// Checks app/src/utils/diagRedact.ts against tests/fixtures/diag_redact_cases.json.
// Run by tests/test_diag_redact_frontend.py via `node --experimental-strip-types`
// (Node >= 22.6) or `bun`; can also be run by hand:
//   bun tests/js/diag_redact_check.mjs
// Prints one line per failure and exits non-zero if any case fails.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const { redactDiagnostics } = await import(
  pathToFileURL(join(root, 'app', 'src', 'utils', 'diagRedact.ts')).href);
const { cases } = JSON.parse(readFileSync(join(root, 'tests', 'fixtures', 'diag_redact_cases.json'), 'utf8'));

const failures = [];
for (const c of cases) {
  const out = redactDiagnostics(c.input, { names: c.names ?? [] });
  for (const s of c.absent) if (out.includes(s)) failures.push(`${c.id}: still contains ${JSON.stringify(s)} → ${JSON.stringify(out)}`);
  for (const s of c.present) if (!out.includes(s)) failures.push(`${c.id}: lost ${JSON.stringify(s)} → ${JSON.stringify(out)}`);
  const twice = redactDiagnostics(out, { names: c.names ?? [] });
  if (twice !== out) failures.push(`${c.id}: not idempotent → ${JSON.stringify(twice)}`);
}

// Same id → same placeholder; different ids → different placeholders.
const a = redactDiagnostics('wxid_aaa111 then wxid_aaa111 and wxid_bbb222').split(' ');
if (a[0] !== a[2]) failures.push(`stable tag: ${a[0]} != ${a[2]}`);
if (a[0] === a[4]) failures.push(`distinct tag: ${a[0]} == ${a[4]}`);
if (redactDiagnostics('') !== '') failures.push('empty input should pass through');

for (const f of failures) console.log(f);
console.log(`diagRedact: ${cases.length} cases, ${failures.length} failures`);
process.exit(failures.length ? 1 : 0);
