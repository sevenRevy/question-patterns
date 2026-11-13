import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import type { PluginFrontendContext, PluginView } from 'learnharness-plugin-api';

type PatternRecord = {
  id: string;
  name: string;
  format: string;
  structure: Record<string, unknown>;
  rule: string;
  reasoning: string[];
  tags: string[];
  enabled: boolean;
  archived: boolean;
  revision: number;
  updatedAt: string;
  examples?: ExampleRecord[];
  exampleLimit?: number | null;
};
type ExampleRecord = { id: string; text: string; forced: boolean };
type PatternContent = Pick<PatternRecord, 'name' | 'format' | 'structure' | 'rule' | 'reasoning'>;
type TemplateRecord = { id: string; name: string; patternIds: string[]; bypassOverallLimit?: boolean; isDefault?: boolean; revision: number; updatedAt: string };
type TemplateSummary = { id: string; totalExamples: number; availableExamples: number; forcedExamples: number; expectedExamples: number; perPatternLimited: boolean; exceedsOverallLimit: boolean };
type PatternVersionRecord = { revision: number; content: PatternContent; createdAt: string; examples?: ExampleRecord[]; exampleLimit?: number | null };

const timestamp = '2026-11-10T18:30:00Z';
const record = (overrides: Partial<PatternRecord> & Pick<PatternRecord, 'id' | 'name' | 'format' | 'rule'>): PatternRecord => ({
  structure: {}, reasoning: [], tags: [], enabled: true, archived: false, revision: 1, updatedAt: timestamp, ...overrides,
});

function createHarness(options: { legacyTemplateSnapshot?: boolean; templateSummary?: TemplateSummary; overallExampleLimit?: number } = {}) {
  const dom = new JSDOM('<div id="view"></div>', { url: 'http://localhost/' });
  const previousGlobals = new Map<string, unknown>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    previousGlobals.set(key, (globalThis as any)[key]);
    (globalThis as any)[key] = value;
  }
  const controller = new AbortController();
  const views = new Map<string, PluginView>(), actions = new Map<string, any>();
  const notifications = new Set<any>(), resync = new Set<any>();
  const placements: any[] = [], calls: Array<{ name: string; input: any }> = [], openedViews: string[] = [];
  const snapshotResponses: Array<{ patterns: PatternRecord[] }> = [], templateSnapshotResponses: Array<{ templates: TemplateRecord[]; exampleSummaries?: TemplateSummary[]; overallExampleLimit?: number }> = [];
  const settingsRowsSeen: Array<{ key: string; type: string; label: string; value: boolean; disabled: boolean }> = [];
  const widgetFailures: unknown[] = [];
  let nextEnabledError: Error | undefined, nextPatternSaveError: Error | undefined, nextPatternDeleteError: Error | undefined, nextTemplateSaveError: Error | undefined, nextTemplateDeleteError: Error | undefined, nextTemplateDefaultError: Error | undefined;
  const patterns: PatternRecord[] = [
    record({ id: 'pattern-multiple', name: 'Multiple Choice', format: 'multiple_choice', rule: 'Offer alternatives and select the best-supported answer.', reasoning: ['compare evidence'], tags: ['Core', 'Assessment'], examples: [{ id: '00000000-0000-4000-8000-000000000001', text: 'Which explanation best fits the evidence?', forced: true }, { id: '00000000-0000-4000-8000-000000000002', text: 'Choose the strongest supported conclusion.', forced: false }], exampleLimit: null }),
    record({ id: 'pattern-legacy', name: 'Legacy direct question', format: 'direct_question', rule: 'Ask one focused question.', reasoning: ['recall the rule'], tags: ['Legacy'] }),
    record({ id: 'pattern-disabled', name: 'Disabled Recall', format: 'open_response', rule: 'Recall a concise explanation.', enabled: false }),
    record({ id: 'pattern-archived', name: 'Archived Example', format: 'any', rule: 'Use when the prompt permits any response.', archived: true }),
  ];
  const templates: TemplateRecord[] = [{ id: 'template-existing', name: 'Evidence set', patternIds: ['pattern-multiple', 'pattern-archived'], isDefault: false, revision: 4, updatedAt: timestamp }];
  const versions = new Map<string, PatternVersionRecord[]>();
  const contentOf = (pattern: PatternRecord): PatternContent => ({ name: pattern.name, format: pattern.format, structure: structuredClone(pattern.structure), rule: pattern.rule, reasoning: [...pattern.reasoning] });
  for (const pattern of patterns) versions.set(pattern.id, [{ revision: pattern.revision, content: contentOf(pattern), createdAt: timestamp, ...(pattern.examples !== undefined ? { examples: structuredClone(pattern.examples) } : {}), ...(Object.hasOwn(pattern, 'exampleLimit') ? { exampleLimit: pattern.exampleLimit } : {}) }]);
  let generatedId = 0, generatedTemplateId = 0, mounts = 0, disposals = 0, markdownMounts = 0, unmount: (() => void | Promise<void>) | void;

  function widget(container: HTMLElement, props: any, options: { signal: AbortSignal }, render: (props: any) => void) {
    mounts++;
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true; disposals++;
      container.replaceChildren(); options.signal.removeEventListener('abort', dispose);
    };
    options.signal.addEventListener('abort', dispose, { once: true }); render(props);
    return { update: (next: any) => { if (!disposed) { props = { ...props, ...next }; render(props); } }, dispose };
  }
  const ui = {
    mountButton(container: HTMLElement, props: any, options: any) {
      const slot = document.createElement('span'); container.append(slot);
      const button = document.createElement('button'); button.type = 'button';
      const handle = widget(slot, props, options, next => {
        button.disabled = !!next.disabled;
        button.title = next.title ?? '';
        button.dataset.iconOnly = String(!!next.iconOnly);
        if (next.iconOnly) {
          button.setAttribute('aria-label', next.label);
          button.innerHTML = next.icon ?? '';
        } else {
          button.removeAttribute('aria-label');
          button.textContent = next.label;
        }
        button.onclick = () => { void next.onClick(); }; slot.replaceChildren(button);
      });
      return { update: handle.update, dispose: () => { handle.dispose(); slot.remove(); } };
    },
    mountModelPicker(container: HTMLElement, props: any, options: any) {
      const button = document.createElement('button'); button.type = 'button';
      return widget(container, props, options, next => { button.textContent = next.value?.id ?? 'Choose a model'; container.replaceChildren(button); });
    },
    mountThinkingPicker(container: HTMLElement, props: any, options: any) {
      const button = document.createElement('button'); button.type = 'button';
      return widget(container, props, options, next => { button.textContent = next.value ?? 'Thinking default'; container.replaceChildren(button); });
    },
    mountSettingsRows(container: HTMLElement, props: any, options: any) {
      return widget(container, props, options, next => {
        container.replaceChildren(...next.rows.map((row: any) => {
          assert.equal(row.key, 'enabled');
          assert.equal(row.type, 'toggle');
          assert.equal(row.label, 'Enabled');
          settingsRowsSeen.push({ key: row.key, type: row.type, label: row.label, value: row.value, disabled: !!row.disabled });
          const label = document.createElement('label');
          const text = document.createElement('span'); text.textContent = row.label;
          const input = document.createElement('input'); input.type = 'checkbox'; input.setAttribute('role', 'switch'); input.setAttribute('aria-label', row.label);
          input.checked = row.value; input.disabled = !!row.disabled;
          input.addEventListener('change', () => {
            void Promise.resolve().then(() => row.onChange(input.checked)).catch(error => {
              widgetFailures.push(error);
              input.checked = row.value;
            });
          });
          label.append(text, input);
          return label;
        }));
      });
    },
    mountMarkdown(container: HTMLElement, props: any, options: any) {
      markdownMounts++;
      return widget(container, props, options, next => { container.textContent = next.text; });
    },
    openDialog(props: any, options: any) {
      const node = document.createElement('div'); node.setAttribute('role', 'dialog'); node.setAttribute('aria-label', props.title); document.body.append(node);
      const hostDialog = document.createElement('div');
      hostDialog.setAttribute('data-plugin-ui-dialog', '');
      hostDialog.style.cssText = 'position:relative;max-height:85vh;overflow:hidden;display:flex;flex-direction:column';
      const close = document.createElement('button'); close.type = 'button'; close.setAttribute('aria-label', 'Close dialog'); close.textContent = '×';
      close.style.cssText = 'position:absolute;top:12px;right:12px;width:32px;height:32px;padding:0;z-index:1';
      close.onclick = () => props.onClose?.();
      const scroll = document.createElement('div');
      scroll.setAttribute('data-plugin-ui-dialog-scroll', '');
      scroll.style.cssText = 'flex:1 1 auto;min-height:0;overflow-y:auto;padding:20px';
      const content = document.createElement('div'); scroll.append(content);
      hostDialog.append(close, scroll); node.append(hostDialog);
      const scope = new AbortController();
      const handle = widget(node, props, options, () => {});
      const cleanup = props.content(content, scope.signal);
      const dispose = () => { scope.abort(); cleanup?.(); handle.dispose(); node.remove(); options.signal.removeEventListener('abort', dispose); };
      options.signal.addEventListener('abort', dispose, { once: true });
      return { update: () => {}, dispose };
    },
    openMenu(_anchor: HTMLElement, props: any, options: any) {
      const node = document.createElement('div'); node.className = 'native-menu'; document.body.append(node);
      const handle = widget(node, props, options, next => node.replaceChildren(...next.items.map((item: any) => {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = item.label;
        button.disabled = !!item.disabled;
        button.onclick = () => { dispose(); void item.onSelect(); };
        return button;
      })));
      const dispose = () => { handle.dispose(); node.remove(); options.signal.removeEventListener('abort', dispose); };
      options.signal.addEventListener('abort', dispose, { once: true });
      return { update: () => {}, dispose };
    },
  };
  const ctx = {
    signal: controller.signal, ui,
    registerView: (view: PluginView) => { views.set(view.id, view); return () => views.delete(view.id); },
    registerAction: (action: any) => { actions.set(action.id, action); return () => actions.delete(action.id); },
    placeAction: (placement: any) => { assert.ok(actions.has(placement.actionId)); placements.push(placement); return () => {}; },
    registerSettings: () => () => {},
    registerSubmissionInterceptor: () => () => {},
    cleanup: () => {},
    call: async (name: string, input: any = {}) => {
      calls.push({ name, input: structuredClone(input) });
      if (name === 'patterns-snapshot') {
        const response = { patterns: structuredClone(patterns) };
        snapshotResponses.push(response);
        return response;
      }
      if (name === 'templates-snapshot') {
        const response: { templates: TemplateRecord[]; exampleSummaries?: TemplateSummary[]; overallExampleLimit?: number } = { templates: structuredClone(templates) };
        if (!options.legacyTemplateSnapshot) {
          response.exampleSummaries = [options.templateSummary ?? { id: 'template-existing', totalExamples: 4, availableExamples: 3, forcedExamples: 1, expectedExamples: 3, perPatternLimited: true, exceedsOverallLimit: true }];
          response.overallExampleLimit = options.overallExampleLimit ?? 15;
        }
        templateSnapshotResponses.push(response);
        return response;
      }
      if (name === 'template-save') {
        if (nextTemplateSaveError) { const error = nextTemplateSaveError; nextTemplateSaveError = undefined; throw error; }
        if (typeof input.name !== 'string' || !Array.isArray(input.patternIds) || input.patternIds.some((id: unknown) => typeof id !== 'string')) throw new Error('Unexpected template-save payload.');
        const existing = input.id ? templates.find(item => item.id === input.id) : undefined;
        if (input.id && (!existing || input.expectedRevision !== existing.revision)) throw new Error('Template revision conflict.');
        if (!input.id && Object.hasOwn(input, 'expectedRevision')) throw new Error('Unexpected template revision on create.');
        const id = existing?.id ?? `template-created-${++generatedTemplateId}`;
        if (Object.hasOwn(input, 'bypassOverallLimit') && typeof input.bypassOverallLimit !== 'boolean') throw new Error('Unexpected template limit bypass value.');
        const next: TemplateRecord = { id, name: input.name, patternIds: [...input.patternIds], bypassOverallLimit: input.bypassOverallLimit ?? existing?.bypassOverallLimit ?? true, isDefault: existing?.isDefault ?? false, revision: existing ? existing.revision + 1 : 1, updatedAt: timestamp };
        if (existing) Object.assign(existing, next); else templates.push(next);
        return id;
      }
      if (name === 'template-default-set') {
        if (nextTemplateDefaultError) { const error = nextTemplateDefaultError; nextTemplateDefaultError = undefined; throw error; }
        const existing = templates.find(item => item.id === input.id);
        if (!existing || input.expectedRevision !== existing.revision || typeof input.isDefault !== 'boolean') throw new Error('Template revision conflict.');
        existing.isDefault = input.isDefault;
        existing.revision++;
        existing.updatedAt = timestamp;
        for (const listener of notifications) listener({ topic: 'library-changed' });
        return;
      }
      if (name === 'template-delete') {
        if (nextTemplateDeleteError) { const error = nextTemplateDeleteError; nextTemplateDeleteError = undefined; throw error; }
        const existing = templates.find(item => item.id === input.id);
        if (!existing || input.expectedRevision !== existing.revision) throw new Error('Template revision conflict.');
        templates.splice(templates.indexOf(existing), 1);
        return;
      }
      if (name === 'pattern-delete') {
        if (nextPatternDeleteError) { const error = nextPatternDeleteError; nextPatternDeleteError = undefined; throw error; }
        const pattern = patterns.find(item => item.id === input.id);
        if (!pattern || input.expectedRevision !== pattern.revision) throw new Error('Pattern revision conflict.');
        patterns.splice(patterns.indexOf(pattern), 1);
        versions.delete(pattern.id);
        return;
      }
      if (name === 'pattern-enabled-set') {
        const pattern = patterns.find(item => item.id === input.id);
        if (!pattern || typeof input.enabled !== 'boolean') throw new Error('Unexpected enabled payload.');
        if (nextEnabledError) { const error = nextEnabledError; nextEnabledError = undefined; throw error; }
        pattern.enabled = input.enabled;
        return;
      }
      if (name === 'pattern-versions') return structuredClone(versions.get(input.id) ?? []);
      if (name === 'archive') {
        const archived = patterns.find(pattern => pattern.id === input.id);
        if (!archived || input.kind !== 'pattern' || typeof input.archived !== 'boolean') throw new Error('Unexpected archive payload.');
        archived.archived = input.archived;
        return;
      }
      if (name === 'pattern-save') {
        if (input.content) {
          if (nextPatternSaveError) { const error = nextPatternSaveError; nextPatternSaveError = undefined; throw error; }
          const existing = patterns.find(pattern => pattern.id === input.id);
          const id = existing?.id ?? `pattern-created-${++generatedId}`;
          const nextContent = structuredClone(input.content) as PatternContent;
          const next: PatternRecord = {
            ...(existing ?? record({ id, name: nextContent.name, format: nextContent.format, rule: nextContent.rule })),
            ...nextContent,
            tags: structuredClone(input.tags ?? existing?.tags ?? []),
            enabled: input.enabled ?? existing?.enabled ?? true,
            ...(input.examples !== undefined ? { examples: structuredClone(input.examples) } : existing?.examples !== undefined ? { examples: structuredClone(existing.examples) } : {}),
            ...(Object.hasOwn(input, 'exampleLimit') ? { exampleLimit: input.exampleLimit } : Object.hasOwn(existing ?? {}, 'exampleLimit') ? { exampleLimit: existing!.exampleLimit } : {}),
            archived: existing?.archived ?? false,
            revision: existing ? existing.revision + 1 : 1,
            updatedAt: timestamp,
          };
          if (existing) Object.assign(existing, next); else patterns.push(next);
          const history = versions.get(id) ?? [];
          history.push({ revision: next.revision, content: contentOf(next), createdAt: timestamp, ...(next.examples !== undefined ? { examples: structuredClone(next.examples) } : {}), ...(Object.hasOwn(next, 'exampleLimit') ? { exampleLimit: next.exampleLimit } : {}) }); versions.set(id, history);
          return id;
        }
        const archived = patterns.find(pattern => pattern.id === input.id);
        if (!archived || typeof input.archived !== 'boolean') throw new Error('Unexpected pattern-save payload.');
        archived.archived = input.archived;
        return archived.id;
      }
      throw new Error(`Unexpected operation: ${name}`);
    },
    onNotification: (listener: any) => { notifications.add(listener); return () => notifications.delete(listener); },
    onResync: (listener: any) => { resync.add(listener); return () => resync.delete(listener); },
    app: { openView: (id: string) => { openedViews.push(id); } },
  } as unknown as PluginFrontendContext;

  const wait = () => new Promise(resolve => setTimeout(resolve, 20));
  const click = async (label: string, root: ParentNode = document) => {
    const button = [...root.querySelectorAll('button')].find(node => node.textContent?.trim() === label);
    assert.ok(button, `Missing button: ${label}; found [${[...root.querySelectorAll('button')].map(node => JSON.stringify(node.textContent?.trim())).join(', ')}]`);
    await act(async () => { button.click(); await wait(); });
  };
  const clickByAccessibleName = async (label: string, root: ParentNode = document) => {
    const button = [...root.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === label);
    assert.ok(button, `Missing button with accessible name: ${label}`);
    await act(async () => { button.click(); await wait(); });
  };
  const setText = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    await act(async () => {
      const prototype = element.tagName === 'INPUT' ? dom.window.HTMLInputElement.prototype : dom.window.HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
      element.dispatchEvent(new dom.window.Event('input', { bubbles: true })); await wait();
    });
  };
  const setFilter = async (value: string) => {
    const select = document.querySelector<HTMLSelectElement>('select');
    assert.ok(select, 'Pattern filter remains available');
    await act(async () => { select.value = value; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await wait(); });
  };
  const libraryTab = (label: string) => {
    const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(item => item.textContent?.trim() === label);
    assert.ok(tab, `Missing ${label} library tab`);
    return tab;
  };
  const selectLibraryTab = async (label: string) => {
    const tab = libraryTab(label);
    await act(async () => { tab.click(); await wait(); });
    return tab;
  };
  const pressLibraryTab = async (label: string, key: string) => {
    const tab = libraryTab(label);
    await act(async () => { tab.focus(); tab.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true })); await wait(); });
  };
  const openPattern = async (name: string) => {
    const row = [...document.querySelectorAll<HTMLElement>('.qp-pattern-record')].find(item => item.textContent?.includes(name));
    assert.ok(row, `Missing pattern row: ${name}`);
    return row;
  };
  const enabledToggle = (row: HTMLElement) => {
    const toggle = row.querySelector<HTMLButtonElement>('button.qp-enabled-switch[role="switch"]');
    assert.ok(toggle, 'pattern has a plugin-owned Enabled switch');
    assert.equal(toggle.type, 'button', 'the switch uses native button keyboard behavior');
    assert.equal(toggle.getAttribute('aria-label'), 'Default for new sessions', 'the switch explains its default-selection behavior');
    assert.equal(toggle.parentElement?.className, 'qp-pattern-toggle', 'the switch keeps the shared compact wrapper');
    assert.equal(toggle.getAttribute('aria-describedby'), row.querySelector('h2')?.id, 'the pattern name describes the switch');
    assert.equal(toggle.textContent?.trim(), '', 'the status switch has no visible Enabled caption');
    return toggle;
  };
  const setToggle = async (toggle: HTMLButtonElement, value: boolean) => {
    await act(async () => { if (toggle.getAttribute('aria-checked') !== String(value)) toggle.click(); await wait(); });
  };
  const openTemplate = async (name: string) => {
    const heading = [...document.querySelectorAll<HTMLElement>('h2,h3')].find(item => item.textContent?.trim() === name);
    assert.ok(heading, `Missing template heading: ${name}`);
    let row: HTMLElement | null = heading;
    while (row && ![...row.querySelectorAll('button')].some(button => button.textContent?.trim() === 'Edit template')) row = row.parentElement;
    assert.ok(row, `Missing template row for ${name}`);
    return row;
  };
  const openTemplateEditor = async (mode: 'new' | 'edit', templateName?: string) => {
    if (mode === 'new') await click('New template');
    else {
      const row = await openTemplate(templateName!);
      await click('Edit template', row);
    }
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog, `${mode} template editor is open`);
    return dialog;
  };
  const templateSwitch = (root: ParentNode, name: string) => {
    const toggle = [...root.querySelectorAll<HTMLButtonElement>('button[role="switch"]')].find(button => button.getAttribute('aria-label')?.includes(name));
    assert.ok(toggle, `Missing template membership switch for ${name}`);
    assert.equal(toggle.type, 'button', 'boolean switches use native button keyboard behavior');
    assert.ok(toggle.closest('.qp-boolean-field'), 'boolean switch has a separate visible descriptive label');
    return toggle;
  };
  const setSwitch = async (toggle: HTMLButtonElement, value: boolean) => {
    await act(async () => { if (toggle.getAttribute('aria-checked') !== String(value)) toggle.click(); await wait(); });
  };
  const openEditor = async (mode: 'new' | 'edit', patternName?: string) => {
    if (mode === 'new') await click('New pattern');
    else {
      const row = await openPattern(patternName!);
      await click('Edit pattern', row);
    }
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog, `${mode} pattern editor is open`);
    return dialog;
  };
  const field = (root: ParentNode, fragment: string, selector = 'input, textarea') => {
    const label = [...root.querySelectorAll<HTMLLabelElement>('label')].find(item => item.textContent?.toLocaleLowerCase().includes(fragment.toLocaleLowerCase()));
    assert.ok(label, `Missing labeled field containing ${fragment}`);
    const control = label.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
    assert.ok(control, `Missing control for ${fragment}`);
    assert.equal(control.closest('details'), null, `${fragment} is not hidden in a disclosure`);
    assert.equal(control.closest('[hidden], [aria-hidden="true"]'), null, `${fragment} is visible`);
    return control;
  };
  const exampleRow = (root: ParentNode, index: number) => {
    const label = [...root.querySelectorAll<HTMLLabelElement>('label')].find(item => item.textContent?.includes(`Example ${index} — full question`));
    assert.ok(label, `Missing numbered full-question label for example ${index}`);
    const textarea = label.querySelector<HTMLTextAreaElement>('textarea');
    assert.ok(textarea, `Example ${index} uses a textarea`);
    let row: HTMLElement | null = textarea;
    while (row && ![...row.querySelectorAll('button')].some(button => button.textContent?.trim() === `Remove example ${index}`)) row = row.parentElement;
    assert.ok(row, `Example ${index} has its own remove action`);
    const force = [...row.querySelectorAll<HTMLButtonElement>('button[role="switch"]')].find(item => item.getAttribute('aria-label') === `Force inclusion for example ${index}`);
    assert.ok(force, `Example ${index} has a uniquely named Force inclusion switch`);
    assert.equal(force.closest('.qp-boolean-field')?.querySelector('span')?.textContent, 'Force inclusion', `Example ${index} keeps its visible descriptive label`);
    return { row, textarea, force };
  };
  const radioGroup = (root: ParentNode) => {
    const group = root.querySelector<HTMLElement>('[role="radiogroup"]');
    assert.ok(group, 'Presentation is an accessible radio group');
    const radios = [...group.querySelectorAll<HTMLElement>('[role="radio"], input[type="radio"]')];
    assert.equal(radios.length, 3, 'Presentation has exactly three supported options');
    const name = (radio: HTMLElement) => radio.getAttribute('aria-label') ?? radio.closest('label')?.textContent ?? radio.textContent ?? '';
    const value = (radio: HTMLElement) => radio.getAttribute('value') ?? radio.getAttribute('data-value') ?? radio.getAttribute('data-format')
      ?? (name(radio).toLocaleLowerCase().includes('multiple choice') ? 'multiple_choice' : name(radio).toLocaleLowerCase().includes('free recall') ? 'open_response' : name(radio).toLocaleLowerCase().includes('any') ? 'any' : null);
    for (const [label, format] of [['Multiple choice', 'multiple_choice'], ['Free recall', 'open_response'], ['Any', 'any']]) {
      const option = radios.find(radio => value(radio) === format);
      assert.ok(option, `Missing ${format} presentation option`);
      assert.match(name(option).toLocaleLowerCase(), new RegExp(label.toLocaleLowerCase()));
    }
    return { group, radios, value };
  };
  const selectedFormat = (root: ParentNode) => {
    const { radios, value } = radioGroup(root);
    const selected = radios.find(radio => radio.getAttribute('aria-checked') === 'true' || (radio instanceof dom.window.HTMLInputElement && radio.checked));
    return selected ? value(selected) : null;
  };
  const press = async (root: ParentNode, key: string) => {
    const { radios } = radioGroup(root);
    const selected = radios.find(radio => radio.getAttribute('aria-checked') === 'true' || (radio instanceof dom.window.HTMLInputElement && radio.checked));
    assert.ok(selected, 'A presentation radio has focusable selected state');
    await act(async () => { selected.focus(); selected.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true })); await wait(); });
  };
  const chooseFormat = async (root: ParentNode, format: string) => {
    const { radios, value } = radioGroup(root);
    const option = radios.find(radio => value(radio) === format);
    assert.ok(option, `Missing ${format} radio`);
    await act(async () => { option.click(); await wait(); });
  };
  const assertOnlyPatternApi = () => {
    const legacyEndpoints = new Set(['snapshot', 'import', 'source-update', 'source-revisions', 'revision-text', 'original', 'image-to-text', 'scan', 'scan-cancel', 'model-catalog', 'settings', 'settings-save', 'run-detail', 'run-input', 'decide']);
    assert.ok(calls.every(call => !legacyEndpoints.has(call.name)), `Legacy endpoint called: ${calls.map(call => call.name).join(', ')}`);
    assert.ok(calls.every(call => ['patterns-snapshot', 'pattern-save', 'pattern-enabled-set', 'pattern-delete', 'templates-snapshot', 'template-save', 'template-default-set', 'template-delete'].includes(call.name)), `Unexpected endpoint: ${calls.map(call => call.name).join(', ')}`);
    assert.equal(calls.some(call => call.name === 'pattern-versions' || call.name === 'archive'), false, 'viewing and editing never fetch versions or archive patterns');
    assert.ok(calls.filter(call => call.name === 'patterns-snapshot').every(call => Object.keys(call.input).length === 0), 'patterns-snapshot always receives an empty payload');
    assert.ok(calls.filter(call => call.name === 'templates-snapshot').every(call => Object.keys(call.input).length === 0), 'templates-snapshot always receives an empty payload');
    for (const call of calls) {
      for (const key of ['targetKind', 'targetId', 'sourceId', 'runId', 'history', 'requestId', 'model', 'thinkingLevel', 'instructions', 'filename', 'location', 'base64', 'text', 'notices', 'replaceId', 'revisionId', 'inputRevision']) {
        assert.equal(Object.hasOwn(call.input, key), false, `No legacy ${key} payload on ${call.name}`);
      }
    }
  };
  const noLegacyActions = () => {
    const labels = [...document.querySelectorAll('button')].map(button => button.textContent?.trim());
    for (const label of ['Analyze', 'Advanced', 'Run analysis', 'Scan history', 'Add sources', 'View source', 'Archive source', 'Structure']) {
      assert.equal(labels.includes(label), false, `Legacy action is absent: ${label}`);
    }
    assert.equal(document.querySelector('input[type="file"]'), null, 'There is no source import control');
    assert.equal(document.querySelector('.qp-source-group'), null, 'There are no source rows');
  };

  return {
    dom, ctx, controller, views, actions, notifications, resync, placements, calls, patterns, templates, versions, snapshotResponses, templateSnapshotResponses, openedViews, settingsRowsSeen, widgetFailures,
    wait, click, clickByAccessibleName, setText, setFilter, libraryTab, selectLibraryTab, pressLibraryTab, openPattern, enabledToggle, setToggle, openTemplate, openTemplateEditor, templateSwitch, setSwitch, openEditor, field, exampleRow, radioGroup, selectedFormat, press, chooseFormat, assertOnlyPatternApi, noLegacyActions,
    failNextEnabledSet(error: Error) { nextEnabledError = error; },
    failNextPatternSave(error: Error) { nextPatternSaveError = error; },
    failNextPatternDelete(error: Error) { nextPatternDeleteError = error; },
    failNextTemplateSave(error: Error) { nextTemplateSaveError = error; },
    failNextTemplateDefaultSet(error: Error) { nextTemplateDefaultError = error; },
    failNextTemplateDelete(error: Error) { nextTemplateDeleteError = error; },
    get mounts() { return mounts; }, get disposals() { return disposals; }, get markdownMounts() { return markdownMounts; },
    async mount() { await act(async () => { unmount = await views.get('library')!.mount(document.getElementById('view')!, controller.signal); await wait(); }); },
    async cleanup() {
      await act(async () => { controller.abort(); await unmount?.(); });
      assert.equal(notifications.size, 0); assert.equal(resync.size, 0); assert.equal(disposals, mounts, 'all native widget mounts are disposed');
      assert.equal(document.querySelector('[role="dialog"]'), null, 'dialogs are cleaned up');
      await dom.window.close();
      for (const [key, value] of previousGlobals) {
        if (value === undefined) delete (globalThis as any)[key]; else (globalThis as any)[key] = value;
      }
    },
  };
}

test('library tabs default to Patterns, support keyboard navigation, and retain pattern search, filter, and session toolbar lifecycle', async () => {
  const harness = createHarness();
  try {
    const { activate } = await import('../src/main');
    activate(harness.ctx);
    assert.ok(harness.placements.some(({ actionId, location }) => actionId === 'open-library' && location === 'sidebar'));
    assert.ok(harness.placements.some(({ actionId, location }) => actionId === 'session-patterns' && location === 'top-bar'));
    assert.equal(harness.actions.has('session-patterns'), true, 'native session pattern registration remains available');
    assert.equal(harness.views.has('library'), true);
    await harness.actions.get('open-library').run();
    assert.deepEqual(harness.openedViews, ['library'], 'the host action opens the registered pattern library');
    await harness.mount();

    assert.equal(document.querySelector('.qp-workspace'), null);
    assert.equal(document.querySelector('h1'), null, 'the host owns the Patterns Library title');
    assert.deepEqual([...document.querySelectorAll('[role="tab"]')].map(tab => tab.textContent?.trim()), ['Patterns', 'Templates'], 'the library exposes only Patterns and Templates tabs');
    assert.equal(harness.libraryTab('Patterns').getAttribute('aria-selected'), 'true', 'Patterns is the default tab');
    assert.equal(document.body.textContent?.includes('Follow the live schema'), false, 'session rendering instructions are not shown in library tabs');
    assert.equal(document.body.textContent?.includes('assessment.md'), false);
    assert.deepEqual(Object.keys(harness.snapshotResponses[0]).sort(), ['patterns'], 'patterns-snapshot remains scoped to patterns');
    assert.ok(document.body.textContent?.includes('Multiple Choice'));
    assert.ok(document.querySelector('input[type="search"]'));
    assert.ok(document.querySelector('select'), 'pattern filters remain available');
    harness.noLegacyActions();
    harness.assertOnlyPatternApi();

    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    await harness.setText(search, 'Legacy direct');
    assert.ok(document.body.textContent?.includes('Legacy direct question'), 'search narrows patterns by name');
    assert.equal(document.body.textContent?.includes('Multiple Choice'), false);
    await harness.setText(search, 'no matching pattern');
    assert.ok(document.body.textContent?.includes('No matches'));
    await harness.setText(search, '');
    await harness.setFilter('disabled');
    assert.ok(document.body.textContent?.includes('Disabled Recall'));
    assert.equal(document.body.textContent?.includes('Multiple Choice'), false, 'disabled filter excludes enabled patterns');
    await harness.setFilter('archived');
    assert.ok(document.body.textContent?.includes('Archived Example'));
    await harness.setFilter('all');

    await harness.pressLibraryTab('Patterns', 'ArrowRight');
    assert.equal(harness.libraryTab('Templates').getAttribute('aria-selected'), 'true', 'ArrowRight activates Templates');
    assert.ok(document.body.textContent?.includes('Evidence set'));
    assert.deepEqual(Object.keys(harness.templateSnapshotResponses[0]).sort(), ['exampleSummaries', 'overallExampleLimit', 'templates']);
    await harness.pressLibraryTab('Templates', 'Home');
    assert.equal(harness.libraryTab('Patterns').getAttribute('aria-selected'), 'true', 'Home activates the first tab');
    await harness.pressLibraryTab('Patterns', 'End');
    assert.equal(harness.libraryTab('Templates').getAttribute('aria-selected'), 'true', 'End activates the last tab');
    await harness.pressLibraryTab('Templates', 'ArrowLeft');
    assert.equal(harness.libraryTab('Patterns').getAttribute('aria-selected'), 'true', 'ArrowLeft activates Patterns');
    harness.assertOnlyPatternApi();
  } finally {
    await harness.cleanup();
  }
});

test('template list remains compatible with snapshots that omit optional example metadata', async () => {
  const harness = createHarness({ legacyTemplateSnapshot: true });
  try {
    const { activate } = await import('../src/main');
    activate(harness.ctx); await harness.mount();
    await harness.selectLibraryTab('Templates');
    assert.deepEqual(Object.keys(harness.templateSnapshotResponses[0]), ['templates'], 'older snapshots may contain templates only');
    assert.ok(document.body.textContent?.includes('Evidence set'), 'templates still render without example summaries or the overall limit');
    assert.ok(document.querySelector('.qp-template-list.qp-feed section.qp-template-record.qp-pattern-record[aria-label="Evidence set"]'), 'the compact list renders without optional metadata');
    assert.equal([...document.querySelectorAll('.qp-template-record .qp-meta')].some(item => item.textContent?.includes('saved examples')), false, 'saved-example metadata is omitted when summaries are unavailable');
    assert.equal(document.querySelector('[role="alert"]'), null, 'omitted optional metadata does not become a loading error');
  } finally {
    await harness.cleanup();
  }
});

test('template list has a fixed three-name preview, compact metadata, and a full edit list', async () => {
  const harness = createHarness({ overallExampleLimit: 2 });
  harness.templates[0].patternIds = ['pattern-multiple', 'pattern-legacy', 'pattern-additional', 'pattern-archived'];
  harness.templates[0].bypassOverallLimit = false;
  harness.patterns.push(record({ id: 'pattern-additional', name: 'Additional active pattern', format: 'direct_question', rule: 'Ask for one evidence-based response.', examples: [
    { id: '00000000-0000-4000-8000-000000000003', text: 'Explain the evidence.', forced: false },
    { id: '00000000-0000-4000-8000-000000000004', text: 'What follows from the evidence?', forced: false },
  ] }));
  try {
    const { activate } = await import('../src/main');
    activate(harness.ctx); await harness.mount();
    await harness.selectLibraryTab('Templates');

    const list = document.querySelector<HTMLElement>('.qp-template-list.qp-feed');
    assert.ok(list, 'templates use the compact feed list');
    const row = list.querySelector<HTMLElement>('section.qp-template-record.qp-pattern-record[aria-label="Evidence set"]');
    assert.ok(row, 'each template record is labeled with its name');
    const heading = row.querySelector('h3');
    assert.equal(heading?.textContent?.trim(), 'Evidence set', 'the template name is an h3');
    assert.ok(heading?.querySelector('svg[aria-hidden="true"]'), 'the heading has a decorative layers icon');

    const preview = row.querySelector<HTMLParagraphElement>('p.qp-template-preview');
    assert.ok(preview, 'the member preview is a paragraph');
    assert.equal(preview.textContent?.trim(), 'Multiple Choice · Legacy direct question · Additional active pattern +1 more', 'the preview is fixed to three names followed by plain-text overflow');
    assert.equal(preview.children.length, 0, 'the preview contains only static text');
    assert.equal(row.querySelector('details'), null, 'the preview is not expandable');
    assert.equal(row.querySelector('[aria-expanded]'), null, 'the preview has no disclosure state');
    assert.equal(row.textContent?.includes('Show all'), false, 'the list has no Show all control');

    const rowText = row.textContent ?? '';
    assert.equal(rowText.includes('Archived Example'), false, 'the fourth member is shown only in the edit modal');
    assert.match(rowText, /4 patterns/, 'compact metadata reports the total pattern count');
    assert.match(rowText, /4 saved examples/, 'compact metadata reports saved examples when a summary exists');
    assert.match(rowText, /1 unavailable/, 'availability is summarized only for unavailable members');
    assert.doesNotMatch(rowText, /available in sessions|Overall limit override|examples per call|expected examples/i, 'the list omits eligible counts, permanent limit policy, and expected sample stats');
    assert.match(rowText, /Example sample capped at 2 per call\./, 'the non-bypassing overall-limit warning describes the capped sample');
    const perPatternWarning = [...row.querySelectorAll('.qp-template-limit')].find(item => item.textContent?.includes('Per-pattern'));
    assert.ok(!perPatternWarning || perPatternWarning.textContent?.trim() === 'Per-pattern limits reduce the sample.', 'the optional per-pattern warning uses compact copy');

    const edit = [...row.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Edit template');
    assert.ok(edit, 'Edit template remains a host button with visible text');
    const defaultButton = row.querySelector<HTMLButtonElement>('button.qp-template-default');
    assert.ok(defaultButton, 'each template has a plugin-owned default pin beside Edit and trash');
    assert.equal(defaultButton.type, 'button');
    assert.equal(defaultButton.getAttribute('aria-label'), 'Default template: Evidence set');
    assert.equal(defaultButton.getAttribute('aria-pressed'), 'false');
    assert.equal(defaultButton.title, 'Set as default template for new sessions only.');
    assert.ok(defaultButton.querySelector('svg[aria-hidden="true"]'), 'the default control uses a decorative pin icon');
    const trash = row.querySelector<HTMLButtonElement>('button[aria-label="Delete template: Evidence set"]');
    assert.ok(trash, 'each template has a named delete button beside Edit');
    assert.equal(trash.title, 'Delete template: Evidence set', 'the trash button has a matching title');
    assert.equal(trash.dataset.iconOnly, 'true', 'the delete button is icon-only');
    assert.equal(trash.textContent?.trim(), '', 'the icon-only accessible label is not visible button text');
    assert.ok(trash.querySelector('svg'), 'the host button renders its shared trash SVG icon');

    await harness.click('Edit template', row);
    const editor = document.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(editor, 'Edit template opens the existing modal');
    for (const name of ['Multiple Choice', 'Legacy direct question', 'Additional active pattern', 'Archived Example']) {
      assert.equal(harness.templateSwitch(editor, name).getAttribute('aria-checked'), 'true', `the full editor includes selected member ${name}`);
    }
  } finally {
    await harness.cleanup();
  }
});

test('template list explains forced examples that exceed the overall limit', async () => {
  const harness = createHarness({
    templateSummary: { id: 'template-existing', totalExamples: 20, availableExamples: 20, forcedExamples: 16, expectedExamples: 20, perPatternLimited: false, exceedsOverallLimit: true },
    overallExampleLimit: 15,
  });
  harness.templates[0].bypassOverallLimit = false;
  try {
    const { activate } = await import('../src/main');
    activate(harness.ctx); await harness.mount();
    await harness.selectLibraryTab('Templates');
    const row = document.querySelector<HTMLElement>('.qp-template-record[aria-label="Evidence set"]');
    assert.ok(row, 'the template renders');
    assert.ok(row.textContent?.includes('16 forced examples exceed the overall limit of 15.'), 'forced examples over the limit get a specific warning');
    assert.equal(row.textContent?.includes('Example sample capped at'), false, 'the forced-example warning takes precedence over the capped-sample warning');
  } finally {
    await harness.cleanup();
  }
});

test('template creation accepts overlapping memberships including disabled patterns without changing patterns or versions', async () => {
  const harness = createHarness();
  try {
    harness.patterns.find(pattern => pattern.id === 'pattern-disabled')!.examples = [
      { id: '00000000-0000-4000-8000-000000000005', text: 'Explain the recalled concept.', forced: false },
    ];
    const { activate } = await import('../src/main');
    const initialPatterns = structuredClone(harness.patterns);
    const initialVersions = new Map([...harness.versions].map(([id, history]) => [id, structuredClone(history)]));
    activate(harness.ctx); await harness.mount();
    await harness.selectLibraryTab('Templates');
    assert.equal(harness.templateSnapshotResponses.length, 1, 'opening Templates loads one template snapshot');
    assert.deepEqual(harness.calls.find(call => call.name === 'templates-snapshot')?.input, {}, 'template snapshot receives an empty payload');

    const createTemplate = async (name: string, patternNames: string[], bypassOverallLimit = true) => {
      const editor = await harness.openTemplateEditor('new');
      assert.equal(editor.getAttribute('aria-label'), 'New template', 'the host dialog is titled New template');
      assert.equal(document.querySelectorAll('[role="dialog"],dialog').length, 1, 'template editor uses one host-owned modal');
      const shell = editor.querySelector<HTMLElement>('[data-plugin-ui-dialog]');
      assert.ok(shell, 'host shell owns the template form');
      assert.equal(shell.querySelectorAll('[data-plugin-ui-dialog-scroll]').length, 1, 'template form has only the host scroll region');
      const nameField = harness.field(editor, 'Name', 'input') as HTMLInputElement;
      await harness.setText(nameField, name);
      const bypass = harness.templateSwitch(editor, 'Bypass overall example limit');
      assert.equal(bypass.getAttribute('aria-checked'), 'true', 'template editor defaults to bypassing the overall example limit');
      await harness.setSwitch(bypass, bypassOverallLimit);
      const search = [...editor.querySelectorAll<HTMLInputElement>('input[type="search"]')].find(input =>
        input.closest('label')?.textContent?.toLocaleLowerCase().includes('search patterns') || input.getAttribute('aria-label')?.toLocaleLowerCase().includes('search patterns'));
      assert.ok(search, 'template editor provides a labeled Search patterns searchbox');
      const picker = search.closest<HTMLElement>('.qp-template-picker');
      assert.ok(picker, 'template search and checklist share the picker layout');
      const searchField = search.closest('label');
      const checklist = picker.querySelector('fieldset.qp-template-members');
      assert.ok(checklist?.contains(harness.templateSwitch(editor, 'Disabled Recall')), 'the picker contains its pattern checklist');
      assert.equal(searchField?.nextElementSibling, checklist, 'the checklist follows the search field directly');
      const disabledMember = harness.templateSwitch(editor, 'Disabled Recall');
      assert.equal(disabledMember.getAttribute('aria-label'), 'Disabled Recall', 'disabled patterns remain eligible template members without a library-status label');
      assert.equal(disabledMember.closest('.qp-boolean-field')?.textContent?.trim(), 'Disabled Recall', 'template membership has no disabled-library label');
      assert.doesNotMatch(editor.textContent ?? '', /Only enabled, non-archived patterns can be applied/i, 'template editor omits the outdated enabled-pattern policy');
      assert.equal([...editor.querySelectorAll<HTMLButtonElement>('button[role="switch"]')].some(toggle =>
        toggle.getAttribute('aria-label')?.includes('Archived Example')), false, 'new templates do not offer archived patterns');
      await harness.click('Select all shown', editor);
      for (const pattern of ['Multiple Choice', 'Legacy direct question', 'Disabled Recall']) assert.equal(harness.templateSwitch(editor, pattern).getAttribute('aria-checked'), 'true', `Select all includes ${pattern}`);
      await harness.click('Clear selection', editor);
      for (const pattern of ['Multiple Choice', 'Legacy direct question', 'Disabled Recall']) assert.equal(harness.templateSwitch(editor, pattern).getAttribute('aria-checked'), 'false', `Clear selection clears ${pattern}`);
      for (const pattern of patternNames) await harness.setSwitch(harness.templateSwitch(editor, pattern), true);
      if (name === 'Rapid review') assert.match(editor.querySelector('[role="status"]')?.textContent ?? '', /up to 3 examples per call/, 'disabled, non-archived members contribute to template samples');
      await harness.click('Save template', editor);
      assert.equal(document.querySelector('[role="dialog"]'), null, 'successful save closes the editor');
      return harness.calls.filter(call => call.name === 'template-save').at(-1)!;
    };

    const firstSave = await createTemplate('Rapid review', ['Multiple Choice', 'Disabled Recall'], false);
    assert.deepEqual(Object.keys(firstSave.input).sort(), ['bypassOverallLimit', 'name', 'patternIds'], 'create sends the template fields and overall-limit choice');
    assert.equal(firstSave.input.bypassOverallLimit, false);
    assert.equal(firstSave.input.name, 'Rapid review');
    assert.deepEqual([...firstSave.input.patternIds].sort(), ['pattern-disabled', 'pattern-multiple']);
    const rapidReview = await harness.openTemplate('Rapid review');
    assert.equal(rapidReview.querySelector('.qp-template-preview')?.textContent?.trim(), 'Multiple Choice · Disabled Recall', 'disabled patterns are previewed without an unavailable suffix');
    assert.doesNotMatch(rapidReview.textContent ?? '', /Only enabled, non-archived patterns can be applied|disabled in library/i, 'template list omits disabled-library labels and policy');
    const secondSave = await createTemplate('Shared evidence', ['Multiple Choice']);
    assert.equal(secondSave.input.bypassOverallLimit, true, 'the default limit bypass is sent when creating another template');
    assert.deepEqual([...secondSave.input.patternIds].sort(), ['pattern-multiple'], 'membership in another template is independent');
    assert.equal(harness.templates.filter(template => template.patternIds.includes('pattern-multiple')).length, 3, 'a pattern may belong to multiple templates');
    assert.deepEqual(harness.patterns, initialPatterns, 'template CRUD does not change pattern definitions or enabled state');
    assert.deepEqual([...harness.versions], [...initialVersions], 'template CRUD does not change pattern versions');
    assert.equal(harness.calls.some(call => ['pattern-save', 'pattern-enabled-set'].includes(call.name)), false, 'template operations do not call pattern mutation APIs');
    harness.assertOnlyPatternApi();
  } finally {
    await harness.cleanup();
  }
});

test('template default pin toggles with revision checks, refreshes state, and reports failures without editing membership', async () => {
  const harness = createHarness();
  try {
    const { activate } = await import('../src/main');
    activate(harness.ctx); await harness.mount();
    await harness.selectLibraryTab('Templates');

    const originalMembership = [...harness.templates[0]!.patternIds];
    const row = await harness.openTemplate('Evidence set');
    const pin = () => row.querySelector<HTMLButtonElement>('button.qp-template-default')!;
    assert.equal(pin().getAttribute('aria-pressed'), 'false');
    assert.equal(pin().title, 'Set as default template for new sessions only.');
    assert.equal(pin().querySelector('svg path')?.getAttribute('fill'), 'none', 'an unselected pin is outlined');

    const failure = new Error('default update failed');
    harness.failNextTemplateDefaultSet(failure);
    await harness.clickByAccessibleName('Default template: Evidence set', row);
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /default update failed/, 'default failure is reported accessibly');
    assert.equal(pin().getAttribute('aria-pressed'), 'false', 'failure leaves the controlled pressed state unchanged');
    assert.equal(harness.templates[0]!.revision, 4, 'failure does not increment the template revision');
    assert.deepEqual(harness.templates[0]!.patternIds, originalMembership, 'failure preserves template memberships');
    assert.deepEqual(harness.calls.filter(call => call.name === 'template-default-set').at(-1)?.input, {
      id: 'template-existing', expectedRevision: 4, isDefault: true,
    }, 'the pin sends the current revision and desired default state');
    assert.equal(document.querySelector('[role="dialog"]'), null, 'toggling default never opens the editor modal');
    assert.equal(harness.calls.some(call => call.name === 'template-save'), false, 'default toggle does not save or alter memberships');

    await harness.clickByAccessibleName('Default template: Evidence set', row);
    assert.equal(pin().getAttribute('aria-pressed'), 'true', 'successful retry activates the pin');
    assert.equal(pin().title, 'Selected as default for new sessions only. Click to unset.');
    assert.equal(pin().querySelector('svg path')?.getAttribute('fill'), 'currentColor', 'the active pin is filled');
    assert.equal(harness.templates[0]!.revision, 5, 'the backend revision advances on success');
    assert.equal(harness.templateSnapshotResponses.at(-1)?.templates[0]?.revision, 5, 'library-changed refreshes the template snapshot and revision');

    await harness.clickByAccessibleName('Default template: Evidence set', row);
    assert.deepEqual(harness.calls.filter(call => call.name === 'template-default-set').at(-1)?.input, {
      id: 'template-existing', expectedRevision: 5, isDefault: false,
    }, 'unsetting sends the refreshed revision');
    assert.equal(pin().getAttribute('aria-pressed'), 'false', 'the pin can be unset');
    assert.equal(pin().querySelector('svg path')?.getAttribute('fill'), 'none');
    assert.equal(harness.templates[0]!.revision, 6);
    assert.deepEqual(harness.templates[0]!.patternIds, originalMembership, 'both toggles leave membership unchanged');
    assert.equal(document.querySelector('[role="dialog"]'), null, 'neither toggle opens a modal');
    assert.equal(harness.calls.some(call => call.name === 'template-save'), false, 'default changes do not call template-save');

    const editor = await harness.openTemplateEditor('edit', 'Evidence set');
    await harness.click('Save template', editor);
    const save = harness.calls.filter(call => call.name === 'template-save').at(-1)!;
    assert.equal(save.input.expectedRevision, 6, 'subsequent edits use the refreshed default-toggle revision');
    assert.deepEqual(save.input.patternIds, originalMembership, 'editing retains existing template memberships');
    assert.equal(harness.templates[0]!.isDefault, false, 'template edits preserve default state');
    harness.assertOnlyPatternApi();
  } finally {
    await harness.cleanup();
  }
});

test('template edits preserve unavailable membership and edits across failures; trash-button deletion is inline and revision-checked', async () => {
  const harness = createHarness();
  try {
    const { activate } = await import('../src/main');
    const initialPatterns = structuredClone(harness.patterns);
    const initialVersions = new Map([...harness.versions].map(([id, history]) => [id, structuredClone(history)]));
    activate(harness.ctx); await harness.mount();
    await harness.selectLibraryTab('Templates');

    const editor = await harness.openTemplateEditor('edit', 'Evidence set');
    assert.equal(editor.getAttribute('aria-label'), 'Edit template', 'the host dialog is titled Edit template');
    assert.equal(document.querySelectorAll('[role="dialog"],dialog').length, 1, 'edit uses one host-owned modal');
    const nameField = harness.field(editor, 'Name', 'input') as HTMLInputElement;
    assert.equal(nameField.value, 'Evidence set', 'template name is prefilled');
    assert.equal(harness.templateSwitch(editor, 'Bypass overall example limit').getAttribute('aria-checked'), 'true', 'legacy templates default to bypassing the overall example limit');
    assert.equal(harness.templateSwitch(editor, 'Multiple Choice').getAttribute('aria-checked'), 'true', 'existing active membership is checked');
    const archivedMembership = harness.templateSwitch(editor, 'Archived Example');
    assert.equal(archivedMembership.getAttribute('aria-checked'), 'true', 'saved archived membership is preserved and checked by default');
    assert.match(archivedMembership.getAttribute('aria-label') ?? '', / — unavailable$/, 'saved archived membership context is in its accessible name');
    assert.match(archivedMembership.closest('.qp-boolean-field')?.textContent ?? '', / — unavailable$/, 'saved archived membership is visibly labeled unavailable');
    await harness.setText(nameField, 'Evidence set revised');
    await harness.setSwitch(harness.templateSwitch(editor, 'Disabled Recall'), true);
    const failure = new Error('template save failed');
    harness.failNextTemplateSave(failure);
    await harness.click('Save template', editor);
    assert.ok(document.querySelector('[role="alert"]')?.textContent?.includes(failure.message), 'save failure is reported accessibly');
    assert.equal(document.querySelector('[role="dialog"]'), editor, 'save failure keeps the editor open');
    assert.equal((harness.field(editor, 'Name', 'input') as HTMLInputElement).value, 'Evidence set revised', 'save failure preserves edited name');
    assert.equal(harness.templateSwitch(editor, 'Disabled Recall').getAttribute('aria-checked'), 'true', 'save failure preserves edited membership');
    await harness.click('Save template', editor);
    const save = harness.calls.filter(call => call.name === 'template-save').at(-1)!;
    assert.deepEqual(Object.keys(save.input).sort(), ['bypassOverallLimit', 'expectedRevision', 'id', 'name', 'patternIds']);
    assert.equal(save.input.bypassOverallLimit, true, 'editing a legacy template persists the default bypass setting');
    assert.equal(save.input.id, 'template-existing');
    assert.equal(save.input.expectedRevision, 4, 'edit uses the loaded template revision');
    assert.deepEqual({ id: save.input.id, expectedRevision: save.input.expectedRevision, name: save.input.name }, {
      id: 'template-existing', expectedRevision: 4, name: 'Evidence set revised',
    });
    assert.deepEqual([...save.input.patternIds].sort(), ['pattern-archived', 'pattern-disabled', 'pattern-multiple'], 'editing preserves existing unavailable membership while saving active selections');
    assert.equal(harness.templates.find(template => template.id === 'template-existing')?.revision, 5);

    const reopenedEditor = await harness.openTemplateEditor('edit', 'Evidence set revised');
    const archivedToRemove = harness.templateSwitch(reopenedEditor, 'Archived Example');
    assert.equal(archivedToRemove.getAttribute('aria-checked'), 'true', 'unavailable membership remains checked when reopening the saved template');
    await harness.setSwitch(archivedToRemove, false);
    await harness.click('Save template', reopenedEditor);
    const removalSave = harness.calls.filter(call => call.name === 'template-save').at(-1)!;
    assert.equal(removalSave.input.expectedRevision, 5, 'removing unavailable membership uses the current revision');
    assert.equal(removalSave.input.bypassOverallLimit, true, 'membership edits preserve the template limit bypass');
    assert.deepEqual([...removalSave.input.patternIds].sort(), ['pattern-disabled', 'pattern-multiple'], 'unavailable membership can be explicitly removed');
    assert.deepEqual([...(harness.templates.find(template => template.id === 'template-existing')?.patternIds ?? [])].sort(), ['pattern-disabled', 'pattern-multiple']);
    assert.equal(harness.templates.find(template => template.id === 'template-existing')?.revision, 6);

    const row = await harness.openTemplate('Evidence set revised');
    const trashLabel = 'Delete template: Evidence set revised';
    await harness.clickByAccessibleName(trashLabel, row);
    assert.equal(document.querySelectorAll('[role="dialog"],dialog').length, 0, 'delete confirmation is not a nested modal');
    assert.ok(row.textContent?.includes('Delete template?'), 'trash opens the inline confirmation');
    assert.ok([...row.querySelectorAll('button')].some(button => button.textContent?.trim() === 'Cancel'));
    assert.equal(harness.calls.filter(call => call.name === 'template-delete').length, 0, 'opening confirmation does not mutate before confirmation');
    const deleteFailure = new Error('template delete failed');
    harness.failNextTemplateDelete(deleteFailure);
    await harness.click('Delete template', row);
    assert.ok(document.querySelector('[role="alert"]')?.textContent?.includes(deleteFailure.message), 'delete failure is reported accessibly');
    assert.ok(row.textContent?.includes('Delete template?'), 'delete failure keeps the inline confirmation available');
    assert.ok(harness.templates.some(template => template.id === 'template-existing'), 'delete failure leaves the template intact');
    await harness.click('Cancel', row);
    assert.equal(row.textContent?.includes('Delete template?'), false, 'Cancel dismisses inline confirmation');
    await harness.clickByAccessibleName(trashLabel, row);
    assert.ok(row.textContent?.includes('Delete template?'), 'the trash button can reopen confirmation after cancel');
    assert.equal(harness.calls.filter(call => call.name === 'template-delete').length, 1, 'retry still waits for inline confirmation after the failed attempt');
    await harness.click('Delete template', row);
    const deletion = harness.calls.filter(call => call.name === 'template-delete').at(-1)!;
    assert.deepEqual(deletion.input, { id: 'template-existing', expectedRevision: 6 }, 'delete sends the current expected revision');
    assert.equal(harness.templates.some(template => template.id === 'template-existing'), false, 'confirmed delete removes the template');
    assert.deepEqual(harness.patterns, initialPatterns, 'editing and deleting templates do not change patterns');
    assert.deepEqual([...harness.versions], [...initialVersions], 'editing and deleting templates do not change versions');
    assert.equal(harness.calls.some(call => ['pattern-save', 'pattern-enabled-set'].includes(call.name)), false, 'template CRUD does not call pattern mutation APIs');
    harness.assertOnlyPatternApi();
  } finally {
    await harness.cleanup();
  }
});

test('pattern examples edit independently from structure, trim on save, preserve drafts, and round-trip version metadata', async () => {
  const harness = createHarness();
  try {
    const { activate } = await import('../src/main');
    activate(harness.ctx); await harness.mount();

    const editor = await harness.openEditor('new');
    const help = editor.textContent?.toLocaleLowerCase() ?? '';
    assert.match(help, /structure/, 'editor help describes reusable structure');
    assert.match(help, /full example/, 'editor help distinguishes full examples from reusable structure');
    await harness.setText(harness.field(editor, 'Name', 'input') as HTMLInputElement, 'Question bank pattern');
    await harness.setText(harness.field(editor, 'Reusable rule', 'textarea') as HTMLTextAreaElement, 'Apply the reusable rule.');
    const enabled = [...editor.querySelectorAll<HTMLButtonElement>('button[role="switch"]')].find(toggle => toggle.getAttribute('aria-label') === 'Default for new sessions');
    assert.ok(enabled, 'pattern editor exposes Enabled as a shared boolean switch');
    assert.equal(enabled.getAttribute('aria-checked'), 'true', 'new patterns default to enabled');
    await harness.setSwitch(enabled, false);
    assert.equal(enabled.getAttribute('aria-checked'), 'false', 'Enabled switch updates the pattern draft');

    await harness.click('Add example', editor);
    let first = harness.exampleRow(editor, 1);
    assert.equal(first.textarea.maxLength, 20000, 'example text allows at most 20,000 characters');
    await harness.setText(first.textarea, '  Which conclusion follows from the evidence?  ');
    await harness.setSwitch(first.force, true);
    await harness.click('Add example', editor);
    const second = harness.exampleRow(editor, 2);
    await harness.setText(second.textarea, 'What is the strongest explanation?');
    await harness.click('Add example', editor);
    harness.exampleRow(editor, 3);
    const saveButton = [...editor.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Save pattern');
    assert.ok(saveButton?.disabled, 'a blank example blocks Save');
    await harness.click('Remove example 3', editor);
    assert.equal([...editor.querySelectorAll('label')].some(label => label.textContent?.includes('Example 3 — full question')), false, 'removing a blank example removes it from the form');

    const limit = harness.field(editor, 'Example limit per call', 'input') as HTMLInputElement;
    assert.equal(limit.type, 'number');
    assert.equal(limit.min, '0');
    assert.equal(limit.max, '1000');
    await harness.setText(limit, '4');
    const failure = new Error('pattern save failed');
    harness.failNextPatternSave(failure);
    await harness.click('Save pattern', editor);
    assert.ok(document.querySelector('[role="alert"]')?.textContent?.includes(failure.message), 'save failure is reported accessibly');
    assert.equal(document.querySelector('[role="dialog"]'), editor, 'save failure keeps the editor open');
    assert.equal(harness.field(editor, 'Name', 'input').value, 'Question bank pattern', 'save failure preserves the name draft');
    assert.equal(harness.exampleRow(editor, 1).textarea.value, '  Which conclusion follows from the evidence?  ', 'save failure preserves the untrimmed example draft');
    assert.equal(harness.exampleRow(editor, 1).force.getAttribute('aria-checked'), 'true', 'save failure preserves Force inclusion');
    assert.equal([...editor.querySelectorAll<HTMLButtonElement>('button[role="switch"]')].find(toggle => toggle.getAttribute('aria-label') === 'Default for new sessions')?.getAttribute('aria-checked'), 'false', 'save failure preserves the non-default pattern draft');
    assert.equal((harness.field(editor, 'Example limit per call', 'input') as HTMLInputElement).value, '4', 'save failure preserves the per-call limit draft');
    assert.equal(harness.patterns.some(pattern => pattern.name === 'Question bank pattern'), false, 'failed saves do not persist a pattern');

    await harness.click('Save pattern', editor);
    const createdSave = harness.calls.filter(call => call.name === 'pattern-save').at(-1)!;
    assert.deepEqual(Object.keys(createdSave.input).sort(), ['content', 'enabled', 'exampleLimit', 'examples', 'tags']);
    assert.equal(createdSave.input.enabled, false, 'pattern Enabled switch value is saved with the content draft');
    assert.deepEqual(Object.keys(createdSave.input.content).sort(), ['format', 'name', 'reasoning', 'rule', 'structure'], 'the full example bank is never copied into structural content');
    assert.equal(createdSave.input.exampleLimit, 4);
    assert.deepEqual(createdSave.input.examples.map(({ text, forced }: ExampleRecord) => ({ text, forced })), [
      { text: 'Which conclusion follows from the evidence?', forced: true },
      { text: 'What is the strongest explanation?', forced: false },
    ], 'example text is trimmed and each Force inclusion flag is saved');
    assert.ok(createdSave.input.examples.every((item: ExampleRecord) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.id)), 'each saved example has a UUID');
    const created = harness.patterns.find(pattern => pattern.name === 'Question bank pattern')!;
    assert.deepEqual(created.examples, createdSave.input.examples, 'the host mock round-trips the example bank');
    assert.equal(created.exampleLimit, 4);
    const createdVersion = harness.versions.get(created.id)!.at(-1)!;
    assert.deepEqual(createdVersion.examples, created.examples, 'version records preserve example metadata');
    assert.equal(createdVersion.exampleLimit, 4, 'version records preserve the per-call limit');
    assert.equal(Object.hasOwn(createdVersion.content, 'examples'), false, 'versioned definition content stays structural');

    const edit = await harness.openEditor('edit', 'Question bank pattern');
    assert.deepEqual(harness.exampleRow(edit, 1).textarea.value, 'Which conclusion follows from the evidence?', 'saved examples prefill in the edit form');
    assert.equal(harness.exampleRow(edit, 1).force.getAttribute('aria-checked'), 'true', 'saved force state prefills');
    assert.equal(harness.exampleRow(edit, 2).textarea.value, 'What is the strongest explanation?');
    assert.equal((harness.field(edit, 'Example limit per call', 'input') as HTMLInputElement).value, '4');
    await harness.setText(harness.exampleRow(edit, 1).textarea, '  Updated evidence question?  ');
    await harness.setSwitch(harness.exampleRow(edit, 1).force, false);
    await harness.click('Remove example 2', edit);
    await harness.click('Add example', edit);
    const added = harness.exampleRow(edit, 2);
    await harness.setText(added.textarea, 'A newly added question?');
    await harness.setSwitch(added.force, true);
    await harness.setText(harness.field(edit, 'Example limit per call', 'input') as HTMLInputElement, '0');
    await harness.click('Save pattern', edit);
    const editSave = harness.calls.filter(call => call.name === 'pattern-save').at(-1)!;
    assert.deepEqual(Object.keys(editSave.input).sort(), ['content', 'enabled', 'exampleLimit', 'examples', 'expectedRevision', 'id', 'tags']);
    assert.equal(editSave.input.id, created.id);
    assert.equal(editSave.input.expectedRevision, 1);
    assert.deepEqual(editSave.input.examples.map(({ text, forced }: ExampleRecord) => ({ text, forced })), [
      { text: 'Updated evidence question?', forced: false },
      { text: 'A newly added question?', forced: true },
    ], 'editing can update, remove, and add examples independently');
    assert.equal(editSave.input.exampleLimit, 0, 'zero is a valid per-call limit override');
    assert.equal(harness.patterns.find(pattern => pattern.id === created.id)?.exampleLimit, 0);
    assert.equal(harness.versions.get(created.id)!.at(-1)!.examples?.length, 2, 'edited example metadata is retained in version history');

    const defaultEditor = await harness.openEditor('new');
    await harness.setText(harness.field(defaultEditor, 'Name', 'input') as HTMLInputElement, 'Default sample pattern');
    await harness.setText(harness.field(defaultEditor, 'Reusable rule', 'textarea') as HTMLTextAreaElement, 'Use a fresh example bank.');
    assert.equal((harness.field(defaultEditor, 'Example limit per call', 'input') as HTMLInputElement).value, '', 'blank means the default of three examples');
    await harness.click('Save pattern', defaultEditor);
    const defaultSave = harness.calls.filter(call => call.name === 'pattern-save').at(-1)!;
    assert.deepEqual(defaultSave.input.examples, [], 'a pattern without examples stores an empty bank');
    assert.equal(defaultSave.input.exampleLimit, null, 'blank per-call limit saves as the default sentinel');
    harness.assertOnlyPatternApi();
  } finally {
    await harness.cleanup();
  }
});

test('pattern editors expose the presentation radio group, require legacy-format choice, and round-trip content', async () => {
  const harness = createHarness();
  try {
    const { activate } = await import('../src/main');
    activate(harness.ctx); await harness.mount();

    const editor = await harness.openEditor('new');
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1, 'the host owns a single dialog');
    const hostDialog = editor.querySelector<HTMLElement>('[data-plugin-ui-dialog]');
    assert.ok(hostDialog, 'the host dialog container owns the editor surface');
    assert.equal(hostDialog.style.position, 'relative');
    assert.equal(hostDialog.style.maxHeight, '85vh');
    assert.equal(hostDialog.style.overflow, 'hidden');
    assert.equal(hostDialog.style.display, 'flex');
    assert.equal(hostDialog.style.flexDirection, 'column');
    const hostScroller = hostDialog.querySelector<HTMLElement>('[data-plugin-ui-dialog-scroll]');
    assert.ok(hostScroller, 'the host provides a dedicated dialog scroller');
    assert.equal(hostScroller.style.minHeight, '0');
    assert.equal(hostScroller.style.overflowY, 'auto');
    assert.equal(hostScroller.style.padding, '20px');
    const nativeClose = hostDialog.querySelector<HTMLButtonElement>('button[aria-label="Close dialog"]');
    assert.ok(nativeClose, 'the host provides an accessibly named Close dialog button');
    assert.equal(nativeClose.style.position, 'absolute', 'the floating native close control does not consume a flex row');
    assert.equal(hostScroller.contains(nativeClose), false, 'the native close control is outside the scrolling content');
    assert.equal(editor.querySelector('.qp-dialog-top'), null, 'the plugin does not add a second Close toolbar');
    assert.equal(editor.querySelector('details'), null, 'editor fields are always open without a details wrapper');
    const name = harness.field(editor, 'Name', 'input') as HTMLInputElement;
    const rule = harness.field(editor, 'Reusable rule', 'textarea') as HTMLTextAreaElement;
    harness.field(editor, 'Structure', 'textarea');
    const tags = harness.field(editor, 'Tags', 'input') as HTMLInputElement;
    const reasoning = harness.field(editor, 'Reasoning', 'input') as HTMLInputElement;
    assert.equal(harness.selectedFormat(editor), 'any', 'new patterns default to Any');

    await harness.press(editor, 'Home');
    assert.equal(harness.selectedFormat(editor), 'multiple_choice', 'Home selects the first presentation option');
    await harness.press(editor, 'ArrowRight');
    assert.equal(harness.selectedFormat(editor), 'open_response', 'ArrowRight advances the selected presentation');
    await harness.press(editor, 'ArrowLeft');
    assert.equal(harness.selectedFormat(editor), 'multiple_choice', 'ArrowLeft moves to the previous presentation');
    await harness.press(editor, 'End');
    assert.equal(harness.selectedFormat(editor), 'any', 'End selects the last presentation option');
    await harness.press(editor, 'Home');
    assert.equal(harness.selectedFormat(editor), 'multiple_choice');

    await harness.setText(name, 'Compare two definitions');
    await harness.setText(rule, 'Compare defining properties and state the decisive difference.');
    await harness.setText(tags, 'Algebra, Reusable');
    await harness.setText(reasoning, 'compare defining properties, check boundary cases');
    await harness.click('Save pattern', editor);
    let save = harness.calls.filter(call => call.name === 'pattern-save').at(-1)!;
    assert.ok(save);
    assert.deepEqual(Object.keys(save.input).sort(), ['content', 'enabled', 'exampleLimit', 'examples', 'tags'], 'example configuration stays outside structural content');
    assert.deepEqual(Object.keys(save.input.content).sort(), ['format', 'name', 'reasoning', 'rule', 'structure']);
    assert.deepEqual(save.input.examples, []);
    assert.equal(save.input.exampleLimit, null, 'blank means the default example limit');
    assert.equal(save.input.content.format, 'multiple_choice', 'save uses the selected native format value');
    assert.deepEqual(save.input.tags, ['Algebra', 'Reusable']);
    assert.deepEqual(save.input.content.reasoning, ['compare defining properties', 'check boundary cases']);
    assert.equal(Object.hasOwn(save.input, 'sourceId'), false);
    await harness.wait();

    const created = harness.patterns.find(pattern => pattern.name === 'Compare two definitions')!;
    const edit = await harness.openEditor('edit', created.name);
    assert.equal(edit.querySelector('details'), null);
    assert.equal((harness.field(edit, 'Tags', 'input') as HTMLInputElement).value, 'Algebra, Reusable', 'tags round-trip into edit fields');
    assert.equal((harness.field(edit, 'Reasoning', 'input') as HTMLInputElement).value, 'compare defining properties, check boundary cases', 'reasoning round-trips into edit fields');
    await harness.setText(harness.field(edit, 'Tags', 'input') as HTMLInputElement, 'Algebra, Reusable, Reviewed');
    await harness.setText(harness.field(edit, 'Reasoning', 'input') as HTMLInputElement, 'compare defining properties, check boundary cases, verify assumptions');
    await harness.click('Save pattern', edit);
    save = harness.calls.filter(call => call.name === 'pattern-save').at(-1)!;
    assert.deepEqual(Object.keys(save.input).sort(), ['content', 'enabled', 'exampleLimit', 'examples', 'expectedRevision', 'id', 'tags']);
    assert.deepEqual(save.input.examples, [], 'an edited pattern round-trips its empty bank');
    assert.equal(save.input.exampleLimit, null, 'an edited pattern round-trips the default limit');
    assert.deepEqual(save.input.tags, ['Algebra', 'Reusable', 'Reviewed']);
    assert.deepEqual(save.input.content.reasoning, ['compare defining properties', 'check boundary cases', 'verify assumptions']);
    await harness.wait();

    const legacy = await harness.openEditor('edit', 'Legacy direct question');
    assert.equal(legacy.querySelector('details'), null);
    assert.ok(legacy.textContent?.includes('direct_question'), 'legacy presentation is displayed as its current unsupported value');
    const savesBeforeLegacyAttempt = harness.calls.filter(call => call.name === 'pattern-save').length;
    await harness.click('Save pattern', legacy);
    await harness.wait();
    assert.equal(harness.calls.filter(call => call.name === 'pattern-save').length, savesBeforeLegacyAttempt, 'saving an unsupported legacy format requires an explicit choice');
    await harness.chooseFormat(legacy, 'open_response');
    await harness.click('Save pattern', legacy);
    save = harness.calls.filter(call => call.name === 'pattern-save').at(-1)!;
    assert.equal(save.input.content.format, 'open_response', 'the legacy format changes only after explicit user selection');

    const closeCheck = await harness.openEditor('new');
    const closeButton = closeCheck.querySelector<HTMLButtonElement>('button[aria-label="Close dialog"]');
    assert.ok(closeButton, 'the native host Close dialog control is available');
    await act(async () => { closeButton.click(); await harness.wait(); });
    assert.equal(document.querySelector('[role="dialog"]'), null, 'the native host Close dialog control closes the editor');

    harness.assertOnlyPatternApi();
    harness.noLegacyActions();
    assert.equal(harness.markdownMounts, 0, 'pattern-only UI never mounts source markdown');
  } finally {
    await harness.cleanup();
  }
});

test('pattern rows stay flat, switches update only enabled metadata, and Edit pattern remains available', async () => {
  const harness = createHarness();
  try {
    const { activate } = await import('../src/main');
    const initialPatterns = structuredClone(harness.patterns);
    const initialVersions = new Map([...harness.versions].map(([id, history]) => [id, structuredClone(history)]));
    activate(harness.ctx); await harness.mount();

    const rows = [...document.querySelectorAll<HTMLElement>('.qp-pattern-record')];
    assert.equal(rows.length, initialPatterns.filter(pattern => !pattern.archived).length, 'each active pattern has a flat record');
    assert.equal(!!document.querySelector('.qp-group-toggle, .qp-group-body, .qp-record-footer, [aria-expanded]'), false, 'patterns are not accordion rows');
    const assertSwitchParts = (toggle: HTMLButtonElement, name: string) => {
      assert.equal(toggle.querySelectorAll('.qp-state-light, [class*="qp-state-light--"]').length, 0, `${name} has no separate status lamp`);
      assert.equal(toggle.querySelectorAll('.qp-switch-track').length, 1, `${name} has one switch track`);
      const thumb = toggle.querySelector('.qp-switch-track .qp-switch-thumb');
      assert.ok(thumb, `${name} has a sliding thumb inside its track`);
      const check = thumb.querySelector('svg.qp-switch-check');
      assert.ok(check, `${name} has an SVG check inside the thumb`);
    };
    for (const pattern of initialPatterns.filter(pattern => !pattern.archived)) {
      const row = await harness.openPattern(pattern.name);
      assert.ok(row.textContent?.includes(pattern.rule), `${pattern.name} displays its rule`);
      assert.deepEqual([...row.querySelectorAll('button:not([role="switch"])')].map(button => button.getAttribute('aria-label') ?? button.textContent?.trim()), ['Edit pattern', `Delete pattern: ${pattern.name}`], `${pattern.name} exposes Edit and trash actions`);
      const toggle = harness.enabledToggle(row);
      assert.equal(toggle.getAttribute('aria-checked'), String(pattern.enabled), `${pattern.name} exposes its controlled state`);
      assert.equal(toggle.dataset.enabled, String(pattern.enabled), `${pattern.name} exposes its CSS state`);
      assert.equal(toggle.title, `${pattern.enabled ? 'Default for new sessions' : 'Not a default'}: ${pattern.name}`, `${pattern.name} has a state-specific title`);
      assertSwitchParts(toggle, pattern.name);
    }
    const labels = [...document.querySelectorAll('button')].map(button => button.textContent?.trim());
    for (const label of ['More', 'Clone pattern', 'Approved versions', 'Archive pattern', 'Restore pattern']) {
      assert.equal(labels.includes(label), false, `${label} action is absent`);
    }
    assert.equal(harness.settingsRowsSeen.length, 0, 'pattern switches do not mount or style host SettingsRows');

    const row = await harness.openPattern('Multiple Choice');
    const nameText = [...row.querySelectorAll<HTMLElement>('*')].find(element => element.childElementCount === 0 && element.textContent?.trim() === 'Multiple Choice');
    assert.ok(nameText, 'pattern name is present as row text');
    await act(async () => { nameText.click(); await harness.wait(); });
    assert.equal(document.querySelector('[role="dialog"]'), null, 'clicking row text does not open an editor');

    await harness.setToggle(harness.enabledToggle(row), false);
    await harness.wait();
    const update = harness.calls.filter(call => call.name === 'pattern-enabled-set').at(-1)!;
    assert.deepEqual(update.input, { id: 'pattern-multiple', enabled: false }, 'the metadata endpoint receives only ID and enabled state');
    assert.equal(harness.patterns.find(pattern => pattern.id === 'pattern-multiple')!.enabled, false, 'the fixture persists the new enabled value');
    assert.equal(harness.patterns.find(pattern => pattern.id === 'pattern-multiple')!.revision, 1, 'enabled changes do not increment pattern revision');
    assert.deepEqual([...harness.versions], [...initialVersions], 'enabled changes leave version history unchanged');
    assert.equal(harness.enabledToggle(row).getAttribute('aria-checked'), 'false', 'the accepted switch state is displayed');
    assert.equal(harness.enabledToggle(row).dataset.enabled, 'false');
    assertSwitchParts(harness.enabledToggle(row), 'disabled switch');
    assert.deepEqual(harness.patterns.map(pattern => pattern.id), initialPatterns.map(pattern => pattern.id), 'all existing pattern records remain');
    assert.deepEqual(harness.patterns.filter(pattern => pattern.id !== 'pattern-multiple'), initialPatterns.filter(pattern => pattern.id !== 'pattern-multiple'), 'other patterns remain unchanged');

    await harness.setFilter('disabled');
    assert.ok(document.body.textContent?.includes('Multiple Choice'), 'disabled filter includes the newly disabled pattern');
    assert.ok(document.body.textContent?.includes('Disabled Recall'));
    await harness.setFilter('enabled');
    assert.equal(document.body.textContent?.includes('Multiple Choice'), false, 'enabled filter excludes it');
    assert.ok(document.body.textContent?.includes('Legacy direct question'));
    await harness.setFilter('archived');
    const archivedToggle = harness.enabledToggle(await harness.openPattern('Archived Example'));
    assert.equal(archivedToggle.disabled, true, 'archived patterns cannot be toggled');
    await harness.setFilter('all');

    const failure = new Error('enabled update failed');
    harness.failNextEnabledSet(failure);
    await harness.setToggle(harness.enabledToggle(await harness.openPattern('Multiple Choice')), true);
    await harness.wait();
    assert.ok(document.querySelector('[role="alert"]')?.textContent?.includes(failure.message), 'the failure is reported accessibly');
    assert.equal(harness.patterns.find(pattern => pattern.id === 'pattern-multiple')!.enabled, false, 'a failed update does not change persisted state');
    const failedToggle = harness.enabledToggle(await harness.openPattern('Multiple Choice'));
    assert.equal(failedToggle.getAttribute('aria-checked'), 'false', 'a failed update leaves the controlled switch unchanged');
    assert.equal(failedToggle.dataset.enabled, 'false');
    assertSwitchParts(failedToggle, 'switch after failed update');
    assert.equal(harness.patterns.find(pattern => pattern.id === 'pattern-multiple')!.revision, 1, 'a failed enabled change does not increment revision');
    assert.deepEqual([...harness.versions], [...initialVersions], 'failed and successful enabled changes preserve all history');

    const editedRule = 'Offer alternatives and explain the strongest supporting evidence.';
    const edit = await harness.openEditor('edit', 'Multiple Choice');
    await harness.setText(harness.field(edit, 'Reusable rule', 'textarea') as HTMLTextAreaElement, editedRule);
    await harness.click('Save pattern', edit);
    await harness.wait();

    assert.deepEqual(harness.patterns.map(pattern => pattern.id), initialPatterns.map(pattern => pattern.id), 'editing does not add or remove patterns');
    const edited = harness.patterns.find(pattern => pattern.id === 'pattern-multiple')!;
    assert.equal(edited.rule, editedRule);
    assert.equal(edited.enabled, false, 'editing preserves the enabled metadata');
    assert.equal(edited.revision, 2, 'editing, unlike toggling enabled, increments pattern revision');
    assert.deepEqual(edited.examples, initialPatterns.find(pattern => pattern.id === 'pattern-multiple')!.examples, 'editing a definition preserves its existing example bank');
    assert.equal(edited.exampleLimit, null, 'editing preserves the existing default limit');
    for (const [id, history] of initialVersions) {
      const currentHistory = harness.versions.get(id)!;
      if (id === 'pattern-multiple') {
        assert.equal(currentHistory.length, history.length + 1, 'saving an edit appends one version');
        assert.deepEqual(currentHistory[0], history[0], 'the existing version remains unchanged');
        assert.equal(currentHistory.at(-1)!.revision, edited.revision);
        assert.equal(currentHistory.at(-1)!.content.rule, editedRule);
        assert.deepEqual(currentHistory.at(-1)!.examples, edited.examples, 'new version snapshots retain the full example bank');
        assert.equal(currentHistory.at(-1)!.exampleLimit, null, 'new version snapshots retain the default limit');
      } else assert.deepEqual(currentHistory, history, `version history for ${id} remains unchanged`);
    }
    harness.assertOnlyPatternApi();
    harness.noLegacyActions();
  } finally {
    await harness.cleanup();
  }
});

test('pattern trash actions confirm permanent deletion, cancel safely, and retain retry on failure', async () => {
  const harness = createHarness();
  try {
    const { activate } = await import('../src/main');
    activate(harness.ctx);
    await harness.mount();
    const row = () => document.querySelector('[aria-labelledby="pattern-name-pattern-multiple"]')!;
    const trash = () => row().querySelector<HTMLButtonElement>('[aria-label="Delete pattern: Multiple Choice"]')!;
    assert.ok(trash().querySelector('svg'));
    assert.equal(trash().textContent, '');
    assert.equal(trash().title, 'Delete pattern: Multiple Choice');
    await harness.clickByAccessibleName('Delete pattern: Multiple Choice');
    assert.match(row().textContent ?? '', /permanently.*examples and history.*templates and sessions/);
    assert.equal(harness.calls.some(call => call.name === 'pattern-delete'), false);
    await harness.click('Cancel');
    assert.equal(row().querySelector('.qp-delete-confirm'), null);
    assert.equal(harness.patterns.length, 4);
    await harness.clickByAccessibleName('Delete pattern: Multiple Choice');
    harness.failNextPatternDelete(new Error('Pattern deletion failed.'));
    await harness.click('Delete pattern');
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /Pattern deletion failed/);
    assert.equal(harness.patterns.length, 4);
    await harness.click('Delete pattern');
    assert.equal(document.querySelector('[aria-labelledby="pattern-name-pattern-multiple"]'), null);
    assert.deepEqual(harness.calls.filter(call => call.name === 'pattern-delete').map(call => call.input), [
      { id: 'pattern-multiple', expectedRevision: 1 }, { id: 'pattern-multiple', expectedRevision: 1 },
    ]);
    await harness.setFilter('archived');
    await harness.clickByAccessibleName('Delete pattern: Archived Example');
    await harness.click('Delete pattern');
    assert.equal(harness.patterns.some(pattern => pattern.id === 'pattern-archived'), false);
    harness.assertOnlyPatternApi();
  } finally { await harness.cleanup(); }
});

test('review comparison exposes Include unchanged items as an interactive shared switch', async () => {
  const harness = createHarness();
  let root: Root | undefined;
  try {
    const { createRoot } = await import('react-dom/client');
    const { RunDetail } = await import('../src/review');
    const current = { id: 'run-current', targetKind: 'source', targetId: 'source', targetTitle: 'Source', status: 'succeeded', createdAt: timestamp, completedAt: timestamp, model: { provider: 'test', id: 'model' } };
    const baseline = { ...current, id: 'run-baseline', createdAt: '2026-11-09T18:30:00Z' };
    const value = { name: 'Same pattern', format: 'any', structure: {}, rule: 'same rule', reasoning: [], support: 'supported', evidence: 'A quoted source sentence.', existingPatternId: null, similarPatternId: null, difference: null };
    const items = [{ id: 'item-same', runId: current.id, kind: 'pattern', key: 'same', value, decision: 'accepted', appliedId: null }];
    const details = new Map([[current.id, { run: current, items }], [baseline.id, { run: baseline, items }]]);
    (harness.ctx as any).call = async (name: string, input: { id: string }) => {
      assert.equal(name, 'run-detail');
      return structuredClone(details.get(input.id));
    };
    const actions = { host: { ctx: harness.ctx, signal: harness.controller.signal }, refresh: async () => {}, select: () => {}, report: (error: unknown) => { throw error; } };
    const snapshot = { runs: [current, baseline], patterns: [], sources: [], settings: {} };
    root = createRoot(document.getElementById('view')!);
    await act(async () => { root!.render(<RunDetail run={current as any} snapshot={snapshot as any} actions={actions as any} technical />); await harness.wait(); });

    const compare = [...document.querySelectorAll('summary')].find(summary => summary.textContent?.trim() === 'Compare scans');
    assert.ok(compare, 'technical review exposes scan comparison');
    await act(async () => { compare.click(); await harness.wait(); });
    const select = document.querySelector<HTMLSelectElement>('.qp-section select');
    assert.ok(select, 'comparison has a scan selector');
    await act(async () => { select.value = baseline.id; select.dispatchEvent(new harness.dom.window.Event('change', { bubbles: true })); await harness.wait(); });

    const toggle = document.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Include unchanged items"]');
    assert.ok(toggle, 'Include unchanged items is a shared boolean switch');
    assert.equal(toggle.closest('.qp-boolean-field')?.querySelector('span')?.textContent, 'Include unchanged items', 'the visible label is separate from the button');
    assert.equal(toggle.getAttribute('aria-checked'), 'false', 'unchanged comparison rows are initially excluded');
    await harness.setSwitch(toggle, true);
    assert.equal(toggle.getAttribute('aria-checked'), 'true', 'the switch enables unchanged comparison rows');
    assert.ok(document.body.textContent?.includes('pattern:same · unchanged'), 'enabling the switch displays unchanged comparison rows');
  } finally {
    if (root) await act(async () => { root!.unmount(); });
    await harness.cleanup();
  }
});
