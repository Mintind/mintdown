import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (root, args) => execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, ...args],
  { cwd: root, encoding: 'utf8', windowsHide: true });
export function matches(path, pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*');
  return new RegExp(`^${escaped}$`).test(path);
}
export function capture(root = project) {
  const paths = [...new Set(git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))];
  const files = {};
  for (const path of paths) {
    try { const bytes = readFileSync(resolve(root, path)); files[path] = { sha256: hash(bytes),
      ...(!bytes.includes(0) ? { text: bytes.toString('utf8') } : {}) }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const index = Object.fromEntries(git(root, ['ls-files', '--stage', '-z']).split('\0').filter(Boolean).map(row => {
    const at = row.indexOf('\t'); return [row.slice(at + 1), row.slice(0, at)];
  }));
  return { schema: 1, createdAt: new Date().toISOString(), head: git(root, ['rev-parse', 'HEAD']).trim(), files, index };
}
export function review(before, after, task, areas) {
  if (!task.task || !task.allowed?.length || task.allowed.some(item => !item.pattern || !item.reason))
    throw Error('Task manifest requires task and allowed[{pattern, reason}]; a file count is not a scope declaration.');
  const changes = [], issues = [], impacted = new Set();
  if (before.head !== after.head) issues.push({ kind: 'review', message: 'HEAD changed during task; compare the intervening commits before continuing.' });
  for (const path of [...new Set([...Object.keys(before.files), ...Object.keys(after.files), ...Object.keys(before.index || {}), ...Object.keys(after.index || {})])].sort()) {
    const indexChanged = before.index && after.index && before.index[path] !== after.index[path];
    if (before.files[path]?.sha256 === after.files[path]?.sha256 && !indexChanged) continue;
    const permission = task.allowed.find(item => matches(path, item.pattern));
    const hits = areas.filter(area => area.paths.some(pattern => matches(path, pattern)));
    hits.forEach(area => impacted.add(area.id));
    const change = { path, kind: before.files[path]?.sha256 === after.files[path]?.sha256 ? 'index-only' : !before.files[path] ? 'added' : !after.files[path] ? 'deleted' : 'modified',
      reason: permission?.reason ?? null, areas: hits.map(area => area.id) };
    if (path.endsWith('.css')) {
      const selectors = text => [...(text || '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => m[0].trim());
      const oldRules = selectors(before.files[path]?.text), newRules = selectors(after.files[path]?.text);
      change.cssRuleHints = [...oldRules.filter(rule => !newRules.includes(rule)), ...newRules.filter(rule => !oldRules.includes(rule))]
        .map(rule => rule.slice(0, rule.indexOf('{')).trim());
    }
    changes.push(change);
    if (!permission) issues.push({ path, kind: 'review', message: 'Outside declared scope; script cannot authorize this change.' });
    if (task.unchanged?.some(pattern => matches(path, pattern)))
      issues.push({ path, kind: 'blocked', message: 'Task explicitly requires this file to remain unchanged.' });
    if (matches(path, 'tests/baselines/**') && !task.baselineApproval?.userRequirement)
      issues.push({ path, kind: 'blocked', message: 'Protected expectation changed without an explicit user requirement reference.' });
    if (hits.some(area => area.shared) && !task.reviews?.[path])
      issues.push({ path, kind: 'review', message: 'Shared style/component changed: review property-level scope, both themes/densities and data invariants.' });
    if (/^(src\/|src-tauri\/)/.test(path) && !hits.length)
      issues.push({ path, kind: 'review', message: 'Unmapped application module; select affected behavior tests manually.' });
    if (/^tests\//.test(path) && before.files[path] && !task.reviews?.[path] && !matches(path, 'tests/baselines/**'))
      issues.push({ path, kind: 'review', message: 'Existing test changed; verify assertions were not weakened to hide a regression.' });
  }
  const selected = areas.filter(area => impacted.has(area.id));
  return { task: task.task, passed: issues.length === 0, changes, issues,
    affectedBaselines: selected.map(area => ({ id: area.id, label: area.label })),
    unitTests: [...new Set([...selected.flatMap(area => area.unitTests), ...(task.relatedTests || [])])],
    visualRequired: selected.some(area => area.visual),
    manualChecks: [...new Set(selected.flatMap(area => area.manualChecks || []))],
    note: 'Scope matching and declared reviews are evidence for review, not proof of user approval or behavioral correctness. CSS hints are heuristic.' };
}
export function checkTask(taskPath, snapshotPath, root = project) {
  const task = JSON.parse(readFileSync(resolve(root, taskPath), 'utf8'));
  const pointer = resolve(root, 'tests/.layout-evidence/change-guard/latest.json');
  const snapshot = snapshotPath || JSON.parse(readFileSync(pointer, 'utf8')).snapshot;
  const before = JSON.parse(readFileSync(resolve(root, snapshot), 'utf8')), after = capture(root);
  const areas = JSON.parse(readFileSync(resolve(root, 'scripts/protected-behaviors.json'), 'utf8'));
  const result = review(before, after, task, areas);
  const diffPaths = git(root, ['diff', '--no-ext-diff', '--name-only', '--no-renames', '-z', 'HEAD']).split('\0').filter(Boolean);
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  result.inheritedChanges = [...new Set([...diffPaths, ...untracked])].filter(path => !result.changes.some(c => c.path === path));
  result.snapshot = snapshot;
  result.reviews = task.reviews || {};
  result.baselineApproval = task.baselineApproval || null;
  const output = resolve(root, 'tests/.layout-evidence/change-guard/report.json');
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(result, null, 2));
  return result;
}
export function main(args = process.argv.slice(2)) {
  const option = name => args[args.indexOf(name) + 1];
  if (args.includes('--begin')) {
    const state = capture(), folder = resolve(project, 'tests/.layout-evidence/change-guard');
    mkdirSync(folder, { recursive: true });
    const snapshot = `tests/.layout-evidence/change-guard/start-${Date.now()}.json`;
    writeFileSync(resolve(project, snapshot), JSON.stringify(state, null, 2));
    writeFileSync(resolve(folder, 'latest.json'), JSON.stringify({ snapshot }));
    console.log(`Captured pre-task snapshot: ${snapshot}`); return;
  }
  if (!args.includes('--task')) throw Error('Use --begin before editing; then --task <manifest.json> [--snapshot <start.json>].');
  const result = checkTask(option('--task'), args.includes('--snapshot') ? option('--snapshot') : undefined);
  console.log(JSON.stringify(result, null, 2)); process.exitCode = result.passed ? 0 : 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
