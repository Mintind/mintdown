// CSS-only validation in a private, non-activating WebView2 shell. No process
// enumeration, monitoring, termination, desktop input, or force-close fallback.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, posix, resolve } from 'node:path';
import { assertLayout, assertMetrics, assertOutline, assertTab, highlightExpression, measureExpression } from './ui-contract.mjs';
import { comparePng } from './png.mjs';
import { checkCurrentHighlightStates } from './native-ui-checks.mjs';

const root = resolve(import.meta.dirname, '../..');
const captureOnly = process.argv.includes('--capture'); // candidates only; never updates approved baselines
const evidence = join(root, 'tests/.layout-evidence', `highlight-guard-${randomUUID()}`);
mkdirSync(evidence, { recursive: true });
const source = Array.from({ length: 60 }, (_, i) => `${'#'.repeat(i % 6 + 1)} 章节 ${i + 1}\n\n中文正文 **粗体** 和 [链接](https://example.com)。\n`).join('\n');
const markdown = join(evidence, '大纲 样式.md');
writeFileSync(markdown, source);
const inputHashes = {};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const baselineFolder = join(root, 'tests/baselines/ui');
const baselineHashes = () => Object.fromEntries(readdirSync(baselineFolder).sort().map(name => [name, hash(readFileSync(join(baselineFolder, name)))]));
const baselineBefore = baselineHashes();
function currentCss(path = 'src/style.css') {
  const text = readFileSync(join(root, path), 'utf8'); inputHashes[path] = hash(text);
  return text.replace(/@import\s+['"]([^'"]+)['"];?/g, (_, relative) => currentCss(posix.normalize(posix.join(posix.dirname(path), relative))));
}
const sourceCss = currentCss();
const approvedHighlights = JSON.parse(readFileSync(join(root, 'tests/baselines/ui/highlights.json'), 'utf8'));
const port = await new Promise(done => {
  const server = createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => done(port)); });
});
const binary = join(root, 'src-tauri/target/interaction-isolated/debug/markdown-editor-kit.exe');
assert.ok(readFileSync(binary).includes(Buffer.from('com.markdowneditor.kit.nativeinteractiontest')), 'Only the isolated test shell is permitted');
const app = spawn(binary, [markdown], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
  ...process.env, MINTDOWN_TEST_BACKGROUND: '1', MINTDOWN_TEST_SESSION_ID: randomUUID(),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --no-proxy-server --force-device-scale-factor=1.5`,
} });
let socket, serial = 0, exited = false, launchError, exitCode, output = '';
app.stdout.on('data', data => { output += data; }); app.stderr.on('data', data => { output += data; });
app.once('exit', code => { exited = true; exitCode = code; }); app.once('error', error => { launchError = error; });
const pending = new Map(), records = [];
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function waitFor(check, label) {
  for (let i = 0; i < 200; i++) { if (launchError) throw launchError; const value = await check(); if (value) return value; if (exited) throw Error(`Test shell exited (${exitCode}): ${output}`); await sleep(100); }
  throw Error(`Timed out: ${label}; test PID ${app.pid} is never force-terminated`);
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 10000);
  pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
});
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
const panel = '.document-tab-panel:not([hidden])';
const view = `document.querySelector('${panel} .cm-content')?.cmTile?.root?.view`;
const state = `(() => {const v=${view};return {source:v.state.doc.toString(),selection:v.state.selection.toJSON(),scroll:document.querySelector('${panel} .editor-scroll').scrollTop,dirty:document.querySelector('.document-tab').textContent.includes('●')}})()`;
const inspect = `(() => {const buttons=[...document.querySelectorAll('${panel} .outline-list button')];return buttons.slice(0,2).map(e=>{const s=getComputedStyle(e);return {backgroundColor:s.backgroundColor,fontWeight:s.fontWeight,boxShadow:s.boxShadow,borderLeftWidth:s.borderLeftWidth,before:getComputedStyle(e,'::before').content,after:getComputedStyle(e,'::after').content}})})()`;
let forcedNodes = [];
async function move(x, y, selector) {
  for (const nodeId of forcedNodes) await send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }).catch(() => {});
  forcedNodes = [];
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  if (selector) {
    const natural = await evaluate(highlightExpression);
    await send('DOM.getDocument', { depth: -1, pierce: true });
    for (const s of selector.includes('document-tab') ? [selector, selector.replace(' [role="tab"]', '')] : [selector]) {
      const object = await send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(s)})` });
      const { nodeId } = await send('DOM.requestNode', { objectId: object.result.objectId });
      await send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] }); forcedNodes.push(nodeId);
    }
    assert.deepEqual(await evaluate(highlightExpression), natural, 'Pinned screenshot Hover must equal actual mouse Hover');
  }
  await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done(true))))');
}
const point = selector => evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
const hover = async selector => { const p = await point(selector); await move(p.x, p.y, selector); };
async function screenshot(file, clip, compare = true) {
  const region = clip && { x: Math.floor(clip.x), y: Math.floor(clip.y), width: Math.ceil(clip.width), height: Math.ceil(clip.height), scale: 1 };
  const bytes = Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, ...(region ? { clip: region } : {}) })).data, 'base64');
  writeFileSync(join(evidence, file), bytes);
  if (!captureOnly && compare) comparePng(bytes, readFileSync(join(root, 'tests/baselines/ui', file)));
  return bytes;
}
async function sourceStyles(enabled) {
  await evaluate(`(()=>{document.querySelectorAll('link[data-highlight-shell]').forEach(e=>{e.disabled=${enabled}});document.getElementById('highlight-source-css').disabled=${!enabled}})()`);
}
async function click(selector, text) {
  const point = await evaluate(`(() => {const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>${text ? `e.textContent===${JSON.stringify(text)}` : 'true'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
}
try {
  const page = await waitFor(async () => {
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => []);
    return pages.find(p => p.type === 'page' && new URL(p.url).searchParams.get('path')?.replace(/^\\\\\?\\/, '').replaceAll('\\', '/').toLowerCase() === markdown.replaceAll('\\', '/').toLowerCase());
  }, 'own fixture page');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', fail, { once: true }); });
  socket.addEventListener('message', e => { const d = JSON.parse(e.data), p = pending.get(d.id); if (!p) return; clearTimeout(p.timer); pending.delete(d.id); d.error ? p.reject(Error(JSON.stringify(d.error))) : p.resolve(d.result); });
  await send('DOM.enable'); await send('CSS.enable');
  await waitFor(() => evaluate(`!!${view} && document.querySelectorAll('${panel} .outline-list button').length===60`), 'outline ready');
  await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
  await evaluate('document.fonts.ready.then(()=>true)');
  await evaluate(`document.querySelector('${panel} .outline-list button').click()`);
  await evaluate(`(() => {document.querySelectorAll('link[rel="stylesheet"]').forEach(e=>e.dataset.highlightShell='true');const s=document.createElement('style');s.id='highlight-source-css';s.textContent=${JSON.stringify(sourceCss)};s.disabled=true;document.head.append(s)})()`);
  for (const density of ['standard', 'compact']) for (const theme of ['light', 'dark']) {
    const name = `${density}-${theme}`;
    if (await evaluate('document.documentElement.dataset.density') !== density) {
      await click(`${panel} .menu-trigger`, '文件'); await click('.menu-popup:not([hidden]) button', '偏好设置');
      await waitFor(() => evaluate(`!!document.querySelector('[aria-label="界面密度"]')`), 'private settings');
      await evaluate(`(() => {const e=document.querySelector('[aria-label="界面密度"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(density)});e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
      await click('[aria-label="关闭设置"]');
      await waitFor(() => evaluate(`document.documentElement.dataset.density===${JSON.stringify(density)}`), 'density applied');
    }
    if (await evaluate('document.documentElement.dataset.theme') !== theme) {
      await click(`${panel} .menu-trigger`, '视图'); await click('.menu-popup:not([hidden]) button', theme === 'dark' ? '深色主题' : '浅色主题');
      await waitFor(() => evaluate(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`), 'theme applied');
    }
    await sourceStyles(false);
    await move(1300, 700);
    const before = await evaluate(measureExpression), content = await evaluate(state);
    await sourceStyles(true);
    const after = await evaluate(measureExpression), expected = structuredClone(before);
    expected.styles.active.backgroundColor = approvedHighlights.themes[theme].neutral.outlineActive.backgroundColor;
    expected.styles.active.boxShadow = 'none';
    expected.styles.tab.backgroundColor = approvedHighlights.themes[theme].neutral.tabActive.backgroundColor;
    expected.styles.tab.boxShadow = 'none';
    assertMetrics(after, expected, `${name}: only approved outline/tab highlight may change`); assertLayout(after.layout);
    const neutral = await evaluate(inspect);
    assertOutline(neutral[0], neutral[1], name);
    for (const item of neutral) { assert.equal(item.borderLeftWidth, '0px'); assert.equal(item.before, 'none'); assert.equal(item.after, 'none'); }
    assertTab(after.styles.tab, name);
    assert.equal(content.source, source); assert.equal(content.dirty, false);
    const clip = { x: 0, y: after.layout.sidebar.y, width: 240, height: 155 };
    const correctOutline = await screenshot(`${name}-outline.png`, clip);
    const correctTab = await screenshot(`${name}-tabs.png`, { ...after.layout.tabs, width: 230 });
    // Read-only check of an unrelated screenshot (never re-approved here).
    const menuBytes = await screenshot(`${name}-menu.png`, { ...after.layout.menu, width: 350 }, false);
    comparePng(menuBytes, readFileSync(join(root, `tests/baselines/ui/${name}-menu.png`)));
    const approved = JSON.parse(readFileSync(join(root, 'tests/baselines/ui/computed.json'), 'utf8')).scenarios[name];
    const approvedSubset = Object.fromEntries(Object.keys(after).map(key => [key, approved[key]]));
    if (captureOnly) {
      approvedSubset.styles.active.backgroundColor = expected.styles.active.backgroundColor; approvedSubset.styles.active.boxShadow = 'none';
      approvedSubset.styles.tab.backgroundColor = expected.styles.tab.backgroundColor; approvedSubset.styles.tab.boxShadow = 'none';
    }
    assertMetrics(after, approvedSubset, `${name}: approved layout/typography/unrelated colors`);
    const second = join(evidence, '第二标签.md'); writeFileSync(second, '# 第二标签\n');
    await evaluate(`window.__TAURI_INTERNALS__.invoke('open_path_tab',{path:${JSON.stringify(second)}})`);
    await waitFor(() => evaluate(`document.querySelectorAll('.document-tab').length===2`), 'second test tab');
    await click('.document-tab:first-child [role="tab"]');
    await waitFor(() => evaluate(`(${view}).state.doc.toString()===${JSON.stringify(source)}`), 'first document restored');
    await move(1300, 700);
    const twoTabState = await evaluate(state), highlights = {};
    highlights.neutral = await evaluate(highlightExpression);
    assertMetrics(highlights.neutral, approvedHighlights.themes[theme].neutral, `${name}: historical neutral`);
    await screenshot(`${name}-highlight-neutral.png`, { ...after.layout.tabs, width: 340 });
    await hover(`${panel} .outline-list button:not(.active)`);
    highlights.outlineHover = await evaluate(highlightExpression);
    assertMetrics(highlights.outlineHover, approvedHighlights.themes[theme].outlineHover, `${name}: historical outline Hover`);
    await screenshot(`${name}-highlight-outline-hover.png`, clip);
    await screenshot(`${name}-final.png`, undefined, false);
    await hover('.document-tab:nth-child(2) [role="tab"]');
    highlights.tabHover = await evaluate(highlightExpression);
    assertMetrics(highlights.tabHover, approvedHighlights.themes[theme].tabHover, `${name}: historical inactive tab Hover`);
    await screenshot(`${name}-highlight-tab-hover.png`, { ...after.layout.tabs, width: 340 });
    await hover('.document-tab:first-child [role="tab"]');
    highlights.activeTabHover = await evaluate(highlightExpression);
    assertMetrics(highlights.activeTabHover, approvedHighlights.themes[theme].activeTabHover, `${name}: historical active tab Hover`);
    await screenshot(`${name}-highlight-active-hover.png`, { ...after.layout.tabs, width: 340 });
    await move(1300, 700);
    assert.deepEqual(await evaluate(state), twoTabState, 'Hover does not change current document or position');
    await click('.document-tab:nth-child(2) .tab-close');
    await waitFor(() => evaluate(`document.querySelectorAll('.document-tab').length===1`), 'only first tab remains');
    await move(1300, 700);
    assert.deepEqual(await evaluate(state), content, 'tab/style checks preserve original source, caret, dirty and scroll');
    // Prove the obsolete style is rejected, without changing source files.
    await evaluate(`(() => {const s=document.createElement('style');s.id='obsolete-stripe';s.textContent='.outline-list button.active{background:transparent!important;box-shadow:inset 2px 0 var(--accent)!important}';document.head.append(s)})()`);
    const broken = await evaluate(inspect);
    assert.throws(() => assertOutline(broken[0], broken[1]), /d58ce8d compact/);
    const brokenOutlineMetrics = await evaluate(measureExpression);
    assert.throws(() => assertMetrics(brokenOutlineMetrics, after), /computed style changed/);
    const brokenOutlinePng = await screenshot(`${name}-injected-outline.png`, clip, false);
    assert.throws(() => comparePng(brokenOutlinePng, correctOutline), /screenshot changed/);
    await evaluate(`document.getElementById('obsolete-stripe').remove()`);
    assert.deepEqual(await evaluate(inspect), neutral);
    await evaluate(`(()=>{const s=document.createElement('style');s.id='obsolete-tab';s.textContent=':root[data-density="${density}"] .document-tab:has([aria-selected="true"]){background:var(--page);box-shadow:inset 0 2px var(--accent)}';document.head.append(s)})()`);
    const brokenTab = await evaluate(measureExpression);
    assert.throws(() => assertTab(brokenTab.styles.tab), /d58ce8d compact/);
    assert.throws(() => assertMetrics(brokenTab, after), /computed style changed/);
    const brokenTabPng = await screenshot(`${name}-injected-tab.png`, { ...after.layout.tabs, width: 230 }, false);
    assert.throws(() => comparePng(brokenTabPng, correctTab), /screenshot changed/);
    await evaluate(`document.getElementById('obsolete-tab').remove()`);
    assertMetrics(await evaluate(measureExpression), after);
    const currentDomHighlights = await checkCurrentHighlightStates({ root, evidence, evaluate, send, point, state, theme, density, waitFor,
      clickAt: async p => { for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 }); } });
    records.push({ name, measurements: after, highlights, currentDomHighlights, mutationRejected: true, stateUnchanged: true });
  }
  assert.equal(readFileSync(markdown, 'utf8'), source);
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    // Only this private CDP target can receive the lifecycle request. Never
    // enumerate PIDs, invoke app.exit, or terminate a process on close failure.
    await send('Runtime.evaluate', { expression: `void window.__TAURI_INTERNALS__.invoke('plugin:window|destroy',{label:window.__TAURI_INTERNALS__.metadata.currentWindow.label})` }).catch(() => {});
    await waitFor(() => exited, 'own window graceful destruction').catch(error => { throw error; });
    socket.close();
  }
  for (const [path, sha] of Object.entries(inputHashes)) assert.equal(hash(readFileSync(join(root, path))), sha, 'Source changed during check');
  assert.deepEqual(baselineHashes(), baselineBefore, 'Regression checks must never rewrite approved expectations');
  writeFileSync(join(evidence, 'result.json'), JSON.stringify({ captureOnly, exited, exitCode, output, inputHashes, kind: 'current CSS on isolated native shell', records }, null, 2));
  console.log(JSON.stringify({ evidence, scenarios: records.length, captureOnly, exited }));
  app.unref();
}
