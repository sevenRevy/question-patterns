import type { PatternContent, PatternExample } from './domain';
import { CORE_EXAMPLES } from './core-examples';

// Increment only when bundled core definitions/examples need a one-time saved-library upgrade.
export const CORE_SEED_VERSION = 3;

/** Presentation, structure and reasoning stay independent; examples illustrate, not constrain, topics. */
export const CORE_PATTERNS: Array<{ id: string; content: PatternContent; examples: PatternExample[]; defaultSelected?: boolean }> = [
  {
    id: '00000000-0000-4000-8000-000000000001', examples: CORE_EXAMPLES[1]!, defaultSelected: true,
    content: {
      name: 'Direct Question', format: 'any',
      structure: { question_count: 1, stimulus: 'include necessary context', response_scope: 'state the expected answer scope' },
      rule: 'Pose one focused, answerable question. Include necessary context and state the expected scope without imposing an unrelated presentation format.',
      reasoning: ['retrieve or infer', 'apply knowledge'],
    },
  },
  {
    id: '00000000-0000-4000-8000-000000000002', examples: CORE_EXAMPLES[2]!, defaultSelected: true,
    content: {
      name: 'Multiple Choice', format: 'multiple_choice',
      structure: { stem: 'complete, clearly stated problem', option_count: 'variable', best_answer_count: 1, distractors: 'plausible, distinct and non-overlapping' },
      rule: 'State the complete task in a clear stem and provide alternatives with exactly one best-supported answer. Use plausible misconceptions as distractors; avoid tricks, answer clues and all/none-of-the-above shortcuts.',
      reasoning: ['distinguish alternatives', 'select the best-supported answer'],
    },
  },
  {
    id: '00000000-0000-4000-8000-000000000003', examples: CORE_EXAMPLES[3]!,
    content: {
      name: 'Statement Combination', format: 'multiple_choice',
      structure: { statement_count: 'variable', option_count: 'variable', statement_labels: 'explicit identifiers', combination_scope: 'all and only the true or supported statements', best_answer_count: 1 },
      rule: 'Ask learners to judge each claim independently, then select the explicit combination containing all and only the supported claims. Make combinations distinct and ensure exactly one matches the claim judgments.',
      reasoning: ['evaluate statements independently', 'map truth values', 'select the matching combination'],
    },
  },
  {
    id: '00000000-0000-4000-8000-000000000004', examples: CORE_EXAMPLES[4]!,
    content: {
      name: 'True / False', format: 'any',
      structure: { statement_count: 'variable', claims_per_item: 1, response_labels: ['true', 'false'], judgment_basis: 'relevant evidence or rule', correction_policy: 'state whether false claims must be corrected' },
      rule: 'Present one clear claim per item and ask learners to judge it using the relevant evidence or rule. Avoid ambiguous qualifiers and double negatives; explicitly request a correction or justification when needed.',
      reasoning: ['evaluate a claim', 'apply evidence or a rule'],
    },
  },
  {
    id: '00000000-0000-4000-8000-000000000005', examples: CORE_EXAMPLES[5]!,
    content: {
      name: 'Matching', format: 'any',
      structure: { left_item_count: 'variable', right_option_count: 'variable', match_basis: 'one stated relationship', reuse_policy: 'state whether options may be reused', unused_option_policy: 'state whether every option is used' },
      rule: 'Pair items from two coherent sets using an explicit relationship. Keep labels and options clear and specify whether options may be reused or left unused.',
      reasoning: ['identify relationships', 'map pairs'],
    },
  },
  {
    id: '00000000-0000-4000-8000-000000000006', examples: CORE_EXAMPLES[6]!,
    content: {
      name: 'Ordering / Sequencing', format: 'any',
      structure: { item_count: 'variable', order_basis: 'explicit magnitude, time or dependency criterion', response_type: 'ordered sequence', tie_policy: 'unique order or explicitly accepted alternatives' },
      rule: 'State the ordering criterion and supply enough information to determine a sequence. Specify how to handle ties or multiple valid sequences rather than assuming an unstated order.',
      reasoning: ['identify an ordering relation', 'sequence items'],
    },
  },
  {
    id: '00000000-0000-4000-8000-000000000007', examples: CORE_EXAMPLES[7]!,
    content: {
      name: 'Fill in the Blank', format: 'open_response',
      structure: { blank_count: 'variable, keep each omission focused', response_type: 'missing word, phrase or value', context: 'enough information to constrain the answer', answer_policy: 'state accepted variants, units or precision when relevant' },
      rule: 'Omit a small, meaningful part of an otherwise understandable statement. Provide enough context and answer requirements to make responses scorable without guessing the intended wording.',
      reasoning: ['recall or infer missing information', 'use context'],
    },
  },
  {
    id: '00000000-0000-4000-8000-000000000008', examples: CORE_EXAMPLES[8]!,
    content: {
      name: 'Scenario-Based', format: 'any',
      structure: { context: 'concrete situation', relevant_facts: 'supply the facts needed to answer', task: 'decision, prediction or application', constraints: 'state the conditions a valid answer must respect', response_format: 'variable' },
      rule: 'Provide a concrete situation with sufficient relevant facts, then ask learners to apply a rule, predict an outcome or make a justified choice. Keep the scenario relevant to the task rather than decorative.',
      reasoning: ['select relevant facts', 'apply rules to a scenario', 'justify a choice'],
    },
  },
  {
    id: '00000000-0000-4000-8000-000000000009', examples: CORE_EXAMPLES[9]!,
    content: {
      name: 'Error Identification', format: 'any',
      structure: { provided_material: 'work or claim containing an error', error_scope: 'state whether the first, one or all errors are required', judgment_basis: 'relevant rule or supplied evidence', response_type: 'locate the error and explain or correct it as requested' },
      rule: 'Present work or a claim, specify the requested error scope, and ask learners to locate the mistake. When appropriate, require a correction and the rule or evidence explaining why it is needed.',
      reasoning: ['detect errors', 'diagnose reasoning', 'correct work'],
    },
  },
  {
    id: '00000000-0000-4000-8000-000000000010', examples: CORE_EXAMPLES[10]!,
    content: {
      name: 'Interpretation', format: 'any',
      structure: { provided_material: 'complete, accessible text, table or other source', task: 'describe a pattern, infer or draw a conclusion', evidence_requirement: 'identify supporting details', inference_scope: 'distinguish source-supported conclusions from assumptions', response_format: 'variable' },
      rule: 'Supply the complete stimulus and ask for an interpretation supported by its details. State any extrapolation assumptions and avoid conclusions stronger than the available evidence.',
      reasoning: ['interpret evidence', 'infer from a source', 'support a conclusion'],
    },
  },
  {
    id: '00000000-0000-4000-8000-000000000011', examples: CORE_EXAMPLES[11]!,
    content: {
      name: 'Problem Solving', format: 'any',
      structure: { goal: 'specific outcome to find or produce', givens: 'relevant information provided', constraints: 'requirements a valid solution must satisfy', response_format: 'variable, specify required working', verification: 'check the result against the goal and constraints' },
      rule: 'State the goal, givens and constraints. Ask learners to choose a suitable method, communicate the required solution steps and check that their result meets the requirements, allowing valid alternative strategies.',
      reasoning: ['select a strategy', 'apply constraints', 'verify a solution'],
    },
  },
  {
    id: '00000000-0000-4000-8000-000000000012', examples: CORE_EXAMPLES[12]!, defaultSelected: true,
    content: {
      name: 'Open-Ended Explanation', format: 'open_response',
      structure: { response_type: 'explanation', scope: 'specific idea, claim or relationship to explain', required_elements: 'state the expected reason, rule or evidence', detail: 'set an appropriate response boundary', evaluation_criteria: ['accuracy', 'clarity', 'support'] },
      rule: 'Ask learners to explain a specified idea in their own words. Identify the supporting elements and appropriate scope, accepting alternative wording when the explanation is accurate and justified.',
      reasoning: ['explain reasoning', 'justify a claim', 'use evidence'],
    },
  },
];
