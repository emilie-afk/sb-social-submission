// Credentials and private source locations never appear in responses, logs, or files
// that are published (public/) or committed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBlobs, setTestEnv, request, ctx, login, installNetworkTripwire, fakeDashboard, jpegB64, uuid, FAKE } from '../helpers.mjs';
import { createHandler as authH } from '../../netlify/functions/auth.mjs';
import { createHandler as saveH } from '../../netlify/functions/save.mjs';
import { createHandler as analyzeH } from '../../netlify/functions/analyze.mjs';
import { createHandler as transcriptH } from '../../netlify/functions/extract-transcript.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SECRETS = [FAKE.SITE_PASSWORD, FAKE.SESSION_SIGNING_SECRET, FAKE.CLAUDE_API_KEY, FAKE.SUPADATA_API_KEY, FAKE.SUBMIT_TOKEN, FAKE.GOOGLE_SHEET_ID, FAKE.SA_EMAIL, 'FAKEKEYMATERIAL'];

let blobs, trip;
const logs = [];
const orig = {};
before(async () => {
  blobs = await startBlobs(); trip = installNetworkTripwire(blobs.port); setTestEnv();
  for (const k of ['log', 'warn', 'error', 'info']) { orig[k] = console[k]; console[k] = (...a) => logs.push(a.map(String).join(' ')); }
});
after(async () => { for (const k of Object.keys(orig)) console[k] = orig[k]; trip.restore(); await blobs.stop(); });

test('error paths leak no secrets into responses or logs', async () => {
  const s = await login(authH(), '10.9.0.1');
  const opts = (body) => ({ body, cookie: s.cookie, csrf: s.csrf });
  const bodies = [];
  const leakyErr = () => Object.assign(new Error(`request to sheets/${FAKE.GOOGLE_SHEET_ID} as ${FAKE.SA_EMAIL} failed`), { code: 403 });
  const sheets = () => ({ ensureIntake: async () => { throw leakyErr(); }, appendRow: async () => { throw leakyErr(); }, findRowById: async () => null, setStatus: async () => {} });
  const r1 = await saveH({ sheets })(request('save', opts({ submissionId: uuid(), rawInput: 'x' })), ctx());
  bodies.push(await r1.text());
  const okSheets = () => ({ ensureIntake: async () => {}, appendRow: async () => 2, findRowById: async () => null, setStatus: async () => {} });
  const r2 = await saveH({ sheets: okSheets, fetch: fakeDashboard({ statuses: [401] }).fetchImpl })(request('save', opts({ submissionId: uuid(), rawInput: 'y' })), ctx());
  bodies.push(await r2.text());
  const r3 = await analyzeH({ claude: () => ({ messages: { create: async () => { throw new Error('bad key ' + FAKE.CLAUDE_API_KEY); } } }) })(request('analyze', opts({ images: [{ base64: jpegB64(), mimeType: 'image/jpeg' }] })), ctx());
  bodies.push(await r3.text());
  const r4 = await transcriptH({ fetch: async () => { throw new Error('supadata key ' + FAKE.SUPADATA_API_KEY); }, youtubeTranscript: async () => { throw new Error('x'); } })(request('extract-transcript', opts({ url: 'https://www.instagram.com/reel/LEAK1/' })), ctx());
  bodies.push(await r4.text());
  const bad = await authH()(request('auth', { body: { password: 'wrong ' + FAKE.SITE_PASSWORD.slice(0, 4) } }), ctx('10.9.0.2'));
  bodies.push(await bad.text());

  const all = bodies.join('\n') + '\n' + logs.join('\n');
  for (const secret of SECRETS) assert.ok(!all.includes(secret), 'leaked: ' + secret.slice(0, 6));
  assert.ok(!/at .*\.mjs:\d+/.test(all), 'no stack traces');
  assert.ok(logs.length > 0, 'logs were captured');
});

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', '.netlify', '.build'].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

test('repository files contain no credentials or private sheet/script locations', () => {
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----(?!\\nFAKE)/,
    /sk-ant-(?!test-FAKE)[A-Za-z0-9_-]{10,}/,
    /docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]{20,}/,
    /script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}/,
    /"private_key"\s*:\s*"-----BEGIN/,
    /[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com/,
  ];
  for (const file of walk(ROOT)) {
    if (file.endsWith('.png') || file.endsWith('.jpg')) continue;
    const text = readFileSync(file, 'utf8');
    for (const re of patterns) {
      const m = text.match(re);
      if (m && file.includes(`${'tests'}`) && /FAKE|fake-project/.test(m[0] + text.slice(text.indexOf(m[0]), text.indexOf(m[0]) + 80))) continue;
      assert.equal(m, null, `${file.slice(ROOT.length)} matches ${re}`);
    }
  }
});

test('the published page carries no secrets or env-var values and no auth flag', () => {
  const page = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
  for (const name of ['CLAUDE_API_KEY', 'SUPADATA_API_KEY', 'SUBMIT_TOKEN', 'GOOGLE_SHEET_ID', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'SESSION_SIGNING_SECRET', 'SITE_PASSWORD']) {
    assert.ok(!page.includes(name), name);
  }
  assert.ok(!/localStorage\.setItem\([^)]*auth/i.test(page), 'no auth flag in localStorage');
  assert.ok(!/localStorage\.setItem\([^)]*(password|csrf)/i.test(page));
});
