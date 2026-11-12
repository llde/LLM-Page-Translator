import type { ChatMessage, SegmentPayload } from '../shared/types';

export const FORMAT_INSTRUCTIONS = `
## Output format (mandatory)
- The input is one continuous phrase containing inline numeric markers like [1], [2], ... that mark the original text spans.
- Read and translate all text between the markers together as one coherent phrase; the markers are span boundaries, not sentence boundaries.
- In the translation, add appropriate spaces after punctuation when required by the target language, even if the source has missing or incorrect spacing; follow target-language conventions where spaces are not used.
- Keep every marker exactly once and in the same order, immediately before the translated text corresponding to that span. Markers may appear inline.
- Do not drop or add markers. If text must not be translated (e.g. code, names), copy it unchanged.
- Enclose the whole output between <translated_text> and </translated_text>.
- Output nothing outside the <translated_text> block: no explanations, notes or comments.

Example:
<translated_text>
[1] first translated part [2] second translated part
</translated_text>`.trim();

export interface PromptParams {
  systemPrompt: string;
  tabPrompt: string;
  targetLanguage: string;
  /** Empty/undefined = let the model detect it. */
  sourceLanguage?: string;
}

export class ParseError extends Error {
  constructor(message: string, public details: string) {
    super(message);
    this.name = 'ParseError';
  }
}

const normalize = (t: string) => t.replace(/\s+/g, ' ').trim();

export function buildMessages(p: PromptParams, segs: SegmentPayload[]): ChatMessage[] {
  const system = [p.systemPrompt.trim(), FORMAT_INSTRUCTIONS].filter(Boolean).join('\n\n');
  const parts: string[] = [];
  if (p.tabPrompt.trim()) parts.push(`Context / instructions for this page:\n${p.tabPrompt.trim()}`);
  const src = p.sourceLanguage?.trim();
  if (src) {
    parts.push(
      `Source language: ${src}. Treat all segments as ${src} text, even where a word could belong to another language.`,
    );
  }
  if (p.targetLanguage.trim()) parts.push(`Target language: ${p.targetLanguage.trim()}`);
  parts.push('Translate this phrase, preserving the inline span markers:\n' + segs.map((s) => `[${s.id}] ${normalize(s.text)}`).join(' '));
  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

function extractBlock(raw: string): { block: string; truncated: boolean } | null {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const blocks = [...text.matchAll(/<translated_text>([\s\S]*?)<\/translated_text>/gi)];
  if (blocks.length) return { block: blocks[blocks.length - 1][1], truncated: false };
  const open = text.toLowerCase().lastIndexOf('<translated_text>');
  if (open >= 0) return { block: text.slice(open + '<translated_text>'.length), truncated: true };
  return null;
}

/** Parse the model output into a map id -> translated text. Throws ParseError on format problems. */
export function parseResponse(raw: string, ids: number[]): Record<number, string> {
  const found = extractBlock(raw);
  if (!found) {
    throw new ParseError('Response does not contain a <translated_text> block', raw);
  }
  const { block, truncated } = found;
  const order = new Map(ids.map((id, i) => [id, i]));
  const accepted: { id: number; start: number; end: number }[] = [];
  let lastIdx = -1;
  for (const m of block.matchAll(/\[(\d+)\]/g)) {
    const id = Number(m[1]);
    const idx = order.get(id);
    if (idx === undefined || idx <= lastIdx) continue;
    accepted.push({ id, start: m.index!, end: m.index! + m[0].length });
    lastIdx = idx;
  }

  const result: Record<number, string> = {};
  if (accepted.length === 0 && ids.length === 1 && block.trim()) {
    result[ids[0]] = block.trim();
    return result;
  }
  accepted.forEach((a, i) => {
    const stop = i + 1 < accepted.length ? accepted[i + 1].start : block.length;
    result[a.id] = block.slice(a.end, stop).trim();
  });

  const missing = ids.filter((id) => !(id in result));
  if (missing.length) {
    const why = truncated ? ' (response appears truncated: missing </translated_text>; consider raising max tokens)' : '';
    throw new ParseError(`Translation is missing segment(s) ${missing.join(', ')}${why}`, raw);
  }
  return result;
}
