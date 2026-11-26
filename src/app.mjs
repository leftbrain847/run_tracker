// run_tracker UI. Imports core; the build inlines both into one page.
import { CONFIG, PREF_DEFAULTS, NETWORK_ERROR, locationMessage, plan, geocodeUrl, parseGeocode, newTrack, addFix, runSegments, trackStats, toGpx, fmtDuration, fmtPace } from './core.mjs';

const UI = {
  storageKeys: { orsKey: 'run_tracker.ors_key', form: 'run_tracker.form' },
  colors: { planned: '#2563eb', alt: '#94a3b8', track: '#dc2626', gap: '#dc2626' },
  tiles: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '&copy; OpenStreetMap contributors', maxZoom: 19 },
  tickMs: 1000,
};

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage off: fine */ } },
};

const state = { start: null, candidates: [], chosen: null, track: null, watchId: null, wakeLock: null, timer: null, layers: [], paused: false, pauseAt: null };

// ---------- map ----------
const map = L.map('map', { zoomControl: false }).setView([38.9, -77.04], 12);
L.tileLayer(UI.tiles.url, { attribution: UI.tiles.attribution, maxZoom: UI.tiles.maxZoom }).addTo(map);
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
  map.fitBounds(line.getBounds(), { padding: [20, 20] });
}

// ---------- form ----------
function readForm() {
  return {
    durationMin: Number($('duration').value),
    paceMinPerMile: Number($('pace').value),
    zip: $('zip').value.trim(),
    prefs: {
      surface: document.querySelector('input[name=surface]:checked')?.value ?? PREF_DEFAULTS.surface,
      terrain: document.querySelector('input[name=terrain]:checked')?.value ?? PREF_DEFAULTS.terrain,
      endDownhill: $('endDownhill').checked,
    },
  };
}

function restoreForm() {
  $('orsKey').value = store.get(UI.storageKeys.orsKey) ?? '';
  try {
    const f = JSON.parse(store.get(UI.storageKeys.form) ?? 'null');
    if (!f) return;
    $('duration').value = f.durationMin; $('pace').value = f.paceMinPerMile; $('zip').value = f.zip ?? '';
    for (const n of ['surface', 'terrain']) { const el = document.querySelector(`input[name=${n}][value=${f.prefs?.[n]}]`); if (el) el.checked = true; }
    $('endDownhill').checked = !!f.prefs?.endDownhill;
  } catch { /* ignore */ }
  $('durationOut').textContent = `${$('duration').value} min`;
}

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
  try { state.start = await locate(); $('zip').value = ''; status('Using your location.'); map.setView([state.start.lat, state.start.lon], 14); }
  catch (e) { status(e.message, true); }
};

$('duration').oninput = () => { $('durationOut').textContent = `${$('duration').value} min`; };

$('planBtn').onclick = async () => {
  const key = $('orsKey').value.trim();
  store.set(UI.storageKeys.orsKey, key);
  const f = readForm();
  store.set(UI.storageKeys.form, JSON.stringify(f));
  try {
    if (!key) throw new Error('add your free openrouteservice key (Setup)');
    if (f.zip) {
      status('Looking up zip…');
      let r;
      try { r = await fetch(geocodeUrl(f.zip, key)); } catch { throw new Error(NETWORK_ERROR); }
      if (!r.ok) throw new Error(`zip lookup failed (${r.status})`);
      state.start = parseGeocode(await r.json());
    }
    if (!state.start) throw new Error('tap "Use my location" or type a zip');
    status(`Building ${CONFIG.plan.seeds} loops and scoring them…`);
    $('planBtn').disabled = true;
    const res = await plan({ start: state.start, durationMin: f.durationMin, paceMinPerMile: f.paceMinPerMile, prefs: f.prefs, key });
    state.candidates = res.candidates;
    renderCandidates(res.target);
    $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) { status(e.message, true); }
  finally { $('planBtn').disabled = false; }
};

function renderCandidates(target) {
  const list = $('results');
  list.innerHTML = '';
  if (!state.candidates.length) { status(`No loops came close to ${(target / 1609.344).toFixed(1)} mi. Try again or change the duration.`, true); return; }
  status(`Target ${(target / 1609.344).toFixed(2)} mi. Tap a loop, then Run it.`);
  state.candidates.forEach((c, i) => {
    const m = c.metrics;
    const card = document.createElement('button');
    card.className = 'card';
    card.innerHTML = `<b>Loop ${i + 1}</b> · ${(m.distance / 1609.344).toFixed(2)} mi · ↑${Math.round(m.ascent * CONFIG.pace.feetPerMeter)} ft<br><small>${c.reasons.map(escapeHtml).join(' · ') || 'balanced'}</small>`;
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
  if (!navigator.geolocation) { status('no GPS on this device', true); return; }
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
  status('Run saved below. Export it as GPX if you want to keep it.');
};

$('saveRunBtn').onclick = () => {
  if (!state.track) return;
  // Planned gap fills go in as their own segments so the file's distance matches the screen.
  const segs = runSegments(state.track);
  download(`run_${new Date().toISOString().slice(0, 10)}.gpx`, toGpx('run_tracker run', segs));
};

$('newBtn').onclick = () => { document.body.classList.remove('done'); state.track = null; if (state.candidates.length) drawCandidates(state.candidates.indexOf(state.chosen)); };

restoreForm();
