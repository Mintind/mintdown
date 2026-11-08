import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { matches, review, type Snapshot } from '../scripts/change-guard.mjs';

const snapshot = (files: Record<string, string>, index = {}): Snapshot => ({ head: 'same-head',
  files: Object.fromEntries(Object.entries(files).map(([path, text]) => [path, { sha256: text, text }])), index });
const task = { task: '定向测试', allowed: [{ pattern: 'tests/**', reason: '必要验证' }, { pattern: 'src/style.css', reason: '用户指定行高' }] };
const areas = [{ id: 'UI', label: '界面', paths: ['src/style.css'], shared: true, visual: true, unitTests: ['tests/outline-style.test.ts'] }];

it('distinguishes inherited dirty content from this task changes', () => {
  const before = snapshot({ 'src/style.css': 'already dirty', 'tests/a.ts': 'old' });
  const result = review(before, snapshot({ 'src/style.css': 'already dirty', 'tests/a.ts': 'new' }),
    { ...task, reviews: { 'tests/a.ts': '新增回归，保留原断言' } }, areas);
  expect(result.passed).toBe(true);
  expect(result.changes.map((c: any) => c.path)).toEqual(['tests/a.ts']);
});
it('flags undeclared files for review instead of authorizing unrelated changes', () => {
  const result = review(snapshot({}), snapshot({ 'src/export/render.ts': 'unrelated' }), task, areas);
  expect(result.passed).toBe(false);
  expect(result.issues.some((i: any) => i.message.includes('Outside declared scope'))).toBe(true);
});
it('allows explained direct dependencies without a mechanical file count limit', () => {
  const files = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`tests/new-${i}.ts`, 'new']));
  expect(review(snapshot({}), snapshot(files), task, areas).passed).toBe(true);
});
it('requires review of shared styles and maps affected tests', () => {
  const result = review(snapshot({ 'src/style.css': '.a { color:red; }' }), snapshot({ 'src/style.css': '.a { color:blue; }' }), task, areas);
  expect(result.passed).toBe(false); expect(result.visualRequired).toBe(true);
  expect(result.unitTests).toContain('tests/outline-style.test.ts');
  expect(result.changes[0].cssRuleHints).toContain('.a');
});
it('does not let an allow-list override an explicit unchanged requirement', () => {
  const result = review(snapshot({ 'src/style.css': 'a' }), snapshot({ 'src/style.css': 'b' }),
    { ...task, unchanged: ['src/**'], reviews: { 'src/style.css': 'reviewed' } }, areas);
  expect(result.passed).toBe(false); expect(result.issues[0].kind).toBe('blocked');
});
it('blocks expectation changes without a specific user requirement reference', () => {
  const before = snapshot({ 'tests/baselines/a.json': 'correct' }), after = snapshot({ 'tests/baselines/a.json': 'weakened' });
  expect(review(before, after, task, []).passed).toBe(false);
  expect(review(before, after, { ...task, baselineApproval: { userRequirement: '本次用户明确改变该项设计，需人工复核此引用' } }, []).passed).toBe(true);
});
it('flags test weakening and stage-only changes', () => {
  expect(review(snapshot({ 'tests/a.ts': 'assert' }), snapshot({ 'tests/a.ts': '' }), task, []).passed).toBe(false);
  const before = snapshot({ 'src/style.css': 'same' }, { 'src/style.css': 'old blob' });
  const result = review(before, snapshot({ 'src/style.css': 'same' }, { 'src/style.css': 'new blob' }), task, areas);
  expect(result.passed).toBe(false); expect(result.changes[0].kind).toBe('index-only');
});
it('rejects unexplained declarations and detects changed HEAD', () => {
  expect(() => review(snapshot({}), snapshot({}), { task: 'bad', allowed: [{ pattern: '**' }] }, [])).toThrow();
  expect(review(snapshot({}), { ...snapshot({}), head: 'new-head' }, task, []).passed).toBe(false);
});
it('matches path boundaries and keeps the map tied to real test files', () => {
  expect(matches('src/style.css', 'src/**')).toBe(true);
  expect(matches('other/src/style.css', 'src/**')).toBe(false);
  expect(matches('src/editor/nested/file.ts', 'src/editor/*.ts')).toBe(false);
  const map = JSON.parse(readFileSync('scripts/protected-behaviors.json', 'utf8'));
  for (const area of map) for (const file of area.unitTests) expect(readFileSync(file).length).toBeGreaterThan(0);
});
