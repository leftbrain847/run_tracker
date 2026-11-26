import { test } from 'node:test';
import assert from 'node:assert';
import {
  CONFIG, haversine, targetMeters, directionsRequest, parseRoute, reverseRoute, metrics, finishDrop, surfaceShares,
  rankCandidates, fillGap, locationMessage, newTrack, addFix, runSegments, trackStats, toGpx, fmtPace, fmtDuration, parseGeocode, geocodeUrl,
} from '../src/core.mjs';
import { orsResponse, START } from './fixtures.mjs';

test('haversine: 1 degree of latitude is about 111 km', () => {
  assert.ok(Math.abs(haversine([0, 0], [1, 0]) - 111195) < 50);
});

test('duration and pace become a target distance', () => {
  assert.ok(Math.abs(targetMeters(40, 10) - 4 * 1609.344) < 1e-6);
  assert.throws(() => targetMeters(0, 10));
});

test('request uses the trail profile, a round trip, elevation and surface info', () => {
  const r = directionsRequest(START, 6437.4, { surface: 'trail' }, 3);
  assert.match(r.url, /foot-hiking\/geojson$/);
  assert.deepEqual(r.body.coordinates, [[START.lon, START.lat]]);
  assert.equal(r.body.options.round_trip.length, 6437);
  assert.equal(r.body.options.round_trip.seed, 3);
  assert.ok(r.body.elevation);
  assert.ok(r.body.extra_info.includes('surface'));
  assert.match(directionsRequest(START, 1000, { surface: 'road' }, 1).url, /foot-walking/);
});

test('route parses to [lat, lon, ele] and a 1 km-side loop is about 4 km', () => {
  const r = parseRoute(orsResponse({ sideM: 1000 }));
  assert.ok(Math.abs(r.coords[0][0] - START.lat) < 1e-9);
  assert.ok(Math.abs(metrics(r).distance - 4000) < 40);
});

test('unpaved share comes from the surface codes', () => {
  assert.ok(surfaceShares(parseRoute(orsResponse({ surface: 11 }))).unpaved > 0.99);
  assert.ok(surfaceShares(parseRoute(orsResponse({ surface: 3 }))).paved > 0.99);
});

test('end downhill: the fixture drops hard at the finish; reversed, the finish drops far less', () => {
  const r = parseRoute(orsResponse({ hill: 40 }));
  assert.ok(finishDrop(r.coords) > 30);
  const rev = reverseRoute(r);
  assert.ok(finishDrop(rev.coords) < 15);
  assert.equal(rev.reversed, true);
  const [a, b] = [metrics(r), metrics(rev)];
  assert.ok(Math.abs(a.ascent - b.descent) < 1e-6);
});

test('ranking prefers hills, flat, or the downhill direction as asked', () => {
  const target = 4000;
  const flat = parseRoute(orsResponse({ hill: 0 }), 1);
  const hilly = parseRoute(orsResponse({ hill: 60 }), 2);
  assert.equal(rankCandidates([flat, hilly], { terrain: 'hilly' }, target)[0].route.seed, 2);
  assert.equal(rankCandidates([flat, hilly], { terrain: 'flat' }, target)[0].route.seed, 1);
  const down = rankCandidates([hilly], { endDownhill: true }, target)[0];
  assert.equal(down.route.reversed, false);
  assert.ok(down.metrics.finishDrop > 0);
});

test('ranking drops loops too far off the target length', () => {
  const ok = parseRoute(orsResponse({ sideM: 1000 }), 1);
  const long = parseRoute(orsResponse({ sideM: 2000 }), 2);
  const out = rankCandidates([ok, long], {}, 4000);
  assert.deepEqual(out.map((c) => c.route.seed), [1]);
});

test('trail preference ranks the dirt loop above the asphalt one', () => {
  const road = parseRoute(orsResponse({ surface: 3 }), 1);
  const dirt = parseRoute(orsResponse({ surface: 11, sideM: 1020 }), 2);
  assert.equal(rankCandidates([road, dirt], { surface: 'trail' }, 4000)[0].route.seed, 2);
  assert.equal(rankCandidates([road, dirt], { surface: 'road' }, 4000)[0].route.seed, 1);
});

test('gap on the plan is filled from the plan; off the plan it is a straight line that does not count', () => {
  const plan = parseRoute(orsResponse({ sideM: 1000 })).coords;
  const g = fillGap(plan, plan[2], plan[12]);
  assert.equal(g.kind, 'planned');
  assert.ok(g.distance > 900);
  const off = fillGap(plan, [START.lat + 0.05, START.lon], [START.lat + 0.06, START.lon]);
  assert.equal(off.kind, 'unknown');
  assert.equal(off.distance, 0);
  const wrap = fillGap(plan, plan[35], plan[3]);
  assert.equal(wrap.kind, 'planned');
});

test('tracker: accumulates steps, ignores bad fixes, fills a lock-screen gap', () => {
  const plan = parseRoute(orsResponse({ sideM: 1000 })).coords;
  const t = newTrack();
  const fix = (i, t0, extra = {}) => ({ lat: plan[i][0], lon: plan[i][1], ele: 0, accuracy: 5, t: t0, ...extra });
  addFix(t, fix(0, 0), plan);
  addFix(t, fix(1, 5000), plan);
  addFix(t, fix(2, 10000, { accuracy: 200 }), plan); // ignored
  const before = t.distance;
  assert.ok(before > 90 && before < 110);
  addFix(t, fix(10, 300000), plan); // phone was locked for ~5 min
  assert.equal(t.gaps.length, 1);
  assert.equal(t.gaps[0].kind, 'planned');
  assert.ok(t.estimated > 800);
  assert.equal(t.segments.length, 2);
  const s = trackStats(t, 300000);
  assert.ok(s.miles > 0.5 && s.paceMinPerMile > 0);
});

test('GPX has one trkseg per segment and escapes the name', () => {
  const gpx = toGpx('a<b', [[[38.9, -77, 10], [38.91, -77, 12]], [[38.92, -77, 0]]]);
  assert.equal(gpx.split('<trkseg>').length - 1, 2);
  assert.match(gpx, /<name>a&lt;b<\/name>/);
  assert.match(gpx, /lat="38\.900000" lon="-77\.000000"/);
});

test('formatting', () => {
  assert.equal(fmtPace(9.999), '10:00');
  assert.equal(fmtPace(8.5), '8:30');
  assert.equal(fmtPace(null), '--:--');
  assert.equal(fmtDuration(3723000), '1:02:03');
  assert.equal(fmtDuration(65000), '1:05');
});

test('geocode: zip query and parse', () => {
  assert.match(geocodeUrl('20001', 'k'), /text=20001/);
  assert.match(geocodeUrl('20001', 'k'), /boundary\.country=US/);
  assert.deepEqual(parseGeocode({ features: [{ geometry: { coordinates: [-77, 38.9] }, properties: { label: 'DC' } }] }), { lat: 38.9, lon: -77, label: 'DC' });
  assert.throws(() => parseGeocode({ features: [] }), /not found/);
});

test('config is the single source for tunables', () => {
  assert.ok(CONFIG.plan.seeds > 0 && CONFIG.unpavedSurfaces.includes(11));
});

test('regression: jitter behind the last fix after a stop never adds a lap', () => {
  const plan = parseRoute(orsResponse({ sideM: 1000 })).coords;
  const g = fillGap(plan, plan[20], plan[19], 30000);
  assert.equal(g.kind, 'unknown');
  assert.equal(g.distance, 0);
});

test('regression: standing still at a light is not a gap', () => {
  const plan = parseRoute(orsResponse({ sideM: 1000 })).coords;
  const t = newTrack();
  const at = (i, ms) => ({ lat: plan[i][0], lon: plan[i][1], ele: 50, accuracy: 5, t: ms });
  addFix(t, at(5, 0), plan);
  for (let ms = 5000; ms <= 60000; ms += 5000) addFix(t, at(5, ms), plan); // 60 s waiting, tiny steps
  addFix(t, at(6, 65000), plan);
  assert.equal(t.gaps.length, 0);
  assert.ok(t.distance < 150);
});

test('gap fill is capped at a running speed for the time missed', () => {
  const plan = parseRoute(orsResponse({ sideM: 1000 })).coords;
  assert.equal(fillGap(plan, plan[2], plan[30], 20000).kind, 'unknown'); // ~2.8 km in 20 s: no
  assert.equal(fillGap(plan, plan[2], plan[30], 900000).kind, 'planned'); // in 15 min: yes
});

test('missing altitude carries the last one instead of dropping to 0', () => {
  const t = newTrack();
  addFix(t, { lat: 38.9, lon: -77, ele: 80, accuracy: 5, t: 0 });
  addFix(t, { lat: 38.9005, lon: -77, ele: null, accuracy: 5, t: 5000 });
  assert.equal(t.last.p[2], 80);
});

test('run GPX order: a gap after a pause lands between the right segments', () => {
  const plan = parseRoute(orsResponse({ sideM: 1000 })).coords;
  const t = newTrack();
  const at = (i, ms) => ({ lat: plan[i][0], lon: plan[i][1], ele: 50, accuracy: 5, t: ms });
  addFix(t, at(0, 0), plan); addFix(t, at(1, 5000), plan);        // s0
  t.last = null;                                                   // pause/resume, as the app does
  addFix(t, at(3, 100000), plan); addFix(t, at(4, 105000), plan);  // s1
  addFix(t, at(12, 400000), plan);                                 // locked phone -> gap, then s2
  assert.equal(t.segments.length, 3);
  assert.equal(t.gaps[0].afterSegment, 1);
  const out = runSegments(t);
  assert.equal(out.length, 4);
  assert.equal(out[1], t.segments[1]);
  assert.equal(out[2], t.gaps[0].path);
  assert.equal(out[3], t.segments[2]);
});

test('location errors say what actually went wrong', () => {
  assert.match(locationMessage(1), /Safari Websites/);
  assert.match(locationMessage(3), /timed out/);
  assert.match(locationMessage(99), /zip/);
});
