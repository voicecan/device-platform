import type { View } from './workspaces.js';

const bindingFlowSearchParams = ['binding_intent', 'binding_path', 'binding_path_locked'] as const;

export function urlForView(currentHref: string, view: View): URL {
  const url = new URL(currentHref);
  const currentView = url.searchParams.get('view') ?? 'overview';

  if (view === 'overview') url.searchParams.delete('view');
  else url.searchParams.set('view', view);

  if (view !== 'devices') url.searchParams.delete('device');

  // Binding intents belong to one visit of the provisioning workspace. Clear
  // them both when leaving that workspace and when starting a fresh visit.
  if (currentView !== 'provision' || view !== 'provision') {
    for (const parameter of bindingFlowSearchParams) url.searchParams.delete(parameter);
  }

  return url;
}
