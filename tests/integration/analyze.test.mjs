import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBlobs, setTestEnv, request, ctx, login, installNetworkTripwire, fakeClaude, jpegB64, pngB64 } from '../helpers.mjs';
import { createHandler as authH } from '../../netlify/functions/auth.mjs';
import { createHandler as analyzeH, SYSTEM_PROMPT, parseModelOutput } from '../../netlify/functions/analyze.mjs';
import { LIMITS } from '../../netlify/lib/limits.mjs';

let blobs, trip, s;
before(async () => { blobs = await startBlobs(); trip = installNetworkTripwire(blobs.port); setTestEnv(); s = await login(authH(), '10.1.0.1'); });
after(async () => { trip.restore(); await blobs.stop(); });

const call = (h, body, raw) => h(request('analyze', { body, raw, cookie: s.cookie, csrf: s.csrf }), ctx());

test('valid screenshots are transcribed; images go to Claude with an untrusted-content system prompt', async () => {
  const claude = fakeClaude();
  const h = analyzeH({ claude: claude.factory });
  const r = await call(h, { images: [{ base64: jpegB64(), mimeType: 'image/jpeg' }, { base64: pngB64(), mimeType: 'image/png' }] });
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.deepEqual(b, { success: true, rawText: 'hello', creatorName: '@maker' });
  const args = claude.state.calls[0];
  assert.equal(args.system, SYSTEM_PROMPT);
  assert.match(args.system, /untrusted/);
  assert.equal(args.messages[0].content.filter((c) => c.type === 'image').length, 2);
});

test('oversized, malformed or mislabelled payloads are rejected before any Claude call', async () => {
  const claude = fakeClaude();
  const h = analyzeH({ claude: claude.factory });
  const bad = [
    {},
    { images: [] },
    { images: Array.from({ length: 11 }, () => ({ base64: jpegB64(), mimeType: 'image/jpeg' })) },
    { images: [{ base64: jpegB64(), mimeType: 'image/svg+xml' }] },
    { images: [{ base64: jpegB64(), mimeType: 'application/pdf' }] },
    { images: [{ base64: 'not base64 !!', mimeType: 'image/jpeg' }] },
    { images: [{ base64: pngB64(), mimeType: 'image/jpeg' }] },          // magic bytes mismatch
    { images: [{ base64: 'AAAA', mimeType: 'image/jpeg' }] },            // too small
    { images: [{ base64: jpegB64(3_600_000), mimeType: 'image/jpeg' }] }, // > 3.5 MB decoded
    { images: [{ base64: jpegB64(2_200_000), mimeType: 'image/jpeg' }, { base64: jpegB64(2_200_000), mimeType: 'image/jpeg' }] }, // total > 4.3 MB
  ];
  for (const [i, body] of bad.entries()) {
    const r = await call(h, body);
    assert.equal(r.status, 400, 'case ' + i);
  }
  const huge = await call(h, null, JSON.stringify({ images: [{ base64: 'A'.repeat(6_000_000), mimeType: 'image/jpeg' }] }));
  assert.equal(huge.status, 413);
  const notJson = await call(h, null, '{bad json');
  assert.equal(notJson.status, 400);
  assert.equal(claude.state.calls.length, 0);
});

test('provider errors return a generic message without provider details or the key', async () => {
  const h = analyzeH({ claude: () => ({ messages: { create: async () => { const e = new Error('401 invalid x-api-key sk-ant-test-FAKEKEY-1234567890'); e.status = 401; throw e; } } }) });
  const r = await call(h, { images: [{ base64: jpegB64(), mimeType: 'image/jpeg' }] });
  assert.equal(r.status, 502);
  const t = await r.text();
  assert.ok(!t.includes('FAKEKEY') && !t.includes('x-api-key'));
});

test('missing CLAUDE_API_KEY → 503 before any call', async () => {
  setTestEnv({ CLAUDE_API_KEY: null });
  const claude = fakeClaude();
  const r = await call(analyzeH({ claude: claude.factory }), { images: [{ base64: jpegB64(), mimeType: 'image/jpeg' }] });
  assert.equal(r.status, 503);
  assert.equal(claude.state.calls.length, 0);
  setTestEnv();
});

test('model output is parsed defensively and capped', () => {
  assert.deepEqual(parseModelOutput('```json\n{"rawText":"a\\u0000b","creatorName":"x\\ny"}\n```'), { rawText: 'ab', creatorName: 'x y' });
  assert.deepEqual(parseModelOutput('plain text'), { rawText: 'plain text', creatorName: null });
  assert.equal(parseModelOutput(JSON.stringify({ rawText: 'z'.repeat(50000) })).rawText.length, 40000);
});

test('durable per-session limit stops paid calls', async () => {
  const claude = fakeClaude();
  const h = analyzeH({ claude: claude.factory });
  const s2 = await login(authH(), '10.1.0.2');
  let last;
  for (let i = 0; i <= LIMITS.analyzePerSession.limit; i++) {
    last = await h(request('analyze', { body: { images: [{ base64: jpegB64(), mimeType: 'image/jpeg' }] }, cookie: s2.cookie, csrf: s2.csrf }), ctx());
  }
  assert.equal(last.status, 429);
  assert.equal(claude.state.calls.length, LIMITS.analyzePerSession.limit);
  assert.deepEqual(trip.calls, []);
});
