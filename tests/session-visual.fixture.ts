// Fictional session-pattern data and host API doubles for isolated visual checks.
import type { PluginFrontendContext } from 'learnharness-plugin-api';
import type { SessionPattern } from '../src/domain';
import { registerSessionPatterns } from '../src/session-patterns';

const sessionId = 'visual-session';
const patterns: SessionPattern[] = [
  { id: '10000000-0000-4000-8000-000000000001', name: 'First-principles decomposition', format: 'direct_question', structure: {}, rule: 'Break a complex idea into its simplest claims.', reasoning: ['Separate assumptions from evidence.'], tags: ['Reasoning'], revision: 2, selected: false },
  { id: '10000000-0000-4000-8000-000000000002', name: 'Counterexample search', format: 'open_response', structure: {}, rule: 'Look for a case that would disprove the claim.', reasoning: ['Test the boundaries of a rule.'], tags: ['Reasoning'], revision: 1, selected: true },
  { id: '10000000-0000-4000-8000-000000000003', name: 'Assumption audit', format: 'direct_question', structure: {}, rule: 'Name what must be true for the conclusion to follow.', reasoning: ['Surface hidden premises.'], tags: ['Reasoning'], revision: 3, selected: false },
  { id: '10000000-0000-4000-8000-000000000004', name: 'Observation before inference', format: 'open_response', structure: {}, rule: 'Record what is directly observable before explaining it.', reasoning: ['Keep evidence distinct from interpretation.'], tags: ['Review'], revision: 1, selected: false },
  { id: '10000000-0000-4000-8000-000000000005', name: 'Transfer check', format: 'direct_question', structure: {}, rule: 'Apply the idea in a changed context.', reasoning: ['Check whether understanding generalizes.'], tags: ['Review'], revision: 1, selected: true },
  { id: '10000000-0000-4000-8000-000000000006', name: 'Retrieval pause', format: 'open_response', structure: {}, rule: 'Recall the key idea before reviewing notes.', reasoning: ['Strengthen independent retrieval.'], tags: ['Study'], revision: 1, selected: true },
];

type VisualTemplate = {
  id: string;
  name: string;
  patternIds: string[];
  bypassOverallLimit?: boolean;
  revision: number;
  updatedAt: string;
};
const templates: VisualTemplate[] = [
  { id: '20000000-0000-4000-8000-000000000001', name: 'Reasoning foundations', patternIds: patterns.slice(0, 3).map(pattern => pattern.id), bypassOverallLimit: false, revision: 2, updatedAt: '2026-11-10T18:30:00.000Z' },
  { id: '20000000-0000-4000-8000-000000000002', name: 'A longer review template name for narrow-screen wrapping', patternIds: patterns.slice(3, 5).map(pattern => pattern.id), revision: 1, updatedAt: '2026-11-10T18:30:00.000Z' },
  { id: '20000000-0000-4000-8000-000000000003', name: 'Unavailable archive', patternIds: ['10000000-0000-4000-8000-000000000099', '10000000-0000-4000-8000-000000000098'], revision: 1, updatedAt: '2026-11-10T18:30:00.000Z' },
];
const exampleSummaries = [
  { id: '20000000-0000-4000-8000-000000000001', totalExamples: 9, availableExamples: 7, forcedExamples: 1, expectedExamples: 6, perPatternLimited: true, exceedsOverallLimit: true },
  { id: '20000000-0000-4000-8000-000000000002', totalExamples: 3, availableExamples: 3, forcedExamples: 0, expectedExamples: 3, perPatternLimited: false, exceedsOverallLimit: false },
  { id: '20000000-0000-4000-8000-000000000003', totalExamples: 0, availableExamples: 0, forcedExamples: 0, expectedExamples: 0, perPatternLimited: false, exceedsOverallLimit: false },
];

const calls: Array<{ name: string; input: any }> = [];
(window as Window & { __sessionVisualCalls?: typeof calls }).__sessionVisualCalls = calls;
let selectedPatterns = structuredClone(patterns);
const favorites = new Map<string, { kind: 'pattern' | 'template'; id: string }>();
const actions = new Map<string, any>();
const notificationListeners = new Set<(event: any) => void>();
const resyncListeners = new Set<() => void>();
const controller = new AbortController();

function favoriteSnapshot() {
  return { favorites: [...favorites.values()].map(entry => ({ ...entry })) };
}

function notifySessionChanged() {
  queueMicrotask(() => {
    for (const listener of [...notificationListeners]) listener({ topic: 'session-patterns-changed', data: { sessionId } });
  });
}

const ctx = {
  signal: controller.signal,
  registerAction(action: any) {
    actions.set(action.id, action);
    return () => actions.delete(action.id);
  },
  placeAction(placement: any) {
    if (placement.actionId !== 'session-patterns') throw new Error(`Unexpected toolbar action: ${placement.actionId}`);
    return () => {};
  },
  onNotification(listener: (event: any) => void) {
    notificationListeners.add(listener);
    return () => notificationListeners.delete(listener);
  },
  onResync(listener: () => void) {
    resyncListeners.add(listener);
    return () => resyncListeners.delete(listener);
  },
  async call(name: string, input: any) {
    calls.push({ name, input: structuredClone(input) });
    if (name === 'session-patterns') return structuredClone(selectedPatterns);
    if (name === 'templates-snapshot') {
      return { templates: structuredClone(templates), exampleSummaries: structuredClone(exampleSummaries), overallExampleLimit: 4 };
    }
    if (name === 'favorites-snapshot') return favoriteSnapshot();
    if (name === 'favorite-set') {
      const key = `${input.kind}:${input.id}`;
      if (input.favorite) favorites.set(key, { kind: input.kind, id: input.id });
      else favorites.delete(key);
      return favoriteSnapshot();
    }
    if (name === 'session-pattern-set') {
      const pattern = selectedPatterns.find(item => item.id === input.patternId);
      if (!pattern) throw new Error(`Unknown session pattern: ${input.patternId}`);
      pattern.selected = input.selected;
      const result = structuredClone(selectedPatterns);
      notifySessionChanged();
      return result;
    }
    if (name === 'session-template-apply') {
      const template = templates.find(item => item.id === input.templateId);
      if (!template) throw new Error(`Unknown session template: ${input.templateId}`);
      const available = new Set(template.patternIds.filter(id => selectedPatterns.some(pattern => pattern.id === id)));
      if (input.mode === 'replace') {
        for (const pattern of selectedPatterns) pattern.selected = available.has(pattern.id);
      } else if (input.mode === 'add') {
        for (const pattern of selectedPatterns) if (available.has(pattern.id)) pattern.selected = true;
      } else if (input.mode === 'remove') {
        for (const pattern of selectedPatterns) if (available.has(pattern.id)) pattern.selected = false;
      } else {
        throw new Error(`Unexpected template apply mode: ${input.mode}`);
      }
      const result = structuredClone(selectedPatterns);
      notifySessionChanged();
      return result;
    }
    throw new Error(`Unexpected session visual API: ${name}`);
  },
  ui: {
    mountButton(container: HTMLElement, props: any, options: { signal: AbortSignal }) {
      let current = props;
      let disposed = false;
      const button = document.createElement('button');
      button.type = 'button';
      const render = () => {
        button.className = `native-button native-${current.variant ?? 'default'}`;
        button.textContent = current.label;
        button.disabled = !!current.disabled;
        if (current.title) button.title = current.title;
        button.onclick = () => { void Promise.resolve(current.onClick()).catch(error => console.error(error)); };
      };
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        button.remove();
        options.signal.removeEventListener('abort', dispose);
      };
      options.signal.addEventListener('abort', dispose, { once: true });
      render();
      container.append(button);
      return { update(next: any) { current = { ...current, ...next }; render(); }, dispose };
    },
    mountSettingsRows(container: HTMLElement, props: any, options: { signal: AbortSignal }) {
      let current = props;
      let disposed = false;
      const render = () => {
        if (disposed) return;
        container.replaceChildren(...current.rows.map((row: any) => {
          const label = document.createElement('label');
          label.className = 'native-settings-toggle';
          const text = document.createElement('span');
          text.textContent = row.label;
          const toggle = document.createElement('button');
          toggle.type = 'button';
          toggle.setAttribute('role', 'switch');
          toggle.setAttribute('aria-label', row.label);
          toggle.setAttribute('aria-checked', String(!!row.value));
          toggle.disabled = !!row.disabled;
          toggle.className = 'native-switch';
          toggle.onclick = () => {
            void Promise.resolve(row.onChange(!row.value)).catch(error => console.error(error));
          };
          label.append(text, toggle);
          return label;
        }));
      };
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        container.replaceChildren();
        options.signal.removeEventListener('abort', dispose);
      };
      options.signal.addEventListener('abort', dispose, { once: true });
      render();
      return { update(next: any) { current = { ...current, ...next }; render(); }, dispose };
    },
    openDialog(props: any, options: { signal: AbortSignal }) {
      const dialog = document.createElement('dialog');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-label', props.title);
      dialog.className = 'host-dialog';
      const shell = document.createElement('div');
      shell.setAttribute('data-plugin-ui-dialog', '');
      shell.className = 'host-dialog-shell';
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'native-button native-ghost host-dialog-close';
      close.setAttribute('aria-label', 'Close dialog');
      close.textContent = '×';
      const scroller = document.createElement('div');
      scroller.setAttribute('data-plugin-ui-dialog-scroll', '');
      scroller.className = 'host-dialog-scroll';
      shell.append(close, scroller);
      dialog.append(shell);
      document.body.append(dialog);

      const contentController = new AbortController();
      const cleanup = props.content(scroller, contentController.signal);
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        options.signal.removeEventListener('abort', dispose);
        contentController.abort();
        cleanup?.();
        if (dialog.open) dialog.close();
        dialog.remove();
      };
      const onDialogClose = () => {
        if (disposed) return;
        props.onClose?.();
        dispose();
      };
      dialog.addEventListener('close', onDialogClose);
      close.addEventListener('click', () => dialog.close());
      options.signal.addEventListener('abort', dispose, { once: true });
      dialog.showModal();
      return { update() {}, dispose };
    },
  },
};

const toolbarButton = document.querySelector<HTMLButtonElement>('#session-patterns-action')!;
toolbarButton.addEventListener('click', () => {
  const action = actions.get('session-patterns');
  if (!action) throw new Error('The session-patterns action was not registered.');
  void action.run({ surface: 'session', kind: 'teaching', sessionId });
});
registerSessionPatterns(ctx as unknown as PluginFrontendContext);
(window as Window & { __sessionVisualReady?: boolean }).__sessionVisualReady = actions.has('session-patterns');

(window as Window & { __sessionVisualNotify?: (topic?: string) => void }).__sessionVisualNotify = (topic = 'library-changed') => {
  for (const listener of [...notificationListeners]) listener({ topic, data: { sessionId } });
};
