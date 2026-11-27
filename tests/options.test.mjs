// Route options: out-and-back, distance mode, quiet/green, elevation limits, fewer repeats.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  CONFIG, directionsRequest, parseRoute, outAndBack, metrics, repeatShare, withinElevation, rankCandidates, plan,
  turnarounds, destination, haversine, distanceMeters, score, PREF_DEFAULTS,
} from '../src/core.mjs';
import { orsResponse, orsLine, START } from './fixtures.mjs';

const prefs = (p = {}) => ({ ...PREF_DEFAULTS, ...p });

test('distance mode: miles to meters, with sane bounds', () => {
  assert.ok(Math.abs(distanceMeters(4) - 6437.376) < 0.01);
  assert.throws(() => distanceMeters(0.1), /distance must be/);
});

test('loop request: round_trip, plus quiet/green weightings only when asked', () => {
  const plain = directionsRequest(START, 5000, prefs(), 1).body;
  assert.ok(plain.options.round_trip);
  assert.equal(plain.options.profile_params, undefined);
  assert.ok(plain.extra_info.includes('waytype') && plain.extra_info.includes('green'));
  const both = directionsRequest(START, 5000, prefs({ quiet: true, green: true }), 1).body;
  assert.deepEqual(both.options.profile_params.weightings, { green: { factor: 1 }, quiet: { factor: 1 } });
  const off = directionsRequest(START, 5000, prefs({ quiet: true }), 1, CONFIG, { weightings: false }).body;
  assert.equal(off.options.profile_params, undefined);
});

test('out-and-back request: two coordinates, no round_trip', () => {
  const turn = destination(START, 2000, 90);
  const b = directionsRequest(START, 5000, prefs({ shape: 'outback' }), 1, CONFIG, { turn }).body;
  assert.equal(b.coordinates.length, 2);
  assert.equal(b.options.round_trip, undefined);
});

test('turnarounds: n directions at about half the distance over the detour factor, rotated on batch 2', () => {
  const t0 = turnarounds(START, 6000, 6, 0), t1 = turnarounds(START, 6000, 6, 1);
  assert.equal(t0.length, 6);
  for (const t of t0) assert.ok(Math.abs(haversine([START.lat, START.lon], [t.lat, t.lon]) - 3000 / CONFIG.plan.outBackDetour) < 5);
  assert.notDeepEqual(t0[0], t1[0]);
});

test('out-and-back route: same path back, twice the length, extras doubled, turnaround marked', () => {
  const one = parseRoute(orsLine(destination(START, 2000, 0), { hill: 30 }));
  const ob = outAndBack(one);
  assert.equal(ob.shape, 'outback');
  assert.equal(ob.turnIndex, one.coords.length - 1);
  const m = metrics(ob);
  assert.ok(Math.abs(m.distance - 2 * metrics(one).distance) < 1);
  assert.ok(Math.abs(m.ascent - 30) < 0.5 && Math.abs(m.descent - 30) < 0.5);
  assert.ok(m.finishDrop > 0, 'the way back is downhill');
  assert.equal(ob.extras.surface.length, 2);
  assert.equal(m.repeats, 0, 'out-and-backs are not penalised for repeating');
});

test('repeats: a clean loop scores ~0, a loop that doubles back scores high', () => {
  const loop = parseRoute(orsResponse({ sideM: 1000 })).coords;
  assert.ok(repeatShare(loop) < 0.05);
  const back = loop.slice(0, 15).concat(loop.slice(0, 15).reverse());
  assert.ok(repeatShare(back) > 0.8);
});

test('quiet: a loop on main roads ranks below a quiet one, and the card says how much main road', () => {
  const main = parseRoute(orsResponse({ sideM: 1000, waytype: 2, noise: 8 }), 1);
  const side = parseRoute(orsResponse({ sideM: 1010, waytype: 3, noise: 2 }), 2);
  const r = rankCandidates([main, side], prefs({ quiet: true }), 4000);
  assert.equal(r[0].route.seed, 2);
  assert.ok(r[0].reasons.includes('0% main road'));
  assert.ok(r[1].reasons.includes('100% main road'));
});

test('green: the greener loop ranks first and shows its score', () => {
  const grey = parseRoute(orsResponse({ sideM: 1000, green: 1 }), 1);
  const leafy = parseRoute(orsResponse({ sideM: 1010, green: 9 }), 2);
  const r = rankCandidates([grey, leafy], prefs({ green: true }), 4000);
  assert.equal(r[0].route.seed, 2);
  assert.ok(r[0].reasons.some((x) => /green 9\.0\/10/.test(x)));
});

test('elevation limits: routes outside are skipped; if all are, the closest come back flagged', () => {
  const low = parseRoute(orsResponse({ sideM: 1000, hill: 0 }), 1);   // 50 m flat = 164 ft
  const high = parseRoute(orsResponse({ sideM: 1010, hill: 100 }), 2); // up to 150 m = 492 ft
  const m = metrics(high);
  assert.equal(withinElevation(m, prefs({ maxEleFt: 300 })), false);
  assert.equal(withinElevation(m, prefs({ maxEleFt: 600 })), true);
  assert.deepEqual(rankCandidates([low, high], prefs({ maxEleFt: 300 }), 4000).map((c) => c.route.seed), [1]);
  const none = rankCandidates([low, high], prefs({ minEleFt: 1000 }), 4000, CONFIG, { fallback: true });
  assert.ok(none.length && none.every((c) => c.offTarget && c.offWhy.includes('elevation')));
});

test('repeats are a goal, not a rule: a great loop that doubles back a bit still beats a bad one that does not', () => {
  const m = { distance: 4000, ascent: 0, unpaved: 0, finishDrop: 0, mainRoad: 0, noise: 0, green: 9, repeats: 0.1, minEle: 0, maxEle: 0 };
  const great = score(m, prefs({ green: true, quiet: true }), 4000).score;
  const bad = score({ ...m, green: 1, mainRoad: 0.6, repeats: 0 }, prefs({ green: true, quiet: true }), 4000).score;
  assert.ok(great > bad);
});

test('plan: out-and-back by distance, end to end with fake ORS', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const [, [lon, lat]] = body.coordinates;
    // road distance ~1.3x straight line: stretch the turnaround a bit
    const to = { lat: START.lat + (lat - START.lat) * 1.3, lon: START.lon + (lon - START.lon) * 1.3 };
    return { ok: true, status: 200, json: async () => orsLine(to, { hill: body.coordinates[1][0] > START.lon ? 20 : 0 }) };
  };
  const res = await plan({ start: START, distanceMi: 4, prefs: { shape: 'outback' }, key: 'k', fetchFn });
  assert.ok(calls.every((b) => b.coordinates.length === 2 && !b.options.round_trip));
  assert.ok(res.candidates.length >= 1);
  assert.ok(res.candidates.every((c) => c.route.shape === 'outback' && !c.offTarget));
});

test('plan: if ORS refuses the quiet/green weightings, it plans without them and says so', async () => {
  let refused = 0;
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.options.profile_params) { refused++; return { ok: false, status: 400, json: async () => ({}) }; }
    return { ok: true, status: 200, json: async () => orsResponse({ sideM: 1609 + body.options.round_trip.seed * 20 }) };
  };
  const res = await plan({ start: START, distanceMi: 4, prefs: { quiet: true }, key: 'k', fetchFn });
  assert.equal(refused, CONFIG.plan.seeds);
  assert.ok(res.candidates.length > 0);
  assert.match(res.notes.join(' '), /quiet\/green routing unavailable/);
});
