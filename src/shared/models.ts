import { browser } from './browser';
import { NO_MODEL_LABEL, type GlobalSettings, type ModelListResult } from './types';

export async function fetchModels(backend?: Pick<GlobalSettings, 'provider' | 'baseUrl' | 'apiKey'>): Promise<ModelListResult> {
  try {
    return (await browser.runtime.sendMessage({ type: 'listModels', backend })) as ModelListResult;
  } catch (e) {
    return { models: [], error: String(e) };
  }
}

function option(value: string, label: string, disabled = false): HTMLOptionElement {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  o.disabled = disabled;
  return o;
}

export interface FillOptions {
  /** Value that should be selected (e.g. the saved model). Kept, marked "(not available)", if missing from the list. */
  current: string;
  /** Optional first entry with value "" (e.g. "use global default"). */
  leadingLabel?: string;
}

/**
 * Populate a model <select>. When the list is empty a "<no model>" entry (value "") is shown.
 */
export function fillModelSelect(select: HTMLSelectElement, models: string[], opts: FillOptions): void {
  select.replaceChildren();
  if (opts.leadingLabel !== undefined) select.append(option('', opts.leadingLabel));
  if (models.length === 0) {
    // With a leading "default" entry, "<no model>" is informational only.
    select.append(option('', NO_MODEL_LABEL, opts.leadingLabel !== undefined));
  }
  for (const m of models) select.append(option(m, m));
  if (opts.current && !models.includes(opts.current)) {
    select.append(option(opts.current, `${opts.current} (not available)`));
  }
  select.value = opts.current;
  if (select.selectedIndex < 0) select.selectedIndex = 0;
}
