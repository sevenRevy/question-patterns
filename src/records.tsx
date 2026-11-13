import { useId, useRef, useState, type KeyboardEvent } from 'react';
import type { Pattern, PatternContent, PatternExample } from './domain';
import { PatternExamplesEditor, parseExampleLimit } from './pattern-examples-editor';
import { BooleanSwitch, Field, HostButton } from './host-ui';
import { message, type LibraryActions } from './library';

export const tagList = (value: string) => [...new Set(value.split(',').map(tag => tag.trim()).filter(Boolean))];

const formatOptions = [
  { value: 'multiple_choice', label: 'Multiple choice' },
  { value: 'open_response', label: 'Free recall' },
  { value: 'any', label: 'Any' },
] as const;
type PresentationFormat = typeof formatOptions[number]['value'];

function isPresentationFormat(value: string): value is PresentationFormat {
  return formatOptions.some(option => option.value === value);
}
function parseStructure(value: string) {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Structure must be a JSON object.');
  return parsed as PatternContent['structure'];
}

const emptyPattern: PatternContent = { name: '', format: 'any', structure: {}, rule: '', reasoning: [] };

export function PatternEditor({ actions, pattern, onSaved }: { actions: LibraryActions; pattern?: Pattern; onSaved?: () => void }) {
  const [content, setContent] = useState<PatternContent>(() => pattern ? {
    name: pattern.name,
    format: pattern.format,
    structure: structuredClone(pattern.structure),
    rule: pattern.rule,
    reasoning: [...pattern.reasoning],
  } : emptyPattern);
  const [formatChoice, setFormatChoice] = useState<PresentationFormat | null>(() =>
    pattern ? (isPresentationFormat(pattern.format) ? pattern.format : null) : 'any');
  const [structureText, setStructureText] = useState(() => JSON.stringify(content.structure, null, 2));
  const [tags, setTags] = useState(pattern?.tags.join(', ') ?? '');
  const [enabled, setEnabled] = useState(pattern?.enabled ?? true);
  const [examples, setExamples] = useState<PatternExample[]>(() => structuredClone(pattern?.examples ?? []));
  const [exampleLimitText, setExampleLimitText] = useState(() => pattern?.exampleLimit == null ? '' : String(pattern.exampleLimit));
  const exampleLimit = parseExampleLimit(exampleLimitText);
  const examplesValid = exampleLimit !== undefined && examples.every(example => example.text.trim());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const formatLabelId = useId();
  const formatHelpId = useId();
  const formatRadios = useRef<Array<HTMLButtonElement | null>>([]);
  const unsupportedFormat = !!pattern && !isPresentationFormat(pattern.format);

  const save = async () => {
    if (!formatChoice || busy || !examplesValid) return;
    setBusy(true); setError('');
    try {
      const savedContent = {
        ...content,
        name: content.name.trim(),
        format: formatChoice,
        rule: content.rule.trim(),
        structure: parseStructure(structureText),
        reasoning: content.reasoning.map(task => task.trim()).filter(Boolean),
      };
      const id = await actions.host.ctx.call<string>('pattern-save', {
        ...(pattern ? { id: pattern.id, expectedRevision: pattern.revision } : {}),
        content: savedContent,
        tags: tagList(tags),
        enabled,
        examples: examples.map(example => ({ ...example, text: example.text.trim() })),
        exampleLimit,
      });
      if (actions.host.signal.aborted) return;
      await actions.refresh(); onSaved?.(); actions.select({ kind: 'pattern', id });
    } catch (cause) {
      if (!actions.host.signal.aborted) setError(message(cause));
    } finally {
      if (!actions.host.signal.aborted) setBusy(false);
    }
  };
  const update = <K extends keyof PatternContent>(key: K, value: PatternContent[K]) => setContent(previous => ({ ...previous, [key]: value }));
  const handleFormatKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number;
    switch (event.key) {
      case 'ArrowRight': case 'ArrowDown': nextIndex = (index + 1) % formatOptions.length; break;
      case 'ArrowLeft': case 'ArrowUp': nextIndex = (index + formatOptions.length - 1) % formatOptions.length; break;
      case 'Home': nextIndex = 0; break;
      case 'End': nextIndex = formatOptions.length - 1; break;
      default: return;
    }
    event.preventDefault();
    setFormatChoice(formatOptions[nextIndex].value);
    formatRadios.current[nextIndex]?.focus();
  };

  return <section className="qp-stack">
    <h2>{pattern ? 'Edit pattern' : 'New pattern'}</h2>
    <p className="qp-muted">Keep the structure reusable. Add full example questions separately below.</p>
    <Field label="Name"><input value={content.name} maxLength={160} disabled={busy} onChange={event => update('name', event.target.value)} /></Field>
    <Field label="Reusable rule"><textarea value={content.rule} maxLength={2000} rows={2} disabled={busy} onChange={event => update('rule', event.target.value)} /></Field>
    <fieldset className="qp-format-field" disabled={busy}>
      <legend id={formatLabelId}>Presentation format</legend>
      <div className="qp-format-options" role="radiogroup" aria-labelledby={formatLabelId} aria-describedby={formatHelpId} aria-required="true" aria-invalid={formatChoice === null}>
        {formatOptions.map((option, index) => <button
          key={option.value}
          ref={element => { formatRadios.current[index] = element; }}
          type="button"
          className="qp-format-option"
          role="radio"
          aria-checked={formatChoice === option.value}
          tabIndex={formatChoice === option.value || (formatChoice === null && index === 0) ? 0 : -1}
          onClick={() => setFormatChoice(option.value)}
          onKeyDown={event => handleFormatKeyDown(event, index)}
        >{option.label}</button>)}
      </div>
      <p id={formatHelpId} className="qp-meta">{unsupportedFormat
        ? `Current value “${pattern?.format ?? ''}” is unsupported. Choose a supported option before saving.`
        : 'Choose the presentation style that best fits this pattern.'}</p>
    </fieldset>
    <Field label="Structure (JSON)"><textarea value={structureText} maxLength={8000} rows={4} disabled={busy} onChange={event => setStructureText(event.target.value)} /></Field>
    <Field label="Reasoning (comma-separated)"><input value={content.reasoning.join(', ')} disabled={busy} onChange={event => update('reasoning', event.target.value.split(',').map(task => task.trim()).filter(Boolean))} /></Field>
    <PatternExamplesEditor host={actions.host} examples={examples} onChange={setExamples} limitText={exampleLimitText} onLimitChange={setExampleLimitText} disabled={busy} />
    <Field label="Tags (comma-separated)"><input value={tags} disabled={busy} onChange={event => setTags(event.target.value)} /></Field>
    <div className="qp-boolean-field"><span>Default for new sessions</span><BooleanSwitch label="Default for new sessions" checked={enabled} disabled={busy} onChange={setEnabled} /></div>
    {error ? <p role="alert" className="qp-error">{error}</p> : null}
    <div className="qp-actions"><HostButton host={actions.host} label={busy ? 'Saving…' : 'Save pattern'} disabled={busy || !content.name.trim() || !formatChoice || !content.rule.trim() || !examplesValid} onClick={save} /></div>
  </section>;
}
