// Static privacy, permission and package-integrity audit.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { bundle } from '../../src/tools/bundle.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** APIs and patterns Folio must never use (spec section 6). */
const FORBIDDEN: [string, RegExp][] = [
  ['fetch()', /\bfetch\s*\(/],
  ['XMLHttpRequest', /XMLHttpRequest/],
  ['WebSocket', /\bWebSocket\b/],
  ['EventSource', /\bEventSource\b/],
  ['sendBeacon', /sendBeacon/],
  ['document.cookie', /document\.cookie/],
  ['chrome.cookies', /chrome\.cookies/],
  ['password fields', /password/i],
  ['eval', /\beval\s*\(/],
  ['new Function', /new\s+Function\s*\(/],
  ['importScripts', /importScripts/],
  ['dynamic import', /\bimport\s*\(/],
  ['innerHTML', /\.innerHTML\b/],
  ['outerHTML', /\.outerHTML\b/],
  ['insertAdjacentHTML', /insertAdjacentHTML/],
  ['document.write', /document\.write/],
  ['page localStorage', /\blocalStorage\b/],
  ['page sessionStorage', /\bsessionStorage\b/],
  ['indexedDB', /\bindexedDB\b/],
  ['chrome.scripting / webRequest / history / downloads', /chrome\.(scripting|webRequest|history|downloads)\b/],
  ['non-claude.ai URL', /https?:\/\/(?!claude\.ai[/'"`*])/],
];

function scan(label: string, text: string): string[] {
  return FORBIDDEN.filter(([, re]) => re.test(text)).map(([name]) => `${label}: ${name}`);
}

describe('manifest', () => {
  it('is MV3 with only the storage and sidePanel permissions', () => {
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual([...manifest.permissions].sort(), ['sidePanel', 'storage']);
    for (const key of ['host_permissions', 'optional_permissions', 'optional_host_permissions', 'web_accessible_resources', 'externally_connectable', 'sandbox']) {
      assert.equal(manifest[key], undefined, `${key} must not be declared`);
    }
    assert.ok(Number(manifest.minimum_chrome_version) >= 116);
  });

  it('runs one content script, only on https://claude.ai/*, top frame only', () => {
    assert.equal(manifest.content_scripts.length, 1);
    const [script] = manifest.content_scripts;
    assert.deepEqual(script.matches, ['https://claude.ai/*']);
    assert.equal(script.all_frames, false);
    assert.equal(script.match_about_blank, undefined);
    assert.equal(script.world, undefined, 'content script must stay in the isolated world');
  });

  it('has a strict extension-page CSP with no remote or inline code', () => {
    const csp: string = manifest.content_security_policy.extension_pages;
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /connect-src 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /default-src 'none'/);
    assert.doesNotMatch(csp, /unsafe-|https?:|\*|data:|blob:/);
  });
});

describe('source and bundle scan', () => {
  it('source files use no network, cookie, credential, eval or HTML-injection APIs', () => {
    const files = walk(join(ROOT, 'src')).filter((f) => !f.endsWith('chrome.d.ts'));
    const problems = files.flatMap((file) => scan(relative(ROOT, file), readFileSync(file, 'utf8')));
    assert.deepEqual(problems, []);
  });

  it('bundled scripts contain none of them either', () => {
    for (const entry of ['src/background/service-worker.ts', 'src/content/main.ts', 'src/sidepanel/main.ts']) {
      assert.deepEqual(scan(entry, bundle(ROOT, join(ROOT, entry))), []);
    }
  });

  it('the panel HTML has no inline script, inline handlers or remote resources', () => {
    const html = readFileSync(join(ROOT, 'src/sidepanel/sidepanel.html'), 'utf8');
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
    assert.doesNotMatch(html, /\sstyle\s*=/i);
    assert.doesNotMatch(html, /(src|href)="https?:/);
  });
});

describe('documentation and fixtures', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

  it('README states the owner copyright and does not claim MIT', () => {
    assert.ok(readme.includes('Copyright (c) 2026 Edward Jones. All rights reserved.'));
    assert.doesNotMatch(readme, /\bMIT\b/);
  });

  it('README documents every permission and the content-script origin', () => {
    for (const permission of manifest.permissions) assert.ok(readme.includes(`\`${permission}\``), permission);
    assert.ok(readme.includes('https://claude.ai/*'));
  });

  it('every fixture is labelled synthetic', () => {
    const dir = join(ROOT, 'fixtures', 'claude');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.html'))) {
      const html = readFileSync(join(dir, file), 'utf8');
      assert.ok(html.includes('<meta name="folio-fixture" content="synthetic">'), file);
      assert.ok(html.includes('SYNTHETIC TEST FIXTURE'), file);
    }
    assert.ok(readFileSync(join(dir, 'long.ts'), 'utf8').includes('SYNTHETIC'));
  });
});
