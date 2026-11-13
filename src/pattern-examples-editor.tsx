import type { PatternExample } from './domain';
import { DEFAULT_PATTERN_EXAMPLE_LIMIT } from './domain';
import { BooleanSwitch, Field, HostButton, type Host } from './host-ui';

export function parseExampleLimit(value: string): number | null | undefined {
  if (!value.trim()) return null;
  const limit = Number(value);
  return Number.isInteger(limit) && limit >= 0 && limit <= 1000 ? limit : undefined;
}

export function PatternExamplesEditor({ host, examples, onChange, limitText, onLimitChange, disabled }: {
  host: Host; examples: PatternExample[]; onChange: (examples: PatternExample[]) => void;
  limitText: string; onLimitChange: (value: string) => void; disabled: boolean;
}) {
  const limit = parseExampleLimit(limitText);
  const effectiveLimit = limit ?? DEFAULT_PATTERN_EXAMPLE_LIMIT;
  const forced = examples.filter(example => example.forced).length;
  const expected = Math.max(forced, Math.min(examples.length, effectiveLimit));
  const update = (id: string, patch: Partial<PatternExample>) => onChange(examples.map(example => example.id === id ? { ...example, ...patch } : example));
  return <section className="qp-stack" aria-label="Examples">
    <div><h3>Examples</h3><p className="qp-meta">Save full questions to illustrate this structure. Include answer choices, answers or explanations when useful. The AI should adapt the structure, not copy the topic.</p></div>
    <Field label="Example limit per call"><input type="number" min={0} max={1000} step={1} placeholder={String(DEFAULT_PATTERN_EXAMPLE_LIMIT)} value={limitText} disabled={disabled} onChange={event => onLimitChange(event.target.value)} /></Field>
    <p className="qp-meta">Leave blank for the default of 3. A fresh random sample is drawn on every AI tool call. Zero sends only forced examples.</p>
    {limit === undefined ? <p role="alert" className="qp-error">Enter a whole number from 0 to 1000, or leave blank for the default.</p> : null}
    <p className="qp-meta" role="status">{examples.length} saved examples · up to {expected} per call before the overall limit · {forced} forced</p>
    {forced > effectiveLimit ? <p className="qp-template-limit">Forced examples exceed this pattern’s limit and will all be included.</p> : null}
    <p className="qp-meta">Forced examples always bypass both the pattern and overall limits. Templates can bypass the overall limit only.</p>
    {examples.map((example, index) => <fieldset key={example.id} className="qp-example" disabled={disabled}>
      <legend className="qp-sr-only">Example {index + 1}</legend>
      <Field label={`Example ${index + 1} — full question`}><textarea rows={4} maxLength={20000} value={example.text} onChange={event => update(example.id, { text: event.target.value })} /></Field>
      <div className="qp-example-actions">
        <div className="qp-boolean-field"><span>Force inclusion</span><BooleanSwitch label={`Force inclusion for example ${index + 1}`} checked={example.forced}
          disabled={disabled} onChange={forced => update(example.id, { forced })} /></div>
        <HostButton host={host} label={`Remove example ${index + 1}`} variant="ghost" disabled={disabled} onClick={() => onChange(examples.filter(item => item.id !== example.id))} />
      </div>
    </fieldset>)}
    {examples.some(example => !example.text.trim()) ? <p className="qp-meta">Complete or remove empty examples before saving.</p> : null}
    <div className="qp-actions"><HostButton host={host} label="Add example" variant="outline" disabled={disabled} onClick={() => onChange([...examples, { id: crypto.randomUUID(), text: '', forced: false }])} /></div>
  </section>;
}
