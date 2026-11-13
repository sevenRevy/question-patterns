import type { PluginButtonProps, PluginDialogProps, PluginFrontendContext, PluginWidgetHandle } from 'learnharness-plugin-api';
import { createBooleanSwitch } from './boolean-switch';
import type { PatternTemplate, SessionPattern, TemplateExampleSummary, TemplatesSnapshot } from './domain';

type TemplateMode = 'add' | 'replace' | 'remove';
type FavoriteKind = 'pattern' | 'template';
type FavoritesSnapshot = { favorites: Array<{ kind: FavoriteKind; id: string }> };

function isExampleCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
function expectedExampleCount(template: PatternTemplate, summary: TemplateExampleSummary, overallLimit: number | undefined) {
  if (!isExampleCount(summary.expectedExamples)) return undefined;
  if (template.bypassOverallLimit !== false) return summary.expectedExamples;
  if (!isExampleCount(summary.forcedExamples) || !isExampleCount(overallLimit)) return undefined;
  return Math.max(summary.forcedExamples, Math.min(summary.expectedExamples, overallLimit));
}

const svg = (body: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const sessionPatternsIcon = svg('<path d="M5 6h14M5 12h14M5 18h14"/><path d="M8 4v4M15 10v4M11 16v4"/>');
const starIcon = svg('<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z"/>');
const typeIcons = {
  pattern: svg('<path d="M8 5h12M8 12h12M8 19h12M4 5h.01M4 12h.01M4 19h.01"/>'),
  template: svg('<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>'),
};

export function registerSessionPatterns(ctx: PluginFrontendContext) {
  let activeDialog: PluginWidgetHandle<PluginDialogProps> | undefined;
  const openPicker = (sessionId: string) => {
    activeDialog?.dispose();
    let dialog: PluginWidgetHandle<PluginDialogProps> | undefined;
    const clearActive = () => { if (activeDialog === dialog) activeDialog = undefined; };
    const close = () => { dialog?.dispose(); clearActive(); };
    dialog = ctx.ui.openDialog({
      title: 'Session patterns', onClose: close,
      content(container, signal) {
        const cleanup = mountSessionPatterns(ctx, container, signal, sessionId, close);
        return () => { cleanup(); clearActive(); };
      },
    }, { signal: ctx.signal });
    activeDialog = dialog;
  };
  ctx.registerAction({
    id: 'session-patterns', name: 'Session patterns', icon: sessionPatternsIcon,
    run(context) {
      if (context.surface !== 'session' || (context.kind !== 'teaching' && context.kind !== 'practice')) return;
      openPicker(context.sessionId);
    },
  });
  ctx.placeAction({ id: 'session-patterns-top-bar', actionId: 'session-patterns', location: 'top-bar', sessions: ['teaching', 'practice'] });
}

function mountSessionPatterns(ctx: PluginFrontendContext, container: HTMLElement, signal: AbortSignal, sessionId: string, close: () => void) {
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  };
  const button = (className: string, label: string, onClick: () => void) => {
    const node = element('button', className, label);
    node.type = 'button'; node.onclick = onClick;
    return node;
  };
  container.classList.add('qp-library', 'qp-session-patterns');
  const heading = element('h2', '', 'Session patterns');
  const tools = element('div', 'qp-search-tools qp-session-tools');
  const searchLabel = element('label', 'qp-search');
  searchLabel.append(element('span', 'qp-sr-only', 'Search patterns and templates'));
  const search = element('input');
  search.type = 'search'; search.placeholder = 'Search patterns and templates…';
  search.setAttribute('aria-label', 'Search patterns and templates');
  searchLabel.append(search);
  const favoritesFilter = button('qp-favorites-filter', 'Favorites', () => { favoritesOnly = !favoritesOnly; render(); });
  const filterIcon = element('span', 'qp-item-icon'); filterIcon.innerHTML = starIcon;
  favoritesFilter.prepend(filterIcon);
  favoritesFilter.setAttribute('aria-pressed', 'false');
  tools.append(searchLabel, favoritesFilter);
  const status = element('p', 'qp-meta'); status.setAttribute('role', 'status');
  const error = element('p', 'qp-error'); error.setAttribute('role', 'alert');
  const retries = element('div', 'qp-actions');
  const list = element('div', 'qp-feed'); list.setAttribute('aria-label', 'Patterns and templates');
  const empty = element('p', 'qp-muted'); empty.setAttribute('role', 'status');
  const closeSlot = element('div', 'qp-session-footer');
  container.append(heading, tools, status, error, retries, list, empty, closeSlot);

  let patterns: SessionPattern[] | undefined;
  let templates: PatternTemplate[] | undefined;
  let summaries: TemplateExampleSummary[] = [];
  let overallLimit: number | undefined;
  let favorites = new Set<string>();
  let favoritesLoaded = false;
  let favoritesOnly = false;
  let disposed = false;
  let writeVersion = 0;
  const readVersions = { patterns: 0, templates: 0, favorites: 0 };
  const loading = { patterns: true, templates: true, favorites: true };
  const errors = { patterns: '', templates: '', favorites: '', write: '', apply: '', favoriteWrite: '' };
  let busyApply: { templateId: string; mode: TemplateMode } | undefined;
  let failedApply: typeof busyApply;
  const pendingPatterns = new Map<string, boolean>();
  const pendingFavorites = new Set<string>();
  const expanded = new Set<string>();
  let operationQueue: Promise<void> = Promise.resolve();
  const handles = new Map<string, PluginWidgetHandle<PluginButtonProps>>();
  const alive = () => !disposed && !signal.aborted;
  const enqueue = <T,>(operation: () => Promise<T>) => {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.then(() => undefined, () => undefined);
    return result;
  };
  const reason = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
  const selected = (pattern: SessionPattern) => pendingPatterns.get(pattern.id) ?? pattern.selected;
  const matches = (pattern: SessionPattern, query: string) =>
    [pattern.name, pattern.rule, pattern.format, ...pattern.reasoning, ...pattern.tags].join(' ').toLocaleLowerCase().includes(query);
  const isFavorite = (kind: FavoriteKind, id: string) => favorites.has(`${kind}:${id}`);

  function favoriteButton(kind: FavoriteKind, id: string) {
    const control = button('qp-favorite', '', () => { void setFavorite(kind, id); });
    control.innerHTML = starIcon;
    return control;
  }
  function updateFavorite(control: HTMLButtonElement, kind: FavoriteKind, id: string, name: string) {
    const favorite = isFavorite(kind, id);
    const label = `${favorite ? 'Unfavorite' : 'Favorite'} ${name}`;
    control.setAttribute('aria-label', label); control.title = label;
    control.setAttribute('aria-pressed', String(favorite));
    control.disabled = !favoritesLoaded || pendingFavorites.has(`${kind}:${id}`);
  }
  function rowContent(kind: FavoriteKind) {
    const content = element('div', 'qp-pattern-content');
    const title = element('h3', 'qp-session-title');
    const icon = element('span', 'qp-item-icon'); icon.innerHTML = typeIcons[kind];
    icon.title = kind === 'template' ? 'Template' : 'Pattern';
    const name = element('span');
    title.append(icon, name);
    content.append(title);
    return { content, name };
  }
  type PatternRow = ReturnType<typeof createPatternRow>;
  function createPatternRow(id: string) {
    const root = element('div', 'qp-pattern-record qp-session-pattern'); root.dataset.patternId = id;
    const { content, name } = rowContent('pattern');
    const rule = element('p', 'qp-pattern-rule'); content.append(rule);
    const actions = element('div', 'qp-pattern-actions');
    const favorite = favoriteButton('pattern', id);
    const toggle = createBooleanSwitch({
      label: '', checked: false, disabled: true,
      onChange: value => { void setSelected(id, value); },
    });
    actions.append(favorite, toggle.element); root.append(content, actions);
    return { root, name, rule, favorite, toggle };
  }
  function updatePatternRow(row: PatternRow, pattern: SessionPattern) {
    row.name.textContent = pattern.name; row.rule.textContent = pattern.rule;
    const checked = selected(pattern);
    row.toggle.update({
      label: pattern.name, checked,
      disabled: loading.patterns || !!errors.patterns || pendingPatterns.has(pattern.id),
      title: `${checked ? 'Deselect' : 'Select'} ${pattern.name}`,
      onChange: value => { void setSelected(pattern.id, value); },
    });
    updateFavorite(row.favorite, 'pattern', pattern.id, pattern.name);
  }
  const standaloneRows = new Map<string, PatternRow>();
  const templateRows = new Map<string, ReturnType<typeof createTemplateRow>>();
  function createTemplateRow(id: string) {
    const root = element('section', 'qp-pattern-record qp-session-template'); root.dataset.templateId = id;
    const { content, name } = rowContent('template');
    const availability = element('p', 'qp-session-availability');
    const preview = element('p', 'qp-template-card-preview');
    content.append(availability, preview);
    const actions = element('div', 'qp-pattern-actions');
    const expand = button('qp-expand-template', '', () => {
      if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
      render();
    });
    expand.innerHTML = svg('<path d="m9 5 7 7-7 7"/>');
    const favorite = favoriteButton('template', id);
    const toggle = createBooleanSwitch({
      label: `Select template ${id}`, checked: false, disabled: true,
      onChange: checked => { void applyTemplate(id, checked ? 'add' : 'remove'); },
    });
    actions.append(expand, favorite, toggle.element);
    const details = element('div', 'qp-session-details'); details.id = `qp-session-template-${id}`;
    const members = element('div', 'qp-session-members');
    const meta = element('p', 'qp-meta');
    const limits = element('div');
    const replaceSlot = element('div');
    const replace = ctx.ui.mountButton(replaceSlot, {
      label: 'Use only these', variant: 'ghost', onClick: () => applyTemplate(id, 'replace'),
    }, { signal });
    details.append(members, meta, limits, replaceSlot);
    root.append(content, actions, details);
    return { root, name, availability, preview, expand, favorite, toggle, details, members, meta, limits, replace, memberRows: new Map<string, PatternRow>() };
  }
  function retry(key: string, label: string, show: boolean, onClick: () => void | Promise<void>) {
    const handle = handles.get(key);
    if (show && !handle) {
      const slot = element('div'); retries.append(slot);
      handles.set(key, ctx.ui.mountButton(slot, { label, variant: 'ghost', onClick }, { signal }));
    } else if (!show && handle) {
      handle.dispose(); handles.delete(key);
    }
  }
  function render() {
    if (!alive()) return;
    const query = search.value.trim().toLocaleLowerCase();
    favoritesFilter.setAttribute('aria-pressed', String(favoritesOnly));
    status.textContent = busyApply
      ? `${busyApply.mode === 'remove' ? 'Removing' : 'Applying'} “${templates?.find(item => item.id === busyApply?.templateId)?.name ?? 'template'}”…`
      : loading.patterns || loading.templates ? 'Loading session patterns…'
        : favoritesOnly && loading.favorites ? 'Loading favorites…' : '';
    error.textContent = Object.values(errors).filter(Boolean).join(' ');
    retry('patterns', 'Retry loading', !!errors.patterns, () => refreshPatterns(true));
    retry('templates', 'Retry loading templates', !!errors.templates, () => refreshTemplates(true));
    retry('favorites', 'Retry loading favorites', !!errors.favorites, () => refreshFavorites());
    retry('apply', 'Retry apply', !!failedApply, () => failedApply && applyTemplate(failedApply.templateId, failedApply.mode));

    // Templates reference the same pattern definitions, not a second set of session selections.
    const groupedIds = new Set(templates?.flatMap(template => template.patternIds) ?? []);
    const visible: HTMLElement[] = [];
    const available = patterns ?? [];
    for (const template of templates ?? []) {
      let row = templateRows.get(template.id);
      if (!row) { row = createTemplateRow(template.id); templateRows.set(template.id, row); }
      const eligible = available.filter(pattern => template.patternIds.includes(pattern.id));
      const nameMatch = template.name.toLocaleLowerCase().includes(query);
      const templateFavorite = isFavorite('template', template.id);
      const matchingMembers = eligible.filter(pattern => matches(pattern, query) && (!favoritesOnly || templateFavorite || isFavorite('pattern', pattern.id)));
      if ((!nameMatch && !matchingMembers.length) || (favoritesOnly && !templateFavorite && !matchingMembers.length)) continue;
      row.name.textContent = template.name;
      row.preview.textContent = eligible.slice(0, 3).map(pattern => pattern.name).join(' · ') + (eligible.length > 3 ? ` +${eligible.length - 3} more` : '');
      const allSelected = eligible.length > 0 && eligible.every(selected);
      const partiallySelected = !allSelected && eligible.some(selected);
      row.availability.textContent = `${eligible.length} of ${template.patternIds.length} patterns available${partiallySelected ? ' · Partially selected' : ''}`;
      const disabled = !patterns || loading.patterns || loading.templates || !!errors.patterns || !!errors.templates || !!busyApply || eligible.length === 0;
      row.toggle.update({
        label: `Select template ${template.name}`, checked: allSelected, disabled,
        title: partiallySelected ? `Select all available patterns in ${template.name}`
          : allSelected ? 'Deselect these patterns, including shared patterns' : 'Add these patterns to this session',
        onChange: checked => { void applyTemplate(template.id, checked ? 'add' : 'remove'); },
      });
      row.replace.update({ disabled });
      updateFavorite(row.favorite, 'template', template.id, template.name);
      const open = expanded.has(template.id) || (!!query && !nameMatch && matchingMembers.length > 0) || (favoritesOnly && !templateFavorite && matchingMembers.length > 0);
      row.expand.setAttribute('aria-expanded', String(open));
      row.expand.setAttribute('aria-controls', row.details.id);
      row.expand.setAttribute('aria-label', `${open ? 'Hide' : 'Show'} patterns in ${template.name}`);
      row.expand.title = `${open ? 'Hide' : 'Show'} patterns`;
      row.details.hidden = !open;
      const shownMembers = open ? (query && !nameMatch ? matchingMembers : eligible.filter(pattern => !favoritesOnly || templateFavorite || isFavorite('pattern', pattern.id))) : [];
      const memberNodes = shownMembers.map(pattern => {
        let member = row!.memberRows.get(pattern.id);
        if (!member) { member = createPatternRow(pattern.id); row!.memberRows.set(pattern.id, member); }
        updatePatternRow(member, pattern);
        return member.root;
      });
      syncChildren(row.members, memberNodes);
      const summary = summaries.find(item => item.id === template.id);
      const counts: string[] = [];
      if (summary && isExampleCount(summary.totalExamples)) counts.push(`${summary.totalExamples} saved ${summary.totalExamples === 1 ? 'example' : 'examples'}`);
      const expected = summary && expectedExampleCount(template, summary, overallLimit);
      if (expected !== undefined) counts.push(`${expected} expected from eligible patterns`);
      row.meta.textContent = counts.join(' · ');
      const messages: string[] = [];
      if (summary?.perPatternLimited) messages.push('Per-pattern sample limit applies.');
      if (summary?.exceedsOverallLimit) messages.push(template.bypassOverallLimit === false
        ? 'Overall limit exceeded; random examples are trimmed, but forced examples remain.'
        : 'Overall limit exceeded; template override on.');
      row.limits.replaceChildren(...messages.map(message => element('p', 'qp-template-limit', message)));
      visible.push(row.root);
    }
    for (const pattern of available) {
      if (groupedIds.has(pattern.id) || !matches(pattern, query) || (favoritesOnly && !isFavorite('pattern', pattern.id))) continue;
      let row = standaloneRows.get(pattern.id);
      if (!row) { row = createPatternRow(pattern.id); standaloneRows.set(pattern.id, row); }
      updatePatternRow(row, pattern); visible.push(row.root);
    }
    syncChildren(list, visible);
    empty.textContent = !loading.patterns && !loading.templates && !visible.length
      && (!favoritesOnly || (favoritesLoaded && !loading.favorites && !errors.favorites))
      ? query ? 'No matches. Try a different search.' : favoritesOnly ? 'No favorites yet. Star a pattern or template to keep it here.' : 'No patterns are available for this session.' : '';
    for (const [id, row] of templateRows) {
      if (templates?.some(template => template.id === id)) continue;
      row.replace.dispose(); row.root.remove(); templateRows.delete(id);
    }
  }
  // Keep existing controls mounted so saving or filtering does not discard keyboard focus.
  function syncChildren(parent: HTMLElement, desired: HTMLElement[]) {
    const keep = new Set(desired);
    for (const child of [...parent.children]) if (!keep.has(child as HTMLElement)) child.remove();
    desired.forEach((node, index) => { if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] ?? null); });
  }

  async function refreshPatterns(showLoading = false) {
    const version = writeVersion, read = ++readVersions.patterns;
    if (showLoading) { loading.patterns = true; errors.patterns = ''; render(); }
    await enqueue(async () => {
      if (!alive()) return;
      try {
        const result = await ctx.call<SessionPattern[]>('session-patterns', { sessionId });
        if (!alive() || version !== writeVersion || read !== readVersions.patterns) return;
        patterns = result; errors.patterns = '';
      } catch (cause) {
        if (!alive() || version !== writeVersion || read !== readVersions.patterns) return;
        errors.patterns = reason(cause);
      }
      loading.patterns = false; render();
    });
  }
  async function refreshTemplates(showLoading = false) {
    const read = ++readVersions.templates;
    if (showLoading) { loading.templates = true; errors.templates = ''; render(); }
    await enqueue(async () => {
      if (!alive()) return;
      try {
        const result = await ctx.call<TemplatesSnapshot>('templates-snapshot', {});
        if (!alive() || read !== readVersions.templates) return;
        templates = result.templates; summaries = result.exampleSummaries ?? []; overallLimit = result.overallExampleLimit;
        errors.templates = '';
      } catch (cause) {
        if (!alive() || read !== readVersions.templates) return;
        errors.templates = reason(cause);
      }
      loading.templates = false; render();
    });
  }
  async function refreshFavorites() {
    const read = ++readVersions.favorites;
    loading.favorites = true; errors.favorites = ''; render();
    await enqueue(async () => {
      if (!alive()) return;
      try {
        const result = await ctx.call<FavoritesSnapshot>('favorites-snapshot', {});
        if (!alive() || read !== readVersions.favorites) return;
        favorites = new Set(result.favorites.map(item => `${item.kind}:${item.id}`));
        favoritesLoaded = true; errors.favorites = '';
      } catch (cause) {
        if (!alive() || read !== readVersions.favorites) return;
        errors.favorites = reason(cause);
      }
      loading.favorites = false; render();
    });
  }
  function setSelected(patternId: string, value: boolean) {
    if (!alive() || pendingPatterns.has(patternId)) return Promise.resolve();
    writeVersion++; pendingPatterns.set(patternId, value); errors.write = ''; render();
    return enqueue(async () => {
      if (!alive()) return;
      try {
        patterns = await ctx.call<SessionPattern[]>('session-pattern-set', { sessionId, patternId, selected: value });
        if (!alive()) return;
        loading.patterns = false; errors.patterns = '';
      } catch (cause) {
        if (alive()) {
          errors.write = `Could not update this session pattern: ${reason(cause)}`;
          // A write invalidates older reads even if it fails; recover authoritative state.
          void refreshPatterns();
        }
      } finally {
        pendingPatterns.delete(patternId); render();
      }
    });
  }
  function applyTemplate(templateId: string, mode: TemplateMode) {
    if (!alive() || busyApply || !patterns || loading.patterns || loading.templates || errors.patterns || errors.templates) return Promise.resolve();
    const operation = { templateId, mode };
    busyApply = operation; failedApply = undefined; errors.apply = ''; writeVersion++; render();
    return enqueue(async () => {
      if (!alive()) return;
      try {
        const result = await ctx.call<SessionPattern[]>('session-template-apply', { sessionId, templateId, mode });
        if (!alive()) return;
        patterns = result; loading.patterns = false; errors.patterns = ''; errors.write = '';
      } catch (cause) {
        if (!alive()) return;
        failedApply = operation; errors.apply = `Could not apply this template: ${reason(cause)}`;
        void refreshPatterns();
      } finally {
        busyApply = undefined; render();
      }
    });
  }
  function setFavorite(kind: FavoriteKind, id: string) {
    const key = `${kind}:${id}`;
    if (!alive() || !favoritesLoaded || pendingFavorites.has(key)) return Promise.resolve();
    const favorite = !favorites.has(key);
    pendingFavorites.add(key); errors.favoriteWrite = ''; readVersions.favorites++; render();
    return enqueue(async () => {
      if (!alive()) return;
      try {
        const result = await ctx.call<FavoritesSnapshot>('favorite-set', { kind, id, favorite });
        if (!alive()) return;
        favorites = new Set(result.favorites.map(item => `${item.kind}:${item.id}`));
      } catch (cause) {
        if (alive()) errors.favoriteWrite = `Could not save favorite: ${reason(cause)}`;
      } finally {
        pendingFavorites.delete(key); render();
      }
    });
  }
  let scheduled = false, refreshLibrary = false;
  const scheduleRefresh = (library = false) => {
    if (!alive()) return;
    refreshLibrary ||= library;
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!alive()) return;
      const all = refreshLibrary; refreshLibrary = false;
      void refreshPatterns();
      if (all) { void refreshTemplates(); void refreshFavorites(); }
    });
  };
  const unsubscribeNotification = ctx.onNotification(event => {
    if (event.topic === 'library-changed') scheduleRefresh(true);
    if (event.topic === 'session-patterns-changed' && (event.data as { sessionId?: unknown } | undefined)?.sessionId === sessionId) scheduleRefresh();
  });
  const unsubscribeResync = ctx.onResync(() => scheduleRefresh(true));
  const closeButton = ctx.ui.mountButton(closeSlot, { label: 'Close', variant: 'ghost', onClick: close }, { signal });
  search.oninput = render;
  void refreshPatterns(true); void refreshTemplates(true); void refreshFavorites();
  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribeNotification(); unsubscribeResync();
    for (const handle of handles.values()) handle.dispose();
    for (const row of templateRows.values()) row.replace.dispose();
    closeButton.dispose();
  };
}
