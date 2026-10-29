// Scheduled every 15 minutes (Netlify Scheduled Function — not reachable as a public URL
// in production, and it accepts no input). Resumes submissions that are not complete:
// • sheet appends whose outcome was unknown are looked up by id; after the 10-minute
//   settle window an unseen append is retried once,
// • dashboard deliveries that certainly never arrived are retried,
// • `uncertain` dashboard deliveries are retried only when DASHBOARD_IDEMPOTENT=true
//   (set it after the Content Intelligence idempotency change is live).

import { sheetsConfig, dashboardEndpoint, submitToken, authConfig } from '../lib/config.mjs';
import { createSheetsClient } from '../lib/sheets.mjs';
import { forwardSignal } from '../lib/dashboard.mjs';
import { reconcilePending } from '../lib/submissions.mjs';
import { defaultStore } from '../lib/store.mjs';
import { createLogger } from '../lib/log.mjs';

const log = createLogger('reconcile');

export function createHandler(deps = {}) {
  const env = deps.env || process.env;
  return async () => {
    const deadline = Date.now() + 25_000; // scheduled functions may run 30 s
    // Maintenance mode (no valid sign-in configuration) also pauses the reconciler.
    if (!authConfig(env)) { log.warn('paused_not_configured'); return new Response(null, { status: 204 }); }
    const sCfg = sheetsConfig(env);
    if (!sCfg) { log.warn('sheets_not_configured'); return new Response(null, { status: 204 }); }
    let client = null;
    const sheets = () => (client ||= (deps.sheets ? deps.sheets(sCfg) : createSheetsClient(sCfg)));
    const endpoint = dashboardEndpoint(env);
    const token = submitToken(env);
    const forward = endpoint && token
      ? (args) => forwardSignal({ ...args, endpoint, token, fetchImpl: deps.fetch || ((...a) => fetch(...a)) })
      : null;
    try {
      const r = await reconcilePending({
        store: deps.store || defaultStore(), sheets, forward, deadline, log,
        retryUncertain: env.DASHBOARD_IDEMPOTENT === 'true',
        minAgeMs: deps.minAgeMs ?? 2 * 60 * 1000,
        clock: deps.now || Date.now,
      });
      log.info('done', r);
    } catch (err) {
      log.error('failed', { kind: err && err.name });
    }
    return new Response(null, { status: 204 });
  };
}

export default createHandler();
export const config = { schedule: '*/15 * * * *' };
