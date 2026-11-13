import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { PluginFrontendContext } from 'learnharness-plugin-api';
import type { PatternTemplate, SessionPattern, TemplateExampleSummary } from '../src/domain';

type Favorite = { kind: 'pattern' | 'template'; id: string };

function pattern(id: string, selected = false): SessionPattern {
  return {
    id,
    name: `Pattern ${id}`,
    format: 'direct_question',
    structure: {},
    rule: `Use ${id} when it fits.`,
    reasoning: ['Compare the question with the rule.'],
    tags: [],
    revision: 1,
    selected,
  };
}

function createHarness(options: {
  loadFailures?: number;
  writeFailures?: number;
  writeFailureCalls?: number[];
  templateLoadFailures?: number;
  templateApplyFailures?: number;
  templateApplyDelay?: number;
  favoriteLoadFailures?: number;
  favoriteSetFailures?: number;
  favoriteSetFailureCalls?: number[];
  sessionPatternReadHook?: (readNumber: number) => Promise<void>;
  favoriteSnapshotHook?: (readNumber: number) => Promise<void>;
  patterns?: SessionPattern[];
  templates?: PatternTemplate[];
  templateExampleSummaries?: TemplateExampleSummary[];
  overallExampleLimit?: number;
} = {}) {
  const dom = new JSDOM('<body></body>', { url: 'http://localhost/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement });
  const controller = new AbortController();
  const actions = new Map<string, any>();
  const placements: any[] = [];
  const calls: Array<{ name: string; input: any }> = [];
  const notifications = new Set<(event: any) => void>();
  const resync = new Set<() => void>();
  const sessions = new Map<string, SessionPattern[]>();
  const initial = options.patterns ?? [pattern('a'), pattern('b')];
  const templates = options.templates ?? [{
    id: 'starter', name: 'Starter template', patternIds: ['a'], revision: 1, updatedAt: '2025-01-01T00:00:00.000Z',
  }];
  const favorites = new Map<string, Favorite>();
  let loadFailures = options.loadFailures ?? 0;
  let writeFailures = options.writeFailures ?? 0;
  let templateLoadFailures = options.templateLoadFailures ?? 0;
  let templateApplyFailures = options.templateApplyFailures ?? 0;
  let favoriteLoadFailures = options.favoriteLoadFailures ?? 0;
  let favoriteSetFailures = options.favoriteSetFailures ?? 0;
  let dialogs = 0;
  const buttonErrors: unknown[] = [];

  const favoriteSnapshot = () => ({ favorites: structuredClone([...favorites.values()]) });
  const ctx = {
    signal: controller.signal,
    ui: {
      mountButton(container: HTMLElement, initial: any, widgetOptions: { signal: AbortSignal }) {
        let current = initial;
        let disposed = false;
        const button = document.createElement('button');
        button.type = 'button';
        const render = () => {
          if (disposed) return;
          button.textContent = current.label;
          button.disabled = !!current.disabled;
          button.onclick = () => {
            if (disposed || button.disabled) return;
            void Promise.resolve().then(() => current.onClick()).catch(error => buttonErrors.push(error));
          };
        };
        const dispose = () => {
          if (disposed) return;
          disposed = true;
          button.remove();
          widgetOptions.signal.removeEventListener('abort', dispose);
        };
        widgetOptions.signal.addEventListener('abort', dispose, { once: true });
        render();
        container.append(button);
        return {
          update(next: any) { if (!disposed) { current = { ...current, ...next }; render(); } },
          dispose,
        };
      },
      // The host provides the dialog shell; controls inside it are plugin-owned.
      openDialog(props: any, widgetOptions: { signal: AbortSignal }) {
        const node = document.createElement('section');
        node.setAttribute('role', 'dialog');
        node.setAttribute('aria-label', props.title);
        document.body.append(node);
        const contentScope = new AbortController();
        const cleanup = props.content(node, contentScope.signal);
        dialogs++;
        let disposed = false;
        const dispose = () => {
          if (disposed) return;
          disposed = true;
          dialogs--;
          widgetOptions.signal.removeEventListener('abort', dispose);
          contentScope.abort();
          cleanup?.();
          props.onClose?.();
          node.remove();
        };
        widgetOptions.signal.addEventListener('abort', dispose, { once: true });
        return { update() {}, dispose };
      },
    },
    registerView: () => () => {},
    registerAction(action: any) { actions.set(action.id, action); return () => actions.delete(action.id); },
    placeAction(placement: any) { placements.push(placement); return () => {}; },
    registerSettings: () => () => {},
    registerSubmissionInterceptor: () => () => {},
    cleanup: () => {},
    call: async (name: string, input: any) => {
      calls.push({ name, input });
      if (name === 'session-patterns') {
        const readNumber = calls.filter(call => call.name === 'session-patterns').length;
        await options.sessionPatternReadHook?.(readNumber);
        if (loadFailures > 0) { loadFailures--; throw new Error('temporary read failure'); }
        return structuredClone(sessions.get(input.sessionId) ?? initial);
      }
      if (name === 'session-pattern-set') {
        const writeNumber = calls.filter(call => call.name === 'session-pattern-set').length;
        if (options.writeFailureCalls?.includes(writeNumber)) throw new Error('temporary write failure');
        if (writeFailures > 0) { writeFailures--; throw new Error('temporary write failure'); }
        const current = structuredClone(sessions.get(input.sessionId) ?? initial);
        const found = current.find(item => item.id === input.patternId);
        assert.ok(found, `Unknown session pattern ${input.patternId}`);
        found.selected = input.selected;
        sessions.set(input.sessionId, current);
        return structuredClone(current);
      }
      if (name === 'templates-snapshot') {
        if (templateLoadFailures > 0) { templateLoadFailures--; throw new Error('temporary templates failure'); }
        return {
          templates: structuredClone(templates),
          ...(options.templateExampleSummaries ? { exampleSummaries: structuredClone(options.templateExampleSummaries) } : {}),
          ...(options.overallExampleLimit !== undefined ? { overallExampleLimit: options.overallExampleLimit } : {}),
        };
      }
      if (name === 'session-template-apply') {
        if (templateApplyFailures > 0) { templateApplyFailures--; throw new Error('temporary apply failure'); }
        if (options.templateApplyDelay) await new Promise(resolve => setTimeout(resolve, options.templateApplyDelay));
        const current = structuredClone(sessions.get(input.sessionId) ?? initial);
        const template = templates.find(item => item.id === input.templateId);
        assert.ok(template, `Unknown template ${input.templateId}`);
        const availableIds = new Set(template.patternIds.filter(id => current.some(item => item.id === id)));
        for (const item of current) {
          if (input.mode === 'replace') item.selected = availableIds.has(item.id);
          else if (availableIds.has(item.id)) item.selected = input.mode === 'add';
        }
        sessions.set(input.sessionId, current);
        return structuredClone(current);
      }
      if (name === 'favorites-snapshot') {
        assert.deepEqual(input, {}, 'favorites-snapshot receives an empty payload');
        const readNumber = calls.filter(call => call.name === 'favorites-snapshot').length;
        await options.favoriteSnapshotHook?.(readNumber);
        if (favoriteLoadFailures > 0) { favoriteLoadFailures--; throw new Error('temporary favorites failure'); }
        return favoriteSnapshot();
      }
      if (name === 'favorite-set') {
        const favoriteCall = calls.filter(call => call.name === 'favorite-set').length;
        if (options.favoriteSetFailureCalls?.includes(favoriteCall)) throw new Error('temporary favorite failure');
        if (favoriteSetFailures > 0) { favoriteSetFailures--; throw new Error('temporary favorite failure'); }
        const key = `${input.kind}:${input.id}`;
        if (input.favorite) favorites.set(key, { kind: input.kind, id: input.id });
        else favorites.delete(key);
        return favoriteSnapshot();
      }
      throw new Error(`Unexpected operation: ${name}`);
    },
    onNotification(listener: (event: any) => void) { notifications.add(listener); return () => notifications.delete(listener); },
    onResync(listener: () => void) { resync.add(listener); return () => resync.delete(listener); },
    app: { openView() {} },
  } as unknown as PluginFrontendContext;

  return {
    dom, ctx, controller, actions, placements, calls, notifications, resync, sessions, favorites, buttonErrors,
    counts: () => ({ dialogs }),
    notify(topic: string, data?: unknown) { for (const listener of [...notifications]) listener({ topic, data }); },
    resyncNow() { for (const listener of [...resync]) listener(); },
    dispose() { controller.abort(); dom.window.close(); },
  };
}

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.fail('Timed out waiting for session picker state');
}

function patternRows(id: string, root: ParentNode = document) {
  return [...root.querySelectorAll<HTMLElement>(`.qp-session-pattern[data-pattern-id="${id}"]`)];
}

function patternSwitches(id: string, root: ParentNode = document) {
  return patternRows(id, root).map(row => {
    const control = row.querySelector<HTMLButtonElement>('button[role="switch"]');
    assert.ok(control, `Missing native switch for ${id}`);
    return control;
  });
}

function patternSwitch(id: string, root: ParentNode = document) {
  const controls = patternSwitches(id, root);
  assert.equal(controls.length, 1, `Expected one visible switch for pattern ${id}, found ${controls.length}`);
  return controls[0]!;
}

function templateRow(name: string) {
  const row = [...document.querySelectorAll<HTMLElement>('.qp-session-template.qp-pattern-record')]
    .find(item => item.querySelector('h3')?.textContent === name);
  assert.ok(row, `Missing template row for ${name}`);
  return row;
}

function templateSwitch(name: string) {
  const control = templateRow(name).querySelector<HTMLButtonElement>('.qp-pattern-toggle > button.qp-enabled-switch[role="switch"]');
  assert.ok(control, `Missing shared template switch for ${name}`);
  return control;
}

function templateExpandButton(name: string) {
  const button = [...templateRow(name).querySelectorAll<HTMLButtonElement>('button[aria-expanded]')][0];
  assert.ok(button, `Missing expand-members control for ${name}`);
  return button;
}

function favoriteButton(name: string, favorite = false) {
  const expectedLabel = `${favorite ? 'Unfavorite' : 'Favorite'} ${name}`;
  const button = document.querySelector<HTMLButtonElement>(`button.qp-favorite[aria-label="${expectedLabel}"]`);
  assert.ok(button, `Missing favorite control labelled ${expectedLabel}`);
  return button;
}

function alertsText() {
  return [...document.querySelectorAll('[role="alert"]')].map(alert => alert.textContent).join(' ');
}

function buttonByText(text: string, root: ParentNode = document) {
  const button = [...root.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === text);
  assert.ok(button, `Missing button ${text}`);
  return button;
}

function openSession(harness: ReturnType<typeof createHarness>, sessionId: string, kind: 'teaching' | 'practice' = 'teaching') {
  const action = harness.actions.get('session-patterns');
  assert.ok(action);
  return action.run({ surface: 'session', kind, sessionId, placement: 'top-bar' });
}

function closePicker() {
  buttonByText('Close').click();
}

function clickPattern(id: string, root: ParentNode = document) {
  patternSwitch(id, root).click();
}

function clickTemplate(name: string) {
  templateSwitch(name).click();
}

test('unified session modal uses shared boolean switches and omits template members as standalone rows', async () => {
  const harness = createHarness({
    patterns: [pattern('a'), pattern('b'), pattern('c')],
    templates: [{ id: 'starter', name: 'Starter template', patternIds: ['a', 'b', 'missing'], revision: 1, updatedAt: '2025-01-01T00:00:00.000Z' }],
  });
  try {
    const { activate } = await import('../src/main');
    activate(harness.ctx);
    assert.deepEqual(harness.placements.find(item => item.actionId === 'session-patterns'), {
      id: 'session-patterns-top-bar', actionId: 'session-patterns', location: 'top-bar', sessions: ['teaching', 'practice'],
    });
    await harness.actions.get('session-patterns').run({ surface: 'app', pathname: '/', placement: 'top-bar' });
    assert.equal(harness.counts().dialogs, 0, 'the action ignores non-session contexts');

    await openSession(harness, 'lesson-one', 'practice');
    await waitFor(() => !!document.querySelector('input[type="search"][aria-label="Search patterns and templates"]')
      && !!document.querySelector('.qp-session-template h3')
      && patternRows('c').length === 1);

    const search = document.querySelector<HTMLInputElement>('input[type="search"][aria-label="Search patterns and templates"]');
    assert.ok(search, 'the unified modal has one labelled search field');
    assert.equal(document.querySelector('[role="tablist"]'), null);
    assert.equal(document.querySelector('[role="tab"]'), null);
    assert.equal(document.body.textContent?.includes('patterns selected for this session'), false, 'the modal omits the old selection count');
    assert.equal(document.body.textContent?.includes('library-wide enabled state'), false, 'the modal omits the old help copy');
    assert.equal(document.body.textContent?.includes('Disabled, archived, or missing template patterns are excluded'), false);

    const favoritesFilter = buttonByText('Favorites');
    assert.equal(favoritesFilter.getAttribute('aria-pressed'), 'false');
    const row = templateRow('Starter template');
    assert.equal(row.querySelector('h3')?.tagName, 'H3');
    assert.ok(row.textContent?.includes('2 of 3 patterns available'));
    assert.equal(row.querySelector('.qp-template-card-preview')?.textContent, 'Pattern a · Pattern b');
    assert.equal(row.querySelector('.qp-template-card-preview img'), null);
    assert.equal(templateSwitch('Starter template').getAttribute('aria-checked'), 'false');
    assert.equal(templateSwitch('Starter template').parentElement?.className, 'qp-pattern-toggle');
    assert.equal(templateSwitch('Starter template').classList.contains('qp-enabled-switch'), true);
    assert.equal(document.querySelector('input[type="checkbox"]'), null, 'template selection uses no checkbox controls');
    assert.equal(document.querySelector('.qp-template-selection'), null, 'the obsolete checkbox wrapper is not rendered');
    assert.equal(patternRows('a').length, 0, 'members do not appear as standalone rows');
    assert.equal(patternRows('b').length, 0, 'every template member is omitted from the standalone list');
    assert.equal(patternRows('c').length, 1, 'patterns outside all templates remain standalone');
    assert.equal(patternSwitch('c').tagName, 'BUTTON');
    assert.equal(patternSwitch('c').getAttribute('role'), 'switch');
    assert.equal(patternSwitch('c').parentElement?.className, 'qp-pattern-toggle');
    assert.equal(patternSwitch('c').getAttribute('aria-checked'), 'false');

    const expansion = templateExpandButton('Starter template');
    assert.equal(expansion.getAttribute('aria-expanded'), 'false');
    expansion.click();
    assert.equal(expansion.getAttribute('aria-expanded'), 'true');
    const members = row.querySelector('.qp-session-members');
    assert.ok(members, 'expanded template members have a dedicated container');
    assert.equal(patternRows('a', members).length, 1);
    assert.equal(patternRows('b', members).length, 1);
    assert.equal(patternRows('a').length, 1, 'a template member is rendered exactly once, inside its template');
    assert.equal(patternSwitch('a', members).getAttribute('aria-checked'), 'false');

    assert.deepEqual(harness.calls.find(call => call.name === 'session-patterns')?.input, { sessionId: 'lesson-one' });
    assert.ok(harness.calls.some(call => call.name === 'favorites-snapshot' && JSON.stringify(call.input) === '{}'));
    const current = harness.sessions.get('lesson-one') ?? [pattern('a'), pattern('b'), pattern('c')];
    current.find(item => item.id === 'c')!.selected = true;
    harness.sessions.set('lesson-one', current);
    const readsBefore = harness.calls.filter(call => call.name === 'session-patterns').length;
    harness.notify('session-patterns-changed', { sessionId: 'different-session' });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(harness.calls.filter(call => call.name === 'session-patterns').length, readsBefore);
    harness.notify('session-patterns-changed', { sessionId: 'lesson-one' });
    await waitFor(() => patternSwitch('c').getAttribute('aria-checked') === 'true');
    harness.notify('library-changed');
    await waitFor(() => harness.calls.filter(call => call.name === 'session-patterns').length === readsBefore + 2
      && harness.calls.filter(call => call.name === 'templates-snapshot').length === 2);
    harness.resyncNow();
    await waitFor(() => harness.calls.filter(call => call.name === 'session-patterns').length === readsBefore + 3);

    closePicker();
    await waitFor(() => harness.counts().dialogs === 0);
    assert.equal(harness.notifications.size, 0);
    assert.equal(harness.resync.size, 0);
    assert.equal(harness.counts().dialogs, 0);

    await openSession(harness, 'lesson-two');
    await waitFor(() => patternRows('c').length === 1);
    assert.equal(patternSwitch('c').getAttribute('aria-checked'), 'false', 'a different session has independent selections');
    await openSession(harness, 'lesson-one');
    await waitFor(() => patternRows('c').length === 1 && patternSwitch('c').getAttribute('aria-checked') === 'true');
    assert.equal(harness.counts().dialogs, 1, 'reopening replaces rather than duplicates the modal');
    assert.equal(harness.notifications.size, 1, 'reopening releases the previous notification subscription');
    closePicker();
  } finally {
    harness.dispose();
  }
});

test('template switches atomically add and remove members; expanded details preserve replace and example-limit information', async () => {
  const harness = createHarness({
    patterns: [pattern('a'), pattern('b'), pattern('c')],
    templates: [
      { id: 'starter', name: 'Starter set', patternIds: ['a', 'c', 'missing'], revision: 1, updatedAt: '2025-01-01T00:00:00.000Z' },
      { id: 'bounded', name: 'Bounded set', patternIds: ['b'], bypassOverallLimit: false, revision: 1, updatedAt: '2025-01-01T00:00:00.000Z' },
    ],
    templateExampleSummaries: [
      { id: 'starter', totalExamples: 9, availableExamples: 4, forcedExamples: 2, expectedExamples: 8, perPatternLimited: true, exceedsOverallLimit: true },
      { id: 'bounded', totalExamples: 7, availableExamples: 5, forcedExamples: 5, expectedExamples: 8, perPatternLimited: true, exceedsOverallLimit: true },
    ],
    overallExampleLimit: 4,
  });
  try {
    const { activate } = await import('../src/main');
    activate(harness.ctx);
    await openSession(harness, 'template-operations');
    await waitFor(() => document.querySelectorAll('.qp-session-template').length === 2);

    const starter = templateRow('Starter set');
    assert.ok(starter.textContent?.includes('2 of 3 patterns available'));
    assert.equal(starter.querySelector('.qp-template-card-preview')?.textContent, 'Pattern a · Pattern c');
    const expand = templateExpandButton('Starter set');
    expand.click();
    assert.equal(starter.querySelector('.qp-meta')?.textContent, '9 saved examples · 8 expected from eligible patterns');
    assert.deepEqual([...starter.querySelectorAll('.qp-template-limit')].map(item => item.textContent), [
      'Per-pattern sample limit applies.',
      'Overall limit exceeded; template override on.',
    ]);
    assert.ok(buttonByText('Use only these', starter), 'replace remains available in expanded template details');

    clickTemplate('Starter set');
    await waitFor(() => harness.sessions.get('template-operations')?.filter(item => item.selected).map(item => item.id).join(',') === 'a,c');
    assert.equal(templateSwitch('Starter set').getAttribute('aria-checked'), 'true');
    assert.deepEqual(harness.calls.filter(call => call.name === 'session-template-apply').at(-1)?.input, {
      sessionId: 'template-operations', templateId: 'starter', mode: 'add',
    });

    clickTemplate('Starter set');
    await waitFor(() => harness.sessions.get('template-operations')?.every(item => !item.selected) === true);
    assert.equal(templateSwitch('Starter set').getAttribute('aria-checked'), 'false');
    assert.deepEqual(harness.calls.filter(call => call.name === 'session-template-apply').at(-1)?.input, {
      sessionId: 'template-operations', templateId: 'starter', mode: 'remove',
    });

    const bounded = templateRow('Bounded set');
    templateExpandButton('Bounded set').click();
    clickPattern('b', bounded);
    await waitFor(() => harness.sessions.get('template-operations')?.find(item => item.id === 'b')?.selected === true);
    buttonByText('Use only these', starter).click();
    await waitFor(() => harness.sessions.get('template-operations')?.find(item => item.id === 'b')?.selected === false
      && harness.sessions.get('template-operations')?.find(item => item.id === 'a')?.selected === true);
    assert.deepEqual(harness.calls.filter(call => call.name === 'session-template-apply').map(call => call.input.mode), ['add', 'remove', 'replace']);
    assert.equal(harness.sessions.get('template-operations')?.find(item => item.id === 'c')?.selected, true);

    assert.equal(bounded.querySelector('.qp-meta')?.textContent, '7 saved examples · 5 expected from eligible patterns');
    assert.deepEqual([...bounded.querySelectorAll('.qp-template-limit')].map(item => item.textContent), [
      'Per-pattern sample limit applies.',
      'Overall limit exceeded; random examples are trimmed, but forced examples remain.',
    ]);
  } finally {
    harness.dispose();
  }
});

test('partially selected template uses boolean false semantics and clicking selects all eligible patterns', async () => {
  const harness = createHarness({
    patterns: [pattern('a', true), pattern('b'), pattern('c')],
    templates: [{ id: 'mixed', name: 'Mixed set', patternIds: ['a', 'b'], revision: 1, updatedAt: '2025-01-01T00:00:00.000Z' }],
  });
  try {
    const { activate } = await import('../src/main');
    activate(harness.ctx);
    await openSession(harness, 'partial-template');
    await waitFor(() => !!document.querySelector('.qp-session-template') && !templateSwitch('Mixed set').disabled);

    const toggle = templateSwitch('Mixed set');
    assert.equal(toggle.getAttribute('aria-checked'), 'false', 'a partial switch exposes its boolean value as false');
    assert.notEqual(toggle.getAttribute('aria-checked'), 'mixed', 'partial state is not exposed as a mixed ARIA value');
    assert.equal(templateRow('Mixed set').querySelector('.qp-session-availability')?.textContent,
      '2 of 2 patterns available · Partially selected', 'partial selection remains visibly explained');
    assert.equal(toggle.title, 'Select all available patterns in Mixed set');

    clickTemplate('Mixed set');
    await waitFor(() => harness.sessions.get('partial-template')?.filter(item => item.selected).map(item => item.id).join(',') === 'a,b');
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
    assert.deepEqual(harness.calls.filter(call => call.name === 'session-template-apply').map(call => call.input.mode), ['add'],
      'clicking a boolean-false partial switch atomically adds all eligible members');
  } finally {
    harness.dispose();
  }
});

test('shared template members synchronize one pattern write and search matches names, rules, and template names', async () => {
  const a = pattern('a');
  a.name = 'Socratic prompt';
  a.rule = 'Ask one probing question before giving an explanation.';
  const b = pattern('b');
  b.name = 'Evidence ladder';
  b.rule = 'Require a quote from the source before making a claim.';
  const c = pattern('c');
  c.name = 'Counterexample check';
  c.rule = 'Test the claim with a counterexample.';
  const harness = createHarness({
    patterns: [a, b, c],
    templates: [
      { id: 'reasoning', name: 'Reasoning bundle', patternIds: ['a', 'b'], revision: 1, updatedAt: '2025-01-01T00:00:00.000Z' },
      { id: 'shared', name: 'Shared prompt bundle', patternIds: ['a'], revision: 1, updatedAt: '2025-01-01T00:00:00.000Z' },
    ],
  });
  try {
    const { activate } = await import('../src/main');
    activate(harness.ctx);
    await openSession(harness, 'search-session');
    await waitFor(() => document.querySelectorAll('.qp-session-template').length === 2 && patternRows('c').length === 1);

    assert.equal(patternRows('a').length, 0, 'shared template members are not duplicated as standalone rows');
    const search = document.querySelector<HTMLInputElement>('input[type="search"][aria-label="Search patterns and templates"]')!;
    search.value = 'Socratic prompt';
    search.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
    await waitFor(() => templateExpandButton('Reasoning bundle').getAttribute('aria-expanded') === 'true'
      && patternRows('a', templateRow('Reasoning bundle')).length === 1);
    assert.equal(patternRows('a').length, 2, 'a shared member appears once in each matching template, never in the standalone list');

    search.value = 'probing question';
    search.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
    await waitFor(() => templateExpandButton('Reasoning bundle').getAttribute('aria-expanded') === 'true'
      && !!templateRow('Reasoning bundle').querySelector('.qp-session-members .qp-session-pattern[data-pattern-id="a"]'));

    search.value = 'Evidence ladder';
    search.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
    await waitFor(() => !!templateRow('Reasoning bundle').querySelector('.qp-session-members .qp-session-pattern[data-pattern-id="b"]'));
    assert.equal(patternRows('b').length, 1, 'searching a member name reveals it inside its template');

    search.value = 'counterexample';
    search.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
    await waitFor(() => patternRows('c').length === 1);
    assert.equal(patternSwitch('c').closest('.qp-session-pattern')?.getAttribute('data-pattern-id'), 'c', 'standalone rules are searchable');

    search.value = 'Shared prompt bundle';
    search.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
    await waitFor(() => document.querySelectorAll('.qp-session-template').length === 1);
    assert.equal(templateRow('Shared prompt bundle').querySelector('h3')?.textContent, 'Shared prompt bundle', 'template names are searchable');
    templateExpandButton('Shared prompt bundle').click();
    const sharedSwitches = patternSwitches('a');
    assert.equal(sharedSwitches.length, 1, 'filtered template search leaves one member control visible');
    sharedSwitches[0]!.click();
    await waitFor(() => harness.sessions.get('search-session')?.find(item => item.id === 'a')?.selected === true);
    assert.equal(harness.calls.filter(call => call.name === 'session-pattern-set' && call.input.patternId === 'a').length, 1,
      'a shared pattern selection is persisted once, not once per template');

    search.value = '';
    search.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
    await waitFor(() => document.querySelectorAll('.qp-session-template').length === 2);
    for (const name of ['Reasoning bundle', 'Shared prompt bundle']) {
      const expand = templateExpandButton(name);
      if (expand.getAttribute('aria-expanded') !== 'true') expand.click();
    }
    assert.deepEqual(patternSwitches('a').map(control => control.getAttribute('aria-checked')), ['true', 'true'],
      'all references to the shared member reflect its single saved selection');
  } finally {
    harness.dispose();
  }
});

test('favorites persist across modal reopen, remain kind-scoped, and do not share session selections', async () => {
  const shared = pattern('same');
  shared.name = 'Shared member';
  const harness = createHarness({
    patterns: [shared, pattern('other')],
    templates: [{ id: 'same', name: 'Shared template', patternIds: ['same'], revision: 1, updatedAt: '2025-01-01T00:00:00.000Z' }],
  });
  try {
    const { activate } = await import('../src/main');
    activate(harness.ctx);
    await openSession(harness, 'favorite-session-one');
    await waitFor(() => !!document.querySelector('.qp-session-template h3') && patternRows('other').length === 1);
    templateExpandButton('Shared template').click();

    favoriteButton('Shared member').click();
    await waitFor(() => harness.favorites.has('pattern:same'));
    favoriteButton('Shared template').click();
    await waitFor(() => harness.favorites.has('template:same'));
    assert.deepEqual(harness.calls.filter(call => call.name === 'favorite-set').map(call => call.input), [
      { kind: 'pattern', id: 'same', favorite: true },
      { kind: 'template', id: 'same', favorite: true },
    ], 'the same identifier can be favorited independently by kind');
    assert.deepEqual(harness.calls.find(call => call.name === 'favorites-snapshot')?.input, {});

    const filter = buttonByText('Favorites');
    filter.click();
    assert.equal(filter.getAttribute('aria-pressed'), 'true');
    await waitFor(() => document.querySelectorAll('.qp-session-template').length === 1);
    assert.equal(templateRow('Shared template').querySelector('h3')?.textContent, 'Shared template');
    assert.equal(patternSwitches('same').length, 1, 'the favorited pattern remains available in the favorited template');

    closePicker();
    await openSession(harness, 'favorite-session-one');
    await waitFor(() => !!document.querySelector('.qp-session-template h3'));
    templateExpandButton('Shared template').click();
    assert.equal(harness.calls.filter(call => call.name === 'favorites-snapshot').length, 2, 'reopening reloads the persisted favorite snapshot');
    assert.equal(favoriteButton('Shared member', true).getAttribute('aria-pressed'), 'true');
    assert.equal(favoriteButton('Shared template', true).getAttribute('aria-pressed'), 'true');
    assert.equal(templateSwitch('Shared template').getAttribute('aria-checked'), 'false', 'favoriting does not select a template for the session');

    clickTemplate('Shared template');
    await waitFor(() => harness.sessions.get('favorite-session-one')?.find(item => item.id === 'same')?.selected === true);
    await openSession(harness, 'favorite-session-two');
    await waitFor(() => !!document.querySelector('.qp-session-template h3'));
    assert.equal(templateSwitch('Shared template').getAttribute('aria-checked'), 'false', 'template selection remains isolated to the original session');
    assert.equal(favoriteButton('Shared template', true).getAttribute('aria-pressed'), 'true', 'favorites are intentionally global across sessions');
  } finally {
    harness.dispose();
  }
});

test('favorite write failure stays inline and leaves the persisted favorite unchanged', async () => {
  const harness = createHarness({ favoriteSetFailures: 1 });
  try {
    const { activate } = await import('../src/main');
    activate(harness.ctx);
    await openSession(harness, 'favorite-failure');
    await waitFor(() => patternRows('b').length === 1);

    favoriteButton('Pattern b').click();
    await waitFor(() => alertsText().includes('temporary favorite failure'));
    assert.equal(harness.favorites.has('pattern:b'), false);
    assert.equal(favoriteButton('Pattern b').getAttribute('aria-pressed'), 'false');
    assert.equal(favoriteButton('Pattern b').getAttribute('aria-label'), 'Favorite Pattern b');

    favoriteButton('Pattern b').click();
    await waitFor(() => harness.favorites.has('pattern:b'));
    assert.equal(favoriteButton('Pattern b', true).getAttribute('aria-pressed'), 'true');
  } finally {
    harness.dispose();
  }
});

test('favorites loading and failed snapshots do not show an empty state and can be retried', async () => {
  let releaseFirstRead!: () => void;
  let signalFirstReadStarted!: () => void;
  const firstReadGate = new Promise<void>(resolve => { releaseFirstRead = resolve; });
  const firstReadStarted = new Promise<void>(resolve => { signalFirstReadStarted = resolve; });
  const harness = createHarness({
    favoriteLoadFailures: 1,
    favoriteSnapshotHook: async readNumber => {
      if (readNumber === 1) {
        signalFirstReadStarted();
        await firstReadGate;
      }
    },
  });
  try {
    const { activate } = await import('../src/main');
    activate(harness.ctx);
    await openSession(harness, 'favorites-loading');
    await waitFor(() => patternRows('b').length === 1 && !!document.querySelector('.qp-session-template h3'));
    await firstReadStarted;

    const filter = buttonByText('Favorites');
    filter.click();
    const status = document.querySelector<HTMLElement>('.qp-session-patterns > p.qp-meta[role="status"]');
    assert.equal(filter.getAttribute('aria-pressed'), 'true');
    assert.equal(status?.textContent, 'Loading favorites…');
    assert.equal(document.querySelector('.qp-session-patterns > .qp-muted')?.textContent, '');

    releaseFirstRead();
    await waitFor(() => alertsText().includes('temporary favorites failure'));
    assert.equal(document.querySelector('.qp-session-patterns > .qp-muted')?.textContent, '',
      'a failed favorite snapshot is not reported as an empty favorites list');
    assert.equal(document.body.textContent?.includes('No favorites yet.'), false);
    buttonByText('Retry loading favorites').click();
    await waitFor(() => harness.calls.filter(call => call.name === 'favorites-snapshot').length === 2
      && document.querySelector('.qp-session-patterns > .qp-muted')?.textContent === 'No favorites yet. Star a pattern or template to keep it here.');
  } finally {
    releaseFirstRead();
    harness.dispose();
  }
});

test('failed selection and template writes recover from a stale notification read', async () => {
  for (const operation of ['pattern', 'template'] as const) {
    let releaseNotificationRead!: () => void;
    let signalNotificationReadStarted!: () => void;
    const notificationReadGate = new Promise<void>(resolve => { releaseNotificationRead = resolve; });
    const notificationReadStarted = new Promise<void>(resolve => { signalNotificationReadStarted = resolve; });
    const failureText = operation === 'pattern' ? 'temporary write failure' : 'temporary apply failure';
    const harness = createHarness({
      ...(operation === 'pattern' ? { writeFailures: 1 } : { templateApplyFailures: 1 }),
      sessionPatternReadHook: async readNumber => {
        if (readNumber === 2) {
          signalNotificationReadStarted();
          await notificationReadGate;
        }
      },
    });
    const sessionId = `stale-notification-${operation}`;
    try {
      const { activate } = await import('../src/main');
      activate(harness.ctx);
      await openSession(harness, sessionId);
      await waitFor(() => patternRows('b').length === 1 && !!document.querySelector('.qp-session-template h3'));
      const starter = templateRow('Starter template');
      templateExpandButton('Starter template').click();
      assert.equal(patternSwitch('a', starter).getAttribute('aria-checked'), 'false');

      const authoritative = structuredClone(harness.sessions.get(sessionId) ?? [pattern('a'), pattern('b')]);
      authoritative.find(item => item.id === 'a')!.selected = true;
      harness.sessions.set(sessionId, authoritative);
      harness.notify('session-patterns-changed', { sessionId });
      await notificationReadStarted;

      if (operation === 'pattern') {
        clickPattern('b');
        await waitFor(() => patternSwitch('b').getAttribute('aria-checked') === 'true');
      } else {
        clickTemplate('Starter template');
        assert.equal(templateSwitch('Starter template').disabled, true, 'the apply is queued behind the deferred notification read');
      }
      releaseNotificationRead();

      await waitFor(() => alertsText().includes(failureText)
        && patternSwitch('a', starter).getAttribute('aria-checked') === 'true'
        && patternSwitch('b').getAttribute('aria-checked') === 'false');
      assert.equal(harness.calls.filter(call => call.name === 'session-patterns').length, 3,
        'the invalidated notification read is followed by an authoritative recovery read');
      assert.equal(harness.sessions.get(sessionId)?.find(item => item.id === 'a')?.selected, true);
      assert.equal(harness.sessions.get(sessionId)?.find(item => item.id === 'b')?.selected, false);
      assert.ok(alertsText().includes(failureText), 'the failed operation error remains visible after recovery');
    } finally {
      releaseNotificationRead();
      harness.dispose();
    }
  }
});

test('load, write, template load, and atomic apply failures can be retried without host widget callbacks', async () => {
  const harness = createHarness({ loadFailures: 1, writeFailures: 1, templateLoadFailures: 1, templateApplyFailures: 1 });
  try {
    const { activate } = await import('../src/main');
    activate(harness.ctx);
    await openSession(harness, 'retry-session');
    await waitFor(() => alertsText().includes('temporary read failure')
      && [...document.querySelectorAll('button')].some(button => button.textContent?.trim() === 'Retry loading'));
    buttonByText('Retry loading').click();
    await waitFor(() => patternRows('b').length === 1);

    clickPattern('b');
    await waitFor(() => alertsText().includes('temporary write failure'));
    assert.equal(patternSwitch('b').getAttribute('aria-checked'), 'false', 'a failed write restores the accepted state inline');
    clickPattern('b');
    await waitFor(() => harness.sessions.get('retry-session')?.find(item => item.id === 'b')?.selected === true);
    assert.equal(patternSwitch('b').getAttribute('aria-checked'), 'true');

    await waitFor(() => alertsText().includes('temporary templates failure')
      && [...document.querySelectorAll('button')].some(button => button.textContent?.trim() === 'Retry loading templates'));
    buttonByText('Retry loading templates').click();
    await waitFor(() => !!document.querySelector('.qp-session-template h3'));
    clickTemplate('Starter template');
    await waitFor(() => alertsText().includes('temporary apply failure'));
    assert.equal(templateSwitch('Starter template').getAttribute('aria-checked'), 'false', 'a failed atomic apply does not change session state');
    buttonByText('Retry apply').click();
    await waitFor(() => harness.calls.filter(call => call.name === 'session-template-apply').length === 2
      && harness.sessions.get('retry-session')?.find(item => item.id === 'a')?.selected === true
      && !alertsText().includes('temporary apply failure'));
    assert.equal(harness.calls.filter(call => call.name === 'templates-snapshot').length, 2);
    assert.equal(harness.calls.some(call => call.name === 'pattern-examples'), false);
  } finally {
    harness.dispose();
  }
});

test('template operations serialize with individual writes, ignore stale refreshes, and abandon queued work on disposal', async () => {
  const harness = createHarness({ templateApplyDelay: 25 });
  try {
    const { activate } = await import('../src/main');
    activate(harness.ctx);
    await openSession(harness, 'queued-template');
    await waitFor(() => patternRows('b').length === 1 && !!document.querySelector('.qp-session-template h3'));

    clickTemplate('Starter template');
    await waitFor(() => harness.calls.some(call => call.name === 'session-template-apply'));
    assert.equal(templateSwitch('Starter template').disabled, true, 'template controls are disabled while an atomic operation is pending');
    assert.equal(patternSwitch('b').disabled, false, 'individual pattern switches remain available to queue');
    harness.notify('session-patterns-changed', { sessionId: 'queued-template' });
    await new Promise(resolve => setTimeout(resolve, 0)); // Let the refresh enter the operation queue before the switch write.
    clickPattern('b');
    await waitFor(() => harness.calls.some(call => call.name === 'session-pattern-set')
      && harness.sessions.get('queued-template')?.every(item => item.selected) === true);
    assert.deepEqual(harness.calls.filter(call => ['session-patterns', 'session-template-apply', 'session-pattern-set'].includes(call.name))
      .map(call => call.name), ['session-patterns', 'session-template-apply', 'session-patterns', 'session-pattern-set']);
    assert.equal(patternSwitch('b').getAttribute('aria-checked'), 'true', 'the refresh cannot overwrite the queued write result');

    closePicker();
    await openSession(harness, 'dispose-during-apply');
    await waitFor(() => patternRows('b').length === 1 && !!document.querySelector('.qp-session-template h3'));
    clickTemplate('Starter template');
    await waitFor(() => harness.calls.filter(call => call.name === 'session-template-apply').length === 2);
    clickPattern('b');
    harness.controller.abort();
    const callsAtDispose = harness.calls.length;
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(harness.calls.length, callsAtDispose, 'queued operations are abandoned after modal disposal');
    assert.equal(harness.calls.some(call => call.name === 'session-pattern-set' && call.input.sessionId === 'dispose-during-apply'), false);
    assert.equal(harness.notifications.size, 0);
    assert.equal(harness.resync.size, 0);
    assert.equal(harness.counts().dialogs, 0);
  } finally {
    harness.dispose();
  }
});
