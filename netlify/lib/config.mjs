// Server-side configuration. Values come only from Netlify environment variables
// (Functions scope). Nothing here is ever sent to the browser.

export const DASHBOARD_ALLOWED_HOSTS = ['sb-content-intelligence.netlify.app'];
export const DASHBOARD_DEFAULT = 'https://sb-content-intelligence.netlify.app';
export const SUBMIT_SIGNAL_PATH = '/.netlify/functions/submit-signal';

/** Login + session secrets. Returns null when missing/unsafe → callers deny access. */
export function authConfig(env = process.env) {
  const password = env.SITE_PASSWORD || '';
  const signingSecret = env.SESSION_SIGNING_SECRET || '';
  if (!password || password.length < 8) return null;
  if (!signingSecret || signingSecret.length < 32) return null;
  if (signingSecret === password || signingSecret.includes(password)) return null;
  return { password, signingSecret, epoch: String(env.SESSION_EPOCH || '0').slice(0, 64) };
}

/**
 * Dashboard destination. Only an https URL on an allow-listed host is accepted, so a
 * misconfigured DASHBOARD_URL cannot turn save into an arbitrary forwarding endpoint
 * (the submission token is only ever sent to this exact origin + path).
 */
export function dashboardEndpoint(env = process.env) {
  const base = env.DASHBOARD_URL || DASHBOARD_DEFAULT;
  let u;
  try { u = new URL(base); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  if (!DASHBOARD_ALLOWED_HOSTS.includes(u.hostname.toLowerCase())) return null;
  return `https://${u.hostname.toLowerCase()}${SUBMIT_SIGNAL_PATH}`;
}

export function submitToken(env = process.env) {
  const t = env.SUBMIT_TOKEN || '';
  return t.length >= 16 ? t : null;
}

export function sheetsConfig(env = process.env) {
  const sheetId = env.GOOGLE_SHEET_ID || '';
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(sheetId)) return null;
  let credentials;
  try { credentials = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON || ''); } catch { return null; }
  if (!credentials || !credentials.client_email || !credentials.private_key) return null;
  return { sheetId, credentials };
}

export function claudeKey(env = process.env) {
  return env.CLAUDE_API_KEY || null;
}

export function supadataKey(env = process.env) {
  return env.SUPADATA_API_KEY || null;
}

/**
 * Time budget for one function invocation. Netlify's synchronous functions stop after
 * 10 s by default; set FUNCTION_TIMEOUT_SEC only if the site's limit was raised (max 26).
 * Work is planned to finish ~1.5 s before the platform limit.
 */
export function functionBudgetMs(env = process.env) {
  const sec = Math.min(26, Math.max(10, Number(env.FUNCTION_TIMEOUT_SEC) || 10));
  return sec * 1000 - 1500;
}
