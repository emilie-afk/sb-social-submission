// Strict URL handling for transcript extraction and outbound requests.
// Only exact, allow-listed public hostnames are accepted, so the function can never be
// pointed at localhost, private networks or cloud metadata addresses (IP literals and
// any unlisted host are rejected before a request is made).

export const PLATFORM_HOSTS = {
  youtube: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'],
  tiktok: ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'],
  instagram: ['instagram.com', 'www.instagram.com'],
};

// Plain path characters only (no percent-encoding): real TikTok/Instagram paths never need it.
const PATH_OK = /^\/[A-Za-z0-9._~@+\-/]*$/;
const YT_ID = /^[A-Za-z0-9_-]{11}$/;

/** Parse a user URL. Returns { ok, url } or { ok:false, message }. */
export function parseUserUrl(input, maxLen = 2048) {
  if (typeof input !== 'string') return { ok: false, message: 'URL is required.' };
  const raw = input.trim();
  if (!raw) return { ok: false, message: 'URL is required.' };
  if (raw.length > maxLen) return { ok: false, message: 'URL is too long.' };
  let u;
  try { u = new URL(raw); } catch { return { ok: false, message: 'That does not look like a valid link.' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, message: 'Only http(s) links are supported.' };
  if (u.username || u.password) return { ok: false, message: 'Links with embedded credentials are not allowed.' };
  if (u.port && u.port !== '443' && u.port !== '80') return { ok: false, message: 'Links with custom ports are not supported.' };
  return { ok: true, url: u };
}

function hostOf(u) { return u.hostname.toLowerCase().replace(/\.$/, ''); }

export function detectPlatform(u) {
  const h = hostOf(u);
  for (const [platform, hosts] of Object.entries(PLATFORM_HOSTS)) if (hosts.includes(h)) return platform;
  return 'unknown';
}

/**
 * Canonical https URL for a supported platform link (rebuilt from validated parts — the
 * user's string is never forwarded as-is). Returns { platform, canonical, videoId?, isShorts? } or null.
 */
export function canonicalize(u) {
  const platform = detectPlatform(u);
  const host = hostOf(u);
  if (platform === 'youtube') {
    let id = null; let isShorts = false;
    if (host === 'youtu.be') id = u.pathname.split('/')[1];
    else if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = /^\/(shorts|embed|live|v)\/([^/]+)/.exec(u.pathname);
      if (m) { id = m[2]; isShorts = m[1] === 'shorts'; }
    }
    if (!id || !YT_ID.test(id)) return { platform, canonical: null };
    const canonical = isShorts ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`;
    return { platform, canonical, videoId: id, isShorts };
  }
  if (platform === 'tiktok' || platform === 'instagram') {
    const path = u.pathname.replace(/\/{2,}/g, '/');
    if (!PATH_OK.test(path) || path.length > 512 || path === '/') return { platform, canonical: null };
    const h = platform === 'instagram' ? 'www.instagram.com' : (host === 'tiktok.com' || host === 'm.tiktok.com' ? 'www.tiktok.com' : host);
    return { platform, canonical: `https://${h}${path}` };
  }
  return { platform: 'unknown', canonical: null };
}

/**
 * Optional source link on a submission: empty, or a public http(s) URL. Internal-looking
 * hosts (IP literals, localhost, single-label, .local/.internal/…) are refused so the link
 * forwarded to Content Intelligence can never point at a private address.
 */
export function validateSourceUrl(input) {
  if (input === undefined || input === null || String(input).trim() === '') return { ok: true, value: '' };
  const r = parseUserUrl(String(input));
  if (!r.ok) return r;
  const h = hostOf(r.url);
  const ipLike = /^[\d.]+$/.test(h) || h.startsWith('[') || /^0x/i.test(h);
  const internal = !h.includes('.') || /\.(local|localhost|internal|intranet|lan|home|corp|test|invalid|arpa)$/.test(h) || h === 'localhost';
  if (ipLike || internal) return { ok: false, message: 'Please use a public link.' };
  return { ok: true, value: r.url.toString() };
}

/**
 * fetch() restricted to allow-listed https hosts, with a timeout, a response-size cap and
 * manual redirect handling (every hop is re-checked against the allow-list).
 */
export async function guardedFetch(url, { allowedHosts, timeoutMs, maxBytes = 1_000_000, headers = {}, maxRedirects = 3, fetchImpl = fetch, signal } = {}) {
  let current = new URL(url);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (current.protocol !== 'https:' || current.username || current.password || (current.port && current.port !== '443')) {
      throw new Error('blocked_destination');
    }
    if (!allowedHosts.includes(hostOf(current))) throw new Error('blocked_destination');
    const ctrl = AbortSignal.timeout(timeoutMs);
    const res = await fetchImpl(current.toString(), {
      headers, redirect: 'manual', signal: signal ? AbortSignal.any([ctrl, signal]) : ctrl,
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      try { await res.body?.cancel(); } catch { /* ignore */ }
      if (!loc) throw new Error('bad_redirect');
      current = new URL(loc, current);
      continue;
    }
    const text = await readCapped(res, maxBytes);
    return { status: res.status, ok: res.ok, headers: res.headers, text, url: current.toString() };
  }
  throw new Error('too_many_redirects');
}

async function readCapped(res, maxBytes) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { try { await reader.cancel(); } catch { /* ignore */ } throw new Error('response_too_large'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}
