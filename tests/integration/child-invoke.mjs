// Runs one function invocation in a fresh Node process (fresh module state, no shared memory).
// Usage: node child-invoke.mjs <function> <json-options>
import { setTestEnv, request, ctx } from '../helpers.mjs';
const [, , fn, optsJson] = process.argv;
const opts = JSON.parse(optsJson);
setTestEnv();
const mod = await import(`../../netlify/functions/${fn}.mjs`);
const deps = {};
if (fn === 'analyze') deps.claude = () => ({ messages: { create: async () => ({ content: [{ type: 'text', text: '{"rawText":"x"}' }] }) } });
const handler = mod.createHandler(deps);
const res = await handler(request(fn, opts.request), ctx(opts.ip));
process.stdout.write(JSON.stringify({ status: res.status }));
