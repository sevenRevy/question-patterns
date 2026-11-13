import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PatternsSnapshot, TemplatesSnapshot } from '../src/domain';
import { Store } from '../src/store';
import { CORE_PATTERNS } from '../src/structures';
import { backend, temporary } from './fixture';

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const clearSession = async (host: Awaited<ReturnType<typeof backend>>, sessionId: string) => {
  const patterns = await host.call<Array<{ id: string; selected: boolean }>>('session-patterns', { sessionId });
  for (const pattern of patterns) if (pattern.selected) {
    await host.call('session-pattern-set', { sessionId, patternId: pattern.id, selected: false });
  }
};
const clearStoreSession = (store: Store, sessionId: string) => {
  for (const pattern of store.sessionPatterns(sessionId)) if (pattern.selected) {
    store.setSessionPattern(sessionId, pattern.id, false);
  }
};

test('pattern-delete permanently removes history and references, and core seeds stay deleted after reopen', async () => {
  const temp = temporary();
  let host = await backend(temp.directory);
  try {
    const before = await host.call<PatternsSnapshot>('patterns-snapshot');
    const core = before.patterns.find(pattern => pattern.id === CORE_PATTERNS[0]!.id)!;
    const example = (text: string) => ({ id: crypto.randomUUID(), text, forced: false });
    const customId = await host.call<string>('pattern-save', {
      content: { name: 'Disposable custom pattern', format: 'disposable', structure: {}, rule: 'Use this once.', reasoning: [] },
      tags: ['temporary'], enabled: true, examples: [example('First example')], exampleLimit: 2,
    });
    await host.call('pattern-save', {
      id: customId, expectedRevision: 1,
      content: { name: 'Revised disposable pattern', format: 'disposable', structure: {}, rule: 'Use this once.', reasoning: [] },
      tags: ['temporary'], enabled: true, examples: [example('Second example')], exampleLimit: 1,
    });
    const customFile = join(temp.directory, 'patterns', `${customId}.json`);
    assert.equal(readJson(customFile).versions.length, 2, 'test record has version history before deletion');

    const templateId = await host.call<string>('template-save', {
      name: 'Delete members', patternIds: [customId, core.id],
    });
    await host.call('favorite-set', { kind: 'pattern', id: customId, favorite: true });
    await host.call('favorite-set', { kind: 'pattern', id: core.id, favorite: true });
    await host.call('favorite-set', { kind: 'template', id: templateId, favorite: true });
    await clearSession(host, 'deletion-session');
    await host.call('session-template-apply', { sessionId: 'deletion-session', templateId, mode: 'add' });

    const templatesPath = join(temp.directory, 'templates.json');
    const favoritesPath = join(temp.directory, 'favorites.json');
    const sessionsPath = join(temp.directory, 'session-selections.json');
    const journalPath = join(temp.directory, 'deleted-patterns.json');
    const unchangedPaths = [customFile, templatesPath, favoritesPath, sessionsPath];
    const bytesBeforeStaleDelete = unchangedPaths.map(path => readFileSync(path));
    await assert.rejects(host.call('pattern-delete', { id: customId, expectedRevision: 1 }), /changed/);
    unchangedPaths.forEach((path, index) => assert.deepEqual(readFileSync(path), bytesBeforeStaleDelete[index]));
    assert.equal(existsSync(journalPath), false, 'stale revision does not record a deletion intent');
    for (const invalid of [
      { id: 'not-a-uuid', expectedRevision: 2 },
      { id: customId, expectedRevision: 0 },
      { id: customId, expectedRevision: 1.5 },
      { id: customId, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
      { id: customId, expectedRevision: 2, extra: true },
    ]) await assert.rejects(host.call('pattern-delete', invalid), /Invalid/);

    await host.call('pattern-delete', { id: customId, expectedRevision: 2 });
    assert.equal(existsSync(customFile), false, 'all pattern versions and example banks live in the removed record');
    assert.equal((await host.call<PatternsSnapshot>('patterns-snapshot')).patterns.some(pattern => pattern.id === customId), false);
    assert.deepEqual(readJson(journalPath), { version: 1, patternIds: [customId] });
    let template = (await host.call<TemplatesSnapshot>('templates-snapshot')).templates[0]!;
    assert.equal(template.revision, 2);
    assert.deepEqual(template.patternIds, [core.id]);
    assert.deepEqual(readJson(favoritesPath).favorites, [{ kind: 'pattern', id: core.id }, { kind: 'template', id: templateId }]);
    assert.deepEqual(readJson(sessionsPath).sessions[0], {
      sessionId: 'deletion-session', patternIds: [core.id], exampleLimitBypassIds: [core.id],
    });
    assert.deepEqual(host.emitted.at(-1), { topic: 'library-changed', data: undefined });
    await assert.rejects(host.call('pattern-save', {
      id: customId, expectedRevision: 2,
      content: { name: 'Resurrected', format: 'disposable', structure: {}, rule: 'No.', reasoning: [] },
      tags: [], enabled: true,
    }), /permanently deleted/);

    await host.call('pattern-delete', { id: core.id, expectedRevision: core.revision });
    assert.equal(existsSync(join(temp.directory, 'patterns', `${core.id}.json`)), false);
    template = (await host.call<TemplatesSnapshot>('templates-snapshot')).templates[0]!;
    assert.equal(template.revision, 3);
    assert.deepEqual(template.patternIds, [], 'templates remain after their last pattern is deleted');
    assert.deepEqual(readJson(favoritesPath).favorites, [{ kind: 'template', id: templateId }]);
    assert.deepEqual(readJson(sessionsPath).sessions, [{ sessionId: 'deletion-session', patternIds: [] }],
      'deleting the final selection retains the empty session initialization marker');
    assert.deepEqual(readJson(journalPath), { version: 1, patternIds: [customId, core.id] });
    await assert.rejects(host.call('pattern-enabled-set', { id: core.id, enabled: false }), /permanently deleted/);

    await host.dispose();
    host = await backend(temp.directory);
    const reopened = await host.call<PatternsSnapshot>('patterns-snapshot');
    assert.equal(reopened.patterns.length, 11);
    assert.ok(!reopened.patterns.some(pattern => pattern.id === customId || pattern.id === core.id));
    await host.dispose();

    const fullStore = await Store.open(temp.directory);
    try {
      assert.ok(!fullStore.patternsSnapshot().patterns.some(pattern => pattern.id === core.id));
      assert.deepEqual(readJson(journalPath).patternIds, [customId, core.id]);
    } finally { fullStore.close(); }
  } finally { await host.dispose(); temp.remove(); }
});

test('deletion validates all affected records first and resumes journaled cleanup on open', async () => {
  const temp = temporary();
  let store = await Store.openPatterns(temp.directory);
  try {
    const pattern = store.patternsSnapshot().patterns[0]!;
    const templateId = store.saveTemplate('To be emptied', [pattern.id]);
    store.setFavorite('pattern', pattern.id, true);
    clearStoreSession(store, 'interrupted-deletion');
    store.setSessionPattern('interrupted-deletion', pattern.id, true);

    const patternPath = join(temp.directory, 'patterns', `${pattern.id}.json`);
    const templatesPath = join(temp.directory, 'templates.json');
    const favoritesPath = join(temp.directory, 'favorites.json');
    const sessionsPath = join(temp.directory, 'session-selections.json');
    const journalPath = join(temp.directory, 'deleted-patterns.json');
    const patternBefore = readFileSync(patternPath);
    const templatesBefore = readFileSync(templatesPath);
    const favoritesBefore = readFileSync(favoritesPath);
    const sessionsBefore = readFileSync(sessionsPath);

    writeFileSync(sessionsPath, '{broken json');
    assert.throws(() => store.deletePattern(pattern.id, pattern.revision), /JSON|Session selections/);
    assert.deepEqual(readFileSync(patternPath), patternBefore);
    assert.deepEqual(readFileSync(templatesPath), templatesBefore);
    assert.deepEqual(readFileSync(favoritesPath), favoritesBefore);
    assert.equal(existsSync(journalPath), false, 'invalid affected data prevents recording or applying deletion');

    writeFileSync(journalPath, JSON.stringify({ version: 1, patternIds: [pattern.id] }));
    await assert.rejects(Store.openPatterns(temp.directory), /JSON|Session selections/);
    assert.deepEqual(readFileSync(patternPath), patternBefore, 'failed recovery leaves the pattern intact');
    assert.deepEqual(readFileSync(templatesPath), templatesBefore);
    assert.deepEqual(readFileSync(favoritesPath), favoritesBefore);

    writeFileSync(sessionsPath, sessionsBefore);
    store.close();
    store = await Store.openPatterns(temp.directory);
    assert.ok(!store.patternsSnapshot().patterns.some(item => item.id === pattern.id));
    assert.deepEqual(store.templates().find(template => template.id === templateId)?.patternIds, []);
    assert.equal(store.templates().find(template => template.id === templateId)?.revision, 2);
    assert.deepEqual(store.favoritesSnapshot().favorites, []);
    assert.deepEqual(readJson(sessionsPath).sessions, [{ sessionId: 'interrupted-deletion', patternIds: [] }]);
    assert.deepEqual(readJson(journalPath), { version: 1, patternIds: [pattern.id] });
  } finally { store.close(); temp.remove(); }
});

test('deletePattern retry resumes a committed cleanup without reopening the store', async () => {
  const temp = temporary();
  const store = await Store.openPatterns(temp.directory);
  try {
    const pattern = store.patternsSnapshot().patterns[0]!;
    const templateId = store.saveTemplate('Retry deletion', [pattern.id]);
    store.setFavorite('pattern', pattern.id, true);
    clearStoreSession(store, 'retry-deletion');
    store.setSessionPattern('retry-deletion', pattern.id, true);

    const patternPath = join(temp.directory, 'patterns', `${pattern.id}.json`);
    const journalPath = join(temp.directory, 'deleted-patterns.json');
    writeFileSync(journalPath, JSON.stringify({ version: 1, patternIds: [pattern.id] }));
    assert.throws(() => store.deletePattern(pattern.id, 0), /positive safe integer/);

    store.deletePattern(pattern.id, pattern.revision);
    assert.equal(existsSync(patternPath), false);
    assert.deepEqual(store.templates().find(template => template.id === templateId)?.patternIds, []);
    assert.equal(store.templates().find(template => template.id === templateId)?.revision, 2);
    assert.deepEqual(store.favoritesSnapshot().favorites, []);
    assert.deepEqual(readJson(join(temp.directory, 'session-selections.json')).sessions, [{ sessionId: 'retry-deletion', patternIds: [] }]);

    store.deletePattern(pattern.id, pattern.revision);
    assert.equal(store.templates().find(template => template.id === templateId)?.revision, 2,
      'repeated retries do not bump an already-clean template');
    assert.deepEqual(readJson(journalPath), { version: 1, patternIds: [pattern.id] });
  } finally { store.close(); temp.remove(); }
});

test('pattern-delete notifies when cleanup fails after the deletion journal is committed', async () => {
  const temp = temporary();
  const storePrototype = Store.prototype as unknown as {
    applyPatternDeletionCleanup: (plan: any) => void;
  };
  const originalCleanup = storePrototype.applyPatternDeletionCleanup;
  let host: Awaited<ReturnType<typeof backend>> | undefined;
  try {
    host = await backend(temp.directory);
    const id = await host.call<string>('pattern-save', {
      content: { name: 'Retryable pattern', format: 'retryable', structure: {}, rule: 'Delete it.', reasoning: [] },
      tags: [], enabled: true,
    });
    const journalPath = join(temp.directory, 'deleted-patterns.json');
    const emittedBefore = host.emitted.length;

    storePrototype.applyPatternDeletionCleanup = () => { throw new Error('simulated cleanup failure'); };
    await assert.rejects(host.call('pattern-delete', { id, expectedRevision: 1 }), /simulated cleanup failure/);
    assert.deepEqual(readJson(journalPath), { version: 1, patternIds: [id] });
    assert.deepEqual(host.emitted.slice(emittedBefore), [{ topic: 'library-changed', data: undefined }]);

    storePrototype.applyPatternDeletionCleanup = originalCleanup;
    await host.call('pattern-delete', { id, expectedRevision: 1 });
    assert.equal(existsSync(join(temp.directory, 'patterns', `${id}.json`)), false);
  } finally {
    storePrototype.applyPatternDeletionCleanup = originalCleanup;
    await host?.dispose();
    temp.remove();
  }
});
