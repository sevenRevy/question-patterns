import { DEFAULT_OVERALL_EXAMPLE_LIMIT, DEFAULT_PATTERN_EXAMPLE_LIMIT } from './domain';
import type { PatternExample, SessionPattern } from './domain';
export type { PatternExample } from './domain';

/** The library's sampling settings, kept separate from the session-facing definition. */
export interface PatternExampleConfig {
  id: string;
  enabled?: boolean;
  archived?: boolean;
  examples?: PatternExample[];
  exampleLimit?: number | null;
}

export type SessionPatternExamples = SessionPattern & { examples?: string[] };

function limit(value: number | null | undefined, fallback: number) {
  if (value == null) return fallback;
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function shuffled<T>(values: T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const value = random();
    const bounded = Number.isFinite(value) ? Math.min(1 - Number.EPSILON, Math.max(0, value)) : 0;
    const swapIndex = Math.floor(bounded * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex]!, result[index]!];
  }
  return result;
}

/**
 * Add sampled example text to selected definitions without exposing library metadata.
 * Forced examples are unconditional. Template-exempt patterns bypass only the shared
 * global cap; randomized samples still obey each pattern's individual limit.
 */
export function selectPatternExamples(
  selectedPatterns: SessionPattern[],
  libraryPatterns: PatternExampleConfig[],
  overallExampleLimit = DEFAULT_OVERALL_EXAMPLE_LIMIT,
  random: () => number = Math.random,
  exemptPatternIds: ReadonlySet<string> | readonly string[] = [],
): SessionPatternExamples[] {
  const selected = selectedPatterns.filter(pattern => pattern.selected);
  const exemptIds = new Set(exemptPatternIds);
  const exempt = selected.map(pattern => exemptIds.has(pattern.id));
  const configs = selected.map(pattern => libraryPatterns.find(candidate => candidate.id === pattern.id));
  const forced = configs.map(config => config && config.archived !== true
    ? (config.examples ?? []).filter(example => example.forced === true && typeof example.text === 'string')
    : []);
  const cappedForcedTotal = forced.reduce((total, examples, index) => total + (exempt[index] ? 0 : examples.length), 0);
  const candidatePools = configs.map((config, index) => {
    if (!config || config.archived === true) return [];
    const forcedIds = new Set(forced[index]!.map(example => example.id));
    const unique = new Map<string, PatternExample>();
    for (const example of config.examples ?? []) {
      if (example.forced !== true && typeof example.text === 'string' && !forcedIds.has(example.id) && !unique.has(example.id)) {
        unique.set(example.id, example);
      }
    }
    const remainingForPattern = Math.max(0, limit(config.exampleLimit, DEFAULT_PATTERN_EXAMPLE_LIMIT) - forced[index]!.length);
    return shuffled([...unique.values()], random).slice(0, remainingForPattern);
  });

  const samples = forced.map(examples => examples.map(example => example.text));
  for (let index = 0; index < candidatePools.length; index++) {
    if (exempt[index]) samples[index]!.push(...candidatePools[index]!.map(example => example.text));
  }
  let remainingGlobal = Math.max(0, limit(overallExampleLimit, DEFAULT_OVERALL_EXAMPLE_LIMIT) - cappedForcedTotal);
  const cursors = candidatePools.map(() => 0);

  // Randomized round-robin gives each eligible pattern an equal chance at each budget slot.
  while (remainingGlobal > 0) {
    const eligible = candidatePools.flatMap((pool, index) => !exempt[index] && cursors[index]! < pool.length ? [index] : []);
    if (eligible.length === 0) break;
    for (const index of shuffled(eligible, random)) {
      if (remainingGlobal === 0) break;
      const example = candidatePools[index]![cursors[index]!]!;
      samples[index]!.push(example.text);
      cursors[index]!++;
      remainingGlobal--;
    }
  }

  return selected.map((pattern, index) => {
    const definition: SessionPatternExamples = {
      id: pattern.id,
      name: pattern.name,
      format: pattern.format,
      structure: pattern.structure,
      rule: pattern.rule,
      reasoning: pattern.reasoning,
      tags: pattern.tags,
      revision: pattern.revision,
      selected: pattern.selected,
    };
    if (samples[index]!.length > 0) definition.examples = samples[index]!;
    return definition;
  });
}
