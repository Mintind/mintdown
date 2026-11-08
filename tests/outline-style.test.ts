import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDescription, buildInfo } from '../src/ui/buildInfo';

describe('outline presentation contract (computed styles verified by native-outline-style.mjs)', () => {
  const css = readFileSync(resolve('src/style.css'), 'utf8');
  it('shares one subtle active background without a stripe across both densities', () => {
    const active = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)]
      .filter(match => match[1].includes('.outline-list button.active'));
    expect(active).toHaveLength(1);
    expect(active[0][1].trim()).toBe('.outline-list button.active');
    expect(active[0][2]).toContain('background: color-mix(in srgb, var(--outline-active) 75%, var(--surface))');
    expect(active[0][2]).toContain('box-shadow: none');
    expect(active[0][2]).toContain('font-weight: var(--font-weight-ui-semibold)');
  });
  it('keeps hover temporary and excludes the active item', () => {
    expect(css).toContain('.outline-list button:hover:not(.active) { background: var(--outline-hover);');
    expect(css).not.toMatch(/\.outline-list button:hover\s*\{/);
  });
  it('uses d58ce8d compact tab highlights in both densities without a top line', () => {
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)];
    const active = rules.filter(m => m[1].includes('.document-tab:has([aria-selected="true"])'));
    expect(active).toHaveLength(1);
    expect(active[0][1].trim()).toBe('.document-tab:has([aria-selected="true"])');
    expect(active[0][2]).toContain('background: color-mix(in srgb, var(--page) 76%, var(--surface))');
    expect(active[0][2]).toContain('box-shadow: none');
    const hover = rules.filter(m => m[1].includes('.document-tab:hover'));
    expect(hover).toHaveLength(1);
    expect(hover[0][1].trim()).toBe('.document-tab:hover');
    expect(hover[0][2]).toContain('background: var(--outline-hover)');
    for (const r of rules.filter(m => m[1].includes('data-density') && /button\.active|document-tab:has|document-tab:hover|button:hover/.test(m[1])))
      expect(r[2]).not.toMatch(/(?:background|color|box-shadow|font-weight)\s*:/);
  });
  it('exposes revision, dirty flag, source digest and build channel rather than version alone', () => {
    expect(buildInfo.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(buildInfo.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(buildInfo.id).toContain(buildInfo.sourceSha256.slice(0, 12));
    expect(buildDescription()).toContain(buildInfo.revision);
    expect(buildDescription()).toContain(buildInfo.channel);
    expect(buildDescription()).toContain(buildInfo.builtAt);
    expect(typeof buildInfo.dirty).toBe('boolean');
  });
});
