// The in-repo bundler must produce working code and fail loudly on anything it
// does not support.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { after, describe, it } from 'node:test';
import { bundle } from '../../src/tools/bundle.mjs';

const dir = mkdtempSync(join(tmpdir(), 'folio-bundle-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(dir, 'p-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  return root;
}

describe('bundle', () => {
  it('bundles named, namespace and type-only imports into a working IIFE', () => {
    const root = project({
      'a.ts': "export const base: number = 40;\nexport function add(x: number): number { return x + base; }\nexport interface Shape { n: number }\n",
      'b.ts': "import { add as plus } from './a.ts';\nimport * as A from './a.ts';\nimport type { Shape } from './a.ts';\nconst s: Shape = { n: plus(2) };\n(globalThis as any).result = [s.n, A.base];\n",
    });
    const context: { result?: unknown } = {};
    runInNewContext(bundle(root, join(root, 'b.ts')), context);
    // The array comes from another realm, so compare its contents, not its prototype.
    assert.deepEqual(Array.from(context.result as number[]), [42, 40]);
  });

  it('rejects a type imported as a value', () => {
    const root = project({ 'a.ts': 'export interface Shape { n: number }\n', 'b.ts': "import { Shape } from './a.ts';\n" });
    assert.throws(() => bundle(root, join(root, 'b.ts')), /not a runtime export/);
  });

  it('rejects default exports, package imports and cycles', () => {
    const def = project({ 'a.ts': 'export default 1;\n' });
    assert.throws(() => bundle(def, join(def, 'a.ts')), /unsupported export/);
    const pkg = project({ 'a.ts': "import { x } from 'left-pad';\n" });
    assert.throws(() => bundle(pkg, join(pkg, 'a.ts')), /only relative imports/);
    const cyc = project({ 'a.ts': "import { b } from './b.ts';\nexport const a = 1;\n", 'b.ts': "import { a } from './a.ts';\nexport const b = 2;\n" });
    assert.throws(() => bundle(cyc, join(cyc, 'a.ts')), /Import cycle/);
  });

  it('rejects syntax that cannot be erased (enums)', () => {
    const root = project({ 'a.ts': 'export enum Color { Red }\n' });
    assert.throws(() => bundle(root, join(root, 'a.ts')), /Type stripping failed|unsupported/);
  });
});
