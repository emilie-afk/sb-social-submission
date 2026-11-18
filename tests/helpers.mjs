// Test helpers: a real local Netlify Blobs server (same client code + conditional writes as
// production), synthetic secrets, request builders and fakes for every external service.
// No test talks to Google, Claude, Supadata, YouTube, TikTok or Content Intelligence.

import { startTestBlobsServer } from './blobs-test-server.mjs';

export const FAKE = {
  SITE_PASSWORD: 'test-password-Zq81',
  SESSION_SIGNING_SECRET: 'test-signing-secret-0123456789abcdefXYZ',
  CLAUDE_API_KEY: 'sk-ant-test-FAKEKEY-1234567890',
  SUPADATA_API_KEY: 'supa-test-FAKEKEY-7890abcdef',
  SUBMIT_TOKEN: 'submit-token-test-FAKE-abcdef0123',
  GOOGLE_SHEET_ID: '1TESTsheetIdFAKE_abcdefghijklmnopqrstuvwx',
  SA_EMAIL: 'intake-test@fake-project.iam.gserviceaccount.com',
  SA_KEY: '-----BEGIN PRIVATE KEY-----\nFAKEKEYMATERIALforTESTSonly\n-----END PRIVATE KEY-----\n',
};

export function setTestEnv(overrides = {}) {
  const base = {
    SITE_PASSWORD: FAKE.SITE_PASSWORD,
    SESSION_SIGNING_SECRET: FAKE.SESSION_SIGNING_SECRET,
    CLAUDE_API_KEY: FAKE.CLAUDE_API_KEY,
    SUPADATA_API_KEY: FAKE.SUPADATA_API_KEY,
    SUBMIT_TOKEN: FAKE.SUBMIT_TOKEN,
    GOOGLE_SHEET_ID: FAKE.GOOGLE_SHEET_ID,
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ type: 'service_account', client_email: FAKE.SA_EMAIL, private_key: FAKE.SA_KEY, private_key_id: 'fakekeyid0001' }),
    DASHBOARD_URL: '',
    SESSION_EPOCH: '',
  };
  for (const [k, v] of Object.entries({ ...base, ...overrides })) {
    if (v === undefined || v === null) delete process.env[k];
    else process.env[k] = v;
  }
}

export async function startBlobs() {
  const token = 'local-blobs-token';
  const server = await startTestBlobsServer({ token });
  const { port } = server;
  const ctx = { siteID: 'test-site', token, edgeURL: `http://localhost:${port}`, uncachedEdgeURL: `http://localhost:${port}`, deployID: 'test' };
  process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify(ctx)).toString('base64');
  return {
    port,
    data: server.data,
    env: { NETLIFY_BLOBS_CONTEXT: process.env.NETLIFY_BLOBS_CONTEXT },
    stop: async () => { await Promise.allSettled(pendingWork); await server.stop(); },
  };
}

/** Records every outbound call that is not to the local blobs server, and refuses it. */
export function installNetworkTripwire(blobsPort) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith(`http://localhost:${blobsPort}/`)) return real(input, init);
    calls.push(url);
    return Promise.reject(new Error('network disabled in tests'));
  };
  return { calls, restore() { globalThis.fetch = real; } };
}

export const ORIGIN = 'https://intake.test';

export function request(name, { method = 'POST', body, cookie, csrf, origin = ORIGIN, headers = {}, raw } = {}) {
  const h = new Headers(headers);
  if (method !== 'GET' && !h.has('content-type')) h.set('content-type', 'application/json');
  if (cookie) h.set('cookie', cookie);
  if (csrf) h.set('x-csrf-token', csrf);
  if (origin) h.set('origin', origin);
  return new Request(`${ORIGIN}/.netlify/functions/${name}`, {
    method, headers: h,
    body: method === 'GET' ? undefined : (raw !== undefined ? raw : JSON.stringify(body ?? {})),
  });
}

// Background work handed to context.waitUntil (housekeeping sweeps) is awaited before the
// test Blobs server stops, as Netlify would keep the invocation alive for it.
export const pendingWork = [];
export const ctx = (ip = '203.0.113.10') => ({ ip, waitUntil: (p) => { pendingWork.push(p); } });

export function cookieFrom(res) {
  const sc = res.headers.get('set-cookie') || '';
  const m = /^(__Host-sbs_session=[^;]*)/.exec(sc);
  return m ? m[1] : null;
}

export async function login(authHandler, ip) {
  const res = await authHandler(request('auth', { body: { password: FAKE.SITE_PASSWORD } }), ctx(ip));
  const body = await res.json();
  if (res.status !== 200) throw new Error('login failed: ' + res.status + ' ' + JSON.stringify(body));
  return { cookie: cookieFrom(res), csrf: body.csrfToken, expiresAt: body.expiresAt };
}

// ── Fakes ───────────────────────────────────────────────────────────────────

export function fakeSheets({ failAppend = 0, failAppendStatus = 503, throwAfterAppend = 0, failStatus = false, failEnsure = 0 } = {}) {
  const state = {
    rows: [], appendCalls: 0, statusCalls: 0, ensureCalls: 0, findCalls: 0, markCalls: 0,
    failAppend, failAppendStatus, throwAfterAppend, failStatus, failEnsure, appendDelayMs: 0, tabExists: true,
    // Late commit: the append times out at the client, but Google commits it later.
    deferNextAppend: 0, deferred: [],
    commitDeferred() { while (state.deferred.length) state.rows.push(state.deferred.shift()); },
    // Crash: the invocation dies right after the append request is sent.
    crashNextAppend: 0,
  };
  const find = (id) => state.rows.map((r, i) => (r[7] === id ? i + 2 : null)).filter(Boolean);
  const client = {
    async ensureIntake() {
      state.ensureCalls++;
      if (state.failEnsure > 0) { state.failEnsure--; throw Object.assign(new Error('sheets down'), { code: 503 }); }
      state.tabExists = true;
    },
    async findRowsById(id) {
      state.findCalls++;
      if (!state.tabExists) throw Object.assign(new Error('Unable to parse range: Intake!H:H'), { code: 400 });
      return find(id);
    },
    async findRowById(id) { return (await client.findRowsById(id))[0] || null; },
    async appendRow(row) {
      state.appendCalls++;
      if (state.appendDelayMs) await new Promise((r) => setTimeout(r, state.appendDelayMs));
      if (state.failAppend > 0) { state.failAppend--; throw Object.assign(new Error('sheets down'), { code: state.failAppendStatus }); }
      if (state.deferNextAppend > 0) {
        state.deferNextAppend--;
        state.deferred.push([...row]);
        throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
      }
      if (state.crashNextAppend > 0) {
        state.crashNextAppend--;
        state.deferred.push([...row]);
        throw Object.assign(new Error('invocation killed'), { crash: true });
      }
      state.rows.push([...row]);
      if (state.throwAfterAppend > 0) { state.throwAfterAppend--; throw Object.assign(new Error('timeout after write'), { code: 'ETIMEDOUT' }); }
      return state.rows.length + 1;
    },
    async setStatus(rowNumber, text, id) {
      state.statusCalls++;
      if (state.failStatus) throw new Error('status failed');
      let i = rowNumber - 2;
      if (!state.rows[i] || state.rows[i][7] !== id) i = state.rows.findIndex((r) => r[7] === id);
      if (i < 0) return null;
      state.rows[i][4] = text;
      return i + 2;
    },
    async markRow(rowNumber, text, id) {
      state.markCalls++;
      const r = state.rows[rowNumber - 2];
      if (!r || r[7] !== id) return false;
      r[4] = text; return true;
    },
  };
  return { state, factory: () => client };
}

export function fakeDashboard({ statuses = [] } = {}) {
  const state = { calls: [], statuses: [...statuses] };
  const fetchImpl = async (url, init) => {
    state.calls.push({ url, headers: init.headers, body: JSON.parse(init.body), redirect: init.redirect });
    const next = state.statuses.length ? state.statuses.shift() : 200;
    if (next === 'network') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (next === 'timeout') { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; }
    if (next === 'hang') {
      await new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))));
    }
    return new Response(JSON.stringify(next === 200 ? { success: true, inserted: 1, skipped: 0 } : { error: 'Failed to insert signals', detail: 'db secret detail' }), { status: next });
  };
  return { state, fetchImpl };
}

export function fakeClaude(reply = '{"rawText":"hello","creatorName":"@maker"}') {
  const state = { calls: [], keys: [] };
  const factory = (apiKey) => {
    state.keys.push(apiKey);
    return { messages: { create: async (args) => { state.calls.push(args); return { content: [{ type: 'text', text: typeof reply === 'function' ? reply(args) : reply }] }; } } };
  };
  return { state, factory };
}

// Smallest valid images (magic bytes + padding).
export function jpegB64(bytes = 600) {
  const b = Buffer.alloc(bytes, 0x11); b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe0;
  return b.toString('base64');
}
export function pngB64(bytes = 600) {
  const b = Buffer.alloc(bytes, 0x22); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  return b.toString('base64');
}

export const uuid = () => crypto.randomUUID();
