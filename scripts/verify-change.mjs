import { spawnSync } from 'node:child_process';
import { checkTask } from './change-guard.mjs';
const args = process.argv.slice(2), task = args[args.indexOf('--task') + 1];
if (!args.includes('--task')) throw Error('Use --task <manifest.json> [--native | --native-styles] [--snapshot <start.json>].');
const result = checkTask(task, args.includes('--snapshot') ? args[args.indexOf('--snapshot') + 1] : undefined);
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exit(2);
const stylesOnly = args.includes('--native-styles');
if (stylesOnly && result.changes.some(c => /^(src\/|src-tauri\/)/.test(c.path) &&
    !['src/style.css', 'src/styles/theme-colors.css', 'src/styles/typography.css'].includes(c.path))) {
  console.error('BLOCKED: --native-styles only validates current CSS. Changed application logic/components require --native with a current isolated build.');
  process.exit(2);
}
if (result.unitTests.length) {
  const run = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...result.unitTests, '--maxWorkers=1', '--testTimeout=15000'], { stdio: 'inherit', windowsHide: true });
  if (run.status !== 0) process.exit(run.status || 1);
}
if (result.visualRequired) {
  if (!args.includes('--native') && !stylesOnly) { console.error('PENDING: affected visual baseline requires --native (CSS-only tasks may use --native-styles). No visual pass claimed.'); process.exit(2); }
  const run = spawnSync(process.execPath, [stylesOnly ? 'tests/protection/highlight-guard.mjs' : 'tests/native-ui-guard.mjs'], { stdio: 'inherit', windowsHide: true });
  if (run.status !== 0) process.exit(run.status || 1);
}
console.log('PASS: scoped automated checks. Manual items above remain review obligations, not automatic passes.');
