import type { TabPromptRule } from './types';

export function makeTabPromptRule(url: string, prompt: string): TabPromptRule {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('Prompt rules require an HTTP or HTTPS page URL');
  }
  const pathname = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`;
  return { urlPrefix: `${parsed.origin}${pathname}`, prompt };
}

export function tabPromptRulePrefixes(url: string): string[] {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('Prompt rules require an HTTP or HTTPS page URL');
  }

  const path = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`;
  const parts = path.split('/').filter(Boolean);
  const prefixes = parts.map((_, index) => `${parsed.origin}/${parts.slice(0, parts.length - index).join('/')}/`);
  prefixes.push(`${parsed.origin}/`);
  return [...new Set(prefixes)];
}

export function findTabPromptRule(url: string, rules: TabPromptRule[]): TabPromptRule | undefined {
  let page: URL;
  try {
    page = new URL(url);
  } catch {
    return undefined;
  }

  return rules
    .filter((rule) => {
      const prefix = new URL(rule.urlPrefix);
      if (prefix.origin !== page.origin) return false;
      const pathWithoutTrailingSlash = prefix.pathname.endsWith('/') ? prefix.pathname.slice(0, -1) : prefix.pathname;
      return page.pathname === pathWithoutTrailingSlash || page.pathname.startsWith(prefix.pathname);
    })
    .sort((a, b) => new URL(b.urlPrefix).pathname.length - new URL(a.urlPrefix).pathname.length)[0];
}

export function resolveTabPrompt(
  tabPrompt: string | undefined,
  defaultTabPrompt: string,
  url: string | undefined,
  rules: TabPromptRule[],
): string {
  if (tabPrompt?.trim()) return tabPrompt;
  const rule = url ? findTabPromptRule(url, rules) : undefined;
  return rule?.prompt.trim() ? rule.prompt : defaultTabPrompt;
}
