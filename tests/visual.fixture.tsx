// Fictional pattern records and public-widget doubles for local visual checks; never bundled in the plugin.
import { createRoot } from 'react-dom/client';
import type { PluginFrontendContext } from 'learnharness-plugin-api';
import type { Pattern } from '../src/domain';
import { Library } from '../src/library';
import { CORE_PATTERNS } from '../src/structures';

const now = '2026-11-10T18:30:00Z';
const visualCalls: Array<{ name: string; input: any }> = [];
(window as Window & { __visualCalls?: typeof visualCalls }).__visualCalls = visualCalls;
const patterns: Pattern[] = CORE_PATTERNS.map(({ id, content }, index) => ({
  ...content, id, revision: 1, updatedAt: now, enabled: true, archived: false,
  tags: ['Core'], analysisIds: [], activeAnalysisId: null, patternIds: [],
  ...(index < 6 ? { examples: Array.from({ length: index === 1 ? 3 : 2 }, (_, sample) => ({
    id: `00000000-0000-4000-8000-${String(index * 10 + sample + 1).padStart(12, '0')}`,
    text: `Fictional full question ${index + 1}-${sample + 1}?`, forced: index < 2 && sample < 2,
  })) } : {}),
  ...(index === 1 ? { exampleLimit: 2 } : index === 2 ? { exampleLimit: 1 } : {}),
}));
type VisualTemplate = { id: string; name: string; patternIds: string[]; bypassOverallLimit?: boolean; isDefault?: boolean; revision: number; updatedAt: string };
const templates: VisualTemplate[] = [
  { id: 'visual-core', name: 'Core comparison set', patternIds: patterns.slice(0, 2).map(pattern => pattern.id), bypassOverallLimit: true, isDefault: true, revision: 2, updatedAt: now },
  { id: 'visual-math', name: 'Math', patternIds: [patterns[2]!, patterns[10]!, patterns[6]!].map(pattern => pattern.id), bypassOverallLimit: false, revision: 1, updatedAt: now },
  { id: 'visual-portuguese', name: 'Portuguese', patternIds: [patterns[0]!, patterns[3]!, patterns[7]!, patterns[11]!].map(pattern => pattern.id), bypassOverallLimit: false, revision: 1, updatedAt: now },
  { id: 'visual-exam', name: 'Exam-style', patternIds: patterns.slice(0, 6).map(pattern => pattern.id), revision: 1, updatedAt: now },
  { id: 'visual-long-name', name: 'A very long reusable template name for checking that narrow cards wrap cleanly without causing horizontal overflow', patternIds: [...patterns.slice(6, 11).map(pattern => pattern.id), 'visual-missing-pattern'], revision: 1, updatedAt: now },
];
let nextTemplateId = 0;

function mount(node: HTMLElement, props: any, render: (props: any) => void) {
  let current = props;
  render(current);
  return { update(next: any) { current = { ...current, ...next }; render(current); }, dispose() { node.replaceChildren(); } };
}
const ctx = {
  call: async (name: string, input: any) => {
    visualCalls.push({ name, input });
    if (name === 'patterns-snapshot') return { patterns };
    if (name === 'templates-snapshot') return {
      templates: structuredClone(templates),
      exampleSummaries: [
        { id: 'visual-core', totalExamples: 5, availableExamples: 5, forcedExamples: 4, expectedExamples: 4, perPatternLimited: true, exceedsOverallLimit: true },
        { id: 'visual-math', totalExamples: 2, availableExamples: 2, forcedExamples: 0, expectedExamples: 1, perPatternLimited: true, exceedsOverallLimit: false },
        { id: 'visual-portuguese', totalExamples: 4, availableExamples: 4, forcedExamples: 2, expectedExamples: 4, perPatternLimited: false, exceedsOverallLimit: true },
        { id: 'visual-exam', totalExamples: 13, availableExamples: 13, forcedExamples: 4, expectedExamples: 11, perPatternLimited: true, exceedsOverallLimit: true },
        { id: 'visual-long-name', totalExamples: 0, availableExamples: 0, forcedExamples: 0, expectedExamples: 0, perPatternLimited: false, exceedsOverallLimit: false },
      ],
      overallExampleLimit: 3,
    };
    if (name === 'template-save') {
      const existing = templates.find(item => item.id === input.id);
      const id = existing?.id ?? `visual-template-${++nextTemplateId}`;
      const next: VisualTemplate = { id, name: input.name, patternIds: [...input.patternIds], bypassOverallLimit: input.bypassOverallLimit ?? existing?.bypassOverallLimit ?? true, isDefault: existing?.isDefault ?? false, revision: existing ? existing.revision + 1 : 1, updatedAt: now };
      if (existing) Object.assign(existing, next); else templates.push(next);
      return id;
    }
    if (name === 'template-default-set') {
      const existing = templates.find(item => item.id === input.id);
      if (!existing || input.expectedRevision !== existing.revision || typeof input.isDefault !== 'boolean') throw new Error('Template revision conflict.');
      existing.isDefault = input.isDefault;
      existing.revision++;
      return;
    }
    if (name === 'template-delete') {
      const index = templates.findIndex(item => item.id === input.id);
      if (index >= 0) templates.splice(index, 1);
      return;
    }
    if (name === 'pattern-delete') {
      const index = patterns.findIndex(item => item.id === input.id);
      if (index < 0 || patterns[index]!.revision !== input.expectedRevision) throw new Error('Pattern revision conflict.');
      patterns.splice(index, 1);
      for (const template of templates) template.patternIds = template.patternIds.filter(id => id !== input.id);
      return;
    }
    if (name === 'pattern-enabled-set') {
      const pattern = patterns.find(item => item.id === input.id);
      if (!pattern || typeof input.enabled !== 'boolean') throw new Error('Unexpected enabled payload.');
      pattern.enabled = input.enabled;
      return;
    }
    if (name === 'pattern-versions') return [];
    if (name === 'pattern-save') {
      const existing = patterns.find(item => item.id === input.id);
      const id = existing?.id ?? 'visual-pattern';
      const next = {
        ...(existing ?? { id, revision: 0, updatedAt: now, enabled: true, archived: false, tags: ['Visual'], analysisIds: [], activeAnalysisId: null, patternIds: [] }),
        ...structuredClone(input.content),
        tags: structuredClone(input.tags ?? existing?.tags ?? []),
        examples: input.examples !== undefined ? structuredClone(input.examples) : structuredClone(existing?.examples ?? []),
        exampleLimit: Object.hasOwn(input, 'exampleLimit') ? input.exampleLimit : existing?.exampleLimit ?? null,
        revision: (existing?.revision ?? 0) + 1, updatedAt: now,
      } as Pattern;
      if (existing) Object.assign(existing, next); else patterns.push(next);
      return id;
    }
    throw new Error(`Not implemented in preview: ${name}`);
  },
  onNotification: () => () => {}, onResync: () => () => {},
  ui: {
    mountButton(node: HTMLElement, props: any) {
      return mount(node, props, value => {
        node.dataset.pluginUiWidget = '';
        const button = document.createElement('button'); button.type = 'button'; button.className = `native-button native-${value.variant ?? 'default'}`;
        if (value.icon) {
          const icon = document.createElement('span'); icon.innerHTML = value.icon; icon.style.display = 'inline-flex';
          icon.querySelectorAll('svg').forEach(svg => { svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16'); });
          button.append(icon);
        }
        if (value.iconOnly) { button.setAttribute('aria-label', value.label); button.dataset.iconOnly = 'true'; }
        else button.append(document.createTextNode(value.label));
        if (value.title) button.title = value.title;
        button.disabled = !!value.disabled; button.onclick = () => void value.onClick(); node.replaceChildren(button);
      });
    },
    mountSettingsRows(node: HTMLElement, props: any) {
      return mount(node, props, value => {
        node.replaceChildren(...value.rows.map((row: any) => {
          const label = document.createElement('label'); label.className = 'native-settings-toggle';
          const text = document.createElement('span'); text.textContent = row.label;
          const input = document.createElement('input'); input.type = 'checkbox'; input.setAttribute('role', 'switch'); input.setAttribute('aria-label', row.label);
          input.checked = row.value; input.disabled = !!row.disabled;
          input.addEventListener('change', () => {
            void Promise.resolve().then(() => row.onChange(input.checked)).catch(() => { input.checked = row.value; });
          });
          label.append(text, input);
          return label;
        }));
      });
    },
    openDialog(props: any, options: any) {
      const element = document.createElement('dialog'); element.setAttribute('role', 'dialog'); element.setAttribute('aria-label', props.title); document.body.append(element);
      const hostDialog = document.createElement('div');
      hostDialog.setAttribute('data-plugin-ui-dialog', '');
      hostDialog.style.cssText = 'position:relative;width:min(44rem,calc(100vw - 2rem));max-height:85vh;overflow:hidden;display:flex;flex-direction:column';
      const close = document.createElement('button'); close.type = 'button'; close.setAttribute('aria-label', 'Close dialog'); close.textContent = '×';
      close.className = 'native-button native-ghost';
      close.style.cssText = 'position:absolute;top:12px;right:12px;min-width:32px;min-height:32px;padding:0;z-index:1';
      close.onclick = () => props.onClose?.();
      const scroll = document.createElement('div');
      scroll.setAttribute('data-plugin-ui-dialog-scroll', '');
      scroll.style.cssText = 'flex:1 1 auto;min-height:0;overflow-y:auto;padding:20px';
      const content = document.createElement('div'); scroll.append(content);
      hostDialog.append(close, scroll); element.append(hostDialog);
      const signal = new AbortController(); const cleanup = props.content(content, signal.signal);
      element.oncancel = () => props.onClose?.(); element.showModal();
      const dispose = () => { signal.abort(); cleanup?.(); element.remove(); };
      options.signal.addEventListener('abort', dispose, { once: true });
      return { update() {}, dispose };
    },
    openMenu(anchor: HTMLElement, props: any, options: any) {
      const menu = document.createElement('div'); menu.className = 'native-menu'; menu.setAttribute('role', 'menu');
      if (props.label) menu.setAttribute('aria-label', props.label);
      const rect = anchor.getBoundingClientRect(); menu.style.cssText = `position:fixed;right:${innerWidth - rect.right}px;top:${rect.bottom}px`;
      props.items.forEach((item: any) => {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'native-button native-ghost'; button.setAttribute('role', 'menuitem'); button.textContent = item.label;
        button.disabled = !!item.disabled; button.onclick = () => { menu.remove(); void item.onSelect(); }; menu.append(button);
      });
      document.body.append(menu); options.signal.addEventListener('abort', () => menu.remove(), { once: true });
      return { update() {}, dispose() { menu.remove(); } };
    },
  },
} as unknown as PluginFrontendContext;
const host = { ctx, signal: new AbortController().signal };
createRoot(document.getElementById('root')!).render(<Library host={host} />);
