// Reusable gate for protected endpoints. Runs before any external service is touched.

import { errors, json } from './http.mjs';
import { verifySession, sameOrigin, csrfValid, clearCookie } from './session.mjs';
import { StoreError } from './store.mjs';

/**
 * Returns { session } when the request carries a valid, unexpired, unrevoked session
 * (and, for state-changing requests, a valid CSRF token from the same origin);
 * otherwise { response } with the refusal to return as-is.
 */
export async function requireSession(req, store, { csrf = true, env = process.env } = {}) {
  if (csrf && !sameOrigin(req)) return { response: errors.forbidden('cross_site') };
  let v;
  try {
    v = await verifySession(req, store, Date.now(), env);
  } catch (err) {
    if (err instanceof StoreError) return { response: errors.unavailable() };
    throw err;
  }
  if (!v.ok) {
    if (v.reason === 'not_configured') {
      return { response: errors.unavailable('Sign-in is not configured.', 'auth_not_configured') };
    }
    // Clear a stale/forged cookie so the browser shows the password screen.
    return {
      response: json(401, { error: 'Please sign in again.', code: 'auth_required' },
        { 'Set-Cookie': clearCookie() }),
    };
  }
  if (csrf && !csrfValid(req, v)) return { response: errors.forbidden('csrf') };
  return { session: v };
}
