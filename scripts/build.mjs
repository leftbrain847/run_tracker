#!/usr/bin/env node
// Inline src/core.mjs + src/app.mjs into src/index.html -> dist/index.html (one self-contained page for Pages and
// for the day snapshot). dist/ is generated: never commit it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BUILD = { template: 'src/index.html', modules: ['src/core.mjs', 'src/app.mjs'], out: 'dist/index.html', marker: '/*@APP@*/' };

export function inlineModules(sources) {
  return sources
    .map((s) => s
      .replace(/^import\s+[^;]+from\s+['"]\.\/[^'"]+['"];?\s*$/gm, '') // local imports become shared scope
      .replace(/^export\s+(?=(const|let|function|async|class)\b)/gm, ''))
    .join('\n');
}

export function build(root, cfg = BUILD) {
  const tpl = readFileSync(join(root, cfg.template), 'utf8');
  if (!tpl.includes(cfg.marker)) throw new Error(`template is missing ${cfg.marker}`);
  const js = inlineModules(cfg.modules.map((m) => readFileSync(join(root, m), 'utf8')));
  const html = tpl.replace(cfg.marker, () => js);
  const out = join(root, cfg.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  return { out, html };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  console.log(`built ${build(root).out}`);
}
