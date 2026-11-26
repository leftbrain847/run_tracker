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
  assert.equal(fetchFn.calls.length, CONFIG.plan.seeds);
  assert.equal(fetchFn.calls[0].headers.Authorization, 'test-key');
  assert.ok(res.candidates.length >= 1 && res.candidates.length <= CONFIG.plan.results);
  const top = res.candidates[0];
  assert.equal(top.route.seed, 2);
  assert.ok(top.metrics.finishDrop > 0);
  assert.ok(!res.candidates.some((c) => c.route.seed === 3));
  assert.match(toGpx('route', [top.route.coords]), /<trkpt/);
});

test('plan: needs a key, and reports routing errors', async () => {
  await assert.rejects(plan({ start: START, durationMin: 30, key: '' }), /key/);
  await assert.rejects(plan({ start: START, durationMin: 30, key: 'k', fetchFn: fakeFetch({}) }), /routing failed \(500\)/);
});

test('build: one page with the app inlined, no exports or local imports left, no external fonts', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rt-'));
  cpSync(join(ROOT, 'src'), join(tmp, 'src'), { recursive: true });
  const { html } = build(tmp);
  assert.ok(html.includes('function rankCandidates'));
  assert.ok(html.includes("getElementById('planBtn')") || html.includes('planBtn'));
  assert.ok(!/^\s*export\s/m.test(html));
  assert.ok(!/from\s+['"]\.\/core\.mjs['"]/.test(html));
  assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(html));
  assert.ok(!html.includes('/*@APP@*/'));
  // every external script/style is pinned with SRI
  for (const tag of html.match(/<(script|link)[^>]+(src|href)="https:[^"]+"[^>]*>/g) ?? []) assert.match(tag, /integrity="sha384-/, tag);
});

test('build output parses as a JS module', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rt-'));
  cpSync(join(ROOT, 'src'), join(tmp, 'src'), { recursive: true });
  const { html } = build(tmp);
  const js = html.split('<script type="module">')[1].split('</script>')[0];
  const file = join(tmp, 'inline.mjs');
  writeFileSync(file, js);
  execFileSync(process.execPath, ['--check', file]); // throws on a syntax error
});
