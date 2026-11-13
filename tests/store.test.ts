import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store';
import { CORE_PATTERNS } from '../src/structures';
import { atomicWrite, recordPath } from '../src/files';
import { compareItems, patternContent, validateAnalysis, type Analysis, type PatternContent, type PatternProposal } from '../src/domain';

const sourceText = 'Choose one answer. Explain your reasoning.';
const multipleChoiceStructure = CORE_PATTERNS[1]!.content.structure;
const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), 'patterns-store-'));
  return { directory, remove: () => rmSync(directory, { recursive: true, force: true }) };
};
const imported = (store: Store, text = sourceText, replaceId?: string) => store.importSource({
  filename: 'assessment.md', kind: 'md', location: 'local/assessment.md', bytes: Buffer.from(text), text, notices: [], replaceId,
});
const proposal = (overrides: Partial<PatternProposal> = {}): PatternProposal => ({
  key: 'multiple-choice', name: 'Choose an answer', format: 'multiple_choice',
  structure: { ...multipleChoiceStructure },
  rule: 'Select the best-supported answer from the alternatives.', reasoning: [],
  support: 'supported', evidence: 'Choose one answer.', existingPatternId: null,
  similarPatternId: null, difference: null, ...overrides,
});
const analysis = (...patterns: PatternProposal[]): Analysis => ({ patterns });
const scan = (store: Store, id: string, targetKind: 'source' | 'pattern' = 'source') => store.createRun({
  requestId: crypto.randomUUID(), targetKind, targetId: id,
  model: { provider: 'test', id: 'model-a' }, instructions: '',
});
const readRecord = (directory: string, folder: string, id: string) => JSON.parse(readFileSync(recordPath(directory, folder, id), 'utf8'));
const clearSession = (store: Store, sessionId: string) => {
  for (const pattern of store.sessionPatterns(sessionId)) if (pattern.selected) {
    store.setSessionPattern(sessionId, pattern.id, false);
  }
};

test('seeds exactly 12 core patterns and stores only sources, patterns, runs, and settings', async () => {
  const temp = temporary();
  try {
    const store = await Store.open(temp.directory);
    const snapshot = store.snapshot();
    assert.equal(snapshot.patterns.length, 12);
    assert.equal(new Set(snapshot.patterns.map(pattern => pattern.id)).size, 12);
    assert.deepEqual(Object.keys(snapshot).sort(), ['patterns', 'runs', 'settings', 'sources']);
    assert.deepEqual(readdirSync(temp.directory).sort(), ['analyses', 'patterns', 'settings.json', 'sources']);
    const source = imported(store);
    const record = snapshot.patterns.find(pattern => pattern.name === 'Multiple Choice')!;
    const before = readFileSync(recordPath(temp.directory, 'patterns', record.id));
    await Store.open(temp.directory);
    assert.deepEqual(readFileSync(recordPath(temp.directory, 'patterns', record.id)), before);
    assert.equal(store.snapshot().patterns.length, 12);
    assert.equal('questionCount' in store.snapshot().sources[0]!, false);
    assert.equal(source.duplicate, false);
  } finally { temp.remove(); }
});

test('new sessions select enabled patterns and list all non-archived current definitions', async () => {
  const temp = temporary();
  try {
    const store = await Store.open(temp.directory);
    const available = store.patterns().filter(pattern => !pattern.archived)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const sessionPatterns = store.sessionPatterns('session one');
    assert.deepEqual(sessionPatterns, available.map(({ id, name, format, structure, rule, reasoning, tags, revision, enabled }) => ({
      id, name, format, structure, rule, reasoning, tags, revision, selected: enabled,
    })));
    assert.deepEqual(JSON.parse(readFileSync(join(temp.directory, 'session-selections.json'), 'utf8')).sessions[0].patternIds.sort(),
      available.filter(pattern => pattern.enabled).map(pattern => pattern.id).sort());
  } finally { temp.remove(); }
});

test('session selections isolate opaque IDs safely and survive restart', async () => {
  const temp = temporary();
  try {
    let store = await Store.open(temp.directory);
    const [first, second] = store.patterns();
    for (const sessionId of ['__proto__', 'constructor', 'toString', 'session id / ?']) {
      clearSession(store, sessionId);
      assert.equal(store.setSessionPattern(sessionId, first!.id, true).find(pattern => pattern.id === first!.id)!.selected, true);
      assert.equal(store.sessionPatterns(sessionId).find(pattern => pattern.id === second!.id)!.selected, false);
    }
    assert.equal(store.setSessionPattern('constructor', second!.id, true).find(pattern => pattern.id === second!.id)!.selected, true);
    assert.equal(store.sessionPatterns('__proto__').find(pattern => pattern.id === second!.id)!.selected, false);

    store = await Store.open(temp.directory);
    assert.equal(store.sessionPatterns('__proto__').find(pattern => pattern.id === first!.id)!.selected, true);
    assert.equal(store.sessionPatterns('constructor').find(pattern => pattern.id === second!.id)!.selected, true);
    assert.equal(store.sessionPatterns('toString').find(pattern => pattern.id === second!.id)!.selected, false);
    assert.deepEqual(JSON.parse(readFileSync(join(temp.directory, 'session-selections.json'), 'utf8')).sessions.map((item: { sessionId: string }) => item.sessionId),
      ['__proto__', 'constructor', 'toString', 'session id / ?']);
    assert.throws(() => store.sessionPatterns('  '), /Session ID/);
    assert.throws(() => store.sessionPatterns('x'.repeat(501)), /Session ID/);
  } finally { temp.remove(); }
});

test('session toggles allow disabled patterns, exclude archived patterns, and never mutate definitions', async () => {
  const temp = temporary();
  try {
    const store = await Store.open(temp.directory);
    const available = store.patterns()[0]!;
    const disabledId = store.savePattern({ name: 'Disabled pattern', format: 'disabled', structure: {}, rule: 'Disabled.', reasoning: [] }, [], true);
    const archivedId = store.savePattern({ name: 'Archived pattern', format: 'archived', structure: {}, rule: 'Archived.', reasoning: [] }, [], true);
    const disabled = store.patterns().find(pattern => pattern.id === disabledId)!;
    store.savePattern({ name: disabled.name, format: disabled.format, structure: disabled.structure, rule: disabled.rule, reasoning: disabled.reasoning }, disabled.tags, false, disabledId, disabled.revision);
    store.archive('pattern', archivedId, true);
    clearSession(store, 'toggle-session');

    const patternDir = join(temp.directory, 'patterns');
    const definitionsBefore = () => readdirSync(patternDir).sort().map(file => [file, readFileSync(join(patternDir, file))]);
    const before = definitionsBefore();
    const listed = store.sessionPatterns('toggle-session');
    assert.ok(listed.some(pattern => pattern.id === disabledId && !pattern.selected));
    assert.ok(!listed.some(pattern => pattern.id === archivedId));
    assert.throws(() => store.setSessionPattern('toggle-session', archivedId, true), /unavailable/);
    assert.equal(store.setSessionPattern('toggle-session', disabledId, true).find(pattern => pattern.id === disabledId)!.selected, true);
    assert.equal(store.setSessionPattern('toggle-session', available.id, true).find(pattern => pattern.id === available.id)!.selected, true);
    assert.equal(store.setSessionPattern('toggle-session', available.id, false).find(pattern => pattern.id === available.id)!.selected, false);
    store.setSessionPattern('toggle-session', disabledId, false);
    store.setSessionPattern('toggle-session', archivedId, false);
    const persisted = JSON.parse(readFileSync(join(temp.directory, 'session-selections.json'), 'utf8'));
    assert.deepEqual(persisted.sessions.find((entry: { sessionId: string }) => entry.sessionId === 'toggle-session')?.patternIds, []);
    assert.deepEqual(definitionsBefore(), before);
  } finally { temp.remove(); }
});

test('malformed session selection storage is rejected strictly', async () => {
  const temp = temporary();
  try {
    const store = await Store.open(temp.directory);
    const path = join(temp.directory, 'session-selections.json');
    for (const malformed of [
      '{"version":1,"sessions":[],"extra":true}',
      '{"version":1,"sessions":[{"sessionId":" ","patternIds":[]}]}',
      '{"version":1,"sessions":[{"sessionId":"same","patternIds":[]},{"sessionId":"same","patternIds":[]}]}',
      '{"version":1,"sessions":[{"sessionId":"same","patternIds":["pattern","pattern"]}]}',
      '{"version":2,"sessions":[]}',
      '{not json',
    ]) {
      writeFileSync(path, malformed);
      assert.throws(() => store.sessionPatterns('session'), /Session selections|Unknown record version|JSON/);
    }
  } finally { temp.remove(); }
});

test('source replacement preserves immutable originals and analysis output remains immutable', async () => {
  const temp = temporary();
  try {
    const store = await Store.open(temp.directory), first = imported(store);
    const source = store.snapshot().sources[0]!;
    const original = store.sourceRevision(source.revisionId);
    const originalPath = join(temp.directory, 'sources', `${source.revisionId}.original.md`);
    const revisionPath = recordPath(temp.directory, 'sources', source.revisionId, '.revision');
    const originalBytes = readFileSync(originalPath), revisionBytes = readFileSync(revisionPath);
    const run = scan(store, source.id);
    store.finishRun(run.id, analysis(proposal()), { outputTokens: 12 });
    const resultPath = recordPath(temp.directory, 'analyses', run.id, '.result');
    const resultBytes = readFileSync(resultPath);
    store.decide(store.items(run.id)[0]!.id, 'accepted', run.id);
    assert.deepEqual(readFileSync(resultPath), resultBytes);
    assert.deepEqual(readFileSync(originalPath), originalBytes);
    assert.deepEqual(readFileSync(revisionPath), revisionBytes);

    imported(store, 'A revised source with new material.', first.id);
    const current = store.snapshot().sources[0]!;
    assert.notEqual(current.revisionId, source.revisionId);
    assert.equal(store.sourceRevisions(first.id).length, 2);
    assert.equal(store.sourceRevision(source.revisionId).text, original.text);
    assert.deepEqual(readFileSync(originalPath), originalBytes);
  } finally { temp.remove(); }
});

test('automatic matching ignores variable counts, subject, difficulty, and reasoning without editing definitions', async () => {
  const temp = temporary();
  try {
    const store = await Store.open(temp.directory), source = imported(store);
    const core = store.snapshot().patterns.find(pattern => pattern.name === 'Multiple Choice')!;
    const corePath = recordPath(temp.directory, 'patterns', core.id), coreBefore = readFileSync(corePath);
    const run = scan(store, source.id);
    store.finishRun(run.id, analysis(proposal({
      format: 'multiple-choice',
      structure: { ...multipleChoiceStructure, option_count: 9, subject: 'biology', difficulty: 'advanced' },
      reasoning: ['compare evidence', 'explain reasoning'],
    })), null);
    const item = store.items(run.id)[0]!;
    assert.equal(item.decision, 'accepted');
    assert.equal(item.automatic, true);
    assert.equal(item.appliedId, core.id);
    assert.ok(store.snapshot().sources.find(item => item.id === source.id)!.patternIds.includes(core.id));
    assert.deepEqual(readFileSync(corePath), coreBefore);
    assert.equal(store.patternVersions(core.id).length, 1);
    assert.equal(store.snapshot().patterns.length, 12);
  } finally { temp.remove(); }
});

test('uncertain matches need review and edited approvals never rewrite an equivalent saved pattern', async () => {
  const temp = temporary();
  try {
    const store = await Store.open(temp.directory), source = imported(store);
    const core = store.snapshot().patterns.find(pattern => pattern.name === 'Multiple Choice')!;
    const before = readFileSync(recordPath(temp.directory, 'patterns', core.id));
    const run = scan(store, source.id);
    store.finishRun(run.id, analysis(proposal({ support: 'uncertain', existingPatternId: core.id })), null);
    const item = store.items(run.id)[0]!;
    assert.equal(item.decision, 'candidate', 'uncertain evidence is not a confident automatic match');
    store.decide(item.id, 'accepted', run.id, { ...patternContent(item.value), name: 'Different label', rule: 'A differently phrased rule.' });
    assert.equal(store.items(run.id)[0]!.appliedId, core.id);
    assert.equal(store.snapshot().patterns.length, 12);
    assert.deepEqual(readFileSync(recordPath(temp.directory, 'patterns', core.id)), before);
  } finally { temp.remove(); }
});

test('ambiguous equivalent matches stay reviewable instead of selecting an arbitrary pattern', async () => {
  const temp = temporary();
  try {
    const store = await Store.open(temp.directory), source = imported(store);
    const core = store.snapshot().patterns.find(pattern => pattern.name === 'Multiple Choice')!;
    store.savePattern({ name: 'Equivalent choice', format: core.format, structure: { ...core.structure, option_count: 5 }, rule: 'Choose one.', reasoning: ['different reasoning'] }, [], true);
    const run = scan(store, source.id);
    store.finishRun(run.id, analysis(proposal()), null);
    assert.equal(store.items(run.id)[0]!.decision, 'candidate');
    assert.equal(store.items(run.id)[0]!.appliedId, null);
  } finally { temp.remove(); }
});

test('material structural differences remain candidates and approval creates a separate compact pattern', async () => {
  const temp = temporary();
  try {
    const store = await Store.open(temp.directory), source = imported(store);
    const core = store.snapshot().patterns.find(pattern => pattern.name === 'Multiple Choice')!;
    const coreBefore = readFileSync(recordPath(temp.directory, 'patterns', core.id));
    const run = scan(store, source.id);
    const proposed = proposal({
      key: 'multiple-select', name: 'Select all that apply',
      structure: { ...multipleChoiceStructure, best_answer_count: 2, distractors: 'all alternatives may be correct' },
      similarPatternId: core.id, difference: 'Allows more than one selected answer.',
    });
    store.finishRun(run.id, analysis(proposed), null);
    assert.equal(store.items(run.id)[0]!.decision, 'candidate');
    store.decide(store.items(run.id)[0]!.id, 'accepted', run.id);
    const appliedId = store.items(run.id)[0]!.appliedId!;
    assert.notEqual(appliedId, core.id);
    assert.equal(store.snapshot().patterns.length, 13);
    assert.deepEqual(Object.keys(store.patternVersions(appliedId)[0]!.content).sort(), ['format', 'name', 'reasoning', 'rule', 'structure']);
    assert.deepEqual(readFileSync(recordPath(temp.directory, 'patterns', core.id)), coreBefore);
  } finally { temp.remove(); }
});

test('approving a new structure auto-associates pending duplicate proposals without changing results', async () => {
  const temp = temporary();
  try {
    const store = await Store.open(temp.directory), source = imported(store);
    const run = scan(store, source.id);
    const first = proposal({ key: 'new-rule', name: 'Apply a rule', format: 'rule_application', structure: { answer_type: 'constructed response', response_format: 'short explanation' }, evidence: 'Explain your reasoning.' });
    const duplicate = proposal({ key: 'same-rule', name: 'Use a rule', format: 'rule_application', structure: { response_format: 'short explanation', answer_type: 'constructed response' }, reasoning: ['independent reasoning'], evidence: 'Explain your reasoning.' });
    store.finishRun(run.id, analysis(first, duplicate), null);
    const resultPath = recordPath(temp.directory, 'analyses', run.id, '.result'), resultBefore = readFileSync(resultPath);
    const [one, two] = store.items(run.id);
    store.decide(one!.id, 'accepted', run.id);
    const after = store.items(run.id);
    assert.equal(after[0]!.decision, 'accepted');
    assert.equal(after[1]!.decision, 'accepted');
    assert.equal(after[1]!.automatic, true);
    assert.equal(after[0]!.appliedId, after[1]!.appliedId);
    assert.equal(store.snapshot().patterns.length, 13);
    assert.deepEqual(readFileSync(resultPath), resultBefore);
  } finally { temp.remove(); }
});

test('rejected candidates are final and never resurrect after an equivalent pattern is approved', async () => {
  const temp = temporary();
  try {
    const store = await Store.open(temp.directory), source = imported(store);
    const run = scan(store, source.id);
    const first = proposal({ key: 'new-rule', format: 'rule_application', structure: { response_format: 'worked steps' }, evidence: 'Explain your reasoning.' });
    const second = proposal({ key: 'rejected-copy', format: 'rule_application', structure: { response_format: 'worked steps' }, evidence: 'Explain your reasoning.' });
    store.finishRun(run.id, analysis(first, second), null);
    const [one, two] = store.items(run.id);
    store.decide(two!.id, 'rejected', run.id);
    store.decide(one!.id, 'accepted', run.id);
    assert.equal(store.items(run.id).find(item => item.id === two!.id)!.decision, 'rejected');
    store.reconcile();
    assert.equal(store.items(run.id).find(item => item.id === two!.id)!.decision, 'rejected');
  } finally { temp.remove(); }
});

test('reconcile repairs automatic associations after restart and is idempotent', async () => {
  const temp = temporary();
  try {
    let store = await Store.open(temp.directory);
    const source = imported(store), core = store.snapshot().patterns.find(pattern => pattern.name === 'Multiple Choice')!;
    const run = scan(store, source.id);
    store.finishRun(run.id, analysis(proposal()), null);
    const resultPath = recordPath(temp.directory, 'analyses', run.id, '.result'), resultBefore = readFileSync(resultPath);
    const reviewPath = recordPath(temp.directory, 'analyses', run.id, '.review'), reviewBefore = readFileSync(reviewPath);

    // Simulate a crash after the review decision was written but before its source link was saved.
    const sourcePath = recordPath(temp.directory, 'sources', source.id), sourceRecord = readRecord(temp.directory, 'sources', source.id);
    sourceRecord.patternIds = [];
    writeFileSync(sourcePath, `${JSON.stringify(sourceRecord, null, 2)}\n`);
    store = await Store.open(temp.directory);
    store.reconcile();
    const repaired = store.snapshot().sources.find(item => item.id === source.id)!;
    assert.deepEqual(repaired.patternIds, [core.id]);
    const patternCount = store.snapshot().patterns.length;
    const versions = store.patternVersions(core.id).length;
    store.reconcile();
    assert.equal(store.snapshot().patterns.length, patternCount);
    assert.equal(store.patternVersions(core.id).length, versions);
    assert.deepEqual(readFileSync(resultPath), resultBefore);
    assert.deepEqual(readFileSync(reviewPath), reviewBefore);
  } finally { temp.remove(); }
});

test('restart recovers an approval saved before its review decision even when matches are ambiguous', async () => {
  const temp = temporary();
  try {
    let store = await Store.open(temp.directory);
    const source = imported(store);
    const content: PatternContent = { name: 'Rule application', format: 'rule_application', structure: { response_format: 'worked steps' }, rule: 'Apply a rule.', reasoning: [] };
    store.savePattern(content, [], true);
    store.savePattern({ ...content, name: 'Another rule application' }, [], true);
    const run = scan(store, source.id);
    store.finishRun(run.id, analysis(proposal({
      key: 'rule-application', ...content, evidence: 'Explain your reasoning.',
    })), null);
    const item = store.items(run.id)[0]!;
    assert.equal(item.decision, 'candidate');

    // Simulate termination after the approved pattern version was written but before .review.
    const approvedId = store.savePattern(patternContent(item.value), [], true, undefined, undefined, { runId: run.id, itemId: item.id });
    store = await Store.open(temp.directory);
    store.reconcile();
    const recovered = store.items(run.id)[0]!;
    assert.equal(recovered.decision, 'accepted');
    assert.equal(recovered.appliedId, approvedId);
    assert.equal(recovered.automatic, undefined, 'recovery preserves the recorded human approval origin');
    assert.ok(store.snapshot().sources.find(item => item.id === source.id)!.patternIds.includes(approvedId));
  } finally { temp.remove(); }
});

test('strict schema validation rejects fabricated evidence, duplicate keys, and extra fields', () => {
  validateAnalysis(analysis(proposal()), sourceText);
  assert.throws(() => validateAnalysis(analysis(proposal({ evidence: 'not in the source' })), sourceText), /exact quote/);
  assert.throws(() => validateAnalysis(analysis(proposal({ support: 'supported', evidence: null })), sourceText), /needs evidence/);
  assert.throws(() => validateAnalysis(analysis(proposal(), proposal()), sourceText), /Duplicate/);
  assert.throws(() => validateAnalysis(analysis(proposal({ similarPatternId: '00000000-0000-4000-8000-000000000002', difference: null })), sourceText), /structural difference/);
  assert.throws(() => validateAnalysis({ ...analysis(), questions: [] }, sourceText), /strict result schema/);
});

test('patternContent keeps only reusable definition fields and compareItems reports field changes', () => {
  const value = proposal({ similarPatternId: '00000000-0000-4000-8000-000000000002', difference: 'Different response type.' });
  const content = patternContent(value);
  assert.deepEqual(Object.keys(content).sort(), ['format', 'name', 'reasoning', 'rule', 'structure']);
  const before = { id: 'item-a', runId: 'run-a', kind: 'pattern' as const, key: 'key', value, decision: 'candidate' as const, appliedId: null };
  const after = { ...before, value: { ...value, rule: 'A changed rule.' } };
  assert.deepEqual(compareItems([before], [after])[0]!.fields, ['rule']);
});

test('pattern edits retain versions and stale approvals do not overwrite them', async () => {
  const temp = temporary();
  try {
    const store = await Store.open(temp.directory);
    const content: PatternContent = { name: 'Rule application', format: 'rule_application', structure: { response_format: 'worked steps' }, rule: 'Apply and explain a rule.', reasoning: ['apply a rule'] };
    const id = store.savePattern(content, [], true);
    const run = scan(store, id, 'pattern');
    store.finishRun(run.id, analysis(proposal({
      key: 'replacement', name: 'Revised rule application', format: 'rule_application',
      structure: { response_format: 'worked steps', citation: 'required' }, rule: 'Apply a rule and cite support.',
      evidence: 'name:\nRule application', existingPatternId: null,
    })), null);
    store.savePattern({ ...content, name: 'Human edit' }, ['manual'], false, id, 1);
    assert.throws(() => store.decide(store.items(run.id)[0]!.id, 'accepted', run.id), /Pattern changed/);
    assert.equal(store.snapshot().patterns.find(pattern => pattern.id === id)?.name, 'Human edit');
    assert.equal(store.patternVersions(id).length, 2);
    assert.match(store.inputText(run), /Rule application/);
    assert.doesNotMatch(store.inputText(run), /Human edit/);
  } finally { temp.remove(); }
});

test('settings and record versions are strict and atomic writes preserve immutable files', async () => {
  const temp = temporary();
  try {
    await Store.open(temp.directory);
    const settings = join(temp.directory, 'settings.json');
    writeFileSync(settings, '{"version":1,"instructions":"keep me","maxTurns":999,"modelSlot":"other","analysisStrength":"strong"}');
    const before = readFileSync(settings);
    await assert.rejects(Store.open(temp.directory), /Settings do not match/);
    assert.deepEqual(readFileSync(settings), before);

    const path = join(temp.directory, 'result.json');
    atomicWrite(path, 'original', true);
    assert.throws(() => atomicWrite(path, 'replacement', true));
    assert.equal(readFileSync(path, 'utf8'), 'original');
    assert.deepEqual(readdirSync(temp.directory).sort(), ['analyses', 'patterns', 'result.json', 'settings.json', 'sources']);
    const blocked = join(temp.directory, 'blocked'); mkdirSync(blocked);
    assert.throws(() => atomicWrite(blocked, 'new value'));
    assert.deepEqual(readdirSync(temp.directory).sort(), ['analyses', 'blocked', 'patterns', 'result.json', 'settings.json', 'sources']);
  } finally { temp.remove(); }
});
