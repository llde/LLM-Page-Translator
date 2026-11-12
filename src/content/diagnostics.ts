export function diagnosticTextPreview(text: string, maxLength = 100): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

export function diagnosticElementPath(el: Element): string {
  const parts: string[] = [];
  for (let current: Element | null = el; current && parts.length < 6; current = current.parentElement) {
    const id = current.id ? `#${current.id}` : '';
    parts.unshift(`${current.tagName.toLowerCase()}${id}`);
  }
  return parts.join(' > ');
}

export function logTextDiagnostic(event: string, detail: unknown): void {
  console.info(`[LLM Page Translator] ${event}`, detail);
}
