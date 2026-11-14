import { lstatSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { atomicWrite, applyLegacyCleanup, assertNotLinked, exists, makeDirectory, planLegacyCleanup, readJson, recordIds, recordPath, writeJson } from './files';
import type { Analysis, AnalysisItem, AnalysisRun, ExampleSettings, LegacyPattern, PatternContent, PatternExample, PatternExampleConfig, PatternTemplate, PatternsSnapshot, RecordLinks, SessionPattern, Settings, Snapshot, Source, TargetKind, TemplateExampleSummary, TemplatesSnapshot } from './domain';
import { DEFAULT_EXAMPLE_SETTINGS, DEFAULT_PATTERN_EXAMPLE_LIMIT, MAX_FILE_BYTES, MAX_TEXT_BYTES, MAX_TEMPLATES, ExampleSettingsRecordSchema, ExampleSettingsSchema, PatternContentSchema, PatternExampleConfigSchema, PatternExampleLimitSchema, PatternExamplesSchema, TemplateIdSchema, TemplateNameSchema, TemplatePatternIdsSchema, TemplatesRecordSchema, patternContent, samePatternStructure, PROMPT_VERSION, SettingsSchema, validateAnalysis } from './domain';
import { LEGACY_CORE_EXAMPLE_HASHES } from './core-example-upgrades';
import { CORE_PATTERNS, CORE_SEED_VERSION } from './structures';

type Versioned = { version: 1 };
interface SourceRecord extends RecordLinks, Versioned { id: string; title: string; tags: string[]; archived: boolean; revisionId: string; revisionIds: string[] }
interface SourceRevision extends Versioned { id: string; sourceId: string; hash: string; filename: string; extension: string; kind: string; location: string; importedAt: string; text: string; notices: string[] }
interface PatternVersion {
  revision: number; content: PatternContent; examples?: PatternExample[]; exampleLimit?: number | null;
  runId?: string | null; itemId?: string | null; createdAt: string;
}
interface PatternRecord extends Partial<RecordLinks>, Versioned {
  id: string; tags: string[]; enabled: boolean; archived: boolean; versions: PatternVersion[]; coreSeedVersion?: number;
}
interface RequestRecord extends Versioned { run: AnalysisRun }
interface ResultRecord extends Versioned { status: AnalysisRun['status']; completedAt: string; usage: unknown; error: string | null; items: Array<Omit<AnalysisItem, 'decision' | 'appliedId'>> }
interface ReviewRecord extends Versioned { decisions: Record<string, { decision: 'accepted' | 'rejected'; appliedId: string | null; automatic?: boolean }> }
interface SessionSelection { sessionId: string; patternIds: string[]; exampleLimitBypassIds?: string[] }
interface SessionSelectionsRecord extends Versioned { sessions: SessionSelection[] }
interface TemplatesRecord extends Versioned { templates: PatternTemplate[] }
type FavoriteKind = 'pattern' | 'template';
interface FavoriteEntry { kind: FavoriteKind; id: string }
interface FavoritesRecord extends Versioned { favorites: FavoriteEntry[] }
interface DeletedPatternsRecord extends Versioned { patternIds: string[] }
interface PatternDeletionPlan {
  templates: TemplatesRecord; writeTemplates: boolean;
  favorites: FavoritesRecord; writeFavorites: boolean;
  sessions: SessionSelectionsRecord; writeSessions: boolean;
  patternPaths: string[];
}
export interface ImportSource { filename: string; kind: string; location: string; text: string; notices: string[]; bytes: Uint8Array; replaceId?: string }
const SessionSelectionsSchema = Type.Object({
  version: Type.Literal(1),
  sessions: Type.Array(Type.Object({
    sessionId: Type.String({ minLength: 1, maxLength: 500, pattern: '\\S' }),
    patternIds: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
    exampleLimitBypassIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true })),
  }, { additionalProperties: false })),

}, { additionalProperties: false });
const TemplateSaveInputSchema = Type.Object({
  name: TemplateNameSchema, patternIds: TemplatePatternIdsSchema, bypassOverallLimit: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
const FavoritesRecordSchema = Type.Object({
  version: Type.Literal(1),
  favorites: Type.Array(Type.Object({
    kind: Type.Union([Type.Literal('pattern'), Type.Literal('template')]),
    id: Type.String({ format: 'uuid' }),
  }, { additionalProperties: false })),
}, { additionalProperties: false });
const DeletedPatternsRecordSchema = Type.Object({
  version: Type.Literal(1), patternIds: Type.Array(Type.String({ format: 'uuid' }), { uniqueItems: true }),
}, { additionalProperties: false });
const now = () => new Date().toISOString();
const links = (): RecordLinks => ({ analysisIds: [], activeAnalysisId: null, patternIds: [] });
function mergedCoreExamples(defaults: PatternExample[], existing: PatternExample[] | undefined): PatternExample[] {
  const defaultsById = new Map(defaults.map(example => [example.id, example] as const));
  const examples = new Map<string, PatternExample>(defaults.map(example => [example.id, structuredClone(example)] as const));
  for (const example of existing ?? []) {
    const seeded = defaultsById.get(example.id);
    const legacyHash = LEGACY_CORE_EXAMPLE_HASHES[example.id];
    const text = seeded && legacyHash
      && createHash('sha256').update(example.text).digest('hex') === legacyHash
      ? seeded.text
      : example.text;
    examples.set(example.id, { ...structuredClone(example), text });
  }
  return [...examples.values()];
}
const patternVersionSchema = Type.Object({
  revision: Type.Integer({ minimum: 1 }), content: PatternContentSchema,
  examples: Type.Optional(PatternExamplesSchema), exampleLimit: Type.Optional(PatternExampleLimitSchema),
  runId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  itemId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  createdAt: Type.String(),
}, { additionalProperties: false });
const patternRecordSchema = Type.Object({
  version: Type.Literal(1), id: Type.String({ format: 'uuid' }),
  tags: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 40, uniqueItems: true }),
  enabled: Type.Boolean(), archived: Type.Boolean(), versions: Type.Array(patternVersionSchema, { minItems: 1 }),
  coreSeedVersion: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  analysisIds: Type.Optional(Type.Array(Type.String({ format: 'uuid' }))),
  activeAnalysisId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  patternIds: Type.Optional(Type.Array(Type.String({ format: 'uuid' }))),
}, { additionalProperties: false });
function validPatternRecord(value: unknown): value is PatternRecord {
  if (!Value.Check(patternRecordSchema, value)) return false;
  return (value as PatternRecord).versions.every(version =>
    version.examples === undefined || new Set(version.examples.map(example => example.id)).size === version.examples.length);
}

/** Files are authoritative. No index, cache, database engine, or analysis preload is maintained. */
export class Store {
  private constructor(private directory: string, private patternsOnly: boolean) {}
  static async open(directory: string) {
    makeDirectory(directory);
    const store = new Store(directory, false);
    store.exampleSettings();
    store.templatesRecord();
    store.favoritesRecord();
    for (const folder of ['patterns', 'analyses', 'sources']) makeDirectory(join(directory, folder));
    const settings = join(directory, 'settings.json');
    if (!exists(settings)) writeJson(settings, { version: 1, instructions: '', maxTurns: 4, modelSlot: 'strong', analysisStrength: 'strong' });
    store.settings();
    store.resumeDeletedPatternCleanup();
    store.seedCorePatterns();
    return store;
  }
  /** Open only the approved pattern library after validating and purging legacy user data. */
  static async openPatterns(directory: string) {
    makeDirectory(directory);
    const store = new Store(directory, true);
    store.exampleSettings();
    store.templatesRecord();
    store.favoritesRecord();
    store.sessionSelections();
    const cleanup = planLegacyCleanup(directory);
    const patternTemps = store.validatePatternRecords();
    store.removeStalePatternTemps(patternTemps);
    store.resumeDeletedPatternCleanup();
    applyLegacyCleanup(cleanup);
    makeDirectory(join(directory, 'patterns'));
    store.stripLegacyPatternMetadata();
    store.seedCorePatterns();
    return store;
  }
  private validatePatternRecords(): string[] {
    const directory = join(this.directory, 'patterns');
    assertNotLinked(directory);
    let names: string[];
    try {
      const info = lstatSync(directory);
      if (!info.isDirectory()) throw new Error(`Invalid pattern library path: ${directory}`);
      names = readdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const canonicalNames = new Set<string>();
    const temporaryPaths: string[] = [];
    for (const name of names) {
      const path = join(directory, name);
      const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i.exec(name);
      if (match) {
        const info = lstatSync(path);
        if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refusing linked pattern data: ${path}`);
        const record = readJson<unknown>(path);
        if (!validPatternRecord(record) || record.id !== match[1]) {
          throw new Error(`Unknown or invalid pattern metadata in ${path}; no data was changed.`);
        }
        if (CORE_PATTERNS.some(core => core.id === record.id)) this.assertSupportedCoreSeedVersion(record);
        canonicalNames.add(name);
        continue;
      }
      const temporary = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.tmp$/i.exec(name);
      if (!temporary) throw new Error(`Unknown pattern data file ${path}; no data was changed.`);
      const info = lstatSync(path);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refusing linked pattern data: ${path}`);
      temporaryPaths.push(path);
    }
    for (const path of temporaryPaths) {
      const temporary = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json)\./i.exec(basename(path))!;
      if (!canonicalNames.has(temporary[1]!)) throw new Error(`Orphan pattern temporary file ${path}; no data was changed.`);
    }
    return temporaryPaths;
  }
  private removeStalePatternTemps(paths: string[]) {
    for (const path of paths) {
      const name = basename(path);
      const match = /^(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i.exec(name)!;
      const canonicalPath = join(dirname(path), match[1]!);
      assertNotLinked(canonicalPath);
      const canonicalInfo = lstatSync(canonicalPath);
      if (canonicalInfo.isSymbolicLink() || !canonicalInfo.isFile()) throw new Error(`Invalid canonical pattern file ${canonicalPath}; no data was changed.`);
      const record = readJson<unknown>(canonicalPath);
      const id = match[2]!;
      if (!validPatternRecord(record) || record.id !== id) {
        throw new Error(`Unknown or invalid pattern metadata in ${canonicalPath}; no data was changed.`);
      }
      assertNotLinked(dirname(path));
      try {
        const info = lstatSync(path);
        if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refusing linked pattern data: ${path}`);
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  private stripLegacyPatternMetadata() {
    for (const id of recordIds(this.directory, 'patterns')) {
      const path = this.path('patterns', id);
      const record = this.read<PatternRecord>(path);
      const { analysisIds, activeAnalysisId, patternIds, ...current } = record;
      let changed = analysisIds !== undefined || activeAnalysisId !== undefined || patternIds !== undefined;
      current.versions = current.versions.map(version => {
        const { runId, itemId, ...approved } = version;
        if (runId !== undefined || itemId !== undefined) changed = true;
        return approved;
      });
      if (changed) writeJson(path, current);
    }
  }
  close() { /* No long-lived handles or caches. */ }
  private path(folder: string, id: string, suffix = '') { return recordPath(this.directory, folder, id, suffix); }
  private deletedPatternsPath() { return join(this.directory, 'deleted-patterns.json'); }
  private deletedPatternsRecord(): DeletedPatternsRecord {
    const path = this.deletedPatternsPath();
    if (!exists(path)) return { version: 1, patternIds: [] };
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Invalid deleted-patterns storage path: ${path}`);
    const stored = readJson<unknown>(path);
    if (!Value.Check(DeletedPatternsRecordSchema, stored)
      || new Set((stored as DeletedPatternsRecord).patternIds.map(id => id.toLowerCase())).size !== (stored as DeletedPatternsRecord).patternIds.length) {
      throw new Error('Deleted pattern journal does not match the current schema.');
    }
    return stored as DeletedPatternsRecord;
  }
  private assertPatternNotDeleted(id: string) {
    if (this.deletedPatternsRecord().patternIds.some(deletedId => deletedId.toLowerCase() === id.toLowerCase())) {
      throw new Error('Pattern was permanently deleted and cannot be restored.');
    }
  }
  private read<T extends Versioned>(path: string): T {
    const value = readJson<T>(path);
    if (!value || value.version !== 1) throw new Error('Unknown record version. No data was changed; use a compatible plugin.');
    return value;
  }
  private source(id: string) { return this.read<SourceRecord>(this.path('sources', id)); }
  private pattern(id: string) {
    this.assertPatternNotDeleted(id);
    const record = this.read<PatternRecord>(this.path('patterns', id));
    if (!validPatternRecord(record)) throw new Error('Pattern metadata does not match the current schema.');
    return this.patternsOnly ? record : { ...links(), ...record };
  }
  private record(kind: TargetKind, id: string): SourceRecord | PatternRecord {
    return kind === 'source' ? this.source(id) : this.pattern(id);
  }
  private saveRecord(kind: TargetKind, record: SourceRecord | PatternRecord) {
    writeJson(this.path(kind === 'source' ? 'sources' : 'patterns', record.id), record);
  }
  private withLinks(record: SourceRecord | PatternRecord): (SourceRecord | PatternRecord) & RecordLinks {
    record.analysisIds ??= [];
    record.activeAnalysisId ??= null;
    record.patternIds ??= [];
    return record as (SourceRecord | PatternRecord) & RecordLinks;
  }
  private attachRun(run: AnalysisRun, activate = false) {
    const record = this.withLinks(this.record(run.targetKind, run.targetId));
    let changed = false;
    if (!record.analysisIds.includes(run.id)) { record.analysisIds.push(run.id); changed = true; }
    if (activate && (!record.activeAnalysisId || record.analysisIds.indexOf(record.activeAnalysisId) <= record.analysisIds.indexOf(run.id))) {
      record.activeAnalysisId = run.id; changed = true;
    }
    if (changed) this.saveRecord(run.targetKind, record);
  }
  patterns(): LegacyPattern[] {
    const deletedIds = new Set(this.deletedPatternsRecord().patternIds.map(id => id.toLowerCase()));
    return recordIds(this.directory, 'patterns').filter(id => !deletedIds.has(id.toLowerCase()))
      .map(id => this.projectPattern(this.pattern(id)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  patternsSnapshot(): PatternsSnapshot {
    return { patterns: this.patterns().map(({ analysisIds: _analysisIds, activeAnalysisId: _activeAnalysisId, patternIds: _patternIds, ...pattern }) => pattern) };
  }
  private templatesPath() { return join(this.directory, 'templates.json'); }
  private templatesRecord(): TemplatesRecord {
    const path = this.templatesPath();
    if (!exists(path)) return { version: 1, templates: [] };
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Invalid template storage path: ${path}`);
    const value = readJson<unknown>(path);
    if (value && typeof value === 'object' && !Array.isArray(value) && (value as { version?: unknown }).version !== 1) {
      throw new Error('Unknown record version. No data was changed; use a compatible plugin.');
    }
    if (!Value.Check(TemplatesRecordSchema, value)) throw new Error('Templates do not match the current schema.');
    const templates = (value as TemplatesRecord).templates;
    if (new Set(templates.map(template => template.id)).size !== templates.length) {
      throw new Error('Template IDs must be unique.');
    }
    return value as TemplatesRecord;
  }
  templates(): PatternTemplate[] { return this.templatesRecord().templates; }
  templatesSnapshot(): TemplatesSnapshot {
    const templates = this.templates();
    const patterns = this.patterns();
    const patternsById = new Map(patterns.map(pattern => [pattern.id, pattern]));
    const overallExampleLimit = this.exampleSettings().overallExampleLimit;
    const exampleSummaries: TemplateExampleSummary[] = templates.map(template => {
      const members = template.patternIds.flatMap(id => {
        const pattern = patternsById.get(id);
        return pattern ? [pattern] : [];
      });
      const eligible = members.filter(pattern => !pattern.archived);
      const totalExamples = members.reduce((total, pattern) => total + (pattern.examples?.length ?? 0), 0);
      const availableExamples = eligible.reduce((total, pattern) => total + (pattern.examples?.length ?? 0), 0);
      const forcedExamples = eligible.reduce((total, pattern) => total + (pattern.examples?.filter(example => example.forced).length ?? 0), 0);
      const expectedExamples = eligible.reduce((total, pattern) => {
        const examples = pattern.examples ?? [];
        const forced = examples.filter(example => example.forced).length;
        return total + Math.max(forced, Math.min(examples.length, pattern.exampleLimit ?? DEFAULT_PATTERN_EXAMPLE_LIMIT));
      }, 0);
      return {
        id: template.id, totalExamples, availableExamples, forcedExamples, expectedExamples,
        perPatternLimited: expectedExamples < availableExamples,
        exceedsOverallLimit: expectedExamples > overallExampleLimit,
      };
    });
    return { templates, exampleSummaries, overallExampleLimit };
  }
  private favoritesPath() { return join(this.directory, 'favorites.json'); }
  private favoritesRecord(): FavoritesRecord {
    const path = this.favoritesPath();
    if (!exists(path)) return { version: 1, favorites: [] };
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Invalid favorites storage path: ${path}`);
    const stored = this.read<FavoritesRecord>(path);
    if (!Value.Check(FavoritesRecordSchema, stored)) throw new Error('Favorites do not match the current schema.');
    const keys = stored.favorites.map(({ kind, id }) => `${kind}:${id}`);
    if (new Set(keys).size !== keys.length) throw new Error('Favorites do not match the current schema.');
    return stored;
  }
  favoritesSnapshot(): { favorites: FavoriteEntry[] } {
    const entries = this.favoritesRecord().favorites;
    const patternIds = new Set(this.patterns().map(pattern => pattern.id));
    const templateIds = new Set(this.templatesRecord().templates.map(template => template.id));
    return { favorites: entries.filter(entry => entry.kind === 'pattern' ? patternIds.has(entry.id) : templateIds.has(entry.id)) };
  }
  setFavorite(kind: FavoriteKind, id: string, favorite: boolean): { favorites: FavoriteEntry[] } {
    if (kind !== 'pattern' && kind !== 'template') throw new Error('Invalid favorite kind.');
    if (!Value.Check(TemplateIdSchema, id)) throw new Error('Invalid favorite ID.');
    if (typeof favorite !== 'boolean') throw new Error('Favorite state must be a boolean.');
    const exists = kind === 'pattern'
      ? this.patterns().some(pattern => pattern.id === id)
      : this.templatesRecord().templates.some(template => template.id === id);
    if (!exists) throw new Error(`Cannot favorite an unknown ${kind}.`);

    const record = this.favoritesRecord();
    const index = record.favorites.findIndex(entry => entry.kind === kind && entry.id === id);
    if (favorite && index < 0) {
      record.favorites.push({ kind, id });
      writeJson(this.favoritesPath(), record);
    } else if (!favorite && index >= 0) {
      record.favorites.splice(index, 1);
      writeJson(this.favoritesPath(), record);
    }
    return this.favoritesSnapshot();
  }
  private validateTemplatePatternIds(patternIds: string[]) {
    const patternIdsInLibrary = new Set(this.patterns().map(pattern => pattern.id));
    if (patternIds.some(id => !patternIdsInLibrary.has(id))) throw new Error('Template references an unknown pattern.');
  }
  saveTemplate(name: string, patternIds: string[], id?: string, expectedRevision?: number, bypassOverallLimit?: boolean) {
    if (!Value.Check(TemplateSaveInputSchema, {
      name, patternIds, ...(bypassOverallLimit !== undefined ? { bypassOverallLimit } : {}),
    })) throw new Error('Template does not match the current schema.');
    if (id !== undefined && !Value.Check(TemplateIdSchema, id)) throw new Error('Invalid template ID.');
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) {
      throw new Error('Expected template revision must be a positive safe integer.');
    }
    const record = this.templatesRecord();
    this.validateTemplatePatternIds(patternIds);
    if (id === undefined) {
      if (expectedRevision !== undefined) throw new Error('A new template cannot have an expected revision.');
      if (record.templates.length >= MAX_TEMPLATES) throw new Error('The template limit has been reached.');
      const templateId = randomUUID();
      record.templates.push({
        id: templateId, name, patternIds: [...patternIds], bypassOverallLimit: bypassOverallLimit ?? true,
        revision: 1, updatedAt: now(),
      });
      writeJson(this.templatesPath(), record);
      return templateId;
    }
    if (expectedRevision === undefined) throw new Error('An expected revision is required when updating a template.');
    const index = record.templates.findIndex(template => template.id === id);
    if (index < 0) throw new Error('Template not found.');
    const current = record.templates[index]!;
    if (current.revision !== expectedRevision) throw new Error('Template changed. Reload before saving to avoid overwriting another revision.');
    if (current.revision >= Number.MAX_SAFE_INTEGER) throw new Error('Template revision limit has been reached.');
    record.templates[index] = {
      id, name, patternIds: [...patternIds],
      ...(bypassOverallLimit !== undefined
        ? { bypassOverallLimit }
        : current.bypassOverallLimit !== undefined ? { bypassOverallLimit: current.bypassOverallLimit } : {}),
      ...(current.isDefault !== undefined ? { isDefault: current.isDefault } : {}),
      revision: current.revision + 1, updatedAt: now(),
    };
    writeJson(this.templatesPath(), record);
    return id;
  }
  setTemplateDefault(id: string, expectedRevision: number, isDefault: boolean) {
    if (!Value.Check(TemplateIdSchema, id)) throw new Error('Invalid template ID.');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('Expected template revision must be a positive safe integer.');
    if (typeof isDefault !== 'boolean') throw new Error('Template default state must be a boolean.');
    const record = this.templatesRecord();
    const index = record.templates.findIndex(template => template.id === id);
    if (index < 0) throw new Error('Template not found.');
    const current = record.templates[index]!;
    if (current.revision !== expectedRevision) throw new Error('Template changed. Reload before updating it.');
    if ((current.isDefault ?? false) === isDefault) return;
    if (current.revision >= Number.MAX_SAFE_INTEGER) throw new Error('Template revision limit has been reached.');
    record.templates[index] = { ...current, isDefault, revision: current.revision + 1, updatedAt: now() };
    writeJson(this.templatesPath(), record);
  }
  deleteTemplate(id: string, expectedRevision: number) {
    if (!Value.Check(TemplateIdSchema, id)) throw new Error('Invalid template ID.');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('Expected template revision must be a positive safe integer.');
    const record = this.templatesRecord();
    const index = record.templates.findIndex(template => template.id === id);
    if (index < 0) throw new Error('Template not found.');
    if (record.templates[index]!.revision !== expectedRevision) throw new Error('Template changed. Reload before deleting it.');
    record.templates.splice(index, 1);
    writeJson(this.templatesPath(), record);
  }
  private sessionSelectionsPath() { return join(this.directory, 'session-selections.json'); }
  private sessionSelections(): SessionSelectionsRecord {
    const path = this.sessionSelectionsPath();
    if (!exists(path)) return { version: 1, sessions: [] };
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Invalid session selections storage path: ${path}`);
    const stored = this.read<SessionSelectionsRecord>(path);
    if (!Value.Check(SessionSelectionsSchema, stored)
      || new Set(stored.sessions.map(({ sessionId }) => sessionId)).size !== stored.sessions.length) {
      throw new Error('Session selections do not match the current schema.');
    }
    return stored;
  }
  private validateSessionId(sessionId: string) {
    if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 500) {
      throw new Error('Session ID must be nonblank and at most 500 characters.');
    }
  }
  private initializeSession(sessionId: string, stored = this.sessionSelections()) {
    let entry = stored.sessions.find(candidate => candidate.sessionId === sessionId);
    if (!entry) {
      const patterns = this.patterns();
      const eligibleIds = new Set(patterns.filter(pattern => !pattern.archived).map(pattern => pattern.id));
      const selectedIds = new Set(patterns.filter(pattern => pattern.enabled && !pattern.archived).map(pattern => pattern.id));
      const exampleLimitBypassIds = new Set<string>();
      for (const template of this.templatesRecord().templates) {
        if (!template.isDefault) continue;
        for (const patternId of template.patternIds) {
          if (!eligibleIds.has(patternId)) continue;
          selectedIds.add(patternId);
          if (template.bypassOverallLimit !== false) exampleLimitBypassIds.add(patternId);
        }
      }
      entry = {
        sessionId, patternIds: [...selectedIds],
        ...(exampleLimitBypassIds.size ? { exampleLimitBypassIds: [...exampleLimitBypassIds] } : {}),
      };
      // The empty entry is the initialization marker, so cleared defaults never reappear.
      stored.sessions.push(entry);
      writeJson(this.sessionSelectionsPath(), stored);
    }
    return { stored, entry };
  }
  sessionExampleOverrides(sessionId: string): string[] {
    this.validateSessionId(sessionId);
    const { entry } = this.initializeSession(sessionId);
    const selectedIds = new Set(entry.patternIds);
    const overrideIds = entry.exampleLimitBypassIds ?? [];
    const eligibleIds = new Set(this.patterns()
      .filter(pattern => !pattern.archived)
      .map(pattern => pattern.id));
    return overrideIds.filter(id => selectedIds.has(id) && eligibleIds.has(id));
  }
  sessionPatterns(sessionId: string): SessionPattern[] {
    this.validateSessionId(sessionId);
    const { entry } = this.initializeSession(sessionId);
    const selectedIds = entry.patternIds;
    return this.patterns()
      .filter(pattern => !pattern.archived)
      .map(pattern => ({
        id: pattern.id, name: pattern.name, format: pattern.format, structure: pattern.structure,
        rule: pattern.rule, reasoning: pattern.reasoning, tags: pattern.tags, revision: pattern.revision,
        selected: selectedIds.includes(pattern.id),
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }
  setSessionPattern(sessionId: string, patternId: string, selected: boolean): SessionPattern[] {
    this.validateSessionId(sessionId);
    if (typeof selected !== 'boolean') throw new Error('Pattern selection must be a boolean.');
    const pattern = this.patterns().find(candidate => candidate.id === patternId);
    if (!pattern) throw new Error('Pattern not found.');
    if (selected && pattern.archived) throw new Error('Cannot select an unavailable pattern.');

    const { stored, entry } = this.initializeSession(sessionId);
    const patternIds = [...entry.patternIds];
    const exampleLimitBypassIds = [...(entry.exampleLimitBypassIds ?? [])];
    const index = patternIds.indexOf(patternId);
    if (selected && index < 0) patternIds.push(patternId);
    if (!selected && index >= 0) patternIds.splice(index, 1);
    if (!selected) {
      const overrideIndex = exampleLimitBypassIds.indexOf(patternId);
      if (overrideIndex >= 0) exampleLimitBypassIds.splice(overrideIndex, 1);
    }
    const updatedEntry = {
      sessionId, patternIds,
      ...(exampleLimitBypassIds.length ? { exampleLimitBypassIds } : {}),
    };
    stored.sessions[stored.sessions.indexOf(entry)] = updatedEntry;
    writeJson(this.sessionSelectionsPath(), stored);
    return this.sessionPatterns(sessionId);
  }
  applyTemplate(sessionId: string, templateId: string, mode: 'add' | 'replace' | 'remove'): SessionPattern[] {
    this.validateSessionId(sessionId);
    if (!Value.Check(TemplateIdSchema, templateId)) throw new Error('Invalid template ID.');
    if (mode !== 'add' && mode !== 'replace' && mode !== 'remove') throw new Error('Template apply mode must be add, replace, or remove.');
    const template = this.templatesRecord().templates.find(candidate => candidate.id === templateId);
    if (!template) throw new Error('Template not found.');
    const eligibleIds = new Set(this.patterns().filter(pattern => !pattern.archived).map(pattern => pattern.id));
    const templateIds = template.patternIds.filter(id => eligibleIds.has(id));
    const templateIdSet = new Set(templateIds);
    const { stored, entry: current } = this.initializeSession(sessionId);
    const currentPatternIds = current.patternIds;
    const currentBypassIds = current.exampleLimitBypassIds ?? [];
    const patternIds = mode === 'replace'
      ? templateIds
      : mode === 'remove'
        ? currentPatternIds.filter(id => !templateIdSet.has(id))
        : [...new Set([...currentPatternIds, ...templateIds])];
    const bypassesOverallLimit = template.bypassOverallLimit !== false;
    const exampleLimitBypassIds = mode === 'replace'
      ? (bypassesOverallLimit ? [...templateIds] : [])
      : mode === 'remove'
        ? currentBypassIds.filter(id => !templateIdSet.has(id))
        : (bypassesOverallLimit
          ? [...new Set([...currentBypassIds, ...templateIds])]
          : [...currentBypassIds]);
    stored.sessions[stored.sessions.indexOf(current)] = {
      sessionId, patternIds,
      ...(exampleLimitBypassIds.length ? { exampleLimitBypassIds } : {}),
    };
    writeJson(this.sessionSelectionsPath(), stored);
    return this.sessionPatterns(sessionId);
  }
  snapshot(scope?: { history?: boolean; targetKind?: TargetKind; targetId?: string; runId?: string }): Snapshot {
    const sources = recordIds(this.directory, 'sources').map(id => {
      const record = this.source(id), revision = this.revision(record.revisionId);
      return { ...record, ...revision, id: record.id, revisionId: record.revisionId } as Source;
    }).sort((a, b) => b.importedAt.localeCompare(a.importedAt));
    const patterns = this.patterns();
    let runs: AnalysisRun[] = [];
    if (scope?.history) runs = this.runs();
    else if (scope?.targetKind && scope.targetId) runs = this.targetRuns(scope.targetKind, scope.targetId);
    else if (scope?.runId) { const run = this.run(scope.runId); runs = this.targetRuns(run.targetKind, run.targetId); }
    return { sources, patterns, runs, settings: this.settings() };
  }
  settings(): Settings {
    const stored = this.read<Settings & Versioned>(join(this.directory, 'settings.json'));
    if (!Value.Check(SettingsSchema, stored)) throw new Error('Settings do not match the current schema.');
    return { instructions: stored.instructions, maxTurns: stored.maxTurns, modelSlot: stored.modelSlot, analysisStrength: stored.analysisStrength };
  }
  saveSettings(settings: Settings) {
    const stored = { version: 1 as const, ...settings };
    if (!Value.Check(SettingsSchema, stored)) throw new Error('Settings do not match the current schema.');
    writeJson(join(this.directory, 'settings.json'), stored);
  }
  private exampleSettingsPath() { return join(this.directory, 'example-settings.json'); }
  exampleSettings(): ExampleSettings {
    const path = this.exampleSettingsPath();
    if (!exists(path)) return { ...DEFAULT_EXAMPLE_SETTINGS };
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Invalid example settings storage path: ${path}`);
    const stored = readJson<unknown>(path);
    if (stored && typeof stored === 'object' && !Array.isArray(stored)
      && (stored as { version?: unknown }).version !== 1) {
      throw new Error('Unknown record version. No data was changed; use a compatible plugin.');
    }
    if (!Value.Check(ExampleSettingsRecordSchema, stored)) throw new Error('Example settings do not match the current schema.');
    return { overallExampleLimit: (stored as ExampleSettings & Versioned).overallExampleLimit };
  }
  saveExampleSettings(settings: ExampleSettings): ExampleSettings {
    if (!Value.Check(ExampleSettingsSchema, settings)) throw new Error('Example settings do not match the current schema.');
    const saved = { version: 1 as const, overallExampleLimit: settings.overallExampleLimit };
    writeJson(this.exampleSettingsPath(), saved);
    return { overallExampleLimit: saved.overallExampleLimit };
  }
  private revision(id: string) { return this.read<SourceRevision>(this.path('sources', id, '.revision')); }
  private originalPath(revision: SourceRevision) {
    if (!/^(md|markdown|txt|pdf|json|csv|png|jpg|jpeg)$/.test(revision.extension)) throw new Error('Invalid source extension.');
    // The ID has already been validated by revision(). Do not follow stored paths.
    return join(this.directory, 'sources', `${revision.id}.original.${revision.extension}`);
  }
  sourceRevision(id: string) {
    const revision = this.revision(id), path = this.originalPath(revision);
    assertNotLinked(path);
    return { ...revision, bytes: readFileSync(path) };
  }
  revisionText(id: string) { const { filename, text, hash } = this.revision(id); return { filename, text, hash }; }
  sourceRevisions(sourceId: string) {
    return this.source(sourceId).revisionIds.map(id => {
      const r = this.revision(id);
      return { id, hash: r.hash, filename: r.filename, imported_at: r.importedAt };
    }).reverse();
  }
  importSource(input: ImportSource) {
    if (!input.bytes.length || input.bytes.length > MAX_FILE_BYTES) throw new Error('Original file must be nonempty and at most 25 MiB.');
    if (!input.text.trim() || Buffer.byteLength(input.text) > MAX_TEXT_BYTES) throw new Error('Extracted text must be nonempty and at most 2 MiB.');
    const hash = createHash('sha256').update(input.bytes).digest('hex');
    for (const sourceId of recordIds(this.directory, 'sources')) {
      const record = this.source(sourceId);
      if (record.revisionIds.some(id => this.revision(id).hash === hash)) return { id: record.id, duplicate: true, archived: record.archived };
    }
    const record: SourceRecord = input.replaceId ? this.source(input.replaceId) : { version: 1, id: randomUUID(), title: input.filename, tags: [], archived: false, revisionId: '', revisionIds: [], ...links() };
    if (record.archived) throw new Error('Restore the source before replacing it.');
    const revision: SourceRevision = { version: 1, id: randomUUID(), sourceId: record.id, hash, filename: input.filename,
      extension: input.filename.split('.').pop()!.toLowerCase(), kind: input.kind, location: input.location, importedAt: now(), text: input.text, notices: input.notices };
    // Originals and extracted evidence are write-once. Replacement changes only the source's pointer.
    atomicWrite(this.originalPath(revision), input.bytes, true);
    writeJson(this.path('sources', revision.id, '.revision'), revision, true);
    record.revisionId = revision.id; record.revisionIds.push(revision.id);
    writeJson(this.path('sources', record.id), record);
    return { id: record.id, duplicate: false, archived: false };
  }
  updateSource(id: string, title: string, tags: string[], archived: boolean) {
    const record = this.source(id);
    writeJson(this.path('sources', id), { ...record, title, tags, archived });
  }
  private assertSupportedCoreSeedVersion(record: PatternRecord) {
    if (record.coreSeedVersion !== undefined && record.coreSeedVersion > CORE_SEED_VERSION) {
      throw new Error(`Core pattern ${record.id} uses seed version ${record.coreSeedVersion}, newer than supported version ${CORE_SEED_VERSION}; no data was changed. Use a compatible plugin.`);
    }
  }
  private planPatternDeletionCleanup(patternIds: string[], requiredPatternId?: string): PatternDeletionPlan {
    const deletedIds = new Set(patternIds.map(id => id.toLowerCase()));
    const templates = this.templatesRecord();
    const favorites = this.favoritesRecord();
    const sessions = this.sessionSelections();
    const patternDirectory = join(this.directory, 'patterns');
    assertNotLinked(patternDirectory);
    let directoryExists = true;
    try {
      const info = lstatSync(patternDirectory);
      if (!info.isDirectory()) throw new Error(`Invalid pattern library path: ${patternDirectory}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      directoryExists = false;
    }

    const patternPaths: string[] = [];
    if (directoryExists) for (const deletedId of deletedIds) {
      const path = this.path('patterns', deletedId);
      try {
        const info = lstatSync(path);
        if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refusing linked pattern data: ${path}`);
        const record = readJson<unknown>(path);
        if (!validPatternRecord(record) || record.id.toLowerCase() !== deletedId) {
          throw new Error(`Unknown or invalid pattern metadata in ${path}; no data was changed.`);
        }
        if (CORE_PATTERNS.some(core => core.id.toLowerCase() === deletedId)) this.assertSupportedCoreSeedVersion(record);
        patternPaths.push(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (requiredPatternId && !patternPaths.some(path => basename(path).toLowerCase() === `${requiredPatternId.toLowerCase()}.json`)) {
      throw new Error('Pattern not found.');
    }

    let writeTemplates = false;
    templates.templates = templates.templates.map(template => {
      const patternIds = template.patternIds.filter(id => !deletedIds.has(id.toLowerCase()));
      if (patternIds.length === template.patternIds.length) return template;
      if (template.revision >= Number.MAX_SAFE_INTEGER) throw new Error(`Template ${template.id} revision limit has been reached.`);
      writeTemplates = true;
      return { ...template, patternIds, revision: template.revision + 1, updatedAt: now() };
    });

    const favoriteEntries = favorites.favorites.filter(entry =>
      entry.kind !== 'pattern' || !deletedIds.has(entry.id.toLowerCase()));
    const writeFavorites = favoriteEntries.length !== favorites.favorites.length;
    favorites.favorites = favoriteEntries;

    let writeSessions = false;
    sessions.sessions = sessions.sessions.flatMap(session => {
      const patternIds = session.patternIds.filter(id => !deletedIds.has(id.toLowerCase()));
      const exampleLimitBypassIds = (session.exampleLimitBypassIds ?? []).filter(id => !deletedIds.has(id.toLowerCase()));
      if (patternIds.length === session.patternIds.length
        && exampleLimitBypassIds.length === (session.exampleLimitBypassIds ?? []).length) return [session];
      writeSessions = true;
      return [{
        sessionId: session.sessionId, patternIds,
        ...(exampleLimitBypassIds.length ? { exampleLimitBypassIds } : {}),
      }];
    });
    return { templates, writeTemplates, favorites, writeFavorites, sessions, writeSessions, patternPaths };
  }
  private applyPatternDeletionCleanup(plan: PatternDeletionPlan) {
    if (plan.writeTemplates) writeJson(this.templatesPath(), plan.templates);
    if (plan.writeFavorites) writeJson(this.favoritesPath(), plan.favorites);
    if (plan.writeSessions) writeJson(this.sessionSelectionsPath(), plan.sessions);
    for (const path of plan.patternPaths) {
      assertNotLinked(dirname(path));
      try {
        const info = lstatSync(path);
        if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refusing changed pattern data path: ${path}`);
        const record = readJson<unknown>(path);
        if (!validPatternRecord(record) || record.id.toLowerCase() !== basename(path, '.json').toLowerCase()) {
          throw new Error(`Refusing changed pattern data path: ${path}`);
        }
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  // The journal commits deletion before cross-file cleanup, so retries cannot restore
  // a pattern after interruption and core seeding cannot recreate a deleted built-in.
  private resumeDeletedPatternCleanup() {
    const journal = this.deletedPatternsRecord();
    if (!journal.patternIds.length) return;
    const plan = this.planPatternDeletionCleanup(journal.patternIds);
    this.applyPatternDeletionCleanup(plan);
  }
  deletePattern(id: string, expectedRevision: number) {
    if (!Value.Check(TemplateIdSchema, id)) throw new Error('Invalid pattern ID.');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error('Expected pattern revision must be a positive safe integer.');
    }
    const patternId = id.toLowerCase();
    const journal = this.deletedPatternsRecord();
    if (journal.patternIds.some(deletedId => deletedId.toLowerCase() === patternId)) {
      const plan = this.planPatternDeletionCleanup(journal.patternIds);
      this.applyPatternDeletionCleanup(plan);
      return;
    }

    const pattern = this.pattern(patternId);
    if (pattern.versions.at(-1)!.revision !== expectedRevision) throw new Error('Pattern changed. Reload before deleting it.');

    const deletedIds = [...journal.patternIds, patternId];
    const plan = this.planPatternDeletionCleanup(deletedIds, patternId);
    writeJson(this.deletedPatternsPath(), { version: 1, patternIds: deletedIds });
    this.applyPatternDeletionCleanup(plan);
  }
  private seedCorePatterns() {
    const deletedIds = new Set(this.deletedPatternsRecord().patternIds.map(id => id.toLowerCase()));
    const records = CORE_PATTERNS.filter(definition => !deletedIds.has(definition.id.toLowerCase())).map(definition => {
      const path = this.path('patterns', definition.id);
      if (!exists(path)) return { definition, path, record: undefined };
      const record = this.read<PatternRecord>(path);
      if (!validPatternRecord(record) || record.id !== definition.id) {
        throw new Error(`Unknown or invalid pattern metadata in ${path}; no data was changed.`);
      }
      this.assertSupportedCoreSeedVersion(record);
      return { definition, path, record };
    });

    for (const { definition, path, record: existing } of records) {
      if (!existing) {
        const record: PatternRecord = {
          version: 1, id: definition.id, coreSeedVersion: CORE_SEED_VERSION,
          tags: ['Core'], enabled: definition.defaultSelected ?? false, archived: false,
          versions: [{
            revision: 1, content: patternContent(definition.content),
            examples: structuredClone(definition.examples), exampleLimit: DEFAULT_PATTERN_EXAMPLE_LIMIT,
            createdAt: now(), ...(this.patternsOnly ? {} : { runId: null, itemId: null }),
          }],
          ...(this.patternsOnly ? {} : links()),
        };
        writeJson(path, record, true);
        continue;
      }
      if ((existing.coreSeedVersion ?? 0) >= CORE_SEED_VERSION) continue;

      const previous = existing.versions.at(-1)!;
      if (previous.revision >= Number.MAX_SAFE_INTEGER) throw new Error(`Core pattern ${existing.id} revision limit has been reached.`);
      const version: PatternVersion = {
        revision: previous.revision + 1,
        content: patternContent(definition.content),
        examples: mergedCoreExamples(definition.examples, previous.examples),
        exampleLimit: previous.exampleLimit !== undefined ? previous.exampleLimit : DEFAULT_PATTERN_EXAMPLE_LIMIT,
        ...(this.patternsOnly ? {} : { runId: null, itemId: null }),
        createdAt: now(),
      };
      writeJson(path, { ...existing, coreSeedVersion: CORE_SEED_VERSION, versions: [...existing.versions, version] });
    }
  }
  private projectPattern(record: PatternRecord): LegacyPattern {
    const version = record.versions.at(-1);
    if (!version) throw new Error('Pattern has no approved version.');
    return { ...patternContent(version.content),
      ...(version.examples !== undefined ? { examples: structuredClone(version.examples) } : {}),
      ...(version.exampleLimit !== undefined ? { exampleLimit: version.exampleLimit } : {}),
      id: record.id, tags: record.tags, enabled: record.enabled, archived: record.archived,
      revision: version.revision, updatedAt: version.createdAt, analysisIds: record.analysisIds ?? [], activeAnalysisId: record.activeAnalysisId ?? null, patternIds: record.patternIds ?? [] };
  }
  private validateExampleConfig(config: unknown): asserts config is PatternExampleConfig {
    if (!Value.Check(PatternExampleConfigSchema, config)) throw new Error('Pattern examples/config do not match the current schema.');
    if (config.examples && new Set(config.examples.map(example => example.id)).size !== config.examples.length) {
      throw new Error('Pattern example IDs must be unique.');
    }
  }
  savePattern(content: PatternContent, tags: string[], enabled: boolean, id?: string, expectedRevision?: number, origin?: { runId: string; itemId: string }, exampleConfig?: PatternExampleConfig) {
    if (id !== undefined) this.assertPatternNotDeleted(id);
    if (origin !== undefined) this.assertPatternNotDeleted(origin.itemId);
    if (exampleConfig !== undefined) this.validateExampleConfig(exampleConfig);
    const definition = patternContent(content);
    const existing = id ? this.pattern(id) : undefined;
    if (origin && existing?.versions.some(v => v.itemId === origin.itemId)) return existing.id;
    if (existing && existing.versions.at(-1)!.revision !== expectedRevision) throw new Error('Pattern changed. Reload before saving to avoid overwriting another version.');
    if (existing?.archived) throw new Error('Restore this pattern before editing it.');
    const record: PatternRecord = existing ?? { version: 1, id: origin?.itemId ?? randomUUID(), tags: [], enabled: true, archived: false, versions: [], ...(this.patternsOnly ? {} : links()) };
    if (!existing && exists(this.path('patterns', record.id))) {
      const applied = this.pattern(record.id);
      if (origin && applied.versions.some(v => v.itemId === origin.itemId)) return record.id;
      throw new Error('Pattern ID collision.');
    }
    const previousVersion = record.versions.at(-1);
    const examples = exampleConfig?.examples ?? previousVersion?.examples;
    const exampleLimit = exampleConfig?.exampleLimit !== undefined ? exampleConfig.exampleLimit : previousVersion?.exampleLimit;
    const version: PatternVersion = {
      revision: (previousVersion?.revision ?? 0) + 1,
      content: definition,
      ...(examples !== undefined ? { examples: structuredClone(examples) } : !existing ? { examples: [] } : {}),
      ...(exampleLimit !== undefined ? { exampleLimit } : !existing ? { exampleLimit: DEFAULT_PATTERN_EXAMPLE_LIMIT } : {}),
      ...(this.patternsOnly ? {} : { runId: origin?.runId ?? null, itemId: origin?.itemId ?? null }),
      createdAt: now(),
    };
    record.versions.push(version); record.tags = tags; record.enabled = enabled;
    writeJson(this.path('patterns', record.id), record);
    return record.id;
  }
  setPatternEnabled(id: string, enabled: boolean) {
    if (typeof enabled !== 'boolean') throw new Error('Pattern enabled state must be a boolean.');
    this.assertPatternNotDeleted(id);
    const record = this.read<PatternRecord>(this.path('patterns', id));
    if (record.archived) throw new Error('Restore this pattern before editing it.');
    if (record.enabled === enabled) return;
    record.enabled = enabled;
    this.saveRecord('pattern', record);
  }
  archive(kind: TargetKind, id: string, archived: boolean) {
    const record = this.record(kind, id);
    record.archived = archived; this.saveRecord(kind, record);
  }
  patternVersions(id: string) { return this.pattern(id).versions.toReversed(); }
  private request(id: string) { return this.read<RequestRecord>(this.path('analyses', id)).run; }
  private result(id: string) {
    const path = this.path('analyses', id, '.result');
    return exists(path) ? this.read<ResultRecord>(path) : null;
  }
  run(id: string): AnalysisRun {
    const request = this.request(id), result = this.result(id);
    return result ? { ...request, status: result.status, error: result.error, usage: result.usage, completedAt: result.completedAt } : request;
  }
  /** History is explicitly requested; the initial library snapshot never reads this folder. */
  runs(): AnalysisRun[] { return recordIds(this.directory, 'analyses').map(id => this.run(id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  targetRuns(kind: TargetKind, id: string) { return this.withLinks(this.record(kind, id)).analysisIds.map(id => this.run(id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  findRequest(requestId: string) { return this.runs().find(run => run.requestId === requestId); }
  private review(runId: string): ReviewRecord {
    const path = this.path('analyses', runId, '.review');
    return exists(path) ? this.read<ReviewRecord>(path) : { version: 1, decisions: {} };
  }
  items(runId: string): AnalysisItem[] {
    const result = this.result(runId), review = this.review(runId);
    return (result?.items ?? []).map(item => ({ ...item, ...(review.decisions[item.id] ?? { decision: 'candidate', appliedId: null }) }));
  }
  target(kind: TargetKind, id: string) {
    if (kind === 'source') {
      const source = this.source(id);
      if (source.archived) throw new Error('Restore this item before scanning.');
      return { title: source.title, revision: source.revisionId };
    }
    const record = this.pattern(id);
    if (record.archived) throw new Error('Restore this item before scanning.');
    const pattern = this.projectPattern(record);
    return { title: pattern.name, revision: String(pattern.revision) };
  }
  inputText(run: AnalysisRun) {
    if (run.targetKind === 'source') return this.revision(run.inputRevision).text;
    const version = this.pattern(run.targetId).versions.find(v => String(v.revision) === run.inputRevision);
    if (!version) throw new Error('Pattern input version not found.');
    return Object.entries(version.content).map(([key, value]) => `${key}:\n${typeof value === 'object' ? JSON.stringify(value) : value}`).join('\n\n');
  }
  createRun(input: Pick<AnalysisRun, 'requestId' | 'targetKind' | 'targetId' | 'model' | 'instructions'>) {
    const target = this.target(input.targetKind, input.targetId);
    const run: AnalysisRun = { ...input, id: randomUUID(), targetTitle: target.title, inputRevision: target.revision,
      promptVersion: PROMPT_VERSION, createdAt: now(), completedAt: null, taskId: null,
      status: 'starting', error: null, usage: null };
    writeJson(this.path('analyses', run.id), { version: 1, run }, true);
    this.attachRun(run);
    return run;
  }
  finishRun(outputId: string, output: Analysis, usage: unknown) {
    const run = this.request(outputId);
    validateAnalysis(output, this.inputText(run));
    if (!this.result(outputId)) {
      const items: ResultRecord['items'] = output.patterns.map(value => ({ id: randomUUID(), runId: outputId, kind: 'pattern', key: value.key, value }));
      writeJson(this.path('analyses', outputId, '.result'), { version: 1, status: 'succeeded', completedAt: now(), usage: usage ?? null, error: null, items } satisfies ResultRecord, true);
    }
    if (this.result(outputId)?.status === 'succeeded') {
      this.autoAssociateMatches(run);
      this.attachRun(run, true);
    }
  }
  failRun(id: string, status: 'failed' | 'cancelled' | 'interrupted', error: string, usage: unknown = null) {
    if (this.result(id)) return;
    writeJson(this.path('analyses', id, '.result'), { version: 1, status, completedAt: now(), error, usage, items: [] } satisfies ResultRecord, true);
  }
  /** Repair cross-file references after a crash; never replay inference or overwrite a result. */
  reconcile() {
    for (const run of this.runs()) {
      if (run.status === 'succeeded') this.autoAssociateMatches(run);
      this.attachRun(run, run.status === 'succeeded');
    }
  }
  private patternApprovedFor(runId: string, itemId: string, content: PatternContent): PatternRecord | undefined {
    const matches = recordIds(this.directory, 'patterns').map(id => this.pattern(id)).filter(record =>
      record.enabled && !record.archived
      && record.versions.some(version => version.runId === runId && version.itemId === itemId)
      && samePatternStructure(this.projectPattern(record), content));
    return matches.length === 1 ? matches[0] : undefined;
  }
  private matchingPattern(content: PatternContent, proposedId: string | null): PatternRecord | undefined {
    const eligible = recordIds(this.directory, 'patterns').map(id => this.pattern(id))
      .filter(record => record.enabled && !record.archived && samePatternStructure(this.projectPattern(record), content));
    if (proposedId) {
      const suggested = eligible.find(record => record.id === proposedId);
      if (suggested) return suggested;
    }
    return eligible.length === 1 ? eligible[0] : undefined;
  }
  /** Link confident matches only; separate files can be repaired without changing analysis output. */
  private autoAssociateMatches(run: AnalysisRun) {
    if (this.result(run.id)?.status !== 'succeeded') return;
    const review = this.review(run.id);
    let reviewChanged = false;
    let targetRecord: SourceRecord | undefined;
    for (const item of this.items(run.id)) {
      if (item.kind !== 'pattern') continue;
      if (item.decision === 'accepted' && item.appliedId && run.targetKind === 'source') {
        targetRecord ??= this.source(run.targetId);
        if (!targetRecord.patternIds.includes(item.appliedId)) targetRecord.patternIds.push(item.appliedId);
        continue;
      }
      if (item.decision !== 'candidate') continue;
      const content = patternContent(item.value);
      const priorApproval = this.patternApprovedFor(run.id, item.id, content);
      const existing = priorApproval ?? (item.value.support === 'supported' ? this.matchingPattern(content, item.value.existingPatternId) : undefined);
      if (!existing) continue;
      review.decisions[item.id] = priorApproval
        ? { decision: 'accepted', appliedId: existing.id }
        : { decision: 'accepted', appliedId: existing.id, automatic: true };
      reviewChanged = true;
      if (run.targetKind === 'source') {
        targetRecord ??= this.source(run.targetId);
        if (!targetRecord.patternIds.includes(existing.id)) targetRecord.patternIds.push(existing.id);
      }
    }
    if (reviewChanged) writeJson(this.path('analyses', run.id, '.review'), review);
    if (targetRecord) writeJson(this.path('sources', targetRecord.id), targetRecord);
  }
  private autoAssociatePendingMatches() {
    for (const run of this.runs()) if (run.status === 'succeeded') this.autoAssociateMatches(run);
  }
  decide(itemId: string, decision: 'accepted' | 'rejected', runId: string, editedContent?: PatternContent) {
    const run = this.run(runId), item = this.items(runId).find(candidate => candidate.id === itemId);
    if (!item) throw new Error('Analysis item not found.');
    if (item.decision === decision) {
      if (decision === 'accepted' && item.kind === 'pattern') this.autoAssociatePendingMatches();
      return;
    }
    if (item.decision !== 'candidate') throw new Error('This review decision is final. Rescan to propose a new change; previous results are retained.');
    let appliedId: string | null = null;
    if (decision === 'accepted') {
      const content = patternContent(editedContent ?? item.value);
      const reusable = this.matchingPattern(content, item.value.existingPatternId);
      const target = run.targetKind === 'pattern' ? this.pattern(run.targetId) : undefined;
      // A source review can only link or create. Editing a proposal must never edit
      // another approved definition; saved-pattern changes have their own editor.
      appliedId = reusable ? reusable.id : this.savePattern(content, target?.tags ?? [], target?.enabled ?? true,
        target?.id, target ? Number(run.inputRevision) : undefined, { runId: run.id, itemId: item.id });
    }
    // The decision record is separate from immutable model output; reconciliation repairs links after crashes.
    const review = this.review(run.id);
    review.decisions[item.id] = { decision, appliedId };
    writeJson(this.path('analyses', run.id, '.review'), review);
    if (decision === 'accepted' && appliedId) {
      const targetRecord = this.withLinks(this.record(run.targetKind, run.targetId));
      if (appliedId !== targetRecord.id && !targetRecord.patternIds.includes(appliedId)) {
        targetRecord.patternIds.push(appliedId);
        this.saveRecord(run.targetKind, targetRecord);
      }
      this.autoAssociatePendingMatches();
    }
  }
}
