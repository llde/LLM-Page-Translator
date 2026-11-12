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

export function analyzeMutationBatch<T>(
  records: readonly T[],
  isRelevant: (record: T) => boolean,
  includeRelevantRecords: boolean,
): { hasRelevantRecords: boolean; relevantRecords?: T[] } {
  if (!includeRelevantRecords) {
    return { hasRelevantRecords: records.some(isRelevant) };
  }
  const relevantRecords = records.filter(isRelevant);
  return { hasRelevantRecords: relevantRecords.length > 0, relevantRecords };
}

export function logTextDiagnostic(event: string, detail: unknown): void {
  console.info(`[LLM Page Translator] ${event}`, detail);
}
