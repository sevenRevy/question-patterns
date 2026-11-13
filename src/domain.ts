import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import type { PluginModelSpec } from 'learnharness-plugin-api';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const DEFAULT_PATTERN_EXAMPLE_LIMIT = 3;
export const DEFAULT_OVERALL_EXAMPLE_LIMIT = 15;
export const PROMPT_VERSION = 'question-patterns/4';
export type TargetKind = 'source' | 'pattern';
export type Support = 'supported' | 'uncertain' | 'unsupported';
export type Decision = 'candidate' | 'accepted' | 'rejected';
export type ModelChoice = PluginModelSpec;

const text = Type.String({ minLength: 1, maxLength: 12000 });
const nullableText = Type.Union([text, Type.Null()]);
const support = Type.Union([Type.Literal('supported'), Type.Literal('uncertain'), Type.Literal('unsupported')]);
const evidenceFields = { support, evidence: nullableText };
const key = Type.String({ minLength: 1, maxLength: 120, pattern: '^[a-z0-9][a-z0-9_.-]*$' });
const compactText = Type.String({ minLength: 1, maxLength: 2000, pattern: '\\S' });
export const PatternExampleSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  text: Type.String({ minLength: 1, maxLength: 20000, pattern: '\\S' }),
  forced: Type.Boolean(),
}, { additionalProperties: false });
export const PatternExamplesSchema = Type.Array(PatternExampleSchema);
export const PatternExampleLimitSchema = Type.Union([Type.Integer({ minimum: 0, maximum: 1000 }), Type.Null()]);
export const PatternExampleConfigSchema = Type.Object({
  examples: Type.Optional(PatternExamplesSchema),
  exampleLimit: Type.Optional(PatternExampleLimitSchema),
}, { additionalProperties: false });
export const ExampleSettingsSchema = Type.Object({
  overallExampleLimit: Type.Integer({ minimum: 0, maximum: 1000 }),
}, { additionalProperties: false });
export const ExampleSettingsRecordSchema = Type.Object({
  version: Type.Literal(1), overallExampleLimit: Type.Integer({ minimum: 0, maximum: 1000 }),
}, { additionalProperties: false });
const structureValue = Type.Union([
  Type.String({ maxLength: 500 }), Type.Number(), Type.Boolean(),
  Type.Array(Type.String({ maxLength: 500 }), { maxItems: 40 }), Type.Array(Type.Number(), { maxItems: 40 }),
]);
export const PatternContentSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 160, pattern: '\\S' }),
  format: Type.String({ minLength: 1, maxLength: 100, pattern: '^[a-z0-9][a-z0-9_-]*$' }),
  structure: Type.Record(Type.String({ minLength: 1, maxLength: 80 }), structureValue, { maxProperties: 24 }),
  rule: compactText,
  // Presentation, organization, and mental operations are independent dimensions.
  reasoning: Type.Array(Type.String({ minLength: 1, maxLength: 300, pattern: '\\S' }), { maxItems: 20, uniqueItems: true }),
}, { additionalProperties: false });
const patternId = Type.Union([Type.String({ format: 'uuid' }), Type.Null()]);
export const PatternSchema = Type.Object({
  key, ...PatternContentSchema.properties, ...evidenceFields,
  existingPatternId: patternId,
  similarPatternId: patternId,
  difference: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
}, { additionalProperties: false });
export const AnalysisSchema = Type.Object({ patterns: Type.Array(PatternSchema, { maxItems: 40 }) }, { additionalProperties: false });
export const SettingsSchema = Type.Object({
  version: Type.Literal(1),
  instructions: Type.String(),
  maxTurns: Type.Integer({ minimum: 1, maximum: 10 }),
  modelSlot: Type.Union([Type.Literal('strong'), Type.Literal('cheap'), Type.Literal('vision')]),
  analysisStrength: Type.Union([Type.Literal('strong'), Type.Literal('medium'), Type.Literal('weak')]),
}, { additionalProperties: false });

export type PatternProposal = Static<typeof PatternSchema>;
export type Analysis = Static<typeof AnalysisSchema>;
export type PatternContent = Static<typeof PatternContentSchema>;
export type PatternExample = Static<typeof PatternExampleSchema>;
export type PatternExampleConfig = Static<typeof PatternExampleConfigSchema>;
export interface ExampleSettings { overallExampleLimit: number }
export const DEFAULT_EXAMPLE_SETTINGS: Readonly<ExampleSettings> = Object.freeze({
  overallExampleLimit: DEFAULT_OVERALL_EXAMPLE_LIMIT,
});

/** Keep only reusable definition fields; proposal identity and evidence stay in the analysis. */
export function patternContent(content: PatternContent): PatternContent {
  return {
    name: content.name,
    format: content.format,
    structure: structuredClone(content.structure),
    rule: content.rule,
    reasoning: [...content.reasoning],
  };
}

function normalizedName(value: string) {
  return value.toLowerCase().trim().replace(/[\s-]+/g, '_');
}

const variableStructureKey = /(?:^|_)(?:count|number|length|size|options|choices|statements|alternatives|items|blanks|stages|steps|subject|topic|domain|difficulty)(?:_|$)/;
function fixedStructure(content: Pick<PatternContent, 'structure'>) {
  return new Map(Object.entries(content.structure).flatMap(([rawKey, value]) => {
    const name = normalizedName(rawKey);
    if (variableStructureKey.test(name) || (typeof value === 'string' && normalizedName(value) === 'variable')) return [];
    const normalized = typeof value === 'string' ? normalizedName(value) : JSON.stringify(value);
    return [[name, normalized]];
  }));
}

function sameEntries(left: Map<string, string>, right: Map<string, string>) {
  return left.size === right.size && [...left].every(([key, value]) => right.get(key) === value);
}

/** Reasoning and variable details do not identify a pattern; fixed structural differences do. */
export function samePatternStructure(left: Pick<PatternContent, 'format' | 'structure'>, right: Pick<PatternContent, 'format' | 'structure'>) {
  const leftFormat = normalizedName(left.format), rightFormat = normalizedName(right.format);
  const leftFixed = fixedStructure(left), rightFixed = fixedStructure(right);
  if (leftFormat === rightFormat) return sameEntries(leftFixed, rightFixed);
  if (leftFormat !== 'any' && rightFormat !== 'any') return false;

  // An "any" pattern is an orthogonal structure (such as a scenario overlay).
  const generic = leftFormat === 'any' ? leftFixed : rightFixed;
  const specific = leftFormat === 'any' ? rightFixed : leftFixed;
  return generic.size > 0 && [...generic].every(([key, value]) => specific.get(key) === value);
}

/** Finds structurally related patterns for review without treating them as equivalent. */
export function similarPatternStructure(left: Pick<PatternContent, 'format' | 'structure'>, right: Pick<PatternContent, 'format' | 'structure'>) {
  const a = normalizedName(left.format), b = normalizedName(right.format);
  if (a !== b && a !== 'any' && b !== 'any') return false;
  const leftFixed = fixedStructure(left), rightFixed = fixedStructure(right);
  const shared = [...leftFixed.keys()].filter(key => rightFixed.has(key));
  if (!shared.length) return false;
  return shared.some(key => leftFixed.get(key) !== rightFixed.get(key))
    || leftFixed.size !== rightFixed.size;
}

export interface RecordLinks { analysisIds: string[]; activeAnalysisId: string | null; patternIds: string[] }
export interface Source extends RecordLinks {
  id: string; title: string; kind: string; tags: string[]; archived: boolean;
  revisionId: string; hash: string; filename: string; location: string; importedAt: string;
  text: string; notices: string[];
}
export interface Pattern extends PatternContent {
  id: string; tags: string[]; enabled: boolean; archived: boolean; revision: number; updatedAt: string;
  examples?: PatternExample[]; exampleLimit?: number | null;
}
/** Legacy store-only view; the current backend never returns source/analysis links. */
export interface LegacyPattern extends Pattern, Partial<RecordLinks> {}
export type SessionPattern = Pick<Pattern, 'id' | 'name' | 'format' | 'structure' | 'rule' | 'reasoning' | 'tags' | 'revision'> & { selected: boolean };
export interface AnalysisItem {
  id: string; runId: string; kind: 'pattern'; key: string; value: PatternProposal;
  decision: Decision; appliedId: string | null; automatic?: boolean;
}
export interface AnalysisRun {
  id: string; requestId: string; targetKind: TargetKind; targetId: string; targetTitle: string;
  inputRevision: string; model: ModelChoice; instructions: string; promptVersion: string;
  createdAt: string; completedAt: string | null;
  taskId: string | null; status: 'starting' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  error: string | null; usage: unknown;
}
export type ModelSlot = 'strong' | 'cheap' | 'vision';
export type AnalysisStrength = 'strong' | 'medium' | 'weak';
export interface Settings { instructions: string; maxTurns: number; modelSlot: ModelSlot; analysisStrength: AnalysisStrength }
export interface Snapshot {
  sources: Source[]; patterns: LegacyPattern[]; runs: AnalysisRun[]; settings: Settings;
}
export interface PatternsSnapshot { patterns: Pattern[] }
export const MAX_TEMPLATES = 1000;
export const MAX_TEMPLATE_PATTERNS = 500;
export const TemplateIdSchema = Type.String({ format: 'uuid' });
export const TemplateNameSchema = Type.String({ minLength: 1, maxLength: 160, pattern: '\\S' });
export const TemplatePatternIdsSchema = Type.Array(TemplateIdSchema, { maxItems: MAX_TEMPLATE_PATTERNS, uniqueItems: true });
export const PatternTemplateSchema = Type.Object({
  id: TemplateIdSchema,
  name: TemplateNameSchema,
  patternIds: TemplatePatternIdsSchema,
  bypassOverallLimit: Type.Optional(Type.Boolean()),
  isDefault: Type.Optional(Type.Boolean()),
  revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  updatedAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false });
export const TemplatesRecordSchema = Type.Object({
  version: Type.Literal(1),
  templates: Type.Array(PatternTemplateSchema, { maxItems: MAX_TEMPLATES }),
}, { additionalProperties: false });
export type PatternTemplate = Static<typeof PatternTemplateSchema>;
export interface TemplateExampleSummary {
  id: string; totalExamples: number; availableExamples: number; forcedExamples: number;
  expectedExamples: number; perPatternLimited: boolean; exceedsOverallLimit: boolean;
}
export interface TemplatesSnapshot {
  templates: PatternTemplate[];
  exampleSummaries?: TemplateExampleSummary[];
  overallExampleLimit?: number;
}

export function validateAnalysis(value: unknown, sourceText: string): asserts value is Analysis {
  if (!Value.Check(AnalysisSchema, value)) throw new Error('Analysis does not match the strict result schema.');
  const keys = new Set<string>();
  for (const item of value.patterns) {
    if (keys.has(item.key)) throw new Error(`Duplicate proposal key: ${item.key}`);
    keys.add(item.key);
    if (item.evidence !== null && !sourceText.includes(item.evidence)) throw new Error(`Evidence for ${item.key} must be an exact quote from the supplied material.`);
    if (item.support === 'supported' && !item.evidence) throw new Error(`Supported pattern ${item.key} needs evidence.`);
    if (item.similarPatternId && !item.difference?.trim()) throw new Error(`Similar pattern ${item.key} needs a brief structural difference.`);
  }
}

export function compareItems(previous: AnalysisItem[], current: AnalysisItem[]) {
  const left = new Map(previous.map(item => [`${item.kind}:${item.key}`, item]));
  const right = new Map(current.map(item => [`${item.kind}:${item.key}`, item]));
  return [...new Set([...left.keys(), ...right.keys()])].map(key => {
    const before = left.get(key), after = right.get(key);
    const fields = [...new Set([...Object.keys(before?.value ?? {}), ...Object.keys(after?.value ?? {})])]
      .filter(field => JSON.stringify((before?.value as Record<string, unknown> | undefined)?.[field]) !== JSON.stringify((after?.value as Record<string, unknown> | undefined)?.[field]));
    return { key, before, after, fields, change: !before ? 'added' : !after ? 'removed' : fields.length ? 'changed' : 'unchanged' };
  });
}
