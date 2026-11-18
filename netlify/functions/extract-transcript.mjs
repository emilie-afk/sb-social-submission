// POST /.netlify/functions/extract-transcript  { url }
// YouTube: free captions first, then Supadata (paid). TikTok / Instagram: Supadata, with
// TikTok's public oEmbed caption as the free fallback. Results are cached so repeated
// requests for the same video do not spend Supadata credits again.

import { YoutubeTranscript } from 'youtube-transcript';
import { json, errors, readJson, wrap } from '../lib/http.mjs';
import { requireSession } from '../lib/guard.mjs';
import { parseUserUrl, canonicalize, guardedFetch } from '../lib/urls.mjs';
import { consume, consumeAll, hashId } from '../lib/limits.mjs';
import { supadataKey, functionBudgetMs } from '../lib/config.mjs';
import { randomBytes } from 'node:crypto';
import { cleanText } from '../lib/text.mjs';
import { defaultStore, StoreError } from '../lib/store.mjs';
import { createLogger } from '../lib/log.mjs';

const log = createLogger('transcript');

export const MAX_TRANSCRIPT_CHARS = 40000;      // a Google Sheets cell holds 50k characters
const CACHE_OK_MS = 7 * 24 * 3600 * 1000;
const CACHE_MISS_MS = 60 * 60 * 1000;
const LOCK_MS = 30_000;
const SUPADATA_HOSTS = ['api.supadata.ai'];
const LABEL = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram' };

const joinSegments = (segs) => segs.map((s) => String(s.text || '').trim()).join(' ').replace(/\s+/g, ' ').trim();

/** fetch() handed to youtube-transcript: YouTube hosts only, no redirects, timeout, size cap. */
function youtubeFetch(deadline, fetchImpl) {
  return async (url, init = {}) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !['www.youtube.com', 'youtube.com'].includes(u.hostname)) {
      throw new Error('blocked_destination');
    }
    const ms = Math.max(200, deadline - Date.now());
    const res = await fetchImpl(u.toString(), { ...init, redirect: 'manual', signal: AbortSignal.timeout(ms) });
    if (res.status >= 300 && res.status < 400) return new Response('', { status: 502 });
    const reader = res.body ? res.body.getReader() : null;
    const chunks = []; let total = 0;
    if (reader) for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 4_000_000) { try { await reader.cancel(); } catch { /* ignore */ } throw new Error('response_too_large'); }
      chunks.push(Buffer.from(value));
    }
    return new Response(Buffer.concat(chunks), { status: res.status, headers: { 'content-type': res.headers.get('content-type') || 'text/plain' } });
  };
}

/**
 * Returns { text } on success, { none:true } when Supadata answered that no transcript
 * exists, { pending:true } when it started an asynchronous job (long videos), and
 * { error:true } for timeouts / provider errors. Only { text } and { none } are cached.
 */
async function supadata(canonical, apiKey, deadline, fetchImpl) {
  const ms = deadline - Date.now() - 200;
  if (ms < 1000) return { error: true };
  try {
    const r = await guardedFetch(`https://api.supadata.ai/v1/transcript?url=${encodeURIComponent(canonical)}`, {
      allowedHosts: SUPADATA_HOSTS, timeoutMs: ms, maxBytes: 2_000_000, maxRedirects: 0,
      headers: { 'x-api-key': apiKey }, fetchImpl,
    });
    if (r.status === 202) {
      let jobId = null;
      try { jobId = JSON.parse(r.text).jobId; } catch { /* ignore */ }
      return { pending: true, jobId: typeof jobId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(jobId) ? jobId : null };
    }
    if (r.status === 404 || r.status === 206) return { none: true };
    if (!r.ok) { log.warn('supadata_status', { status: r.status }); return { error: true }; }
    const data = JSON.parse(r.text);
    if (Array.isArray(data.content) && data.content.length) return { text: joinSegments(data.content) };
    if (typeof data.content === 'string' && data.content.trim()) return { text: data.content.replace(/\s+/g, ' ').trim() };
    return { none: true };
  } catch (err) {
    log.warn('supadata_failed', { kind: err && (err.name || err.message) });
    return { error: true };
  }
}

/** Poll an asynchronous Supadata job (polling is free) until done or out of time. */
async function pollSupadataJob(jobId, apiKey, deadline, fetchImpl) {
  while (deadline - Date.now() > 1500) {
    try {
      const r = await guardedFetch(`https://api.supadata.ai/v1/transcript/${encodeURIComponent(jobId)}`, {
        allowedHosts: SUPADATA_HOSTS, timeoutMs: Math.min(3000, deadline - Date.now() - 300), maxBytes: 2_000_000, maxRedirects: 0,
        headers: { 'x-api-key': apiKey }, fetchImpl,
      });
      if (r.status === 404) return { none: true, jobGone: true };
      if (!r.ok) return { error: true };
      const data = JSON.parse(r.text);
      if (data.status === 'completed') {
        if (Array.isArray(data.content) && data.content.length) return { text: joinSegments(data.content) };
        if (typeof data.content === 'string' && data.content.trim()) return { text: data.content.replace(/\s+/g, ' ').trim() };
        return { none: true };
      }
      if (data.status === 'failed') return { none: true };
    } catch {
      return { error: true };
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  return { pending: true };
}

async function tiktokOembed(canonical, deadline, fetchImpl) {
  const ms = Math.min(5000, deadline - Date.now() - 200);
  if (ms < 500) return null;
  try {
    const r = await guardedFetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(canonical)}`, {
      allowedHosts: ['www.tiktok.com'], timeoutMs: ms, maxBytes: 256_000, maxRedirects: 1,
      headers: { 'User-Agent': 'Mozilla/5.0' }, fetchImpl,
    });
    if (!r.ok) return null;
    const data = JSON.parse(r.text);
    const parts = [];
    if (typeof data.title === 'string' && data.title) parts.push(`Caption: ${data.title}`);
    if (typeof data.author_name === 'string' && data.author_name) parts.push(`Creator: ${data.author_name}`);
    return parts.length ? parts.join('\n') : null;
  } catch {
    return null;
  }
}

export function createHandler(deps = {}) {
  const fetchImpl = deps.fetch || ((...a) => fetch(...a));
  const ytFetchTranscript = deps.youtubeTranscript || ((id, cfg) => YoutubeTranscript.fetchTranscript(id, cfg));

  return wrap(async (req) => {
    if (req.method !== 'POST') return errors.methodNotAllowed();
    const env = deps.env || process.env;
    const startedAt = Date.now();
    const store = deps.store || defaultStore();
    const gate = await requireSession(req, store, { env });
    if (gate.response) return gate.response;
    const sid = gate.session.sid;

    const body = await readJson(req, 8 * 1024);
    const parsed = parseUserUrl(body.url);
    if (!parsed.ok) return errors.badRequest(parsed.message, 'invalid_url');

    const c = canonicalize(parsed.url);
    if (c.platform === 'unknown') {
      return json(200, { success: false, platform: 'unknown', transcript: '',
        note: 'Transcript extraction works for YouTube, TikTok, and Instagram URLs.' });
    }
    if (!c.canonical) {
      return errors.badRequest(c.platform === 'youtube'
        ? 'Could not extract a YouTube video ID from this URL.'
        : 'This link format is not supported.', 'invalid_url');
    }

    const deadline = startedAt + functionBudgetMs(env);
    const apiKey = supadataKey(env);
    const cacheKey = `tx/${hashId(c.canonical)}`;
    const jobKey = `txjob/${hashId(c.canonical)}`;
    const lockKey = `txlock/${hashId(c.canonical)}`;
    const now = Date.now();

    try {
      const lim = await consumeAll(store, [['transcriptPerSession', sid], ['transcriptGlobal', 'all']]);
      if (!lim.allowed) return errors.rateLimited(lim.retryAfterSec, 'Transcript limit reached — please try again later.');

      const cached = await store.get(cacheKey);
      if (cached && cached.data && cached.data.expiresAt > now) {
        return json(200, { ...cached.data.result, cached: true });
      }

      // One extraction per video at a time (protects paid credits from double-clicks).
      let locked = false;
      const lockOwner = randomBytes(8).toString('hex');
      await store.update(lockKey, (cur) => {
        if (cur && cur.until > now) { locked = false; return undefined; }
        locked = true;
        return { until: now + LOCK_MS, owner: lockOwner };
      });
      if (!locked) {
        return json(409, { error: 'This link is already being processed — try again in a few seconds.', code: 'in_progress', retryAfter: 5 });
      }

      try {
        // Another request may have finished while we waited for the lock.
        const again = await store.get(cacheKey);
        if (again && again.data && again.data.expiresAt > Date.now()) {
          return json(200, { ...again.data.result, cached: true });
        }
        const result = await extract(c, { apiKey, deadline, sid, store, fetchImpl, ytFetchTranscript, jobKey });
        if (result.cache) {
          await store.update(cacheKey, () => ({
            result: result.body,
            expiresAt: now + (result.body.success ? CACHE_OK_MS : CACHE_MISS_MS),
          }));
        }
        return json(result.status || 200, result.body);
      } finally {
        // Release only our own lock, atomically (CAS): if the lock expired and another
        // request took it over, the owner no longer matches and nothing is changed.
        await store.update(lockKey, (cur) => (cur && cur.owner === lockOwner ? { until: 0, owner: null } : undefined)).catch(() => {});
      }
    } catch (err) {
      if (err instanceof StoreError) return errors.unavailable();
      throw err;
    }
  }, log);
}

// Mark a Supadata job finished only if it is still the job we polled (CAS).
async function finishJob(ctx, jobId) {
  await ctx.store.update(ctx.jobKey, (cur) => (cur && cur.jobId === jobId ? { jobId, expiresAt: 0, done: true } : undefined)).catch(() => {});
}

async function extract(c, ctx) {
  const label = LABEL[c.platform];
  const done = (body, cache = true) => ({ body: { ...body, transcript: cleanText(body.transcript || '', MAX_TRANSCRIPT_CHARS) }, cache });

  // Paid fallback with its own durable budget; a refusal is reported, not cached.
  const paid = async () => {
    if (!ctx.apiKey) return { none: true };
    // A long video already has a paid job running: poll it (free) instead of starting another.
    const job = await ctx.store.get(ctx.jobKey);
    if (job && job.data && job.data.expiresAt > Date.now()) {
      const r = await pollSupadataJob(job.data.jobId, ctx.apiKey, ctx.deadline, ctx.fetchImpl);
      if (r.text || r.none) await finishJob(ctx, job.data.jobId);
      if (!r.jobGone) return r;
    }
    const lim = await consumeAll(ctx.store, [['supadataPerSession', ctx.sid], ['supadataGlobal', 'all']]);
    if (!lim.allowed) return { limited: true };
    const r = await supadata(c.canonical, ctx.apiKey, ctx.deadline, ctx.fetchImpl);
    if (r.pending && r.jobId) {
      await ctx.store.update(ctx.jobKey, () => ({ jobId: r.jobId, expiresAt: Date.now() + 60 * 60 * 1000 }));
      const polled = await pollSupadataJob(r.jobId, ctx.apiKey, ctx.deadline, ctx.fetchImpl);
      if (polled.text || polled.none) await finishJob(ctx, r.jobId);
      return polled;
    }
    return r;
  };
  const limitedNote = 'Paid transcript limit reached for now — add the spoken content manually in the notes field, or try again later.';
  const pendingNote = 'The transcript is still being generated for this video — try Extract again in a minute.';
  const errorNote = 'The transcript service did not respond in time — please try again.';
  // Provider trouble (limit, pending job, timeout) is reported but never cached.
  const transient = (p) => p.limited || p.pending || p.error;
  const transientNote = (p) => (p.limited ? limitedNote : p.pending ? pendingNote : errorNote);

  if (c.platform === 'youtube') {
    let transcript = null;
    try {
      const freeDeadline = Math.min(ctx.deadline, Date.now() + 4000);
      const segs = await Promise.race([
        ctx.ytFetchTranscript(c.videoId, { fetch: youtubeFetch(freeDeadline, ctx.fetchImpl) }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), Math.max(0, freeDeadline - Date.now())).unref?.()),
      ]);
      if (Array.isArray(segs) && segs.length) transcript = joinSegments(segs);
    } catch { /* fall through to paid */ }
    if (transcript) return done({ success: true, platform: label, transcript, source: 'free' });

    const p = await paid();
    if (p.text) return done({ success: true, platform: label, transcript: p.text, source: 'supadata' });
    if (transient(p)) return done({ success: false, platform: label, transcript: '', note: transientNote(p) }, false);
    return done({
      success: false, platform: label, transcript: '',
      note: c.isShorts
        ? "No transcript found. Shorts often don't have auto-captions. To capture spoken content: open the Short → three-dot menu → Captions, screenshot it, then use the Screenshot tab."
        : 'No transcript found (captions may be disabled). Add the spoken content manually in the notes field.',
    });
  }

  if (c.platform === 'tiktok') {
    const p = await paid();
    if (p.text) return done({ success: true, platform: label, transcript: p.text, source: 'supadata' });
    const caption = await tiktokOembed(c.canonical, ctx.deadline, ctx.fetchImpl);
    if (caption) {
      return done({
        success: true, platform: label, transcript: caption,
        note: transient(p) ? transientNote(p) : ctx.apiKey
          ? 'Supadata could not retrieve a spoken transcript — caption text returned instead.'
          : 'Spoken transcripts are not configured. Caption text returned for now.',
      }, !transient(p));
    }
    return done({ success: false, platform: label, transcript: '',
      note: transient(p) ? transientNote(p) : 'Could not retrieve transcript. The video may be private. Try pasting notes manually.' }, !transient(p));
  }

  // instagram
  const p = await paid();
  if (p.text) return done({ success: true, platform: label, transcript: p.text, source: 'supadata' });
  return done({
    success: false, platform: label, transcript: '',
    note: transient(p) ? transientNote(p) : ctx.apiKey
      ? 'Supadata could not retrieve a transcript for this Instagram video (may be private or a story).'
      : 'Instagram transcripts are not configured. Alternatively: play the video with captions on → screenshot → use the Screenshot tab.',
  }, !transient(p));
}

export default createHandler();
