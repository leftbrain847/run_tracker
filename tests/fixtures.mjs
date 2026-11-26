// Synthetic ORS geojson responses: square loops near DC with controllable size, climb and surface.
export const START = { lat: 38.9, lon: -77.04 };

// A loop as [lon, lat, ele] points. sideM = side length; hill = metres of rise on the first half.
export function loopCoords({ sideM = 1000, n = 40, hill = 0 } = {}) {
  const dLat = sideM / 111320;
  const dLon = sideM / (111320 * Math.cos((START.lat * Math.PI) / 180));
  const corners = [[0, 0], [0, dLon], [dLat, dLon], [dLat, 0], [0, 0]];
  const pts = [];
  for (let c = 0; c < 4; c++) {
    for (let i = 0; i < n / 4; i++) {
      const t = i / (n / 4);
      const lat = START.lat + corners[c][0] + (corners[c + 1][0] - corners[c][0]) * t;
      const lon = START.lon + corners[c][1] + (corners[c + 1][1] - corners[c][1]) * t;
      pts.push([lon, lat]);
    }
  }
  pts.push([START.lon, START.lat]);
  // Elevation: steady climb for the first 80%, then a fast drop to the start.
  return pts.map(([lon, lat], i) => {
    const f = i / (pts.length - 1);
    const ele = 50 + (f <= 0.8 ? hill * (f / 0.8) : hill * (1 - (f - 0.8) / 0.2));
    return [lon, lat, ele];
  });
}

export function orsResponse({ sideM, hill = 0, surface = 3 } = {}) {
  const coordinates = loopCoords({ sideM, hill });
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'LineString', coordinates },
      properties: { extras: { surface: { values: [[0, coordinates.length - 1, surface]] } } },
    }],
  };
}

export function fakeFetch(bySeed) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    const r = bySeed[body.options.round_trip.seed];
    if (!r) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => r };
  };
  fn.calls = calls;
  return fn;
}
