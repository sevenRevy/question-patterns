import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { PluginFrontendContext, PluginSettingsSchema } from 'learnharness-plugin-api';
import { activate } from '../src/main';

type SettingsMount = (container: HTMLElement, signal: AbortSignal) => void | (() => void);
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function createHarness(options: {
  load?: () => unknown | Promise<unknown>;
  save?: (input: { overallExampleLimit: number }) => unknown | Promise<unknown>;
} = {}) {
  const dom = new JSDOM('<body></body>', { url: 'http://localhost/' });
  const previousGlobals = new Map<string, unknown>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement })) {
    previousGlobals.set(key, (globalThis as any)[key]);
    (globalThis as any)[key] = value;
  }

  const controller = new AbortController();
  const calls: Array<{ name: string; input: any }> = [];
  const notifications = new Set<(event: any) => void>();
  const resync = new Set<() => void>();
  const rowsSeen: PluginSettingsSchema[] = [];
  const buttonElements = new Map<string, HTMLButtonElement>();
  const counts = { settingsMounts: 0, settingsUpdates: 0, settingsDisposals: 0, buttonDisposals: 0 };
  let settingsMount: SettingsMount | undefined;
  let container: HTMLDivElement | undefined;

  const ui = {
    mountSettingsRows(node: HTMLElement, initial: PluginSettingsSchema, widgetOptions: { signal: AbortSignal }) {
      counts.settingsMounts++;
      let current = initial;
      let disposed = false;
      const render = () => {
        if (disposed) return;
        rowsSeen.push(current);
        node.replaceChildren(...current.rows.map((row: any) => {
          const label = document.createElement('label');
          const caption = document.createElement('span'); caption.textContent = row.label;
          const input = document.createElement('input');
          input.type = row.type === 'number' ? 'number' : 'text';
          input.setAttribute('aria-label', row.label);
          input.value = String(row.value);
          input.disabled = !!row.disabled;
          if (row.min !== undefined) input.min = String(row.min);
          if (row.max !== undefined) input.max = String(row.max);
          if (row.step !== undefined) input.step = String(row.step);
          const description = document.createElement('span'); description.textContent = row.description ?? '';
          label.append(caption, input, description);
          return label;
        }));
      };
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        counts.settingsDisposals++;
        node.replaceChildren();
        widgetOptions.signal.removeEventListener('abort', dispose);
      };
      widgetOptions.signal.addEventListener('abort', dispose, { once: true });
      render();
      return {
        update(next: PluginSettingsSchema) { if (!disposed) { counts.settingsUpdates++; current = { ...current, ...next }; render(); } },
        dispose,
      };
    },
    mountButton(node: HTMLElement, initial: any, widgetOptions: { signal: AbortSignal }) {
      let current = initial;
      let disposed = false;
      const button = document.createElement('button');
      button.type = 'button';
      const render = () => {
        button.textContent = current.label;
        button.disabled = !!current.disabled;
        button.onclick = () => { void current.onClick(); };
      };
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        counts.buttonDisposals++;
        button.remove();
        widgetOptions.signal.removeEventListener('abort', dispose);
      };
      widgetOptions.signal.addEventListener('abort', dispose, { once: true });
      render();
      node.append(button);
      buttonElements.set(initial.label, button);
      return { update(next: any) { if (!disposed) { current = { ...current, ...next }; render(); } }, dispose };
    },
  };
  const ctx = {
    signal: controller.signal,
    ui,
    registerView: () => () => {},
    registerAction: () => () => {},
    placeAction: () => () => {},
    registerSettings(mount: SettingsMount) { settingsMount = mount; return () => { settingsMount = undefined; }; },
    registerSubmissionInterceptor: () => () => {},
    cleanup: () => {},
    call: async (name: string, input: any = {}) => {
      calls.push({ name, input: structuredClone(input) });
      if (name === 'example-settings') return options.load ? await options.load() : { overallExampleLimit: 15 };
      if (name === 'example-settings-save') return options.save ? await options.save(input) : input;
      throw new Error(`Unexpected operation: ${name}`);
    },
    onNotification(listener: (event: any) => void) { notifications.add(listener); return () => notifications.delete(listener); },
    onResync(listener: () => void) { resync.add(listener); return () => resync.delete(listener); },
    app: { openView() {} },
  } as unknown as PluginFrontendContext;

  const start = () => {
    assert.ok(settingsMount, 'settings mount was registered');
    container = document.createElement('div');
    document.body.append(container);
    const cleanup = settingsMount(container, controller.signal);
    return cleanup;
  };
  const latestRows = () => rowsSeen.at(-1)?.rows ?? [];
  const currentRow = () => latestRows().find((row: any) => row.key === 'overallExampleLimit') as any;
  const waitFor = async (check: () => boolean) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (check()) return;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.fail('Timed out waiting for settings UI state');
  };

  return {
    ctx, controller, calls, notifications, resync, counts, rowsSeen, buttonElements,
    get container() { return container!; }, start, latestRows, currentRow, waitFor,
    notify(topic = 'library-changed') { for (const listener of [...notifications]) listener({ topic }); },
    resyncNow() { for (const listener of [...resync]) listener(); },
    restore() {
      controller.abort();
      dom.window.close();
      for (const [key, value] of previousGlobals) {
        if (value === undefined) delete (globalThis as any)[key];
        else (globalThis as any)[key] = value;
      }
    },
  };
}

test('settings are loaded only when the native settings panel mounts and expose the default row', async () => {
  const harness = createHarness();
  try {
    activate(harness.ctx);
    assert.equal(harness.calls.length, 0, 'activation does not load settings before the settings panel is visible');
    const cleanup = harness.start();
    await harness.waitFor(() => !harness.currentRow()?.disabled);

    assert.deepEqual(harness.calls, [{ name: 'example-settings', input: {} }]);
    const row = harness.currentRow();
    assert.equal(row.key, 'overallExampleLimit');
    assert.equal(row.type, 'number');
    assert.equal(row.label, 'Overall example limit');
    assert.equal(row.value, 15);
    assert.equal(row.min, 0);
    assert.equal(row.max, 1000);
    assert.equal(row.step, 1);
    assert.match(row.description, /per tool response/);
    assert.match(row.description, /Templates bypass this limit by default/);
    assert.match(row.description, /Forced examples are always included even above this limit/);
    assert.match(row.description, /0 disables capped random examples only/);
    assert.equal(harness.container.querySelector('[role="status"]')?.textContent, '');
    cleanup?.();
  } finally {
    harness.restore();
  }
});

test('load failures show retry and a retry publishes the loaded value', async () => {
  let reads = 0;
  const harness = createHarness({ load: () => {
    reads++;
    if (reads === 1) throw new Error('temporary read failure');
    return { overallExampleLimit: 27 };
  } });
  try {
    activate(harness.ctx);
    const cleanup = harness.start();
    await harness.waitFor(() => !!harness.container.querySelector('button'));
    assert.match(harness.container.querySelector('[role="alert"]')?.textContent ?? '', /temporary read failure/);
    assert.equal(harness.buttonElements.get('Retry loading')?.textContent, 'Retry loading');
    assert.equal(harness.currentRow().value, 15);
    assert.equal(harness.currentRow().disabled, true);

    harness.buttonElements.get('Retry loading')!.click();
    await harness.waitFor(() => harness.currentRow().value === 27 && !harness.currentRow().disabled);
    assert.equal(harness.container.querySelector('[role="alert"]')?.textContent, '');
    assert.equal(harness.container.querySelector('button'), null);
    assert.deepEqual(harness.calls.map(call => call.name), ['example-settings', 'example-settings']);
    cleanup?.();
  } finally {
    harness.restore();
  }
});

test('save failures reject for native rollback and retain the last accepted value', async () => {
  const harness = createHarness({ save: async () => { throw new Error('write failed'); } });
  try {
    activate(harness.ctx);
    const cleanup = harness.start();
    await harness.waitFor(() => !harness.currentRow()?.disabled);
    const failed = harness.currentRow().onChange(42);
    await assert.rejects(failed, /write failed/);

    assert.deepEqual(harness.calls.map(call => call.name), ['example-settings', 'example-settings-save']);
    assert.deepEqual(harness.calls[1].input, { overallExampleLimit: 42 });
    assert.equal(harness.currentRow().value, 15, 'the controlled value remains at the last successful setting');
    assert.match(harness.container.querySelector('[role="alert"]')?.textContent ?? '', /Could not save example settings: write failed/);
    cleanup?.();
  } finally {
    harness.restore();
  }
});

test('saves are serialized and library refresh waits until pending saves finish', async () => {
  let storedLimit = 15;
  let saveCount = 0;
  const firstSave = deferred<unknown>();
  const harness = createHarness({
    load: () => ({ overallExampleLimit: storedLimit }),
    save: input => {
      saveCount++;
      if (saveCount === 1) return firstSave.promise.then(result => {
        storedLimit = (result as { overallExampleLimit: number }).overallExampleLimit;
        return result;
      });
      storedLimit = input.overallExampleLimit;
      return { overallExampleLimit: storedLimit };
    },
  });
  try {
    activate(harness.ctx);
    const cleanup = harness.start();
    await harness.waitFor(() => !harness.currentRow()?.disabled);
    const change = harness.currentRow().onChange;
    const first = change(20);
    const second = change(30);
    await harness.waitFor(() => harness.calls.length === 2);
    harness.notify();
    harness.resyncNow();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(harness.calls.length, 2, 'refreshes do not start while saves are pending');

    firstSave.resolve({ overallExampleLimit: 20 });
    await Promise.all([first, second]);
    await harness.waitFor(() => harness.calls.length >= 4 && harness.currentRow().value === 30);
    assert.deepEqual(harness.calls.map(call => call.name), [
      'example-settings', 'example-settings-save', 'example-settings-save', 'example-settings',
    ]);
    assert.deepEqual(harness.calls.slice(1, 3).map(call => call.input.overallExampleLimit), [20, 30]);
    assert.equal(harness.currentRow().value, 30, 'the post-save refresh sees the latest persisted value');
    cleanup?.();
  } finally {
    harness.restore();
  }
});

test('disposal unsubscribes and prevents follow-up calls or UI updates after an in-flight load', async () => {
  const load = deferred<unknown>();
  const harness = createHarness({ load: () => load.promise });
  try {
    activate(harness.ctx);
    const cleanup = harness.start();
    await harness.waitFor(() => harness.calls.length === 1);
    const row = harness.currentRow();
    harness.controller.abort();
    cleanup?.();
    const updatesAtDispose = harness.counts.settingsUpdates;
    load.resolve({ overallExampleLimit: 90 });
    await new Promise(resolve => setTimeout(resolve, 0));
    await row.onChange(50);
    harness.notify();
    harness.resyncNow();

    assert.equal(harness.calls.length, 1);
    assert.equal(harness.counts.settingsUpdates, updatesAtDispose);
    assert.equal(harness.counts.settingsDisposals, 1);
    assert.equal(harness.notifications.size, 0);
    assert.equal(harness.resync.size, 0);
    assert.equal(harness.container.childElementCount, 0);
  } finally {
    harness.restore();
  }
});
