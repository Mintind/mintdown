import { expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { assertLayout, assertMetrics, assertOutline, assertTab } from './protection/ui-contract.mjs';
import { comparePng } from './protection/png.mjs';

it('rejects a vivid row fill, transparent active state and the obsolete stripe', () => {
  const good = { backgroundColor: 'color(srgb 0.189216 0.237255 0.357843)', boxShadow: 'none', fontWeight: '600' };
  expect(() => assertOutline(good, { fontWeight: '400' })).not.toThrow();
  expect(() => assertOutline({ ...good, backgroundColor: 'color(srgb 0.879412 0.940196 0.913725)' }, { fontWeight: '400' })).not.toThrow();
  for (const backgroundColor of ['rgb(41, 46, 64)', 'rgb(54, 69, 104)', 'rgba(0, 0, 0, 0)'])
    expect(() => assertOutline({ ...good, backgroundColor }, { fontWeight: '400' })).toThrow(/d58ce8d compact/);
  expect(() => assertOutline({ ...good, boxShadow: 'rgb(122, 162, 247) 2px 0px 0px 0px inset' }, { fontWeight: '400' })).toThrow(/stripe/);
});
it('protects compact-origin tab backgrounds and forbids reintroducing an accent line', () => {
  const good = { backgroundColor: 'color(srgb 0.136471 0.152157 0.225725)', boxShadow: 'none' };
  expect(() => assertTab(good)).not.toThrow();
  expect(() => assertTab({ ...good, boxShadow: 'inset 0 2px blue' })).toThrow(/accent line/);
  expect(() => assertTab({ ...good, backgroundColor: 'rgb(36, 40, 59)' })).toThrow(/d58ce8d compact/);
  const ref = JSON.parse(readFileSync('tests/baselines/ui/highlights.json', 'utf8'));
  expect(ref.origin.commit).toBe('d58ce8d0e35e271e4303fabe7d32aaacb4541208');
  for (const theme of ['light', 'dark']) {
    assertOutline(ref.themes[theme].neutral.outlineActive, ref.themes[theme].neutral.outlineOther);
    assertTab(ref.themes[theme].neutral.tabActive);
    expect(ref.themes[theme].outlineHover.outlineActive).toEqual(ref.themes[theme].neutral.outlineActive);
    expect(ref.themes[theme].tabHover.tabOther.backgroundColor).not.toBe(ref.themes[theme].neutral.tabOther.backgroundColor);
  }
});
it('rejects changed color/font/border even if layout stays the same', () => {
  const base = { color: 'rgb(24, 121, 104)', fontSize: '13px', borderTopWidth: '1px', width: 264 };
  for (const change of [{ color: 'green' }, { fontSize: '14px' }, { borderTopWidth: '0px' }, { width: 280 }])
    expect(() => assertMetrics({ ...base, ...change }, base)).toThrow();
});
it('rejects a full-width tab bar and menu/editor displacement', () => {
  const layout = { menu: { x: 0 }, sidebar: { x: 0, y: 43, width: 264 }, tabs: { x: 264, y: 43, width: 1102, height: 34 }, editor: { x: 264, y: 77, width: 1102 } };
  expect(() => assertLayout(layout)).not.toThrow();
  expect(() => assertLayout({ ...layout, tabs: { ...layout.tabs, x: 0 } })).toThrow();
});
it('requires all four approved matrices and their small screenshot references', () => {
  const base = JSON.parse(readFileSync('tests/baselines/ui/computed.json', 'utf8'));
  expect(Object.keys(base.scenarios).sort()).toEqual(['compact-dark', 'compact-light', 'standard-dark', 'standard-light']);
  for (const [name, scenario] of Object.entries<any>(base.scenarios)) {
    assertOutline(scenario.styles.active, scenario.styles.outline); assertLayout(scenario.layout);
    for (const component of ['menu', 'tabs', 'outline', 'popup']) expect(existsSync(`tests/baselines/ui/${name}-${component}.png`)).toBe(true);
  }
});
it('compares actual screenshot pixels and detects a different theme', () => {
  const a = readFileSync('tests/baselines/ui/standard-light-outline.png'), b = readFileSync('tests/baselines/ui/standard-dark-outline.png');
  expect(comparePng(a, a).changedPixels).toBe(0);
  expect(() => comparePng(a, b)).toThrow(/screenshot changed/);
});
