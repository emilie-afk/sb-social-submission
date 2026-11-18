// Forwards one signal to SB Content Intelligence (submit-signal).
// The submission token is sent only to the allow-listed endpoint; redirects are refused.
// The submission id travels as `Idempotency-Key` and `client_submission_id` so the
// dashboard can deduplicate retries (requires the companion change; ignored otherwise).

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const SAFE_RETRY_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function buildSignal(id, f, submittedAtIso) {
  return [{
    topic: f.rawInput,
    source_url: f.sourceUrl || null,
    platform: f.platform || null,
    creator_name: f.sourceName || null,
    date_found: submittedAtIso.slice(0, 10),
    status: 'New',
    is_manual: true,
    client_submission_id: id,
  }];
}

async function once({ endpoint, token, body, id, fetchImpl, timeoutMs }) {
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'Content-Type': 'application/json',
        'x-submission-token': token,
        'Idempotency-Key': id,
      },
      body,
    });
    let summary = {};
    try {
      const text = (await res.text()).slice(0, 65536);
      const data = JSON.parse(text);
      summary = {
        inserted: Number.isFinite(data.inserted) ? data.inserted : undefined,
        skipped: Number.isFinite(data.skipped) ? data.skipped : undefined,
      };
    } catch { /* body is not needed */ }
    if (res.ok) return { outcome: 'delivered', httpStatus: res.status, summary };
    return {
      outcome: RETRYABLE_STATUS.has(res.status) ? 'retryable' : 'rejected',
      httpStatus: res.status,
      safeToRepeat: res.status === 429 || res.status === 503,
    };
  } catch (err) {
    const code = err && (err.cause && err.cause.code || err.code);
    return { outcome: 'retryable', httpStatus: null, error: err && err.name === 'TimeoutError' ? 'timeout' : 'network', safeToRepeat: SAFE_RETRY_CODES.has(code) };
  }
}

/**
 * Bounded delivery: at most 2 attempts in one request, and the second only when the first
 * certainly did not reach the dashboard's processing (connection refused / DNS / 429 / 503).
 * A timeout is ambiguous, so it is never repeated automatically here.
 */
export async function forwardSignal({ endpoint, token, id, fields, submittedAtIso, fetchImpl = fetch, deadline = Date.now() + 7000 }) {
  const body = JSON.stringify(buildSignal(id, fields, submittedAtIso));
  const budget = () => Math.min(7000, deadline - Date.now());
  let r = await once({ endpoint, token, body, id, fetchImpl, timeoutMs: Math.max(500, budget()) });
  if (r.outcome !== 'delivered' && r.safeToRepeat && budget() > 2000) {
    await sleep(600);
    r = await once({ endpoint, token, body, id, fetchImpl, timeoutMs: budget() });
  }
  return r;
}
