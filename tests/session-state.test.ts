import { afterEach, expect, it } from 'vitest';
import { validPosition } from '../src/native/sessionBridge';
import { defaultPreferences, readPreferences, writePreferences } from '../src/ui/preferences';

afterEach(() => localStorage.clear());

it('restores the saved cursor and scroll while rejecting invalid session coordinates', () => {
  expect(validPosition({ anchor: 28, head: 34, scrollTop: 451.75 }))
    .toEqual({ anchor: 28, head: 34, scrollTop: 451.75 });
  expect(validPosition({ anchor: -4, head: Number.POSITIVE_INFINITY, scrollTop: Number.NaN }))
    .toEqual({ anchor: 0, head: 0, scrollTop: 0 });
});

it('enables startup restoration by default and persists an explicit opt-out', () => {
  expect(readPreferences().restoreLastSession).toBe(true);
  writePreferences({ ...defaultPreferences, restoreLastSession: false });
  expect(readPreferences().restoreLastSession).toBe(false);
});
