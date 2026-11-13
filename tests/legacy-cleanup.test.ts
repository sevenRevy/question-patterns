import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/store';
import { backend, temporary } from './fixture';

const content = {
  name: 'Reusable response', format: 'open_response', structure: { response: 'short explanation' },
  rule: 'Ask for an explanation.', reasoning: ['explain'],
};
const summarizeApprovedRecords = (directory: string) => readdirSync(join(directory, 'patterns')).sort().map(name => {
  const record = JSON.parse(readFileSync(join(directory, 'patterns', name), 'utf8'));
  return {
    version: record.version, id: record.id, tags: record.tags, enabled: record.enabled, archived: record.archived,
    versions: record.versions.map(({ revision, content: approved, createdAt }: any) => ({ revision, content: approved, createdAt })),
  };
});

test('activation purges only validated legacy source/history data and preserves all approved state', async () => {
  const temp = temporary();
  try {
    const store = await Store.open(temp.directory);
    const imported = store.importSource({
      filename: 'legacy.md', kind: 'md', location: 'private/legacy.md', bytes: Buffer.from('A legacy prompt.'),
      text: 'A legacy prompt.', notices: [],
    });
    const run = store.createRun({ requestId: crypto.randomUUID(), targetKind: 'source', targetId: imported.id,
      model: { provider: 'test', id: 'model-a' }, instructions: 'private history' });
    store.finishRun(run.id, { patterns: [] }, null);
    const selected = store.patterns()[0]!;
    store.setSessionPattern('saved-session', selected.id, true);
    const editable = store.patterns()[1]!;
    store.savePattern({ ...content, name: 'Approved revision two' }, ['kept', 'tag'], false, editable.id, editable.revision);

    const patternsBefore = summarizeApprovedRecords(temp.directory);
    const source = store.snapshot().sources.find(entry => entry.id === imported.id)!;
    unlinkSync(join(temp.directory, 'sources', `${source.revisionId}.original.md`));
    unlinkSync(join(temp.directory, 'analyses', `${run.id}.result.json`));
    const selectionsPath = join(temp.directory, 'session-selections.json');
    const selectionsBefore = readFileSync(selectionsPath);
    const unrelatedPath = join(temp.directory, 'unrelated.json');
    writeFileSync(unrelatedPath, '{"keep":true}');

    const host = await backend(temp.directory);
    try {
      const snapshot = await host.call<{ patterns: Array<{ id: string; tags: string[]; revision: number; enabled: boolean }> }>('patterns-snapshot');
      assert.equal(snapshot.patterns.length, 12);
      assert.equal(snapshot.patterns.find(pattern => pattern.id === editable.id)?.revision, editable.revision + 1);
      assert.deepEqual(summarizeApprovedRecords(temp.directory), patternsBefore, 'pattern IDs, tags, approved definitions and every revision are preserved');
      for (const name of readdirSync(join(temp.directory, 'patterns'))) {
        const record = JSON.parse(readFileSync(join(temp.directory, 'patterns', name), 'utf8'));
        assert.equal('analysisIds' in record, false);
        assert.equal('activeAnalysisId' in record, false);
        assert.equal('patternIds' in record, false);
        assert.ok(record.versions.every((version: object) => !('runId' in version) && !('itemId' in version)));
      }
      assert.deepEqual(readFileSync(selectionsPath), selectionsBefore, 'session selections are byte-for-byte preserved');
      assert.equal(existsSync(join(temp.directory, 'sources')), false);
      assert.equal(existsSync(join(temp.directory, 'analyses')), false);
      assert.equal(existsSync(join(temp.directory, 'settings.json')), false);
      assert.equal(readFileSync(unrelatedPath, 'utf8'), '{"keep":true}');
      await assert.rejects(host.call('scan'), /Handler not found/);
      await assert.rejects(host.call('import'), /Handler not found/);
    } finally { await host.dispose(); }

    const restarted = await backend(temp.directory);
    try {
      assert.equal((await restarted.call<{ patterns: unknown[] }>('patterns-snapshot')).patterns.length, 12);
      assert.deepEqual(readFileSync(selectionsPath), selectionsBefore);
      assert.equal(existsSync(join(temp.directory, 'sources')), false);
      assert.equal(existsSync(join(temp.directory, 'analyses')), false);
      assert.equal(existsSync(join(temp.directory, 'settings.json')), false);
    } finally { await restarted.dispose(); }
  } finally { temp.remove(); }
});

test('unknown legacy record versions abort activation before deleting any data', async () => {
  const temp = temporary();
  try {
    const store = await Store.open(temp.directory);
    const imported = store.importSource({ filename: 'legacy.txt', kind: 'txt', location: '', bytes: Buffer.from('keep'), text: 'keep', notices: [] });
    const sourcePath = join(temp.directory, 'sources', `${imported.id}.json`);
    const sourceBefore = readFileSync(sourcePath);
    const settingsPath = join(temp.directory, 'settings.json');
    const settingsBefore = readFileSync(settingsPath);
    const unknownId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const unknownPath = join(temp.directory, 'analyses', `${unknownId}.json`);
    writeFileSync(unknownPath, JSON.stringify({ version: 2, run: { id: unknownId } }));

    await assert.rejects(backend(temp.directory), /Unknown legacy record version/);
    assert.deepEqual(readFileSync(sourcePath), sourceBefore);
    assert.deepEqual(readFileSync(settingsPath), settingsBefore);
    assert.equal(existsSync(unknownPath), true);
  } finally { temp.remove(); }
});

test('unknown pattern metadata prevents cleanup rather than clobbering approved data', async () => {
  const temp = temporary();
  try {
    const store = await Store.open(temp.directory);
    const imported = store.importSource({ filename: 'legacy.txt', kind: 'txt', location: '', bytes: Buffer.from('keep'), text: 'keep', notices: [] });
    const sourcePath = join(temp.directory, 'sources', `${imported.id}.json`);
    const sourceBefore = readFileSync(sourcePath);
    const pattern = store.patterns()[0]!;
    const patternPath = join(temp.directory, 'patterns', `${pattern.id}.json`);
    const record = JSON.parse(readFileSync(patternPath, 'utf8'));
    record.version = 2;
    writeFileSync(patternPath, JSON.stringify(record));

    await assert.rejects(backend(temp.directory), /Unknown or invalid pattern metadata/);
    assert.deepEqual(readFileSync(sourcePath), sourceBefore);
    assert.equal(JSON.parse(readFileSync(patternPath, 'utf8')).version, 2);
    assert.equal(existsSync(join(temp.directory, 'settings.json')), true);
  } finally { temp.remove(); }
});

test('cleanup removes recognized partial atomic temporaries from legacy source and analysis folders', async () => {
  const temp = temporary();
  try {
    const sources = join(temp.directory, 'sources');
    const analyses = join(temp.directory, 'analyses');
    mkdirSync(sources);
    mkdirSync(analyses);
    const sourceTemp = join(sources, `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json.${crypto.randomUUID()}.tmp`);
    const analysisTemp = join(analyses, `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.result.json.${crypto.randomUUID()}.tmp`);
    writeFileSync(sourceTemp, '{ partially written');
    writeFileSync(analysisTemp, '{ also partial');

    const host = await backend(temp.directory);
    await host.dispose();
    assert.equal(existsSync(sources), false);
    assert.equal(existsSync(analyses), false);
  } finally { temp.remove(); }
});

test('cleanup removes stale pattern temporaries only when their canonical records validate', async () => {
  const temp = temporary();
  try {
    const store = await Store.open(temp.directory);
    const pattern = store.patterns()[0]!;
    const path = join(temp.directory, 'patterns', `${pattern.id}.json.${crypto.randomUUID()}.tmp`);
    writeFileSync(path, '{ partially written');

    const host = await backend(temp.directory);
    await host.dispose();
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(join(temp.directory, 'patterns', `${pattern.id}.json`)), true);

    const restarted = await backend(temp.directory);
    try {
      assert.equal((await restarted.call<{ patterns: unknown[] }>('patterns-snapshot')).patterns.length, 12);
      assert.equal(existsSync(path), false);
    } finally { await restarted.dispose(); }
  } finally { temp.remove(); }
});

test('orphan or invalid-canonical pattern temporaries abort cleanup without deleting other data', async () => {
  const orphanTemp = temporary();
  try {
    const store = await Store.open(orphanTemp.directory);
    const imported = store.importSource({ filename: 'legacy.txt', kind: 'txt', location: '', bytes: Buffer.from('preserve'), text: 'preserve', notices: [] });
    const sourcePath = join(orphanTemp.directory, 'sources', `${imported.id}.json`);
    const sourceBefore = readFileSync(sourcePath);
    const settingsPath = join(orphanTemp.directory, 'settings.json');
    const settingsBefore = readFileSync(settingsPath);
    const orphanPath = join(orphanTemp.directory, 'patterns', `cccccccc-cccc-4ccc-8ccc-cccccccccccc.json.${crypto.randomUUID()}.tmp`);
    writeFileSync(orphanPath, '{ orphan');

    await assert.rejects(backend(orphanTemp.directory), /Orphan pattern temporary file/);
    assert.deepEqual(readFileSync(sourcePath), sourceBefore);
    assert.deepEqual(readFileSync(settingsPath), settingsBefore);
    assert.equal(existsSync(orphanPath), true);
  } finally { orphanTemp.remove(); }

  const invalidTemp = temporary();
  try {
    const store = await Store.open(invalidTemp.directory);
    const imported = store.importSource({ filename: 'legacy.txt', kind: 'txt', location: '', bytes: Buffer.from('preserve'), text: 'preserve', notices: [] });
    const sourcePath = join(invalidTemp.directory, 'sources', `${imported.id}.json`);
    const sourceBefore = readFileSync(sourcePath);
    const settingsPath = join(invalidTemp.directory, 'settings.json');
    const settingsBefore = readFileSync(settingsPath);
    const pattern = store.patterns()[0]!;
    const canonicalPath = join(invalidTemp.directory, 'patterns', `${pattern.id}.json`);
    writeFileSync(canonicalPath, '{"version":2}');
    const invalidCanonicalBefore = readFileSync(canonicalPath);
    const stalePath = join(invalidTemp.directory, 'patterns', `${pattern.id}.json.${crypto.randomUUID()}.tmp`);
    writeFileSync(stalePath, '{ stale');

    await assert.rejects(backend(invalidTemp.directory), /Unknown or invalid pattern metadata/);
    assert.deepEqual(readFileSync(sourcePath), sourceBefore);
    assert.deepEqual(readFileSync(settingsPath), settingsBefore);
    assert.deepEqual(readFileSync(canonicalPath), invalidCanonicalBefore);
    assert.equal(existsSync(stalePath), true);
  } finally { invalidTemp.remove(); }
});

test('cleanup refuses symlinks inside legacy folders without following or deleting their targets', async t => {
  const temp = temporary();
  try {
    const sources = join(temp.directory, 'sources');
    mkdirSync(sources);
    const target = join(temp.directory, 'outside.txt');
    writeFileSync(target, 'preserve');
    const link = join(sources, 'ffffffff-ffff-4fff-8fff-ffffffffffff.original.txt');
    try { symlinkSync(target, link); }
    catch { t.skip('symlink creation is not available in this environment'); return; }

    await assert.rejects(backend(temp.directory), /Refusing unknown or linked legacy data/);
    assert.equal(readFileSync(target, 'utf8'), 'preserve');
    assert.equal(existsSync(link), true);
  } finally { temp.remove(); }
});
