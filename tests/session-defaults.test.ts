import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PatternsSnapshot, TemplatesSnapshot } from '../src/domain';
import { Store } from '../src/store';
import { backend, temporary } from './fixture';

async function createPattern(host: Awaited<ReturnType<typeof backend>>, name: string, enabled: boolean) {
  return host.call<string>('pattern-save', {
    content: { name, format: 'short_answer', structure: {}, rule: `Use ${name}.`, reasoning: [] },
    tags: [], enabled,
  });
}

async function disableAllPatterns(host: Awaited<ReturnType<typeof backend>>) {
  const { patterns } = await host.call<PatternsSnapshot>('patterns-snapshot');
  for (const pattern of patterns) await host.call('pattern-enabled-set', { id: pattern.id, enabled: false });
}

function selectedIds(patterns: Array<{ id: string; selected: boolean }>) {
  return patterns.filter(pattern => pattern.selected).map(pattern => pattern.id).sort();
}

test('defaults initialize once per session from enabled patterns and default template members', async () => {
  const temp = temporary(), host = await backend(temp.directory);
  try {
    await disableAllPatterns(host);
    const enabled = await createPattern(host, 'Enabled default', true);
    const fromDefaultTemplate = await createPattern(host, 'Disabled template member', false);
    const shared = await createPattern(host, 'Shared template member', false);
    const notDefault = await createPattern(host, 'Ordinary template member', false);
    const bypassTemplate = await host.call<string>('template-save', {
      name: 'Default with bypass', patternIds: [fromDefaultTemplate, shared],
    });
    const cappedTemplate = await host.call<string>('template-save', {
      name: 'Default without bypass', patternIds: [shared], bypassOverallLimit: false,
    });
    const ordinaryTemplate = await host.call<string>('template-save', {
      name: 'Not a default', patternIds: [notDefault],
    });
    await host.call('template-default-set', { id: bypassTemplate, expectedRevision: 1, isDefault: true });
    await host.call('template-default-set', { id: cappedTemplate, expectedRevision: 1, isDefault: true });
    await assert.rejects(host.call('template-default-set', {
      id: bypassTemplate, expectedRevision: 2, isDefault: 'true',
    }), /Invalid/);
    await assert.rejects(host.call('template-default-set', {
      id: bypassTemplate, expectedRevision: 2, isDefault: true, extra: true,
    }), /Invalid/);

    const session = await host.call<Array<{ id: string; selected: boolean }>>('session-patterns', { sessionId: 'first-read' });
    assert.deepEqual(selectedIds(session), [enabled, fromDefaultTemplate, shared].sort());
    assert.ok(session.some(pattern => pattern.id === notDefault && !pattern.selected), 'disabled non-default template members are available but not selected');
    await host.call('session-pattern-context', { sessionId: 'overrides-first' });
    const overrideEntry = JSON.parse(readFileSync(join(temp.directory, 'session-selections.json'), 'utf8'))
      .sessions.find((entry: { sessionId: string }) => entry.sessionId === 'overrides-first');
    assert.deepEqual(overrideEntry.exampleLimitBypassIds, [fromDefaultTemplate, shared], 'only bypassing default templates add exemption provenance');
    assert.deepEqual(await host.call('session-template-apply', {
      sessionId: 'apply-first', templateId: ordinaryTemplate, mode: 'add',
    }).then(selectedIds), [enabled, fromDefaultTemplate, notDefault, shared].sort());

    const templateSnapshot = await host.call<TemplatesSnapshot>('templates-snapshot');
    assert.equal(templateSnapshot.templates.find(template => template.id === bypassTemplate)?.isDefault, true);
    assert.equal(templateSnapshot.templates.find(template => template.id === bypassTemplate)?.revision, 2);
    await assert.rejects(host.call('template-default-set', {
      id: bypassTemplate, expectedRevision: 1, isDefault: false,
    }), /changed/);
    await host.call('template-save', {
      id: bypassTemplate, expectedRevision: 2, name: 'Edited default', patternIds: [fromDefaultTemplate, shared],
    });
    assert.equal((await host.call<TemplatesSnapshot>('templates-snapshot')).templates.find(template => template.id === bypassTemplate)?.isDefault, true,
      'editing template content preserves its default setting');
  } finally { await host.dispose(); temp.remove(); }
});

test('cleared sessions stay empty while future defaults change; defaults do not rewrite other sessions', async () => {
  const temp = temporary(), host = await backend(temp.directory);
  try {
    await disableAllPatterns(host);
    const pattern = await createPattern(host, 'Mutable default', true);
    const member = await createPattern(host, 'Template default', false);
    const template = await host.call<string>('template-save', { name: 'Future default', patternIds: [member] });
    await host.call('session-patterns', { sessionId: 'clear-me' });
    await host.call('session-pattern-set', { sessionId: 'clear-me', patternId: pattern, selected: false });

    const selectionPath = join(temp.directory, 'session-selections.json');
    const beforeDefaultsChange = readFileSync(selectionPath, 'utf8');
    await host.call('pattern-enabled-set', { id: pattern, enabled: false });
    await host.call('template-default-set', { id: template, expectedRevision: 1, isDefault: true });
    assert.equal(readFileSync(selectionPath, 'utf8'), beforeDefaultsChange, 'changing defaults does not mutate initialized sessions');
    assert.deepEqual(selectedIds(await host.call('session-patterns', { sessionId: 'clear-me' })), [], 'cleared initialized sessions do not reapply defaults');
    assert.deepEqual(selectedIds(await host.call('session-patterns', { sessionId: 'new-session' })), [member], 'sessions without a stored entry use the current defaults');
    assert.deepEqual(selectedIds(await host.call('session-patterns', { sessionId: 'clear-me' })), [], 'subsequent reads preserve the explicit empty selection');

    const stored = JSON.parse(readFileSync(selectionPath, 'utf8'));
    assert.deepEqual(stored.sessions.find((entry: { sessionId: string }) => entry.sessionId === 'clear-me'), {
      sessionId: 'clear-me', patternIds: [],
    });
  } finally { await host.dispose(); temp.remove(); }
});

test('pre-existing empty session records remain initialized and disabled patterns remain eligible', async () => {
  const temp = temporary();
  let store = await Store.openPatterns(temp.directory);
  try {
    const pattern = store.patternsSnapshot().patterns[0]!;
    store.setPatternEnabled(pattern.id, false);
    writeFileSync(join(temp.directory, 'session-selections.json'), JSON.stringify({
      version: 1, sessions: [{ sessionId: 'legacy-empty', patternIds: [] }],
    }));
    store.close();
    store = await Store.openPatterns(temp.directory);

    assert.equal(store.sessionPatterns('legacy-empty').find(item => item.id === pattern.id)?.selected, false);
    assert.ok(store.sessionPatterns('legacy-empty').some(item => item.id === pattern.id), 'disabled patterns remain available to session tools');
    assert.deepEqual(JSON.parse(readFileSync(join(temp.directory, 'session-selections.json'), 'utf8')).sessions, [
      { sessionId: 'legacy-empty', patternIds: [] },
    ]);
    assert.equal(store.setSessionPattern('legacy-empty', pattern.id, true).find(item => item.id === pattern.id)?.selected, true);
  } finally { store.close(); temp.remove(); }
});
