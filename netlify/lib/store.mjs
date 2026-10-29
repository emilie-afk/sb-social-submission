// Durable state on Netlify Blobs (site-wide store, strong consistency).
// Used for sessions, rate-limit counters, submission/delivery state and transcript cache.
// All read-modify-write operations use conditional writes (ETag compare-and-swap), so
// concurrent function invocations cannot lose updates. Any storage failure fails closed.

import { getStore } from '@netlify/blobs';

export const STORE_NAME = 'sb-social-submission';

export class StoreError extends Error {
  constructor(message = 'store_unavailable') { super(message); this.name = 'StoreError'; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createStore(raw) {
  let blobs = raw || null;
  const s = () => {
    if (!blobs) {
      try {
        blobs = getStore({ name: STORE_NAME, consistency: 'strong' });
      } catch {
        throw new StoreError('store_not_configured');
      }
    }
    return blobs;
  };
  const guard = async (fn) => {
    try { return await fn(); } catch (err) {
      if (err instanceof StoreError) throw err;
      throw new StoreError('store_unavailable');
    }
  };

  const api = {
    async get(key) {
      return guard(async () => {
        const res = await s().getWithMetadata(key, { type: 'json', consistency: 'strong' });
        if (!res) return null;
        return { data: res.data, etag: res.etag };
      });
    },
    async create(key, data) {
      return guard(async () => {
        const r = await s().setJSON(key, data, { onlyIfNew: true });
        return { ok: !!(r && r.modified), etag: r && r.etag };
      });
    },
    async replace(key, data, etag) {
      // Without an ETag the client would silently perform an unconditional write.
      if (typeof etag !== 'string' || !etag) throw new StoreError('missing_etag');
      return guard(async () => {
        const r = await s().setJSON(key, data, { onlyIfMatch: etag });
        return { ok: !!(r && r.modified), etag: r && r.etag };
      });
    },
    async delete(key) {
      return guard(() => s().delete(key));
    },
    async list(prefix) {
      return guard(async () => {
        const { blobs: items } = await s().list({ prefix });
        return items.map((b) => b.key);
      });
    },
    /**
     * Compare-and-swap update. `fn(current)` returns the next value, or undefined to
     * leave the entry unchanged. Returns { data, changed }.
     */
    async update(key, fn, { attempts = 8 } = {}) {
      for (let i = 0; i < attempts; i++) {
        const cur = await api.get(key);
        const next = fn(cur ? cur.data : null);
        if (next === undefined) return { data: cur ? cur.data : null, changed: false };
        const r = cur ? await api.replace(key, next, cur.etag) : await api.create(key, next);
        if (r.ok) return { data: next, changed: true };
        await sleep(15 + Math.floor(Math.random() * 40) * (i + 1));
      }
      throw new StoreError('store_contention');
    },
  };
  /**
   * Retire stale entries under `prefix` by replacing them with a small marker — through a
   * conditional (ETag) write, never a read-then-delete. If another request rewrote the
   * entry after we read it, the write fails and the fresh entry survives. Netlify Blobs
   * has no conditional delete, so keys that can be reused are never deleted.
   */
  api.retire = async (prefix, isStale, marker, max = 100) => {
    let retired = 0;
    for (const k of await api.list(prefix)) {
      if (retired >= max) break;
      const cur = await api.get(k);
      if (!cur || !cur.data || cur.data.retired || !isStale(cur.data)) continue;
      const r = await api.replace(k, { ...marker, retired: true }, cur.etag);
      if (r.ok) retired++;
    }
    return retired;
  };
  return api;
}

let shared = null;
export function defaultStore() {
  if (!shared) shared = createStore();
  return shared;
}
