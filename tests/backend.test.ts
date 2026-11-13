import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PATTERN_EXAMPLE_LIMIT, type PatternsSnapshot, type Pattern } from '../src/domain';
import { Store } from '../src/store';
import { backend, temporary } from './fixture';

const patternContent = (pattern: Pattern) => ({
  name: pattern.name, format: pattern.format, structure: pattern.structure,
  rule: pattern.rule, reasoning: pattern.reasoning,
});

function assertNativeToolResult(result: { content: Array<{ type: string; text?: string }>; details: unknown }, expected: unknown) {
  assert.deepEqual(result.details, expected);
  const text = result.content.find(item => item.type === 'text')?.text;
  assert.ok(text);
  assert.deepEqual(JSON.parse(text), expected);
}

function assertSelectedNativeToolResult(
  result: { content: Array<{ type: string; text?: string }>; details: unknown },
  expected: Array<Record<string, unknown>>,
  exampleBanks: Map<string, string[]>,
) {
  const definitions = result.details as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(definitions));
  assert.deepEqual(definitions.map(({ examples: _examples, ...definition }) => definition), expected);
  for (const definition of definitions) {
    assert.equal('exampleLimit' in definition, false);
    const bank = exampleBanks.get(definition.id as string) ?? [];
    if (bank.length === 0) {
      assert.equal('examples' in definition, false);
      continue;
    }
    assert.ok(Array.isArray(definition.examples));
    const examples = definition.examples as unknown[];
    assert.ok(examples.length <= DEFAULT_PATTERN_EXAMPLE_LIMIT);
    assert.ok(examples.every(example => typeof example === 'string' && bank.includes(example)));
  }
  const text = result.content.find(item => item.type === 'text')?.text;
  assert.ok(text);
  assert.deepEqual(JSON.parse(text), definitions);
}

function exampleBanks(snapshot: PatternsSnapshot) {
  return new Map(snapshot.patterns.map(pattern => [pattern.id, (pattern.examples ?? []).map(example => example.text)] as const));
}

async function clearSession(host: Awaited<ReturnType<typeof backend>>, sessionId: string) {
  const patterns = await host.call<Array<{ id: string; selected: boolean }>>('session-patterns', { sessionId });
  for (const pattern of patterns) if (pattern.selected) {
    await host.call('session-pattern-set', { sessionId, patternId: pattern.id, selected: false });
  }
}

test('backend exposes only approved pattern and session APIs with link-free payloads', async () => {
  const temp = temporary(), host = await backend(temp.directory);
  try {
    const beforeReads = host.notifications;
    const snapshot = await host.call<PatternsSnapshot>('patterns-snapshot');
    assert.equal(host.notifications, beforeReads, 'reads do not emit library notifications');
    assert.equal(snapshot.patterns.length, 12);
    assert.ok(snapshot.patterns.every(pattern => !('analysisIds' in pattern) && !('activeAnalysisId' in pattern) && !('patternIds' in pattern)));
    await assert.rejects(host.call('snapshot'), /Handler not found/);
    await assert.rejects(host.call('scan'), /Handler not found/);
    await assert.rejects(host.call('settings-save'), /Handler not found/);
    await assert.rejects(host.call('model-catalog'), /Handler not found/);

    const current = snapshot.patterns[0]!;
    const id = await host.call<string>('pattern-save', {
      id: current.id, expectedRevision: current.revision,
      content: { ...patternContent(current), name: `${current.name} revised` }, tags: ['reviewed'], enabled: true,
    });
    assert.equal(id, current.id);
    const versions = await host.call<Array<Record<string, unknown>>>('pattern-versions', { id });
    assert.equal(versions.length, 2);
    assert.deepEqual(Object.keys(versions[0]!).sort(), ['content', 'createdAt', 'exampleLimit', 'examples', 'revision']);
    assert.equal(versions[0]!.revision, 2);
    await assert.rejects(host.call('pattern-versions', { id, extra: true }), /Invalid/);
    await assert.rejects(host.call('pattern-save', { content: { name: 'incomplete' } }), /Invalid/);
    await assert.rejects(host.call('pattern-save', {
      id, expectedRevision: current.revision, content: patternContent(current), tags: [], enabled: true,
    }), /Pattern changed/);
    await assert.rejects(host.call('archive', { kind: 'source', id, archived: true }), /Invalid/);
    await host.call('archive', { kind: 'pattern', id, archived: true });
    assert.equal((await host.call<PatternsSnapshot>('patterns-snapshot')).patterns.find(pattern => pattern.id === id)?.archived, true);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(temp.directory, 'patterns', `${id}.json`), 'utf8'))).sort(),
      ['archived', 'coreSeedVersion', 'enabled', 'id', 'tags', 'version', 'versions']);
    assert.ok(host.notifications > beforeReads);
  } finally { await host.dispose(); temp.remove(); }
});

test('pattern enablement is metadata-only and controls only defaults for uninitialized sessions', async () => {
  const temp = temporary();
  let host = await backend(temp.directory);
  try {
    const pattern = (await host.call<PatternsSnapshot>('patterns-snapshot')).patterns[0]!;
    const file = join(temp.directory, 'patterns', `${pattern.id}.json`);
    const before = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
    const versions = await host.call<Array<Record<string, unknown>>>('pattern-versions', { id: pattern.id });
    const [list, set] = host.nativeTools('teacher', 'selected-session');
    assert.ok(list && set);
    await set.execute('select', { patternId: pattern.id, selected: true });

    await assert.rejects(host.call('pattern-enabled-set', { id: pattern.id, enabled: 'false' }), /Invalid/);
    await assert.rejects(host.call('pattern-enabled-set', { id: pattern.id, enabled: false, extra: true }), /Invalid/);
    await assert.rejects(host.call('pattern-enabled-set', { id: '', enabled: false }), /Invalid/);
    const notifications = host.notifications;
    await host.call('pattern-enabled-set', { id: pattern.id, enabled: false });
    assert.ok(host.notifications > notifications);
    assert.deepEqual(host.emitted.at(-1), { topic: 'library-changed', data: undefined });

    const disabledSession = await host.call<Array<{ id: string; selected: boolean }>>('session-patterns', { sessionId: 'selected-session' });
    assert.ok(disabledSession.some(entry => entry.id === pattern.id && entry.selected), 'disabling a pattern does not remove an existing session selection');
    const disabledDefinitions = await list.execute('selected-disabled', {});
    assert.ok((disabledDefinitions.details as Array<{ id: string }>).some(entry => entry.id === pattern.id));
    const disabledCatalog = await list.execute('catalog-disabled', { available: true });
    assert.ok((disabledCatalog.details as Array<{ id: string }>).some(entry => entry.id === pattern.id));
    const explicitDisabled = await host.call<Array<{ id: string; selected: boolean }>>('session-pattern-set', {
      sessionId: 'another-session', patternId: pattern.id, selected: true,
    });
    assert.equal(explicitDisabled.find(entry => entry.id === pattern.id)?.selected, true, 'disabled patterns remain eligible for explicit session selection');

    const disabledRecord = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
    assert.equal(disabledRecord.enabled, false);
    assert.deepEqual({ ...disabledRecord, enabled: before.enabled }, before);
    assert.deepEqual(disabledRecord.tags, before.tags);
    assert.deepEqual(disabledRecord.versions, before.versions);
    assert.deepEqual(Object.keys(disabledRecord).sort(), ['archived', 'coreSeedVersion', 'enabled', 'id', 'tags', 'version', 'versions']);
    assert.deepEqual(await host.call('pattern-versions', { id: pattern.id }), versions);

    await host.dispose();
    host = await backend(temp.directory);
    assert.equal((await host.call<PatternsSnapshot>('patterns-snapshot')).patterns.find(entry => entry.id === pattern.id)?.enabled, false);
    const [freshList] = host.nativeTools('teacher', 'fresh-session');
    assert.ok(freshList);
    await host.call('pattern-enabled-set', { id: pattern.id, enabled: true });
    const freshPatterns = await host.call<Array<{ id: string; selected: boolean }>>('session-patterns', { sessionId: 'fresh-session' });
    assert.equal(freshPatterns.find(entry => entry.id === pattern.id)?.selected, true, 'enabled patterns default into sessions that have not initialized yet');
    const freshDefinitions = await freshList.execute('fresh-list', {});
    assert.ok((freshDefinitions.details as Array<{ id: string }>).some(entry => entry.id === pattern.id));
    const enabledCatalog = await freshList.execute('catalog-enabled', { available: true });
    assert.ok((enabledCatalog.details as Array<{ id: string; selected: boolean }>).some(entry => entry.id === pattern.id && entry.selected));
    const enabledRecord = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
    assert.deepEqual({ ...enabledRecord, enabled: before.enabled }, before);
    assert.deepEqual(await host.call('pattern-versions', { id: pattern.id }), versions);

    await host.call('archive', { kind: 'pattern', id: pattern.id, archived: true });
    await assert.rejects(host.call('pattern-enabled-set', { id: pattern.id, enabled: false }), /Restore this pattern/);
  } finally { await host.dispose(); temp.remove(); }
});

test('store rejects non-boolean pattern enablement values', async () => {
  const temp = temporary(), store = await Store.openPatterns(temp.directory);
  try {
    const id = (await store.patternsSnapshot()).patterns[0]!.id;
    assert.throws(() => store.setPatternEnabled(id, 'false' as unknown as boolean), /boolean/);
  } finally { store.close(); temp.remove(); }
});

test('native session pattern tools list and isolate approved selections', async () => {
  const temp = temporary(), host = await backend(temp.directory);
  try {
    assert.deepEqual(host.instructions.map(entry => entry.agents), [['teacher', 'practice']]);
    for (const agent of ['teacher', 'practice'] as const) {
      assert.match(host.nativeInstructions(agent).join('\n'), /Follow the live schema/);
      assert.match(host.nativeInstructions(agent).join('\n'), /not fixed output templates/);
    }
    assert.deepEqual(host.nativeInstructions('teacher'), host.nativeInstructions('practice'));
    assert.match(host.nativeInstructions('teacher')[0]!, /call question_patterns_list/);
    assert.equal(host.nativeInstructions('prober').length, 0);
    assert.equal(host.nativeTools('prober', 'session-a').length, 0);

    const tools = host.nativeTools('teacher', 'session-a');
    assert.deepEqual(tools.map(tool => tool.name), ['question_patterns_list', 'question_patterns_set']);
    const banks = exampleBanks(await host.call<PatternsSnapshot>('patterns-snapshot'));
    const patternId = '00000000-0000-4000-8000-000000000002';
    await clearSession(host, 'session-a');
    const initial = await tools[0]!.execute('list-initial', {});
    assertNativeToolResult(initial, []);
    const selected = await tools[1]!.execute('select', { patternId, selected: true });
    assertSelectedNativeToolResult(selected, await host.call('session-patterns', { sessionId: 'session-a' }).then((patterns: any[]) => patterns.filter(pattern => pattern.selected)), banks);
    assert.deepEqual(host.emitted.at(-1), { topic: 'session-patterns-changed', data: { sessionId: 'session-a' } });
    await clearSession(host, 'session-b');
    const selectedForB = await host.call<Array<{ id: string; selected: boolean }>>('session-patterns', { sessionId: 'session-b' });
    assert.equal(selectedForB.find(pattern => pattern.id === patternId)?.selected, false);
    assertSelectedNativeToolResult(await tools[0]!.execute('list-selected', {}),
      await host.call('session-patterns', { sessionId: 'session-a' }).then((patterns: any[]) => patterns.filter(pattern => pattern.selected)), banks);

    await assert.rejects(host.call('session-patterns', { sessionId: '  ' }), /Invalid/);
    await assert.rejects(host.call('session-pattern-set', { sessionId: 'session-a', patternId, selected: 1 }), /Invalid/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(tools[1]!.execute('cancelled', { patternId, selected: false }, controller.signal), /cancelled/);
    assert.equal((await host.call<any[]>('session-patterns', { sessionId: 'session-a' })).find(pattern => pattern.id === patternId)?.selected, true);

    await host.dispose();
    assert.equal(host.instructions.length, 0);
    assert.equal(host.toolContributions.length, 0);
    await assert.rejects(tools[0]!.execute('after-disable', {}), /disabled/);
  } finally { await host.dispose(); temp.remove(); }
});

test('agent tools expose only selected definitions and a compact opt-in catalog', async () => {
  const temp = temporary(), host = await backend(temp.directory);
  try {
    const [list, set] = host.nativeTools('practice', 'catalog-session');
    const snapshot = await host.call<PatternsSnapshot>('patterns-snapshot');
    const banks = exampleBanks(snapshot);
    const [first, second, disabled, archived] = snapshot.patterns;
    assert.ok(first && second && disabled && archived);
    await clearSession(host, 'catalog-session');
    await host.call('pattern-save', {
      id: disabled.id, expectedRevision: disabled.revision, content: patternContent(disabled), tags: disabled.tags, enabled: false,
    });
    await host.call('archive', { kind: 'pattern', id: archived.id, archived: true });

    assertNativeToolResult(await list!.execute('none', {}), []);
    await set!.execute('first-on', { patternId: first.id, selected: true });
    const both = await set!.execute('second-on', { patternId: second.id, selected: true });
    const selected = await host.call<any[]>('session-patterns', { sessionId: 'catalog-session' });
    assertSelectedNativeToolResult(both, selected.filter(pattern => pattern.selected), banks);
    assertSelectedNativeToolResult(await list!.execute('active', { available: false }), selected.filter(pattern => pattern.selected), banks);
    const catalog = await list!.execute('catalog', { available: true });
    assertNativeToolResult(catalog, selected.map(({ id, name, selected }) => ({ id, name, selected })));
    assert.ok(!JSON.stringify(catalog).includes('"structure"'), 'catalog never leaks inactive definitions');
    assert.ok((catalog.details as Array<{ id: string }>).some(pattern => pattern.id === disabled.id), 'disabled patterns remain in the available catalog');
    assert.ok(!(catalog.details as Array<{ id: string }>).some(pattern => pattern.id === archived.id));
    await assert.rejects(list!.execute('invalid', { available: 'true' }), /Invalid/);
    await assert.rejects(list!.execute('override-session', { sessionId: 'another-session' }), /Invalid/);

    const remaining = await set!.execute('first-off', { patternId: first.id, selected: false });
    assertSelectedNativeToolResult(remaining, selected.filter(pattern => pattern.id === second.id), banks);
    assertNativeToolResult(await set!.execute('second-off', { patternId: second.id, selected: false }), []);
    assertNativeToolResult(await list!.execute('all-off', {}), []);
  } finally { await host.dispose(); temp.remove(); }
});

test('session pattern selections survive backend activation', async () => {
  const temp = temporary(), host = await backend(temp.directory);
  const patternId = '00000000-0000-4000-8000-000000000002';
  try {
    await host.call('session-pattern-set', { sessionId: 'persisted-session', patternId, selected: true });
    await host.dispose();
    const restarted = await backend(temp.directory);
    try {
      const persisted = await restarted.call<Array<{ id: string; selected: boolean }>>('session-patterns', { sessionId: 'persisted-session' });
      assert.equal(persisted.find(pattern => pattern.id === patternId)?.selected, true);
    } finally { await restarted.dispose(); }
  } finally { await host.dispose(); temp.remove(); }
});
