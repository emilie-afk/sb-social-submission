// POST /.netlify/functions/save
// { submissionId, rawInput, sourceUrl, platform, sourceName, submittedBy }
// Records the submission in the Intake sheet and forwards it to SB Content Intelligence.
// "Submitted by" is self-reported attribution typed by the user, not a verified identity.

import { json, errors, readJson, wrap } from '../lib/http.mjs';
import { requireSession } from '../lib/guard.mjs';
import { consumeAll } from '../lib/limits.mjs';
import { sheetsConfig, dashboardEndpoint, submitToken, functionBudgetMs } from '../lib/config.mjs';
import { cleanText, singleLine } from '../lib/text.mjs';
import { validateSourceUrl } from '../lib/urls.mjs';
import { createSheetsClient } from '../lib/sheets.mjs';
import { forwardSignal } from '../lib/dashboard.mjs';
import { processSubmission } from '../lib/submissions.mjs';
import { defaultStore, StoreError } from '../lib/store.mjs';
import { createLogger } from '../lib/log.mjs';

const log = createLogger('save');

export const PLATFORMS = ['', 'Instagram', 'TikTok', 'Facebook', 'YouTube', 'Pinterest', 'Other'];
export const MAX_RAW_INPUT = 40000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function validateSave(body) {
  const id = String(body.submissionId || '').toLowerCase();
  if (!UUID.test(id)) return { ok: false, message: 'Missing submission id — reload the page and try again.' };
  const rawInput = cleanText(body.rawInput, MAX_RAW_INPUT + 1);
  if (!rawInput) return { ok: false, message: 'Raw input is required.' };
  if (rawInput.length > MAX_RAW_INPUT) return { ok: false, message: `Raw input is too long (max ${MAX_RAW_INPUT} characters).` };
  const src = validateSourceUrl(body.sourceUrl);
  if (!src.ok) return { ok: false, message: `Source link: ${src.message}` };
  const platform = singleLine(body.platform, 40);
  if (!PLATFORMS.includes(platform)) return { ok: false, message: 'Unknown platform.' };
  return {
    ok: true, id,
    fields: {
      rawInput,
      sourceUrl: src.value,
      platform,
      sourceName: singleLine(body.sourceName, 200),
      submittedBy: singleLine(body.submittedBy, 100),
    },
  };
}

export function createHandler(deps = {}) {
  const env = deps.env || process.env;
  return wrap(async (req, context) => {
    if (req.method !== 'POST') return errors.methodNotAllowed();
    const deadline = Date.now() + (deps.budgetMs || functionBudgetMs(env));
    const store = deps.store || defaultStore();
    const gate = await requireSession(req, store, { env });
    if (gate.response) return gate.response;

    const body = await readJson(req, 256 * 1024);
    const v = validateSave(body);
    if (!v.ok) return errors.badRequest(v.message, 'invalid_submission');

    const sCfg = sheetsConfig(env);
    if (!sCfg) {
      log.error('sheets_not_configured');
      return errors.unavailable('Saving is not configured.', 'not_configured');
    }

    try {
      const lim = await consumeAll(store, [['savePerSession', gate.session.sid], ['saveGlobal', 'all']]);
      if (!lim.allowed) return errors.rateLimited(lim.retryAfterSec, 'Save limit reached — please try again later.');

      let client = null;
      const sheets = () => (client ||= (deps.sheets ? deps.sheets(sCfg) : createSheetsClient(sCfg)));
      const endpoint = dashboardEndpoint(env);
      const token = submitToken(env);
      if (!endpoint) log.error('dashboard_url_rejected');
      const forward = endpoint && token
        ? (args) => forwardSignal({ ...args, endpoint, token, fetchImpl: deps.fetch || ((...a) => fetch(...a)) })
        : null;

      const r = await processSubmission({ id: v.id, fields: v.fields, store, sheets, forward, now: deps.now ? deps.now() : Date.now(), deadline, log });
      log.info('done', { status: r.status, dashboard: r.body.dashboard && r.body.dashboard.state });

      return json(r.status, r.body);
    } catch (err) {
      if (err instanceof StoreError) {
        log.error('store', { reason: err.message });
        return errors.unavailable('Could not save right now — your entry is still in the form. Please retry.');
      }
      throw err;
    }
  }, log);
}

export default createHandler();
