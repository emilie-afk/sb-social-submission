// Production build check: bundles every function with Netlify's own bundler
// (zip-it-and-ship-it; v2 functions are traced with nft), then unzips each bundle
// into a clean directory and imports it to prove it loads with only its bundled files.
import { zipFunctions } from '@netlify/zip-it-and-ship-it';
import { mkdirSync, rmSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Minimal stand-in for the AWS Lambda runtime global the Netlify bootstrap expects.
globalThis.awslambda = { streamifyResponse: (fn) => fn, HttpResponseStream: { from: (stream) => stream } };

const root = resolve(new URL('..', import.meta.url).pathname);
const out = join(root, '.build');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const results = await zipFunctions(join(root, 'netlify/functions'), out, {
  basePath: root,
});
let failed = 0;
for (const fn of results) {
  const dir = join(out, 'unzipped', fn.name);
  mkdirSync(dir, { recursive: true });
  execFileSync('unzip', ['-q', '-o', fn.path, '-d', dir]);
  const entry = readdirSync(dir).find((f) => f === '___netlify-entry-point.mjs');
  try {
    if (!entry) throw new Error('entry point missing');
    const mod = await import(pathToFileURL(join(dir, entry)).href);
    if (typeof mod.handler !== 'function') throw new Error('no handler export');
    // The bundled function module itself must expose a v2 default handler.
    const inner = await import(pathToFileURL(join(dir, 'netlify/functions', `${fn.name}.mjs`)).href);
    if (typeof inner.default !== 'function') throw new Error('no default export');
    console.log(`ok   ${fn.name.padEnd(20)} runtime=v${fn.runtimeAPIVersion} bundler=${fn.bundler} size=${(fn.size / 1024).toFixed(0)}KB`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${fn.name}: ${err.message}`);
  }
}
if (results.length !== 7) { console.log(`expected 7 functions, got ${results.length}`); failed++; }
process.exit(failed ? 1 : 0);
