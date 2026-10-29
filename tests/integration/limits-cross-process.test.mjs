// Usage limits hold across separate invocations (separate processes, no shared memory).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
import { fileURLToPath } from 'node:url';
import { startBlobs, setTestEnv, login, jpegB64 } from '../helpers.mjs';
import { createHandler as authH } from '../../netlify/functions/auth.mjs';
import { LIMITS } from '../../netlify/lib/limits.mjs';
import { defaultStore } from '../../netlify/lib/store.mjs';

const child = fileURLToPath(new URL('./child-invoke.mjs', import.meta.url));
let blobs;
before(async () => { blobs = await startBlobs(); setTestEnv(); });
after(async () => { await blobs.stop(); });

async function invoke(fn, opts) {
  const { stdout } = await run(process.execPath, [child, fn, JSON.stringify(opts)], { env: { ...process.env, ...blobs.env }, encoding: 'utf8', timeout: 20000 });
  return JSON.parse(stdout.trim().split('\n').pop());
}

test('failed-login limit is enforced across separate processes', async () => {
  const statuses = [];
  for (let i = 0; i < LIMITS.loginFailPerIp.limit + 1; i++) {
    statuses.push((await invoke('auth', { ip: '198.18.0.9', request: { body: { password: 'wrong-' + i } } })).status);
  }
  assert.deepEqual(statuses.slice(0, -1), Array(LIMITS.loginFailPerIp.limit).fill(401));
  assert.equal(statuses.at(-1), 429);
});

test('analyze session limit is enforced across separate processes', async () => {
  const s = await login(authH(), '198.18.0.10');
  // Pre-fill the counter to one below the limit, then cross it in two fresh processes.
  const { consume } = await import('../../netlify/lib/limits.mjs');
  const sid = /v1\.([A-Za-z0-9_-]{32})/.exec(s.cookie)[1];
  for (let i = 0; i < LIMITS.analyzePerSession.limit - 1; i++) await consume(defaultStore(), 'analyzePerSession', sid);
  const req = { body: { images: [{ base64: jpegB64(), mimeType: 'image/jpeg' }] }, cookie: s.cookie, csrf: s.csrf };
  assert.equal((await invoke('analyze', { ip: '198.18.0.10', request: req })).status, 200);
  assert.equal((await invoke('analyze', { ip: '198.18.0.10', request: req })).status, 429);
});
