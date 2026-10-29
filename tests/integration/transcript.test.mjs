import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBlobs, setTestEnv, request, ctx, login, installNetworkTripwire, FAKE } from '../helpers.mjs';
import { createHandler as authH } from '../../netlify/functions/auth.mjs';
import { createHandler as transcriptH } from '../../netlify/functions/extract-transcript.mjs';
import { guardedFetch } from '../../netlify/lib/urls.mjs';
import { LIMITS } from '../../netlify/lib/limits.mjs';

let blobs, trip, s;
before(async () => { blobs = await startBlobs(); trip = installNetworkTripwire(blobs.port); setTestEnv(); s = await login(authH(), '10.2.0.1'); });
after(async () => { trip.restore(); await blobs.stop(); });

function providers({ supadata = 'Spoken words here', oembed = { title: 'A caption', author_name: 'maker' }, ytSegments = null } = {}) {
  const calls = { supadata: [], oembed: [], yt: 0, other: [] };
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    if (u.hostname === 'api.supadata.ai') {
      calls.supadata.push({ url, key: init.headers['x-api-key'] });
      if (supadata === 'redirect') return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
      if (supadata === 500) return new Response('{"error":"internal"}', { status: 500 });
      if (supadata === 202) return new Response('{"jobId":"j1"}', { status: 202 });
      return supadata ? Response.json({ content: [{ text: supadata }] }) : new Response('{}', { status: 404 });
    }
    if (u.hostname === 'www.tiktok.com' && u.pathname === '/oembed') {
      calls.oembed.push(url);
      return oembed ? Response.json(oembed) : new Response('', { status: 404 });
    }
    calls.other.push(url);
    throw new Error('unexpected fetch ' + url);
  };
  const youtubeTranscript = async () => { calls.yt++; if (ytSegments) return ytSegments; throw new Error('no captions'); };
  return { calls, h: transcriptH({ fetch: fetchImpl, youtubeTranscript }) };
}
const call = (h, url, sess = s) => h(request('extract-transcript', { body: { url }, cookie: sess.cookie, csrf: sess.csrf }), ctx());

test('unsafe or invalid URLs are rejected with no provider call', async () => {
  const p = providers();
  const bad = [
    'not a url', 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://youtube.com/watch?v=dQw4w9WgXcQ',
    'https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=short', 'https://www.tiktok.com/', 'https://www.instagram.com/p/<script>/',
    'https://www.youtube.com/watch?v=' + 'a'.repeat(3000),
  ];
  for (const u of bad) {
    const r = await call(p.h, u);
    assert.equal(r.status, 400, u);
  }
  // Look-alike / private / metadata hosts are "unsupported", never fetched.
  for (const u of ['https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ', 'https://evilyoutube.com/watch?v=dQw4w9WgXcQ',
    'https://www.tiktok.com.attacker.net/@a/video/1', 'http://localhost/x', 'http://127.0.0.1/x', 'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.5/admin', 'http://[::1]/', 'https://metadata.google.internal/']) {
    const r = await call(p.h, u);
    const b = await r.json();
    assert.equal(r.status, 200, u);
    assert.equal(b.success, false);
    assert.equal(b.platform, 'unknown');
  }
  assert.equal(p.calls.supadata.length + p.calls.oembed.length + p.calls.yt + p.calls.other.length, 0);
});

test('YouTube: free captions first; supadata receives only the canonical URL', async () => {
  const free = providers({ ytSegments: [{ text: 'hello ' }, { text: ' world' }] });
  const r = await call(free.h, 'https://youtu.be/dQw4w9WgXcQ?si=tracking');
  const b = await r.json();
  assert.equal(b.success, true); assert.equal(b.source, 'free'); assert.equal(b.transcript, 'hello world');
  assert.equal(free.calls.supadata.length, 0);

  const paid = providers();
  const r2 = await call(paid.h, 'https://m.youtube.com/shorts/aaaaaaaaaaa?feature=share');
  const b2 = await r2.json();
  assert.equal(b2.source, 'supadata');
  assert.equal(decodeURIComponent(new URL(paid.calls.supadata[0].url).searchParams.get('url')), 'https://www.youtube.com/shorts/aaaaaaaaaaa');
  assert.equal(paid.calls.supadata[0].key, FAKE.SUPADATA_API_KEY);
  assert.ok(!JSON.stringify(b2).includes(FAKE.SUPADATA_API_KEY));
});

test('repeat requests for the same video are served from cache — no second paid call', async () => {
  const p = providers();
  const url = 'https://www.instagram.com/reel/ABC123xyz/';
  const a = await (await call(p.h, url)).json();
  const b = await (await call(p.h, url + '?igsh=zzz')).json();
  assert.equal(a.transcript, 'Spoken words here');
  assert.equal(b.cached, true);
  assert.equal(p.calls.supadata.length, 1);
});

test('concurrent requests for one video make a single paid call', async () => {
  const p = providers();
  const url = 'https://www.tiktok.com/@maker/video/7300000000000000001';
  const rs = await Promise.all([call(p.h, url), call(p.h, url), call(p.h, url)]);
  const statuses = rs.map((r) => r.status).sort();
  assert.ok(statuses.includes(200));
  assert.ok(p.calls.supadata.length === 1, 'paid calls: ' + p.calls.supadata.length);
});

test('TikTok falls back to the oEmbed caption; provider redirects are not followed', async () => {
  const p = providers({ supadata: 'redirect' });
  const r = await call(p.h, 'https://vm.tiktok.com/ZMabc123/');
  const b = await r.json();
  assert.equal(b.success, true);
  assert.match(b.transcript, /Caption: A caption/);
  assert.equal(p.calls.other.length, 0, 'redirect target never fetched');
});

test('guardedFetch re-checks every redirect hop against the allow-list', async () => {
  const seen = [];
  const fetchImpl = async (url) => { seen.push(url); return new Response('', { status: 301, headers: { location: 'http://127.0.0.1:8080/' } }); };
  await assert.rejects(guardedFetch('https://www.tiktok.com/oembed?url=x', { allowedHosts: ['www.tiktok.com'], timeoutMs: 1000, fetchImpl }), /blocked_destination/);
  assert.equal(seen.length, 1);
  const big = async () => new Response('x'.repeat(5000));
  await assert.rejects(guardedFetch('https://www.tiktok.com/a', { allowedHosts: ['www.tiktok.com'], timeoutMs: 1000, maxBytes: 100, fetchImpl: big }), /response_too_large/);
});

test('paid (Supadata) calls have their own durable per-session limit', async () => {
  const p = providers();
  const s2 = await login(authH(), '10.2.0.2');
  let limitedNote = null;
  for (let i = 0; i < LIMITS.supadataPerSession.limit + 2; i++) {
    const r = await call(p.h, `https://www.instagram.com/reel/LIMIT${i}/`, s2);
    const b = await r.json();
    if (!b.success) limitedNote = b.note;
  }
  assert.equal(p.calls.supadata.length, LIMITS.supadataPerSession.limit);
  assert.match(limitedNote, /limit/i);
});

test('without SUPADATA_API_KEY only free sources are used', async () => {
  setTestEnv({ SUPADATA_API_KEY: null });
  const p = providers();
  const r = await call(p.h, 'https://www.instagram.com/reel/NOKEY1/');
  const b = await r.json();
  assert.equal(b.success, false);
  assert.equal(p.calls.supadata.length, 0);
  setTestEnv();
  assert.deepEqual(trip.calls, []);
});

test('provider errors are not cached as "no transcript"', async () => {
  for (const status of [500]) {
    const p = providers({ supadata: status });
    const url = `https://www.instagram.com/reel/TRANSIENT${status}/`;
    const a = await (await call(p.h, url)).json();
    assert.equal(a.success, false);
    assert.match(a.note, status === 202 ? /still being generated/ : /did not respond/);
    const ok = providers();
    const b = await (await call(ok.h, url)).json();
    assert.equal(b.success, true, 'second attempt reaches the provider again');
    assert.equal(ok.calls.supadata.length, 1);
  }
});

test('long videos: a Supadata job is polled (free) on later requests instead of starting new paid jobs', async () => {
  let starts = 0; let polls = 0; let ready = false;
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/v1/transcript') { starts++; return new Response('{"jobId":"job_123"}', { status: 202 }); }
    if (u.pathname === '/v1/transcript/job_123') {
      polls++;
      return Response.json(ready ? { status: 'completed', content: [{ text: 'long video words' }] } : { status: 'active' });
    }
    throw new Error('unexpected ' + url);
  };
  const h = transcriptH({ fetch: fetchImpl, youtubeTranscript: async () => { throw new Error('none'); } });
  const url = 'https://www.instagram.com/reel/LONGVIDEO1/';
  const a = await (await call(h, url)).json();
  assert.equal(a.success, false);
  assert.match(a.note, /still being generated/);
  const b = await (await call(h, url)).json();
  assert.equal(b.success, false);
  ready = true;
  const c = await (await call(h, url)).json();
  assert.equal(c.success, true);
  assert.equal(c.transcript, 'long video words');
  assert.equal(starts, 1, 'only one paid job started');
  assert.ok(polls >= 3);
});
