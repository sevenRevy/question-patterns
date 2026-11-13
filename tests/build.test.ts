import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('build refuses misplaced data and linked output without removing either', () => {
  // Keep the fixture under the workspace so the copied script resolves the existing esbuild dependency.
  const root = mkdtempSync(join(process.cwd(), '.build-fixture-'));
  try {
    mkdirSync(join(root, 'scripts'));
    copyFileSync(resolve('scripts/build.mjs'), join(root, 'scripts/build.mjs'));
    const data = join(root, 'dist', 'data'); mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'keep.json'), 'important');
    const first = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: root, encoding: 'utf8' });
    assert.notEqual(first.status, 0); assert.match(first.stderr, /Refusing dist\/data/);
    assert.equal(readFileSync(join(data, 'keep.json'), 'utf8'), 'important');
    rmSync(join(root, 'dist'), { recursive: true });
    const target = join(root, 'outside-dist'); mkdirSync(target); writeFileSync(join(target, 'keep'), 'important');
    symlinkSync(target, join(root, 'dist'), 'junction');
    const second = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: root, encoding: 'utf8' });
    assert.notEqual(second.status, 0); assert.match(second.stderr, /Refusing symlinked dist/);
    assert.equal(readFileSync(join(target, 'keep'), 'utf8'), 'important');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
