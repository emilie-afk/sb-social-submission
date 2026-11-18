// Minimal structured logger. Only short primitive fields are logged; any configured
// secret value or private source id that slips into a field is replaced with [redacted].
// Never pass request bodies, cookies, passwords, images or provider responses here.

const SECRET_ENV = [
  'SITE_PASSWORD', 'SESSION_SIGNING_SECRET', 'CLAUDE_API_KEY', 'SUPADATA_API_KEY',
  'SUBMIT_TOKEN', 'GOOGLE_SHEET_ID', 'GOOGLE_SERVICE_ACCOUNT_JSON',
];

function secrets() {
  const out = [];
  for (const name of SECRET_ENV) {
    const v = process.env[name];
    if (v && v.length >= 6) out.push(v);
  }
  // The service-account private key and client email are also sensitive.
  try {
    const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
    if (sa.private_key) out.push(sa.private_key);
    if (sa.client_email) out.push(sa.client_email);
    if (sa.private_key_id) out.push(sa.private_key_id);
  } catch { /* ignore */ }
  return out;
}

export function redact(value) {
  let s = String(value);
  for (const secret of secrets()) {
    if (secret && s.includes(secret)) s = s.split(secret).join('[redacted]');
  }
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}

function clean(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (v === undefined) continue;
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
    else out[k] = redact(v);
  }
  return out;
}

function emit(level, event, fields) {
  const line = JSON.stringify({ level, event, ...clean(fields) });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function createLogger(scope) {
  return {
    info: (event, fields) => emit('info', `${scope}.${event}`, fields),
    warn: (event, fields) => emit('warn', `${scope}.${event}`, fields),
    error: (event, fields) => emit('error', `${scope}.${event}`, fields),
  };
}
