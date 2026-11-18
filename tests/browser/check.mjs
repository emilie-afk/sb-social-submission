// Browser checks (Chromium via Playwright) against the real page and the real function
// handlers. External services (Google Sheets, Claude, Supadata/YouTube, Content
// Intelligence) are replaced by in-process fakes; durable state uses the test Blobs server.
// Run: npm run test:browser

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
// Playwright is used from the machine's installation (not a project dependency).
const { chromium } = createRequire(import.meta.url)('playwright');
import { startBlobs, setTestEnv, fakeSheets, fakeDashboard, fakeClaude, FAKE } from '../helpers.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const blobs = await startBlobs();
setTestEnv();

const sheets = fakeSheets();
const dash = fakeDashboard();
const claude = fakeClaude('{"rawText":"Screenshot caption: my echeveria is stretching","creatorName":"@succulent_fan"}');
const transcriptFetch = async (url) => {
  const u = new URL(url);
  if (u.hostname === 'api.supadata.ai') return Response.json({ content: [{ text: 'paid transcript text' }] });
  throw new Error('unexpected ' + url);
};
const ytFree = async () => [{ text: 'free youtube captions' }, { text: 'here' }];

const fns = {};
for (const name of ['auth', 'session', 'logout', 'save', 'analyze', 'extract-transcript']) {
  const mod = await import(`../../netlify/functions/${name}.mjs`);
  fns[name] = mod.createHandler({ sheets: sheets.factory, fetch: name === 'save' ? dash.fetchImpl : transcriptFetch, claude: claude.factory, youtubeTranscript: ytFree });
}

// Production headers from netlify.toml, applied to the page so CSP problems show up here.
const toml = readFileSync(`${ROOT}netlify.toml`, 'utf8');
const pageHeaders = {};
for (const m of toml.matchAll(/^\s+([A-Za-z-]+) = "(.*)"$/gm)) pageHeaders[m[1]] = m[2];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const m = /^\/\.netlify\/functions\/([a-z-]+)$/.exec(url.pathname);
  if (m && fns[m[1]]) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const request = new Request(`http://localhost:${server.address().port}${req.url}`, {
      method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const r = await fns[m[1]](request, { ip: '127.0.0.1', waitUntil: () => {} });
    const headers = {};
    r.headers.forEach((v, k) => { if (k !== 'set-cookie') headers[k] = v; });
    const cookies = r.headers.getSetCookie();
    if (cookies.length) headers['set-cookie'] = cookies;
    res.writeHead(r.status, headers);
    return res.end(Buffer.from(await r.arrayBuffer()));
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...pageHeaders });
    return res.end(readFileSync(`${ROOT}public/index.html`));
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://localhost:${server.address().port}/`;

// 64×64 PNG generated in the browser would also work; a fixed tiny PNG keeps it simple.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');

const results = [];
const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond, detail }); console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail && !cond ? ' — ' + detail : ''}`); };

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', (err) => consoleErrors.push(String(err)));
page.on('dialog', (d) => d.dismiss());
const visible = (sel) => page.isVisible(sel);
const statusText = () => page.textContent('#main-status');

try {
  // 1. A forged browser flag does not open the app, and is removed.
  await page.goto(BASE);
  await page.evaluate(() => localStorage.setItem('sb_auth_ok', JSON.stringify({ expires: Date.now() + 9e9 })));
  await page.reload();
  await page.waitForSelector('#password-gate', { state: 'visible' });
  check('browser auth flag does not unlock the app', !(await visible('#app')));
  check('legacy flag removed from localStorage', (await page.evaluate(() => localStorage.getItem('sb_auth_ok'))) === null);

  // 2. Login
  await page.fill('#gate-input', 'wrong-password');
  await page.click('#gate-btn');
  await page.waitForFunction(() => document.getElementById('gate-error').textContent.length > 0);
  check('wrong password shows an error', (await page.textContent('#gate-error')).includes('Incorrect'));
  await page.fill('#gate-input', FAKE.SITE_PASSWORD);
  await page.click('#gate-btn');
  await page.waitForSelector('#app', { state: 'visible' });
  check('correct password opens the app', true);
  const cookies = await context.cookies();
  const sc = cookies.find((c) => c.name === '__Host-sbs_session');
  check('session cookie is HttpOnly + Secure + SameSite=Strict', sc && sc.httpOnly && sc.secure && sc.sameSite === 'Strict', JSON.stringify(sc));
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  check('password and tokens not in browser storage', !stored.includes(FAKE.SITE_PASSWORD) && !/csrf|sbs_session/i.test(stored), stored);

  // 3. Session restore after reload
  await page.reload();
  await page.waitForSelector('#app', { state: 'visible' });
  check('session restored after reload', !(await visible('#password-gate')));

  // 4. Text submission
  await page.fill('#submitted-by', 'Tester');
  await page.click('#tab-text');
  await page.fill('#text-input', '=HYPERLINK("http://x") people asking about leggy echeveria\nsecond line');
  await page.fill('#text-url', 'https://www.facebook.com/groups/x/posts/1');
  await page.selectOption('#platform', 'Facebook');
  await page.click('#submit-btn');
  await page.waitForFunction(() => document.getElementById('main-status').className.includes('success'));
  check('text submission saved + delivered', sheets.state.rows.length === 1 && dash.state.calls.length === 1);
  check('formula-like text stored literally', sheets.state.rows[0][0].startsWith('=HYPERLINK(') && sheets.state.rows[0][0].includes('\nsecond line'));
  check('submitted-by attribution recorded', sheets.state.rows[0][6] === 'Tester');
  await page.waitForTimeout(2700); // form resets after success

  // 5. Screenshot transcription
  await page.setInputFiles('#photo-file', { name: 'shot.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForSelector('.thumb-img');
  await page.click('#extract-btn');
  await page.waitForSelector('#extracted-field', { state: 'visible' });
  check('screenshot text extracted', (await page.inputValue('#extracted-text')).includes('echeveria is stretching'));
  check('creator name auto-filled', (await page.inputValue('#creator-name')) === '@succulent_fan');
  check('Claude received a validated PNG', claude.state.calls.length === 1 && claude.state.calls[0].messages[0].content[0].source.media_type === 'image/png');
  await page.click('#submit-btn');
  await page.waitForFunction(() => document.getElementById('main-status').className.includes('success'));
  check('screenshot submission saved', sheets.state.rows.length === 2 && sheets.state.rows[1][3] === '@succulent_fan');
  await page.waitForTimeout(2700);

  // 6. Transcript extraction (YouTube, free path)
  await page.click('#tab-url');
  await page.fill('#url-input', 'https://youtu.be/dQw4w9WgXcQ');
  await page.click('#transcript-btn');
  await page.waitForSelector('#transcript-field', { state: 'visible' });
  check('YouTube transcript extracted', (await page.inputValue('#transcript-text')) === 'free youtube captions here');
  check('platform auto-selected', (await page.inputValue('#platform')) === 'YouTube');

  // 7. Partial failure → retry delivers only the signal
  dash.state.statuses.push(500);
  await page.click('#submit-btn');
  await page.waitForFunction(() => document.getElementById('submit-btn').textContent.includes('Retry dashboard'));
  check('partial delivery reported (not success)', /dashboard did not (receive|confirm)/.test(await statusText()) && sheets.state.rows.length === 3);
  check('sheet status shows error before retry', sheets.state.rows[2][4] === '❌ Error');
  await page.click('#submit-btn');
  await page.waitForFunction(() => document.getElementById('main-status').className.includes('success'));
  check('retry delivered without a duplicate row', sheets.state.rows.length === 3 && dash.state.calls.length === 4 && sheets.state.rows[2][4] === '✅ Sent');
  await page.waitForTimeout(2700);

  // 8. Double-click submit
  await page.click('#tab-text');
  await page.fill('#text-input', 'double click test');
  await page.dblclick('#submit-btn');
  await page.waitForFunction(() => document.getElementById('main-status').className.includes('success'));
  await page.waitForTimeout(500);
  check('double-click creates one row and one signal', sheets.state.rows.length === 4 && dash.state.calls.length === 5);
  await page.waitForTimeout(2300);

  // 9. Sheet outage keeps the entry and retry works
  sheets.state.failEnsure = 1;
  await page.click('#tab-text');
  await page.fill('#text-input', 'sheet outage test');
  await page.click('#submit-btn');
  await page.waitForFunction(() => document.getElementById('submit-btn').textContent.includes('Retry'));
  check('sheet outage keeps the entry in the form', (await page.inputValue('#text-input')) === 'sheet outage test');
  await page.click('#submit-btn');
  await page.waitForFunction(() => document.getElementById('main-status').className.includes('success'));
  check('retry after outage saved exactly once', sheets.state.rows.length === 5);
  await page.waitForTimeout(2700);

  // 10a. Failed sign-out is never reported as success (network error, 403, 503)
  for (const [label, handler] of [
    ['network error', (route) => route.abort('failed')],
    ['HTTP 403', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"Request refused.","code":"csrf"}' })],
    ['HTTP 503', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Service is temporarily unavailable."}' })],
  ]) {
    await page.route('**/.netlify/functions/logout', handler);
    await page.click('#signout-btn');
    await page.waitForFunction(() => document.getElementById('main-status').textContent.includes('Could not sign out'));
    const gateText = await page.textContent('#gate-error');
    check(`failed sign-out (${label}) is not shown as signed out`, (await visible('#app')) && !(await visible('#password-gate')) && !gateText.includes('Signed out'));
    await page.unroute('**/.netlify/functions/logout');
    await page.evaluate(() => hideStatus());
  }
  await page.reload();
  await page.waitForSelector('#app', { state: 'visible' });
  check('session still active after failed sign-outs (as reported)', !(await visible('#password-gate')));

  // 10. Logout and old-cookie reuse
  const before = (await context.cookies()).find((c) => c.name === '__Host-sbs_session');
  await page.click('#signout-btn');
  await page.waitForSelector('#password-gate', { state: 'visible' });
  check('confirmed sign-out returns to the password screen', !(await visible('#app')) && (await page.textContent('#gate-error')) === 'Signed out.');
  await page.reload();
  await page.waitForSelector('#password-gate', { state: 'visible' });
  check('still signed out after reload', !(await visible('#app')));
  await context.addCookies([before]);
  const replay = await page.evaluate(async () => (await fetch('/.netlify/functions/session')).status);
  check('old session cookie is rejected after logout', replay === 401);

  // 11. Session revoked server-side while the page is open
  await page.fill('#gate-input', FAKE.SITE_PASSWORD);
  await page.click('#gate-btn');
  await page.waitForSelector('#app', { state: 'visible' });
  const sid = /v1\.([A-Za-z0-9_-]{32})/.exec((await context.cookies()).find((c) => c.name === '__Host-sbs_session').value)[1];
  const { defaultStore } = await import('../../netlify/lib/store.mjs');
  await defaultStore().delete(`sessions/${sid}`);
  await page.click('#tab-text');
  await page.fill('#text-input', 'after revoke');
  await page.click('#submit-btn');
  await page.waitForSelector('#password-gate', { state: 'visible' });
  check('revoked session sends the user back to sign-in', (await page.textContent('#gate-error')).includes('session has ended') && sheets.state.rows.length === 5);

  const cspErrors = consoleErrors.filter((e) => /Content Security Policy|Refused to/i.test(e));
  check('no CSP violations', cspErrors.length === 0, cspErrors.join(' | '));
  const other = consoleErrors.filter((e) => !/status of 40[13]|status of 50[23]|Failed to load resource/.test(e) && !/Content Security Policy|Refused to/i.test(e));
  check('no page errors', other.length === 0, other.join(' | '));
  await page.screenshot({ path: `${ROOT}test-results/browser-final.png` }).catch(() => {});
} catch (err) {
  check('browser run completed', false, err.message);
} finally {
  await browser.close();
  server.close();
  await blobs.stop();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} browser checks passed`);
process.exit(failed ? 1 : 0);
