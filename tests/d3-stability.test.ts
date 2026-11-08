import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('keeps recovery commands inside the same isolated storage as sessions and draft images', () => {
  const source = readFileSync('src-tauri/src/lib.rs', 'utf8');
  for (const name of ['load_recovery', 'save_recovery', 'clear_recovery']) {
    const start = source.indexOf(`fn ${name}(`), end = source.indexOf('\n}', start);
    expect(source.slice(start, end)).toContain('session_data(&app)');
    expect(source.slice(start, end)).not.toContain('app_data(&app)');
  }
});
