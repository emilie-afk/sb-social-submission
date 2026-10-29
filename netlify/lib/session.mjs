// Signed, expiring, server-checked sessions for the shared team password.
//
// Cookie  : __Host-sbs_session=v1.<sid>.<expMs>.<sig>; Secure; HttpOnly; SameSite=Strict; Path=/
// sig     : HMAC-SHA256(key, "v1.<sid>.<expMs>")
// key     : HMAC-SHA256(SESSION_SIGNING_SECRET, "sbs-session|" + sha256(SITE_PASSWORD) + "|" + SESSION_EPOCH)
//           → changing the password, the signing secret or SESSION_EPOCH invalidates every session.
// Server  : sessions/<sid> record in Netlify Blobs; logout deletes it, so a copied cookie
//           stops working immediately. Expiry is enforced from both the signed value and the record.
// CSRF    : X-CSRF-Token = HMAC(key, "csrf.<sid>") required on every state-changing request,
//           plus Origin / Sec-Fetch-Site checks and a JSON content type.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { authConfig } from './config.mjs';

export const COOKIE_NAME = '__Host-sbs_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // matches the previous 7-day unlock

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function deriveKey(cfg) {
  const pwHash = createHash('sha256').update(cfg.password, 'utf8').digest('hex');
  return createHmac('sha256', cfg.signingSecret).update(`sbs-session|${pwHash}|${cfg.epoch}`).digest();
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Constant-time password check (compares fixed-length digests). */
export function passwordMatches(candidate, cfg) {
  if (typeof candidate !== 'string' || !candidate || candidate.length > 256) return false;
  const a = createHash('sha256').update(candidate, 'utf8').digest();
  const b = createHash('sha256').update(cfg.password, 'utf8').digest();
  return timingSafeEqual(a, b);
}

export function csrfFor(cfg, sid) {
  return b64u(createHmac('sha256', deriveKey(cfg)).update(`csrf.${sid}`).digest());
}

function sign(cfg, sid, exp) {
  return b64u(createHmac('sha256', deriveKey(cfg)).update(`v1.${sid}.${exp}`).digest());
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

export function sessionCookie(token, maxAgeSec) {
  return `${COOKIE_NAME}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}`;
}
export function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/** Create a session record + cookie. */
export async function createSession(store, cfg, now = Date.now()) {
  const sid = b64u(randomBytes(24));
  const exp = now + SESSION_TTL_MS;
  const r = await store.create(`sessions/${sid}`, { exp, createdAt: now, epoch: cfg.epoch });
  if (!r.ok) throw new Error('session_collision');
  const token = `v1.${sid}.${exp}.${sign(cfg, sid, exp)}`;
  return {
    sid, exp, csrfToken: csrfFor(cfg, sid),
    cookie: sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)),
  };
}

/**
 * Verify the session cookie. Returns { ok:true, sid, exp, cfg } or { ok:false, reason }.
 * Reasons: not_configured | missing | malformed | bad_signature | expired | revoked.
 */
export async function verifySession(req, store, now = Date.now(), env = process.env) {
  const cfg = authConfig(env);
  if (!cfg) return { ok: false, reason: 'not_configured' };
  const token = parseCookies(req.headers.get('cookie'))[COOKIE_NAME];
  if (!token) return { ok: false, reason: 'missing' };
  const m = /^v1\.([A-Za-z0-9_-]{32})\.(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return { ok: false, reason: 'malformed' };
  const [, sid, expStr, sig] = m;
  const exp = Number(expStr);
  if (!safeEqual(sig, sign(cfg, sid, exp))) return { ok: false, reason: 'bad_signature' };
  if (!(exp > now) || exp - now > SESSION_TTL_MS + 60_000) return { ok: false, reason: 'expired' };
  const rec = await store.get(`sessions/${sid}`);
  if (!rec || !rec.data) return { ok: false, reason: 'revoked' };
  if (rec.data.exp !== exp || !(rec.data.exp > now) || rec.data.epoch !== cfg.epoch) {
    return { ok: false, reason: 'revoked' };
  }
  return { ok: true, sid, exp, cfg };
}

export async function revokeSession(store, sid) {
  await store.delete(`sessions/${sid}`);
}

/** Same-origin checks for state-changing requests (defence in depth next to SameSite + token). */
export function sameOrigin(req) {
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.get('origin');
  if (origin) {
    let reqHost;
    try { reqHost = new URL(req.url).host; } catch { return false; }
    const fwdHost = req.headers.get('x-forwarded-host') || req.headers.get('host') || reqHost;
    let o;
    try { o = new URL(origin); } catch { return false; }
    if (o.host !== reqHost && o.host !== fwdHost) return false;
  }
  return true;
}

export function csrfValid(req, session) {
  const sent = req.headers.get('x-csrf-token') || '';
  return !!sent && safeEqual(sent, csrfFor(session.cfg, session.sid));
}

/** Remove expired session records (best effort, bounded). */
export async function sweepSessions(store, now = Date.now(), max = 100) {
  let removed = 0;
  for (const key of await store.list('sessions/')) {
    if (removed >= max) break;
    const rec = await store.get(key);
    if (!rec || !rec.data || !(rec.data.exp > now)) { await store.delete(key); removed++; }
  }
  return removed;
}
