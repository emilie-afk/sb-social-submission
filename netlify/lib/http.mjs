// Shared HTTP helpers for the Netlify Functions (v2 format: Request -> Response).
// Responses never echo credentials, provider messages or stack traces.

const BASE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export function json(status, body, extraHeaders = {}) {
  const headers = new Headers(BASE_HEADERS);
  for (const [k, v] of Object.entries(extraHeaders)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined && v !== null) headers.set(k, String(v));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export const errors = {
  methodNotAllowed: () => json(405, { error: 'Method not allowed.' }),
  unauthorized: (code = 'auth_required') =>
    json(401, { error: 'Please sign in again.', code }),
  forbidden: (code = 'forbidden') => json(403, { error: 'Request refused.', code }),
  badRequest: (message = 'Invalid request.', code = 'bad_request') =>
    json(400, { error: message, code }),
  tooLarge: (message = 'Request is too large.') => json(413, { error: message, code: 'too_large' }),
  rateLimited: (retryAfterSec, message = 'Too many requests — please try again later.') =>
    json(429, { error: message, code: 'rate_limited', retryAfter: retryAfterSec },
      { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSec || 60))) }),
  unavailable: (message = 'Service is temporarily unavailable.', code = 'unavailable') =>
    json(503, { error: message, code }),
  upstream: (message = 'An external service failed — please try again.', code = 'upstream_error') =>
    json(502, { error: message, code }),
};

export class HttpError extends Error {
  constructor(response) {
    super('http_error');
    this.response = response;
  }
}

/**
 * Read and parse a JSON body with a hard byte limit. Requires a JSON content type
 * (a non-simple content type also forces a CORS preflight for cross-site callers).
 */
export async function readJson(req, maxBytes) {
  const ct = (req.headers.get('content-type') || '').toLowerCase();
  if (!ct.startsWith('application/json')) {
    throw new HttpError(json(415, { error: 'Content-Type must be application/json.', code: 'unsupported_media_type' }));
  }
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(errors.tooLarge());

  let received = 0;
  const chunks = [];
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new HttpError(errors.tooLarge());
      }
      chunks.push(value);
    }
  }
  const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  try {
    const parsed = JSON.parse(text || 'null');
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
    return parsed;
  } catch {
    throw new HttpError(errors.badRequest('Invalid JSON body.', 'invalid_json'));
  }
}

/** Client IP as seen by Netlify (context.ip), falling back to the Netlify header. */
export function clientIp(req, context) {
  return (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || 'unknown';
}

/** Wrap a handler so unexpected errors become a generic 500 and HttpError short-circuits. */
export function wrap(fn, log) {
  return async (req, context) => {
    try {
      return await fn(req, context);
    } catch (err) {
      if (err instanceof HttpError) return err.response;
      log.error('unhandled', { kind: err && err.name });
      return json(500, { error: 'Something went wrong — please try again.', code: 'internal' });
    }
  };
}
