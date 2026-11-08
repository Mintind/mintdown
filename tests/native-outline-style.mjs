// Background WebView2 visual contract; never sends desktop input or shows a window.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertOutline } from './protection/ui-contract.mjs';

const root = resolve(import.meta.dirname, '..');
const phase = process.env.OUTLINE_PHASE || 'fixed';
const evidence = process.env.OUTLINE_EVIDENCE || join(root, 'docs/evidence/outline-style');
const scratch = join(root, 'tests/.layout-evidence', `outline-${randomUUID()}`);
mkdirSync(evidence, { recursive: true }); mkdirSync(scratch, { recursive: true });
const source = Array.from({ length: 60 }, (_, i) => `${'#'.repeat(i % 6 + 1)} 章节 ${i + 1}\n\n中文正文 **粗体** 和 [链接](https://example.com)。\n`).join('\n');
const markdown = join(scratch, '大纲 样式.md'); writeFileSync(markdown, source);
const ownedPath = value => {
  const slashes = value.replaceAll('\\', '/');
  return resolve(slashes.startsWith('//?/') ? slashes.slice(4) : slashes).toLowerCase();
};
const binary = process.env.NATIVE_TEST_BINARY || join(root, 'src-tauri/target/interaction-isolated/debug/markdown-editor-kit.exe');
const port = Number(process.env.NATIVE_DEBUG_PORT || 9417);
// CDP's DPR override alone does not normalize WebView2's native border/font
// snapping. The approved screenshots used a 1.5 raster scale. Pin only the
// isolated guard renderer; never change Windows DPI or application CSS.
const rasterArgument = process.env.MINTDOWN_UI_GUARD === '1' ? ' --force-device-scale-factor=1.5' : '';
const app = spawn(binary, [markdown], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: {
  ...process.env, MINTDOWN_TEST_BACKGROUND: '1', MINTDOWN_TEST_SESSION_ID: `outline-${randomUUID()}`,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --no-proxy-server${rasterArgument}`,
} });
let socket, serial = 0, stderr = ''; const pending = new Map();
app.stderr.on('data', data => { stderr += data; });
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function waitFor(check, label) {
  for (let i = 0; i < 300; i++) { try { const value = await check(); if (value) return value; } catch {} await sleep(100); }
  throw Error(`Timed out ${label}: ${stderr}`);
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++serial; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const panel = '.document-tab-panel:not([hidden])';
const view = `document.querySelector('${panel} .cm-content')?.cmTile?.root?.view`;
const point = selector => evaluate(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
async function clickAt(p) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 });
}
async function menu(group, label) {
  for (const selector of [`.menu-trigger`, `.menu-popup:not([hidden]) button`]) {
    const text = selector === '.menu-trigger' ? group : label;
    await clickAt(await evaluate(`(() => {const e=[...document.querySelectorAll('${panel} ${selector}')].find(e=>e.textContent===${JSON.stringify(text)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`));
  }
}
const state = `(() => {const v=${view};return {source:v.state.doc.toString(),head:v.state.selection.main.head,anchor:v.state.selection.main.anchor,scroll:document.querySelector('${panel} .editor-scroll').scrollTop,dirty:document.querySelector('.document-tab').textContent.includes('●')}})()`;
const styles = `(() => {const list=document.querySelector('${panel} .outline-list'),a=list.querySelector('.active'),b=list.querySelector('button:not(.active)'),inspect=e=>{const s=getComputedStyle(e);return {background:s.backgroundColor,color:s.color,weight:s.fontWeight,shadow:s.boxShadow,rect:e.getBoundingClientRect().toJSON()}},root=getComputedStyle(document.documentElement);return {active:inspect(a),other:inspect(b),activeText:a.textContent,accent:root.getPropertyValue('--accent').trim(),hover:root.getPropertyValue('--outline-hover').trim(),rules:[...document.styleSheets].flatMap(sheet=>{try{return [...sheet.cssRules]}catch{return []}}).filter(r=>r.selectorText?.includes('.outline-list button.active')).map(r=>r.cssText)}})()`;
const result = { phase, binary, binarySha256: createHash('sha256').update(readFileSync(binary)).digest('hex'), snapshots: [] };
try {
  const page = await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json())).find(p => {
    if (p.type !== 'page') return false;
    const path = new URL(p.url).searchParams.get('path');
    return path && ownedPath(path) === ownedPath(markdown);
  }), 'owned fixture page');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', fail, { once: true }); });
  socket.addEventListener('message', e => { const d = JSON.parse(e.data), p = pending.get(d.id); if (!p) return; pending.delete(d.id); d.error ? p.reject(Error(JSON.stringify(d.error))) : p.resolve(d.result); });
  await waitFor(() => evaluate(`!!${view} && document.querySelectorAll('${panel} .outline-list button').length===60`), 'outline');
  await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
  await evaluate('document.fonts.ready.then(()=>true)');
  for (const density of ['standard', 'compact']) {
    if (await evaluate(`document.documentElement.dataset.density`) !== density) {
      await menu('文件', '偏好设置');
      await waitFor(() => evaluate(`!!document.querySelector('[aria-label="界面密度"]')`), 'settings');
      await evaluate(`(() => {const e=document.querySelector('[aria-label="界面密度"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(density)});e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await clickAt(await point('[aria-label="关闭设置"]'));
      await waitFor(() => evaluate(`document.documentElement.dataset.density===${JSON.stringify(density)}`), 'density');
    }
    for (const theme of ['light', 'dark']) {
      if (await evaluate('document.documentElement.dataset.theme') !== theme) await menu('视图', theme === 'dark' ? '深色主题' : '浅色主题');
      await waitFor(() => evaluate(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`), 'theme');
      // Active section selected by the actual outline command, then hover without clicking.
      await clickAt(await point(`${panel} .outline-list button`));
      await waitFor(() => evaluate(`!!document.querySelector('${panel} .outline-list button.active')`), 'active');
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1300, y: 700 });
      const before = await evaluate(state), neutral = await evaluate(styles);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...await point(`${panel} .outline-list button:not(.active)`) });
      const hovered = await evaluate(styles);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...await point(`${panel} .outline-list button.active`) });
      const activeHovered = await evaluate(styles);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1300, y: 700 });
      const after = await evaluate(state), left = await evaluate(styles);
      assert.deepEqual(after, before, 'hover must not change document, selection, scroll or dirty state');
      assert.equal(after.source, source); assert.equal(after.dirty, false);
      assert.deepEqual(left, neutral, 'mouse leave restores neutral styling');
      const name = `${phase}-${density}-${theme}`;
      const png = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(join(evidence, `${name}.png`), Buffer.from(png.data, 'base64'));
      result.snapshots.push({ name, neutral, hovered, activeHovered, contentUnchanged: true });
      if (process.env.MINTDOWN_UI_GUARD === '1') {
        const { checkUi } = await import('./protection/native-ui-checks.mjs');
        await checkUi({ root, evidence, evaluate, send, clickAt, point, state, theme, density, waitFor });
      }
    }
  }
  if (process.env.MINTDOWN_UI_GUARD === '1') {
    const { checkLayoutTransitions } = await import('./protection/native-ui-checks.mjs');
    await checkLayoutTransitions({ evidence, evaluate, send, clickAt, point, waitFor, view, state, menu });
  }
  if (phase !== 'baseline') {
    for (const s of result.snapshots) {
      assertOutline(s.neutral.active, s.neutral.other, s.name);
      assert.equal(s.activeHovered.active.background, s.neutral.active.background);
      assert.equal(s.activeHovered.active.shadow, s.neutral.active.shadow);
      assert.equal(s.hovered.activeText, s.neutral.activeText);
      assert.notEqual(s.hovered.other.background, s.neutral.other.background);
      assert.equal(s.hovered.other.shadow, 'none');
      assert.ok(Number(s.neutral.active.weight) > Number(s.neutral.other.weight));
      assert.ok(Number(s.neutral.active.weight) <= 600);
    }
    await menu('帮助', '构建信息');
    result.buildInformation = await evaluate(`document.querySelector('[aria-label="构建信息"]').textContent`);
    assert.match(result.buildInformation, /Git：[0-9a-f]{40}/);
    await clickAt(await point('.operation-result-dialog .dialog-button-primary'));
    await evaluate(`(() => {const v=${view};const p=v.state.doc.toString().indexOf('中文');v.dispatch({selection:{anchor:p}});v.focus();})()`);
    await send('Input.insertText', { text: '连续编辑测试' });
    const edited = await evaluate(state);
    assert.notEqual(edited.source, source); assert.equal(edited.dirty, true);
    await menu('视图', '浅色主题'); await menu('视图', '深色主题');
    assert.deepEqual(await evaluate(state), edited, 'theme changes preserve pending edits, caret and scroll');
    await evaluate(`(${view}).focus()`);
    const key = async (key, code, windowsVirtualKeyCode) => {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers: 2 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers: 2 });
    };
    await key('z', 'KeyZ', 90);
    assert.equal((await evaluate(state)).source, source, 'one undo after visual changes removes only the actual input');
    await key('y', 'KeyY', 89);
    assert.equal((await evaluate(state)).source, edited.source, 'redo preserves actual input');
    result.undoRedoPreserved = true;
  }
  assert.equal(readFileSync(markdown, 'utf8'), source);
  writeFileSync(join(evidence, `${phase}.json`), JSON.stringify(result, null, 2));
  const captureOnly = process.env.MINTDOWN_UI_CAPTURE === '1';
  console.log(JSON.stringify({ phase, scenarios: result.snapshots.length, evidence, passed: !captureOnly, captureOnly }));
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    await send('Runtime.evaluate', { expression: `void window.__TAURI_INTERNALS__.invoke('plugin:window|destroy',{label:window.__TAURI_INTERNALS__.metadata.currentWindow.label})` }).catch(() => {});
    socket.close();
  }
  // No process termination fallback. Only the private test window receives IPC.
  app.unref();
}
