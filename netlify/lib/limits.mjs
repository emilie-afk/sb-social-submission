// Durable usage limits (fixed windows stored in Netlify Blobs, updated with CAS).
// Counters are consumed *before* any paid or external call, so failed calls still count.

import { createHash } from 'node:crypto';

export const LIMITS = {
  // Login: every attempt is consumed atomically *before* the password is compared
  // (a successful sign-in refunds it), so parallel bursts cannot exceed the limit.
  loginFailPerIp:     { limit: 8,    windowSec: 15 * 60 },
  loginFailGlobal:    { limit: 300,  windowSec: 60 * 60 },
  // Screenshot analysis (Claude)
  analyzePerSession:  { limit: 40,   windowSec: 60 * 60 },
  analyzeGlobal:      { limit: 300,  windowSec: 24 * 60 * 60 },
  // Transcript requests (all) and paid Supadata calls
  transcriptPerSession: { limit: 60, windowSec: 60 * 60 },
  transcriptGlobal:   { limit: 400,  windowSec: 24 * 60 * 60 },
  supadataPerSession: { limit: 30,   windowSec: 60 * 60 },
  supadataGlobal:     { limit: 150,  windowSec: 24 * 60 * 60 },
  // Saves (each save may write one sheet row and one dashboard signal)
  savePerSession:     { limit: 120,  windowSec: 60 * 60 },
  saveGlobal:         { limit: 1500, windowSec: 24 * 60 * 60 },
};

export const hashId = (v) => createHash('sha256').update(String(v)).digest('hex').slice(0, 32);

function windowKey(name, scope, windowSec, now) {
  const idx = Math.floor(now / 1000 / windowSec);
  return { key: `rl/${name}/${hashId(scope)}/${idx}`, resetAt: (idx + 1) * windowSec * 1000 };
}

/** Current count without consuming. */
export async function peek(store, name, scope, now = Date.now()) {
  const { windowSec, limit } = LIMITS[name];
  const { key, resetAt } = windowKey(name, scope, windowSec, now);
  const cur = await store.get(key);
  const count = cur && cur.data ? cur.data.count : 0;
  return { count, limit, exceeded: count >= limit, retryAfterSec: Math.ceil((resetAt - now) / 1000) };
}

/** Consume one unit. Returns { allowed, retryAfterSec }. Does not consume when already at the limit. */
export async function consume(store, name, scope, now = Date.now()) {
  const { windowSec, limit } = LIMITS[name];
  const { key, resetAt } = windowKey(name, scope, windowSec, now);
  let allowed = false;
  await store.update(key, (cur) => {
    const count = cur ? cur.count : 0;
    if (count >= limit) { allowed = false; return undefined; }
    allowed = true;
    return { count: count + 1, expiresAt: resetAt };
  });
  return { allowed, retryAfterSec: Math.ceil((resetAt - now) / 1000) };
}

/** Give back one unit (e.g. a login attempt that turned out to be the right password). */
export async function refund(store, name, scope, now = Date.now()) {
  const { windowSec } = LIMITS[name];
  const { key } = windowKey(name, scope, windowSec, now);
  await store.update(key, (cur) => (cur && cur.count > 0 ? { ...cur, count: cur.count - 1 } : undefined));
}

/** Rate-limit scope for a client address: IPv6 addresses are grouped by their /64 prefix. */
export function ipScope(ip) {
  const s = String(ip || 'unknown');
  if (!s.includes(':')) return s;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  if (mapped) return mapped[1];                       // IPv4-mapped IPv6 → the IPv4 address
  const [head] = s.split('%');
  const parts = head.split('::');
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts.length > 1 && parts[1] ? parts[1].split(':') : [];
  const full = parts.length > 1 ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return full.slice(0, 4).map((x) => x.toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

/** Consume one unit from each named bucket in order; stop at the first refusal. */
export async function consumeAll(store, buckets, now = Date.now()) {
  for (const [name, scope] of buckets) {
    const r = await consume(store, name, scope, now);
    if (!r.allowed) return { allowed: false, bucket: name, retryAfterSec: r.retryAfterSec };
  }
  return { allowed: true };
}

/** Remove counters whose window has ended (best effort, bounded). */
export async function sweepExpired(store, now = Date.now(), max = 200) {
  let removed = 0;
  const keys = await store.list('rl/');
  for (const key of keys) {
    if (removed >= max) break;
    const parts = key.split('/');
    const name = parts[1];
    const idx = Number(parts[3]);
    const cfg = LIMITS[name];
    if (!cfg || !Number.isFinite(idx)) continue;
    if ((idx + 1) * cfg.windowSec * 1000 < now) { await store.delete(key); removed++; }
  }
  return removed;
}
