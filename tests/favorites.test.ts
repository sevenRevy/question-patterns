import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PatternsSnapshot, TemplatesSnapshot } from '../src/domain';
import { backend, temporary } from './fixture';

interface FavoritesSnapshot { favorites: Array<{ kind: 'pattern' | 'template'; id: string }> }

const savedBytes = (path: string) => readFileSync(path);

test('favorites are independently persisted for patterns and templates and survive restart', async () => {
  const temp = temporary();
  let host = await backend(temp.directory);
  try {
    const pattern = (await host.call<PatternsSnapshot>('patterns-snapshot')).patterns[0]!;
    const templateId = await host.call<string>('template-save', { name: 'Favorite group', patternIds: [pattern.id] });
    const patternPath = join(temp.directory, 'patterns', `${pattern.id}.json`);
    const templatesPath = join(temp.directory, 'templates.json');
    const patternsBefore = savedBytes(patternPath);
    const templatesBefore = savedBytes(templatesPath);

    const notifications = host.notifications;
    assert.deepEqual(await host.call<FavoritesSnapshot>('favorites-snapshot'), { favorites: [] });
    assert.equal(host.notifications, notifications, 'snapshot reads do not notify');
    assert.equal(existsSync(join(temp.directory, 'favorites.json')), false, 'reading does not create favorite storage');

    const patternFavorite = await host.call<FavoritesSnapshot>('favorite-set', {
      kind: 'pattern', id: pattern.id, favorite: true,
    });
    assert.deepEqual(patternFavorite, { favorites: [{ kind: 'pattern', id: pattern.id }] });
    assert.deepEqual(host.emitted.at(-1), { topic: 'library-changed', data: undefined });
    const bothFavorites = await host.call<FavoritesSnapshot>('favorite-set', {
      kind: 'template', id: templateId, favorite: true,
    });
    assert.deepEqual(bothFavorites, { favorites: [
      { kind: 'pattern', id: pattern.id }, { kind: 'template', id: templateId },
    ] });
    assert.deepEqual(await host.call<FavoritesSnapshot>('favorite-set', {
      kind: 'pattern', id: pattern.id, favorite: true,
    }), bothFavorites, 'repeating an enabled toggle does not duplicate favorites');
    assert.deepEqual(await host.call<FavoritesSnapshot>('favorite-set', {
      kind: 'pattern', id: pattern.id, favorite: false,
    }), { favorites: [{ kind: 'template', id: templateId }] });

    const stored = JSON.parse(readFileSync(join(temp.directory, 'favorites.json'), 'utf8'));
    assert.deepEqual(Object.keys(stored).sort(), ['favorites', 'version']);
    assert.equal(stored.version, 1);
    assert.deepEqual(stored.favorites, [{ kind: 'template', id: templateId }]);
    assert.deepEqual(savedBytes(patternPath), patternsBefore, 'favorites do not revise or mutate pattern records');
    assert.deepEqual(savedBytes(templatesPath), templatesBefore, 'favorites do not mutate template records');

    await host.dispose();
    host = await backend(temp.directory);
    assert.deepEqual(await host.call<FavoritesSnapshot>('favorites-snapshot'), { favorites: [{ kind: 'template', id: templateId }] });
    assert.equal((await host.call<TemplatesSnapshot>('templates-snapshot')).templates[0]?.id, templateId);
  } finally { await host.dispose(); temp.remove(); }
});

test('favorite writes validate kind, ID, boolean state, and current item references', async () => {
  const temp = temporary(), host = await backend(temp.directory);
  try {
    const pattern = (await host.call<PatternsSnapshot>('patterns-snapshot')).patterns[0]!;
    const validId = crypto.randomUUID();
    for (const input of [
      { kind: 'source', id: pattern.id, favorite: true },
      { kind: 'pattern', id: validId, favorite: true },
      { kind: 'template', id: validId, favorite: true },
      { kind: 'pattern', id: pattern.id, favorite: 'true' },
      { kind: 'pattern', id: pattern.id, favorite: true, extra: true },
      { kind: 'pattern', id: 'not-a-uuid', favorite: true },
    ]) await assert.rejects(host.call('favorite-set', input));
    assert.deepEqual(await host.call<FavoritesSnapshot>('favorites-snapshot'), { favorites: [] });
    assert.equal(existsSync(join(temp.directory, 'favorites.json')), false, 'invalid requests do not create storage');
  } finally { await host.dispose(); temp.remove(); }
});
