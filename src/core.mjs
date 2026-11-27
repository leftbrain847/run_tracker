// run_tracker core: pure functions (no DOM). The page and the tests both import this file.
// Every tunable lives in CONFIG so it can be changed at any granularity.

export const CONFIG = {
  ors: {
    // The old openrouteservice.org API host was retired in Nov 2026; HeiGIT serves the same APIs under api.heigit.org.
    routingBase: 'https://api.heigit.org/openrouteservice',
    geocodeBase: 'https://api.heigit.org/pelias/v1',
    profiles: { road: 'foot-walking', trail: 'foot-hiking', either: 'foot-walking' },
    extraInfo: ['surface', 'waytype', 'green', 'noise'], // green/noise exist for foot profiles only (all of ours)
    weightingFactor: { green: 1, quiet: 1 }, // ORS profile_params.weightings: 0 = normal routing, 1 = strongest
    country: 'US',
  },
  plan: {
    seeds: 6,              // round trips per batch (each costs one ORS call; up to 2 batches per plan)
    calibrate: true,       // ORS round-trip length is rough: if batch 1 misses, re-ask with a corrected length
    maxCorrection: 3,      // never scale the requested length by more than 3x either way
    loopPoints: 4,         // ORS round_trip.points: higher = rounder loop
    distanceTolerance: 0.15, // drop candidates more than 15% off target length
    results: 3,            // candidates shown
    finishFraction: 0.2,   // "end downhill" looks at the last 20% of the route
    outBackDetour: 1.3,    // out-and-back: road distance / straight-line distance to the turnaround, before calibration
    elevationToleranceFt: 0, // how far past a min/max elevation limit still counts as inside
  },
  distance: { minMi: 0.5, maxMi: 30 },
  mainRoadWaytypes: [1, 2], // ORS waytype IDs: 1 State Road, 2 Road (3 Street, 4 Path, 5 Track, 6 Cycleway, 7 Footway)
  repeat: { cellM: 20, nearM: 18, minApartM: 150 }, // a point "repeats" if within nearM of route >= minApartM away along it
  pace: { defaultMinPerMile: 10, metersPerMile: 1609.344, feetPerMeter: 3.28084 },
  // Surface IDs from the ORS docs; 9 and 16 are retired there but kept so old data still scores.
  unpavedSurfaces: [2, 8, 9, 10, 11, 12, 15, 16, 17],
  pavedSurfaces: [1, 3, 4, 5, 6, 7, 14, 18],
  weights: {
    distanceError: 40, // per 100% off target
    surface: 30,       // per 100% matching surface share
    hills: 2,          // per m of climb per km
    finishDrop: 1.5,   // per m of drop over the finish section
    mainRoad: 40,      // per 100% on main roads (when "quiet streets" is on)
    noise: 2,          // per point of average noise 0-10 (when "quiet streets" is on)
    green: 3,          // per point of average greenness 0-10 (when "prefer green" is on)
    repeats: 25,       // per 100% doubled back (loops only: a goal, not a rule)
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

// Browsers report blocked or dropped requests with no status ("Load failed" on iPhone). Usually a bad key or a
// service outage, since the gateway's error replies don't carry CORS headers.
export const NETWORK_ERROR = "Couldn't reach the routing service. Check your key in Setup (copy it again from account.heigit.org), then try again.";

export const PREF_DEFAULTS = {
  surface: 'either', terrain: 'any', endDownhill: false,
  shape: 'loop',        // 'loop' | 'outback'
  quiet: false,         // prefer quiet ways, avoid main roads
  green: false,         // prefer green (shaded-ish) ways; true shade has no data on the public ORS
  minEleFt: null, maxEleFt: null, // optional elevation limits (feet)
};

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

export function distanceMeters(miles, cfg = CONFIG) {
  if (!(miles >= cfg.distance.minMi && miles <= cfg.distance.maxMi)) throw new Error(`distance must be ${cfg.distance.minMi}-${cfg.distance.maxMi} mi`);
  return miles * cfg.pace.metersPerMile;
}

// Point `meters` away from p on a compass bearing (degrees).
export function destination(p, meters, bearingDeg) {
  const d = meters / R, b = rad(bearingDeg), la = rad(p.lat), lo = rad(p.lon);
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return { lat: (la2 * 180) / Math.PI, lon: ((((lo2 * 180) / Math.PI) + 540) % 360) - 180 };
}

// Out-and-back turnarounds: n bearings spread round the compass, offset per batch so batch 2 tries new directions.
export function turnarounds(start, meters, n, batch = 0, cfg = CONFIG) {
  const r = meters / 2 / cfg.plan.outBackDetour;
  return Array.from({ length: n }, (_, i) => destination(start, r, (i * 360) / n + (batch * 180) / n));
}

// ---------- ORS requests ----------
function routeOptions(prefs, cfg, weightings = true) {
  const o = {};
  if (weightings && (prefs.quiet || prefs.green)) {
    const w = {};
    if (prefs.green) w.green = { factor: cfg.ors.weightingFactor.green };
    if (prefs.quiet) w.quiet = { factor: cfg.ors.weightingFactor.quiet };
    o.profile_params = { weightings: w };
  }
  return o;
}

// One ORS request. Loop: a round trip from `start`. Out-and-back: start -> `turn` (the way back is the same path).
export function directionsRequest(start, meters, prefs, seed, cfg = CONFIG, { turn = null, weightings = true } = {}) {
  const profile = cfg.ors.profiles[prefs.surface] ?? cfg.ors.profiles.either;
  const options = routeOptions(prefs, cfg, weightings);
  const coordinates = [[start.lon, start.lat]];
  if (turn) coordinates.push([turn.lon, turn.lat]);
  else options.round_trip = { length: Math.round(meters), points: cfg.plan.loopPoints, seed };
  return {
    url: `${cfg.ors.routingBase}/v2/directions/${profile}/geojson`,
    body: { coordinates, elevation: true, instructions: false, extra_info: cfg.ors.extraInfo, options },
  };
}

export function geocodeUrl(text, key, cfg = CONFIG) {
  const q = new URLSearchParams({ api_key: key, text, size: '1', 'boundary.country': cfg.ors.country });
  return `${cfg.ors.geocodeBase}/search?${q}`;
}

export function parseGeocode(json) {
  const f = json?.features?.[0];
  if (!f) throw new Error('location not found');
  const [lon, lat] = f.geometry.coordinates;
  return { lat, lon, label: f.properties?.label ?? '' };
}

// ORS geojson -> route object. Coordinates come back [lon, lat, ele]; we store [lat, lon, ele].
// extras: { surface, waytype, green, noise } as [fromIndex, toIndex, value] runs, whichever ORS returned.
export function parseRoute(json, seed = 0) {
  const f = json?.features?.[0];
  if (!f?.geometry?.coordinates?.length) throw new Error('no route in response');
  const coords = f.geometry.coordinates.map(([lon, lat, ele]) => [lat, lon, ele ?? 0]);
  const extras = {};
  for (const [k, v] of Object.entries(f.properties?.extras ?? {})) if (Array.isArray(v?.values)) extras[k] = v.values;
  return { seed, coords, extras, reversed: false, shape: 'loop' };
}

const remapExtras = (extras, fn) => Object.fromEntries(Object.entries(extras).map(([k, runs]) => [k, fn(runs)]));

export function reverseRoute(route) {
  const n = route.coords.length - 1;
  return {
    ...route,
    coords: [...route.coords].reverse(),
    extras: remapExtras(route.extras, (runs) => runs.map(([a, b, v]) => [n - b, n - a, v]).reverse()),
    reversed: !route.reversed,
  };
}

// Out-and-back from a one-way route: the same path, then back along it.
export function outAndBack(route) {
  const n = route.coords.length - 1;
  const back = reverseRoute(route);
  return {
    ...route,
    shape: 'outback',
    turnIndex: n,
    coords: route.coords.concat(back.coords.slice(1)),
    extras: Object.fromEntries(Object.keys(route.extras).map((k) => [k, route.extras[k].concat(back.extras[k].map(([a, b, v]) => [a + n, b + n, v]))])),
  };
}

// ---------- metrics ----------
// Distance-weighted share of an extra whose value passes `test` (0-1), or null if ORS didn't return that extra.
export function extraShare(route, key, test, cum = cumulative(route.coords)) {
  const runs = route.extras?.[key];
  if (!runs?.length) return null;
  const total = cum[cum.length - 1] || 1;
  let hit = 0;
  for (const [a, b, v] of runs) if (test(v)) hit += (cum[Math.min(b, cum.length - 1)] ?? 0) - (cum[a] ?? 0);
  return hit / total;
}

// Distance-weighted average of a 0-10 extra (green, noise), or null if missing.
export function extraAverage(route, key, cum = cumulative(route.coords)) {
  const runs = route.extras?.[key];
  if (!runs?.length) return null;
  let sum = 0, len = 0;
  for (const [a, b, v] of runs) {
    const l = (cum[Math.min(b, cum.length - 1)] ?? 0) - (cum[a] ?? 0);
    sum += v * l; len += l;
  }
  return len ? sum / len : null;
}

export function surfaceShares(route, cfg = CONFIG) {
  const cum = cumulative(route.coords);
  return {
    unpaved: extraShare(route, 'surface', (v) => cfg.unpavedSurfaces.includes(v), cum) ?? 0,
    paved: extraShare(route, 'surface', (v) => cfg.pavedSurfaces.includes(v), cum) ?? 0,
  };
}

// Share of the route's distance that passes within nearM of another part of itself (doubling back), 0-1.
export function repeatShare(coords, cfg = CONFIG) {
  const { cellM, nearM, minApartM } = cfg.repeat;
  if (coords.length < 3) return 0;
  const cum = cumulative(coords);
  const total = cum[cum.length - 1] || 1;
  const latM = 111320, lonM = 111320 * Math.cos(rad(coords[0][0]));
  const cell = (p) => [Math.floor((p[0] * latM) / cellM), Math.floor((p[1] * lonM) / cellM)];
  const grid = new Map();
  coords.forEach((p, i) => { const k = cell(p).join(','); (grid.get(k) ?? grid.set(k, []).get(k)).push(i); });
  let rep = 0;
  for (let i = 1; i < coords.length; i++) {
    const [cy, cx] = cell(coords[i]);
    let hit = false;
    for (let dy = -1; dy <= 1 && !hit; dy++) for (let dx = -1; dx <= 1 && !hit; dx++) {
      for (const j of grid.get(`${cy + dy},${cx + dx}`) ?? []) {
        if (Math.abs(cum[i] - cum[j]) >= minApartM && haversine(coords[i], coords[j]) <= nearM) { hit = true; break; }
      }
    }
    if (hit) rep += cum[i] - cum[i - 1];
  }
  return rep / total;
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
  const cum = cumulative(route.coords);
  const distance = cum[cum.length - 1] ?? 0;
  const { ascent, descent } = climb(route.coords);
  const { unpaved, paved } = surfaceShares(route, cfg);
  const eles = route.coords.map((c) => c[2] ?? 0);
  return {
    distance, ascent, descent, unpaved, paved,
    finishDrop: finishDrop(route.coords, cfg.plan.finishFraction),
    mainRoad: extraShare(route, 'waytype', (v) => cfg.mainRoadWaytypes.includes(v), cum),
    green: extraAverage(route, 'green', cum),
    noise: extraAverage(route, 'noise', cum),
    minEle: Math.min(...eles), maxEle: Math.max(...eles),
    repeats: route.shape === 'outback' ? 0 : repeatShare(route.coords, cfg),
  };
}

// Inside the optional elevation limits (feet)?
export function withinElevation(m, prefs, cfg = CONFIG) {
  const ft = cfg.pace.feetPerMeter, tol = cfg.plan.elevationToleranceFt;
  if (prefs.minEleFt != null && m.minEle * ft < prefs.minEleFt - tol) return false;
  if (prefs.maxEleFt != null && m.maxEle * ft > prefs.maxEleFt + tol) return false;
  return true;
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
  if (prefs.quiet) {
    if (m.mainRoad != null) { s -= m.mainRoad * w.mainRoad; reasons.push(`${Math.round(m.mainRoad * 100)}% main road`); }
    if (m.noise != null) s -= m.noise * w.noise;
  }
  if (prefs.green && m.green != null) { s += m.green * w.green; reasons.push(`green ${m.green.toFixed(1)}/10`); }
  if (m.repeats > 0) { s -= m.repeats * w.repeats; if (m.repeats >= 0.05) reasons.push(`${Math.round(m.repeats * 100)}% doubles back`); }
  if (prefs.minEleFt != null || prefs.maxEleFt != null) reasons.push(`${Math.round(m.minEle * ft)}-${Math.round(m.maxEle * ft)} ft elev`);
  return { score: s, reasons };
}

// Each loop is tried both ways round; keep the better direction, drop off-length loops, rank.
export function rankCandidates(routes, prefs, target, cfg = CONFIG, { fallback = false } = {}) {
  const best = routes.map((r) => {
    const opts = [r, reverseRoute(r)].map((x) => {
      const m = metrics(x, cfg);
      return { route: x, metrics: m, ...score(m, prefs, target, cfg) };
    });
    return opts[0].score >= opts[1].score ? opts[0] : opts[1];
  });
  // Different seeds can return the same loop: dedupe on length + climb + midpoint, keeping the best-scoring copy.
  const seen = new Set();
  const off = (c) => Math.abs(c.metrics.distance - target) / target;
  const fitsElevation = (c) => withinElevation(c.metrics, prefs, cfg);
  let pool = best.filter((c) => off(c) <= cfg.plan.distanceTolerance && fitsElevation(c));
  // Nothing fits: show the closest few, flagged, rather than nothing (elevation-fitting ones first).
  if (!pool.length && fallback) {
    pool = [...best].sort((a, b) => (fitsElevation(b) - fitsElevation(a)) || (off(a) - off(b))).slice(0, cfg.plan.results)
      .map((c) => ({ ...c, offTarget: true, offWhy: [off(c) > cfg.plan.distanceTolerance && 'length', !fitsElevation(c) && 'elevation'].filter(Boolean) }));
  }
  return pool
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
// Median of actual/requested length for a batch: how much ORS over- or under-shoots here.
export function lengthRatio(routes, requested) {
  const r = routes.map((x) => pathLength(x.coords) / requested).filter((v) => v > 0).sort((a, b) => a - b);
  if (!r.length) return 1;
  const m = Math.floor(r.length / 2);
  return r.length % 2 ? r[m] : (r[m - 1] + r[m]) / 2;
}

async function fetchOne(req, key, fetchFn) {
  let res;
  try {
    res = await fetchFn(req.url, {
      method: 'POST',
      headers: { Authorization: key, 'Content-Type': 'application/json', Accept: 'application/geo+json' },
      body: JSON.stringify(req.body),
    });
  } catch { throw new Error(NETWORK_ERROR); }
  if (!res.ok) { const e = new Error(`routing failed (${res.status})`); e.status = res.status; throw e; }
  return res.json();
}

// One batch of candidates: loops (one round trip per seed) or out-and-backs (one turnaround per direction).
async function fetchBatch({ start, length, prefs, key, fetchFn, cfg, seeds, batch, weightings }) {
  const turns = prefs.shape === 'outback' ? turnarounds(start, length, seeds.length, batch, cfg) : null;
  const results = await Promise.allSettled(seeds.map(async (seed, i) => {
    const req = directionsRequest(start, length, prefs, seed, cfg, { turn: turns?.[i] ?? null, weightings });
    const r = parseRoute(await fetchOne(req, key, fetchFn), seed);
    return turns ? outAndBack(r) : r;
  }));
  const rejected = results.filter((r) => r.status === 'rejected').map((r) => r.reason);
  return {
    routes: results.filter((r) => r.status === 'fulfilled').map((r) => r.value),
    error: rejected[0]?.message,
    badRequest: rejected.length === results.length && rejected.every((e) => e.status === 400),
  };
}

// End to end: start + target + prefs -> ranked routes. fetchFn is injected so tests can run offline.
// Target: durationMin + paceMinPerMile, or distanceMi.
export async function plan({ start, durationMin, paceMinPerMile, distanceMi = null, prefs = PREF_DEFAULTS, key, fetchFn = fetch, cfg = CONFIG }) {
  if (!key) throw new Error('add your free openrouteservice key first');
  prefs = { ...PREF_DEFAULTS, ...prefs };
  const target = distanceMi != null ? distanceMeters(distanceMi, cfg) : targetMeters(durationMin, paceMinPerMile);
  const n = cfg.plan.seeds;
  const seedsFor = (b) => Array.from({ length: n }, (_, i) => b * n + i + 1);
  let weightings = true;
  let first = await fetchBatch({ start, length: target, prefs, key, fetchFn, cfg, seeds: seedsFor(0), batch: 0, weightings });
  const notes = [];
  // If ORS refuses the quiet/green weightings (all 400s), plan without them and say so; the scoring still applies.
  if (!first.routes.length && first.badRequest && (prefs.quiet || prefs.green)) {
    weightings = false;
    notes.push('quiet/green routing unavailable here; scored by road type and greenness instead');
    first = await fetchBatch({ start, length: target, prefs, key, fetchFn, cfg, seeds: seedsFor(0), batch: 0, weightings });
  }
  if (!first.routes.length) throw new Error(first.error ?? 'no routes');
  let routes = first.routes;
  let requested = target;
  if (cfg.plan.calibrate && rankCandidates(routes, prefs, target, cfg).length < cfg.plan.results) {
    const ratio = lengthRatio(routes, target);
    const k = Math.min(cfg.plan.maxCorrection, Math.max(1 / cfg.plan.maxCorrection, 1 / ratio));
    requested = target * k;
    const second = await fetchBatch({ start, length: requested, prefs, key, fetchFn, cfg, seeds: seedsFor(1), batch: 1, weightings });
    routes = routes.concat(second.routes);
  }
  return { target, requested, notes, candidates: rankCandidates(routes, prefs, target, cfg, { fallback: true }) };
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
