import browser from 'webextension-polyfill';

declare const __BROWSER__: 'chrome' | 'firefox' | undefined;

/** True when running inside Firefox (build-time flag, with a runtime fallback). */
export function isFirefox(): boolean {
  if (typeof __BROWSER__ !== 'undefined') return __BROWSER__ === 'firefox';
  try {
    return browser.runtime.getURL('').startsWith('moz-extension:');
  } catch {
    return false;
  }
}

export { browser };
