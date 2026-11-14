import { createRoot } from 'react-dom/client';
import type { PluginFrontendContext } from 'learnharness-plugin-api';
import { Library } from './library';
import { registerSessionPatterns } from './session-patterns';
import { mountExampleSettings } from './example-settings';

export function activate(ctx: PluginFrontendContext) {
  ctx.registerView({
    id: 'library', name: 'Patterns Library',
    mount(container, signal) {
      const root = createRoot(container);
      const host = { ctx, signal };
      root.render(<Library host={host} />);
      return () => root.unmount();
    },
  });
  ctx.registerAction({ id: 'open-library', name: 'Patterns Library', run: () => ctx.app.openView('library') });
  ctx.placeAction({ id: 'library-sidebar', actionId: 'open-library', location: 'sidebar' });
  registerSessionPatterns(ctx);
  ctx.registerSettings((container, signal) => mountExampleSettings(ctx, container, signal));
}
