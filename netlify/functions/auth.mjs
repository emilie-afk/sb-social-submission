// POST /.netlify/functions/auth  { password }  → sets the session cookie.
// The password is validated server-side only; it is never returned, stored or logged.

import { json, errors, readJson, clientIp, wrap } from '../lib/http.mjs';
import { authConfig } from '../lib/config.mjs';
import { createSession, passwordMatches, sameOrigin, sweepSessions } from '../lib/session.mjs';
import { consume, refund, ipScope, sweepExpired } from '../lib/limits.mjs';
import { defaultStore, StoreError } from '../lib/store.mjs';
import { createLogger } from '../lib/log.mjs';

const log = createLogger('auth');

export function createHandler(deps = {}) {
  return wrap(async (req, context) => {
    if (req.method !== 'POST') return errors.methodNotAllowed();
    if (!sameOrigin(req)) return errors.forbidden('cross_site');

    const cfg = authConfig(deps.env || process.env);
    if (!cfg) {
      log.warn('not_configured');
      return errors.unavailable('Sign-in is not configured.', 'auth_not_configured');
    }
    const body = await readJson(req, 4 * 1024);
    const store = deps.store || defaultStore();
    const ip = ipScope(clientIp(req, context));
    const now = deps.now ? deps.now() : Date.now();

    try {
      // Reserve the attempt atomically *before* comparing, so parallel requests cannot
      // all slip past the check. A correct password refunds the reservation.
      const perIp = await consume(store, 'loginFailPerIp', ip, now);
      if (!perIp.allowed) {
        log.warn('locked', { bucket: 'loginFailPerIp' });
        return errors.rateLimited(perIp.retryAfterSec, 'Too many sign-in attempts — please wait and try again.');
      }
      const global = await consume(store, 'loginFailGlobal', 'all', now);
      if (!global.allowed) {
        await refund(store, 'loginFailPerIp', ip, now);
        log.warn('locked', { bucket: 'loginFailGlobal' });
        return errors.rateLimited(global.retryAfterSec, 'Too many sign-in attempts — please wait and try again.');
      }

      if (!passwordMatches(body.password, cfg)) {
        log.info('failed');
        return json(401, { error: 'Incorrect password.', code: 'bad_password' });
      }
      // Best effort: a refund failure must not block a correct sign-in.
      await refund(store, 'loginFailPerIp', ip, now).catch(() => {});
      await refund(store, 'loginFailGlobal', 'all', now).catch(() => {});

      const s = await createSession(store, cfg, now);
      log.info('ok');
      // Opportunistic housekeeping; never blocks sign-in.
      const sweep = Promise.allSettled([
        sweepSessions(store, now), sweepExpired(store, now),
        // Transcript cache / job entries are retired with conditional writes (never deleted).
        store.retire('tx/', (d) => !(d.expiresAt > now), { expiresAt: 0 }),
        store.retire('txjob/', (d) => !(d.expiresAt > now), { expiresAt: 0 }),
      ]);
      if (context && typeof context.waitUntil === 'function') context.waitUntil(sweep);
      return json(200, { success: true, csrfToken: s.csrfToken, expiresAt: s.exp }, { 'Set-Cookie': s.cookie });
    } catch (err) {
      if (err instanceof StoreError) {
        log.error('store', { reason: err.message });
        return errors.unavailable();
      }
      throw err;
    }
  }, log);
}

export default createHandler();
