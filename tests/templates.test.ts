import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pattern, PatternTemplate, PatternsSnapshot, TemplatesSnapshot } from '../src/domain';
import { Store } from '../src/store';
import { backend, temporary } from './fixture';

const templateData = (template: PatternTemplate) => ({ name: template.name, patternIds: template.patternIds });
const saveTemplate = (host: Awaited<ReturnType<typeof backend>>, name: string, patternIds: string[], bypassOverallLimit?: boolean) =>
  host.call<string>('template-save', { name, patternIds, ...(bypassOverallLimit !== undefined ? { bypassOverallLimit } : {}) });
const saveBank = (store: Store, pattern: Pattern, examples: Array<{ id: string; text: string; forced: boolean }>, exampleLimit?: number | null) =>
  store.savePattern({
    name: pattern.name, format: pattern.format, structure: pattern.structure, rule: pattern.rule, reasoning: pattern.reasoning,
  }, pattern.tags, pattern.enabled, pattern.id, pattern.revision, undefined, {
    examples, ...(exampleLimit !== undefined ? { exampleLimit } : {}),
  });
const examples = (count: number, forcedCount = 0) => Array.from({ length: count }, (_, index) => ({
  id: crypto.randomUUID(), text: `Example ${index + 1}`, forced: index < forcedCount,
}));
const clearSession = async (host: Awaited<ReturnType<typeof backend>>, sessionId: string) => {
  const patterns = await host.call<Array<{ id: string; selected: boolean }>>('session-patterns', { sessionId });
  for (const pattern of patterns) if (pattern.selected) {
    await host.call('session-pattern-set', { sessionId, patternId: pattern.id, selected: false });
  }
};

test('template CRUD is separately persisted, revision-checked, and can reuse patterns across groups', async () => {
  const temp = temporary(), host = await backend(temp.directory);
  try {
    const patternsBefore = await host.call<PatternsSnapshot>('patterns-snapshot');
    const [first, second] = patternsBefore.patterns;
    assert.ok(first && second);
    assert.deepEqual(Object.keys(patternsBefore).sort(), ['patterns']);
    const notifications = host.notifications;
    assert.deepEqual(await host.call<TemplatesSnapshot>('templates-snapshot'), {
      templates: [], exampleSummaries: [], overallExampleLimit: 15,
    });
    assert.equal(host.notifications, notifications, 'template reads do not notify');

    const firstId = await saveTemplate(host, 'Warm-up set', [first.id]);
    assert.match(firstId, /^[0-9a-f-]{36}$/i);
    assert.deepEqual(host.emitted.at(-1), { topic: 'library-changed', data: undefined });
    const secondId = await saveTemplate(host, 'Review set', [first.id, second.id], false);
    assert.notEqual(firstId, secondId);
    const saved = await host.call<TemplatesSnapshot>('templates-snapshot');
    assert.deepEqual(saved.templates.map(templateData), [
      { name: 'Warm-up set', patternIds: [first.id] },
      { name: 'Review set', patternIds: [first.id, second.id] },
    ]);
    assert.deepEqual(saved.templates.map(template => template.revision), [1, 1]);
    assert.deepEqual(saved.templates.map(template => template.bypassOverallLimit), [true, false]);
    assert.equal(saved.overallExampleLimit, 15);
    assert.deepEqual(saved.exampleSummaries?.map(summary => summary.expectedExamples), [3, 6], 'each seeded core contributes its three default examples');

    const storagePath = join(temp.directory, 'templates.json');
    const stored = JSON.parse(readFileSync(storagePath, 'utf8'));
    assert.deepEqual(Object.keys(stored).sort(), ['templates', 'version']);
    assert.equal(stored.version, 1);
    assert.deepEqual(Object.keys(stored.templates[0]).sort(), ['bypassOverallLimit', 'id', 'name', 'patternIds', 'revision', 'updatedAt']);
    assert.deepEqual(stored.templates[0].patternIds, [first.id], 'groups store references only');

    await assert.rejects(host.call('template-save', { id: firstId, name: 'Stale', patternIds: [], expectedRevision: 2 }), /changed/);
    await assert.rejects(host.call('template-save', { id: firstId, name: 'Missing revision', patternIds: [] }), /expected revision/i);
    await assert.rejects(host.call('template-save', { name: 'Create with revision', patternIds: [], expectedRevision: 1 }), /new template/i);
    const updatedId = await host.call<string>('template-save', {
      id: firstId, expectedRevision: 1, name: 'Warm-up revised', patternIds: [second.id],
    });
    assert.equal(updatedId, firstId);
    const updated = (await host.call<TemplatesSnapshot>('templates-snapshot')).templates[0]!;
    assert.equal(updated.revision, 2);
    assert.equal(updated.name, 'Warm-up revised');
    assert.deepEqual(updated.patternIds, [second.id]);
    assert.equal(updated.bypassOverallLimit, true, 'omitted updates preserve the existing setting');
    await host.call('template-save', {
      id: secondId, expectedRevision: 1, name: 'Review revised', patternIds: [first.id, second.id],
    });
    assert.equal((await host.call<TemplatesSnapshot>('templates-snapshot')).templates.find(template => template.id === secondId)?.bypassOverallLimit,
      false, 'omitted updates also preserve an explicit opt-out');

    await assert.rejects(host.call('template-delete', { id: firstId, expectedRevision: 1 }), /changed/);
    await host.call('session-pattern-set', { sessionId: 'delete-retains-selection', patternId: first.id, selected: true });
    await host.call('template-delete', { id: firstId, expectedRevision: 2 });
    assert.equal((await host.call<Array<{ id: string; selected: boolean }>>('session-patterns', { sessionId: 'delete-retains-selection' })).find(pattern => pattern.id === first.id)?.selected, true);
    assert.deepEqual(host.emitted.at(-1), { topic: 'library-changed', data: undefined });
    assert.deepEqual((await host.call<TemplatesSnapshot>('templates-snapshot')).templates.map(template => template.id), [secondId]);
    assert.deepEqual(await host.call<PatternsSnapshot>('patterns-snapshot'), patternsBefore, 'template edits never mutate pattern definitions');

    const expectedTemplates = await host.call<TemplatesSnapshot>('templates-snapshot');
    await host.dispose();
    const restarted = await backend(temp.directory);
    try {
      assert.deepEqual(await restarted.call<TemplatesSnapshot>('templates-snapshot'), expectedTemplates);
    } finally { await restarted.dispose(); }
  } finally { await host.dispose(); temp.remove(); }
});

test('template API rejects malformed and over-bounded input without writing', async () => {
  const temp = temporary(), host = await backend(temp.directory);
  try {
    const pattern = (await host.call<PatternsSnapshot>('patterns-snapshot')).patterns[0]!;
    const invalidRequests = [
      { name: '   ', patternIds: [] },
      { name: 'x'.repeat(161), patternIds: [] },
      { name: 'Bad ID', patternIds: ['not-a-uuid'] },
      { name: 'Repeated', patternIds: [pattern.id, pattern.id] },
      { name: 'Extra field', patternIds: [], extra: true },
      { name: 'Invalid bypass', patternIds: [], bypassOverallLimit: 'true' },
      { name: 'Unknown pattern', patternIds: ['00000000-0000-4000-8000-ffffffffffff'] },
      { name: 'Too many', patternIds: Array.from({ length: 501 }, () => crypto.randomUUID()) },
    ];
    for (const input of invalidRequests) await assert.rejects(host.call('template-save', input));
    await assert.rejects(host.call('templates-snapshot', { extra: true }), /Invalid/);
    await assert.rejects(host.call('template-delete', { id: 'not-a-uuid', expectedRevision: 1 }), /Invalid/);
    assert.deepEqual(await host.call<TemplatesSnapshot>('templates-snapshot'), {
      templates: [], exampleSummaries: [], overallExampleLimit: 15,
    });
    assert.equal(existsSync(join(temp.directory, 'templates.json')), false, 'invalid requests do not create storage');
  } finally { await host.dispose(); temp.remove(); }
});

test('applying templates adds eligible patterns or replaces all remembered selections atomically', async () => {
  const temp = temporary(), host = await backend(temp.directory);
  try {
    const { patterns } = await host.call<PatternsSnapshot>('patterns-snapshot');
    const [included, priorAvailable, disabled, archived] = patterns;
    assert.ok(included && priorAvailable && disabled && archived);
    await host.call('pattern-enabled-set', { id: disabled.id, enabled: false });
    await clearSession(host, 'apply-session');
    await host.call('session-pattern-set', { sessionId: 'apply-session', patternId: disabled.id, selected: true });
    await host.call('session-pattern-set', { sessionId: 'apply-session', patternId: archived.id, selected: true });
    await host.call('session-pattern-set', { sessionId: 'apply-session', patternId: priorAvailable.id, selected: true });
    await host.call('archive', { kind: 'pattern', id: archived.id, archived: true });

    const templateId = await saveTemplate(host, 'Reusable group', [included.id, disabled.id, archived.id]);
    const priorWrites = readFileSync(join(temp.directory, 'session-selections.json'), 'utf8');
    const added = await host.call<Array<{ id: string; selected: boolean }>>('session-template-apply', {
      sessionId: 'apply-session', templateId, mode: 'add',
    });
    assert.deepEqual(added.filter(pattern => pattern.selected).map(pattern => pattern.id).sort(), [included.id, disabled.id, priorAvailable.id].sort());
    assert.deepEqual(host.emitted.at(-1), { topic: 'session-patterns-changed', data: { sessionId: 'apply-session' } });
    const afterAdd = JSON.parse(readFileSync(join(temp.directory, 'session-selections.json'), 'utf8'));
    const rememberedAfterAdd = afterAdd.sessions.find((entry: { sessionId: string }) => entry.sessionId === 'apply-session').patternIds;
    assert.ok(rememberedAfterAdd.includes(disabled.id) && rememberedAfterAdd.includes(archived.id), 'add retains prior remembered unavailable selections');
    assert.notEqual(readFileSync(join(temp.directory, 'session-selections.json'), 'utf8'), priorWrites);

    const replaced = await host.call<Array<{ id: string; selected: boolean }>>('session-template-apply', {
      sessionId: 'apply-session', templateId, mode: 'replace',
    });
    assert.deepEqual(replaced.filter(pattern => pattern.selected).map(pattern => pattern.id).sort(), [included.id, disabled.id].sort());
    const afterReplace = JSON.parse(readFileSync(join(temp.directory, 'session-selections.json'), 'utf8'));
    assert.deepEqual(afterReplace.sessions.find((entry: { sessionId: string }) => entry.sessionId === 'apply-session').patternIds, [included.id, disabled.id]);
    assert.deepEqual(afterReplace.sessions.find((entry: { sessionId: string }) => entry.sessionId === 'apply-session').exampleLimitBypassIds, [included.id, disabled.id]);
    assert.equal((await host.call<PatternsSnapshot>('patterns-snapshot')).patterns.find(pattern => pattern.id === disabled.id)?.enabled, false);
    assert.equal((await host.call<PatternsSnapshot>('patterns-snapshot')).patterns.find(pattern => pattern.id === archived.id)?.archived, true);

    await clearSession(host, 'fresh-session');
    const fresh = await host.call<Array<{ id: string; selected: boolean }>>('session-patterns', { sessionId: 'fresh-session' });
    assert.ok(fresh.every(pattern => !pattern.selected), 'templates are never auto-applied to a cleared initialized session');
    const [list, set] = host.nativeTools('teacher', 'fresh-session');
    assert.ok(list && set);
    assert.deepEqual([list.name, set.name], ['question_patterns_list', 'question_patterns_set']);
    assert.deepEqual((await list.execute('template-not-selection', {})).details, []);
    assert.deepEqual(Object.keys(await host.call<TemplatesSnapshot>('templates-snapshot')).sort(), ['exampleSummaries', 'overallExampleLimit', 'templates']);
    await assert.rejects(host.call('session-template-apply', { sessionId: 'fresh-session', templateId, mode: 'merge' }), /Invalid/);
    await assert.rejects(host.call('session-template-apply', { sessionId: 'fresh-session', templateId: 'bad-id', mode: 'add' }), /Invalid/);
  } finally { await host.dispose(); temp.remove(); }
});

test('template removal deselects eligible members, clears their exemptions, and preserves overlapping selections', async () => {
  const temp = temporary(), host = await backend(temp.directory);
  try {
    const eligible = (await host.call<PatternsSnapshot>('patterns-snapshot')).patterns
      .filter(pattern => !pattern.archived);
    const [first, shared, unrelated, unavailableAfterApply] = eligible;
    assert.ok(first && shared && unrelated && unavailableAfterApply);
    const removeId = await saveTemplate(host, 'Remove group', [first.id, shared.id, unavailableAfterApply.id]);
    const overlappingId = await saveTemplate(host, 'Overlapping group', [shared.id, unrelated.id]);

    await clearSession(host, 'remove-session');
    await host.call('session-template-apply', { sessionId: 'remove-session', templateId: removeId, mode: 'add' });
    await host.call('session-template-apply', { sessionId: 'remove-session', templateId: overlappingId, mode: 'add' });
    const selectionsPath = join(temp.directory, 'session-selections.json');
    const beforeRemoval = JSON.parse(readFileSync(selectionsPath, 'utf8'));
    const beforeEntry = beforeRemoval.sessions.find((entry: { sessionId: string }) => entry.sessionId === 'remove-session');
    assert.deepEqual(beforeEntry.patternIds, [first.id, shared.id, unavailableAfterApply.id, unrelated.id]);
    assert.equal(new Set(beforeEntry.patternIds).size, beforeEntry.patternIds.length, 'overlapping template applications do not duplicate selected IDs');
    assert.deepEqual(beforeEntry.exampleLimitBypassIds, [first.id, shared.id, unavailableAfterApply.id, unrelated.id]);
    await host.call('pattern-enabled-set', { id: unavailableAfterApply.id, enabled: false });

    const removed = await host.call<Array<{ id: string; selected: boolean }>>('session-template-apply', {
      sessionId: 'remove-session', templateId: removeId, mode: 'remove',
    });
    assert.deepEqual(removed.filter(pattern => pattern.selected).map(pattern => pattern.id), [unrelated.id]);
    const afterRemoval = JSON.parse(readFileSync(selectionsPath, 'utf8'));
    const afterEntry = afterRemoval.sessions.find((entry: { sessionId: string }) => entry.sessionId === 'remove-session');
    assert.deepEqual(afterEntry.patternIds, [unrelated.id], 'all non-archived template members are removed even after they are disabled');
    assert.deepEqual(afterEntry.exampleLimitBypassIds, [unrelated.id], 'removed members lose their exemption provenance');
    assert.deepEqual(host.emitted.at(-1), { topic: 'session-patterns-changed', data: { sessionId: 'remove-session' } });
    await assert.rejects(host.call('session-template-apply', {
      sessionId: 'remove-session', templateId: removeId, mode: 'merge',
    }), /Invalid/);
  } finally { await host.dispose(); temp.remove(); }
});

test('template example summaries are derived from live eligible banks and global limits', async () => {
  const temp = temporary(), store = await Store.openPatterns(temp.directory);
  try {
    const [limited, defaulted, disabled, archived] = store.patternsSnapshot().patterns;
    assert.ok(limited && defaulted && disabled && archived);
    assert.equal(store.exampleSettings().overallExampleLimit, 15);
    saveBank(store, limited, examples(6, 2), 1);
    saveBank(store, defaulted, examples(5), null);
    saveBank(store, disabled, examples(2));
    saveBank(store, archived, examples(3));
    store.setPatternEnabled(disabled.id, false);
    store.archive('pattern', archived.id, true);
    const templateId = store.saveTemplate('Example summary', [limited.id, defaulted.id, disabled.id, archived.id]);
    store.saveExampleSettings({ overallExampleLimit: 4 });

    const snapshot = store.templatesSnapshot();
    assert.equal(snapshot.overallExampleLimit, 4);
    assert.deepEqual(snapshot.exampleSummaries, [{
      id: templateId, totalExamples: 16, availableExamples: 13, forcedExamples: 2,
      expectedExamples: 7, perPatternLimited: true, exceedsOverallLimit: true,
    }]);
  } finally { store.close(); temp.remove(); }
});

test('template example summaries include forced examples within the normal sampling allowance', async () => {
  const temp = temporary(), store = await Store.openPatterns(temp.directory);
  try {
    const pattern = store.patternsSnapshot().patterns[0]!;
    const templateId = store.saveTemplate('Forced and random', [pattern.id]);
    for (const [count, forced, limit, expected] of [[3, 1, 3, 3], [5, 1, 3, 3], [5, 4, 3, 4], [3, 1, 0, 1]] as const) {
      saveBank(store, pattern, examples(count, forced), limit);
      const summary = store.templatesSnapshot().exampleSummaries!.find(item => item.id === templateId)!;
      assert.equal(summary.expectedExamples, expected);
      assert.equal(summary.perPatternLimited, expected < count);
      Object.assign(pattern, store.patternsSnapshot().patterns.find(item => item.id === pattern.id)!);
    }
  } finally { store.close(); temp.remove(); }
});

test('template apply records only template-provenance exemptions; manual reselection does not restore them', async () => {
  const temp = temporary();
  let store = await Store.openPatterns(temp.directory);
  try {
    const [included, additional, manual] = store.patternsSnapshot().patterns;
    assert.ok(included && additional && manual);
    const beforePatterns = store.patternsSnapshot();
    const overallBefore = store.exampleSettings();
    for (const pattern of store.sessionPatterns('provenance')) if (pattern.selected) {
      store.setSessionPattern('provenance', pattern.id, false);
    }
    const defaultTemplate = store.saveTemplate('Bypass default', [included.id]);
    const cappedTemplate = store.saveTemplate('Respect cap', [additional.id, included.id], undefined, undefined, false);
    assert.equal(store.templates().find(template => template.id === defaultTemplate)?.bypassOverallLimit, true);
    assert.equal(store.templates().find(template => template.id === cappedTemplate)?.bypassOverallLimit, false);

    store.setSessionPattern('provenance', manual.id, true);
    store.applyTemplate('provenance', defaultTemplate, 'add');
    assert.deepEqual(store.sessionExampleOverrides('provenance'), [included.id]);
    store.applyTemplate('provenance', cappedTemplate, 'add');
    assert.deepEqual(store.sessionExampleOverrides('provenance'), [included.id], 'non-bypassing add preserves existing exemptions');

    store.setSessionPattern('provenance', included.id, false);
    assert.deepEqual(store.sessionExampleOverrides('provenance'), []);
    store.setSessionPattern('provenance', included.id, true);
    assert.deepEqual(store.sessionExampleOverrides('provenance'), [], 'manual selection alone is not exempt');
    store.applyTemplate('provenance', defaultTemplate, 'add');
    assert.deepEqual(store.sessionExampleOverrides('provenance'), [included.id]);

    store.applyTemplate('provenance', cappedTemplate, 'replace');
    assert.deepEqual(store.sessionExampleOverrides('provenance'), [], 'a non-bypassing replace clears existing exemptions');
    store.applyTemplate('provenance', defaultTemplate, 'replace');
    assert.deepEqual(store.sessionExampleOverrides('provenance'), [included.id], 'default bypass applies to replace selections');
    store.setPatternEnabled(included.id, false);
    assert.deepEqual(store.sessionExampleOverrides('provenance'), [included.id], 'disabling a pattern does not remove its exemption provenance');
    store.setPatternEnabled(included.id, true);
    assert.deepEqual(store.sessionExampleOverrides('provenance'), [included.id]);
    store.setSessionPattern('provenance', included.id, false);
    store.setSessionPattern('provenance', included.id, true);
    assert.deepEqual(store.sessionExampleOverrides('provenance'), []);

    store.applyTemplate('provenance', defaultTemplate, 'replace');
    assert.deepEqual(store.patternsSnapshot(), beforePatterns, 'template application never changes pattern state');
    assert.deepEqual(store.exampleSettings(), overallBefore, 'template application never changes global sampling settings');
    store.close();
    store = await Store.openPatterns(temp.directory);
    assert.deepEqual(store.sessionExampleOverrides('provenance'), [included.id], 'exemptions survive activation');
    const persisted = JSON.parse(readFileSync(join(temp.directory, 'session-selections.json'), 'utf8'));
    assert.deepEqual(persisted.sessions.find((entry: { sessionId: string }) => entry.sessionId === 'provenance').exampleLimitBypassIds, [included.id]);
  } finally { store.close(); temp.remove(); }
});

test('legacy templates and session selections load without optional bypass data', async () => {
  const temp = temporary();
  let store = await Store.openPatterns(temp.directory);
  try {
    const pattern = store.patternsSnapshot().patterns[0]!;
    const templateId = store.saveTemplate('Legacy', [pattern.id]);
    const templatesPath = join(temp.directory, 'templates.json');
    const templates = JSON.parse(readFileSync(templatesPath, 'utf8'));
    delete templates.templates[0].bypassOverallLimit;
    writeFileSync(templatesPath, JSON.stringify(templates));
    writeFileSync(join(temp.directory, 'session-selections.json'), JSON.stringify({
      version: 1, sessions: [{ sessionId: 'legacy-session', patternIds: [pattern.id] }],
    }));
    store.close();
    store = await Store.openPatterns(temp.directory);

    assert.equal('bypassOverallLimit' in store.templates()[0]!, false, 'templates() retains their persisted raw shape');
    assert.deepEqual(store.sessionExampleOverrides('legacy-session'), []);
    store.applyTemplate('legacy-session', templateId, 'replace');
    assert.deepEqual(store.sessionExampleOverrides('legacy-session'), [pattern.id], 'an absent legacy flag defaults to bypassing the overall cap');
  } finally { store.close(); temp.remove(); }
});

test('malformed and unknown-version template files abort activation before legacy cleanup', async () => {
  const temp = temporary();
  try {
    const store = await Store.open(temp.directory);
    const source = store.importSource({ filename: 'keep.txt', kind: 'txt', location: '', bytes: Buffer.from('keep'), text: 'keep', notices: [] });
    const pattern = store.patterns()[0]!;
    store.saveTemplate('Valid', [pattern.id]);
    const sourcePath = join(temp.directory, 'sources', `${source.id}.json`);
    const settingsPath = join(temp.directory, 'settings.json');
    const patternPath = join(temp.directory, 'patterns', `${pattern.id}.json`);
    const sourceBefore = readFileSync(sourcePath), settingsBefore = readFileSync(settingsPath), patternBefore = readFileSync(patternPath);
    const stalePatternTemp = join(temp.directory, 'patterns', `${pattern.id}.json.${crypto.randomUUID()}.tmp`);
    writeFileSync(stalePatternTemp, '{ incomplete');
    const templatesPath = join(temp.directory, 'templates.json');
    const valid = JSON.parse(readFileSync(templatesPath, 'utf8'));

    for (const malformed of [
      { ...valid, version: 2 },
      { ...valid, templates: [valid.templates[0], valid.templates[0]] },
      { ...valid, templates: [{ ...valid.templates[0], patternIds: [pattern.id, pattern.id] }] },
      { ...valid, templates: [{ ...valid.templates[0], extra: true }] },
      { ...valid, templates: [{ ...valid.templates[0], bypassOverallLimit: 'true' }] },
    ]) {
      const bytes = `${JSON.stringify(malformed)}\n`;
      writeFileSync(templatesPath, bytes);
      await assert.rejects(backend(temp.directory), /Unknown record version|Templates|Template IDs/);
      assert.equal(readFileSync(templatesPath, 'utf8'), bytes);
      assert.deepEqual(readFileSync(sourcePath), sourceBefore);
      assert.deepEqual(readFileSync(settingsPath), settingsBefore);
      assert.deepEqual(readFileSync(patternPath), patternBefore);
      assert.equal(readFileSync(stalePatternTemp, 'utf8'), '{ incomplete', 'unrelated stale cleanup waits until templates validate');
    }
  } finally { temp.remove(); }
});

test('malformed session bypass data aborts activation before legacy cleanup', async () => {
  const temp = temporary();
  try {
    const store = await Store.open(temp.directory);
    const source = store.importSource({ filename: 'keep.txt', kind: 'txt', location: '', bytes: Buffer.from('keep'), text: 'keep', notices: [] });
    const pattern = store.patterns()[0]!;
    const sourcePath = join(temp.directory, 'sources', `${source.id}.json`);
    const sourceBefore = readFileSync(sourcePath);
    const selectionPath = join(temp.directory, 'session-selections.json');
    for (const session of [
      { sessionId: 'bad', patternIds: [pattern.id], exampleLimitBypassIds: [pattern.id, pattern.id] },
      { sessionId: 'bad', patternIds: [pattern.id], exampleLimitBypassIds: [pattern.id], unexpected: true },
    ]) {
      const bytes = `${JSON.stringify({ version: 1, sessions: [session] })}\n`;
      writeFileSync(selectionPath, bytes);
      await assert.rejects(backend(temp.directory), /Session selections/);
      assert.equal(readFileSync(selectionPath, 'utf8'), bytes);
      assert.deepEqual(readFileSync(sourcePath), sourceBefore);
    }
  } finally { temp.remove(); }
});
