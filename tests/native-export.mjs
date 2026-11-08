import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

function pngBlock(type, payload) {
  const label = Buffer.from(type), size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length);
  const data = Buffer.concat([label, payload]);
  let crc = 0xffffffff;
  for (const value of data) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  const check = Buffer.alloc(4); check.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, data, check]);
}
function testPng(red, green, blue) {
  const width = 120, height = 75, header = Buffer.alloc(13), rows = Buffer.alloc((width * 4 + 1) * height);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 4 + 1) + 1 + x * 4;
    rows[offset] = red; rows[offset + 1] = green; rows[offset + 2] = blue; rows[offset + 3] = 255;
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngBlock('IHDR', header),
    pngBlock('IDAT', deflateSync(rows)), pngBlock('IEND', Buffer.alloc(0))]);
}

const root = resolve(import.meta.dirname, '..');
const scratch = join(root, 'tests', '.layout-evidence', `d1-export-${randomUUID()}`);
mkdirSync(scratch, { recursive: true });
const folder = join(scratch, '中文 路径');
mkdirSync(folder);
const markdown = join(folder, '导出 样例.md');
const images = join(folder, '导出 样例.assets');
mkdirSync(images);
writeFileSync(join(images, '本地 图片.png'), testPng(58, 145, 125));
writeFileSync(join(images, '第二张.png'), testPng(112, 140, 185));
const source = ['---', 'title: 中文导出验收', 'author: Mintdown', '---', '# 标题与正文', '',
  '这是一段包含 **粗体**、*斜体*、`inline code` 和 [链接](https://example.com) 的中文正文。', '',
  '<!--more-->', '', '![本地图](导出%20样例.assets/本地%20图片.png)', '',
  '![第二张](导出%20样例.assets/第二张.png)', '',
  '![缺失](missing.png)', '', '![远程](https://example.com/remote.png)', '',
  '$$', '\\int_0^1 x^2 \\,dx = \\frac{1}{3}', '$$', '',
  '```python', '# 代码中的伪标题', 'def hello(name: str) -> dict[str, str]:', '    values = {"greeting": f"你好 {name}", "status": "ready"}', '    return values', '<!--more-->', '```', '',
  '| 左对齐 | 右对齐 |', '|:---|---:|',
  ...Array.from({ length: 46 }, (_, index) => `| 第 ${index + 1} 行中文 | 数据 ${index + 1} |`), '',
  '## 长文档分页检查', '',
  '### **重复标题** `code`', '', '三级正文。', '',
  '#### 四级中文', '', '四级正文。', '',
  '##### 五级中文', '', '五级正文。', '',
  '###### 六级中文', '', '六级正文。', '',
  '### **重复标题** `code`', '', '另一个独立的三级标题。', '',
  ...Array.from({ length: 24 }, (_, index) => `第 ${index + 1} 段：${'中文长文档用于检查连续阅读、自动换页和文字复制。'.repeat(5)}\n`),
  '<script>alert("不可执行")</script>', '', '{{ unknown_extension }}', '', '结尾。', ''].join('\n');
writeFileSync(markdown, source, 'utf8');
const htmlTarget = join(scratch, '独立 导出.html');
const pdfTarget = join(scratch, '独立 导出.pdf');
const binary = process.env.NATIVE_TEST_BINARY || join(root, 'src-tauri', 'target', 'interaction-isolated', 'debug', 'markdown-editor-kit.exe');
const port = Number(process.env.NATIVE_DEBUG_PORT || 9391);
const app = spawn(binary, [markdown], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
  ...process.env, MINTDOWN_TEST_BACKGROUND: '1', MINTDOWN_TEST_SESSION_ID: `d1-${randomUUID()}`,
  WEBVIEW2_USER_DATA_FOLDER: join(scratch, 'webview-profile'),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --no-proxy-server`,
} });
const exited = new Promise(done => app.once('exit', done));
let stderr = '';
app.stderr.on('data', chunk => { stderr += chunk; });
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function waitFor(check, label, attempts = 600) {
  for (let index = 0; index < attempts; index++) {
    try { const result = await check(); if (result) return result; } catch { /* app startup */ }
    await sleep(150);
  }
  throw Error(`Timed out: ${label}. ${stderr}`);
}
let socket, serial = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++serial; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const packet = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (packet.exceptionDetails) throw Error(packet.exceptionDetails.exception?.description || packet.exceptionDetails.text);
  return packet.result.value;
};
const active = '.document-tab-panel:not([hidden])';
async function triggerExport(format, target, approve = true) {
  await evaluate(`window.__MINTDOWN_TEST_DIALOGS__={save:()=>${JSON.stringify(target)},ask:()=>${approve}}`);
  await evaluate(`[...document.querySelectorAll('${active} .menu-trigger')].find(e=>e.textContent==='文件').click()`);
  await waitFor(() => evaluate(`!!document.querySelector('${active} .menu-popup:not([hidden])')`), 'file menu');
  await evaluate(`[...document.querySelectorAll('${active} .menu-popup:not([hidden]) .menu-entry > button')].find(e=>e.textContent?.startsWith('导出')).click()`);
  await waitFor(() => evaluate(`!![...document.querySelectorAll('${active} .menu-submenu:not([hidden]) button')].find(e=>e.textContent===${JSON.stringify(format.toUpperCase()+'…')})`), 'export submenu');
  await evaluate(`[...document.querySelectorAll('${active} .menu-submenu:not([hidden]) button')].find(e=>e.textContent===${JSON.stringify(format.toUpperCase()+'…')}).click()`);
}
async function exportFromMenu(format, target) {
  await triggerExport(format, target);
  await waitFor(() => evaluate(`document.querySelector('.export-notice[data-phase="success"]')?.textContent?.includes(${JSON.stringify(format.toUpperCase()+' 导出完成')})`), `${format} export`, 300);
  const result = await evaluate(`({title:${JSON.stringify(format.toUpperCase()+' 导出完成')},body:document.querySelector('.export-notice[data-phase="success"]')?.textContent})`);
  await evaluate(`document.querySelector('[aria-label="关闭导出状态"]').click()`);
  return result;
}
async function contextExport(format, target, index = 1) {
  await evaluate(`window.__MINTDOWN_TEST_DIALOGS__={save:(options)=>{window.__exportDefault=options;return ${JSON.stringify(target)}},ask:()=>true}`);
  const point = await evaluate(`(() => {const r=document.querySelector('.document-tab:nth-child(${index}) [role="tab"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...point, button: 'right', buttons: type === 'mousePressed' ? 2 : 0, clickCount: 1 });
  await waitFor(() => evaluate(`!!document.querySelector('.tab-context-menu')`), 'inactive context menu');
  await evaluate(`document.querySelector('.tab-context-menu [aria-haspopup="menu"]').click()`);
  await waitFor(() => evaluate(`!!document.querySelector('.tab-context-menu .menu-submenu:not([hidden])')`), 'context export submenu');
  await evaluate(`[...document.querySelectorAll('.tab-context-menu .menu-submenu button')].find(e=>e.textContent===${JSON.stringify(format.toUpperCase()+'…')}).click()`);
}
async function finishContextExport(format) {
  await waitFor(() => evaluate(`document.querySelector('.export-notice[data-phase="success"]')?.textContent.includes(${JSON.stringify(format.toUpperCase()+' 导出完成')})`), 'inactive export completed', 300);
  const metrics = await evaluate('window.__MINTDOWN_LAST_EXPORT__');
  await evaluate(`document.querySelector('[aria-label="关闭导出状态"]').click()`);
  return metrics;
}
try {
  const page = await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json()))
    .find(item => new URL(item.url).searchParams.get('path')?.toLowerCase().endsWith('导出 样例.md')), 'native editor page');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', fail, { once: true }); });
  socket.addEventListener('message', event => { const result = JSON.parse(event.data), item = pending.get(result.id); if (!item) return;
    pending.delete(result.id); result.error ? item.reject(Error(JSON.stringify(result.error))) : item.resolve(result.result); });
  const editor = `document.querySelector('${active} .cm-content')?.cmTile?.root?.view`;
  await waitFor(() => evaluate(`!!${editor}`), 'canonical editor');
  await evaluate(`(() => {const view=${editor};view.dispatch({changes:{from:view.state.doc.length,insert:'\\n\\n未保存导出标记。'}})})()`);
  await waitFor(() => evaluate(`document.querySelector('${active} .document-name')?.textContent?.includes('未保存')`), 'unsaved edit');
  const cancelled = join(scratch, 'cancelled.html');
  await triggerExport('html', null);
  await sleep(300);
  if (existsSync(cancelled) || await evaluate(`!!document.querySelector('${active} .operation-result-dialog')`))
    throw Error('Cancelled export changed state');
  writeFileSync(htmlTarget, 'do not replace');
  await triggerExport('html', htmlTarget, false);
  await sleep(300);
  if (readFileSync(htmlTarget, 'utf8') !== 'do not replace') throw Error('Overwrite rejection changed target');
  const htmlResult = await exportFromMenu('html', htmlTarget);
  const html = readFileSync(htmlTarget, 'utf8');
  if (!html.includes('未保存导出标记') || !html.includes('data:image/png;base64,') || !html.includes('<math') ||
      !html.includes('第 46 行中文') || !html.includes('{{ unknown_extension }}') || html.includes('<script>') || html.includes('author: Mintdown') ||
      html.includes('class="app-menu-bar"') || !html.includes('图片未找到：missing.png'))
    throw Error('Standalone HTML content incorrect');
  if (readFileSync(markdown, 'utf8') !== source) throw Error('Export changed original Markdown');
  const pdfResult = await exportFromMenu('pdf', pdfTarget);
  const pdf = readFileSync(pdfTarget);
  if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-')) || statSync(pdfTarget).size < 3000)
    throw Error('PDF missing or invalid');
  if (readFileSync(markdown, 'utf8') !== source) throw Error('PDF export changed original Markdown');
  if (!await evaluate(`document.querySelector('${active} .document-name')?.textContent?.includes('未保存')`))
    throw Error('Export cleared the unsaved state');
  const failed = join(scratch, 'nonexistent-parent', 'failed.html');
  await triggerExport('html', failed);
  await waitFor(() => evaluate(`document.querySelector('.export-notice[data-phase="error"]')?.textContent?.includes('HTML 导出失败')`), 'write failure');
  if (existsSync(failed) || readFileSync(markdown, 'utf8') !== source) throw Error('Write failure damaged files');
  await evaluate(`document.querySelector('[aria-label="关闭导出状态"]').click()`);
  const secondMarkdown = join(folder, '第二篇.md');
  const secondSource = '第二篇独立文档\n\n单独导出的正文。\n';
  writeFileSync(secondMarkdown, secondSource);
  await evaluate(`window.__TAURI_INTERNALS__.invoke('open_path_tab',{path:${JSON.stringify(secondMarkdown)}})`);
  await waitFor(() => evaluate(`document.querySelectorAll('.document-tab').length===2`), 'second tab');
  await waitFor(() => evaluate(`document.querySelector('${active} .document-name')?.textContent?.includes('第二篇.md')`), 'second tab active');
  const secondHtml = join(scratch, '第二篇.html');
  await exportFromMenu('html', secondHtml);
  await exportFromMenu('pdf', join(scratch, 'no-headings.pdf'));
  if (!readFileSync(secondHtml, 'utf8').includes('单独导出的正文') || readFileSync(secondHtml, 'utf8').includes('第 46 行中文') ||
      readFileSync(secondMarkdown, 'utf8') !== secondSource) throw Error('Multi-tab export mixed source documents');
  await evaluate(`[...document.querySelectorAll('${active} .menu-trigger')].find(e=>e.textContent==='视图').click()`);
  await waitFor(() => evaluate(`!!document.querySelector('${active} .menu-popup:not([hidden])')`), 'view menu');
  await evaluate(`[...document.querySelectorAll('${active} .menu-popup:not([hidden]) .menu-entry > button')].find(e=>e.textContent?.startsWith('源码模式')).click()`);
  await waitFor(() => evaluate(`!!document.querySelector('${active} .canonical-editor[data-mode="source"] .cm-content')`), 'source mode');
  const sourceHtml = join(scratch, '源码模式.html');
  await exportFromMenu('html', sourceHtml);
  if (!readFileSync(sourceHtml, 'utf8').includes('单独导出的正文')) throw Error('Source-mode export failed');
  await evaluate(`[...document.querySelectorAll('${active} .menu-trigger')].find(e=>e.textContent==='文件').click()`);
  await waitFor(() => evaluate(`!!document.querySelector('${active} .menu-popup:not([hidden])')`), 'new document menu');
  await evaluate(`[...document.querySelectorAll('${active} .menu-popup:not([hidden]) .menu-entry > button')].find(e=>e.textContent?.startsWith('新建文档')).click()`);
  await waitFor(() => evaluate(`document.querySelectorAll('.document-tab').length===3`), 'untitled tab');
  await waitFor(() => evaluate(`!!${editor}`), 'untitled editor');
  const draft = '# 未命名直接导出\n\n尚未保存 Markdown。\n\n' + '供活动标签继续编辑的中文正文。\n\n'.repeat(40);
  await evaluate(`(() => {const view=${editor};view.dispatch({changes:{from:0,insert:${JSON.stringify(draft)}}});view.dispatch({selection:{anchor:120}});document.querySelector('${active} .editor-scroll').scrollTop=300})()`);
  const untitledHtml = join(scratch, '未命名.html');
  await exportFromMenu('html', untitledHtml);
  if (!readFileSync(untitledHtml, 'utf8').includes('尚未保存 Markdown')) throw Error('Untitled direct export failed');
  const snapshot = () => evaluate(`(()=>{const v=${editor};return {tab:document.querySelector('${active}').dataset.tabId,source:v.state.doc.toString(),selection:v.state.selection.toJSON(),scroll:document.querySelector('${active} .editor-scroll').scrollTop,dirty:document.querySelector('${active} .document-name').textContent}})()`);
  const beforeInactive = await snapshot();
  const inactiveHtml = join(scratch, '非活动标签.html');
  await contextExport('html', inactiveHtml);
  const inactiveHtmlMetrics = await finishContextExport('html');
  if (JSON.stringify(beforeInactive) !== JSON.stringify(await snapshot())) throw Error('Inactive export changed active tab, cursor, scroll, dirty state or content');
  if (!readFileSync(inactiveHtml, 'utf8').includes('未保存导出标记') || readFileSync(inactiveHtml, 'utf8').includes('尚未保存 Markdown')) throw Error('Inactive HTML used wrong document');
  if (!JSON.stringify(await evaluate('window.__exportDefault')).includes('导出 样例.html')) throw Error('Inactive filename did not use target document');
  // Re-export the same image path after a disk edit: per-job image caches must refresh.
  const changedImage = testPng(190, 130, 70);
  writeFileSync(join(images, '第二张.png'), changedImage);
  await contextExport('html', join(scratch, '图片更新.html'));
  await finishContextExport('html');
  if (!readFileSync(join(scratch, '图片更新.html'), 'utf8').includes(changedImage.toString('base64'))) throw Error('Image cache exported old disk content');
  const firstView = `document.querySelectorAll('.document-tab-panel')[0]?.querySelector('.cm-content')?.cmTile?.root?.view`;
  await evaluate(`(()=>{const v=${firstView};v.dispatch({changes:{from:v.state.doc.length,insert:${JSON.stringify('新一轮正文缓存验证。\n\n' + '长文档导出不应阻止其他标签输入。'.repeat(1500))}}})})()`);
  const inactivePdf = join(scratch, '非活动标签.pdf');
  await contextExport('pdf', inactivePdf);
  await waitFor(() => evaluate(`!!document.querySelector('.export-notice[data-phase="working"]')`), 'nonblocking export progress');
  await evaluate(`document.querySelector('${active} .cm-content').focus({preventScroll:true})`);
  const inputStart = performance.now();
  await send('Input.insertText', { text: '导出期间继续输入' });
  await waitFor(() => evaluate(`${editor}.state.doc.toString().includes('导出期间继续输入')`), 'editing during PDF export');
  const editingResponseMs = performance.now() - inputStart;
  const inactivePdfMetrics = await finishContextExport('pdf');
  if ((await snapshot()).tab !== beforeInactive.tab || readFileSync(markdown, 'utf8') !== source) throw Error('Inactive PDF switched tab or wrote Markdown');
  const printTargets = (await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json())).filter(t => t.url.includes('export-temp'));
  if (printTargets.length !== 1 || inactivePdfMetrics.native.reusedView !== 1) throw Error('PDF view was not safely reused');
  await evaluate(`document.querySelector('.document-tab:nth-child(2) [role="tab"]').click()`);
  const beforeDraftExport = await snapshot();
  await contextExport('html', join(scratch, '非活动未命名.html'), 3);
  await finishContextExport('html');
  if (!readFileSync(join(scratch, '非活动未命名.html'), 'utf8').includes('导出期间继续输入') ||
    !JSON.stringify(await evaluate('window.__exportDefault')).includes('untitled.html') ||
    JSON.stringify(beforeDraftExport) !== JSON.stringify(await snapshot())) throw Error('Inactive untitled export lost content or changed active state');
  await evaluate(`[...document.querySelectorAll('${active} .menu-trigger')].find(e=>e.textContent==='文件').click()`);
  await evaluate(`[...document.querySelectorAll('${active} .menu-popup:not([hidden]) button')].find(e=>e.textContent?.startsWith('偏好设置')).click()`);
  await waitFor(() => evaluate(`!!document.querySelector('.preferences-document-tab')`), 'preferences tab');
  await evaluate(`(()=>{const e=document.querySelector('.preferences-document-tab');const r=e.getBoundingClientRect();e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.x+20,clientY:r.y+10}))})()`);
  await waitFor(() => evaluate(`!!document.querySelector('.tab-context-menu')`), 'preferences context menu');
  if (await evaluate(`document.querySelector('.tab-context-menu').textContent.includes('导出')`)) throw Error('Preferences tab offers Markdown export');
  await send('Input.dispatchKeyEvent', { type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27 });
  await send('Input.dispatchKeyEvent', { type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27 });
  const output = { scratch, markdown, htmlTarget, pdfTarget, htmlBytes: statSync(htmlTarget).size,
    pdfBytes: statSync(pdfTarget).size, htmlResult, pdfResult, originalUnchanged: true,
    cancelled: true, rejectedOverwrite: true, writeFailureSafe: true,
    multiTabIsolated: true, sourceModeExported: true, untitledExported: true,
    inactiveHtml, inactivePdf, inactiveHtmlMetrics, inactivePdfMetrics, activeStateUnchanged: true,
    imageCacheRefreshed: true, editingResponseMs, printViews: printTargets.length, preferencesNoExport: true };
  await evaluate(`void window.__TAURI_INTERNALS__.invoke('plugin:window|destroy',{label:window.__TAURI_INTERNALS__.metadata.currentWindow.label});true`);
  const ownerClosed = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]);
  if (!ownerClosed) throw Error('Pooled print window kept the application alive after owner closed');
  output.ownerCloseCleanedPrintView = true;
  writeFileSync(join(scratch, 'result.json'), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
} finally {
  socket?.close();
  app.kill();
}
