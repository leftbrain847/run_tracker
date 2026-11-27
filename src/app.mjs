// run_tracker UI. Imports core; the build inlines both into one page.
import { addRun, CONFIG, PREF_DEFAULTS, NETWORK_ERROR, locationMessage, plan, geocodeUrl, parseGeocode, newTrack, addFix, runSegments, trackStats, toGpx, fmtDuration, fmtPace } from './core.mjs';

const UI = {
  storageKeys: { orsKey: 'run_tracker.ors_key', form: 'run_tracker.form', history: 'run_tracker.history' },
  colors: { planned: '#2563eb', alt: '#94a3b8', track: '#dc2626', gap: '#dc2626' },
  tiles: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '&copy; OpenStreetMap contributors', maxZoom: 19 },
  tickMs: 1000,
  minSavedRunM: 200, // shorter runs aren't saved to "somewhere new" history
};

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } }, // false: off or full
};

const state = { via: null, pickingVia: false, start: null, candidates: [], chosen: null, track: null, watchId: null, wakeLock: null, timer: null, layers: [], paused: false, pauseAt: null };

// ---------- map ----------
const map = L.map('map', { zoomControl: false }).setView([38.9, -77.04], 12);
// Tiles load only once there's a start point: an untouched page makes no third-party requests (and fewer OSM hits).
let tiles = null;
function showTiles() {
  if (tiles) return;
  tiles = L.tileLayer(UI.tiles.url, { attribution: UI.tiles.attribution, maxZoom: UI.tiles.maxZoom }).addTo(map);
  document.getElementById('map').classList.add('live');
}
const clearLayers = () => { state.layers.forEach((l) => l.remove()); state.layers = []; };
const add = (l) => { l.addTo(map); state.layers.push(l); return l; };
const latlngs = (coords) => coords.map(([a, b]) => [a, b]);

function drawCandidates(selected) {
  clearLayers();
  state.candidates.forEach((c, i) => {
    if (i !== selected) add(L.polyline(latlngs(c.route.coords), { color: UI.colors.alt, weight: 3, opacity: 0.6 }));
  });
  const c = state.candidates[selected];
  if (!c) return;
  const line = add(L.polyline(latlngs(c.route.coords), { color: UI.colors.planned, weight: 5 }));
  add(L.circleMarker(c.route.coords[0], { radius: 7, color: '#16a34a', fillOpacity: 1 }));
  if (c.route.turnIndex != null) add(L.circleMarker(c.route.coords[c.route.turnIndex], { radius: 6, color: '#f59e0b', fillOpacity: 1 })); // turnaround
  map.fitBounds(line.getBounds(), { padding: [20, 20] });
}

// ---------- form ----------
const radio = (name, fallback) => document.querySelector(`input[name=${name}]:checked`)?.value ?? fallback;
const numOrNull = (id) => { const v = $(id).value.trim(); return v === '' || !isFinite(Number(v)) ? null : Number(v); };

function readForm() {
  return {
    by: radio('by', 'time'),
    durationMin: Number($('duration').value),
    paceMinPerMile: Number($('pace').value),
    distanceMi: Number($('distance').value),
    zip: $('zip').value.trim(),
    prefs: {
      surface: radio('surface', PREF_DEFAULTS.surface),
      terrain: radio('terrain', PREF_DEFAULTS.terrain),
      endDownhill: $('endDownhill').checked,
      shape: radio('shape', PREF_DEFAULTS.shape),
      quiet: $('quiet').checked,
      green: $('green').checked,
      minEleFt: numOrNull('minEle'),
      maxEleFt: numOrNull('maxEle'),
      somewhereNew: $('somewhereNew').checked,
      via: state.via,
    },
  };
}

function showBy() {
  const dist = radio('by', 'time') === 'distance';
  $('byTime').hidden = dist; $('byDistance').hidden = !dist;
  $('durationOut').textContent = `${$('duration').value} min`;
  $('distanceOut').textContent = `${Number($('distance').value).toFixed(2)} mi`;
}
document.querySelectorAll('input[name=by]').forEach((el) => { el.onchange = showBy; });
$('distance').oninput = showBy;

let restoredVia = null;
function restoreForm() {
  $('orsKey').value = store.get(UI.storageKeys.orsKey) ?? '';
  try {
    const f = JSON.parse(store.get(UI.storageKeys.form) ?? 'null');
    if (!f) return;
    $('duration').value = f.durationMin; $('pace').value = f.paceMinPerMile; $('zip').value = f.zip ?? '';
    if (f.distanceMi) $('distance').value = f.distanceMi;
    const pick = (n, v) => { const el = document.querySelector(`input[name=${n}][value="${v}"]`); if (el) el.checked = true; };
    pick('by', f.by); pick('surface', f.prefs?.surface); pick('terrain', f.prefs?.terrain); pick('shape', f.prefs?.shape);
    $('endDownhill').checked = !!f.prefs?.endDownhill;
    $('quiet').checked = !!f.prefs?.quiet; $('green').checked = !!f.prefs?.green;
    $('somewhereNew').checked = !!f.prefs?.somewhereNew;
    $('minEle').value = f.prefs?.minEleFt ?? ''; $('maxEle').value = f.prefs?.maxEleFt ?? '';
    if (f.prefs?.minEleFt != null || f.prefs?.maxEleFt != null) $('eleBox').open = true;
    if (f.prefs?.via && isFinite(f.prefs.via.lat) && isFinite(f.prefs.via.lon)) { restoredVia = f.prefs.via; $('viaBox').open = true; }
  } catch { /* ignore */ }
  showBy();
}

// ---------- via a spot ----------
let viaMarker = null;
function setVia(v) {
  state.via = v;
  viaMarker?.remove(); viaMarker = null;
  if (v) {
    showTiles();
    viaMarker = L.circleMarker([v.lat, v.lon], { radius: 8, color: '#a855f7', fillOpacity: 1 }).addTo(map);
    $('viaLine').innerHTML = `Via: <b>${escapeHtml(v.label || `${v.lat.toFixed(4)}, ${v.lon.toFixed(4)}`)}</b> <button id="viaClear" type="button" class="link">Clear</button>`;
    $('viaClear').onclick = () => setVia(null);
  } else {
    $('viaLine').textContent = 'Loops pass through it; out-and-backs run through it and turn further on.';
  }
}
$('viaFind').onclick = async () => {
  const text = $('viaText').value.trim();
  const key = $('orsKey').value.trim();
  if (!text) { status('Type a place to go via, or tap the map.', true); return; }
  if (!key) { openHowto(); return; }
  try {
    let r;
    try { r = await fetch(geocodeUrl(text, key, CONFIG, state.start)); } catch { throw new Error(NETWORK_ERROR); }
    if (!r.ok) throw new Error(`place lookup failed (${r.status})`);
    const v = parseGeocode(await r.json());
    setVia(v);
    map.setView([v.lat, v.lon], 14);
    status('Via spot set. Plan your run.');
  } catch (e) { status(e.message, true); }
};
$('viaTap').onclick = () => {
  state.pickingVia = true;
  showTiles();
  document.getElementById('map').scrollIntoView({ behavior: 'smooth' });
  status('Tap the map where you want to go through.');
};
map.on('click', (e) => {
  if (!state.pickingVia) return;
  state.pickingVia = false;
  setVia({ lat: e.latlng.lat, lon: e.latlng.lng, label: 'spot on the map' });
  status('Via spot set. Plan your run.');
});

// ---------- saved runs ("somewhere new") ----------
function loadHistory() {
  try { const h = JSON.parse(store.get(UI.storageKeys.history) ?? '[]'); return Array.isArray(h) ? h : []; } catch { return []; }
}
function saveRun(coords) {
  let h = addRun(loadHistory(), coords, new Date().toISOString().slice(0, 10));
  // Storage full: drop the oldest runs until it fits (or give up and say so).
  while (!store.set(UI.storageKeys.history, JSON.stringify(h)) && h.length > 1) h = h.slice(0, Math.floor(h.length * 0.8));
  showHistory();
}
function showHistory() {
  const n = loadHistory().length;
  $('historyLine').innerHTML = n
    ? `${n} saved run${n === 1 ? '' : 's'} on this device. <button id="clearHistory" type="button" class="link">Clear</button>`
    : 'Finish a run here, or tap "I ran this", and it counts as ground you know.';
  const c = document.getElementById('clearHistory');
  if (c) c.onclick = () => { store.set(UI.storageKeys.history, '[]'); showHistory(); };
}

// ---------- how-to popup ----------
function openHowto() {
  const d = $('howto');
  if (d.open) return;
  try { d.showModal(); } catch { d.setAttribute('open', ''); } // old browsers: plain open
}
$('howtoBtn').onclick = openHowto;
$('howtoClose').onclick = () => { $('howto').close?.(); $('howto').removeAttribute('open'); afterHowto(); };
$('howto').addEventListener('close', afterHowto); // Escape closes it too
function afterHowto() { $('setup').open = true; $('orsKey').focus(); }

const status = (msg, isErr = false) => { $('status').textContent = msg; $('status').className = isErr ? 'err' : ''; };

function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('no location on this device; use a zip'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, label: 'your location' }),
      (err) => reject(new Error(locationMessage(err?.code))),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  });
}

$('useLocation').onclick = async () => {
  status('Finding you…');
  try { state.start = await locate(); $('zip').value = ''; status('Using your location.'); showTiles(); map.setView([state.start.lat, state.start.lon], 14); }
  catch (e) { status(e.message, true); }
};

$('duration').oninput = () => { $('durationOut').textContent = `${$('duration').value} min`; };

$('planBtn').onclick = async () => {
  state.pickingVia = false;
  const key = $('orsKey').value.trim();
  store.set(UI.storageKeys.orsKey, key);
  const f = readForm();
  store.set(UI.storageKeys.form, JSON.stringify(f));
  try {
    if (!key) { openHowto(); throw new Error('add your free openrouteservice key (Setup)'); }
    if (f.zip) {
      status('Looking up zip…');
      let r;
      try { r = await fetch(geocodeUrl(f.zip, key, CONFIG)); } catch { throw new Error(NETWORK_ERROR); }
      if (!r.ok) throw new Error(`zip lookup failed (${r.status})`);
      state.start = parseGeocode(await r.json());
    }
    if (!state.start) throw new Error('tap "Use my location" or type a zip');
    showTiles();
    status(`Building ${CONFIG.plan.seeds} loops and scoring them…`);
    $('planBtn').disabled = true;
    const res = await plan({
      start: state.start, prefs: f.prefs, key, history: loadHistory(),
      ...(f.by === 'distance' ? { distanceMi: f.distanceMi } : { durationMin: f.durationMin, paceMinPerMile: f.paceMinPerMile }),
    });
    state.notes = res.notes;
    state.candidates = res.candidates;
    renderCandidates(res.target);
    $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) { status(e.message, true); }
  finally { $('planBtn').disabled = false; }
};

function renderCandidates(target) {
  const list = $('results');
  list.innerHTML = '';
  if (!state.candidates.length) {
    state.chosen = null; $('runBar').hidden = true; clearLayers();
    status('No routes came back. Try again or move the start.', true); return;
  }
  const off = state.candidates[0].offTarget;
  const why = state.candidates[0].offWhy ?? [];
  const miles = (target / CONFIG.pace.metersPerMile).toFixed(off ? 1 : 2);
  const miss = why.includes('elevation') && why.includes('length') ? `the length (${miles} mi) and elevation limits`
    : why.includes('elevation') ? 'your elevation limits' : `${Math.round(CONFIG.plan.distanceTolerance * 100)}% of ${miles} mi`;
  const note = state.notes?.length ? ` (${state.notes.join('; ')})` : '';
  status((off ? `Nothing here fits ${miss}; these are the closest.` : `Target ${miles} mi. Tap a route, then Run it.`) + note, off);
  state.candidates.forEach((c, i) => {
    const m = c.metrics;
    const card = document.createElement('button');
    card.className = 'card';
    const kind = c.route.shape === 'outback' ? 'Out & back' : 'Loop';
    card.innerHTML = `<b>${kind} ${i + 1}</b> · ${(m.distance / 1609.344).toFixed(2)} mi · ↑${Math.round(m.ascent * CONFIG.pace.feetPerMeter)} ft<br><small>${c.offTarget ? 'off target · ' : ''}${c.reasons.map(escapeHtml).join(' · ') || 'balanced'}</small>`;
    card.onclick = () => select(i);
    list.appendChild(card);
  });
  select(0);
}

const escapeHtml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));

function select(i) {
  state.chosen = state.candidates[i];
  document.querySelectorAll('.card').forEach((c, j) => c.classList.toggle('on', i === j));
  drawCandidates(i);
  $('runBar').hidden = false;
}

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/gpx+xml' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

$('gpxBtn').onclick = () => { if (state.chosen) download('run_tracker_route.gpx', toGpx('run_tracker route', [state.chosen.route.coords])); };

// ---------- run ----------
async function keepAwake() {
  try { state.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ }
}
function letSleep() {
  state.wakeLock?.release?.().catch(() => {});
  state.wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.watchId != null && !state.paused) keepAwake();
});

function drawTrack() {
  clearLayers();
  if (state.chosen) add(L.polyline(latlngs(state.chosen.route.coords), { color: UI.colors.planned, weight: 4, opacity: 0.5 }));
  for (const s of state.track.segments) if (s.length > 1) add(L.polyline(latlngs(s), { color: UI.colors.track, weight: 5 }));
  for (const g of state.track.gaps) add(L.polyline(latlngs(g.path), { color: UI.colors.gap, weight: 4, dashArray: '6 8', opacity: g.kind === 'planned' ? 0.9 : 0.5 }));
  const last = state.track.last?.p;
  if (last) add(L.circleMarker(last, { radius: 7, color: UI.colors.track, fillOpacity: 1 }));
}

function tick() {
  const s = trackStats(state.track, state.paused ? state.pauseAt : Date.now());
  $('tTime').textContent = fmtDuration(s.elapsedMs);
  $('tDist').textContent = s.miles.toFixed(2);
  $('tPace').textContent = fmtPace(s.paceMinPerMile);
  $('tEst').textContent = s.estimatedMiles > 0.005 ? `${s.estimatedMiles.toFixed(2)} mi filled from plan` : '';
}

$('startBtn').onclick = () => {
  if (!state.chosen) { status('Plan a run and pick a loop first.', true); return; }
  if (!navigator.geolocation) { status('no GPS on this device', true); return; }
  showTiles();
  state.track = newTrack();
  state.paused = false;
  $('pauseBtn').textContent = 'Pause';
  document.body.classList.add('running');
  keepAwake();
  const planCoords = state.chosen?.route.coords ?? [];
  state.watchId = navigator.geolocation.watchPosition(
    (p) => {
      if (state.paused) return;
      addFix(state.track, { lat: p.coords.latitude, lon: p.coords.longitude, ele: p.coords.altitude, accuracy: p.coords.accuracy, t: p.timestamp }, planCoords);
      drawTrack();
    },
    (e) => status(`GPS: ${e.message}`, true),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
  );
  state.track.startT = Date.now();
  state.timer = setInterval(tick, UI.tickMs);
  status('Running. Keep the screen on for a full track.');
};

$('pauseBtn').onclick = () => {
  if (!state.track) return;
  if (!state.paused) { state.paused = true; state.pauseAt = Date.now(); $('pauseBtn').textContent = 'Resume'; letSleep(); }
  else {
    keepAwake();
    state.track.pausedMs += Date.now() - state.pauseAt;
    // Resume starts a fresh segment so the pause isn't drawn or counted as a gap.
    state.track.last = null;
    state.paused = false; $('pauseBtn').textContent = 'Pause';
  }
};

$('finishBtn').onclick = () => {
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  clearInterval(state.timer);
  letSleep();
  if (state.paused) { state.track.pausedMs += Date.now() - state.pauseAt; state.paused = false; }
  $('pauseBtn').textContent = 'Pause';
  tick();
  document.body.classList.remove('running');
  document.body.classList.add('done');
  const ran = runSegments(state.track).flat();
  if (state.track.distance >= UI.minSavedRunM) saveRun(ran); // remembered for "somewhere new"
  status('Run saved on this device. Export it as GPX if you want a file.');
};

$('ranBtn').onclick = () => {
  if (!state.chosen) return;
  saveRun(state.chosen.route.coords);
  status('Saved as run: "somewhere new" will now count this route as ground you know.');
};

$('saveRunBtn').onclick = () => {
  if (!state.track) return;
  // Planned gap fills go in as their own segments so the file's distance matches the screen.
  const segs = runSegments(state.track);
  download(`run_${new Date().toISOString().slice(0, 10)}.gpx`, toGpx('run_tracker run', segs));
};

$('newBtn').onclick = () => { document.body.classList.remove('done'); state.track = null; if (state.candidates.length) drawCandidates(state.candidates.indexOf(state.chosen)); };

restoreForm();
showHistory();
if (restoredVia) setVia(restoredVia);
