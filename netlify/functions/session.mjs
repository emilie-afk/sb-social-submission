// GET /.netlify/functions/session → restores the signed-in state after a reload.
// Returns the CSRF token for this session; the browser keeps it in memory only.

import { json, errors, wrap } from '../lib/http.mjs';
import { requireSession } from '../lib/guard.mjs';
import { csrfFor } from '../lib/session.mjs';
import { defaultStore } from '../lib/store.mjs';
import { createLogger } from '../lib/log.mjs';

const log = createLogger('session');

export function createHandler(deps = {}) {
  return wrap(async (req) => {
    if (req.method !== 'GET') return errors.methodNotAllowed();
    const gate = await requireSession(req, deps.store || defaultStore(), { csrf: false, env: deps.env || process.env });
    if (gate.response) return gate.response;
    const { sid, exp, cfg } = gate.session;
    return json(200, { authenticated: true, expiresAt: exp, csrfToken: csrfFor(cfg, sid) });
  }, log);
}

export default createHandler();
