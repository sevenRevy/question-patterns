import { useEffect, useId, useRef, useState } from 'react';
import type { AnalysisItem, AnalysisRun, PatternContent, Snapshot } from './domain';
import { compareItems, patternContent } from './domain';
import { BooleanSwitch, HostButton, type Host } from './host-ui';
import { date, message, type LibraryActions } from './library';

interface Detail { run: AnalysisRun; items: AnalysisItem[] }
export function proposalTitle(item: AnalysisItem) { return item.value.name; }

function structurePreview(structure: PatternContent['structure']) {
  return Object.entries(structure).map(([key, value]) => `${key.replaceAll('_', ' ')}: ${Array.isArray(value) ? value.join(', ') : String(value)}`).join(' · ');
}

function EvidenceDetails({ value, host, fullSource, onLoadSource, sourceLoading, sourceError }: {
  value: AnalysisItem['value']; host: Host; fullSource?: string | null; onLoadSource?: () => void; sourceLoading?: boolean; sourceError?: string;
}) {
  return <details className="qp-evidence"><summary>Evidence and source</summary><div className="qp-stack qp-inset">
    <p className="qp-meta">{value.support} support · {value.format.replaceAll('_', ' ')}</p>
    <blockquote className="qp-prewrap">{value.evidence ?? 'No supporting quote was supplied.'}</blockquote>
    <details className="qp-full-source" onToggle={event => { if (event.currentTarget.open) onLoadSource?.(); }}>
      <summary>View complete analysis input</summary>
      {sourceLoading ? <p role="status">Loading complete source…</p> : sourceError ? <p role="alert">{sourceError}</p> : fullSource !== null && fullSource !== undefined ? <pre className="qp-full-source-text">{fullSource}</pre> : <p className="qp-meta">Open to load the complete source.</p>}
    </details>
  </div></details>;
}

export function ProposalFields({ value, host, snapshot, fullSource, onLoadSource, sourceLoading, sourceError }: {
  value: AnalysisItem['value']; host: Host; snapshot?: Snapshot; fullSource?: string | null; onLoadSource?: () => void; sourceLoading?: boolean; sourceError?: string;
}) {
  const content = patternContent(value);
  const similar = value.similarPatternId ? snapshot?.patterns.find(pattern => pattern.id === value.similarPatternId) : undefined;
  const structure = structurePreview(content.structure);
  return <div className="qp-stack qp-pattern-content">
    <p className="qp-pattern-rule">{content.rule}</p>
    {content.reasoning.length ? <p className="qp-meta">Reasoning · {content.reasoning.map(task => task.replaceAll('_', ' ')).join(' · ')}</p> : null}
    {structure ? <details><summary>Structure</summary><p className="qp-meta qp-structure-preview">{structure}</p></details> : null}
    {similar && value.difference ? <p className="qp-reuse-note">Related to {similar.name}: {value.difference}</p> : null}
    <EvidenceDetails value={value} host={host} fullSource={fullSource} onLoadSource={onLoadSource} sourceLoading={sourceLoading} sourceError={sourceError} />
  </div>;
}

function ProposalEditor({ value, onChange, onValidityChange }: { value: PatternContent; onChange: (content: PatternContent) => void; onValidityChange: (valid: boolean) => void }) {
  const [structureText, setStructureText] = useState(() => JSON.stringify(value.structure, null, 2));
  const [reasoningText, setReasoningText] = useState(() => value.reasoning.join(', '));
  const [error, setError] = useState('');
  const update = (patch: Partial<PatternContent>) => onChange({ ...value, ...patch });
  const parseStructure = () => {
    try {
      const structure: unknown = JSON.parse(structureText);
      if (!structure || typeof structure !== 'object' || Array.isArray(structure)) throw new Error('Structure must be a JSON object.');
      onChange({ ...value, structure: structure as PatternContent['structure'], reasoning: reasoningText.split(',').map(task => task.trim()).filter(Boolean) });
      onValidityChange(true); setError(''); return true;
    } catch (cause) { onValidityChange(false); setError(message(cause)); return false; }
  };
  return <div className="qp-editor">
    <label>Name<input value={value.name} maxLength={160} onChange={event => update({ name: event.target.value })} /></label>
    <label>Presentation format<input value={value.format} maxLength={100} onChange={event => update({ format: event.target.value.toLowerCase().replace(/[^a-z0-9_-]+/g, '_') })} /></label>
    <label>Structural rule<textarea rows={2} maxLength={2000} value={value.rule} onChange={event => update({ rule: event.target.value })} /></label>
    <details><summary>Structure and reasoning</summary><label>Structure (JSON)<textarea rows={4} value={structureText} onChange={event => { setStructureText(event.target.value); try { const structure = JSON.parse(event.target.value); if (!structure || typeof structure !== 'object' || Array.isArray(structure)) throw new Error('Structure must be a JSON object.'); update({ structure }); onValidityChange(true); setError(''); } catch { onValidityChange(false); setError('Enter a valid JSON object to apply this edit.'); } }} onBlur={parseStructure} /></label><label>Reasoning (comma-separated)<input value={reasoningText} onChange={event => { setReasoningText(event.target.value); update({ reasoning: event.target.value.split(',').map(task => task.trim()).filter(Boolean) }); }} /></label></details>
    {error ? <p className="qp-error" role="alert">{error}</p> : null}
    <button type="button" className="qp-text-action" onClick={parseStructure}>Apply edits</button>
  </div>;
}

function decisionLabel(item: AnalysisItem) { return item.decision === 'accepted' ? 'Saved' : 'Rejected'; }

export function RunDetail({ run, snapshot, actions, technical = false }: { run: AnalysisRun; snapshot: Snapshot; actions: LibraryActions; technical?: boolean }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [baselineId, setBaselineId] = useState('');
  const [baseline, setBaseline] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [fullSource, setFullSource] = useState<string | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edited, setEdited] = useState<PatternContent | null>(null);
  const [editValid, setEditValid] = useState(true);
  const namespace = useId();
  const suggestions = useRef<HTMLDivElement>(null);
  useEffect(() => { if (selectedId) suggestions.current?.querySelector<HTMLButtonElement>('[aria-expanded="true"]')?.focus({ preventScroll: true }); }, [selectedId]);
  const comparable = snapshot.runs.filter(other => other.id !== run.id && other.targetId === run.targetId && other.targetKind === run.targetKind && other.status === 'succeeded');
  useEffect(() => {
    let live = true;
    actions.host.ctx.call<Detail>('run-detail', { id: run.id }).then(data => { if (live && !actions.host.signal.aborted) { setDetail(data); setError(''); } }).catch(cause => { if (live && !actions.host.signal.aborted) setError(message(cause)); });
    return () => { live = false; };
  }, [actions.host, run.id, run.status, run.completedAt]);
  useEffect(() => {
    let live = true; setBaseline(null);
    if (baselineId) actions.host.ctx.call<Detail>('run-detail', { id: baselineId }).then(data => { if (live && !actions.host.signal.aborted) setBaseline(data); }).catch(cause => { if (live && !actions.host.signal.aborted) setError(message(cause)); });
    return () => { live = false; };
  }, [actions.host, baselineId]);

  const items = detail?.items ?? [];
  const reviewQueue = items.filter(item => item.decision === 'candidate');
  const existingMatches = items.filter(item => item.automatic && item.appliedId);
  const reviewedPatterns = items.filter(item => item.decision !== 'candidate' && !item.automatic);
  const status = detail?.run.status ?? run.status;
  const differences = baseline ? compareItems(baseline.items, items) : [];

  const loadFullSource = async () => {
    if (fullSource !== null || sourceLoading) return;
    setSourceLoading(true); setSourceError('');
    try {
      const result = await actions.host.ctx.call<{ inputText: string }>('run-input', { id: run.id });
      if (!actions.host.signal.aborted) setFullSource(result.inputText);
    } catch (cause) { if (!actions.host.signal.aborted) setSourceError(message(cause)); }
    finally { if (!actions.host.signal.aborted) setSourceLoading(false); }
  };
  const refreshDecision = async (itemId: string) => {
    const next = await actions.host.ctx.call<Detail>('run-detail', { id: run.id });
    if (actions.host.signal.aborted) return;
    setDetail(next); setEditingId(null); setEdited(null); setEditValid(true);
    const remaining = next.items.filter(other => other.id !== itemId && other.decision === 'candidate');
    const position = next.items.findIndex(other => other.id === itemId);
    setSelectedId((remaining.find(other => next.items.indexOf(other) > position) ?? remaining[0])?.id ?? null);
    await actions.refresh();
  };
  const decide = async (item: AnalysisItem, decision: 'accepted' | 'rejected') => {
    setBusy(item.id); setError('');
    try {
      await actions.host.ctx.call('decide', { id: item.id, runId: run.id, decision });
      if (!actions.host.signal.aborted) await refreshDecision(item.id);
    } catch (cause) { if (!actions.host.signal.aborted) setError(message(cause)); }
    finally { if (!actions.host.signal.aborted) setBusy(null); }
  };
  const saveEditedPattern = async (item: AnalysisItem) => {
    if (!edited) return;
    setBusy(item.id); setError('');
    const content: PatternContent = { ...edited, name: edited.name.trim(), format: edited.format.trim(), rule: edited.rule.trim(), reasoning: edited.reasoning.map(task => task.trim()).filter(Boolean) };
    try {
      await actions.host.ctx.call('decide', { id: item.id, runId: run.id, decision: 'accepted', content });
      if (!actions.host.signal.aborted) await refreshDecision(item.id);
    } catch (cause) { if (!actions.host.signal.aborted) setError(message(cause)); }
    finally { if (!actions.host.signal.aborted) setBusy(null); }
  };

  return <div className="qp-stack qp-analysis">
    {technical ? <div><h2>Scan results</h2><p className="qp-meta">{run.targetTitle} · {date(run.createdAt)} · {status}</p></div> : null}
    {error || detail?.run.error ? <p role="alert" className="qp-error">{error || detail?.run.error}</p> : null}
    {!detail ? <p role="status">Loading results…</p> : status !== 'succeeded' ? <div className="qp-stack"><p className="qp-muted" role="status">{['starting', 'queued', 'running'].includes(status) ? `Analyzing with ${run.model.id}… You can keep browsing.` : `Scan ${status}. Earlier results remain available.`}</p>{technical && ['starting', 'queued', 'running'].includes(status) ? <HostButton host={actions.host} label="Cancel analysis" variant="outline" onClick={async () => { try { await actions.host.ctx.call('scan-cancel', { id: run.id }); await actions.refresh(); } catch (cause) { if (!actions.host.signal.aborted) setError(message(cause)); } }} /> : null}</div> : <section aria-label="Pattern suggestions" className="qp-stack qp-review">
      <div className="qp-review-bar"><h3>{existingMatches.length ? `${existingMatches.length} existing ${existingMatches.length === 1 ? 'match' : 'matches'} · ` : ''}{reviewQueue.length ? `${reviewQueue.length} new ${reviewQueue.length === 1 ? 'pattern' : 'patterns'} to review` : reviewedPatterns.length ? 'Review complete' : existingMatches.length ? 'No new patterns found' : 'No reusable structures found'}</h3></div>
      <div ref={suggestions} className="qp-review-items">{reviewQueue.map(item => {
        const open = selectedId === item.id;
        const value = patternContent(item.value);
        const editing = editingId === item.id;
        return <article key={item.id} className={`qp-review-item${open ? ' is-open' : ''}`}><button type="button" className="qp-review-item-toggle" aria-expanded={open} aria-controls={`${namespace}-pattern-${item.id}`} disabled={!!busy} onClick={() => setSelectedId(open ? null : item.id)}><span className="qp-chevron" aria-hidden="true">{open ? '⌄' : '›'}</span><span className="qp-review-item-title">{proposalTitle(item)}</span><span className="qp-state">New pattern</span></button>
          {open ? <section id={`${namespace}-pattern-${item.id}`} className="qp-proposal" aria-label="Selected pattern suggestion">{editing ? <><p className="qp-reuse-note">Save a reusable structure. Equivalent patterns are linked without changing their saved definitions.</p><ProposalEditor value={edited ?? value} onChange={setEdited} onValidityChange={setEditValid} /></> : <ProposalFields value={item.value} host={actions.host} snapshot={snapshot} fullSource={fullSource} onLoadSource={loadFullSource} sourceLoading={sourceLoading} sourceError={sourceError} />}{item.decision === 'candidate' ? <div className="qp-review-actions">{editing ? <><HostButton host={actions.host} label="Save new pattern" disabled={busy !== null || !editValid || !edited?.name.trim() || !edited?.format.trim() || !edited?.rule.trim()} onClick={() => void saveEditedPattern(item)} /><HostButton host={actions.host} label="Cancel edit" variant="ghost" disabled={busy !== null} onClick={() => { setEditingId(null); setEdited(null); setEditValid(true); }} /></> : <><HostButton host={actions.host} label="Approve pattern" disabled={busy !== null} onClick={() => void decide(item, 'accepted')} /><HostButton host={actions.host} label="Edit" variant="outline" disabled={busy !== null} onClick={() => { setEdited(value); setEditingId(item.id); setEditValid(true); }} /><HostButton host={actions.host} label="Reject" variant="ghost" disabled={busy !== null} onClick={() => void decide(item, 'rejected')} /></>}</div> : null}</section> : <div id={`${namespace}-pattern-${item.id}`} hidden />}
        </article>;
      })}</div>
      {existingMatches.length ? <details className="qp-supporting"><summary>{existingMatches.length} automatic existing {existingMatches.length === 1 ? 'match' : 'matches'}</summary><div className="qp-stack qp-inset">{existingMatches.map(item => { const pattern = snapshot.patterns.find(candidate => candidate.id === item.appliedId); return <details key={item.id}><summary>{pattern?.name ?? proposalTitle(item)}</summary><div className="qp-stack">{pattern ? <><p className="qp-pattern-rule">{pattern.rule}</p>{pattern.format !== 'any' || pattern.reasoning.length ? <p className="qp-meta">{[pattern.format !== 'any' ? pattern.format.replaceAll('_', ' ') : '', ...pattern.reasoning.map(task => task.replaceAll('_', ' '))].filter(Boolean).join(' · ')}</p> : null}</> : null}{pattern ? <HostButton host={actions.host} label="Open pattern" variant="ghost" onClick={() => actions.select({ kind: 'pattern', id: pattern.id })} /> : null}<EvidenceDetails value={item.value} host={actions.host} fullSource={fullSource} onLoadSource={loadFullSource} sourceLoading={sourceLoading} sourceError={sourceError} /></div></details>; })}</div></details> : null}
      {reviewedPatterns.length ? <details className="qp-supporting"><summary>{reviewedPatterns.length} reviewed suggestions</summary><div className="qp-stack qp-inset">{reviewedPatterns.map(item => <details key={item.id}><summary>{proposalTitle(item)} · {decisionLabel(item)}</summary><ProposalFields value={item.value} host={actions.host} snapshot={snapshot} fullSource={fullSource} onLoadSource={loadFullSource} sourceLoading={sourceLoading} sourceError={sourceError} /></details>)}</div></details> : null}
      <p className="qp-scan-caption">{run.model.id} · {date(run.createdAt)}{technical ? ' · Reviews do not alter the stored model result.' : ''}</p>
    </section>}
    {technical ? <>
      {status === 'succeeded' && comparable.length ? <details className="qp-section"><summary>Compare scans</summary><div className="qp-stack qp-inset"><label className="qp-field"><span>Compare against</span><select value={baselineId} onChange={event => setBaselineId(event.target.value)}><option value="">Choose a scan</option>{comparable.map(other => <option key={other.id} value={other.id}>{date(other.createdAt)} · {other.model.provider} / {other.model.id} · {other.inputRevision === run.inputRevision ? 'same input' : 'different input'}</option>)}</select></label>{baselineId && !baseline ? <p role="status">Loading comparison…</p> : null}{baseline ? <>{baseline.run.inputRevision !== run.inputRevision ? <p className="qp-notices">Different input revisions: changes may come from the source, not only the models.</p> : null}<div className="qp-boolean-field"><span>Include unchanged items</span><BooleanSwitch label="Include unchanged items" checked={showUnchanged} onChange={setShowUnchanged} /></div><p className="qp-meta">Matched by stable pattern key. Renamed patterns appear as additions or removals.</p>{differences.filter(diff => showUnchanged || diff.change !== 'unchanged').map(diff => <details key={diff.key} className="qp-diff"><summary>{diff.key} · {diff.change}</summary>{diff.fields.length ? <div className="qp-table-wrap"><table><caption>Before: {baseline.run.model.id} · After: {run.model.id}</caption><thead><tr><th scope="col">Field</th><th scope="col">Before</th><th scope="col">After</th></tr></thead><tbody>{diff.fields.map(field => <tr key={field}><th scope="row">{field}</th><td>{JSON.stringify((diff.before?.value as Record<string, unknown> | undefined)?.[field] ?? 'Not supplied')}</td><td>{JSON.stringify((diff.after?.value as Record<string, unknown> | undefined)?.[field] ?? 'Not supplied')}</td></tr>)}</tbody></table></div> : <p>Identical fields.</p>}</details>)}{!differences.some(diff => diff.change !== 'unchanged') ? <p>No result fields changed.</p> : null}</> : null}</div></details> : null}
      <details className="qp-section"><summary>Technical details</summary><div className="qp-stack qp-inset"><dl className="qp-metadata"><dt>Model</dt><dd>{run.model.provider} / {run.model.id}</dd><dt>Thinking</dt><dd>{run.model.thinkingLevel ?? 'Provider default'}</dd><dt>Created</dt><dd>{date(run.createdAt)}</dd><dt>Prompt version</dt><dd>{run.promptVersion}</dd><dt>Input revision</dt><dd>{run.inputRevision}</dd></dl>{run.instructions ? <div><h3>Additional instructions</h3><p className="qp-prewrap">{run.instructions}</p></div> : null}{detail ? <><details onToggle={event => { if (event.currentTarget.open) void loadFullSource(); }}><summary>Exact input material (read-only)</summary>{sourceLoading ? <p role="status">Loading complete input…</p> : sourceError ? <p role="alert">{sourceError}</p> : fullSource !== null ? <pre className="qp-full-source-text">{fullSource}</pre> : <p className="qp-meta">Open to load the complete source.</p>}</details>{detail.run.usage ? <details><summary>Recorded model usage</summary><pre className="qp-prewrap">{JSON.stringify(detail.run.usage, null, 2)}</pre></details> : <p className="qp-meta">Usage not reported. This does not mean the run was free.</p>}</> : null}</div></details>
    </> : null}
  </div>;
}
