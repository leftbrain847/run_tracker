#!/usr/bin/env node
// Write live/<Project>.html: the project's living version. index_engine pairs it with the day snapshots and links it as
// the current version, so later fixes show up without touching a frozen day. Same opt-in tag as a public snapshot.
// Regenerate with `npm run live` after any change to src/ (a test fails if the file falls behind the build).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from './build.mjs';
import { makePublic, makePrivate } from './snapshot.mjs';

export const LIVE_DIR = 'live';

export function livePage(root) {
  const cfg = JSON.parse(readFileSync(join(root, 'sprint.config.json'), 'utf8'));
  const { html } = build(root);
  return { path: join(root, LIVE_DIR, `${cfg.project}.html`), html: cfg.public ? makePublic(html) : makePrivate(html) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { path, html } = livePage(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, html);
  console.log(`wrote ${path}`);
}
