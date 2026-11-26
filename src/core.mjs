// run_tracker core: pure functions (no DOM). The page and the tests both import this file.
// Every tunable lives in CONFIG so it can be changed at any granularity.

export const CONFIG = {
  ors: {
    base: 'https://api.openrouteservice.org',
    profiles: { road: 'foot-walking', trail: 'foot-hiking', either: 'foot-walking' },
    extraInfo: ['surface', 'waytype'],
    country: 'US',
  },
  plan: {
    seeds: 6,              // round trips requested per plan (each costs one ORS call)
    loopPoints: 4,         // ORS round_trip.points: higher = rounder loop
    distanceTolerance: 0.15, // drop candidates more than 15% off target length
    results: 3,            // candidates shown
    finishFraction: 0.2,   // "end downhill" looks at the last 20% of the route
  },
  pace: { defaultMinPerMile: 10, metersPerMile: 1609.344, feetPerMeter: 3.28084 },
  // Surface IDs from the ORS docs; 9 and 16 are retired there but kept so old data still scores.
  unpavedSurfaces: [2, 8, 9, 10, 11, 12, 15, 16, 17],
  pavedSurfaces: [1, 3, 4, 5, 6, 7, 14, 18],
  weights: {
    distanceError: 40, // per 100% off target
    surface: 30,       // per 100% matching surface share
    hills: 2,          // per m of climb per km
    finishDrop: 1.5,   // per m of drop over the finish section
  },
  track: {
    maxAccuracyM: 35,  // ignore GPS fixes worse than this
    minStepM: 3,       // ignore jitter below this
    gapMs: 20000,      // no fix for this long = a gap
    snapM: 50,         // both gap ends within this of the plan = fill with the plan
    wrapFraction: 0.25, // a gap may wrap past the loop's start only from its last 25% to its first 25%
    maxSpeedMps: 6.5,  // a filled gap can't be longer than this speed allows (~4:08/mi)
  },
};

export const PREF_DEFAULTS = { surface: 'either', terrain: 'any', endDownhill: false };

// Geolocation error code -> what to tell the runner (codes from the W3C Geolocation API).
export const LOCATION_ERRORS = {
  1: 'Location is off for this site. iPhone: Settings > Privacy & Security > Location Services > Safari Websites > While Using, then reload. Or type a zip.',
  2: 'No GPS fix yet. Step outside or try again, or type a zip.',
  3: 'Location timed out. Try again, or type a zip.',
};
export function locationMessage(code) {
  return LOCATION_ERRORS[code] ?? 'Could not get your location; type a zip instead.';
}

// ---------- geometry ----------
const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
export function haversine(a, b) {
  // points are [lat, lon, ele?]
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function cumulative(coords) {
  const out = [0];
  for (let i = 1; i < coords.length; i++) out.push(out[i - 1] + haversine(coords[i - 1], coords[i]));
  return out;
}

export function pathLength(coords) {
  const c = cumulative(coords);
  return c[c.length - 1] ?? 0;
}

export function climb(coords) {
  let ascent = 0, descent = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = (coords[i][2] ?? 0) - (coords[i - 1][2] ?? 0);
    if (d > 0) ascent += d; else descent -= d;
  }
  return { ascent, descent };
}

// ---------- duration -> distance ----------
export function targetMeters(durationMin, paceMinPerMile = CONFIG.pace.defaultMinPerMile) {
  if (!(durationMin > 0) || !(paceMinPerMile > 0)) throw new Error('duration and pace must be positive');
  return (durationMin / paceMinPerMile) * CONFIG.pace.metersPerMile;
}

// ---------- ORS requests ----------
export function directionsRequest(start, meters, prefs, seed, cfg = CONFIG) {
  const profile = cfg.ors.profiles[prefs.surface] ?? cfg.ors.profiles.either;
  return {
    url: `${cfg.ors.base}/v2/directions/${profile}/geojson`,
    body: {
      coordinates: [[start.lon, start.lat]],
      elevation: true,
      instructions: false,
      extra_info: cfg.ors.extraInfo,
      options: { round_trip: { length: Math.round(meters), points: cfg.plan.loopPoints, seed } },
    },
  };
}

export function geocodeUrl(text, key, cfg = CONFIG) {
  const q = new URLSearchParams({ api_key: key, text, size: '1', 'boundary.country': cfg.ors.country });
  return `${cfg.ors.base}/geocode/search?${q}`;
}

export function parseGeocode(json) {
  const f = json?.features?.[0];
  if (!f) throw new Error('location not found');
  const [lon, lat] = f.geometry.coordinates;
  return { lat, lon, label: f.properties?.label ?? '' };
}

// ORS geojson -> route object. Coordinates come back [lon, lat, ele]; we store [lat, lon, ele].
export function parseRoute(json, seed = 0) {
  const f = json?.features?.[0];
  if (!f?.geometry?.coordinates?.length) throw new Error('no route in response');
  const coords = f.geometry.coordinates.map(([lon, lat, ele]) => [lat, lon, ele ?? 0]);
  const surfaces = f.properties?.extras?.surface?.values ?? [];
  return { seed, coords, surfaces, reversed: false };
}

export function reverseRoute(route) {
  const n = route.coords.length - 1;
  return {
    ...route,
    coords: [...route.coords].reverse(),
    surfaces: route.surfaces.map(([a, b, v]) => [n - b, n - a, v]).reverse(),
    reversed: !route.reversed,
  };
}

// ---------- metrics ----------
export function surfaceShares(route, cfg = CONFIG) {
  const cum = cumulative(route.coords);
  const total = cum[cum.length - 1] || 1;
  let unpaved = 0, paved = 0;
  for (const [a, b, v] of route.surfaces) {
    const len = (cum[Math.min(b, cum.length - 1)] ?? 0) - (cum[a] ?? 0);
    if (cfg.unpavedSurfaces.includes(v)) unpaved += len;
    else if (cfg.pavedSurfaces.includes(v)) paved += len;
  }
  return { unpaved: unpaved / total, paved: paved / total };
}

// Elevation lost over the last `fraction` of the route (positive = finishes downhill).
export function finishDrop(coords, fraction = CONFIG.plan.finishFraction) {
  const cum = cumulative(coords);
  const total = cum[cum.length - 1];
  if (!total) return 0;
  const from = total * (1 - fraction);
  let i = cum.findIndex((d) => d >= from);
  if (i < 0) i = coords.length - 1;
  return (coords[i][2] ?? 0) - (coords[coords.length - 1][2] ?? 0);
}

export function metrics(route, cfg = CONFIG) {
  const distance = pathLength(route.coords);
  const { ascent, descent } = climb(route.coords);
  const { unpaved, paved } = surfaceShares(route, cfg);
  return { distance, ascent, descent, unpaved, paved, finishDrop: finishDrop(route.coords, cfg.plan.finishFraction) };
}

// ---------- scoring ----------
export function score(m, prefs, target, cfg = CONFIG) {
  const w = cfg.weights;
  const reasons = [];
  let s = 100;
  const err = Math.abs(m.distance - target) / target;
  s -= err * 100 * (w.distanceError / 100);
  if (prefs.surface === 'trail') { s += m.unpaved * w.surface; reasons.push(`${Math.round(m.unpaved * 100)}% unpaved`); }
  if (prefs.surface === 'road') { s += (1 - m.unpaved) * w.surface; reasons.push(`${Math.round((1 - m.unpaved) * 100)}% paved/road`); }
  const perKm = m.ascent / Math.max(m.distance / 1000, 0.1);
  const ft = cfg.pace.feetPerMeter;
  const ftPerMi = perKm * ft * (cfg.pace.metersPerMile / 1000);
  if (prefs.terrain === 'hilly') { s += perKm * w.hills; reasons.push(`${Math.round(ftPerMi)} ft climb/mi`); }
  if (prefs.terrain === 'flat') { s -= perKm * w.hills; reasons.push(`${Math.round(ftPerMi)} ft climb/mi`); }
  if (prefs.endDownhill) { s += m.finishDrop * w.finishDrop; reasons.push(`finish ${m.finishDrop >= 0 ? 'drops' : 'climbs'} ${Math.abs(Math.round(m.finishDrop * ft))} ft`); }
  return { score: s, reasons };
}

// Each loop is tried both ways round; keep the better direction, drop off-length loops, rank.
export function rankCandidates(routes, prefs, target, cfg = CONFIG) {
  const best = routes.map((r) => {
    const opts = [r, reverseRoute(r)].map((x) => {
      const m = metrics(x, cfg);
      return { route: x, metrics: m, ...score(m, prefs, target, cfg) };
    });
    return opts[0].score >= opts[1].score ? opts[0] : opts[1];
  });
  // Different seeds can return the same loop: dedupe on length + climb + midpoint, keeping the best-scoring copy.
  const seen = new Set();
  return best
    .filter((c) => Math.abs(c.metrics.distance - target) / target <= cfg.plan.distanceTolerance)
    .sort((a, b) => b.score - a.score)
    .filter((c) => {
      const mid = c.route.coords[Math.floor(c.route.coords.length / 2)];
      const k = `${Math.round(c.metrics.distance / 50)}:${Math.round(c.metrics.ascent / 5)}:${mid[0].toFixed(4)},${mid[1].toFixed(4)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, cfg.plan.results);
}

// End to end: start + duration + prefs -> ranked loops. fetchFn is injected so tests can run offline.
export async function plan({ start, durationMin, paceMinPerMile, prefs = PREF_DEFAULTS, key, fetchFn = fetch, cfg = CONFIG }) {
  if (!key) throw new Error('add your free openrouteservice key first');
  const target = targetMeters(durationMin, paceMinPerMile);
  const seeds = Array.from({ length: cfg.plan.seeds }, (_, i) => i + 1);
  const results = await Promise.allSettled(seeds.map(async (seed) => {
    const req = directionsRequest(start, target, prefs, seed, cfg);
    const res = await fetchFn(req.url, {
      method: 'POST',
      headers: { Authorization: key, 'Content-Type': 'application/json', Accept: 'application/geo+json' },
      body: JSON.stringify(req.body),
    });
    if (!res.ok) throw new Error(`routing failed (${res.status})`);
    return parseRoute(await res.json(), seed);
  }));
  const routes = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!routes.length) {
    const why = results.find((r) => r.status === 'rejected')?.reason?.message ?? 'no routes';
    throw new Error(why);
  }
  return { target, candidates: rankCandidates(routes, prefs, target, cfg) };
}

// ---------- tracking ----------
export function nearestIndex(coords, p) {
  let best = 0, bestD = Infinity;
  coords.forEach((c, i) => { const d = haversine(c, p); if (d < bestD) { bestD = d; best = i; } });
  return { index: best, dist: bestD };
}

// Fill a GPS gap between fixes a and b. On-plan: the planned path between them (estimated). Off-plan: a straight
// line that does not count toward distance.
export function fillGap(planCoords, a, b, gapMs = Infinity, cfg = CONFIG) {
  const unknown = { kind: 'unknown', path: [a, b], distance: 0 };
  if (!planCoords.length) return unknown;
  const na = nearestIndex(planCoords, a);
  const nb = nearestIndex(planCoords, b);
  if (na.dist > cfg.track.snapM || nb.dist > cfg.track.snapM) return unknown;
  const last = planCoords.length - 1;
  const w = cfg.track.wrapFraction * last;
  let seg;
  if (nb.index >= na.index) seg = planCoords.slice(na.index, nb.index + 1);
  else if (na.index >= last - w && nb.index <= w) seg = [...planCoords.slice(na.index), ...planCoords.slice(1, nb.index + 1)]; // crossed the start
  else return unknown; // went backwards or jittered behind: don't invent a lap
  const path = [a, ...seg, b];
  const distance = pathLength(path);
  if (distance > (gapMs / 1000) * cfg.track.maxSpeedMps) return unknown; // faster than a runner could go
  return { kind: 'planned', path, distance };
}

// Tracker state machine. Feed it fixes {lat, lon, ele, accuracy, t}; it returns what to draw.
export function newTrack() {
  return { segments: [], gaps: [], distance: 0, estimated: 0, last: null, startT: null, pausedMs: 0 };
}

export function addFix(track, fix, planCoords = [], cfg = CONFIG) {
  if (fix.accuracy != null && fix.accuracy > cfg.track.maxAccuracyM) return track;
  const p = [fix.lat, fix.lon, fix.ele ?? track.last?.p[2] ?? 0]; // no altitude: carry the last one, don't drop to 0
  if (track.startT == null) track.startT = fix.t;
  if (!track.last) {
    track.segments.push([p]);
    track.last = { p, t: fix.t };
    return track;
  }
  const step = haversine(track.last.p, p);
  if (fix.t - track.last.t >= cfg.track.gapMs) {
    const gap = fillGap(planCoords, track.last.p, p, fix.t - track.last.t, cfg);
    gap.afterSegment = track.segments.length - 1; // pauses also start segments, so record where the gap sits
    track.gaps.push(gap);
    track.distance += gap.distance;
    track.estimated += gap.distance;
    track.segments.push([p]);
  } else {
    if (step < cfg.track.minStepM) { track.last.t = fix.t; return track; } // standing still is not a gap
    track.segments[track.segments.length - 1].push(p);
    track.distance += step;
  }
  track.last = { p, t: fix.t };
  return track;
}

// Segments in the order run, with planned gap fills placed after the segment they follow (for GPX export).
export function runSegments(track) {
  return track.segments.flatMap((seg, i) => [
    seg,
    ...track.gaps.filter((g) => g.kind === 'planned' && g.afterSegment === i).map((g) => g.path),
  ]);
}

export function trackStats(track, now) {
  const elapsedMs = track.startT == null ? 0 : now - track.startT - track.pausedMs;
  const miles = track.distance / CONFIG.pace.metersPerMile;
  return { elapsedMs, miles, paceMinPerMile: miles > 0.01 ? elapsedMs / 60000 / miles : null, estimatedMiles: track.estimated / CONFIG.pace.metersPerMile };
}

// ---------- GPX ----------
const esc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
export function toGpx(name, segments) {
  const segs = segments.filter((s) => s.length).map((s) =>
    `<trkseg>${s.map(([lat, lon, ele]) => `<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"><ele>${(ele ?? 0).toFixed(1)}</ele></trkpt>`).join('')}</trkseg>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="run_tracker" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${esc(name)}</name>${segs}</trk></gpx>\n`;
}

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(sec).padStart(2, '0')}`;
}

export function fmtPace(minPerMile) {
  if (minPerMile == null || !isFinite(minPerMile)) return '--:--';
  const total = Math.round(minPerMile * 60);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
