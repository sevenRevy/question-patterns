import type { PluginButtonProps, PluginFrontendContext, PluginSettingsSchema, PluginWidgetHandle } from 'learnharness-plugin-api';

import { DEFAULT_OVERALL_EXAMPLE_LIMIT, type ExampleSettings } from './domain';

const OVERALL_EXAMPLE_LIMIT_DESCRIPTION = 'Combined per tool response for patterns without a template override. Templates bypass this limit by default. Forced examples are always included even above this limit; 0 disables capped random examples only.';

function isExampleSettings(value: unknown): value is ExampleSettings {
  if (!value || typeof value !== 'object') return false;
  const limit = (value as { overallExampleLimit?: unknown }).overallExampleLimit;
  return typeof limit === 'number' && Number.isInteger(limit) && limit >= 0 && limit <= 1000;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function mountExampleSettings(ctx: PluginFrontendContext, container: HTMLElement, signal: AbortSignal) {
  if (signal.aborted) return () => {};

  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const error = document.createElement('p');
  error.setAttribute('role', 'alert');
  const fields = document.createElement('div');
  const retrySlot = document.createElement('div');
  container.replaceChildren(status, error, fields, retrySlot);

  let currentLimit = DEFAULT_OVERALL_EXAMPLE_LIMIT;
  let hasLoaded = false;
  let loading = false;
  let disposed = false;
  let loadError = '';
  let saveError = '';
  let pendingWrites = 0;
  let refreshPending = false;
  let refreshScheduled = false;
  let operationQueue: Promise<void> = Promise.resolve();
  let settingsHandle: PluginWidgetHandle<PluginSettingsSchema> | undefined;
  let retryHandle: PluginWidgetHandle<PluginButtonProps> | undefined;

  const active = () => !disposed && !signal.aborted;
  const enqueue = <T,>(operation: () => Promise<T>) => {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.then(() => undefined, () => undefined);
    return result;
  };

  function render() {
    if (!active()) return;
    status.textContent = loading ? (hasLoaded ? 'Refreshing example settings…' : 'Loading example settings…') : '';
    error.textContent = loadError
      ? `Could not load example settings: ${loadError}`
      : saveError;
    const rows: PluginSettingsSchema['rows'] = [{
      key: 'overallExampleLimit',
      type: 'number',
      label: 'Overall example limit',
      description: OVERALL_EXAMPLE_LIMIT_DESCRIPTION,
      value: currentLimit,
      min: 0,
      max: 1000,
      step: 1,
      disabled: loading || !hasLoaded,
      validate: value => Number.isInteger(value) && value >= 0 && value <= 1000
        ? undefined
        : 'Enter a whole number from 0 to 1000.',
      onChange: saveLimit,
    }];
    if (settingsHandle) settingsHandle.update({ rows });
    else settingsHandle = ctx.ui.mountSettingsRows(fields, { rows }, { signal });

    if (loadError) {
      const props: PluginButtonProps = {
        label: 'Retry loading',
        variant: 'ghost',
        disabled: loading,
        onClick: () => loadSettings(),
      };
      if (retryHandle) retryHandle.update(props);
      else retryHandle = ctx.ui.mountButton(retrySlot, props, { signal });
    } else if (retryHandle) {
      retryHandle.dispose();
      retryHandle = undefined;
      retrySlot.replaceChildren();
    }
  }

  function scheduleRefresh() {
    if (!active()) return;
    if (pendingWrites > 0 || loading) {
      refreshPending = true;
      return;
    }
    if (refreshScheduled) return;
    refreshScheduled = true;
    queueMicrotask(() => {
      refreshScheduled = false;
      if (!active()) return;
      if (pendingWrites > 0 || loading) {
        refreshPending = true;
        return;
      }
      refreshPending = false;
      void loadSettings();
    });
  }

  function loadSettings() {
    if (!active()) return Promise.resolve();
    loading = true;
    loadError = '';
    saveError = '';
    render();
    return enqueue(async () => {
      if (!active()) return;
      try {
        const result = await ctx.call<unknown>('example-settings', {});
        if (!active()) return;
        if (!isExampleSettings(result)) throw new Error('The settings response contains an invalid overall example limit.');
        currentLimit = result.overallExampleLimit;
        hasLoaded = true;
        loadError = '';
        saveError = '';
      } catch (cause) {
        if (!active()) return;
        loadError = errorMessage(cause);
      } finally {
        if (active()) {
          loading = false;
          render();
          if (refreshPending && pendingWrites === 0) scheduleRefresh();
        }
      }
    });
  }

  async function saveLimit(value: number) {
    if (!active()) return;
    if (!Number.isInteger(value) || value < 0 || value > 1000) {
      throw new Error('Enter a whole number from 0 to 1000.');
    }
    if (!hasLoaded) throw new Error('Example settings have not loaded yet.');

    pendingWrites++;
    saveError = '';
    error.textContent = loadError ? `Could not load example settings: ${loadError}` : '';
    return enqueue(async () => {
      let saved = false;
      try {
        if (!active()) return;
        const result = await ctx.call<unknown>('example-settings-save', { overallExampleLimit: value });
        if (!active()) return;
        if (!isExampleSettings(result)) throw new Error('The saved settings response contains an invalid overall example limit.');
        currentLimit = result.overallExampleLimit;
        hasLoaded = true;
        loadError = '';
        saveError = '';
        saved = true;
      } catch (cause) {
        if (!active()) return;
        saveError = `Could not save example settings: ${errorMessage(cause)}`;
        error.textContent = loadError ? `Could not load example settings: ${loadError}` : saveError;
        throw cause;
      } finally {
        pendingWrites--;
        if (active()) {
          if (saved) render();
          if (pendingWrites === 0 && refreshPending) scheduleRefresh();
        }
      }
    });
  }

  const unsubscribeNotification = ctx.onNotification(event => {
    if (event.topic === 'library-changed') scheduleRefresh();
  });
  const unsubscribeResync = ctx.onResync(scheduleRefresh);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener('abort', dispose);
    unsubscribeNotification();
    unsubscribeResync();
    settingsHandle?.dispose();
    retryHandle?.dispose();
    container.replaceChildren();
  };
  signal.addEventListener('abort', dispose, { once: true });

  render();
  void loadSettings();
  return dispose;
}
