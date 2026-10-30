// Builds the unpacked extension into dist/. Usage: node src/tools/build.mjs
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundle } from './bundle.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DIST = join(ROOT, 'dist');

const BUNDLES = [
  ['background.js', 'src/background/service-worker.ts'],
  ['content.js', 'src/content/main.ts'],
  ['sidepanel.js', 'src/sidepanel/main.ts'],
];

const COPIES = [
  ['manifest.json', 'manifest.json'],
  ['content.css', 'src/content/content.css'],
  ['sidepanel.html', 'src/sidepanel/sidepanel.html'],
  ['sidepanel.css', 'src/sidepanel/sidepanel.css'],
];

/** Files the manifest refers to; every one must exist in dist/. */
function manifestReferences(manifest) {
  const refs = new Set();
  refs.add(manifest.background.service_worker);
  refs.add(manifest.side_panel.default_path);
  for (const script of manifest.content_scripts) {
    for (const file of [...(script.js ?? []), ...(script.css ?? [])]) refs.add(file);
  }
  for (const icon of Object.values(manifest.icons ?? {})) refs.add(icon);
  for (const icon of Object.values(manifest.action?.default_icon ?? {})) refs.add(icon);
  return [...refs];
}

export function build({ quiet = false } = {}) {
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(join(DIST, 'icons'), { recursive: true });

  for (const [out, entry] of BUNDLES) {
    writeFileSync(join(DIST, out), bundle(ROOT, join(ROOT, entry)));
  }
  for (const [out, src] of COPIES) {
    copyFileSync(join(ROOT, src), join(DIST, out));
  }
  for (const icon of readdirSync(join(ROOT, 'icons')).filter((f) => f.endsWith('.png'))) {
    copyFileSync(join(ROOT, 'icons', icon), join(DIST, 'icons', icon));
  }

  const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
  const missing = manifestReferences(manifest).filter((file) => !existsSync(join(DIST, file)));
  if (missing.length > 0) throw new Error(`Manifest references missing files: ${missing.join(', ')}`);

  if (!quiet) console.log(`Folio ${manifest.version} built into ${DIST}`);
  return DIST;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  build();
}
