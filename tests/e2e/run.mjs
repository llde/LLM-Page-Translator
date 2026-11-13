// End-to-end smoke test: loads dist/chrome in Chromium, serves a test page and a mock Ollama backend.
// Usage: npm run build:chrome && npm run e2e   (set CHROMIUM_PATH to use a specific Chromium binary)
import http from 'node:http';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const PORT = 8765;
const FRAME_PORT = 8766;
let failMode = true;
const requests = [];
let activeProviderRequests = 0;
let maxActiveProviderRequests = 0;

const PAGE = `<!doctype html><html><head><title>t</title></head><body>
<h1>Welcome to the test page</h1>
<div id="levels">
  <p>Same level first paragraph.</p>
  <p><span>Brief</span></p>
  <p>Same level second paragraph.</p>
  <p><span>Nested level phrase stays separate.</span></p>
</div>
<div id="nested-inline">
  <span><span>First nested span phrase.</span></span>
  <span><span>Second nested span phrase.</span></span>
  <a href="/target"><span>Nested anchor span phrase.</span></a>
</div>
<p id="p1">The first sentence is here. The second one follows! <a id="lnk" href="https://example.com/x">Read the docs</a> for more.</p>
<p id="long">This is a deliberately long phrase, with several commas, semicolons; and colons: it exists only to exceed the configured chunk size of the extension so that the oversized handling kicks in</p>
<p id="fail">Please FAILME now.</p>
<div style="display:none" id="hidden">Hidden text must not be translated.</div>
<pre id="code">const code = "not translated";</pre>
<form id="input-form">
  <input id="input-eligible" type="text" value="Attribute input text.">
  <input id="input-submit" type="submit" value="Submit form now.">
  <input id="input-named" type="text" name="caption" value="Named input text.">
  <input id="input-disabled" type="text" value="Disabled input text." disabled>
  <input id="input-no-value" type="text">
  <input id="input-password" type="password" value="Password input text.">
  <input id="input-checkbox" type="checkbox" value="Checkbox input text.">
</form>
<input id="input-outside-form" type="text" value="Outside form input text.">
<script>document.querySelector('#input-eligible').value = 'Welcome input text.'; setTimeout(() => { const d = document.createElement('p'); d.id = 'dyn'; d.textContent = 'Dynamic text appears later.'; document.body.appendChild(d); }, 1500);</script>
</body></html>`;

const FRAME_PAGE = `<!doctype html><html><body>
<p id="top-frame-text">Top-document boundary phrase.</p>
<iframe id="cross-origin-frame" src="http://127.0.0.1:${FRAME_PORT}/frame"></iframe>
<iframe id="blank-frame" srcdoc="<p id='blank-frame-text'>Blank child boundary phrase.</p>"></iframe>
<iframe id="unmatched-frame" src="data:text/html,%3Cp%3EUnmatched%20frame%20text.%3C/p%3E"></iframe>
</body></html>`;

const frameServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><html><body>
<p id="cross-origin-text">Cross-origin boundary phrase.</p>
<p id="cross-origin-number">Frame count 6 items.</p>
<iframe id="nested-frame" srcdoc="<p id='nested-frame-text'>Nested child boundary phrase.</p>"></iframe>
</body></html>`);
});
await new Promise((r) => frameServer.listen(FRAME_PORT, '127.0.0.1', r));

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/tags') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ models: [{ name: 'other' }, { name: 'mock' }] }));
  }
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(req.url === '/iframe-test' ? FRAME_PAGE
      : req.url === '/numbers-test' || req.url === '/mutation-target-test' || req.url.startsWith('/html-number-test') ? '<!doctype html><html><body></body></html>'
        : PAGE);
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = JSON.parse(body);
    requests.push(json);
    activeProviderRequests++;
    maxActiveProviderRequests = Math.max(maxActiveProviderRequests, activeProviderRequests);
    const user = json.messages.find((m) => m.role === 'user').content;
    const phrase = user.split('Translate this phrase, preserving the inline span markers:\n')[1] ?? '';
    const markers = [...phrase.matchAll(/\[(\d+)\]\s*/g)];
    const segs = markers.map((marker, index) => {
      const start = marker.index + marker[0].length;
      const end = markers[index + 1]?.index ?? phrase.length;
      return [marker[1], phrase.slice(start, end).trim()];
    });
    setTimeout(() => {
      activeProviderRequests--;
      if (failMode && user.includes('FAILME')) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'mock model exploded' }));
      }
      const out = segs.map(([id, t]) => `[${id}] IT:${t === 'Ambiguous 6 units.' ? 'Ambiguous units.' : t}`).join('\n');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: { role: 'assistant', content: `<think>hmm</think><translated_text>\n${out}\n</translated_text>` }, done_reason: 'stop' }));
    }, user.includes('PREFLIGHT-MISS') ? 2000 : 700);
  });
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const ext = resolve('dist/chrome');
const ctx = await chromium.launchPersistentContext('', {
  executablePath: process.env.CHROMIUM_PATH || undefined,
  channel: process.env.CHROMIUM_PATH ? undefined : 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};

try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const backgroundDiagnostics = [];
  sw.on('console', (message) => backgroundDiagnostics.push(message.text()));
  await sw.evaluate(async (base) => {
    await chrome.storage.local.set({ settings: {
      baseUrl: base,
      model: 'mock',
      maxChunkSize: 120,
      concurrency: 2,
      targetLanguage: 'Italian',
      tabPromptRules: [{ urlPrefix: `${base}/story/`, prompt: 'E2E saved URL prompt' }],
    } });
  }, `http://127.0.0.1:${PORT}`);

  const page = await ctx.newPage();
  const errors = [];
  const diagnostics = [];
  const observerSummaries = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (message) => diagnostics.push(message.text()));
  page.on('console', async (message) => {
    if (message.text().includes('[LLM Page Translator] mutation observer')) {
      observerSummaries.push(await message.args()[1].jsonValue());
    }
  });
  await page.goto(`http://127.0.0.1:${PORT}/story/51/`);
  await page.waitForTimeout(500);

  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
    await chrome.storage.session.set({ [`tab:${tab.id}`]: { textDiagnostics: true } });
    await chrome.storage.local.set({
      'llm-page-translator:memory:v1:page:expired-e2e': Date.now() - 31 * 24 * 60 * 60 * 1000,
      'llm-page-translator:memory:v1:entry:expired-e2e:frame': ['stale'],
    });
  });
  await page.reload();
  await page.waitForTimeout(500);
  const tabMsg = (msg) =>
    sw.evaluate(async (m) => {
      const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
      return chrome.tabs.sendMessage(tab.id, m);
    }, msg);

  await tabMsg({ type: 'start' });
  await page.waitForTimeout(100);
  check(diagnostics.some((line) => line.includes('[LLM Page Translator] scan')), 'enabled diagnostics log text scanning');
  check(diagnostics.some((line) => line.includes('[LLM Page Translator] chunks')), 'enabled diagnostics log chunk aggregation');
  await page.waitForTimeout(250);
  check((await page.locator('.xt-seg.xt-busy').count()) > 0, 'segments show busy state while processing');
  check((await page.locator('.xt-seg.xt-spin').count()) > 0, 'spinner shown on processing chunk');

  await page.waitForTimeout(4000);
  check(diagnostics.some((line) => line.includes('[LLM Page Translator] chunk dispatched')), 'enabled diagnostics log chunk dispatch');
  check(diagnostics.some((line) => line.includes('[LLM Page Translator] chunk result received')), 'enabled diagnostics log result receipt');
  check(diagnostics.some((line) => line.includes('[LLM Page Translator] segment updated')), 'enabled diagnostics log DOM text replacement');
  const observerLogStart = diagnostics.length;
  const observerSummaryStart = observerSummaries.length;
  const observerProbe = await page.evaluateHandle(() => {
    const node = document.createElement('div');
    node.id = 'observer-probe';
    node.append(document.createTextNode('Original observer text'));
    document.body.append(node);
    return node;
  });
  await page.waitForTimeout(100);
  await observerProbe.evaluate((node) => {
    node.firstChild.data = 'Changed observer text';
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    const node = document.createElement('div');
    node.id = 'observer-probe-second';
    document.body.append(node);
  });
  await page.waitForTimeout(100);
  await observerProbe.evaluate((node) => node.remove());
  await page.waitForTimeout(700);
  const observerLogs = diagnostics
    .slice(observerLogStart)
    .filter((line) => line.includes('[LLM Page Translator] mutation observer'));
  const observerDetails = observerSummaries.slice(observerSummaryStart);
  check(observerDetails.some((summary) => summary.childListRecords > 0), 'observer diagnostics count child-list records');
  check(observerDetails.some((summary) => summary.debounceAction === 'scheduled'), 'observer diagnostics report a newly scheduled scan');
  check(observerDetails.some((summary) => summary.debounceAction === 'restarted'), 'observer diagnostics report a restarted scan debounce');
  check(
    observerDetails.some((summary) =>
      summary.relevantRecordCount === 0 &&
      summary.ignoredRecordCount > 0 &&
      summary.debounceAction === 'unchanged',
    ),
    'observer diagnostics report ignored-only callbacks without changing the debounce',
  );
  const mutations = observerDetails.flatMap((summary) => summary.mutations ?? []);
  check(
    observerLogs.length > 0 && mutations.some((mutation) =>
      mutation.type === 'childList' &&
      mutation.addedNodes.some((node) => node.path.includes('div#observer-probe'))),
    'observer diagnostics identify added nodes',
  );
  check(
    mutations.some((mutation) =>
      mutation.type === 'characterData' &&
      mutation.target.path.includes('div#observer-probe') &&
      mutation.target.preview === 'Changed observer text'),
    'observer diagnostics identify changed text nodes',
  );
  check(
    mutations.some((mutation) =>
      mutation.type === 'childList' &&
      mutation.removedNodes.some((node) => node.path.includes('div#observer-probe'))),
    'observer diagnostics identify removed nodes, including ignored-only removals',
  );
  check(backgroundDiagnostics.some((line) => line.includes('[LLM Page Translator] backend request received')), 'enabled diagnostics log backend request receipt');
  check(backgroundDiagnostics.some((line) => line.includes('[LLM Page Translator] backend translation completed')), 'enabled diagnostics log backend translation completion');
  check(backgroundDiagnostics.some((line) => line.includes('[LLM Page Translator] backend translation failed')), 'enabled diagnostics log backend translation failures');
  check(requests.some((r) => r.messages[1].content.includes('E2E saved URL prompt')), 'URL-prefix prompt is included for a descendant page');
  check(
    requests.some((r) => {
      const user = r.messages[1].content;
      return user.includes('Same level first paragraph.') && user.includes('Brief') && user.includes('Same level second paragraph.');
    }),
    'same-depth paragraphs batch together, including a one-word segment at another depth',
  );
  check(
    requests.some((r) => r.messages[1].content.includes('Nested level phrase stays separate.')) &&
      !requests.find((r) => r.messages[1].content.includes('Same level first paragraph.'))?.messages[1].content.includes('Nested level phrase stays separate.'),
    'multiword text from another DOM depth is sent separately',
  );
  const nestedInlineText = ['First nested span phrase.', 'Second nested span phrase.', 'Nested anchor span phrase.'];
  const sentNestedInlineText = requests.flatMap((r) => [...r.messages[1].content.matchAll(/^\[\d+\] (.*)$/gm)].map((m) => m[1]));
  check(nestedInlineText.every((text) => sentNestedInlineText.some((segment) => segment.includes(text))), 'nested span and anchor text all reach the backend');
  check(
    (await page.locator('#nested-inline').innerText()).includes('IT:First nested span phrase.') &&
      (await page.locator('#nested-inline').innerText()).includes('IT:Second nested span phrase.') &&
      (await page.locator('#nested-inline').innerText()).includes('IT:Nested anchor span phrase.') &&
      (await page.locator('#nested-inline .xt-seg.xt-busy').count()) === 0,
    `nested span and anchor text finish processing: ${await page.locator('#nested-inline').innerText()}`,
  );
  const p1 = await page.locator('#p1').innerText();
  check(p1.includes('IT:The first sentence is here.') && p1.includes('IT:Read the docs'), `paragraph translated: "${p1}"`);
  check(
    requests.some((r) => {
      const phrase = r.messages[1].content.split('Translate this phrase, preserving the inline span markers:\n')[1] ?? '';
      return phrase.includes('The first sentence is here.') && /\s+\[\d+\] The second one follows!/.test(phrase);
    }),
    'members of a chunk are sent together as one phrase with inline span references',
  );
  check((await page.locator('#lnk').getAttribute('href')) === 'https://example.com/x', 'link preserved');
  check(!(await page.locator('#hidden').textContent()).includes('IT:'), 'hidden text untouched');
  check(!(await page.locator('#code').textContent()).includes('IT:'), '<pre> untouched');
  check((await page.locator('#dyn').innerText()).includes('IT:Dynamic text'), 'dynamic content translated');
  check((await page.locator('#input-eligible').inputValue()) === 'IT:Welcome input text.', 'eligible form input value is translated');
  check((await page.locator('#input-submit').inputValue()) === 'IT:Submit form now.', 'unnamed submit input value is translated');
  check(
    requests.some((r) => r.messages[1].content.includes('Welcome input text.')) &&
      !requests.some((r) => r.messages[1].content.includes('Attribute input text.')) &&
      requests.some((r) => r.messages[1].content.includes('Submit form now.')) &&
      !requests.some((r) => r.messages[1].content.includes('Welcome input text.') && r.messages[1].content.includes('Please FAILME now.')) &&
      !requests.some((r) => ['Named input text.', 'Disabled input text.', 'Password input text.', 'Checkbox input text.', 'Outside form input text.']
        .some((text) => r.messages[1].content.includes(text))),
    'eligible input is translated separately; ineligible form inputs are not sent',
  );
  check(
    (await Promise.all(['#input-named', '#input-disabled', '#input-no-value', '#input-password', '#input-checkbox', '#input-outside-form']
      .map((selector) => page.locator(selector).inputValue()))).every((value) => !value.startsWith('IT:')),
    'ineligible input values remain unchanged',
  );

  const errBadge = page.locator('#fail .xt-badge-host');
  check((await errBadge.count()) === 1, 'error badge shown on failed chunk');
  check((await errBadge.locator('.msg').innerText()).includes('HTTP 500'), 'error badge reports HTTP error');
  await errBadge.getByRole('button', { name: 'Details' }).click();
  check((await errBadge.locator('pre').innerText()).includes('mock model exploded'), 'details show response body');
  const failedChunkId = backgroundDiagnostics
    .find((line) => line.includes('[LLM Page Translator] backend translation failed'))
    ?.match(/chunkId:\s*(\d+)/)?.[1];
  check(
    !!failedChunkId && !backgroundDiagnostics.some((line) =>
      line.includes('[LLM Page Translator] translation memory stored') &&
      line.match(/chunkId:\s*(\d+)/)?.[1] === failedChunkId),
    'provider failures do not produce memory-store diagnostics',
  );
  const failedChunkRequests = requests.filter((r) => r.messages[1].content.includes('FAILME')).length;

  const longBadge = page.locator('#long .xt-badge-host');
  check((await longBadge.count()) === 1, 'oversized badge shown');
  check((await page.locator('#long .xt-seg.xt-oversized').count()) === 1, 'oversized phrase highlighted');

  const sizes = requests.map((r) => {
    const phrase = r.messages[1].content.split('Translate this phrase, preserving the inline span markers:\n')[1] ?? '';
    const markers = [...phrase.matchAll(/\[(\d+)\]\s*/g)];
    return markers.reduce((total, marker, index) => {
      const start = marker.index + marker[0].length;
      const end = markers[index + 1]?.index ?? phrase.length;
      return total + phrase.slice(start, end).trim().length;
    }, 0);
  });
  check(sizes.every((s) => s <= 120), `all sent chunks <= 120 chars (${sizes.join(', ')})`);

  await longBadge.getByRole('button', { name: 'Split' }).click();
  await page.waitForTimeout(2500);
  const longText = await page.locator('#long').innerText();
  check((await page.locator('#long .xt-badge-host').count()) === 0 && longText.startsWith('IT:'), `split phrase translated: "${longText.slice(0, 80)}…"`);
  check((await page.locator('#long .xt-seg').count()) > 1, 'oversized phrase split into several segments');

  failMode = false;
  await errBadge.getByRole('button', { name: 'Retry' }).click();
  await page.waitForTimeout(1500);
  check((await page.locator('#fail').innerText()).includes('IT:Please FAILME now.'), 'retry succeeds');
  const memoryDiagnostics = () => backgroundDiagnostics.filter((line) => line.includes('[LLM Page Translator] translation memory'));
  check(memoryDiagnostics().some((line) => line.includes('translation memory miss')), 'enabled diagnostics log memory misses');
  check(memoryDiagnostics().some((line) => line.includes('translation memory stored')), 'enabled diagnostics log successful memory stores');
  check(memoryDiagnostics().some((line) => line.includes('translation memory expired')), 'enabled diagnostics log expired memory cleanup');
  check(
    memoryDiagnostics().every((line) =>
      !line.includes('http') &&
      !line.includes('The first sentence is here.') &&
      !line.includes('IT:The first sentence is here.'),
    ),
    'memory diagnostics do not expose page URLs, source text, or translations',
  );
  check(
    requests.filter((r) => r.messages[1].content.includes('FAILME')).length === failedChunkRequests + 1,
    'failed chunks are retried at the provider instead of being served from memory',
  );

  const st = await tabMsg({ type: 'status' });
  check(st.errors === 0 && st.oversized === 0 && st.busy === 0 && st.done === st.total, `status ${JSON.stringify(st)}`);

  await tabMsg({ type: 'restore' });
  check((await page.locator('#p1').innerText()).startsWith('The first sentence is here.'), 'restore brings back original text');
  check((await page.locator('#input-eligible').inputValue()) === 'Welcome input text.', 'restore brings back the original input value');
  check((await page.locator('#input-submit').inputValue()) === 'Submit form now.', 'restore brings back the original submit value');
  check((await page.locator('.xt-node, .xt-badge-host').count()) === 0, 'restore removes all wrappers and badges');

  const cachedRequestCount = requests.length;
  await tabMsg({ type: 'start' });
  await page.waitForTimeout(1000);
  check(requests.length === cachedRequestCount, 'retranslating the same page reuses successful chunk memory');
  check(memoryDiagnostics().some((line) => line.includes('translation memory hit')), 'enabled diagnostics log memory hits');
  await tabMsg({ type: 'restore' });

  const preflightRequestStart = requests.length;
  await sw.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, concurrency: 1 } });
  });
  await page.evaluate(() => {
    document.querySelector('h1').textContent = 'PREFLIGHT-MISS first uncached phrase.';
    const container = document.createElement('div');
    container.innerHTML = '<div><p id="preflight-later">PREFLIGHT-MISS later uncached phrase.</p></div>';
    document.body.append(container);
  });
  maxActiveProviderRequests = 0;
  await tabMsg({ type: 'start' });
  await page.waitForTimeout(300);
  check(
    (await page.locator('#p1').innerText()).includes('IT:The first sentence is here.'),
    'cached text applies while the first uncached LLM request occupies the only slot',
  );
  check(
    requests.filter((request) => request.messages[1].content.includes('PREFLIGHT-MISS')).length === 1,
    'only one uncached provider request starts with concurrency set to one',
  );
  await page.waitForFunction(
    () =>
      document.querySelector('h1')?.innerText.includes('IT:PREFLIGHT-MISS first uncached phrase.') &&
      document.querySelector('#preflight-later')?.innerText.includes('IT:PREFLIGHT-MISS later uncached phrase.'),
    null,
    { timeout: 7000 },
  );
  check(
    (await page.locator('h1').innerText()).includes('IT:PREFLIGHT-MISS first uncached phrase.') &&
      (await page.locator('#preflight-later').innerText()).includes('IT:PREFLIGHT-MISS later uncached phrase.'),
    'both uncached chunks translate after obtaining provider slots',
  );
  check(
    requests.length - preflightRequestStart === 2 && maxActiveProviderRequests === 1,
    `provider requests respect concurrency one (${requests.length - preflightRequestStart} requests, max ${maxActiveProviderRequests} active)`,
  );
  await tabMsg({ type: 'restore' });
  await sw.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, concurrency: 2 } });
  });

  // Oversized "send as one chunk" path
  await tabMsg({ type: 'start' });
  await page.waitForTimeout(2500);
  await page.locator('#long .xt-badge-host').getByRole('button', { name: /Send as one chunk/ }).click();
  await page.waitForTimeout(1500);
  check((await page.locator('#long').innerText()).startsWith('IT:This is a deliberately long phrase'), 'send-as-one-chunk translates whole phrase');

  await sw.evaluate(async () => {
    await chrome.storage.local.set({
      'llm-page-translator:memory:v1:page:expired-disabled-e2e': Date.now() - 31 * 24 * 60 * 60 * 1000,
      'llm-page-translator:memory:v1:entry:expired-disabled-e2e:frame': ['stale'],
    });
  });
  const frameDiagnosticStart = backgroundDiagnostics.length;
  const framePage = await ctx.newPage();
  const frameDiagnostics = [];
  framePage.on('console', (message) => frameDiagnostics.push(message.text()));
  await framePage.goto(`http://127.0.0.1:${PORT}/iframe-test`);
  const frameTabMessage = (msg) =>
    sw.evaluate(async ({ message, url }) => {
      const [tab] = await chrome.tabs.query({ url });
      const emptyStatus = { active: false, total: 0, done: 0, busy: 0, queued: 0, errors: 0, oversized: 0 };
      if (!tab?.id) return { error: 'test tab not found', frames: 0, rejected: 0, statusResponses: 0, status: emptyStatus };
      try {
        const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
        const results = await Promise.allSettled(
          (frames ?? []).map(({ frameId }) => chrome.tabs.sendMessage(tab.id, message, { frameId })),
        );
        const statuses = results
          .filter((r) => r.status === 'fulfilled')
          .map((r) => r.value);
        const sum = (key) => statuses.reduce((total, status) => total + status[key], 0);
        return {
          frames: frames?.length ?? 0,
          rejected: results.filter((r) => r.status === 'rejected').length,
          statusResponses: statuses.length,
          status: {
            active: statuses.some((status) => status.active),
            total: sum('total'),
            done: sum('done'),
            busy: sum('busy'),
            queued: sum('queued'),
            errors: sum('errors'),
            oversized: sum('oversized'),
          },
        };
      } catch (e) {
        return { error: String(e), frames: 0, rejected: 0, statusResponses: 0, status: emptyStatus };
      }
    }, { message: msg, url: `http://127.0.0.1:${PORT}/iframe-test` });

  const frameStart = await frameTabMessage({ type: 'start' });
  check(!frameStart.error, `frame start reaches injectable documents ${frameStart.error ?? ''}`);
  check(frameStart.rejected > 0, 'unmatched frame message rejection does not block other frames');
  await framePage.waitForTimeout(3500);
  check(
    !backgroundDiagnostics.slice(frameDiagnosticStart).some((line) => line.includes('[LLM Page Translator] translation memory')),
    'disabled diagnostics do not log iframe memory activity',
  );
  check(
    !frameDiagnostics.some((line) => line.includes('[LLM Page Translator] mutation observer')),
    'disabled diagnostics do not log MutationObserver callbacks in iframes',
  );
  const frameTexts = [
    'Top-document boundary phrase.',
    'Cross-origin boundary phrase.',
    'Blank child boundary phrase.',
    'Nested child boundary phrase.',
  ];
  const frameRequests = requests.filter((r) =>
    frameTexts.some((text) => r.messages[1].content.includes(text)),
  );
  check(frameTexts.every((text) => frameRequests.some((r) => r.messages[1].content.includes(text))), 'top, cross-origin, blank, and nested frame text reach translation');
  check(
    frameRequests.length > 0 && frameRequests.every((r) => {
      const content = r.messages[1].content;
      return !(
        (content.includes(frameTexts[0]) && frameTexts.slice(1).some((text) => content.includes(text))) ||
        (content.includes(frameTexts[1]) && frameTexts.slice(2).some((text) => content.includes(text))) ||
        (content.includes(frameTexts[2]) && content.includes(frameTexts[3]))
      );
    }),
    'translation chunks never cross document boundaries',
  );
  check(
    (await framePage.locator('#top-frame-text').innerText()).includes('IT:Top-document boundary phrase.') &&
      (await framePage.frameLocator('#cross-origin-frame').locator('#cross-origin-text').innerText()).includes('IT:Cross-origin boundary phrase.') &&
      (await framePage.frameLocator('#blank-frame').locator('#blank-frame-text').innerText()).includes('IT:Blank child boundary phrase.') &&
      (await framePage.frameLocator('#cross-origin-frame').frameLocator('#nested-frame').locator('#nested-frame-text').innerText()).includes('IT:Nested child boundary phrase.'),
    'each injectable frame receives its translation',
  );
  const frameStatus = await frameTabMessage({ type: 'status' });
  check(
    frameStatus.status.active && frameStatus.status.done === frameStatus.status.total,
    `aggregated frame status ${JSON.stringify(frameStatus.status)}`,
  );
  const frameNumberRequestCount = requests.length;
  const frameNumberUpdated = await framePage.frameLocator('#cross-origin-frame').locator('#cross-origin-number').evaluate((element) => {
    const child = element.firstChild;
    element.innerHTML = 'Frame count 7 items.';
    return element.firstChild === child && element.textContent.includes('IT:') && element.textContent.includes('7');
  });
  check(frameNumberUpdated, 'iframe numeric HTML updates preserve translated nodes');
  await framePage.waitForTimeout(1000);
  check(requests.length === frameNumberRequestCount, 'iframe numeric HTML updates do not request translation');
  const frameRestore = await frameTabMessage({ type: 'restore' });
  check(!frameRestore.error, 'restore reaches all responding frames');
  check(
    (await framePage.frameLocator('#cross-origin-frame').locator('#cross-origin-text').innerText()) === 'Cross-origin boundary phrase.' &&
      (await framePage.frameLocator('#blank-frame').locator('#blank-frame-text').innerText()) === 'Blank child boundary phrase.',
    'iframe restore returns original text',
  );
  check((await framePage.frameLocator('#cross-origin-frame').locator('#cross-origin-number').innerText()) === 'Frame count 7 items.',
    'iframe restore retains updated numeric originals');
  await framePage.frameLocator('#cross-origin-frame').locator('#cross-origin-number').evaluate((element) => {
    element.textContent = 'Frame count 6 items.';
  });
  const frameCacheRequestCount = requests.length;
  await frameTabMessage({ type: 'start' });
  await framePage.waitForTimeout(1000);
  check(requests.length === frameCacheRequestCount, 'retranslating the page reuses memory from the top document and frames');
  await frameTabMessage({ type: 'restore' });

  const frameReloadRequestCount = requests.length;
  await framePage.reload();
  await framePage.waitForTimeout(500);
  const frameReloadStart = await frameTabMessage({ type: 'start' });
  check(!frameReloadStart.error, 'frame translation can restart after a page reload');
  await framePage.waitForTimeout(3500);
  const frameReloadStatus = await frameTabMessage({ type: 'status' });
  check(
    !frameReloadStatus.error &&
      frameReloadStatus.status.active &&
      frameReloadStatus.status.total > 0 &&
      frameReloadStatus.status.done === frameReloadStatus.status.total,
    `all frame translations finish after reload ${JSON.stringify(frameReloadStatus.status)}`,
  );
  check(
    (await framePage.frameLocator('#cross-origin-frame').frameLocator('#nested-frame').locator('#nested-frame-text').innerText())
      .includes('IT:Nested child boundary phrase.'),
    'nested about:srcdoc text is translated after reload',
  );
  check(
    requests.length === frameReloadRequestCount,
    'reloading the page reuses stored translations for internal iframe documents',
  );
  await frameTabMessage({ type: 'restore' });

  // Popup & options pages load without errors
  const extId = new URL(sw.url()).host;
  for (const p of ['popup/popup.html', 'options/options.html']) {
    const pg = await ctx.newPage();
    const errs = [];
    pg.on('pageerror', (e) => errs.push(String(e)));
    await pg.goto(`chrome-extension://${extId}/${p}`);
    await pg.waitForTimeout(500);
    check(errs.length === 0, `${p} loads without errors ${errs.join(' ')}`);
    if (p.startsWith('popup')) {
      const clearMemoryButton = pg.locator('#clearMemory');
      const hasClearMemoryButton = (await clearMemoryButton.count()) === 1;
      check(hasClearMemoryButton, 'popup exposes a page memory clear button');
      check((await pg.locator('#textDiagnostics').count()) === 1, 'popup exposes per-tab text diagnostics toggle');
      if (hasClearMemoryButton) {
        const popupTabId = await sw.evaluate(async () =>
          (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id,
        );
        await sw.evaluate(async (tabId) => {
          await chrome.storage.session.set({ [`tab:${tabId}`]: { textDiagnostics: true } });
        }, popupTabId);
        const clearDiagnosticStart = backgroundDiagnostics.length;
        await clearMemoryButton.click();
        await pg.waitForFunction(() => document.querySelector('#status')?.textContent === 'Memory cleared for this page.');
        const clearEvent = backgroundDiagnostics
          .slice(clearDiagnosticStart)
          .find((line) => line.includes('[LLM Page Translator] translation memory cleared'));
        check(
          !!clearEvent && clearEvent.includes('removedEntries'),
          'enabled diagnostics log page memory clears',
        );
        check(
          !!clearEvent &&
            !clearEvent.includes('http') &&
            !clearEvent.includes('The first sentence is here.') &&
            !clearEvent.includes('IT:'),
          'page-clear diagnostics omit URLs, source text, and translations',
        );
      }
      const beforePageClear = requests.length;
      const frameTabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, framePage.url());
      check(typeof frameTabId === 'number', 'iframe tab ID is available for scoped memory diagnostics');
      const disabledClearCount = backgroundDiagnostics.filter((line) => line.includes('[LLM Page Translator] translation memory cleared')).length;
      await pg.evaluate(
        ({ pageUrl, tabId }) => chrome.runtime.sendMessage({ type: 'clearPageMemory', pageUrl, tabId }),
        { pageUrl: framePage.url(), tabId: frameTabId },
      );
      check(
        backgroundDiagnostics.filter((line) => line.includes('[LLM Page Translator] translation memory cleared')).length === disabledClearCount,
        'disabled diagnostics do not log iframe memory clears',
      );
      await frameTabMessage({ type: 'start' });
      await framePage.waitForTimeout(3500);
      check(requests.length > beforePageClear, 'clearing a page removes its top-document and iframe memories');
      await frameTabMessage({ type: 'restore' });
      await pg.locator('#textDiagnostics').check();
      await pg.waitForTimeout(300);
      const diagnosticsSettings = await sw.evaluate(async () => {
        const all = await chrome.storage.session.get(null);
        return Object.values(all).find((v) => v && v.textDiagnostics);
      });
      check(diagnosticsSettings?.textDiagnostics === true, 'popup persists diagnostics toggle for this tab');
      const opts = await pg.locator('#model option').allTextContents();
      check(JSON.stringify(opts) === JSON.stringify(['(global: mock)', 'mock', 'other']), `popup model list: ${JSON.stringify(opts)}`);
      const src = await pg.locator('#sourceLanguage option').allTextContents();
      const tgt = await pg.locator('#targetLanguage option').allTextContents();
      check(src[0] === 'Auto-detect' && src.includes('German') && src.includes('Japanese'), `source selector: ${src.slice(0, 4).join(', ')}…`);
      check(tgt[0] === '(global: Italian)' && tgt.includes('English'), `target selector: ${tgt.slice(0, 4).join(', ')}…`);
      await pg.locator('#sourceLanguage').selectOption('German');
      await pg.locator('#targetLanguage').selectOption('French');
      await pg.waitForTimeout(600);
      const saved = await sw.evaluate(async () => {
        const all = await chrome.storage.session.get(null);
        return Object.values(all).find((v) => v && v.sourceLanguage);
      });
      check(saved?.sourceLanguage === 'German' && saved?.targetLanguage === 'French', `tab languages saved: ${JSON.stringify(saved)}`);
    }
    if (p.startsWith('options')) {
      check((await pg.locator('input[name=memoryRetentionDays]').inputValue()) === '30', 'options show the default 30-day memory retention');
      const sliceOption = pg.locator('input[name=experimentalSliceGuard]');
      const hasSliceOption = (await sliceOption.count()) === 1;
      check(hasSliceOption && !(await sliceOption.isChecked()), 'experimental slice option is available and disabled by default');
      if (hasSliceOption) await sliceOption.check();
      const numberOption = pg.locator('input[name=separateNumbers]');
      const hasNumberOption = (await numberOption.count()) === 1;
      check(hasNumberOption && !(await numberOption.isChecked()), 'number separator option is available and disabled by default');
      if (hasNumberOption) await numberOption.check();
      const opts = await pg.locator('select[name=model] option').allTextContents();
      check(JSON.stringify(opts) === JSON.stringify(['mock', 'other']), `options model list from backend: ${JSON.stringify(opts)}`);
      check((await pg.locator('select[name=model]').inputValue()) === 'mock', 'options shows saved model');
      check((await pg.locator('select[name=targetLanguage]').inputValue()) === 'Italian', 'options target language selector shows saved value');
      await pg.locator('button[type=submit]').click();
      await pg.waitForFunction(() => document.querySelector('#msg')?.textContent?.startsWith('Saved'));
      const savedSettings = await sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
      check(savedSettings.tabPromptRules?.[0]?.prompt === 'E2E saved URL prompt', 'saving global options preserves URL prompt rules');
      check(hasSliceOption && savedSettings.experimentalSliceGuard === true, 'options save the experimental slice setting');
      check(hasNumberOption && savedSettings.separateNumbers === true, 'options save the number separator setting');
      if (hasSliceOption) {
        await sliceOption.uncheck();
        if (hasNumberOption) await numberOption.uncheck();
        await pg.locator('button[type=submit]').click();
        await pg.waitForFunction(() => document.querySelector('#msg')?.textContent?.startsWith('Saved'));
      }
      await pg.locator('#test').click();
      await pg.waitForTimeout(1500);
      check((await pg.locator('#msg').innerText()).includes('OK'), `test connection: ${await pg.locator('#msg').innerText()}`);

      await pg.locator('input[name=baseUrl]').fill('http://127.0.0.1:1');
      await pg.waitForTimeout(2000);
      const off = await pg.locator('select[name=model] option').allTextContents();
      check(off.includes('<no model>') && !off.includes('other'), `unreachable backend shows <no model>: ${JSON.stringify(off)}`);
      check((await pg.locator('#modelHint').innerText()).includes('unreachable'), `hint: ${await pg.locator('#modelHint').innerText()}`);
    }
    await pg.close();
  }
  const setterPage = await ctx.newPage();
  setterPage.on('pageerror', (e) => errors.push(String(e)));
  await setterPage.goto(`http://127.0.0.1:${PORT}/setter-test`);
  await setterPage.evaluate(() => {
    document.body.innerHTML = `
      <p id="setter-text">Original setter phrase.</p>
      <p id="setter-html">Read <a href="/target">the link</a> now.</p>
      <p id="setter-detached">Detached original phrase.</p>
      <p id="setter-detached-html">Detached HTML phrase.</p>
      <p id="setter-number">Normal value 43 units.</p>
      <div id="setter-hidden" style="display:none"><b>Untranslated content</b></div>
      <iframe id="setter-frame" srcdoc="<p id='frame-source'>Frame original phrase.</p>"></iframe>
    `;
  });
  const setterTabMsg = (msg) => sw.evaluate(async (m) => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:8765/setter-test' });
    return chrome.tabs.sendMessage(tab.id, m);
  }, msg);
  await setterPage.waitForTimeout(500);
  await setterTabMsg({ type: 'start' });
  check(await setterPage.evaluate(() => typeof 'ordinary'.slice(0, 3) === 'string'), 'slice wrapping is disabled by default');
  await setterPage.waitForFunction(() =>
    document.querySelector('#setter-text')?.textContent?.includes('IT:Original setter phrase.') &&
    document.querySelector('#setter-html')?.textContent?.includes('IT:the link') &&
    document.querySelector('#setter-detached')?.textContent?.includes('IT:Detached original phrase.') &&
    document.querySelector('#setter-detached-html')?.textContent?.includes('IT:Detached HTML phrase.') &&
    document.querySelector('#setter-number')?.textContent?.includes('IT:Normal value 43 units.'),
    null,
    { timeout: 10000 },
  );
  const setterChecks = await setterPage.evaluate(() => {
    function assignWithoutMutation(element, setter, value) {
      const child = element.firstChild;
      const before = element.innerHTML;
      const observer = new MutationObserver(() => {});
      observer.observe(element, { childList: true, subtree: true, characterData: true });
      element[setter] = value;
      const result = child === element.firstChild && before === element.innerHTML && observer.takeRecords().length === 0;
      observer.disconnect();
      return result;
    }
    const detached = document.querySelector('#setter-detached');
    detached.remove();
    const detachedText = assignWithoutMutation(detached, 'textContent', 'Detached original phrase.');
    document.body.append(detached);
    const detachedHtmlNode = document.querySelector('#setter-detached-html');
    detachedHtmlNode.remove();
    const detachedHtml = assignWithoutMutation(detachedHtmlNode, 'innerHTML', 'Detached HTML phrase.');
    document.body.append(detachedHtmlNode);
    const empty = document.createElement('div');
    empty.append(document.createTextNode(''));
    const numeric = document.createElement('div');
    numeric.append(document.createTextNode('42'));
    return {
      text: assignWithoutMutation(document.querySelector('#setter-text'), 'textContent', 'Original setter phrase.'),
      html: assignWithoutMutation(document.querySelector('#setter-html'), 'innerHTML', "Read <a href='/target'>the link</a> now."),
      plain: assignWithoutMutation(document.querySelector('#setter-hidden'), 'innerHTML', '<b>Untranslated content</b>'),
      segmentHtml: assignWithoutMutation(document.querySelector('#setter-text .xt-seg'), 'innerHTML', 'Original setter phrase.'),
      detachedText,
      detachedHtml,
      nullText: assignWithoutMutation(empty, 'textContent', null),
      numberText: assignWithoutMutation(numeric, 'textContent', 42),
    };
  });
  check(setterChecks.text, 'equal textContent keeps translated nodes without mutation');
  check(setterChecks.html, 'equal original innerHTML keeps translated markup without mutation');
  check(setterChecks.plain, 'equal innerHTML keeps untranslated nodes without mutation');
  check(setterChecks.segmentHtml, 'equal innerHTML on a translated segment compares original text');
  check(setterChecks.detachedText, 'equal original textContent is intercepted on detached translated nodes');
  check(setterChecks.detachedHtml, 'equal original innerHTML is intercepted on detached translated nodes');
  check(setterChecks.nullText, 'equal null textContent preserves existing nodes');
  check(setterChecks.numberText, 'equal numeric textContent preserves existing nodes');

  const setterFrame = setterPage.frameLocator('#setter-frame').locator('#frame-source');
  await setterFrame.waitFor();
  await setterPage.waitForTimeout(1500);
  const frameAssignment = await setterFrame.evaluate((element) => {
    const before = element.innerHTML;
    const child = element.firstChild;
    const observer = new MutationObserver(() => {});
    observer.observe(element, { childList: true, subtree: true, characterData: true });
    element.textContent = 'Frame original phrase.';
    const unchanged = element.firstChild === child && element.innerHTML === before && observer.takeRecords().length === 0;
    observer.disconnect();
    return before.includes('IT:') && unchanged;
  });
  check(frameAssignment, 'equal original textContent is intercepted in iframes');
  await setterPage.evaluate(() => {
    document.querySelector('#setter-html').innerHTML = 'Read <strong>the link</strong> now.';
    document.querySelector('#setter-text').textContent = 'Changed setter phrase.';
  });
  check(await setterPage.locator('#setter-html strong').count() === 1, 'changed markup is not suppressed');
  await setterPage.waitForFunction(() =>
    document.querySelector('#setter-text')?.textContent?.includes('IT:Changed setter phrase.'),
    null,
    { timeout: 10000 },
  );
  check(true, 'changed text is translated normally');
  await setterTabMsg({ type: 'restore' });
  const afterRestore = await setterPage.evaluate(() => {
    const element = document.querySelector('#setter-text');
    const child = element.firstChild;
    element.textContent = element.textContent;
    return child !== element.firstChild;
  });
  check(afterRestore, 'restore returns page setters to normal behavior');
  await setterPage.close();

  for (const separateNumbers of [false, true]) {
    await sw.evaluate(async (separate) => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, separateNumbers: separate, experimentalSliceGuard: false } });
    }, separateNumbers);
    const htmlPage = await ctx.newPage();
    htmlPage.on('pageerror', (e) => errors.push(String(e)));
    const htmlUrl = `http://127.0.0.1:${PORT}/html-number-test?separate=${separateNumbers}`;
    await htmlPage.goto(htmlUrl);
    await htmlPage.evaluate((separate) => {
      document.body.innerHTML = `
        <p id="html-single">Total: -12.5 items.</p>
        <p id="html-nested">Status <a href="/one">Count 2</a><i>8</i> end.</p>
        <p id="html-punctuation">Greetings, world.</p>
        <p id="html-pending">Pending 11 items.</p>
        <p id="html-duplicates">Repeated 3 and 3 items.</p>
        <p id="html-restored">Remaining <b>20</b> items.</p>
        ${separate ? '' : '<p id="html-ambiguous">Ambiguous 6 units.</p>'}
      `;
    }, separateNumbers);
    const htmlTabMsg = (msg) => sw.evaluate(async ({ m, url }) => {
      const [tab] = await chrome.tabs.query({ url });
      return chrome.tabs.sendMessage(tab.id, m, { frameId: 0 });
    }, { m: msg, url: htmlUrl });
    await htmlPage.waitForTimeout(500);
    await htmlTabMsg({ type: 'start' });
    const pendingReplaced = await htmlPage.locator('#html-pending').evaluate((element) => {
      const oldChild = element.firstChild;
      element.innerHTML = 'Pending 12 items.';
      return element.firstChild !== oldChild;
    });
    check(pendingReplaced, `incomplete translation applies the incoming HTML (separateNumbers=${separateNumbers})`);
    await htmlPage.waitForFunction((separate) =>
      document.querySelector('#html-single')?.textContent?.includes('IT:') &&
      document.querySelector('#html-nested a')?.textContent?.includes('IT:') &&
      document.querySelector('#html-punctuation')?.textContent?.includes('IT:') &&
      document.querySelector('#html-pending')?.textContent?.includes('12') &&
      document.querySelector('#html-duplicates')?.textContent?.includes('IT:') &&
      document.querySelector('#html-restored')?.textContent?.includes('IT:') &&
      (separate || document.querySelector('#html-ambiguous')?.textContent?.includes('IT:Ambiguous units.')),
      separateNumbers, { timeout: 15000 });
    await htmlPage.waitForTimeout(1000);
    const htmlRequestStart = requests.length;
    const htmlChecks = await htmlPage.evaluate(() => {
      const single = document.querySelector('#html-single');
      const singleChild = single.firstChild;
      single.innerHTML = "Total: +1'400,5 items.";
      const singleUpdated = single.firstChild === singleChild && single.textContent.includes('IT:') && single.textContent.includes("+1'400,5");
      single.textContent = "Total: +1'400,5 items.";
      const updatedOriginalMatches = single.firstChild === singleChild && single.textContent.includes('IT:');
      const nested = document.querySelector('#html-nested');
      const link = nested.querySelector('a');
      const numberOnly = nested.querySelector('i');
      nested.innerHTML = 'Status <a href="/one">Count 9</a><i>15</i> end.';
      const firstUpdate = nested.querySelector('a') === link && link.textContent.includes('IT:') && link.textContent.includes('9') &&
        nested.querySelector('i') === numberOnly && numberOnly.textContent === '15';
      nested.innerHTML = 'Status <a href="/one">Count 10</a><i>16</i> end!';
      const secondUpdate = nested.querySelector('a') === link && link.textContent.includes('IT:') && link.textContent.includes('10') &&
        nested.querySelector('i') === numberOnly && numberOnly.textContent === '16';
      const punctuation = document.querySelector('#html-punctuation');
      const before = punctuation.innerHTML;
      punctuation.innerHTML = 'Greetings!!! world?';
      const restored = document.querySelector('#html-restored');
      const bold = restored.querySelector('b');
      restored.innerHTML = 'Remaining <b>21</b> items.';
      const numericChildUpdated = restored.querySelector('b') === bold && bold.textContent === '21';
      return { singleUpdated, updatedOriginalMatches, firstUpdate, secondUpdate, numericChildUpdated, punctuationPreserved: punctuation.innerHTML === before };
    });
    await htmlPage.waitForTimeout(1200);
    check(htmlChecks.singleUpdated, `formatted number update preserves translated nodes (separateNumbers=${separateNumbers})`);
    check(htmlChecks.updatedOriginalMatches, `updated originals prevent equivalent textContent replacement (separateNumbers=${separateNumbers})`);
    check(htmlChecks.firstUpdate && htmlChecks.secondUpdate, `nested repeated number updates preserve translated markup (separateNumbers=${separateNumbers})`);
    check(htmlChecks.numericChildUpdated, `numeric-only child text updates in place (separateNumbers=${separateNumbers})`);
    check(htmlChecks.punctuationPreserved, `nonalphabetic-only HTML changes preserve translated content (separateNumbers=${separateNumbers})`);
    check(requests.length === htmlRequestStart, `number-only HTML updates do not request translation (separateNumbers=${separateNumbers})`);
    if (!separateNumbers) {
      const ambiguousReplaced = await htmlPage.locator('#html-ambiguous').evaluate((element) => {
        const oldChild = element.firstChild;
        element.innerHTML = 'Ambiguous 7 units.';
        return element.firstChild !== oldChild;
      });
      check(ambiguousReplaced, 'ambiguous translated numbers apply the incoming HTML normally');
      await htmlPage.waitForFunction(() => document.querySelector('#html-ambiguous')?.textContent?.includes('IT:Ambiguous 7 units.'), null, { timeout: 15000 });
    }
    const duplicateReplaced = await htmlPage.locator('#html-duplicates').evaluate((element) => {
      const oldChild = element.firstChild;
      element.innerHTML = 'Repeated 4 and 5 items.';
      return element.firstChild !== oldChild;
    });
    check(duplicateReplaced, `ambiguous duplicate numbers apply the incoming HTML (separateNumbers=${separateNumbers})`);
    const detachedUpdated = await htmlPage.locator('#html-single').evaluate((element) => {
      const parent = element.parentNode;
      const child = element.firstChild;
      element.remove();
      element.innerHTML = "Total: +1'500,5 items.";
      const preserved = element.firstChild === child && element.textContent.includes('IT:') && element.textContent.includes("+1'500,5");
      parent.appendChild(element);
      return preserved;
    });
    check(detachedUpdated, `detached translated HTML preserves number updates (separateNumbers=${separateNumbers})`);
    const changedMarkup = await htmlPage.locator('#html-nested').evaluate((element) => {
      const oldLink = element.querySelector('a');
      element.innerHTML = 'Status <a href="/two">Count 10</a><i>16</i> end.';
      return element.querySelector('a') !== oldLink && element.querySelector('a').getAttribute('href') === '/two';
    });
    check(changedMarkup, `changed attributes apply normally (separateNumbers=${separateNumbers})`);
    const changedTag = await htmlPage.locator('#html-nested').evaluate((element) => {
      element.innerHTML = 'Status <strong>Count 10</strong><i>16</i> end.';
      return !!element.querySelector('strong') && !element.querySelector('a');
    });
    check(changedTag, `changed tags apply normally (separateNumbers=${separateNumbers})`);
    await htmlPage.waitForTimeout(2500);
    const pendingText = await htmlPage.locator('#html-pending').textContent();
    const duplicateText = await htmlPage.locator('#html-duplicates').textContent();
    check(pendingText.includes('IT:') && pendingText.includes('12'),
      `incomplete translation is retried for the incoming HTML (separateNumbers=${separateNumbers})`);
    check(duplicateText.includes('IT:') && duplicateText.includes('4') && duplicateText.includes('5'),
      `ambiguous numeric changes are retranslated (separateNumbers=${separateNumbers})`);
    await htmlTabMsg({ type: 'restore' });
    check((await htmlPage.locator('#html-single').textContent()) === "Total: +1'500,5 items.",
      `restore retains updated original numbers (separateNumbers=${separateNumbers})`);
    check((await htmlPage.locator('#html-restored').textContent()) === 'Remaining 21 items.',
      `restore retains updated numeric-only child text (separateNumbers=${separateNumbers})`);
    await htmlPage.close();
  }

  const mutationPage = await ctx.newPage();
  mutationPage.on('pageerror', (e) => errors.push(String(e)));
  const mutationScanRoots = [];
  mutationPage.on('console', async (message) => {
    if (message.text().includes('[LLM Page Translator] scan started')) {
      mutationScanRoots.push((await message.args()[1].jsonValue()).root);
    }
  });
  await mutationPage.goto(`http://127.0.0.1:${PORT}/mutation-target-test`);
  await mutationPage.evaluate(() => {
    document.body.innerHTML = `
      <p id="previously-hidden" style="display:none">Previously hidden unrelated phrase.</p>
      <p id="changed-first"></p><p id="changed-second"></p>
      <div id="excluded-parent" translate="no"></div>
      <div id="hidden-parent" style="display:none"></div>
      <pre id="excluded-tag"></pre>
      <form id="dynamic-form"></form>
      <div id="move-from"></div><div id="move-to"></div>
    `;
    document.querySelector('#changed-first').appendChild(document.createTextNode(''));
    document.querySelector('#changed-second').appendChild(document.createTextNode(''));
  });
  const mutationTabMsg = (msg) => sw.evaluate(async (m) => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:8765/mutation-target-test' });
    return chrome.tabs.sendMessage(tab.id, m, { frameId: 0 });
  }, msg);
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:8765/mutation-target-test' });
    await chrome.storage.session.set({ [`tab:${tab.id}`]: { textDiagnostics: true } });
  });
  await mutationPage.waitForTimeout(500);
  await mutationTabMsg({ type: 'start' });
  await mutationPage.waitForTimeout(100);
  mutationScanRoots.length = 0;
  const mutationRequestStart = requests.length;
  await mutationPage.evaluate(() => {
    document.querySelector('#previously-hidden').style.display = '';
    document.querySelector('#changed-first').firstChild.data = 'First changed text.';
    const added = document.createElement('section');
    added.id = 'added-subtree';
    document.body.appendChild(added);
    const nested = document.createElement('p');
    nested.textContent = 'Nested added text.';
    added.appendChild(nested);
    const input = document.createElement('input');
    input.id = 'dynamic-input';
    input.setAttribute('value', 'Direct added input.');
    document.querySelector('#dynamic-form').appendChild(input);
    document.querySelector('#excluded-parent').textContent = 'Excluded ancestor text.';
    document.querySelector('#hidden-parent').textContent = 'Hidden ancestor text.';
    document.querySelector('#excluded-tag').textContent = 'Excluded tag text.';
    const detached = document.createElement('p');
    detached.textContent = 'Detached before debounce.';
    document.body.appendChild(detached);
    detached.remove();
    const moved = document.createElement('p');
    moved.id = 'moved-target';
    moved.textContent = 'Moved target text.';
    document.querySelector('#move-from').appendChild(moved);
    document.body.appendChild(document.createTextNode('Direct body text.'));
  });
  await mutationPage.waitForTimeout(150);
  await mutationPage.evaluate(() => {
    document.querySelector('#changed-second').firstChild.data = 'Second changed text.';
    document.querySelector('#move-to').appendChild(document.querySelector('#moved-target'));
  });
  await mutationPage.waitForFunction(() =>
    document.querySelector('#changed-first')?.textContent?.includes('IT:First changed text.') &&
    document.querySelector('#changed-second')?.textContent?.includes('IT:Second changed text.') &&
    document.querySelector('#added-subtree')?.textContent?.includes('IT:Nested added text.') &&
    document.querySelector('#move-to #moved-target')?.textContent?.includes('IT:Moved target text.') &&
    document.body.textContent?.includes('IT:Direct body text.') &&
    document.querySelector('#dynamic-input')?.value?.includes('IT:Direct added input.'),
    null, { timeout: 15000 });
  check((await mutationPage.locator('#previously-hidden').textContent()) === 'Previously hidden unrelated phrase.',
    'mutation processing does not scan unrelated newly visible text');
  const mutationRequests = requests.slice(mutationRequestStart).map((request) => request.messages[1].content);
  check(!mutationRequests.some((request) => request.includes('Previously hidden unrelated phrase.')),
    'unrelated newly visible text is not sent to the provider');
  check(!mutationRequests.some((request) =>
    ['Excluded ancestor text.', 'Hidden ancestor text.', 'Excluded tag text.', 'Detached before debounce.'].some((text) => request.includes(text))),
    'targeted scans skip excluded, hidden, and detached nodes');
  check(mutationRequests.filter((request) => request.includes('Nested added text.')).length === 1,
    'overlapping added subtrees are translated only once');
  check(mutationRequests.filter((request) => request.includes('Moved target text.')).length === 1,
    'nodes moved during the debounce are translated once in their final location');
  check(mutationScanRoots.some((root) => root.includes('#added-subtree')) &&
    !mutationScanRoots.some((root) => root === 'html > body'),
    'observer-triggered scans do not traverse the whole document');
  await mutationTabMsg({ type: 'restore' });
  await mutationPage.close();

  await sw.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, experimentalSliceGuard: true, separateNumbers: true } });
  });
  const slicePage = await ctx.newPage();
  slicePage.on('pageerror', (e) => errors.push(String(e)));
  const sliceDiagnostics = [];
  slicePage.on('console', async (message) => {
    if (message.text().includes('[LLM Page Translator] mutation observer')) {
      sliceDiagnostics.push(await message.args()[1].jsonValue());
    }
  });
  await slicePage.goto(`http://127.0.0.1:${PORT}/slice-test`);
  await slicePage.evaluate(() => {
    document.body.innerHTML = `
      <p id="slice-only">Slice target original.</p>
      <p id="slice-mixed">Mixed target original.</p>
      <p id="slice-full">Full target original.</p>
      <iframe id="slice-frame" srcdoc="<p id='slice-frame-target'>Frame target original.</p>"></iframe>
    `;
  });
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:8765/slice-test' });
    await chrome.storage.session.set({ [`tab:${tab.id}`]: { textDiagnostics: true } });
  });
  const sliceTabMsg = (msg) => sw.evaluate(async (m) => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:8765/slice-test' });
    return chrome.tabs.sendMessage(tab.id, m);
  }, msg);
  await slicePage.waitForTimeout(500);
  await sliceTabMsg({ type: 'start' });
  await slicePage.waitForFunction(() =>
    document.querySelector('#slice-only')?.textContent?.includes('IT:Slice target original.') &&
    document.querySelector('#slice-mixed')?.textContent?.includes('IT:Mixed target original.') &&
    document.querySelector('#slice-full')?.textContent?.includes('IT:Full target original.'),
    null,
    { timeout: 10000 },
  );
  const sliceFrame = slicePage.frameLocator('#slice-frame').locator('#slice-frame-target');
  await sliceFrame.waitFor();
  await slicePage.waitForTimeout(1500);
  const requestStart = requests.length;
  const sliceStart = sliceDiagnostics.length;
  const sliceChecks = await slicePage.evaluate(() => {
    const partial = 'Unique sliced source'.slice(0, 6);
    const full = 'Whole changed phrase.'.slice();
    const equalPartial = 'Unique suffix'.slice(0, 6);
    const framePartial = document.querySelector('#slice-frame').contentWindow.String.prototype.slice.call('Unique iframe source', 0, 6);
    const noConstructor = { constructor: null, toString: () => 'ordinary object' };
    const detached = document.createElement('p');
    detached.textContent = null;
    const nullText = detached.textContent === '';
    detached.textContent = undefined;
    const undefinedText = detached.textContent === '';
    detached.textContent = noConstructor;
    const result = {
      partialWrapped: !(partial instanceof String) && partial.constructor?.name === full.constructor?.name && partial.isSubstring === true && partial.value === 'Unique',
      fullWrapped: !(full instanceof String) && full.isSubstring === false,
      equality: typeof partial.equals === 'function' && partial.equals('Unique') && partial.equals(equalPartial) && partial.equals(framePartial) &&
        !partial.equals(null) && !partial.equals(undefined) && !partial.equals(noConstructor) &&
        partial == 'Unique' && String(partial) === 'Unique',
      nullSafe: nullText && undefinedText && detached.textContent === 'ordinary object',
    };
    document.querySelector('#slice-only').textContent = framePartial;
    document.querySelector('#slice-mixed').textContent = 'Discarded mixed source'.slice(0, 9);
    document.querySelector('#slice-mixed').textContent = 'Genuine mixed update.';
    document.querySelector('#slice-full').textContent = full;
    const direct = document.createElement('p');
    direct.id = 'slice-direct';
    direct.appendChild(document.createTextNode('Initial direct text.'));
    document.body.appendChild(direct);
    direct.firstChild.textContent = 'Direct substring source'.slice(0, 6);
    const boundaryHost = document.createElement('p');
    const boundary = document.createElement('span');
    boundaryHost.append('SliceBoundaryBefore ', boundary, ' SliceBoundaryAfter');
    document.body.appendChild(boundaryHost);
    boundary.textContent = 'Slice 123'.slice(6);
    result.primitiveText = typeof document.querySelector('#slice-only').textContent === 'string';
    return result;
  });
  const frameWrapped = await sliceFrame.evaluate((element) => {
    const partial = 'Frame slice source'.slice(0, 5);
    element.textContent = partial;
    return partial.constructor?.name === 'Frame'.slice().constructor?.name && partial.isSubstring === true;
  });
  await slicePage.waitForTimeout(3500);
  check(sliceChecks.partialWrapped && sliceChecks.fullWrapped && sliceChecks.equality, 'experimental slice returns comparable wrappers with substring metadata');
  check(sliceChecks.nullSafe, 'slice detection accepts null, undefined, and objects without constructors');
  check(sliceChecks.primitiveText && (await slicePage.locator('#slice-only').textContent()) === 'Unique', 'substring assignment stores primitive text without retranslating');
  check(
    (await slicePage.locator('#slice-mixed').textContent()).includes('IT:Genuine mixed update.'),
    'a later ordinary mutation on the same node is translated',
  );
  check((await slicePage.locator('#slice-full').textContent()).includes('IT:Whole changed phrase.'), 'a full slice mutation is translated normally');
  check((await slicePage.locator('#slice-direct').textContent()) === 'Direct', 'direct text-node substring assignment survives unrelated scans');
  check(frameWrapped && (await sliceFrame.textContent()) === 'Frame', 'iframe substring mutation is ignored independently');
  check(
    !requests.slice(requestStart).some((request) => request.messages[1].content.includes('Unique') || request.messages[1].content.includes('Frame') || request.messages[1].content.includes('Direct')),
    'ignored slice mutations do not reach the provider',
  );
  const sliceBoundaryRequests = requests.slice(requestStart).map((request) => request.messages[1].content);
  check(
    sliceBoundaryRequests.some((request) => request.includes('SliceBoundaryBefore')) &&
    sliceBoundaryRequests.some((request) => request.includes('SliceBoundaryAfter')) &&
    !sliceBoundaryRequests.some((request) => request.includes('SliceBoundaryBefore') && request.includes('SliceBoundaryAfter')),
    'an ignored slice containing numbers still separates surrounding chunks',
  );
  check(
    sliceDiagnostics.slice(sliceStart).some((summary) =>
      summary.mutations?.some((mutation) => mutation.sliceWrapper === true && mutation.isSubstring === true)),
    'observer diagnostics identify substring wrapper assignments',
  );
  await slicePage.locator('#slice-direct').evaluate((element) => {
    element.firstChild.textContent = 'Genuine direct update.';
  });
  await slicePage.waitForTimeout(2000);
  check((await slicePage.locator('#slice-direct').textContent()).includes('IT:Genuine direct update.'), 'a later ordinary text-node mutation is translated');
  await sliceTabMsg({ type: 'restore' });
  check(await slicePage.evaluate(() => typeof 'ordinary'.slice(0, 3) === 'string'), 'restore removes experimental slice wrapping');
  await slicePage.close();

  await sw.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, experimentalSliceGuard: false, separateNumbers: true } });
  });
  const numberPage = await ctx.newPage();
  numberPage.on('pageerror', (e) => errors.push(String(e)));
  await numberPage.goto(`http://127.0.0.1:${PORT}/numbers-test`);
  await numberPage.evaluate(() => {
    document.body.innerHTML = `
      <p>Unrelated neighboring phrase.</p>
      <p id="number-text">Balance 12.5 credits.</p>
      <p>Another neighboring phrase.</p>
      <p id="number-inline">BoundaryBefore <span>99</span> BoundaryAfter</p>
      <p id="number-word">Device24h ready.</p>
      <p id="number-unicode">Quantity ١٢٫٥ units.</p>
      <form><input id="number-input" type="text" value="Inventory 7 units."></form>
      <iframe id="number-frame" srcdoc="<p id='number-frame-text'>Framecount 21 objects.</p>"></iframe>
    `;
  });
  const numberTabMsg = (msg) => sw.evaluate(async (m) => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:8765/numbers-test' });
    return chrome.tabs.sendMessage(tab.id, m);
  }, msg);
  const waitForNumberTranslations = async () => {
    let status;
    for (let attempt = 0; attempt < 150; attempt++) {
      status = await sw.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:8765/numbers-test' });
        return chrome.tabs.sendMessage(tab.id, { type: 'status' }, { frameId: 0 });
      });
      if (status.total > 0 && status.done === status.total) return;
      if (status.errors || status.oversized) break;
      await numberPage.waitForTimeout(100);
    }
    throw new Error(`Number translation did not finish: ${JSON.stringify(status)}`);
  };
  await numberPage.waitForTimeout(500);
  const numberRequestStart = requests.length;
  await numberTabMsg({ type: 'start' });
  await waitForNumberTranslations();
  const numberFrame = numberPage.frameLocator('#number-frame').locator('#number-frame-text');
  await numberFrame.waitFor();
  await numberPage.waitForFunction(() =>
    document.querySelector('#number-frame')?.contentDocument?.querySelector('#number-frame-text')?.textContent === 'IT:Framecount 21 IT:objects.',
    null, { timeout: 15000 });
  check((await numberPage.locator('#number-text').textContent()) === 'IT:Balance 12.5 IT:credits.', 'numbers and decimal punctuation remain unchanged between translated chunks');
  check((await numberPage.locator('#number-word').textContent()) === 'IT:Device24IT:h ready.', 'digits inside words separate translated chunks');
  check((await numberPage.locator('#number-unicode').textContent()) === 'IT:Quantity ١٢٫٥ IT:units.', 'non-ASCII numbers and their punctuation are preserved');
  check((await numberPage.locator('#number-input').inputValue()) === 'IT:Inventory 7 IT:units.', 'input values preserve numbers between translated chunks');
  const numberRequests = requests.slice(numberRequestStart).map((request) => request.messages[1].content);
  check(!numberRequests.some((request) => {
    const text = request.split('Translate this phrase, preserving the inline span markers:\n')[1] ?? '';
    return /\p{N}/u.test(text.replace(/\[\d+\]/g, ''));
  }), 'number separators are not sent to the provider');
  check(!numberRequests.some((request) => request.includes('BoundaryBefore') && request.includes('BoundaryAfter')), 'a numeric-only node separates surrounding chunks');
  const beforeInputBoundary = requests.length;
  await numberPage.locator('#number-input').evaluate((input) => {
    input.before(document.createTextNode('EarlierBoundary '));
    input.after(document.createTextNode(' LaterBoundary'));
  });
  await numberPage.waitForFunction(() => {
    const text = document.querySelector('#number-input')?.parentElement?.textContent ?? '';
    return text.includes('IT:EarlierBoundary') && text.includes('IT:LaterBoundary');
  }, null, { timeout: 10000 });
  await waitForNumberTranslations();
  const inputBoundaryRequests = requests.slice(beforeInputBoundary).map((request) => request.messages[1].content);
  check(!inputBoundaryRequests.some((request) => request.includes('EarlierBoundary') && request.includes('LaterBoundary')), 'an already translated input still separates later chunks');
  const beforeNumberUpdate = requests.length;
  await numberPage.locator('#number-text').evaluate((element) => { element.textContent = 'Balance 13.5 credits.'; });
  await numberFrame.evaluate((element) => { element.textContent = 'Framecount 22 objects.'; });
  await numberPage.waitForTimeout(2500);
  check((await numberPage.locator('#number-text').textContent()) === 'IT:Balance 13.5 IT:credits.', 'changed numbers preserve cached surrounding translations');
  check((await numberFrame.textContent()) === 'IT:Framecount 22 IT:objects.', 'iframe number updates preserve cached surrounding translations');
  check(requests.length === beforeNumberUpdate, 'updating only a number reuses translation memory without provider requests');
  await numberTabMsg({ type: 'restore' });
  check((await numberPage.locator('#number-text').textContent()) === 'Balance 13.5 credits.' &&
    (await numberPage.locator('#number-input').inputValue()) === 'Inventory 7 units.', 'restore preserves original text and numbers');
  await numberPage.locator('#number-input').evaluate((input) => { input.value = 'Inventory 8 units.'; });
  const beforeNumberRestart = requests.length;
  await numberTabMsg({ type: 'start' });
  await waitForNumberTranslations();
  await numberPage.waitForFunction(() =>
    document.querySelector('#number-frame')?.contentDocument?.querySelector('#number-frame-text')?.textContent === 'IT:Framecount 22 IT:objects.',
    null, { timeout: 10000 });
  check((await numberPage.locator('#number-input').inputValue()) === 'IT:Inventory 8 IT:units.', 'input values reuse translations after a number changes');
  check(requests.length === beforeNumberRestart, 'restarting with changed input numbers reuses translation memory');
  await numberPage.close();
  check(errors.length === 0, `no page errors ${errors.join(' ')}`);
} finally {
  await ctx.close();
  server.close();
  frameServer.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
