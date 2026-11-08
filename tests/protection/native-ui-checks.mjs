import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectBuildInfo } from '../../scripts/build-info.mjs';
import { assertLayout, assertMetrics, assertOutline, highlightExpression, measureExpression, styleProperties } from './ui-contract.mjs';
import { comparePng } from './png.mjs';

const records = [];
export async function checkCurrentHighlightStates({ root, evidence, evaluate, send, clickAt, point, state, theme, density, waitFor }) {
  const before = await evaluate(state);
  const second = join(evidence, '第二标签.md'); writeFileSync(second, '# 第二标签\n');
  await evaluate(`window.__TAURI_INTERNALS__.invoke('open_path_tab',{path:${JSON.stringify(second)}})`);
  await waitFor(() => evaluate(`document.querySelectorAll('.document-tab').length===2`), 'second highlight tab');
  await clickAt(await point('.document-tab:first-child [role="tab"]'));
  await waitFor(() => evaluate(`document.querySelectorAll('.document-tab-panel:not([hidden]) .outline-list button').length===60`), 'original outline restored');
  const expected = JSON.parse(readFileSync(join(root, 'tests/baselines/ui/highlights.json'), 'utf8')).themes[theme], states = {};
  for (const [name, selector] of [['neutral', null], ['outlineHover', '.document-tab-panel:not([hidden]) .outline-list button:not(.active)'],
    ['tabHover', '.document-tab:nth-child(2) [role="tab"]'], ['activeTabHover', '.document-tab:first-child [role="tab"]']]) {
    const p = selector ? await point(selector) : { x: 1300, y: 700 };
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
    states[name] = await evaluate(highlightExpression);
    assertMetrics(states[name], expected[name], `${density}-${theme}: current application ${name}`);
  }
  await clickAt(await point('.document-tab:nth-child(2) .tab-close'));
  await waitFor(() => evaluate(`document.querySelectorAll('.document-tab').length===1`), 'second highlight tab closed');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1300, y: 700 });
  assert.deepEqual(await evaluate(state), before, 'highlight checks preserve current document/caret/scroll/dirty');
  return states;
}
export async function checkUi({ root, evidence, evaluate, send, clickAt, point, state, theme, density, waitFor }) {
  const captureOnly = process.env.MINTDOWN_UI_CAPTURE === '1', name = `${density}-${theme}`;
  const baselineFolder = join(root, 'tests/baselines/ui');
  const schema = join(baselineFolder, 'computed.json');
  if (!captureOnly && !existsSync(schema)) throw Error('Approved UI baseline missing. Capture is not a pass; review the initial baseline against confirmed requirements.');
  const compiled = await evaluate(`fetch('/build-info.json').then(r=>r.json())`);
  const current = collectBuildInfo(root, 'build', 'production');
  assert.equal(compiled.sourceSha256, current.sourceSha256, 'STALE NATIVE BINARY: rebuild the isolated native test app; old UI cannot validate changed sources');
  assert.equal(compiled.channel, 'native-test', 'Only an isolated native-test build is allowed');
  const before = await evaluate(state), measurements = await evaluate(measureExpression);
  assert.equal(measurements.viewport.width, 1366); assert.equal(measurements.viewport.height, 768);
  assert.ok(Math.abs(measurements.viewport.dpr - 1) < 1e-6, 'DPR must be 1 (allow only floating-point rounding)');
  assertLayout(measurements.layout);
  assertOutline(measurements.styles.active, measurements.styles.outline, name);
  const checks = [];
  const screenshot = async (suffix, clip) => {
    const region = { x: Math.floor(clip.x), y: Math.floor(clip.y), width: Math.ceil(clip.width), height: Math.ceil(clip.height), scale: 1 };
    const data = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: region });
    const bytes = Buffer.from(data.data, 'base64'), file = `${name}-${suffix}.png`;
    writeFileSync(join(evidence, file), bytes);
    if (!captureOnly) checks.push({ file, ...comparePng(bytes, readFileSync(join(baselineFolder, file))) });
  };
  await screenshot('menu', { ...measurements.layout.menu, width: 350 });
  await screenshot('tabs', { ...measurements.layout.tabs, width: 230 });
  await screenshot('outline', { x: 0, y: measurements.layout.sidebar.y, width: 240, height: 155 });
  // Same shared item typography in top menu and document-tab context menu.
  const properties = JSON.stringify(styleProperties);
  const inspect = selector => evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)}),c=getComputedStyle(e);return Object.fromEntries(${properties}.map(p=>[p,c[p]]));})()`);
  await clickAt(await point('.document-tab-panel:not([hidden]) .menu-trigger'));
  measurements.popup = await inspect('.menu-popup:not([hidden])');
  measurements.menuItem = await inspect('.menu-popup:not([hidden]) .menu-entry > button');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...await point('.menu-popup:not([hidden]) .menu-entry > button') });
  measurements.menuHover = await inspect('.menu-popup:not([hidden]) .menu-entry > button');
  const popupRect = await evaluate(`document.querySelector('.menu-popup:not([hidden])').getBoundingClientRect().toJSON()`);
  await screenshot('popup', popupRect);
  const esc = async () => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); };
  await esc();
  const tab = await point('.document-tab [role="tab"]');
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...tab, button: 'right', clickCount: 1 });
  measurements.context = await inspect('.tab-context-menu');
  measurements.contextItem = await inspect('.tab-context-menu > [role="menuitem"]');
  for (const key of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'])
    assert.equal(measurements.contextItem[key], measurements.menuItem[key], `shared menu ${key}`);
  await esc();
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1300, y: 20 });
  assert.deepEqual(await evaluate(state), before, 'opening/closing menus must preserve editor data and position');
  if (!captureOnly) assertMetrics(measurements, JSON.parse(readFileSync(schema, 'utf8')).scenarios[name], name);
  // Check the actual current React DOM as well as the CSS-only shell. This
  // catches future component/inline-style Hover regressions in fresh builds.
  const highlightStates = await checkCurrentHighlightStates({ root, evidence, evaluate, send, clickAt, point, state, theme, density, waitFor });
  const record = { name, measurements, checks, highlightStates, compiledBuild: compiled.id };
  records.push(record);
  writeFileSync(join(evidence, 'ui-metrics.json'), JSON.stringify({ records, captureOnly }, null, 2));
  if (process.env.MINTDOWN_UI_PROVE_MUTATION === '1' && density === 'compact') {
    const mutationBase = await evaluate(measureExpression);
    await evaluate(`(() => {const e=document.createElement('style');e.id='guard-fault-injection';e.textContent=':root[data-density="compact"] .outline-list button.active { background: transparent; box-shadow: inset 2px 0 var(--accent); }';document.head.append(e);})()`);
    const broken = await evaluate(measureExpression); let failure, computedFailure, pixelFailure;
    try { assertOutline(broken.styles.active, broken.styles.outline, `${name} injected regression`); }
    catch (error) { failure = error.message; }
    try { assertMetrics(broken, mutationBase); } catch (error) { computedFailure = error.message; }
    const clip = { x: 0, y: Math.floor(broken.layout.sidebar.y), width: 240, height: 155, scale: 1 };
    const brokenPng = Buffer.from((await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false })).data, 'base64');
    writeFileSync(join(evidence, `${name}-injected.png`), brokenPng);
    try { comparePng(brokenPng, readFileSync(join(baselineFolder, `${name}-outline.png`))); }
    catch (error) { pixelFailure = error.message; }
    try { assert.ok(failure?.includes('d58ce8d compact'), 'the injected obsolete stripe style must fail'); }
    finally { await evaluate(`document.getElementById('guard-fault-injection').remove()`); }
    assert.ok(computedFailure, 'computed-style comparison must detect the regression');
    assert.ok(pixelFailure, 'screenshot comparison must detect the regression');
    const restored = await evaluate(measureExpression);
    assertOutline(restored.styles.active, restored.styles.outline);
    assertMetrics(restored, mutationBase);
    const restoredPng = Buffer.from((await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false })).data, 'base64');
    comparePng(restoredPng, readFileSync(join(baselineFolder, `${name}-outline.png`)));
    record.mutation = { detected: true, failure, computedFailure, pixelFailure, restored: true };
    writeFileSync(join(evidence, 'ui-metrics.json'), JSON.stringify({ records, captureOnly }, null, 2));
  }
}

export async function checkLayoutTransitions({ evidence, evaluate, send, clickAt, point, waitFor, view, state, menu }) {
  const original = await evaluate(measureExpression), editorState = await evaluate(state);
  await evaluate(`void(window.__guardEditor=${view})`);
  const second = join(evidence, '第二标签.md'); writeFileSync(second, '# 第二标签\n\n独立测试正文。\n');
  await evaluate(`window.__TAURI_INTERNALS__.invoke('open_path_tab',{path:${JSON.stringify(second)}})`);
  await waitFor(() => evaluate(`document.querySelectorAll('.document-tab').length===2`), 'two tabs');
  await clickAt(await point('.document-tab:first-child [role="tab"]'));
  await waitFor(() => evaluate(`(${view})===window.__guardEditor`), 'same editor after tab switching');
  const multi = await evaluate(measureExpression); assertLayout(multi.layout);
  assertMetrics(multi.layout, original.layout, 'single to multiple tabs');
  await clickAt(await point('.document-tab:nth-child(2) .tab-close'));
  await waitFor(() => evaluate(`document.querySelectorAll('.document-tab').length===1`), 'single tab');
  assertMetrics((await evaluate(measureExpression)).layout, original.layout, 'multiple to single tab');
  const start = await point('.document-tab-panel:not([hidden]) .outline-resizer');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + 96, y: start.y, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: start.x + 96, y: start.y, button: 'left', buttons: 0 });
  const wide = await evaluate(measureExpression); assertLayout(wide.layout);
  assert.ok(wide.layout.sidebar.width > original.layout.sidebar.width + 80, 'resizer actually changed width');
  const end = await point('.document-tab-panel:not([hidden]) .outline-resizer');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...end, button: 'left', buttons: 1 });
  const targetX = end.x - (wide.layout.sidebar.width - original.layout.sidebar.width);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: targetX, y: end.y, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: targetX, y: end.y, button: 'left', buttons: 0 });
  await clickAt(await point('.document-tab-panel:not([hidden]) .outline-toggle'));
  const hidden = await evaluate(`(() => {const a=document.querySelector('.document-tabs').getBoundingClientRect(),b=document.querySelector('.document-tab-panel:not([hidden]) .editor-pane').getBoundingClientRect();return {tabsX:a.x,editorX:b.x,height:a.height,width:a.width}})()`);
  assert.equal(hidden.tabsX, 0); assert.equal(hidden.editorX, 0); assert.equal(hidden.height, 34);
  await clickAt(await point('.document-tab-panel:not([hidden]) .outline-toggle'));
  await menu('文件', '偏好设置');
  await waitFor(() => evaluate(`!!document.querySelector('.preferences-document-tab')`), 'preferences special tab');
  const preferencesTab = await evaluate(`document.querySelector('.preferences-document-tab').closest('.document-tabs')!==null`);
  assert.equal(preferencesTab, true);
  await clickAt(await point('[aria-label="关闭设置"]'));
  assertMetrics((await evaluate(measureExpression)).layout, original.layout, 'restored layout');
  assert.deepEqual(await evaluate(state), editorState, 'layout operations preserve source, caret, scroll and dirty state');
  writeFileSync(join(evidence, 'layout-transitions.json'), JSON.stringify({ multi: multi.layout, wide: wide.layout, hidden, preferencesTab, sameEditor: true, stateUnchanged: true }, null, 2));
}
