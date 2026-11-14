import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Value } from 'typebox/value';
import { DEFAULT_PATTERN_EXAMPLE_LIMIT, PatternContentSchema, PatternExamplesSchema, type PatternContent, type PatternExample } from '../src/domain';
import { Store } from '../src/store';
import { LEGACY_CORE_EXAMPLE_HASHES } from '../src/core-example-upgrades';
import { CORE_PATTERNS, CORE_SEED_VERSION } from '../src/structures';

const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), 'core-upgrade-'));
  return { directory, remove: () => rmSync(directory, { recursive: true, force: true }) };
};
const patternPath = (directory: string, id: string) => join(directory, 'patterns', `${id}.json`);
const readRecord = (directory: string, id: string) => JSON.parse(readFileSync(patternPath(directory, id), 'utf8')) as any;
const writeRecord = (directory: string, id: string, record: unknown) =>
  writeFileSync(patternPath(directory, id), `${JSON.stringify(record, null, 2)}\n`);

const readBytes = (path: string) => readFileSync(path);

test('all core seeds satisfy the reusable-content and cross-subject example contract', () => {
  const supportedFormats = new Set(['any', 'multiple_choice', 'open_response']);
  const subjectSpecificTerms = /\b(?:algebra|arithmetic|biology|botany|chemistry|ecology|fractions?|geography|grammar|history|language|linguistics?|physics|plants?|portuguese|programming|water|weather)\b/i;
  const exampleIds = new Set<string>();

  assert.equal(CORE_PATTERNS.length, 12);
  assert.equal(new Set(CORE_PATTERNS.map(definition => definition.id)).size, 12);
  for (const definition of CORE_PATTERNS) {
    assert.ok(Value.Check(PatternContentSchema, definition.content), `${definition.content.name} has valid pattern content`);
    assert.ok(supportedFormats.has(definition.content.format), `${definition.content.name} uses a UI-supported format`);
    assert.ok(Value.Check(PatternExamplesSchema, definition.examples), `${definition.content.name} has valid examples`);
    assert.equal(definition.examples.length, 3, `${definition.content.name} has three examples`);

    const content = JSON.stringify(definition.content);
    assert.doesNotMatch(content, subjectSpecificTerms, `${definition.content.name} stays independent of its example subjects`);
    for (const example of definition.examples) {
      assert.ok(!exampleIds.has(example.id), `duplicate core example ID: ${example.id}`);
      exampleIds.add(example.id);
      assert.match(example.text, /(?:^|\n)Question:\s*\S/i, `${example.id} includes a complete English question`);
      assert.match(example.text, /(?:^|\n)(?:Model )?Answer:\s*\S/i, `${example.id} includes an English answer key`);
      assert.match(example.text, /(?:^|\n)Rationale:\s*\S/i, `${example.id} includes an English rationale`);
      assert.doesNotMatch(example.text, /(?:^|\n)(?:Pergunta|Resposta|Justificativa):/i, `${example.id} has no Portuguese section headings`);
      assert.equal(example.forced, false, `${example.id} is sampled normally`);
    }
  }
  assert.equal(exampleIds.size, 36);
});

test('fresh core records persist the current seed version and three cloned, unforced examples', async () => {
  const temp = temporary();
  try {
    const store = await Store.open(temp.directory);
    assert.equal(CORE_PATTERNS.length, 12);
    for (const definition of CORE_PATTERNS) {
      assert.equal(definition.examples.length, 3);
      assert.ok(definition.examples.every(example => example.forced === false));
      const record = readRecord(temp.directory, definition.id);
      assert.equal(record.coreSeedVersion, CORE_SEED_VERSION);
      assert.equal(record.versions.length, 1);
      assert.equal(record.versions[0].revision, 1);
      assert.deepEqual(record.versions[0].content, definition.content);
      assert.deepEqual(record.versions[0].examples, definition.examples);
      assert.equal(record.versions[0].exampleLimit, DEFAULT_PATTERN_EXAMPLE_LIMIT);
    }
    assert.equal(store.patterns().length, 12);
  } finally { temp.remove(); }
});

test('fresh libraries select only three starter defaults and never reset saved choices', async () => {
  const temp = temporary();
  let store = await Store.openPatterns(temp.directory);
  try {
    const starters = ['Direct Question', 'Multiple Choice', 'Open-Ended Explanation'].sort();
    const snapshot = store.patternsSnapshot().patterns;
    assert.equal(snapshot.length, 12, 'all core patterns are still created');
    assert.deepEqual(snapshot.filter(pattern => pattern.enabled).map(pattern => pattern.name).sort(), starters);
    assert.equal(store.sessionPatterns('first-session').length, 12, 'non-default cores remain selectable');
    assert.deepEqual(store.sessionPatterns('first-session').filter(pattern => pattern.selected).map(pattern => pattern.name).sort(), starters);

    const extra = snapshot.find(pattern => pattern.name === 'Fill in the Blank')!;
    for (const pattern of snapshot) store.setPatternEnabled(pattern.id, pattern.id === extra.id);
    store.close();
    store = await Store.openPatterns(temp.directory);
    assert.deepEqual(store.patternsSnapshot().patterns.filter(pattern => pattern.enabled).map(pattern => pattern.id), [extra.id], 'reopening preserves changed default switches');
    assert.deepEqual(store.sessionPatterns('first-session').filter(pattern => pattern.selected).map(pattern => pattern.name).sort(), starters, 'existing session choices remain unchanged');
    assert.deepEqual(store.sessionPatterns('later-session').filter(pattern => pattern.selected).map(pattern => pattern.id), [extra.id]);

    store.setPatternEnabled(extra.id, false);
    store.close();
    store = await Store.openPatterns(temp.directory);
    assert.equal(store.patternsSnapshot().patterns.filter(pattern => pattern.enabled).length, 0, 'turning every default off stays off');
    assert.deepEqual(store.sessionPatterns('empty-defaults').filter(pattern => pattern.selected), []);
  } finally { store.close(); temp.remove(); }
});

test('legacy core records upgrade once, merge user examples, and preserve unrelated state', async () => {
  const temp = temporary();
  try {
    let store = await Store.open(temp.directory);
    const target = CORE_PATTERNS[0]!;
    const zeroLimitTarget = CORE_PATTERNS[1]!;
    const selectedCoreId = target.id;
    store.setSessionPattern('saved-session', selectedCoreId, true);
    store.saveTemplate('Saved core set', [selectedCoreId]);
    store.saveSettings({ instructions: 'Keep these settings.', maxTurns: 6, modelSlot: 'cheap', analysisStrength: 'medium' });
    store.saveExampleSettings({ overallExampleLimit: 8 });
    const nonCoreId = store.savePattern({
      name: 'User-created pattern', format: 'user_pattern', structure: {}, rule: 'A user definition.', reasoning: [],
    }, ['mine'], true);

    const customExample: PatternExample = { id: target.examples[0]!.id, text: 'User replacement for a seeded ID.', forced: true };
    const additionalExample: PatternExample = { id: randomUUID(), text: 'User-added example.', forced: true };
    let targetRecord: any;
    let previousVersions: unknown[] = [];
    for (const [index, definition] of CORE_PATTERNS.entries()) {
      const record = readRecord(temp.directory, definition.id);
      delete record.coreSeedVersion;
      for (const version of record.versions) {
        delete version.examples;
        delete version.exampleLimit;
      }
      if (index === 0) record.coreSeedVersion = 1;
      if (definition.id === target.id) {
        const prior = structuredClone(record.versions.at(-1));
        prior.revision = 2;
        prior.content.name = 'A previous user edit';
        prior.examples = [customExample, additionalExample];
        prior.exampleLimit = null;
        record.versions.push(prior);
        record.tags = ['Core', 'User tag'];
        record.enabled = false;
        record.archived = true;
        record.analysisIds = ['10000000-0000-4000-8000-000000000001'];
        record.activeAnalysisId = '10000000-0000-4000-8000-000000000001';
        record.patternIds = ['20000000-0000-4000-8000-000000000002'];
        previousVersions = structuredClone(record.versions);
        targetRecord = record;
      } else if (definition.id === zeroLimitTarget.id) {
        record.versions.at(-1).exampleLimit = 0;
      }
      writeRecord(temp.directory, definition.id, record);
    }

    const globalPaths = [
      join(temp.directory, 'settings.json'),
      join(temp.directory, 'example-settings.json'),
      join(temp.directory, 'templates.json'),
      join(temp.directory, 'session-selections.json'),
      patternPath(temp.directory, nonCoreId),
    ];
    const globalsBefore = globalPaths.map(readBytes);
    const legacyLinks = {
      analysisIds: targetRecord.analysisIds,
      activeAnalysisId: targetRecord.activeAnalysisId,
      patternIds: targetRecord.patternIds,
    };
    const expectedExamples = target.examples.map(example => example.id === customExample.id ? customExample : example)
      .concat(additionalExample);

    store = await Store.open(temp.directory);
    for (const definition of CORE_PATTERNS) {
      const upgraded = readRecord(temp.directory, definition.id);
      assert.equal(upgraded.coreSeedVersion, CORE_SEED_VERSION);
      assert.equal(upgraded.versions.at(-1).revision, definition.id === target.id ? 3 : 2);
      assert.deepEqual(upgraded.versions.at(-1).content, definition.content);
      assert.deepEqual(upgraded.versions.at(-1).examples,
        definition.id === target.id ? expectedExamples : definition.examples);
      assert.equal(upgraded.versions.at(-1).exampleLimit,
        definition.id === target.id ? null : definition.id === zeroLimitTarget.id ? 0 : DEFAULT_PATTERN_EXAMPLE_LIMIT);
      assert.ok(upgraded.versions.at(-1).examples.every((example: PatternExample) => example.forced === false || definition.id === target.id));
    }

    const upgradedTarget = readRecord(temp.directory, target.id);
    assert.deepEqual(upgradedTarget.versions.slice(0, previousVersions.length), previousVersions);
    assert.deepEqual({ tags: upgradedTarget.tags, enabled: upgradedTarget.enabled, archived: upgradedTarget.archived },
      { tags: ['Core', 'User tag'], enabled: false, archived: true });
    assert.deepEqual({ analysisIds: upgradedTarget.analysisIds, activeAnalysisId: upgradedTarget.activeAnalysisId, patternIds: upgradedTarget.patternIds }, legacyLinks);
    assert.equal(upgradedTarget.versions.at(-1).runId, null);
    assert.equal(upgradedTarget.versions.at(-1).itemId, null);
    assert.deepEqual(globalPaths.map(readBytes), globalsBefore, 'settings, examples settings, templates, selections and user patterns are untouched');

    const seededBytes = CORE_PATTERNS.map(definition => readBytes(patternPath(temp.directory, definition.id)));
    store = await Store.open(temp.directory);
    assert.deepEqual(CORE_PATTERNS.map(definition => readBytes(patternPath(temp.directory, definition.id))), seededBytes,
      'a second activation does not append another revision');

    const userEditedCore = CORE_PATTERNS[2]!;
    const current = store.patterns().find(pattern => pattern.id === userEditedCore.id)!;
    const content: PatternContent = {
      name: current.name, format: current.format, structure: current.structure, rule: current.rule, reasoning: current.reasoning,
    };
    store.savePattern(content, current.tags, current.enabled, current.id, current.revision, undefined, { examples: [] });
    const editedRevision = readRecord(temp.directory, current.id).versions.at(-1).revision;
    store = await Store.open(temp.directory);
    const afterUserEdit = readRecord(temp.directory, current.id);
    assert.equal(afterUserEdit.versions.at(-1).revision, editedRevision);
    assert.deepEqual(afterUserEdit.versions.at(-1).examples, [], 'removing seeded examples later does not trigger a reseed');
  } finally { temp.remove(); }
});

test('version 3 refreshes only untouched legacy example text and is idempotent', async () => {
  const temp = temporary();
  try {
    const definition = CORE_PATTERNS[0]!;
    const legacyId = definition.examples[1]!.id;
    const oldLegacyText = `Pergunta: Qual é a forma do verbo "publicar" no pretérito perfeito do indicativo que concorda com "as pesquisadoras"?\n\nResposta: Publicaram.\nJustificativa: "As pesquisadoras" corresponde à terceira pessoa do plural.`;
    assert.equal(createHash('sha256').update(oldLegacyText).digest('hex'), LEGACY_CORE_EXAMPLE_HASHES[legacyId]);

    await Store.open(temp.directory);
    const record = readRecord(temp.directory, definition.id);
    record.coreSeedVersion = 2;
    const [customSeedExample, legacyExample] = record.versions.at(-1).examples as PatternExample[];
    customSeedExample.text = 'A learner rewrote this example.';
    customSeedExample.forced = true;
    legacyExample.text = oldLegacyText;
    legacyExample.forced = true;
    const previousVersions = structuredClone(record.versions);
    writeRecord(temp.directory, definition.id, record);

    await Store.open(temp.directory);
    const upgraded = readRecord(temp.directory, definition.id);
    const examples = upgraded.versions.at(-1).examples as PatternExample[];
    assert.equal(upgraded.coreSeedVersion, 3);
    assert.equal(upgraded.versions.at(-1).revision, 2);
    assert.deepEqual(upgraded.versions.slice(0, previousVersions.length), previousVersions);
    assert.deepEqual(examples.find(example => example.id === customSeedExample.id), customSeedExample,
      'user text on a seeded ID is preserved');
    assert.deepEqual(examples.find(example => example.id === legacyId), {
      ...legacyExample, text: definition.examples[1]!.text,
    }, 'known original text is refreshed while its ID and forced flag are preserved');

    const bytesAfterUpgrade = readBytes(patternPath(temp.directory, definition.id));
    await Store.open(temp.directory);
    assert.deepEqual(readBytes(patternPath(temp.directory, definition.id)), bytesAfterUpgrade,
      'a version-3 activation does not refresh again');
  } finally { temp.remove(); }
});

test('pattern-only activation upgrades legacy cores without restoring legacy links', async () => {
  const temp = temporary();
  try {
    const initial = await Store.open(temp.directory);
    const imported = initial.importSource({
      filename: 'old.txt', kind: 'txt', location: '', bytes: Buffer.from('legacy source'), text: 'legacy source', notices: [],
    });
    for (const definition of CORE_PATTERNS) {
      const record = readRecord(temp.directory, definition.id);
      delete record.coreSeedVersion;
      for (const version of record.versions) {
        delete version.examples;
        delete version.exampleLimit;
      }
      writeRecord(temp.directory, definition.id, record);
    }

    const store = await Store.openPatterns(temp.directory);
    for (const definition of CORE_PATTERNS) {
      const record = readRecord(temp.directory, definition.id);
      assert.equal(record.coreSeedVersion, CORE_SEED_VERSION);
      assert.equal(record.versions.at(-1).revision, 2);
      assert.deepEqual(record.versions.at(-1).examples, definition.examples);
      assert.equal(record.versions.at(-1).exampleLimit, DEFAULT_PATTERN_EXAMPLE_LIMIT);
      assert.equal('runId' in record.versions.at(-1), false);
      assert.equal('itemId' in record.versions.at(-1), false);
      assert.equal('analysisIds' in record, false);
      assert.equal('activeAnalysisId' in record, false);
      assert.equal('patternIds' in record, false);
    }
    assert.equal(existsSync(join(temp.directory, 'sources')), false);
    assert.equal(existsSync(join(temp.directory, 'settings.json')), false);
    assert.ok(imported.id);
    assert.equal(store.patterns().length, 12);
  } finally { temp.remove(); }
});

test('a future core seed version blocks both cleanup and partial seeding', async () => {
  const cleanupTemp = temporary();
  try {
    const store = await Store.open(cleanupTemp.directory);
    const imported = store.importSource({
      filename: 'keep.txt', kind: 'txt', location: '', bytes: Buffer.from('keep'), text: 'keep', notices: [],
    });
    const future = CORE_PATTERNS.at(-1)!;
    const futurePath = patternPath(cleanupTemp.directory, future.id);
    const futureRecord = readRecord(cleanupTemp.directory, future.id);
    futureRecord.coreSeedVersion = CORE_SEED_VERSION + 1;
    writeRecord(cleanupTemp.directory, future.id, futureRecord);
    const futureBefore = readBytes(futurePath);
    const sourcePath = join(cleanupTemp.directory, 'sources', `${imported.id}.json`);
    const settingsPath = join(cleanupTemp.directory, 'settings.json');
    const sourceBefore = readBytes(sourcePath), settingsBefore = readBytes(settingsPath);
    const stalePath = `${futurePath}.${randomUUID()}.tmp`;
    writeFileSync(stalePath, '{ stale temporary');
    const staleBefore = readBytes(stalePath);

    await assert.rejects(Store.openPatterns(cleanupTemp.directory), /newer than supported version/);
    assert.deepEqual(readBytes(futurePath), futureBefore);
    assert.deepEqual(readBytes(sourcePath), sourceBefore);
    assert.deepEqual(readBytes(settingsPath), settingsBefore);
    assert.deepEqual(readBytes(stalePath), staleBefore);
  } finally { cleanupTemp.remove(); }

  const seedTemp = temporary();
  try {
    await Store.open(seedTemp.directory);
    const missingSeed = CORE_PATTERNS[0]!;
    const future = CORE_PATTERNS.at(-1)!;
    const missingPath = patternPath(seedTemp.directory, missingSeed.id);
    unlinkSync(missingPath);
    const futurePath = patternPath(seedTemp.directory, future.id);
    const futureRecord = readRecord(seedTemp.directory, future.id);
    futureRecord.coreSeedVersion = CORE_SEED_VERSION + 1;
    writeRecord(seedTemp.directory, future.id, futureRecord);
    const futureBefore = readBytes(futurePath);

    await assert.rejects(Store.open(seedTemp.directory), /newer than supported version/);
    assert.equal(existsSync(missingPath), false, 'preflight prevents earlier missing cores from being seeded');
    assert.deepEqual(readBytes(futurePath), futureBefore);
  } finally { seedTemp.remove(); }
});
