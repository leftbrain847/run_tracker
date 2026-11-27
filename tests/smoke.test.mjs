// End to end, offline: form inputs -> ORS calls (faked) -> ranked loops -> GPX, then the built page.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, cpSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plan, toGpx, CONFIG } from '../src/core.mjs';
import { build } from '../scripts/build.mjs';
import { orsResponse, fakeFetch, START } from './fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('plan: 40 min at 10:00/mi, hills + end downhill -> top loop is hilly and finishes downhill', async () => {
  const fetchFn = fakeFetch({
    1: orsResponse({ sideM: 1609, hill: 0 }), // 4-mile loop
    2: orsResponse({ sideM: 1609, hill: 50 }),
    3: orsResponse({ sideM: 4000 }), // way too long: dropped
    // 4-6 fail: plan still works
  });
  const res = await plan({ start: START, durationMin: 40, paceMinPerMile: 10, prefs: { surface: 'either', terrain: 'hilly', endDownhill: true }, key: 'test-key', fetchFn });
  assert.equal(fetchFn.calls.length, CONFIG.plan.seeds * 2); // only 2 good loops in batch 1, so it re-asks
  assert.equal(fetchFn.calls[0].headers.Authorization, 'test-key');
  assert.ok(res.candidates.length >= 1 && res.candidates.length <= CONFIG.plan.results);
  const top = res.candidates[0];
  assert.equal(top.route.seed, 2);
  assert.ok(top.metrics.finishDrop > 0);
  assert.ok(!res.candidates.some((c) => c.route.seed === 3));
  assert.match(toGpx('route', [top.route.coords]), /<trkpt/);
});

test('plan: when ORS undershoots, the second batch asks for a longer loop and lands on target', async () => {
  const calls = [];
  const shortBy40 = async (url, init) => { // this ORS returns loops 60% of the length asked for
    const body = JSON.parse(init.body);
    calls.push(body.options.round_trip.length);
    return { ok: true, status: 200, json: async () => orsResponse({ sideM: (body.options.round_trip.length * 0.6) / 4 + (body.options.round_trip.seed % 6) * 20 }) };
  };
  const res = await plan({ start: START, durationMin: 40, paceMinPerMile: 10, key: 'k', fetchFn: shortBy40 });
  assert.equal(calls.length, CONFIG.plan.seeds * 2);
  assert.ok(calls[CONFIG.plan.seeds] > calls[0] * 1.5, 'second batch asks for more length');
  assert.equal(res.candidates.length, CONFIG.plan.results);
  assert.ok(res.candidates.every((c) => !c.offTarget && Math.abs(c.metrics.distance - res.target) / res.target <= CONFIG.plan.distanceTolerance));
});

test('plan: if nothing is close, show the closest loops flagged off target', async () => {
  const wayLong = async () => ({ ok: true, status: 200, json: async () => orsResponse({ sideM: 5000 }) });
  const res = await plan({ start: START, durationMin: 40, paceMinPerMile: 10, key: 'k', fetchFn: wayLong });
  assert.ok(res.candidates.length >= 1);
  assert.ok(res.candidates.every((c) => c.offTarget));
});

test('plan: a dropped request ("Load failed") becomes a readable message', async () => {
  const dead = async () => { throw new TypeError('Load failed'); };
  await assert.rejects(plan({ start: START, durationMin: 30, key: 'k', fetchFn: dead }), /Couldn't reach the routing service/);
});

test('no calls to the retired api.openrouteservice.org host', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['src/core.mjs', 'src/app.mjs', 'src/index.html']) assert.ok(!readFileSync(join(ROOT, f), 'utf8').includes('api.openrouteservice.org'), f);
});

test('plan: needs a key, and reports routing errors', async () => {
  await assert.rejects(plan({ start: START, durationMin: 30, key: '' }), /key/);
  await assert.rejects(plan({ start: START, durationMin: 30, key: 'k', fetchFn: fakeFetch({}) }), /routing failed \(500\)/);
});

test('build: one page with the app inlined, no exports or local imports left, no external fonts', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rt-'));
  cpSync(join(ROOT, 'src'), join(tmp, 'src'), { recursive: true });
  cpSync(join(ROOT, 'vendor'), join(tmp, 'vendor'), { recursive: true });
  const { html } = build(tmp);
  assert.ok(html.includes('function rankCandidates'));
  // nothing loads from another host: the sprint site's publish gate rejects unlisted CDN scripts and styles
  assert.ok(!/<script[^>]+src=/i.test(html), 'no external <script src>');
  assert.ok(!/<link[^>]+rel=["']?stylesheet/i.test(html), 'no external stylesheet');
  assert.ok(html.includes('.leaflet-container'));
  assert.equal((html.match(/BSD 2-Clause License/g) ?? []).length, 2, 'full license text before the CSS and the JS');
  assert.ok(html.includes('THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS'));
  // the run bar stays hidden until a loop is picked (a class display rule must not override [hidden])
  assert.ok(/\.bar\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(html));
  assert.ok(html.includes("if (!state.chosen) { status('Plan a run and pick a loop first.'"));
  // map tiles are added only by showTiles(), never on load
  assert.equal((html.match(/L\.tileLayer\(/g) ?? []).length, 1);
  assert.ok(/function showTiles\(\)[\s\S]*?L\.tileLayer\(/.test(html));
  assert.ok(html.includes("getElementById('planBtn')") || html.includes('planBtn'));
  assert.ok(!/^\s*export\s/m.test(html));
  assert.ok(!/from\s+['"]\.\/core\.mjs['"]/.test(html));
  assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(html));
  assert.ok(!html.includes('/*@APP@*/'));
  // every external script/style is pinned with SRI
  for (const tag of html.match(/<(script|link)[^>]+(src|href)="https:[^"]+"[^>]*>/g) ?? []) assert.match(tag, /integrity="sha384-/, tag);
});

test('build refuses a vendored file that does not match its pinned hash', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rt-'));
  cpSync(join(ROOT, 'src'), join(tmp, 'src'), { recursive: true });
  cpSync(join(ROOT, 'vendor'), join(tmp, 'vendor'), { recursive: true });
  writeFileSync(join(tmp, 'vendor/leaflet-1.9.4/leaflet.js'), 'tampered');
  assert.throws(() => build(tmp), /pinned hash/);
});

test('build output parses as a JS module', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rt-'));
  cpSync(join(ROOT, 'src'), join(tmp, 'src'), { recursive: true });
  cpSync(join(ROOT, 'vendor'), join(tmp, 'vendor'), { recursive: true });
  const { html } = build(tmp);
  const js = html.split('<script type="module">')[1].split('</script>')[0];
  const file = join(tmp, 'inline.mjs');
  writeFileSync(file, js);
  execFileSync(process.execPath, ['--check', file]); // throws on a syntax error
});

test('live/<Project>.html matches the current build (run `npm run live` after changing src/)', async () => {
  const { livePage } = await import('../scripts/live.mjs');
  const { readFileSync, existsSync } = await import('node:fs');
  const tmp = mkdtempSync(join(tmpdir(), 'rt-'));
  for (const d of ['src', 'vendor']) cpSync(join(ROOT, d), join(tmp, d), { recursive: true });
  cpSync(join(ROOT, 'sprint.config.json'), join(tmp, 'sprint.config.json'));
  const want = livePage(tmp);
  const file = join(ROOT, 'live', want.path.split('/live/')[1]);
  assert.ok(existsSync(file), `${file} is missing`);
  assert.equal(readFileSync(file, 'utf8'), want.html, 'live page is stale: run npm run live');
  assert.match(want.html, /<meta name="sprint-public" content="yes">/);
});

test('how-to popup: links to the HeiGIT account site, opens when there is no key', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rt-'));
  for (const d of ['src', 'vendor']) cpSync(join(ROOT, d), join(tmp, d), { recursive: true });
  const { html } = build(tmp);
  assert.match(html, /<dialog id="howto"/);
  assert.match(html, /href="https:\/\/account\.heigit\.org\/"/);
  assert.ok(!html.includes('openrouteservice.org/dev'), 'no retired signup link');
  assert.match(html, /if \(!key\) \{ openHowto\(\);/);
});
