// POST /.netlify/functions/logout → revokes the server-side session and clears the cookie.

import { json, errors, wrap } from '../lib/http.mjs';
import { requireSession } from '../lib/guard.mjs';
import { clearCookie, revokeSession } from '../lib/session.mjs';
import { defaultStore } from '../lib/store.mjs';
import { createLogger } from '../lib/log.mjs';

const log = createLogger('logout');

export function createHandler(deps = {}) {
  return wrap(async (req) => {
    if (req.method !== 'POST') return errors.methodNotAllowed();
    const store = deps.store || defaultStore();
    const gate = await requireSession(req, store, { csrf: true, env: deps.env || process.env });
    if (gate.response) {
      // Already signed out (or forged cookie): just clear the cookie.
      if (gate.response.status === 401) return json(200, { success: true }, { 'Set-Cookie': clearCookie() });
      return gate.response;
    }
    await revokeSession(store, gate.session.sid);
    log.info('ok');
    return json(200, { success: true }, { 'Set-Cookie': clearCookie() });
  }, log);
}

export default createHandler();
