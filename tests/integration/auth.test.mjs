import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { startBlobs, setTestEnv, request, ctx, login, cookieFrom, FAKE, installNetworkTripwire } from '../helpers.mjs';
import { createHandler as authH } from '../../netlify/functions/auth.mjs';
import { createHandler as sessionH } from '../../netlify/functions/session.mjs';
import { createHandler as logoutH } from '../../netlify/functions/logout.mjs';
import { createHandler as saveH } from '../../netlify/functions/save.mjs';
import { defaultStore } from '../../netlify/lib/store.mjs';
import { SESSION_TTL_MS } from '../../netlify/lib/session.mjs';
import { fakeSheets, fakeDashboard, uuid } from '../helpers.mjs';

let blobs, trip;
before(async () => { blobs = await startBlobs(); trip = installNetworkTripwire(blobs.port); setTestEnv(); });
after(async () => { trip.restore(); await blobs.stop(); });

const auth = authH();
const session = sessionH();
const logout = logoutH();

test('login sets a Secure HttpOnly SameSite=Strict __Host- cookie and never returns the password', async () => {
  const res = await auth(request('auth', { body: { password: FAKE.SITE_PASSWORD } }), ctx('198.51.100.1'));
  assert.equal(res.status, 200);
  const sc = res.headers.get('set-cookie');
  assert.match(sc, /^__Host-sbs_session=v1\./);
  for (const attr of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) assert.ok(sc.includes(attr), attr);
  const text = await res.text();
  assert.ok(!text.includes(FAKE.SITE_PASSWORD));
  assert.ok(!sc.includes(FAKE.SITE_PASSWORD));
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('wrong password → 401; session endpoint restores a valid session', async () => {
  const bad = await auth(request('auth', { body: { password: 'nope-nope' } }), ctx('198.51.100.2'));
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get('set-cookie'), null);
  const s = await login(auth, '198.51.100.2');
  const r = await session(request('session', { method: 'GET', cookie: s.cookie }));
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.authenticated, true);
  assert.equal(b.csrfToken, s.csrf);
});

test('missing, malformed, forged and tampered sessions are rejected', async () => {
  const s = await login(auth, '198.51.100.3');
  const variants = {
    missing: undefined,
    malformed: '__Host-sbs_session=hello',
    browserFlag: 'sb_auth_ok={"expires":99999999999999}',
    forged: (() => {
      const sid = 'A'.repeat(32); const exp = Date.now() + 1000;
      const sig = createHmac('sha256', 'wrong-secret-wrong-secret-wrong-secret').update(`v1.${sid}.${exp}`).digest('base64url');
      return `__Host-sbs_session=v1.${sid}.${exp}.${sig}`;
    })(),
    extendedExpiry: s.cookie.replace(/\.(\d{13})\./, (m, e) => `.${Number(e) + 1000}.`),
    otherSid: s.cookie.replace(/v1\.([A-Za-z0-9_-]{32})/, 'v1.' + 'B'.repeat(32)),
  };
  for (const [name, cookie] of Object.entries(variants)) {
    const r = await session(request('session', { method: 'GET', cookie }));
    assert.equal(r.status, 401, name);
  }
});

test('a correctly signed but expired session is rejected server-side (not only by cookie expiry)', async () => {
  const s = await login(auth, '198.51.100.4');
  const later = sessionH({});
  // Re-sign nothing: just move the clock past expiry by verifying with a future "now".
  const { verifySession } = await import('../../netlify/lib/session.mjs');
  const req = request('session', { method: 'GET', cookie: s.cookie });
  const v = await verifySession(req, defaultStore(), s.expiresAt + 1);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'expired');
  assert.ok(later);
  // And a record whose server-side expiry passed is refused even if the cookie claims longer.
  const sid = /v1\.([A-Za-z0-9_-]{32})/.exec(s.cookie)[1];
  await defaultStore().update(`sessions/${sid}`, (cur) => ({ ...cur, exp: Date.now() - 1 }));
  const r = await session(request('session', { method: 'GET', cookie: s.cookie }));
  assert.equal(r.status, 401);
  assert.ok(SESSION_TTL_MS > 0);
});

test('logout revokes the session server-side: the old cookie no longer works', async () => {
  const s = await login(auth, '198.51.100.5');
  const out = await logout(request('logout', { cookie: s.cookie, csrf: s.csrf }));
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  const r = await session(request('session', { method: 'GET', cookie: s.cookie }));
  assert.equal(r.status, 401);
});

test('logout without CSRF token is refused (and does not revoke)', async () => {
  const s = await login(auth, '198.51.100.6');
  const out = await logout(request('logout', { cookie: s.cookie }));
  assert.equal(out.status, 403);
  const r = await session(request('session', { method: 'GET', cookie: s.cookie }));
  assert.equal(r.status, 200);
});

test('changing SESSION_EPOCH, the signing secret or the password invalidates every session', async () => {
  const s = await login(auth, '198.51.100.7');
  for (const change of [{ SESSION_EPOCH: '2' }, { SESSION_SIGNING_SECRET: 'another-signing-secret-0123456789abcdef' }, { SITE_PASSWORD: 'a-new-team-password' }]) {
    setTestEnv(change);
    const r = await session(request('session', { method: 'GET', cookie: s.cookie }));
    assert.equal(r.status, 401, JSON.stringify(Object.keys(change)));
    setTestEnv();
  }
  const ok = await session(request('session', { method: 'GET', cookie: s.cookie }));
  assert.equal(ok.status, 200);
});

test('missing or unsafe security configuration denies access', async () => {
  const s = await login(auth, '198.51.100.8');
  const cases = [
    { SITE_PASSWORD: null },
    { SESSION_SIGNING_SECRET: null },
    { SESSION_SIGNING_SECRET: 'short' },
    { SESSION_SIGNING_SECRET: FAKE.SITE_PASSWORD + 'x'.repeat(32) }, // contains the password
  ];
  for (const c of cases) {
    setTestEnv(c);
    const l = await auth(request('auth', { body: { password: FAKE.SITE_PASSWORD } }), ctx('198.51.100.8'));
    assert.equal(l.status, 503, 'login ' + JSON.stringify(c));
    const r = await session(request('session', { method: 'GET', cookie: s.cookie }));
    assert.equal(r.status, 503, 'session ' + JSON.stringify(c));
    setTestEnv();
  }
});

test('CSRF: cross-site origin, missing/wrong token and non-JSON bodies are refused before any work', async () => {
  const s = await login(auth, '198.51.100.9');
  const sheets = fakeSheets(); const dash = fakeDashboard();
  const save = saveH({ sheets: sheets.factory, fetch: dash.fetchImpl });
  const body = { submissionId: uuid(), rawInput: 'x' };
  const cases = [
    request('save', { body, cookie: s.cookie, csrf: s.csrf, origin: 'https://evil.example' }),
    request('save', { body, cookie: s.cookie, csrf: s.csrf, headers: { 'sec-fetch-site': 'cross-site' } }),
    request('save', { body, cookie: s.cookie }),
    request('save', { body, cookie: s.cookie, csrf: 'A'.repeat(43) }),
    request('save', { body, cookie: s.cookie, csrf: s.csrf, headers: { 'content-type': 'text/plain' } }),
  ];
  const expected = [403, 403, 403, 403, 415];
  for (let i = 0; i < cases.length; i++) {
    const r = await save(cases[i], ctx());
    assert.equal(r.status, expected[i], 'case ' + i);
  }
  assert.equal(sheets.state.appendCalls, 0);
  assert.equal(dash.state.calls.length, 0);
});

test('login is refused from a cross-site origin', async () => {
  const r = await auth(request('auth', { body: { password: FAKE.SITE_PASSWORD }, origin: 'https://evil.example' }), ctx('198.51.100.10'));
  assert.equal(r.status, 403);
});

test('login attempt limit: after 8 failures from one IP even the right password is refused', async () => {
  const ip = '192.0.2.77';
  for (let i = 0; i < 8; i++) {
    const r = await auth(request('auth', { body: { password: 'wrong-' + i } }), ctx(ip));
    assert.equal(r.status, 401);
  }
  const locked = await auth(request('auth', { body: { password: FAKE.SITE_PASSWORD } }), ctx(ip));
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  // Another IP is unaffected.
  const other = await auth(request('auth', { body: { password: FAKE.SITE_PASSWORD } }), ctx('192.0.2.78'));
  assert.equal(other.status, 200);
});

test('rate-limit keys do not contain raw IP addresses', async () => {
  const keys = await defaultStore().list('rl/');
  assert.ok(keys.length > 0);
  for (const k of keys) assert.ok(!k.includes('192.0.2.77'));
  assert.ok(createHash);
});

test('no outbound network calls were made by auth flows', () => {
  assert.deepEqual(trip.calls, []);
  assert.ok(cookieFrom);
});

test('parallel burst of wrong passwords cannot exceed the per-IP limit', async () => {
  const ip = '192.0.2.200';
  const checked = { n: 0 };
  const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => auth(request('auth', { body: { password: 'burst-' + i } }), ctx(ip))));
  const statuses = rs.map((r) => r.status);
  checked.n = statuses.filter((x) => x === 401).length;
  assert.ok(checked.n <= 8, 'password comparisons: ' + checked.n);
  assert.ok(statuses.every((x) => x === 401 || x === 429 || x === 503), String(statuses));
});

test('IPv6 clients are limited per /64 prefix', async () => {
  const { ipScope } = await import('../../netlify/lib/limits.mjs');
  assert.equal(ipScope('2001:db8:1:2:aaaa::1'), ipScope('2001:db8:1:2:bbbb:cccc:dddd:eeee'));
  assert.notEqual(ipScope('2001:db8:1:2::1'), ipScope('2001:db8:1:3::1'));
  assert.equal(ipScope('203.0.113.5'), '203.0.113.5');
  assert.equal(ipScope('::ffff:203.0.113.5'), '203.0.113.5');
  assert.notEqual(ipScope('::ffff:203.0.113.5'), ipScope('::ffff:198.51.100.9'));
});

test('a correct password does not use up the failure budget', async () => {
  const ip = '192.0.2.201';
  for (let i = 0; i < 12; i++) await login(auth, ip);
  const r = await auth(request('auth', { body: { password: 'wrong' } }), ctx(ip));
  assert.equal(r.status, 401);
});
