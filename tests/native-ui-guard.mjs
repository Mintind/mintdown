import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '..');
const expectedBinary = join(root, 'src-tauri/target/interaction-isolated/debug/markdown-editor-kit.exe');
if (process.env.NATIVE_TEST_BINARY && resolve(process.env.NATIVE_TEST_BINARY) !== expectedBinary)
  throw Error('Refusing an arbitrary/installed application. Build the isolated native interaction target.');
if (!existsSync(expectedBinary)) throw Error('Isolated native test binary is missing; see docs/BEHAVIOR_BASELINES.md.');
if (!readFileSync(expectedBinary).includes(Buffer.from('com.markdowneditor.kit.nativeinteractiontest')))
  throw Error('Isolated test identifier missing from binary; refusing to risk forwarding files to a user instance.');
const port = Number(process.env.NATIVE_DEBUG_PORT || 9417);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid isolated debugging port');
await new Promise((done, fail) => { const server = createServer(); server.once('error', fail);
  server.listen(port, '127.0.0.1', () => server.close(done)); });
if (process.argv.slice(2).some(arg => arg !== '--prove-mutation')) throw Error('Only --prove-mutation is supported; there is no update-baseline option.');
const output = join(root, 'tests/.layout-evidence', `ui-guard-${randomUUID()}`);
mkdirSync(output, { recursive: true });
process.env.OUTLINE_EVIDENCE = output;
process.env.OUTLINE_PHASE = 'fixed';
process.env.MINTDOWN_UI_GUARD = '1';
if (process.argv.includes('--prove-mutation')) process.env.MINTDOWN_UI_PROVE_MUTATION = '1';
console.log(`Actual results only (baseline is read-only): ${output}`);
const baselineFolder = join(root, 'tests/baselines/ui');
const baselineHashes = () => existsSync(baselineFolder) ? Object.fromEntries(readdirSync(baselineFolder).sort().map(name =>
  [name, createHash('sha256').update(readFileSync(join(baselineFolder, name))).digest('hex')])) : {};
const before = baselineHashes();
try {
  // Protect all Active/Hover states in both themes/densities, then validate the
  // freshly built application and its remaining UI/interaction baselines.
  await import('./protection/highlight-guard.mjs');
  await import('./native-outline-style.mjs');
}
finally { assert.deepEqual(baselineHashes(), before, 'Regression run must not rewrite its expected screenshots or values'); }
console.log('Expected screenshots and computed baselines unchanged.');
if (process.env.MINTDOWN_UI_CAPTURE === '1') { console.error('CAPTURE ONLY: initial candidates require review; no regression pass claimed.'); process.exitCode = 2; }
