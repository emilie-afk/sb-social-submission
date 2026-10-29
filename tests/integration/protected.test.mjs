// Every protected endpoint × every unauthorised caller → refused, and no external service
// (Google, Claude, Supadata, YouTube, TikTok, Content Intelligence) is ever invoked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBlobs, setTestEnv, request, ctx, login, installNetworkTripwire, fakeSheets, fakeDashboard, fakeClaude, jpegB64, uuid } from '../helpers.mjs';
import { createHandler as authH } from '../../netlify/functions/auth.mjs';
import { createHandler as logoutH } from '../../netlify/functions/logout.mjs';
import { createHandler as saveH } from '../../netlify/functions/save.mjs';
import { createHandler as analyzeH } from '../../netlify/functions/analyze.mjs';
import { createHandler as transcriptH } from '../../netlify/functions/extract-transcript.mjs';
import { createHandler as sessionH } from '../../netlify/functions/session.mjs';

let blobs, trip;
before(async () => { blobs = await startBlobs(); trip = installNetworkTripwire(blobs.port); setTestEnv(); });
after(async () => { trip.restore(); await blobs.stop(); });

test('unauthorised callers never reach external services', async () => {
  const auth = authH();
  const live = await login(auth, '10.0.0.1');
  const revoked = await login(auth, '10.0.0.1');
  await logoutH()(request('logout', { cookie: revoked.cookie, csrf: revoked.csrf }));

  const sheets = fakeSheets(); const dash = fakeDashboard(); const claude = fakeClaude();
  const fetchSpy = { calls: 0 };
  const fetchImpl = async () => { fetchSpy.calls++; throw new Error('should not be called'); };
  const yt = { calls: 0 };
  const endpoints = {
    save: [saveH({ sheets: sheets.factory, fetch: dash.fetchImpl }), { submissionId: uuid(), rawInput: 'hello' }],
    analyze: [analyzeH({ claude: claude.factory }), { images: [{ base64: jpegB64(), mimeType: 'image/jpeg' }] }],
    'extract-transcript': [transcriptH({ fetch: fetchImpl, youtubeTranscript: async () => { yt.calls++; return []; } }), { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }],
  };
  const callers = {
    anonymous: {},
    browserFlagOnly: { cookie: 'sb_auth_ok={"expires":99999999999999}' },
    garbageCookie: { cookie: '__Host-sbs_session=v1.x.y.z' },
    revokedSession: { cookie: revoked.cookie, csrf: revoked.csrf },
    validCookieNoCsrf: { cookie: live.cookie },
    validCookieCrossSite: { cookie: live.cookie, csrf: live.csrf, origin: 'https://attacker.example' },
    csrfWithoutCookie: { csrf: live.csrf },
  };
  for (const [name, [handler, body]] of Object.entries(endpoints)) {
    for (const [who, opts] of Object.entries(callers)) {
      const r = await handler(request(name, { body, ...opts }), ctx());
      assert.ok([401, 403].includes(r.status), `${name} / ${who} → ${r.status}`);
      const text = await r.text();
      assert.ok(!/stack|Error:|at \//.test(text), 'no internals in response');
    }
    // Wrong method
    const g = await handler(request(name, { method: 'GET', cookie: live.cookie }), ctx());
    assert.equal(g.status, 405);
  }
  assert.equal(sheets.state.appendCalls + sheets.state.ensureCalls + sheets.state.findCalls, 0, 'Google not called');
  assert.equal(dash.state.calls.length, 0, 'dashboard not called');
  assert.equal(claude.state.calls.length + claude.state.keys.length, 0, 'Claude not called');
  assert.equal(fetchSpy.calls + yt.calls, 0, 'transcript providers not called');
  assert.deepEqual(trip.calls, [], 'no network at all');
});

test('session endpoint does not authorise via any client-supplied flag or header', async () => {
  const session = sessionH();
  for (const headers of [{ 'x-authenticated': 'true' }, { authorization: 'Bearer ' + 'a'.repeat(40) }, { 'x-role': 'admin' }]) {
    const r = await session(request('session', { method: 'GET', headers }));
    assert.equal(r.status, 401);
  }
});
