import type { PluginFrontendContext, PluginSettingsSchema, PluginWidgetHandle } from 'learnharness-plugin-api';
import type { AnalysisStrength, ModelSlot, Settings, Snapshot } from './domain';

export async function mountSettings(ctx: PluginFrontendContext, container: HTMLElement, signal: AbortSignal) {
  const intro = document.createElement('p');
  intro.textContent = 'Question Patterns uses a LearnHarness model slot for analysis. Strong is recommended; no model fallback is used. Analysis strength changes detail, not the selected slot.';
  container.append(intro);
  const [{ settings }, catalog] = await Promise.all([
    ctx.call<Snapshot>('snapshot', {}),
    ctx.call<{ slots: Partial<Record<ModelSlot, { model: { provider: string; id: string }; thinkingLevel?: string }>> }>('model-catalog').catch(() => null),
  ]);
  if (signal.aborted) return;
  let saved = settings;
  const status = document.createElement('p');
  status.textContent = catalog
    ? `Strong: ${catalog.slots.strong ? `${catalog.slots.strong.model.provider}/${catalog.slots.strong.model.id}` : 'not configured'} · Cheap: ${catalog.slots.cheap ? `${catalog.slots.cheap.model.provider}/${catalog.slots.cheap.model.id}` : 'not configured'} · Vision: ${catalog.slots.vision ? `${catalog.slots.vision.model.provider}/${catalog.slots.vision.model.id}` : 'not configured'}. Configure models in LearnHarness Settings → Agent → Models.`
    : 'Model slot availability could not be checked. Configure models in LearnHarness Settings → Agent → Models.';
  container.append(status);
  let handle: PluginWidgetHandle<PluginSettingsSchema>;
  let pending: Promise<void> = Promise.resolve();
  const save = (patch: Partial<Settings>) => {
    const operation = pending.catch(() => {}).then(async () => {
      if (signal.aborted) return;
      const next = { ...saved, ...patch };
      await ctx.call('settings-save', next);
      if (signal.aborted) return;
      saved = next; handle.update(rows());
    });
    pending = operation;
    return operation;
  };
  const slotDescription = (slot: ModelSlot) => {
    const model = catalog?.slots[slot];
    return model ? `${model.model.provider}/${model.model.id}${model.thinkingLevel ? ` · ${model.thinkingLevel} thinking` : ''}` : 'Not configured; this choice will not fall back to another slot.';
  };
  const rows = (): PluginSettingsSchema => ({ rows: [
    { key: 'modelSlot', type: 'dropdown', label: 'Analysis model slot', description: slotDescription(saved.modelSlot), value: saved.modelSlot, options: [
      { value: 'strong', label: 'Strong — recommended' }, { value: 'cheap', label: 'Cheap' }, { value: 'vision', label: 'Vision' },
    ], onChange: value => save({ modelSlot: value as ModelSlot }) },
    { key: 'analysisStrength', type: 'dropdown', label: 'Analysis strength', description: 'Strong is thorough; Medium is balanced; Weak is a fast, minimal classification.', value: saved.analysisStrength, options: [
      { value: 'strong', label: 'Strong' }, { value: 'medium', label: 'Medium' }, { value: 'weak', label: 'Weak' },
    ], onChange: value => save({ analysisStrength: value as AnalysisStrength }) },
    { key: 'instructions', type: 'text', label: 'Default analysis instructions', description: 'Optional guidance copied into each new analysis.', value: saved.instructions, onChange: value => save({ instructions: value }), validate: value => value.length > 8000 ? 'Use at most 8,000 characters.' : undefined },
    { key: 'maxTurns', type: 'number', label: 'Maximum analysis turns', description: 'Includes structured-result correction turns. Existing runs retain their accepted worker settings.', value: saved.maxTurns, min: 1, max: 10, step: 1, onChange: value => save({ maxTurns: value }) },
  ] });
  const fields = document.createElement('div'); container.append(fields);
  handle = ctx.ui.mountSettingsRows(fields, rows(), { signal });
  return () => handle.dispose();
}
