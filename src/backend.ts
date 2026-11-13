import type { PluginBackendContext } from 'learnharness-plugin-api';
import { Type, type TSchema, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { Store } from './store';
import { ExampleSettingsSchema, PatternContentSchema, PatternExampleConfigSchema, TemplateIdSchema, TemplateNameSchema, TemplatePatternIdsSchema } from './domain';
import { createSessionTools, selectedDefinitions, SESSION_PATTERN_INSTRUCTIONS } from './session-tools';

const id = Type.String({ minLength: 1, maxLength: 128 });
const tags = Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 40, uniqueItems: true });
const sessionId = Type.String({ minLength: 1, maxLength: 500, pattern: '\\S' });
const sessionPatternsSchema = Type.Object({ sessionId }, { additionalProperties: false });
const sessionPatternSetSchema = Type.Object({ sessionId, patternId: id, selected: Type.Boolean() }, { additionalProperties: false });
const patternEnabledSetSchema = Type.Object({ id, enabled: Type.Boolean() }, { additionalProperties: false });
const patternDeleteSchema = Type.Object({
  id: TemplateIdSchema, expectedRevision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
}, { additionalProperties: false });
const templatesSnapshotSchema = Type.Object({}, { additionalProperties: false });
const favoritesSnapshotSchema = Type.Object({}, { additionalProperties: false });
const favoriteSetSchema = Type.Object({
  kind: Type.Union([Type.Literal('pattern'), Type.Literal('template')]),
  id: Type.String({ format: 'uuid' }), favorite: Type.Boolean(),
}, { additionalProperties: false });
const emptyInputSchema = Type.Object({}, { additionalProperties: false });
const templateSaveSchema = Type.Object({
  id: Type.Optional(TemplateIdSchema), expectedRevision: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  name: TemplateNameSchema, patternIds: TemplatePatternIdsSchema,
  bypassOverallLimit: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
const templateDefaultSetSchema = Type.Object({
  id: TemplateIdSchema, expectedRevision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), isDefault: Type.Boolean(),
}, { additionalProperties: false });
const templateDeleteSchema = Type.Object({ id: TemplateIdSchema, expectedRevision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }, { additionalProperties: false });
const sessionTemplateApplySchema = Type.Object({
  sessionId, templateId: TemplateIdSchema, mode: Type.Union([Type.Literal('add'), Type.Literal('replace'), Type.Literal('remove')]),
}, { additionalProperties: false });

export async function activate(ctx: PluginBackendContext) {
  if (ctx.signal.aborted) return;
  const store = await Store.openPatterns(ctx.dataDirectory);
  if (ctx.signal.aborted) { store.close(); return; }
  const disposers: Array<() => void> = [];
  let closed = false;
  ctx.cleanup(() => {
    closed = true;
    for (const dispose of disposers.reverse()) dispose();
    store.close();
  });
  const alive = () => { if (closed || ctx.signal.aborted) throw new Error('Plugin was disabled; no changes were saved.'); };
  const notify = () => { if (!closed && !ctx.signal.aborted) ctx.events.emit('library-changed'); };
  const notifySessionPatterns = (id: string) => { if (!closed && !ctx.signal.aborted) ctx.events.emit('session-patterns-changed', { sessionId: id }); };
  disposers.push(ctx.registerInstructions({ agents: ['teacher', 'practice'], text: SESSION_PATTERN_INSTRUCTIONS }));
  disposers.push(ctx.registerTools({
    agents: ['teacher', 'practice'],
    create: context => createSessionTools(store, context, alive, notifySessionPatterns),
  }));
  const handle = <T extends TSchema>(name: string, schema: T, fn: (input: Static<T>) => unknown | Promise<unknown>) => {
    disposers.push(ctx.handle(name, async input => {
      alive();
      if (!Value.Check(schema, input)) throw new Error(`Invalid ${name} request.`);
      const result = await fn(input as Static<T>);
      notify();
      return result;
    }));
  };
  const read = <T extends TSchema>(name: string, schema: T, fn: (input: Static<T>) => unknown | Promise<unknown>) => {
    disposers.push(ctx.handle(name, async input => {
      alive();
      if (!Value.Check(schema, input)) throw new Error(`Invalid ${name} request.`);
      return await fn(input as Static<T>);
    }));
  };

  read('patterns-snapshot', Type.Object({}, { additionalProperties: false }), () => store.patternsSnapshot());
  read('templates-snapshot', templatesSnapshotSchema, () => store.templatesSnapshot());
  read('favorites-snapshot', favoritesSnapshotSchema, () => store.favoritesSnapshot());
  read('pattern-versions', Type.Object({ id }, { additionalProperties: false }), input =>
    store.patternVersions(input.id).map(({ revision, content, createdAt, examples, exampleLimit }) => ({
      revision, content, createdAt,
      ...(examples !== undefined ? { examples } : {}),
      ...(exampleLimit !== undefined ? { exampleLimit } : {}),
    })));
  read('session-patterns', sessionPatternsSchema, input => store.sessionPatterns(input.sessionId));
  read('session-pattern-context', sessionPatternsSchema, input => {
    const patterns = store.sessionPatterns(input.sessionId);
    return selectedDefinitions(store, input.sessionId, patterns, alive);
  });
  disposers.push(ctx.handle('session-pattern-set', async input => {
    alive();
    if (!Value.Check(sessionPatternSetSchema, input)) throw new Error('Invalid session-pattern-set request.');
    const request = input as Static<typeof sessionPatternSetSchema>;
    const selections = store.setSessionPattern(request.sessionId, request.patternId, request.selected);
    alive();
    notifySessionPatterns(request.sessionId);
    return selections;
  }));
  read('example-settings', emptyInputSchema, () => store.exampleSettings());
  handle('example-settings-save', ExampleSettingsSchema, input => store.saveExampleSettings(input));
  handle('pattern-save', Type.Object({
    id: Type.Optional(id), expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
    content: PatternContentSchema, tags, enabled: Type.Boolean(), ...PatternExampleConfigSchema.properties,
  }, { additionalProperties: false }), input => store.savePattern(
    input.content, input.tags, input.enabled, input.id, input.expectedRevision, undefined,
    {
      ...(input.examples !== undefined ? { examples: input.examples } : {}),
      ...(input.exampleLimit !== undefined ? { exampleLimit: input.exampleLimit } : {}),
    },
  ));
  handle('pattern-enabled-set', patternEnabledSetSchema, input =>
    store.setPatternEnabled(input.id, input.enabled));
  disposers.push(ctx.handle('pattern-delete', async input => {
    alive();
    if (!Value.Check(patternDeleteSchema, input)) throw new Error('Invalid pattern-delete request.');
    const request = input as Static<typeof patternDeleteSchema>;
    try {
      return store.deletePattern(request.id, request.expectedRevision);
    } finally {
      notify();
    }
  }));
  handle('template-save', templateSaveSchema, input =>
    store.saveTemplate(input.name, input.patternIds, input.id, input.expectedRevision, input.bypassOverallLimit));
  handle('template-default-set', templateDefaultSetSchema, input =>
    store.setTemplateDefault(input.id, input.expectedRevision, input.isDefault));
  handle('template-delete', templateDeleteSchema, input =>
    store.deleteTemplate(input.id, input.expectedRevision));
  handle('favorite-set', favoriteSetSchema, input =>
    store.setFavorite(input.kind, input.id, input.favorite));
  disposers.push(ctx.handle('session-template-apply', async input => {
    alive();
    if (!Value.Check(sessionTemplateApplySchema, input)) throw new Error('Invalid session-template-apply request.');
    const request = input as Static<typeof sessionTemplateApplySchema>;
    const selections = store.applyTemplate(request.sessionId, request.templateId, request.mode);
    alive();
    notifySessionPatterns(request.sessionId);
    return selections;
  }));
  handle('archive', Type.Object({ kind: Type.Literal('pattern'), id, archived: Type.Boolean() }, { additionalProperties: false }), input =>
    store.archive('pattern', input.id, input.archived));
}
