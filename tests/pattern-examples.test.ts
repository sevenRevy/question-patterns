import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_EXAMPLE_SETTINGS, DEFAULT_PATTERN_EXAMPLE_LIMIT, type PatternContent, type PatternExample, type PatternExampleConfig } from '../src/domain';
import { Store } from '../src/store';
import { backend } from './fixture';

const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), 'pattern-examples-'));
  return { directory, remove: () => rmSync(directory, { recursive: true, force: true }) };
};
const content: PatternContent = {
  name: 'Example pattern', format: 'example_test', structure: {}, rule: 'Apply the rule.', reasoning: [],
};
const example = (overrides: Partial<PatternExample> = {}): PatternExample => ({
  id: randomUUID(), text: 'A saved example.', forced: false, ...overrides,
});
const oldSettings = () => ({ version: 1, instructions: '', maxTurns: 4, modelSlot: 'strong', analysisStrength: 'strong' });
const readPatternRecord = (directory: string, id: string) =>
  JSON.parse(readFileSync(join(directory, 'patterns', `${id}.json`), 'utf8')) as any;


test('new and updated pattern example configuration is versioned, persisted, and preserved when omitted', async () => {
  const temp = temporary();
  try {
    let store = await Store.open(temp.directory);
    const id = store.savePattern(content, [], true);
    let pattern = store.patternsSnapshot().patterns.find(item => item.id === id)!;
    assert.deepEqual(pattern.examples, []);
    assert.equal(pattern.exampleLimit, DEFAULT_PATTERN_EXAMPLE_LIMIT);

    const first = example({ text: 'x'.repeat(20000), forced: true });
    store.savePattern(content, [], true, id, pattern.revision, undefined, { examples: [first], exampleLimit: 0 });
    pattern = store.patternsSnapshot().patterns.find(item => item.id === id)!;
    assert.deepEqual(pattern.examples, [first]);
    assert.equal(pattern.exampleLimit, 0);

    store.savePattern({ ...content, name: 'Edited pattern' }, ['edited'], false, id, pattern.revision, undefined, { exampleLimit: null });
    pattern = store.patternsSnapshot().patterns.find(item => item.id === id)!;
    assert.deepEqual(pattern.examples, [first], 'omitting examples preserves the current bank');
    assert.equal(pattern.exampleLimit, null);
    store.savePattern({ ...content, name: 'Third version' }, ['edited'], true, id, pattern.revision);

    const versions = store.patternVersions(id);
    assert.equal(versions.length, 4);
    assert.deepEqual(versions[0]!.examples, [first]);
    assert.equal(versions[0]!.exampleLimit, null);
    assert.deepEqual(versions[1]!.examples, [first]);
    assert.equal(versions[1]!.exampleLimit, null);
    assert.deepEqual(versions[2]!.examples, [first]);
    assert.equal(versions[2]!.exampleLimit, 0);
    assert.deepEqual(versions[3]!.examples, []);
    assert.equal(versions[3]!.exampleLimit, DEFAULT_PATTERN_EXAMPLE_LIMIT);

    store = await Store.open(temp.directory);
    pattern = store.patternsSnapshot().patterns.find(item => item.id === id)!;
    assert.deepEqual(pattern.examples, [first]);
    assert.equal(pattern.exampleLimit, null);
    store.setPatternEnabled(id, false);
    assert.equal(store.sessionPatterns('lean-picker').find(item => item.id === id)!.selected, false);
    assert.deepEqual(Object.keys(store.sessionPatterns('lean-picker').find(item => item.id === id)!).sort(),
      ['format', 'id', 'name', 'reasoning', 'revision', 'rule', 'selected', 'structure', 'tags']);
  } finally { temp.remove(); }
});

test('older records and versions remain valid without migration and omitted config stays absent', async () => {
  const temp = temporary();
  try {
    let store = await Store.open(temp.directory);
    const legacyId = store.savePattern(content, ['legacy'], true);
    const path = join(temp.directory, 'patterns', `${legacyId}.json`);
    const legacyRecord = readPatternRecord(temp.directory, legacyId);
    for (const version of legacyRecord.versions) {
      delete version.examples;
      delete version.exampleLimit;
    }
    writeFileSync(path, `${JSON.stringify(legacyRecord, null, 2)}\n`);
    const original = readFileSync(path);
    const oldPattern = store.patterns().find(pattern => pattern.id === legacyId)!;
    assert.equal('examples' in oldPattern, false);
    assert.equal('exampleLimit' in oldPattern, false);

    store = await Store.open(temp.directory);
    assert.deepEqual(readFileSync(path), original, 'opening old non-core version-1 records does not migrate or rewrite them');
    const current = store.patterns().find(pattern => pattern.id === legacyId)!;
    store.savePattern({
      name: current.name, format: current.format, structure: current.structure, rule: current.rule, reasoning: current.reasoning,
    }, current.tags, current.enabled, current.id, current.revision);
    assert.equal('examples' in store.patterns().find(pattern => pattern.id === current.id)!, false);
    assert.equal('exampleLimit' in store.patterns().find(pattern => pattern.id === current.id)!, false);
    assert.equal('examples' in store.patternVersions(current.id)[0]!, false);
  } finally { temp.remove(); }
});

test('example validation rejects malformed banks before writes, enforces stale revisions, and has no count cap', async () => {
  const temp = temporary();
  try {
    const store = await Store.open(temp.directory);
    const id = store.savePattern(content, [], true);
    const current = store.patterns().find(pattern => pattern.id === id)!;
    const path = join(temp.directory, 'patterns', `${id}.json`);
    const before = readFileSync(path);
    const duplicateId = randomUUID();
    const invalidConfigs: unknown[] = [
      { examples: [example({ id: duplicateId }), example({ id: duplicateId, text: 'Different content' })] },
      { examples: [example({ id: 'not-a-uuid' })] },
      { examples: [example({ text: '  \n' })] },
      { examples: [example({ text: 'x'.repeat(20001) })] },
      { examples: [example({ forced: 'yes' as unknown as boolean })] },
      { exampleLimit: -1 }, { exampleLimit: 1001 }, { exampleLimit: 1.5 }, { exampleLimit: '3' as unknown as number },
    ];
    for (const config of invalidConfigs) {
      assert.throws(() => store.savePattern(content, [], true, id, current.revision, undefined, config as PatternExampleConfig));
      assert.deepEqual(readFileSync(path), before, 'invalid configuration must not write a new version');
    }

    const exactLimit = example({ text: 'x'.repeat(20000) });
    store.savePattern(content, [], true, id, current.revision, undefined, { examples: [exactLimit] });
    const updated = store.patterns().find(pattern => pattern.id === id)!;
    const savedBytes = readFileSync(path);
    assert.throws(() => store.savePattern(content, [], true, id, current.revision, undefined, { exampleLimit: 1 }), /Pattern changed/);
    assert.deepEqual(readFileSync(path), savedBytes, 'stale writes leave the latest configuration untouched');

    const many = Array.from({ length: 1001 }, (_, index) => example({ text: `Example ${index}` }));
    store.savePattern(content, [], true, id, updated.revision, undefined, { examples: many });
    assert.equal(store.patterns().find(pattern => pattern.id === id)!.examples!.length, 1001);
  } finally { temp.remove(); }
});

test('example settings default to 15, persist zero, validate strictly, and survive pattern-library cleanup', async () => {
  const temp = temporary();
  try {
    let store = await Store.openPatterns(temp.directory);
    assert.deepEqual(store.exampleSettings(), DEFAULT_EXAMPLE_SETTINGS);
    assert.equal(existsSync(join(temp.directory, 'example-settings.json')), false, 'reading defaults does not create storage');
    assert.deepEqual(store.saveExampleSettings({ overallExampleLimit: 0 }), { overallExampleLimit: 0 });
    const settingPath = join(temp.directory, 'example-settings.json');
    assert.deepEqual(JSON.parse(readFileSync(settingPath, 'utf8')), { version: 1, overallExampleLimit: 0 });
    store = await Store.openPatterns(temp.directory);
    assert.deepEqual(store.exampleSettings(), { overallExampleLimit: 0 });

    const before = readFileSync(settingPath);
    for (const invalid of [-1, 1001, 1.25, '3', null]) {
      assert.throws(() => store.saveExampleSettings({ overallExampleLimit: invalid } as any));
      assert.deepEqual(readFileSync(settingPath), before);
    }
    assert.throws(() => store.saveExampleSettings({ overallExampleLimit: 1, extra: true } as any));

    writeFileSync(join(temp.directory, 'settings.json'), `${JSON.stringify(oldSettings())}\n`);
    store = await Store.openPatterns(temp.directory);
    assert.equal(existsSync(join(temp.directory, 'settings.json')), false, 'only obsolete settings.json is cleaned up');
    assert.equal(store.exampleSettings().overallExampleLimit, 0);
    assert.equal(existsSync(settingPath), true);
  } finally { temp.remove(); }
});

test('malformed example settings block activation before legacy cleanup', async () => {
  const temp = temporary();
  try {
    const legacyPath = join(temp.directory, 'settings.json');
    const examplePath = join(temp.directory, 'example-settings.json');
    writeFileSync(legacyPath, `${JSON.stringify(oldSettings())}\n`);
    for (const malformed of [
      { version: 2, overallExampleLimit: 8 },
      { version: 1, overallExampleLimit: 8, extra: true },
      { version: 1, overallExampleLimit: -1 },
    ]) {
      writeFileSync(examplePath, `${JSON.stringify(malformed)}\n`);
      const legacyBefore = readFileSync(legacyPath);
      await assert.rejects(Store.openPatterns(temp.directory), /Unknown record version|Example settings/);
      assert.deepEqual(readFileSync(legacyPath), legacyBefore, 'legacy cleanup must wait for new storage validation');
    }
  } finally { temp.remove(); }
});

test('backend exposes example configuration and settings APIs with library notifications', async () => {
  const temp = temporary(), host = await backend(temp.directory);
  try {
    const initialNotifications = host.notifications;
    assert.deepEqual(await host.call('example-settings'), DEFAULT_EXAMPLE_SETTINGS);
    assert.equal(host.notifications, initialNotifications);
    assert.deepEqual(await host.call('example-settings-save', { overallExampleLimit: 0 }), { overallExampleLimit: 0 });
    assert.deepEqual(host.emitted.at(-1), { topic: 'library-changed', data: undefined });
    await assert.rejects(host.call('example-settings-save', { overallExampleLimit: 1001 }), /Invalid/);

    const id = await host.call<string>('pattern-save', {
      content, tags: [], enabled: true, examples: [example({ forced: true })], exampleLimit: null,
    });
    const pattern = (await host.call<{ patterns: Array<Record<string, any>> }>('patterns-snapshot')).patterns.find(item => item.id === id)!;
    assert.equal(pattern.exampleLimit, null);
    assert.equal(pattern.examples[0].forced, true);
    const versions = await host.call<Array<Record<string, any>>>('pattern-versions', { id });
    assert.equal(versions[0]!.exampleLimit, null);
    assert.deepEqual(versions[0]!.examples, pattern.examples);
    await assert.rejects(host.call('pattern-save', {
      id, expectedRevision: 1, content, tags: [], enabled: true,
      examples: [example({ id: '00000000-0000-4000-8000-000000000001' }), example({ id: '00000000-0000-4000-8000-000000000001' })],
    }), /unique/);
    const sessionPattern = (await host.call<any[]>('session-patterns', { sessionId: 'picker' })).find(item => item.id === id)!;
    assert.equal('examples' in sessionPattern, false, 'session picker remains lean and does not return example banks');
  } finally { await host.dispose(); temp.remove(); }
});
