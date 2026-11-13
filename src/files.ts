import { mkdirSync, readFileSync, lstatSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, linkSync, readdirSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Value } from 'typebox/value';
import { SettingsSchema } from './domain';

export function assertNotLinked(path: string) {
  try { if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing linked plugin data: ${path}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
/** Atomic single-file writes. Write-once publication uses a hard link so it cannot replace an existing original/result. */
export function atomicWrite(path: string, bytes: string | Uint8Array, immutable = false) {
  assertNotLinked(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    if (immutable) linkSync(temporary, path);
    else renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
export function readJson<T>(path: string): T {
  assertNotLinked(path);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}
export function writeJson(path: string, value: unknown, immutable = false) {
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`, immutable);
}
export function exists(path: string) {
  assertNotLinked(path);
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export function makeDirectory(path: string) { assertNotLinked(path); mkdirSync(path, { recursive: true }); }
export function recordPath(root: string, folder: string, id: string, suffix = '') {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid record ID.');
  return join(root, folder, `${id}${suffix}.json`);
}
export function recordIds(root: string, folder: string) {
  const directory = join(root, folder);
  assertNotLinked(directory);
  return readdirSync(directory).filter(name => /^[0-9a-f-]{36}\.json$/i.test(name)).map(name => name.slice(0, -5));
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sourceExtensions = 'md|markdown|txt|pdf|json|csv|png|jpg|jpeg';
type LegacyFileKind = 'source-original' | 'source-metadata' | 'analysis-history' | 'settings' | 'temporary';
interface PlannedFile { path: string; kind: LegacyFileKind }
export interface LegacyCleanupPlan {
  root: string;
  files: PlannedFile[];
  directories: string[];
}
export interface LegacyCleanupReport {
  sourceFiles: number;
  sourceMetadata: number;
  analysisHistory: number;
  settings: boolean;
}

function checkKeys(value: Record<string, unknown>, allowed: string[], path: string) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`Unknown legacy metadata in ${path}; no data was changed.`);
}
function readLegacyRecord(path: string, allowedKeys: string[], expectedId?: string) {
  assertNotLinked(path);
  const info = lstatSync(path);
  if (!info.isFile()) throw new Error(`Unexpected legacy data path: ${path}; no data was changed.`);
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid legacy metadata in ${path}; no data was changed.`);
  const record = value as Record<string, unknown>;
  if (record.version !== 1) throw new Error(`Unknown legacy record version in ${path}; no data was changed.`);
  checkKeys(record, allowedKeys, path);
  if (expectedId !== undefined && record.id !== expectedId) throw new Error(`Legacy record ID mismatch in ${path}; no data was changed.`);
  return record;
}
function directoryEntries(path: string): string[] | null {
  assertNotLinked(path);
  try {
    const info = lstatSync(path);
    if (!info.isDirectory()) throw new Error(`Unexpected legacy data path: ${path}; no data was changed.`);
    return readdirSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Validate every legacy deletion target before removing any of them. */
export function planLegacyCleanup(root: string): LegacyCleanupPlan {
  assertNotLinked(root);
  const files: PlannedFile[] = [];
  const directories: string[] = [];
  const folders = [
    { name: 'sources', kind: 'source' as const },
    { name: 'analyses', kind: 'analysis' as const },
  ];

  for (const folder of folders) {
    const path = join(root, folder.name);
    const entries = directoryEntries(path);
    if (!entries) continue;
    directories.push(path);
    for (const name of entries) {
      const target = join(path, name);
      const stat = lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Refusing unknown or linked legacy data: ${target}; no data was changed.`);
      const temporary = /^(.+)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.tmp$/i.exec(name);
      const targetName = temporary?.[1] ?? name;
      const sourceRecord = folder.kind === 'source' && /^([0-9a-f-]{36})\.json$/i.exec(targetName);
      const sourceRevision = folder.kind === 'source' && /^([0-9a-f-]{36})\.revision\.json$/i.exec(targetName);
      const sourceOriginal = folder.kind === 'source' && new RegExp(`^([0-9a-f-]{36})\\.original\\.(${sourceExtensions})$`, 'i').exec(targetName);
      const analysisRecord = folder.kind === 'analysis' && /^([0-9a-f-]{36})\.json$/i.exec(targetName);
      const analysisResult = folder.kind === 'analysis' && /^([0-9a-f-]{36})\.result\.json$/i.exec(targetName);
      const analysisReview = folder.kind === 'analysis' && /^([0-9a-f-]{36})\.review\.json$/i.exec(targetName);

      const recognizedTemporaryTarget = [sourceRecord, sourceRevision, sourceOriginal, analysisRecord, analysisResult, analysisReview]
        .some(match => !!match && uuid.test(match[1]!));
      if (temporary && recognizedTemporaryTarget) {
        files.push({ path: target, kind: 'temporary' });
      } else if (temporary) {
        throw new Error(`Unknown legacy temporary file ${target}; no data was changed.`);
      } else if (sourceRecord && uuid.test(sourceRecord[1]!)) {
        const record = readLegacyRecord(target, ['version', 'id', 'title', 'tags', 'archived', 'revisionId', 'revisionIds', 'analysisIds', 'activeAnalysisId', 'patternIds'], sourceRecord[1]);
        if (!Array.isArray(record.revisionIds) || !Array.isArray(record.analysisIds) || !Array.isArray(record.patternIds)) throw new Error(`Invalid legacy source metadata in ${target}; no data was changed.`);
        files.push({ path: target, kind: 'source-metadata' });
      } else if (sourceRevision && uuid.test(sourceRevision[1]!)) {
        readLegacyRecord(target, ['version', 'id', 'sourceId', 'hash', 'filename', 'extension', 'kind', 'location', 'importedAt', 'text', 'notices'], sourceRevision[1]);
        files.push({ path: target, kind: 'source-metadata' });
      } else if (sourceOriginal && uuid.test(sourceOriginal[1]!)) {
        files.push({ path: target, kind: 'source-original' });
      } else if (analysisRecord && uuid.test(analysisRecord[1]!)) {
        const record = readLegacyRecord(target, ['version', 'run']);
        const run = record.run;
        if (!run || typeof run !== 'object' || Array.isArray(run) || (run as Record<string, unknown>).id !== analysisRecord[1]) {
          throw new Error(`Invalid legacy analysis metadata in ${target}; no data was changed.`);
        }
        checkKeys(run as Record<string, unknown>, ['id', 'requestId', 'targetKind', 'targetId', 'targetTitle', 'inputRevision', 'model', 'instructions', 'promptVersion', 'createdAt', 'completedAt', 'taskId', 'status', 'error', 'usage'], target);
        files.push({ path: target, kind: 'analysis-history' });
      } else if (analysisResult && uuid.test(analysisResult[1]!)) {
        readLegacyRecord(target, ['version', 'status', 'completedAt', 'usage', 'error', 'items']);
        files.push({ path: target, kind: 'analysis-history' });
      } else if (analysisReview && uuid.test(analysisReview[1]!)) {
        readLegacyRecord(target, ['version', 'decisions']);
        files.push({ path: target, kind: 'analysis-history' });
      } else {
        throw new Error(`Unknown legacy data file ${target}; no data was changed.`);
      }
    }
  }

  const settingsPath = join(root, 'settings.json');
  assertNotLinked(settingsPath);
  try {
    const settings = readLegacyRecord(settingsPath, ['version', 'instructions', 'maxTurns', 'modelSlot', 'analysisStrength']);
    if (!Value.Check(SettingsSchema, settings)) throw new Error(`Invalid obsolete settings metadata in ${settingsPath}; no data was changed.`);
    files.push({ path: settingsPath, kind: 'settings' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { root, files, directories };
}

/** Delete a prevalidated plan. Missing files are tolerated so an interrupted cleanup can be rerun. */
export function applyLegacyCleanup(plan: LegacyCleanupPlan): LegacyCleanupReport {
  const report: LegacyCleanupReport = { sourceFiles: 0, sourceMetadata: 0, analysisHistory: 0, settings: false };
  assertNotLinked(plan.root);
  for (const file of plan.files) {
    assertNotLinked(dirname(file.path));
    try {
      const info = lstatSync(file.path);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refusing changed legacy data path: ${file.path}`);
      unlinkSync(file.path);
      if (file.kind === 'source-original') report.sourceFiles++;
      else if (file.kind === 'source-metadata') report.sourceMetadata++;
      else if (file.kind === 'analysis-history') report.analysisHistory++;
      else if (file.kind === 'settings') report.settings = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  for (const directory of plan.directories) {
    assertNotLinked(dirname(directory));
    try {
      const info = lstatSync(directory);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Refusing changed legacy directory: ${directory}`);
      rmdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return report;
}
