import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  PluginFrontendContext,
  PluginSubmission,
  PluginSubmissionContext,
  PluginSubmissionInterceptor,
} from 'learnharness-plugin-api';
import type { SessionPatternExamples } from '../src/example-selection';
import { registerSessionPatternSubmissions } from '../src/session-submissions';
import { SESSION_PATTERN_INSTRUCTIONS } from '../src/session-tools';
import { backend, temporary } from './fixture';
import type { PatternsSnapshot } from '../src/domain';

const START = '<question-patterns-context version="1">';
const END = '</question-patterns-context>';

type Call = { name: string; input: unknown };
type BackendCall = (name: string, input: unknown) => Promise<unknown>;

function harness(call: BackendCall = async () => []) {
  const activation = new AbortController();
  const calls: Call[] = [];
  const cleanups: Array<() => void | Promise<void>> = [];
  let interceptor: PluginSubmissionInterceptor | undefined;
  let unregisterCalls = 0;
  const ctx = {
    signal: activation.signal,
    cleanup: (dispose: () => void | Promise<void>) => cleanups.push(dispose),
    registerSubmissionInterceptor: (definition: PluginSubmissionInterceptor) => {
      interceptor = definition;
      return () => { unregisterCalls++; };
    },
    call: (name: string, input: unknown) => {
      calls.push({ name, input });
      return call(name, input);
    },
  } as unknown as PluginFrontendContext;
  registerSessionPatternSubmissions(ctx);
  assert.ok(interceptor, 'the interceptor is registered');
  return {
    activation,
    calls,
    cleanups,
    interceptor: interceptor!,
    get unregisterCalls() { return unregisterCalls; },
  };
}

function submissionContext(options: {
  sessionId?: string;
  sessionKind?: 'teaching' | 'practice';
  channels?: string[];
  messages?: unknown[];
  signal?: AbortSignal;
  onAccepted?: (callback: () => void | Promise<void>) => void;
} = {}): PluginSubmissionContext {
  return {
    sessionId: options.sessionId ?? 'session-a',
    sessionKind: options.sessionKind ?? 'practice',
    channels: options.channels ?? ['content'],
    messages: options.messages ?? [],
    signal: options.signal ?? new AbortController().signal,
    onAccepted: options.onAccepted ?? (() => {}),
  } as unknown as PluginSubmissionContext;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function content(text: string, images: unknown[] = []) {
  return deepFreeze({ text, images });
}

function examples(id: string, name: string): SessionPatternExamples[] {
  return [{ id, name, examples: [`Example <${name}>&`] }] as unknown as SessionPatternExamples[];
}

function escapedSnapshot(patterns: SessionPatternExamples[]): string {
  return JSON.stringify({ patterns }).replace(/[<>&]/g, char => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' })[char]!);
}

function assertSnapshot(text: string, originalText: string, patterns: SessionPatternExamples[]) {
  const separator = originalText ? '\n\n' : '';
  assert.ok(text.startsWith(`${originalText}${separator}`), 'original text and whitespace are preserved');
  const attachment = text.slice(originalText.length + separator.length);
  assert.ok(attachment.startsWith(`${START}\n`), 'the versioned reference block is appended');
  assert.ok(attachment.endsWith(`\n${END}`), 'the block is closed');
  assert.ok(attachment.includes(escapedSnapshot(patterns)), 'the direct endpoint snapshot is JSON with tag delimiters escaped');
  assert.equal((attachment.match(/<question-patterns-context version="1">/g) ?? []).length, 1);
}

async function intercept(h: ReturnType<typeof harness>, input: unknown, context = submissionContext()) {
  return h.interceptor.intercept(input as PluginSubmission, context) as Promise<PluginSubmission | null | void>;
}

test('registers one interceptor and disposes its unregister callback through cleanup', () => {
  const h = harness();
  assert.equal(h.interceptor.id, 'session-pattern-context');
  assert.equal(h.interceptor.hasPendingInput, undefined, 'reference context never advertises pending learner input');
  assert.equal(h.cleanups.length, 1);
  h.cleanups[0]!();
  assert.equal(h.unregisterCalls, 1);
});

test('text and thinking submissions append escaped snapshots without mutating frozen input', async () => {
  const snapshot = examples('p-1', 'A <&>');
  const h = harness(async () => snapshot);
  let accepted = 0;
  const ctx = submissionContext({ onAccepted: () => { accepted++; } });
  const image = deepFreeze({ type: 'image/png', data: 'learner-image' });
  const imageList = deepFreeze([image]);

  const text = deepFreeze({ type: 'text', content: content('  learner text \n ', imageList) });
  const textResult = await intercept(h, text, ctx) as any;
  assert.ok(textResult.content.text.startsWith(`${text.content.text}\n\n`));
  assertSnapshot(textResult.content.text, text.content.text, snapshot);
  assert.notEqual(textResult.content, text.content);
  assert.equal(textResult.content.images, text.content.images, 'images remain on the content channel');
  assert.equal(textResult.content.images, imageList);

  const thinking = deepFreeze({ type: 'thinking', content: content('\tprivate reasoning  ', [image]) });
  const thinkingResult = await intercept(h, thinking, ctx) as any;
  assertSnapshot(thinkingResult.content.text, thinking.content.text, snapshot);
  assert.equal(thinkingResult.content.images, thinking.content.images);
  assert.equal(text.content.text, '  learner text \n ');
  assert.equal(thinking.content.text, '\tprivate reasoning  ');
  assert.equal(accepted, 0, 'the interceptor does not track acceptance');
  assert.deepEqual(h.calls, [
    { name: 'session-pattern-context', input: { sessionId: 'session-a' } },
    { name: 'session-pattern-context', input: { sessionId: 'session-a' } },
  ]);
});

test('rereads the current session snapshot on every attempt and always emits an empty clear block', async () => {
  const first = examples('same', 'first');
  const second = examples('same', 'second');
  const duplicates = [...examples('duplicate-id', 'one'), ...examples('duplicate-id', 'two')];
  const snapshots = [first, second, [], duplicates];
  let next = 0;
  const h = harness(async () => snapshots[next++]!);
  const attempts = [
    { sessionId: 'session-a', text: 'first attempt' },
    { sessionId: 'session-a', text: 'second attempt' },
    { sessionId: 'session-b', text: '' },
    { sessionId: 'session-a', text: 'backend snapshot' },
  ];

  for (const [index, attempt] of attempts.entries()) {
    const input = deepFreeze({ type: 'text', content: content(attempt.text) });
    const output = await intercept(h, input, submissionContext({ sessionId: attempt.sessionId })) as any;
    assertSnapshot(output.content.text, attempt.text, snapshots[index]!);
    assert.ok(output.content.text.includes(escapedSnapshot(snapshots[index]!)));
    if (index === 2) assert.ok(output.content.text.startsWith(`${START}\n`), 'an empty snapshot still clears earlier context');
  }

  assert.deepEqual(h.calls, attempts.map(({ sessionId }) => ({
    name: 'session-pattern-context', input: { sessionId },
  })));
});

test('routes builtin and plugin question answers only into an allowed reference channel', async () => {
  const cases = [
    { type: 'answer', channels: ['thinking', 'readingThinking'], target: 'thinking' },
    { type: 'answer', channels: ['readingThinking'], target: 'readingThinking' },
    { type: 'plugin-question-answer', channels: ['thinking', 'readingThinking'], target: 'thinking' },
    { type: 'plugin-question-answer', channels: ['readingThinking'], target: 'readingThinking' },
  ] as const;
  const snapshot = examples('answer-context', 'answer');

  for (const item of cases) {
    const h = harness(async () => snapshot);
    const answer = deepFreeze(item.type === 'answer'
      ? { values: ['graded option'], other: 'verbatim', images: [{ data: 'answer image' }] }
      : { response: { optionId: 'generated-option', nested: [1, 'kept'] } });
    const answerImages = deepFreeze([{ data: 'plugin answer image' }]);
    const thinking = content('existing thinking', [{ data: 'thinking image' }]);
    const readingThinking = content('existing reading notes', [{ data: 'reading image' }]);
    const input = deepFreeze(item.type === 'answer'
      ? { type: item.type, answer, thinking, readingThinking }
      : { type: item.type, answer, answerImages, thinking, readingThinking });
    const output = await intercept(h, input, submissionContext({ channels: [...item.channels] })) as any;

    assert.equal(output.answer, input.answer, 'graded or structured answer keeps its exact reference');
    assert.deepEqual(output.answer, answer);
    if (item.type === 'plugin-question-answer') assert.equal(output.answerImages, input.answerImages);
    assertSnapshot(output[item.target].text, input[item.target].text, snapshot);
    assert.equal(output[item.target].images, input[item.target].images);
    const other = item.target === 'thinking' ? 'readingThinking' : 'thinking';
    assert.equal(output[other], input[other], 'the unselected channel is unchanged');
    assert.equal(input.answer, answer);
  }
});

test('plugin-problem submissions use only thinking and never change structured submission data', async () => {
  const snapshot = examples('problem-context', 'problem');
  const h = harness(async () => snapshot);
  const submission = deepFreeze({ response: { steps: ['one', 'two'], score: 4 } });
  const submissionImages = deepFreeze([{ data: 'submitted work image' }]);
  const thinking = content('problem reasoning', [{ data: 'thinking image' }]);
  const input = deepFreeze({ type: 'plugin-problem-submission', submission, submissionImages, thinking });
  const output = await intercept(h, input, submissionContext({ channels: ['submission', 'thinking'] })) as any;

  assert.equal(output.submission, input.submission);
  assert.deepEqual(output.submission, submission);
  assert.equal(output.submissionImages, input.submissionImages);
  assertSnapshot(output.thinking.text, input.thinking.text, snapshot);
  assert.equal(output.thinking.images, input.thinking.images);

  const unsupported = harness();
  const noChange = await intercept(unsupported, input, submissionContext({ channels: ['submission', 'readingThinking'] }));
  assert.equal(noChange, undefined);
  assert.deepEqual(unsupported.calls, []);
});

test('unsupported answer channels are a no-op and do not request a snapshot', async () => {
  const h = harness();
  const answer = deepFreeze({ values: ['unchanged'], images: [] });
  const inputs = [
    { type: 'answer', answer, thinking: content('think'), readingThinking: content('read') },
    { type: 'plugin-question-answer', answer, answerImages: [], thinking: content('think'), readingThinking: content('read') },
  ];
  for (const input of inputs) {
    const result = await intercept(h, deepFreeze(input), submissionContext({ channels: ['answer', 'submission'] }));
    assert.equal(result, undefined);
  }
  assert.deepEqual(h.calls, []);
  assert.deepEqual(answer, { values: ['unchanged'], images: [] });
});

test('teaching waits for successful probe handoff while practice needs no handoff', async () => {
  const h = harness(async () => []);
  const input = deepFreeze({ type: 'text', content: content('next question') });
  const teaching = (messages: unknown[]) => submissionContext({ sessionKind: 'teaching', messages });

  assert.equal(await intercept(h, input, teaching([])), undefined);
  assert.equal(await intercept(h, input, teaching([{ role: 'toolResult', toolName: 'probe_done', isError: true }])), undefined);
  assert.equal(await intercept(h, input, teaching([{ role: 'toolResult', toolName: 'another_tool', isError: false }])), undefined);
  assert.equal(h.calls.length, 0, 'pre-handoff probe submissions do not read pattern context');

  const acceptedProbe = await intercept(h, input, teaching([{ role: 'toolResult', toolName: 'probe_done', isError: false }])) as any;
  assertSnapshot(acceptedProbe.content.text, input.content.text, []);
  const customHandoff = await intercept(h, input, teaching([{ role: 'custom', customType: 'probe-handoff' }])) as any;
  assertSnapshot(customHandoff.content.text, input.content.text, []);
  const practice = await intercept(h, input, submissionContext({ sessionKind: 'practice', messages: [] })) as any;
  assertSnapshot(practice.content.text, input.content.text, []);
  assert.equal(h.calls.length, 3);

  assert.match(SESSION_PATTERN_INSTRUCTIONS, /If the current input has no attached snapshot[\s\S]*call question_patterns_list with its default parameters/,
    'the documented fallback tool covers submissions without an attached snapshot');
});

test('cancellation before and during endpoint reads aborts without returning modified input', async () => {
  const input = deepFreeze({ type: 'text', content: content('still mine') });
  const beforeCases: Array<{ label: string; abort: (h: ReturnType<typeof harness>, signal: AbortController) => void }> = [
    { label: 'activation', abort: h => h.activation.abort() },
    { label: 'submission', abort: (_h, signal) => signal.abort() },
  ];
  for (const { label, abort } of beforeCases) {
    const h = harness();
    const submissionSignal = new AbortController();
    abort(h, submissionSignal);
    await assert.rejects(intercept(h, input, submissionContext({ signal: submissionSignal.signal })), { name: 'AbortError' }, label);
    assert.deepEqual(h.calls, [], `${label} cancellation avoids the endpoint read`);
  }

  for (const cancelActivation of [true, false]) {
    let resolveCall!: (value: unknown) => void;
    const h = harness(() => new Promise(resolve => { resolveCall = resolve; }));
    const submissionSignal = new AbortController();
    const pending = intercept(h, input, submissionContext({ signal: submissionSignal.signal }));
    assert.equal(h.calls.length, 1, 'the endpoint read has started');
    if (cancelActivation) h.activation.abort();
    else submissionSignal.abort();
    resolveCall([]);
    await assert.rejects(pending, { name: 'AbortError' }, cancelActivation ? 'activation aborted while awaiting' : 'submission aborted while awaiting');
    assert.equal(input.content.text, 'still mine');
  }
});

test('automatic attachments use real backend defaults once and reflect later session clears', async () => {
  const temp = temporary(), host = await backend(temp.directory);
  try {
    const { patterns } = await host.call<PatternsSnapshot>('patterns-snapshot');
    const first = patterns[0]!;
    for (const pattern of patterns) await host.call('pattern-enabled-set', { id: pattern.id, enabled: pattern.id === first.id });
    const h = harness((name, input) => host.call(name, input));
    const input = deepFreeze({ type: 'text', content: content('Give me a question.') });
    const context = submissionContext({ sessionId: 'integrated-session' });
    const attached = await intercept(h, input, context) as { content: { text: string } };
    const snapshot = JSON.parse(attached.content.text.split('\n').at(-2)!);
    assert.deepEqual(snapshot.patterns.map((pattern: { id: string }) => pattern.id), [first.id]);
    assert.ok(snapshot.patterns[0].examples.length > 0, 'the attachment includes sampled references');
    await host.call('session-pattern-set', { sessionId: 'integrated-session', patternId: first.id, selected: false });
    const cleared = await intercept(h, input, context) as { content: { text: string } };
    assertSnapshot(cleared.content.text, input.content.text, []);
    assert.ok((await host.call<any[]>('session-pattern-context', { sessionId: 'another-session' })).some(pattern => pattern.id === first.id), 'another session still receives the defaults');
  } finally { await host.dispose(); temp.remove(); }
});

test('backend errors reject unchanged and the interceptor never acknowledges acceptance', async () => {
  const failure = new Error('session-pattern-context unavailable');
  const h = harness(async () => { throw failure; });
  let accepted = 0;
  const input = deepFreeze({
    type: 'answer',
    answer: { values: ['graded'], images: [] },
    thinking: content(''),
    readingThinking: content(''),
  });
  const context = submissionContext({
    channels: ['thinking'],
    onAccepted: () => { accepted++; },
  });

  await assert.rejects(intercept(h, input, context), error => error === failure);
  assert.equal(input.answer.values[0], 'graded');
  assert.equal(input.thinking.text, '');
  assert.equal(accepted, 0);
  assert.equal(h.interceptor.hasPendingInput, undefined);
  assert.deepEqual(h.calls, [{ name: 'session-pattern-context', input: { sessionId: 'session-a' } }]);
});
