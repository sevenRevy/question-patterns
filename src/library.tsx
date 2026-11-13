import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Pattern, PatternsSnapshot } from './domain';
import { BooleanSwitch, Dialog, HostButton, TRASH_ICON, type Host } from './host-ui';
import { PatternEditor } from './records';
import { TemplateLibrary } from './templates';

export type Selection = { kind: 'source' | 'pattern'; id: string } | { kind: 'run'; id: string } | null;
export type LibraryActions = { host: Host; refresh: () => Promise<void>; select: (selection: Selection) => void; report: (error: unknown) => void };
export const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export const date = (value: string) => new Date(value).toLocaleString();

function PatternScope({ actions, children }: { actions: LibraryActions; children: (actions: LibraryActions) => ReactNode }) {
  const [controller] = useState(() => new AbortController());
  const parent = actions.host;
  const host = useMemo(() => ({ ctx: parent.ctx, signal: controller.signal }), [parent.ctx, controller]);
  useLayoutEffect(() => {
    const abort = () => controller.abort();
    if (parent.signal.aborted) abort();
    else parent.signal.addEventListener('abort', abort, { once: true });
    return () => { parent.signal.removeEventListener('abort', abort); controller.abort(); };
  }, [parent.signal, controller]);
  return <>{children({ ...actions, host,
    refresh: async () => { if (!host.signal.aborted) await actions.refresh(); },
    select: selection => { if (!host.signal.aborted) actions.select(selection); },
    report: error => { if (!host.signal.aborted) actions.report(error); },
  })}</>;
}

function PatternItem({ pattern, actions }: { pattern: Pattern; actions: LibraryActions }) {
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const pending = useRef(false);
  const setEnabled = async (enabled: boolean) => {
    if (actions.host.signal.aborted || pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await actions.host.ctx.call('pattern-enabled-set', { id: pattern.id, enabled });
      await actions.refresh();
    } catch (cause) {
      actions.report(cause);
    } finally {
      pending.current = false;
      if (!actions.host.signal.aborted) setBusy(false);
    }
  };
  const remove = async () => {
    if (actions.host.signal.aborted || pending.current) return;
    pending.current = true; setBusy(true);
    try {
      await actions.host.ctx.call('pattern-delete', { id: pattern.id, expectedRevision: pattern.revision });
      await actions.refresh();
    } catch (cause) {
      actions.report(cause);
    } finally {
      pending.current = false;
      if (!actions.host.signal.aborted) setBusy(false);
    }
  };
  return <section className="qp-pattern-record" aria-labelledby={`pattern-name-${pattern.id}`}>
    <div className="qp-pattern-content">
      <h2 id={`pattern-name-${pattern.id}`}>{pattern.name}</h2>
      <p className="qp-pattern-rule">{pattern.rule}</p>
      {pattern.archived ? <p className="qp-meta">Archived</p> : null}
    </div>
    <div className="qp-pattern-actions">
      <HostButton host={actions.host} label="Edit pattern" variant="ghost" disabled={pattern.archived || busy || deleting} onClick={() => actions.select({ kind: 'pattern', id: pattern.id })} />
      <HostButton host={actions.host} label={`Delete pattern: ${pattern.name}`} title={`Delete pattern: ${pattern.name}`}
        icon={TRASH_ICON} iconOnly size="icon-sm" variant="ghost" disabled={busy || deleting}
        onClick={() => setDeleting(true)} />
      <BooleanSwitch label="Default for new sessions" checked={pattern.enabled} disabled={pattern.archived || busy || deleting}
        describedBy={`pattern-name-${pattern.id}`} title={`${pattern.enabled ? 'Default for new sessions' : 'Not a default'}: ${pattern.name}`}
        onChange={enabled => { void setEnabled(enabled); }} />
    </div>
    {deleting ? <div className="qp-delete-confirm">
      <p>Delete “{pattern.name}” permanently? Its examples and history will be deleted, and it will be removed from templates and sessions.</p>
      <div className="qp-actions">
        <HostButton host={actions.host} label="Delete pattern" variant="outline" disabled={busy} onClick={remove} />
        <HostButton host={actions.host} label="Cancel" variant="ghost" disabled={busy} onClick={() => setDeleting(false)} />
      </div>
    </div> : null}
  </section>;
}

export function Library({ host }: { host: Host }) {
  const [snapshot, setSnapshot] = useState<PatternsSnapshot | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [tab, setTab] = useState<'patterns' | 'templates'>('patterns');
  const tabId = useId();
  const tabButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const [overlay, setOverlay] = useState<'new-pattern' | { id: string } | null>(null);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const ticket = ++request.current;
    try {
      const data = await host.ctx.call<PatternsSnapshot>('patterns-snapshot', {});
      if (!host.signal.aborted && ticket === request.current) { setSnapshot(data); setError(''); }
    } catch (cause) { if (!host.signal.aborted && ticket === request.current) setError(message(cause)); }
  }, [host]);
  useEffect(() => {
    let scheduled = false;
    const reload = () => {
      if (scheduled || host.signal.aborted) return;
      scheduled = true;
      queueMicrotask(() => { scheduled = false; if (!host.signal.aborted) void refresh(); });
    };
    void refresh();
    const notification = host.ctx.onNotification(event => { if (event.topic === 'library-changed') reload(); });
    const resync = host.ctx.onResync(reload);
    return () => { request.current++; notification(); resync(); };
  }, [host, refresh]);
  const select = (next: Selection) => {
    if (next === null) setOverlay(null);
    else if (next.kind === 'pattern') setOverlay({ id: next.id });
  };
  const actions: LibraryActions = { host, refresh, select, report: value => setError(message(value)) };
  const query = search.toLocaleLowerCase();
  const matches = (parts: unknown[]) => parts.join(' ').toLocaleLowerCase().includes(query);
  const patterns = snapshot?.patterns.filter(pattern =>
    (filter === 'archived' ? pattern.archived : !pattern.archived)
    && matches([pattern.name, pattern.format, pattern.rule, ...pattern.reasoning, JSON.stringify(pattern.structure), ...pattern.tags])
    && (filter !== 'enabled' || pattern.enabled)
    && (filter !== 'disabled' || !pattern.enabled)) ?? [];
  const patternCount = snapshot?.patterns.filter(pattern => !pattern.archived).length ?? 0;
  const editingPattern = overlay && overlay !== 'new-pattern' ? snapshot?.patterns.find(pattern => pattern.id === overlay.id) : undefined;
  const close = () => setOverlay(null);

  return <div className="qp-library"><div className="qp-page">
    <div className="qp-view-tabs" role="tablist" aria-label="Pattern library views">
      {(['patterns', 'templates'] as const).map((value, index) => <button key={value} type="button" role="tab"
        id={`${tabId}-${value}-tab`} aria-controls={`${tabId}-${value}-panel`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1}
        ref={element => { tabButtons.current[index] = element; }} onClick={() => setTab(value)} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
          setTab(next ? 'templates' : 'patterns'); tabButtons.current[next]?.focus();
        }}>{value === 'patterns' ? 'Patterns' : 'Templates'}</button>)}
    </div>
    <div id={`${tabId}-patterns-panel`} role="tabpanel" aria-labelledby={`${tabId}-patterns-tab`} hidden={tab !== 'patterns'}>
    <header className="qp-page-header">
      <div><p className="qp-meta">{snapshot ? `${patternCount} patterns` : 'Question pattern library'}</p><p className="qp-meta">Defaults are selected once when a session first uses patterns.</p></div>
      <HostButton host={host} label="New pattern" variant="outline" onClick={() => setOverlay('new-pattern')} />
    </header>
    <div className="qp-collection-tools">
      <div className="qp-search-tools">
        <label className="qp-search"><span className="qp-sr-only">Search patterns</span><input type="search" placeholder="Search patterns…" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <label className="qp-field"><span className="qp-sr-only">Filter patterns</span><select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All patterns</option><option value="enabled">Defaults</option><option value="disabled">Not default</option><option value="archived">Archived</option></select></label>
      </div>
    </div>
    {error ? <div className="qp-error" role="alert"><span>{error}</span><HostButton host={host} label="Retry loading" variant="ghost" onClick={refresh} /></div> : null}
    <main aria-label="Patterns" className="qp-feed">
      {!snapshot ? <p role="status">{error ? 'Library unavailable.' : 'Loading local library…'}</p> : !patterns.length ? <div className="qp-empty"><h2>{search || filter !== 'all' ? 'No matches' : 'Keep the patterns that work'}</h2><p className="qp-muted">{search || filter !== 'all' ? 'Try a different search or clear the filter.' : 'Create your first pattern to build reusable question guidance.'}</p>{search || filter !== 'all' ? <HostButton host={host} label="Clear filters" variant="ghost" onClick={() => { setSearch(''); setFilter('all'); }} /> : null}</div> : patterns.map(pattern =>
        <PatternScope key={pattern.id} actions={actions}>{scoped => <PatternItem pattern={pattern} actions={scoped} />}</PatternScope>)}
    </main>
    {overlay ? <Dialog key={overlay === 'new-pattern' ? overlay : overlay.id} host={host} title={overlay === 'new-pattern' ? 'New pattern' : 'Edit pattern'} onClose={close}>{dialogHost => {
      const scoped: LibraryActions = { ...actions, host: dialogHost,
        select: () => { if (!dialogHost.signal.aborted) close(); },
        refresh: async () => { if (!dialogHost.signal.aborted) await refresh(); },
        report: value => { if (!dialogHost.signal.aborted) actions.report(value); },
      };
      return overlay === 'new-pattern' || editingPattern ? <PatternEditor actions={scoped} pattern={editingPattern} onSaved={close} /> : <p role="alert">Pattern unavailable.</p>;
    }}</Dialog> : null}
    </div>
    <div id={`${tabId}-templates-panel`} role="tabpanel" aria-labelledby={`${tabId}-templates-tab`} hidden={tab !== 'templates'}>
      {tab === 'templates' ? snapshot ? <TemplateLibrary host={host} patterns={snapshot.patterns} /> : error
        ? <div className="qp-error" role="alert"><span>{error}</span><HostButton host={host} label="Retry loading" variant="ghost" onClick={refresh} /></div>
        : <p role="status">Loading patterns…</p> : null}
    </div>
  </div></div>;
}
