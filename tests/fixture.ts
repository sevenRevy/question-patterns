import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginAgentKind, PluginBackendContext, PluginInstructions, PluginTaskSnapshot, PluginTools, PluginWorkerDefinition, PluginWorkerStartOptions } from 'learnharness-plugin-api';
import { activate } from '../src/backend';
import type { Analysis } from '../src/domain';

export function temporary() {
  const directory = mkdtempSync(join(tmpdir(), 'question-patterns-'));
  return { directory, remove: () => rmSync(directory, { recursive: true, force: true }) };
}
export const sourceText = 'Q1. What is 2 + 2?\nA. 3\nB. 4\nOriginal answer: B\nExplain your reasoning.';
export const compactOutput = (): Analysis => ({
  patterns: [
    { key: 'multiple-choice-reusable', name: 'Multiple Choice', format: 'multiple_choice', structure: { option_count: 'variable', answer_type: 'single selection' }, rule: 'Offer alternatives and ask the learner to select the best-supported answer.', reasoning: [], support: 'supported', evidence: 'What is 2 + 2?', existingPatternId: '00000000-0000-4000-8000-000000000002', similarPatternId: null, difference: null },
    { key: 'structured-explanation', name: 'Structured Explanation', format: 'open_response', structure: { required_parts: ['reason', 'support'] }, rule: 'Ask for a concise explanation and supporting evidence.', reasoning: ['explain reasoning'], support: 'supported', evidence: 'Explain your reasoning.', existingPatternId: null, similarPatternId: null, difference: null },
  ],
});
export async function backend(directory: string, tasks = new Map<string, PluginTaskSnapshot>()) {
  const controller = new AbortController();
  const handlers = new Map<string, (input: unknown) => unknown>();
  const definitions = new Map<string, PluginWorkerDefinition>();
  const listeners = new Map<string, Set<(task: PluginTaskSnapshot) => void>>();
  const cleanup: Array<() => void | Promise<void>> = [];
  const instructions: PluginInstructions[] = [];
  const toolContributions: PluginTools[] = [];
  const emitted: Array<{ topic: string; data?: unknown }> = [];
  let notifications = 0;
  let starts = 0;
  const inferenceCalls: unknown[] = [];
  const catalog = {
    models: ['model-a', 'model-b'].map(id => ({ provider: 'test', id, name: id, input: id === 'model-b' ? ['text', 'image'] : ['text'], reasoning: true, maxTokens: 4096, supportedLevels: ['off', 'low', 'high', 'max'] })),
    providers: [{ id: 'test', keyPresent: true }], defaults: null, rolePins: {},
    slots: { strong: { model: { provider: 'test', id: 'model-a' }, thinkingLevel: 'low' }, cheap: null, vision: { model: { provider: 'test', id: 'model-b' }, thinkingLevel: 'high' } },
  };
  const inferenceResult = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Question transcription.\nA) First option\nB) Second option' }] };
  const emit = (task: PluginTaskSnapshot) => { for (const listener of listeners.get(task.id) ?? []) listener(structuredClone(task)); };
  const context = {
    dataDirectory: directory, signal: controller.signal,
    cleanup: (fn: () => void | Promise<void>) => cleanup.push(fn),
    handle: (name: string, fn: (input: unknown) => unknown) => { handlers.set(name, fn); return () => { handlers.delete(name); }; },
    registerInstructions: (contribution: PluginInstructions) => {
      instructions.push(contribution);
      return () => { const index = instructions.indexOf(contribution); if (index >= 0) instructions.splice(index, 1); };
    },
    registerTools: (contribution: PluginTools) => {
      toolContributions.push(contribution);
      return () => { const index = toolContributions.indexOf(contribution); if (index >= 0) toolContributions.splice(index, 1); };
    },
    events: { emit: (topic: string, data?: unknown) => { notifications++; emitted.push({ topic, data: structuredClone(data) }); } },
    inference: { catalog: async () => structuredClone(catalog), complete: async (request: unknown) => { inferenceCalls.push(request); return structuredClone(inferenceResult); } },
    workers: {
      register: (definition: PluginWorkerDefinition) => { definitions.set(definition.id, definition); return () => { definitions.delete(definition.id); }; },
      list: () => [...tasks.values()].map(task => structuredClone(task)),
      get: (id: string) => { const task = tasks.get(id); if (!task) throw new Error('Task not found.'); return structuredClone(task); },
      start: (definitionId: string, options: PluginWorkerStartOptions) => {
        starts++;
        const task: PluginTaskSnapshot = { ...structuredClone(options), id: crypto.randomUUID(), definitionId, version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'queued', messages: [], turns: 0 };
        tasks.set(task.id, task); return structuredClone(task);
      },
      subscribe: (id: string, listener: (task: PluginTaskSnapshot) => void) => {
        const set = listeners.get(id) ?? new Set(); listeners.set(id, set); set.add(listener);
        listener(structuredClone(tasks.get(id)!)); return () => { set.delete(listener); };
      },
      cancel: (id: string) => { const task = tasks.get(id)!; task.status = 'cancelled'; task.error = { code: 'cancelled', message: 'Cancelled by user.' }; emit(task); },
    },
  } as unknown as PluginBackendContext;
  await activate(context);
  return {
    tasks, context, catalog, inferenceCalls, inferenceResult, instructions, toolContributions, emitted,
    nativeTools: (agent: PluginAgentKind, chatId: string) => toolContributions.flatMap(contribution => contribution.agents.includes(agent) ? contribution.create({ agent, chatId }) : []),
    nativeInstructions: (agent: PluginAgentKind) => instructions.filter(contribution => contribution.agents.includes(agent)).map(contribution => contribution.text),
    get starts() { return starts; }, get notifications() { return notifications; },
    call: async <T = any>(name: string, input: unknown = {}): Promise<T> => {
      const handler = handlers.get(name); if (!handler) throw new Error(`Handler not found: ${name}`);
      return await handler(input) as T;
    },
    complete: async (id: string, result: Analysis) => {
      const task = tasks.get(id)!;
      await definitions.get(task.definitionId)!.validateResult?.(result, { taskId: id, input: task.input, signal: controller.signal });
      task.status = 'succeeded'; task.result = result; task.usage = { model: 'test:model-a', steps: 1, inputTokens: 20, outputTokens: 30, cacheReadTokens: undefined, cacheWriteTokens: undefined, reasoningTokens: undefined };
      emit(task);
    },
    dispose: async () => { controller.abort(); for (const fn of cleanup.reverse()) await fn(); },
  };
}
