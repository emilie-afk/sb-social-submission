// Regression tests for the second review (duplicate rows after uncertain appends, record
// cleanup, lock/cleanup races). Synthetic data and fakes only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getStore } from '@netlify/blobs';
import { startBlobs, setTestEnv, request, ctx, login, installNetworkTripwire, fakeSheets, fakeDashboard, uuid } from '../helpers.mjs';
import { createHandler as authH } from '../../netlify/functions/auth.mjs';
import { createHandler as saveH } from '../../netlify/functions/save.mjs';
import { createHandler as reconcileH } from '../../netlify/functions/reconcile-submissions.mjs';
import { createHandler as transcriptH } from '../../netlify/functions/extract-transcript.mjs';
import { createStore, defaultStore, StoreError, STORE_NAME } from '../../netlify/lib/store.mjs';
import { SETTLE_MS, DUPLICATE_TEXT } from '../../netlify/lib/submissions.mjs';
import { hashId } from '../../netlify/lib/limits.mjs';

let blobs, trip, s;
before(async () => { blobs = await startBlobs(); trip = installNetworkTripwire(blobs.port); setTestEnv(); s = await login(authH(), '10.7.0.1'); });
after(async () => { trip.restore(); await blobs.stop(); });

const save = (h, body) => h(request('save', { body, cookie: s.cookie, csrf: s.csrf }), ctx());
const sample = (over = {}) => ({ submissionId: uuid(), rawInput: 'review regression', sourceUrl: '', platform: 'Other', sourceName: '', submittedBy: 'QA', ...over });
const at = (ms) => () => Date.now() + ms;
const MIN = 60_000;

// A store whose every operation fails once `killed` is set — models the invocation dying
// (nothing after that point is persisted).
function killableStore() {
  const base = defaultStore();
  const st = { killed: false };
  const wrap = (fn) => async (...a) => { if (st.killed) throw new StoreError('killed'); return fn(...a); };
  const store = {};
  for (const k of ['get', 'create', 'replace', 'delete', 'list', 'update', 'retire']) store[k] = wrap(base[k].bind(base));
  return { store, st };
}

// ── 1. Uncertain appends ──────────────────────────────────────────────────────

test('late commit (> 30 s after the client timeout): no second row', async () => {
  const sh = fakeSheets(); const d = fakeDashboard();
  sh.state.deferNextAppend = 1;
  const body = sample();
  assert.equal((await save(saveH({ sheets: sh.factory, fetch: d.fetchImpl }), body)).status, 503);
  for (const t of [31_000, 2 * MIN, 5 * MIN]) {
    const r = await save(saveH({ sheets: sh.factory, fetch: d.fetchImpl, now: at(t) }), body);
    assert.equal((await r.json()).code, 'sheet_verifying', 'at ' + t);
  }
  sh.state.commitDeferred();                     // Google finally commits the first append
  const r = await save(saveH({ sheets: sh.factory, fetch: d.fetchImpl, now: at(6 * MIN) }), body);
  assert.equal(r.status, 200);
  assert.equal(sh.state.rows.length, 1);
  assert.equal(sh.state.appendCalls, 1);
});

test('invocation dies right after starting the append: no second row, entry recoverable', async () => {
  const sh = fakeSheets(); const d = fakeDashboard();
  const { store, st } = killableStore();
  const body = sample();
  const client = sh.factory();
  const dying = { ...client, appendRow: async (row) => { sh.state.deferred.push([...row]); st.killed = true; throw new Error('killed'); } };
  await save(saveH({ store, sheets: () => dying, fetch: d.fetchImpl }), body).catch(() => {});
  const rec = await defaultStore().get(`sub/${body.submissionId}`);
  assert.equal(rec.data.sheet.state, 'inflight', 'in-flight state was persisted before the append');
  assert.ok(rec.data.fields.rawInput, 'submission text kept');
  assert.ok(await defaultStore().get(`pending/${body.submissionId}`), 'indexed for the reconciler');
  // Retries while the original may still commit: blocked (lease, then settle window).
  assert.equal((await save(saveH({ sheets: sh.factory, fetch: d.fetchImpl }), body)).status, 409);
  assert.equal((await (await save(saveH({ sheets: sh.factory, fetch: d.fetchImpl, now: at(40_000) }), body)).json()).code, 'sheet_verifying');
  sh.state.commitDeferred();
  const r = await save(saveH({ sheets: sh.factory, fetch: d.fetchImpl, now: at(3 * MIN) }), body);
  assert.equal(r.status, 200);
  assert.equal(sh.state.rows.length, 1);
  assert.equal(sh.state.appendCalls, 0, 'the retry never appended');
});

test('record update fails after a successful append: the retry finds the row', async () => {
  const sh = fakeSheets(); const d = fakeDashboard();
  const { store, st } = killableStore();
  const body = sample();
  const client = sh.factory();
  const thenDie = { ...client, appendRow: async (row) => { const n = await client.appendRow(row); st.killed = true; return n; } };
  const r1 = await save(saveH({ store, sheets: () => thenDie, fetch: d.fetchImpl }), body);
  assert.equal(r1.status, 503);
  const r2 = await save(saveH({ sheets: sh.factory, fetch: d.fetchImpl, now: at(40_000) }), body);
  assert.equal(r2.status, 200);
  assert.equal(sh.state.rows.length, 1);
  assert.equal(sh.state.appendCalls, 1);
});

test('an append slower than every documented limit is re-appended once, then flagged as a duplicate', async () => {
  const sh = fakeSheets(); const d = fakeDashboard();
  sh.state.deferNextAppend = 1;
  const body = sample();
  await save(saveH({ sheets: sh.factory, fetch: d.fetchImpl }), body);
  const r = await save(saveH({ sheets: sh.factory, fetch: d.fetchImpl, now: at(SETTLE_MS + MIN) }), body);
  assert.equal(r.status, 200);
  sh.state.commitDeferred();                     // the original lands after the settle window
  assert.equal(sh.state.rows.length, 2);
  // The reconciler's later re-check flags the extra row for manual deletion (never deletes).
  await reconcileH({ sheets: sh.factory, fetch: d.fetchImpl, now: at(SETTLE_MS * 2 + 2 * MIN) })();
  const ids = sh.state.rows.map((x) => x[7]);
  assert.deepEqual(ids, [body.submissionId, body.submissionId]);
  assert.equal(sh.state.rows[1][4], DUPLICATE_TEXT(2));
  assert.equal(sh.state.rows[0][4], '✅ Sent');
  assert.equal((await defaultStore().get(`sub/${body.submissionId}`)).data.sheet.row, 2, 'record points at the kept row');
});

// ── 2. No cleanup of submission records ──────────────────────────────────────

test('completed records become tombstones (no text) and still prevent duplicate rows', async () => {
  const sh = fakeSheets(); const d = fakeDashboard();
  const body = sample();
  assert.equal((await save(saveH({ sheets: sh.factory, fetch: d.fetchImpl }), body)).status, 200);
  const rec = await defaultStore().get(`sub/${body.submissionId}`);
  assert.equal(rec.data.fields, null);
  assert.equal(await defaultStore().get(`pending/${body.submissionId}`), null);
  // Every housekeeping path runs (login sweeps + reconciler), even "years" later.
  await authH()(request('auth', { body: { password: process.env.SITE_PASSWORD } }), ctx('10.7.0.9'));
  await reconcileH({ sheets: sh.factory, fetch: d.fetchImpl, now: at(400 * 24 * 60 * MIN) })();
  const r = await save(saveH({ sheets: sh.factory, fetch: d.fetchImpl, now: at(400 * 24 * 60 * MIN) }), body);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).replay, true);
  assert.equal(sh.state.rows.length, 1);
  assert.equal(d.state.calls.length, 1);
});

test('even if a record is lost, a same-id retry finds the existing row instead of appending', async () => {
  const sh = fakeSheets(); const d = fakeDashboard();
  const body = sample();
  await save(saveH({ sheets: sh.factory, fetch: d.fetchImpl }), body);
  await defaultStore().delete(`sub/${body.submissionId}`);   // e.g. store reset
  await save(saveH({ sheets: sh.factory, fetch: d.fetchImpl }), body);
  assert.equal(sh.state.rows.length, 1);
  assert.equal(sh.state.appendCalls, 1);
});

test('stale partial records are kept and recovered by the reconciler without a new row', async () => {
  const sh = fakeSheets(); const d = fakeDashboard({ statuses: ['network', 'network'] });
  const body = sample();
  const r1 = await save(saveH({ sheets: sh.factory, fetch: d.fetchImpl }), body);
  assert.equal(r1.status, 202);
  assert.equal((await r1.json()).dashboard.state, 'failed');
  await reconcileH({ sheets: sh.factory, fetch: d.fetchImpl, now: at(100 * 24 * 60 * MIN) })();
  const rec = await defaultStore().get(`sub/${body.submissionId}`);
  assert.equal(rec.data.dashboard.state, 'delivered');
  assert.equal(sh.state.rows.length, 1);
  assert.equal(sh.state.rows[0][4], '✅ Sent');
});

test('reconciler does not repeat an uncertain delivery unless the dashboard is idempotent', async () => {
  const sh = fakeSheets(); const d = fakeDashboard({ statuses: ['timeout'] });
  const body = sample();
  await save(saveH({ sheets: sh.factory, fetch: d.fetchImpl }), body);
  await reconcileH({ sheets: sh.factory, fetch: d.fetchImpl, now: at(10 * MIN) })();
  assert.equal(d.state.calls.length, 1);
  setTestEnv({ DASHBOARD_IDEMPOTENT: 'true' });
  await reconcileH({ sheets: sh.factory, fetch: d.fetchImpl, now: at(20 * MIN) })();
  setTestEnv({ DASHBOARD_IDEMPOTENT: null });
  assert.equal(d.state.calls.length, 2);
  assert.equal((await defaultStore().get(`sub/${body.submissionId}`)).data.dashboard.state, 'delivered');
});

test('reconciler leaves a submission with a live lease alone', async () => {
  const sh = fakeSheets(); const d = fakeDashboard();
  const body = sample();
  sh.state.appendDelayMs = 300;
  const p = save(saveH({ sheets: sh.factory, fetch: d.fetchImpl }), body);
  await new Promise((r) => setTimeout(r, 100));
  await reconcileH({ sheets: sh.factory, fetch: d.fetchImpl, minAgeMs: 0 })();
  assert.equal((await p).status, 200);
  assert.equal(sh.state.rows.length, 1);
  assert.equal(sh.state.appendCalls, 1);
});

// ── 3. Cleanup and lock races ────────────────────────────────────────────────

// A raw Blobs store whose read of `key` lets `hook` run (a competing writer) after the
// read but before the caller acts on it.
function interleaved(key, hook) {
  const raw = getStore({ name: STORE_NAME, consistency: 'strong' });
  let fired = false;
  return createStore(new Proxy(raw, {
    get(target, prop) {
      if (prop === 'getWithMetadata') {
        return async (k, o) => {
          const res = await target.getWithMetadata(k, o);
          if (k === key && !fired) { fired = true; await hook(); }
          return res;
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }));
}

test('cleanup cannot remove an entry rewritten after it was read (retire uses CAS)', async () => {
  const k = 'tx/race-entry';
  await defaultStore().update(k, () => ({ result: { success: true }, expiresAt: 1 }));   // expired
  const store = interleaved(k, () => defaultStore().update(k, () => ({ result: { success: true, fresh: true }, expiresAt: Date.now() + 1e9 })));
  const retired = await store.retire('tx/', (d) => !(d.expiresAt > Date.now()), { expiresAt: 0 });
  assert.equal(retired, 0);
  const now = await defaultStore().get(k);
  assert.equal(now.data.result.fresh, true, 'fresh entry survived');
});

test('an old owner releasing after a lock takeover leaves the new lock in place', async () => {
  const k = 'txlock/race-lock';
  await defaultStore().update(k, () => ({ until: Date.now() - 1, owner: 'old' }));
  // The old owner's release reads the lock, then a new owner takes it over, then the release writes.
  const store = interleaved(k, () => defaultStore().update(k, (cur) => (cur.until < Date.now() ? { until: Date.now() + 30_000, owner: 'new' } : undefined)));
  await store.update(k, (cur) => (cur && cur.owner === 'old' ? { until: 0, owner: null } : undefined));
  const cur = await defaultStore().get(k);
  assert.equal(cur.data.owner, 'new');
  assert.ok(cur.data.until > Date.now());
});

test('housekeeping during a live transcript extraction keeps the lock: a second extraction stays blocked', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let paid = 0;
  const fetchImpl = async (url) => {
    if (new URL(url).hostname === 'api.supadata.ai') { paid++; await gate; return Response.json({ content: [{ text: 'words' }] }); }
    throw new Error('unexpected');
  };
  const h = transcriptH({ fetch: fetchImpl, youtubeTranscript: async () => { throw new Error('none'); } });
  const call = () => h(request('extract-transcript', { body: { url: 'https://www.instagram.com/reel/LOCKRACE1/' }, cookie: s.cookie, csrf: s.csrf }), ctx());
  const first = call();
  await new Promise((r) => setTimeout(r, 150));
  // Login runs all housekeeping sweeps.
  await authH()(request('auth', { body: { password: process.env.SITE_PASSWORD } }), ctx('10.7.0.10'));
  const lock = await defaultStore().get(`txlock/${hashId('https://www.instagram.com/reel/LOCKRACE1/')}`);
  assert.ok(lock && lock.data.until > Date.now(), 'live lock survived housekeeping');
  const second = await call();
  assert.equal(second.status, 409);
  release();
  assert.equal((await first).status, 200);
  assert.equal(paid, 1);
});

test('reconciler is not starved by records it cannot progress (rejected / uncertain)', async () => {
  const sh = fakeSheets();
  const rej = fakeDashboard({ statuses: Array(25).fill(401) });
  for (let i = 0; i < 25; i++) await save(saveH({ sheets: sh.factory, fetch: rej.fetchImpl }), sample({ rawInput: 'rejected ' + i }));
  const unc = fakeDashboard({ statuses: Array(5).fill('timeout') });
  for (let i = 0; i < 5; i++) await save(saveH({ sheets: sh.factory, fetch: unc.fetchImpl }), sample({ rawInput: 'uncertain ' + i }));
  const flaky = fakeDashboard({ statuses: ['network', 'network'] });
  const body = sample({ rawInput: 'recoverable' });
  await save(saveH({ sheets: sh.factory, fetch: flaky.fetchImpl }), body);
  const ok = fakeDashboard();
  await reconcileH({ sheets: sh.factory, fetch: ok.fetchImpl, now: at(30 * MIN) })();
  assert.equal((await defaultStore().get(`sub/${body.submissionId}`)).data.dashboard.state, 'delivered');
  assert.equal(ok.state.calls.length, 1, 'only the recoverable record was sent');
});

test('a dashboard send that dies mid-flight is treated as uncertain (not re-sent unless idempotent)', async () => {
  const sh = fakeSheets();
  const { store, st } = killableStore();
  const body = sample();
  const dying = async () => { st.killed = true; throw Object.assign(new Error('killed'), { name: 'Killed' }); };
  await save(saveH({ store, sheets: sh.factory, fetch: dying }), body).catch(() => {});
  const rec = await defaultStore().get(`sub/${body.submissionId}`);
  assert.equal(rec.data.dashboard.state, 'inflight', 'in-flight delivery persisted before sending');
  const d = fakeDashboard();
  await reconcileH({ sheets: sh.factory, fetch: d.fetchImpl, now: at(30 * MIN) })();
  assert.equal(d.state.calls.filter((c) => c.body[0].client_submission_id === body.submissionId).length, 0);
  setTestEnv({ DASHBOARD_IDEMPOTENT: 'true' });
  await reconcileH({ sheets: sh.factory, fetch: d.fetchImpl, now: at(60 * MIN) })();
  setTestEnv({ DASHBOARD_IDEMPOTENT: null });
  const mine = d.state.calls.filter((c) => c.body[0].client_submission_id === body.submissionId);
  assert.equal(mine.length, 1, 'sent once, after being enabled');
  assert.equal((await defaultStore().get(`sub/${body.submissionId}`)).data.dashboard.state, 'delivered');
  assert.equal(sh.state.rows.filter((r) => r[7] === body.submissionId).length, 1);
});

test('the reconciler index is written before the record', async () => {
  const base = defaultStore();
  const store = { ...base, update: async (k, fn, o) => { if (k.startsWith('sub/')) throw new StoreError('down'); return base.update(k, fn, o); } };
  for (const m of ['get', 'create', 'replace', 'delete', 'list', 'retire']) store[m] = base[m].bind(base);
  const body = sample();
  const r = await save(saveH({ store, sheets: fakeSheets().factory, fetch: fakeDashboard().fetchImpl }), body);
  assert.equal(r.status, 503);
  assert.ok(await defaultStore().get(`pending/${body.submissionId}`), 'index entry exists');
  await reconcileH({ sheets: fakeSheets().factory, fetch: fakeDashboard().fetchImpl, now: at(30 * MIN) })(); // skips the missing record
  assert.ok(await defaultStore().get(`pending/${body.submissionId}`), 'orphan index entry is retained (never deleted on a missing-record read)');
});

test('removing the token never turns a possibly-delivered send into a safe-to-send state', async () => {
  const sh = fakeSheets();
  const body = sample();
  await save(saveH({ sheets: sh.factory, fetch: fakeDashboard({ statuses: ['timeout'] }).fetchImpl }), body);
  setTestEnv({ SUBMIT_TOKEN: null });
  await save(saveH({ sheets: sh.factory }), body);
  setTestEnv();
  assert.equal((await defaultStore().get(`sub/${body.submissionId}`)).data.dashboard.state, 'uncertain');
  const d = fakeDashboard();
  await reconcileH({ sheets: sh.factory, fetch: d.fetchImpl, now: at(30 * MIN) })();
  assert.equal(d.state.calls.filter((c) => c.body[0].client_submission_id === body.submissionId).length, 0);
});

test('maintenance mode (no signing secret) pauses the reconciler', async () => {
  const sh = fakeSheets(); const d = fakeDashboard({ statuses: ['network', 'network'] });
  const body = sample();
  await save(saveH({ sheets: sh.factory, fetch: d.fetchImpl }), body);
  const calls = d.state.calls.length;
  setTestEnv({ SESSION_SIGNING_SECRET: null });
  await reconcileH({ sheets: sh.factory, fetch: d.fetchImpl, now: at(30 * MIN) })();
  setTestEnv();
  assert.equal(d.state.calls.length, calls);
});

test('no outbound network in these tests', () => { assert.deepEqual(trip.calls, []); });

test('orphan index entry vs concurrent retry: the unfinished save stays discoverable and is completed later', async () => {
  const sh = fakeSheets();
  const body = sample();
  const id = body.submissionId;
  // 1. A failed earlier request left an old index entry and no record.
  await defaultStore().update(`pending/${id}`, () => ({ at: Date.now() - 30 * MIN }));
  assert.equal(await defaultStore().get(`sub/${id}`), null);

  // 2–4. The reconciler reads sub/<id> (missing); before it continues, the user retries:
  //      record created, sheet row saved, dashboard fails. Then the reconciler goes on.
  const base = defaultStore();
  const store = {};
  for (const m of ['get', 'create', 'replace', 'delete', 'list', 'update', 'retire']) store[m] = base[m].bind(base);
  let injected = false;
  store.get = async (k) => {
    const r = await base.get(k);
    if (k === `sub/${id}` && !injected) {
      injected = true;
      const u = await save(saveH({ sheets: sh.factory, fetch: fakeDashboard({ statuses: [503, 503] }).fetchImpl }), body); // certainly not delivered
      assert.equal(u.status, 202, 'user retry: sheet saved, dashboard failed');
    }
    return r; // the reconciler keeps its old "record missing" snapshot
  };
  const r1 = await reconcileH({ store, sheets: sh.factory, fetch: fakeDashboard().fetchImpl, now: at(0) })();
  assert.ok(injected, 'interleaving happened');
  assert.equal(r1.status, 204);

  // 5. The next scheduled scan still finds the entry and finishes delivery — no new sheet row.
  const idx = await defaultStore().get(`pending/${id}`);
  assert.ok(idx && idx.data, 'index entry survived the concurrent cleanup');
  assert.ok(idx.data.at > Date.now() - MIN, 'index refreshed by the retry');
  const d = fakeDashboard();
  await reconcileH({ sheets: sh.factory, fetch: d.fetchImpl, now: at(30 * MIN) })();
  const rec = await defaultStore().get(`sub/${id}`);
  assert.equal(rec.data.dashboard.state, 'delivered');
  assert.equal(d.state.calls.filter((c) => c.body[0].client_submission_id === id).length, 1);
  assert.equal(sh.state.rows.filter((row) => row[7] === id).length, 1, 'still one sheet row');
  assert.equal(await defaultStore().get(`pending/${id}`), null, 'index removed only once complete');
});
