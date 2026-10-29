// Syntax + module-load check for every function and library file.
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const files = [
  ...readdirSync('netlify/functions').map((f) => `netlify/functions/${f}`),
  ...readdirSync('netlify/lib').map((f) => `netlify/lib/${f}`),
];
for (const f of files) execFileSync(process.execPath, ['--check', f]);
for (const f of files) await import(new URL(`../${f}`, import.meta.url));
console.log(`checked ${files.length} files`);
