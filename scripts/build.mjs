#!/usr/bin/env node
// Inline src/core.mjs + src/app.mjs into src/index.html -> dist/index.html (one self-contained page for Pages and
// for the day snapshot). dist/ is generated: never commit it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BUILD = {
  template: 'src/index.html', modules: ['src/core.mjs', 'src/app.mjs'], out: 'dist/index.html', marker: '/*@APP@*/',
  // Third-party code is inlined so the page loads nothing from other hosts (the public sites' publish check requires
  // it). Each file is verified against the hash of the published npm release before it goes in.
  vendor: [
    { marker: '/*@LEAFLET_CSS@*/', file: 'vendor/leaflet-1.9.4/leaflet.css', sha384: 'sHL9NAb7lN7rfvG5lfHpm643Xkcjzp4jFvuavGOndn6pjVqS6ny56CAt3nsEVT4H',
      banner: '/* Leaflet 1.9.4 | BSD-2-Clause | (c) 2010-2023 Volodymyr Agafonkin, (c) 2010-2011 CloudMade | full license: github.com/Leaflet/Leaflet/blob/v1.9.4/LICENSE */\n' },
    { marker: '/*@LEAFLET_JS@*/', file: 'vendor/leaflet-1.9.4/leaflet.js', sha384: 'cxOPjt7s7Iz04uaHJceBmS+qpjv2JkIHNVcuOrM+YHwZOmJGBXI00mdUXEq65HTH',
      banner: '' }, // leaflet.js carries its own license header
  ],
};

export function sha384(buf) {
  return createHash('sha384').update(buf).digest('base64');
}

export function inlineVendor(html, root, vendor) {
  for (const v of vendor) {
    const buf = readFileSync(join(root, v.file));
    if (sha384(buf) !== v.sha384) throw new Error(`${v.file} does not match its pinned hash`);
    const text = buf.toString('utf8');
    if (/<\/(script|style)/i.test(text)) throw new Error(`${v.file} would close its tag early`);
    if (!html.includes(v.marker)) throw new Error(`template is missing ${v.marker}`);
    html = html.replace(v.marker, () => v.banner + text);
  }
  return html;
}

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
  const html = inlineVendor(tpl.replace(cfg.marker, () => js), root, cfg.vendor ?? []);
  const out = join(root, cfg.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  return { out, html };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  console.log(`built ${build(root).out}`);
}
