import { afterEach, expect, it } from 'vitest';
import { defaultPreferences, outlineIndent, readPreferences, writePreferences } from '../src/ui/preferences';

afterEach(() => localStorage.clear());

it('keeps the existing layout as default and persists the opt-in density', () => {
  expect(readPreferences().density).toBe('standard');
  writePreferences({ ...defaultPreferences, density: 'compact' });
  expect(readPreferences().density).toBe('compact');
  writePreferences({ ...defaultPreferences, density: 'standard' });
  expect(readPreferences().density).toBe('standard');
});

it('falls back safely for old or invalid stored preferences', () => {
  localStorage.setItem('markdown-editor.b2-1.preferences', JSON.stringify({ theme: 'dark' }));
  expect(readPreferences()).toMatchObject({ theme: 'dark', density: 'standard' });
  localStorage.setItem('markdown-editor.b2-1.preferences', JSON.stringify({ density: 'unsupported' }));
  expect(readPreferences().density).toBe('standard');
});

it('reduces deep outline indentation without changing the current layout', () => {
  expect([1, 2, 6].map(level => outlineIndent(level, 'standard'))).toEqual([12, 28, 92]);
  expect([1, 2, 6].map(level => outlineIndent(level, 'compact'))).toEqual([10, 21, 65]);
});
