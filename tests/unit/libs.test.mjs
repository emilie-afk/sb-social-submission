import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUserUrl, canonicalize, validateSourceUrl } from '../../netlify/lib/urls.mjs';
import { cleanText, singleLine } from '../../netlify/lib/text.mjs';
import { createStore, StoreError } from '../../netlify/lib/store.mjs';
import { parseCookies, passwordMatches, sameOrigin } from '../../netlify/lib/session.mjs';
import { authConfig, dashboardEndpoint } from '../../netlify/lib/config.mjs';
import { redact } from '../../netlify/lib/log.mjs';

const canon = (u) => canonicalize(parseUserUrl(u).url);

test('canonical platform URLs are rebuilt from validated parts', () => {
  assert.equal(canon('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=x').canonical, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(canon('http://youtu.be/dQw4w9WgXcQ').canonical, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(canon('https://youtube.com/shorts/dQw4w9WgXcQ').isShorts, true);
  assert.equal(canon('https://WWW.TikTok.com./@a.b/video/123?lang=en').canonical, 'https://www.tiktok.com/@a.b/video/123');
  assert.equal(canon('https://instagram.com/reel/AbC_1-2/').canonical, 'https://www.instagram.com/reel/AbC_1-2/');
  assert.equal(canon('https://notyoutube.com/watch?v=dQw4w9WgXcQ').platform, 'unknown');
  assert.equal(canon('https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ').platform, 'unknown');
});

test('source URL validation', () => {
  assert.deepEqual(validateSourceUrl(''), { ok: true, value: '' });
  assert.equal(validateSourceUrl('https://example.com/a b').ok, true);
  assert.equal(validateSourceUrl('data:text/html,hi').ok, false);
  assert.equal(validateSourceUrl('https://a:b@example.com').ok, false);
  assert.equal(validateSourceUrl('http://192.168.1.1/').ok, false);
  assert.equal(validateSourceUrl('https://www.facebook.com/groups/x').ok, true);
});

test('text cleaning keeps Unicode and newlines, drops control chars', () => {
  assert.equal(cleanText('a\r\nb\u0000c\u0007 🌵 é'), 'a\nbc 🌵 é');
  assert.equal(singleLine(' a \n b '), 'a b');
  assert.equal(cleanText('x'.repeat(10), 4), 'xxxx');
});

test('store refuses a replace without an ETag (would be an unconditional write)', async () => {
  const raw = { setJSON: async () => ({ modified: true, etag: '"e"' }), getWithMetadata: async () => ({ data: { n: 1 }, etag: undefined }) };
  const store = createStore(raw);
  await assert.rejects(store.replace('k', {}, undefined), StoreError);
  await assert.rejects(store.update('k', (c) => ({ n: c.n + 1 })), StoreError);
});

test('store errors fail closed as StoreError', async () => {
  const store = createStore({ getWithMetadata: async () => { throw new Error('boom'); } });
  await assert.rejects(store.get('k'), StoreError);
});

test('cookies, password compare, origin checks', () => {
  assert.deepEqual(parseCookies('a=1; __Host-sbs_session=v1.x; a=2'), { a: '1', '__Host-sbs_session': 'v1.x' });
  const cfg = { password: 'correct horse', signingSecret: 'x'.repeat(40), epoch: '0' };
  assert.equal(passwordMatches('correct horse', cfg), true);
  assert.equal(passwordMatches('correct hors', cfg), false);
  assert.equal(passwordMatches('x'.repeat(300), cfg), false);
  assert.equal(passwordMatches(undefined, cfg), false);
  const mk = (h) => new Request('https://intake.test/x', { method: 'POST', headers: h });
  assert.equal(sameOrigin(mk({ origin: 'https://intake.test' })), true);
  assert.equal(sameOrigin(mk({})), true);
  assert.equal(sameOrigin(mk({ origin: 'https://intake.test.evil.com' })), false);
  assert.equal(sameOrigin(mk({ origin: 'null' })), false);
  assert.equal(sameOrigin(mk({ 'sec-fetch-site': 'same-site' })), false);
});

test('auth config fails closed', () => {
  assert.equal(authConfig({}), null);
  assert.equal(authConfig({ SITE_PASSWORD: 'longenough', SESSION_SIGNING_SECRET: 'short' }), null);
  assert.ok(authConfig({ SITE_PASSWORD: 'longenough', SESSION_SIGNING_SECRET: 'z'.repeat(32) }));
  assert.equal(authConfig({ SITE_PASSWORD: 'short', SESSION_SIGNING_SECRET: 'z'.repeat(32) }), null);
  assert.equal(dashboardEndpoint({}), 'https://sb-content-intelligence.netlify.app/.netlify/functions/submit-signal');
});

test('log redaction removes configured secrets', () => {
  process.env.SUBMIT_TOKEN = 'redact-me-token-123456';
  assert.equal(redact('x redact-me-token-123456 y'), 'x [redacted] y');
  delete process.env.SUBMIT_TOKEN;
});
