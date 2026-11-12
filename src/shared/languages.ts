/** Common languages, by English name (the name is what the LLM receives in the prompt). */
export const LANGUAGES: readonly string[] = [
  'English',
  'Italian',
  'Spanish',
  'French',
  'German',
  'Portuguese (Brazil)',
  'Portuguese (Portugal)',
  'Dutch',
  'Polish',
  'Romanian',
  'Czech',
  'Hungarian',
  'Greek',
  'Swedish',
  'Danish',
  'Norwegian',
  'Finnish',
  'Russian',
  'Ukrainian',
  'Turkish',
  'Arabic',
  'Hebrew',
  'Persian',
  'Hindi',
  'Bengali',
  'Indonesian',
  'Vietnamese',
  'Thai',
  'Chinese (Simplified)',
  'Chinese (Traditional)',
  'Japanese',
  'Korean',
];

export const AUTO_DETECT_LABEL = 'Auto-detect';

function option(value: string, label: string): HTMLOptionElement {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  return o;
}

export interface LanguageSelectOptions {
  current: string;
  /** Optional first entry with value "" (e.g. "(global: English)" or "Auto-detect"). */
  leadingLabel?: string;
}

/** Populate a language <select>; a value not in the list is kept as a "(custom)" entry. */
export function fillLanguageSelect(select: HTMLSelectElement, opts: LanguageSelectOptions): void {
  select.replaceChildren();
  if (opts.leadingLabel !== undefined) select.append(option('', opts.leadingLabel));
  for (const l of LANGUAGES) select.append(option(l, l));
  if (opts.current && !LANGUAGES.includes(opts.current)) select.append(option(opts.current, `${opts.current} (custom)`));
  select.value = opts.current;
  if (select.selectedIndex < 0) select.selectedIndex = 0;
}
