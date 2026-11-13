import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pattern, PatternsSnapshot } from '../src/domain';
import type { SessionPatternExamples } from '../src/example-selection';
import { backend, temporary } from './fixture';

async function clearSession(host: Awaited<ReturnType<typeof backend>>, sessionId: string) {
  const patterns = await host.call<Array<{ id: string; selected: boolean }>>('session-patterns', { sessionId });
  for (const pattern of patterns) if (pattern.selected) {
    await host.call('session-pattern-set', { sessionId, patternId: pattern.id, selected: false });
  }
}

function exampleBank(label: string, forcedCount: number, ordinaryCount: number) {
  return Array.from({ length: forcedCount + ordinaryCount }, (_, index) => ({
    id: randomUUID(),
    text: `${label} example ${index}`,
    forced: index < forcedCount,
  }));
}

async function configurePattern(
  host: Awaited<ReturnType<typeof backend>>,
  pattern: Pattern,
  name: string,
  forcedCount: number,
  ordinaryCount: number,
  exampleLimit: number,
) {
  return host.call<string>('pattern-save', {
    id: pattern.id,
    expectedRevision: pattern.revision,
    content: {
      name,
      format: 'direct_question',
      structure: { response: 'short answer' },
      rule: `Ask with ${name}.`,
      reasoning: ['Check understanding.'],
    },
    tags: [],
    enabled: true,
    examples: exampleBank(name, forcedCount, ordinaryCount),
    exampleLimit,
  });
}

test('session-pattern-context validates reads and isolates empty and selected sessions', async () => {
  const temp = temporary(), host = await backend(temp.directory);
  try {
    await assert.rejects(host.call('session-pattern-context'), /Invalid/);
    await assert.rejects(host.call('session-pattern-context', { sessionId: '' }), /Invalid/);
    await assert.rejects(host.call('session-pattern-context', { sessionId: '  ' }), /Invalid/);
    await assert.rejects(host.call('session-pattern-context', { sessionId: 'valid', extra: true }), /Invalid/);
    await clearSession(host, 'empty-session');
    assert.deepEqual(await host.call('session-pattern-context', { sessionId: 'empty-session' }), []);

    const { patterns } = await host.call<PatternsSnapshot>('patterns-snapshot');
    const patternId = patterns[0]!.id;
    await clearSession(host, 'session-a');
    await host.call('session-pattern-set', { sessionId: 'session-a', patternId, selected: true });

    const selected = await host.call<SessionPatternExamples[]>('session-pattern-context', { sessionId: 'session-a' });
    assert.deepEqual(selected.map(pattern => pattern.id), [patternId]);
    assert.ok(selected[0]!.selected);
    await clearSession(host, 'session-b');
    assert.deepEqual(await host.call('session-pattern-context', { sessionId: 'session-b' }), []);
    assert.deepEqual(await host.call('session-pattern-context', { sessionId: 'empty-session' }), []);
  } finally { await host.dispose(); temp.remove(); }
});

test('overlapping templates produce selected definitions with unique pattern IDs', async () => {
  const temp = temporary(), host = await backend(temp.directory);
  try {
    const { patterns } = await host.call<PatternsSnapshot>('patterns-snapshot');
    const [first, shared, third] = patterns;
    assert.ok(first && shared && third);
    const firstTemplate = await host.call<string>('template-save', {
      name: 'First pair', patternIds: [first.id, shared.id], bypassOverallLimit: false,
    });
    const secondTemplate = await host.call<string>('template-save', {
      name: 'Overlapping pair', patternIds: [shared.id, third.id], bypassOverallLimit: false,
    });
    await clearSession(host, 'overlap');
    await host.call('session-template-apply', { sessionId: 'overlap', templateId: firstTemplate, mode: 'add' });
    await host.call('session-template-apply', { sessionId: 'overlap', templateId: secondTemplate, mode: 'add' });

    const context = await host.call<SessionPatternExamples[]>('session-pattern-context', { sessionId: 'overlap' });
    assert.deepEqual(new Set(context.map(pattern => pattern.id)), new Set([first.id, shared.id, third.id]));
    assert.equal(context.length, 3);
    assert.equal(new Set(context.map(pattern => pattern.id)).size, context.length);
    assert.ok(context.every(pattern => pattern.selected));
  } finally { await host.dispose(); temp.remove(); }
});

test('disabled selected patterns remain in session context while archived patterns are excluded', async () => {
  const temp = temporary(), host = await backend(temp.directory);
  try {
    const { patterns } = await host.call<PatternsSnapshot>('patterns-snapshot');
    const [disabled, archived] = patterns;
    assert.ok(disabled && archived);
    await clearSession(host, 'unavailable');
    await host.call('session-pattern-set', { sessionId: 'unavailable', patternId: disabled.id, selected: true });
    await host.call('session-pattern-set', { sessionId: 'unavailable', patternId: archived.id, selected: true });
    await host.call('pattern-enabled-set', { id: disabled.id, enabled: false });
    await host.call('archive', { kind: 'pattern', id: archived.id, archived: true });

    const context = await host.call<SessionPatternExamples[]>('session-pattern-context', { sessionId: 'unavailable' });
    assert.deepEqual(context.map(pattern => pattern.id), [disabled.id]);
    const remaining = await host.call<Array<{ id: string; selected: boolean }>>('session-patterns', { sessionId: 'unavailable' });
    assert.ok(remaining.some(pattern => pattern.id === disabled.id && pattern.selected));
    assert.ok(!remaining.some(pattern => pattern.id === archived.id));
  } finally { await host.dispose(); temp.remove(); }
});

test('session context shares default sampling, forced/template exemptions, and leaks no config', async () => {
  const temp = temporary(), host = await backend(temp.directory);
  const originalRandom = Math.random;
  try {
    const { patterns } = await host.call<PatternsSnapshot>('patterns-snapshot');
    const [manual, forcedTemplate, sampledTemplate] = patterns;
    assert.ok(manual && forcedTemplate && sampledTemplate);
    await configurePattern(host, manual, 'Manual', 1, 5, 8);
    await configurePattern(host, forcedTemplate, 'Template forced', 3, 4, 1);
    await configurePattern(host, sampledTemplate, 'Template sampled', 0, 5, 2);
    await host.call('example-settings-save', { overallExampleLimit: 2 });
    await clearSession(host, 'sampling');

    const templateA = await host.call<string>('template-save', {
      name: 'Template A', patternIds: [forcedTemplate.id, sampledTemplate.id],
    });
    const templateB = await host.call<string>('template-save', {
      name: 'Template B', patternIds: [sampledTemplate.id],
    });
    await host.call('session-pattern-set', { sessionId: 'sampling', patternId: manual.id, selected: true });
    await host.call('session-template-apply', { sessionId: 'sampling', templateId: templateA, mode: 'add' });
    await host.call('session-template-apply', { sessionId: 'sampling', templateId: templateB, mode: 'add' });

    const [list] = host.nativeTools('teacher', 'sampling');
    assert.ok(list);
    const notifications = host.notifications;
    const eventCount = host.emitted.length;
    const inferenceCount = host.inferenceCalls.length;
    Math.random = () => 0.41;
    const context = await host.call<SessionPatternExamples[]>('session-pattern-context', { sessionId: 'sampling' });
    const nativeResult = await list.execute('default-list', {});

    assert.deepEqual(context, nativeResult.details);
    assert.equal(context.length, 3, 'overlapping templates select each pattern only once');
    const byName = new Map(context.map(pattern => [pattern.name, pattern]));
    assert.equal(byName.get('Manual')?.examples?.length, 2, 'one forced and one globally budgeted example');
    assert.equal(byName.get('Template forced')?.examples?.length, 3, 'forced examples exceed the individual limit');
    assert.equal(byName.get('Template sampled')?.examples?.length, 2, 'template samples bypass only the shared limit');
    for (const pattern of context) {
      assert.deepEqual(Object.keys(pattern).sort(), [
        'examples', 'format', 'id', 'name', 'reasoning', 'revision', 'rule', 'selected', 'structure', 'tags',
      ]);
      assert.ok(pattern.selected);
      assert.ok(pattern.examples?.every(example => typeof example === 'string'));
    }
    assert.equal(host.notifications, notifications, 'reads do not emit events');
    assert.equal(host.emitted.length, eventCount, 'reads do not emit events');
    assert.equal(host.inferenceCalls.length, inferenceCount, 'reads do not call inference');
    assert.equal(inferenceCount, 0);
    const serialized = JSON.stringify(context);
    assert.ok(!serialized.includes('exampleLimit'));
    assert.ok(!serialized.includes('"forced":'));
    assert.ok(!serialized.includes('enabled'));
    assert.ok(!JSON.stringify(context).includes('archived'));
  } finally {
    Math.random = originalRandom;
    await host.dispose(); temp.remove();
  }
});
