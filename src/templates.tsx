import { useCallback, useEffect, useRef, useState } from 'react';
import type { Pattern, PatternTemplate, TemplateExampleSummary, TemplatesSnapshot } from './domain';
import { DEFAULT_OVERALL_EXAMPLE_LIMIT, DEFAULT_PATTERN_EXAMPLE_LIMIT } from './domain';
import { BooleanSwitch, Dialog, Field, HostButton, TRASH_ICON, type Host } from './host-ui';
import { message } from './library';

function TemplateEditor({ host, patterns, template, overallLimit, onSaved }: {
  host: Host; patterns: Pattern[]; template?: PatternTemplate; overallLimit: number; onSaved: () => void;
}) {
  const [name, setName] = useState(template?.name ?? '');
  const [members, setMembers] = useState(() => new Set(template?.patternIds ?? []));
  const [search, setSearch] = useState('');
  const [bypassOverallLimit, setBypassOverallLimit] = useState(template?.bypassOverallLimit ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  // Keep unavailable saved references unless the learner explicitly removes them.
  const available = patterns.filter(pattern => !pattern.archived);
  const shown = available.filter(pattern => pattern.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const unavailable = [...members].filter(id => !available.some(pattern => pattern.id === id));
  const selectedPatterns = patterns.filter(pattern => members.has(pattern.id));
  const savedExamples = selectedPatterns.reduce((sum, pattern) => sum + (pattern.examples?.length ?? 0), 0);
  const eligiblePatterns = selectedPatterns.filter(pattern => !pattern.archived);
  const forcedExamples = eligiblePatterns.reduce((sum, pattern) => sum + (pattern.examples?.filter(example => example.forced).length ?? 0), 0);
  const expectedExamples = eligiblePatterns.reduce((sum, pattern) => sum + Math.max(
    pattern.examples?.filter(example => example.forced).length ?? 0,
    Math.min(pattern.examples?.length ?? 0, pattern.exampleLimit ?? DEFAULT_PATTERN_EXAMPLE_LIMIT)), 0);
  const deliveredExamples = bypassOverallLimit ? expectedExamples : Math.max(forcedExamples, Math.min(expectedExamples, overallLimit));
  const toggle = (id: string, selected: boolean) => setMembers(previous => {
    const next = new Set(previous);
    if (selected) next.add(id); else next.delete(id);
    return next;
  });
  const save = async () => {
    if (pending.current || host.signal.aborted) return;
    pending.current = true; setBusy(true); setError('');
    try {
      await host.ctx.call('template-save', {
        ...(template ? { id: template.id, expectedRevision: template.revision } : {}),
        name: name.trim(), patternIds: [...members], bypassOverallLimit,
      });
      if (!host.signal.aborted) onSaved();
    } catch (cause) {
      if (!host.signal.aborted) setError(message(cause));
    } finally {
      pending.current = false;
      if (!host.signal.aborted) setBusy(false);
    }
  };
  return <section className="qp-stack">
    <h2>{template ? 'Edit template' : 'New template'}</h2>
    <p className="qp-muted">Group patterns for bulk use in sessions. Saving a template does not change existing session selections.</p>
    <Field label="Name"><input value={name} maxLength={160} disabled={busy} placeholder="Math, Portuguese, Exam-style…" onChange={event => setName(event.target.value)} /></Field>
    <p className="qp-meta" role="status">{members.size} patterns selected · {savedExamples} saved examples · up to {deliveredExamples} examples per call</p>
    <div className="qp-boolean-field"><span>Bypass overall example limit</span><BooleanSwitch label="Bypass overall example limit" checked={bypassOverallLimit} disabled={busy} onChange={setBypassOverallLimit} /></div>
    <p className="qp-meta">On by default. Per-pattern limits still apply. Forced examples always bypass both limits.</p>
    {expectedExamples > overallLimit ? <p className="qp-template-limit">Exceeds overall limit of {overallLimit}: {bypassOverallLimit ? 'template override on' : 'random examples will be capped; forced examples still included'}.</p> : null}
    <div className="qp-actions">
      <HostButton host={host} label="Select all shown" variant="ghost" disabled={busy || !shown.length} onClick={() => setMembers(previous => new Set([...previous, ...shown.map(pattern => pattern.id)]))} />
      <HostButton host={host} label="Clear selection" variant="ghost" disabled={busy || !members.size} onClick={() => setMembers(new Set())} />
    </div>
    <div className="qp-template-picker">
    <Field label="Search patterns"><input type="search" value={search} disabled={busy} onChange={event => setSearch(event.target.value)} /></Field>
    <fieldset className="qp-template-members" disabled={busy}>
      <legend className="qp-sr-only">Template patterns</legend>
      {!available.length ? <p className="qp-muted">Create patterns in the Patterns tab first.</p> : !shown.length ? <p className="qp-muted">No matching patterns.</p> : shown.map(pattern => {
        const label = pattern.name;
        return <div className="qp-boolean-field" key={pattern.id}><span>{label}</span><BooleanSwitch label={label} checked={members.has(pattern.id)} disabled={busy} onChange={selected => toggle(pattern.id, selected)} /></div>;
      })}
      {unavailable.map(id => {
        const label = `${patterns.find(pattern => pattern.id === id)?.name ?? id} — unavailable`;
        return <div className="qp-boolean-field" key={id}><span>{label}</span><BooleanSwitch label={label} checked disabled={busy} onChange={selected => toggle(id, selected)} /></div>;
      })}
    </fieldset>
    </div>
    <p className="qp-meta">A pattern can belong to several templates.</p>
    {error ? <p className="qp-error" role="alert">{error}</p> : null}
    <div className="qp-actions"><HostButton host={host} label={busy ? 'Saving…' : 'Save template'} disabled={busy || !name.trim() || !members.size} onClick={save} /></div>
  </section>;
}

export function TemplateLibrary({ host, patterns }: { host: Host; patterns: Pattern[] }) {
  const [templates, setTemplates] = useState<PatternTemplate[] | null>(null);
  const [exampleSummaries, setExampleSummaries] = useState<TemplateExampleSummary[]>([]);
  const [overallLimit, setOverallLimit] = useState(DEFAULT_OVERALL_EXAMPLE_LIMIT);
  const [error, setError] = useState('');
  const [overlay, setOverlay] = useState<'new' | PatternTemplate | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const request = useRef(0);
  const active = useRef(true);
  const refresh = useCallback(async () => {
    const ticket = ++request.current;
    try {
      const result = await host.ctx.call<TemplatesSnapshot>('templates-snapshot', {});
      if (active.current && !host.signal.aborted && ticket === request.current) {
        setTemplates(result.templates); setExampleSummaries(result.exampleSummaries ?? []);
        setOverallLimit(result.overallExampleLimit ?? DEFAULT_OVERALL_EXAMPLE_LIMIT); setError('');
      }
    } catch (cause) {
      if (active.current && !host.signal.aborted && ticket === request.current) setError(message(cause));
    }
  }, [host]);
  useEffect(() => {
    active.current = true;
    let scheduled = false;
    const reload = () => {
      if (scheduled || !active.current || host.signal.aborted) return;
      scheduled = true;
      queueMicrotask(() => { scheduled = false; if (active.current && !host.signal.aborted) void refresh(); });
    };
    void refresh();
    const notification = host.ctx.onNotification(event => { if (event.topic === 'library-changed') reload(); });
    const resync = host.ctx.onResync(reload);
    return () => { active.current = false; request.current++; notification(); resync(); };
  }, [host, refresh]);
  const setDefault = async (template: PatternTemplate) => {
    if (pending.current || host.signal.aborted) return;
    pending.current = true; setBusy(true); setError('');
    try {
      await host.ctx.call('template-default-set', {
        id: template.id, expectedRevision: template.revision, isDefault: template.isDefault !== true,
      });
      if (!active.current || host.signal.aborted) return;
      await refresh();
    } catch (cause) {
      if (active.current && !host.signal.aborted) setError(message(cause));
    } finally {
      pending.current = false;
      if (active.current && !host.signal.aborted) setBusy(false);
    }
  };
  const remove = async (template: PatternTemplate) => {
    if (pending.current || host.signal.aborted) return;
    pending.current = true; setBusy(true); setError('');
    try {
      await host.ctx.call('template-delete', { id: template.id, expectedRevision: template.revision });
      if (!active.current || host.signal.aborted) return;
      setDeleting(null); await refresh();
    } catch (cause) {
      if (active.current && !host.signal.aborted) setError(message(cause));
    } finally {
      pending.current = false;
      if (active.current && !host.signal.aborted) setBusy(false);
    }
  };
  const close = () => setOverlay(null);
  return <div className="qp-stack qp-template-library">
    <header className="qp-page-header">
      <div><h2>Templates</h2><p className="qp-meta">Save named pattern groups, then use them in teaching or practice sessions.</p></div>
      <HostButton host={host} label="New template" variant="outline" disabled={busy || templates === null} onClick={() => setOverlay('new')} />
    </header>
    {error ? <div className="qp-error" role="alert"><span>{error}</span><HostButton host={host} label="Retry loading templates" variant="ghost" disabled={busy} onClick={refresh} /></div> : null}
    {!templates ? <p role="status">{error ? 'Templates unavailable.' : 'Loading templates…'}</p> : !templates.length ? <div className="qp-empty"><h3>No templates yet</h3><p className="qp-muted">Create a group such as Math, Portuguese, or Exam-style and select its patterns.</p></div> : <div className="qp-feed qp-template-list" aria-label="Templates">
      {templates.map(template => {
        const eligible = template.patternIds.filter(id => patterns.some(pattern => pattern.id === id && !pattern.archived)).length;
        const summary = exampleSummaries.find(item => item.id === template.id);
        const bypass = template.bypassOverallLimit ?? true;
        const delivered = summary ? bypass ? summary.expectedExamples : Math.max(summary.forcedExamples, Math.min(summary.expectedExamples, overallLimit)) : 0;
        const unavailable = template.patternIds.length - eligible;
        const preview = template.patternIds.slice(0, 3).map(id => {
          const pattern = patterns.find(item => item.id === id);
          return `${pattern?.name ?? 'Unavailable pattern'}${pattern?.archived ? ' — unavailable' : ''}`;
        }).join(' · ');
        return <section key={template.id} className="qp-pattern-record qp-template-record" aria-label={template.name}>
          <div className="qp-pattern-content">
            <h3 className="qp-template-title"><svg className="qp-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5" /></svg><span>{template.name}</span></h3>
            <p className="qp-meta">{template.patternIds.length} {template.patternIds.length === 1 ? 'pattern' : 'patterns'}{summary ? ` · ${summary.totalExamples} saved ${summary.totalExamples === 1 ? 'example' : 'examples'}` : ''}{unavailable ? ` · ${unavailable} unavailable` : ''}</p>
            <p className="qp-template-preview">{preview || 'No patterns in this template.'}{template.patternIds.length > 3 ? ` +${template.patternIds.length - 3} more` : ''}</p>
            {summary?.perPatternLimited ? <p className="qp-template-limit">Per-pattern limits reduce the sample.</p> : null}
            {summary && summary.forcedExamples > overallLimit
              ? <p className="qp-template-limit">{summary.forcedExamples} forced examples exceed the overall limit of {overallLimit}.</p>
              : summary?.exceedsOverallLimit && !bypass ? <p className="qp-template-limit">Example sample capped at {delivered} per call.</p> : null}
          </div>
          {deleting === template.id ? <div className="qp-template-confirm">
            <p>Delete template? Patterns and session selections will be kept.</p>
            <div className="qp-actions"><HostButton host={host} label="Delete template" variant="outline" disabled={busy} onClick={() => remove(template)} /><HostButton host={host} label="Cancel" variant="ghost" disabled={busy} onClick={() => setDeleting(null)} /></div>
          </div> : <div className="qp-actions qp-template-actions">
            <button type="button" className="qp-template-default" aria-label={`Default template: ${template.name}`}
              aria-pressed={template.isDefault === true}
              title={template.isDefault === true ? 'Selected as default for new sessions only. Click to unset.' : 'Set as default template for new sessions only.'}
              disabled={busy} onClick={() => { void setDefault(template); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m16 3 5 5-4 1-4 4-1 5-1 1-1-1 1-5-4-4-3-1 5-5 7 0Z" fill={template.isDefault === true ? 'currentColor' : 'none'} />
                <path d="m10 14-6 6" />
              </svg>
            </button>
            <HostButton host={host} label="Edit template" variant="ghost" disabled={busy} onClick={() => setOverlay(template)} />
            <HostButton host={host} label={`Delete template: ${template.name}`} icon={TRASH_ICON} iconOnly size="icon-sm" title={`Delete template: ${template.name}`} variant="ghost" disabled={busy} onClick={() => setDeleting(template.id)} />
          </div>}
        </section>;
      })}
    </div>}
    {overlay ? <Dialog host={host} title={overlay === 'new' ? 'New template' : 'Edit template'} onClose={close}>{dialogHost =>
      <TemplateEditor host={dialogHost} patterns={patterns} template={overlay === 'new' ? undefined : overlay} overallLimit={overallLimit} onSaved={() => { close(); void refresh(); }} />}</Dialog> : null}
  </div>;
}
