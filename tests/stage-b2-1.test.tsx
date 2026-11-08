import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorView as CodeMirrorView } from '@codemirror/view';
import { history as cmHistory, undo, redo } from '@codemirror/commands';
import { editorViewCtx } from '@milkdown/kit/core';
import { TextSelection } from '@milkdown/kit/prose/state';
import { afterEach, expect, it, vi } from 'vitest';
import { createUnifiedMilkdown } from '../src/editor/createUnifiedMilkdown';
import { outlineFromDocument, outlineFromMarkdown, activeHeadingIndex } from '../src/ui/outline';
import { clampFontSize, defaultPreferences, readPreferences, writePreferences } from '../src/ui/preferences';
import { setSourceHeading, setVisualHeading } from '../src/ui/editorCommands';

const native = vi.hoisted(() => ({
  open: vi.fn(), save: vi.fn(), openWindow: vi.fn(), registerTab: vi.fn(async () => {}), releaseTab: vi.fn(async () => {}),
  loadRecovery: vi.fn(), saveRecovery: vi.fn(), clearRecovery: vi.fn(),
}));
vi.mock('../src/native/fileBridge', () => ({ nativeFiles: native, explainNativeError: (error: unknown) => error }));
vi.mock('../src/native/sessionBridge', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/native/sessionBridge')>()),
  nativeSession: { read: vi.fn(async () => null), save: vi.fn(async () => {}), takePendingOpens: vi.fn(async () => []) },
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'b2-1-test', onCloseRequested: async () => () => {}, destroy: vi.fn() }),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(async () => false), open: vi.fn(), save: vi.fn() }));

import { DesktopApp } from '../src/native/DesktopApp';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout geometry; CodeMirror may measure its standalone test view on a later frame.
if (!Range.prototype.getClientRects) Object.defineProperty(Range.prototype, 'getClientRects', { value: () => [] });
afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  vi.clearAllMocks();
  history.replaceState({}, '', '/');
});

async function mount(source = '# 第一章\n\n## 小节\n\n正文\n\n# 第二章\n', strict = false) {
  native.open.mockResolvedValue({ path: 'C:\\中文 路径\\文章.md', bytes: Array.from(new TextEncoder().encode(source)), fingerprint: 'first' });
  native.loadRecovery.mockResolvedValue(null);
  native.clearRecovery.mockResolvedValue(undefined);
  native.saveRecovery.mockResolvedValue(undefined);
  native.save.mockResolvedValue({ fingerprint: 'second' });
  history.replaceState({}, '', '/?path=' + encodeURIComponent('C:\\中文 路径\\文章.md'));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(strict ? <StrictMode><DesktopApp /></StrictMode> : <DesktopApp />); await new Promise((done) => setTimeout(done, 0)); });
  for (let attempt = 0; attempt < 50 && !host.querySelector('.canonical-editor .cm-editor'); attempt++)
    await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
  expect(host.querySelector('.canonical-editor .cm-editor')).not.toBeNull();
  return { host, root };
}

async function waitForSelectionText(host: HTMLElement, text: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const editor = host.querySelector<HTMLElement>('.canonical-editor .cm-editor');
    const view = editor && CodeMirrorView.findFromDOM(editor);
    if (view?.state.doc.lineAt(view.state.selection.main.head).text.includes(text) &&
        document.activeElement === view.contentDOM) return;
    await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
  }
  const view = CodeMirrorView.findFromDOM(host.querySelector('.canonical-editor .cm-editor')!)!;
  expect(view.state.doc.lineAt(view.state.selection.main.head).text).toContain(text);
  expect(document.activeElement).toBe(view.contentDOM);
}

async function waitForSourceCaret(host: HTMLElement, position: number) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const element = host.querySelector<HTMLElement>('.cm-editor');
    const view = element && CodeMirrorView.findFromDOM(element);
    if (view?.state.selection.main.head === position && document.activeElement === view.contentDOM) return view;
    await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
  }
  const view = CodeMirrorView.findFromDOM(host.querySelector('.cm-editor')!)!;
  expect(view.state.selection.main.head).toBe(position);
  expect(document.activeElement).toBe(view.contentDOM);
  return view;
}

it('大纲只收集真实标题并按级别与位置导航', () => {
  const headings = outlineFromMarkdown('---\ntitle: 测试\n---\n\n# 第一 **章**\n\n```md\n# 代码\n```\n\n## 小节\n');
  expect(headings.map(({ level, text }) => [level, text])).toEqual([[1, '第一 章'], [2, '小节']]);
  expect(activeHeadingIndex(headings, headings[1].position)).toBe(1);
});

it('默认大纲、标题修改、点击跳转和当前章节高亮', async () => {
  const { host, root } = await mount();
  expect(host.querySelector('[aria-label="文档大纲"]')).not.toBeNull();
  expect([...host.querySelectorAll('[role="treeitem"]')].map((item) => item.textContent)).toEqual(['第一章', '小节', '第二章']);
  await act(async () => { (host.querySelectorAll('[role="treeitem"]')[2] as HTMLButtonElement).click(); });
  expect(host.querySelector('[role="treeitem"][aria-current="location"]')?.textContent).toBe('第二章');
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', code: 'Slash', ctrlKey: true, bubbles: true })); });
  const source = CodeMirrorView.findFromDOM(host.querySelector('.cm-editor')!)!;
  await act(async () => { source.dispatch({ changes: { from: 2, to: 5, insert: '改名' } }); });
  expect(host.querySelector('[role="treeitem"]')?.textContent).toBe('改名');
  await act(async () => { root.unmount(); });
});

it('可视模式标题快捷命令只修改光标所在段落', async () => {
  const host = document.createElement('div'); document.body.append(host);
  const editor = createUnifiedMilkdown(host, '前一段\n\n后一段', () => {});
  await editor.create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(8))));
  for (let level = 1; level <= 6; level++) {
    expect(setVisualHeading(view, level)).toBe(true);
    expect(outlineFromDocument(view.state.doc).map(({ level, text }) => [level, text])).toEqual([[level, '后一段']]);
  }
  expect(view.state.doc.firstChild?.type.name).toBe('paragraph');
  expect(setVisualHeading(view, 0)).toBe(true);
  expect(outlineFromDocument(view.state.doc)).toEqual([]);
  await editor.destroy();
});

it('源码标题命令只修改当前行，不触碰代码围栏', () => {
  const host = document.createElement('div'); document.body.append(host);
  const view = new CodeMirrorView({ doc: '正文\n\n```js\ncode\n```\n\n尾段', parent: host });
  view.dispatch({ selection: { anchor: view.state.doc.line(7).from + 1 } });
  expect(setSourceHeading(view, 4)).toBe(true);
  expect(view.state.doc.line(7).text).toBe('#### 尾段');
  expect(view.state.doc.line(1).text).toBe('正文');
  view.dispatch({ selection: { anchor: view.state.doc.line(4).from + 1 } });
  expect(setSourceHeading(view, 2)).toBe(false);
  expect(view.state.doc.line(4).text).toBe('code');
  view.destroy();
});

it('标题等级与普通段落互转保留正文中的光标和选区', () => {
  for (const original of ['前中文后', '# 前中文后', '#### 前中文后']) {
    for (const level of [0, 1, 2, 3, 4, 5, 6]) {
      const view = new CodeMirrorView({ doc: original, parent: document.body });
      for (const offset of [0, 2, 4]) {
        const textFrom = view.state.doc.toString().indexOf('前');
        view.dispatch({ selection: { anchor: textFrom + offset } });
        expect(setSourceHeading(view, level)).toBe(true);
        expect(view.state.selection.main.head - view.state.doc.toString().indexOf('前')).toBe(offset);
      }
      const start = view.state.doc.toString().indexOf('前');
      view.dispatch({ selection: { anchor: start + 1, head: start + 3 } });
      expect(setSourceHeading(view, (level + 1) % 7)).toBe(true);
      const nextStart = view.state.doc.toString().indexOf('前');
      expect(view.state.selection.main.anchor - nextStart).toBe(1);
      expect(view.state.selection.main.head - nextStart).toBe(3);
      view.destroy();
    }
  }
});

it('标题转换的撤销与重做仍定位到原正文附近', () => {
  const view = new CodeMirrorView({ doc: '前中文后', parent: document.body, extensions: [cmHistory()] });
  view.dispatch({ selection: { anchor: 3 } });
  expect(setSourceHeading(view, 3)).toBe(true);
  expect(view.state.doc.toString()).toBe('### 前中文后');
  expect(view.state.selection.main.head).toBe(7);
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe('前中文后');
  expect(view.state.selection.main.head).toBe(3);
  expect(redo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe('### 前中文后');
  // CodeMirror history may restore the end of the changed line on redo, but
  // must not put the caret back inside the generated Markdown prefix.
  expect(view.state.selection.main.head).toBeGreaterThanOrEqual(4);
  expect(view.state.selection.main.head).toBeLessThanOrEqual(view.state.doc.length);
  view.destroy();
});

it('快捷键打开模式和查找入口，且不拦截 IME 合成事件', async () => {
  const { host, root } = await mount('普通正文');
  await act(async () => { (host.querySelector('.cm-content') as HTMLElement).focus(); window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', code: 'Slash', ctrlKey: true, bubbles: true })); });
  expect(host.querySelector('.cm-content')).not.toBeNull();
  const source = CodeMirrorView.findFromDOM(host.querySelector('.cm-editor')!)!;
  await act(async () => { source.focus(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true })); });
  expect(host.querySelector('[aria-label="查找面板"]')).not.toBeNull();
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', ctrlKey: true, bubbles: true })); });
  expect(host.querySelector('[aria-label="替换面板"]')).not.toBeNull();
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', code: 'Slash', ctrlKey: true, isComposing: true, bubbles: true })); });
  expect(host.querySelector('.cm-content')).not.toBeNull();
  await act(async () => { root.unmount(); });
});

it('侧栏折叠、宽度和深色主题持久化', async () => {
  const { host, root } = await mount();
  await act(async () => { (host.querySelector('[aria-label="隐藏大纲"]') as HTMLButtonElement).click(); });
  expect(host.querySelector('[aria-label="文档大纲"]')).toBeNull();
  await act(async () => { (host.querySelector('[aria-label="显示大纲"]') as HTMLButtonElement).click(); });
  const separator = host.querySelector('[role="separator"]')!;
  await act(async () => {
    separator.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 250 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 320 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  });
  expect(host.querySelector('.desktop-app')?.getAttribute('style')).toContain('334px');
  await act(async () => { [...host.querySelectorAll('.menu-trigger')].find((button) => button.textContent === '视图')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await act(async () => { [...host.querySelectorAll('.menu-entry button')].find((button) => button.textContent === '深色主题')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(readPreferences()).toMatchObject({ outlineOpen: true, outlineWidth: 334, theme: 'dark' });
  await act(async () => { root.unmount(); });
  writePreferences({ ...defaultPreferences, theme: 'dark', outlineOpen: false });
  const second = await mount();
  expect(second.host.querySelector('[aria-label="文档大纲"]')).toBeNull();
  expect(second.host.querySelector('.desktop-app')?.getAttribute('data-theme')).toBe('dark');
  await act(async () => { second.root.unmount(); });
});

it('源码切回可视模式时保留连续空行并定位到原光标，返回源码仍保持原文', async () => {
  const original = '# 标题\n\n\n\n第一段\n\n\n第二段';
  const { host, root } = await mount(original);
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', code: 'Slash', ctrlKey: true, bubbles: true })); });
  const source = CodeMirrorView.findFromDOM(host.querySelector('.cm-editor')!)!;
  const target = original.indexOf('第二段') + 2;
  await act(async () => { source.dispatch({ selection: { anchor: target } }); });
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', code: 'Slash', ctrlKey: true, bubbles: true }));
  });
  await waitForSelectionText(host, '第二段');
  expect(host.querySelector('.canonical-editor[data-mode="visual"]')).not.toBeNull();
  expect([...host.querySelectorAll('.canonical-editor .cm-line')].filter((line) => !line.textContent).length).toBe(5);
  expect(source.state.doc.lineAt(source.state.selection.main.head).text).toContain('第二段');
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', code: 'Slash', ctrlKey: true, bubbles: true })); });
  const returned = await waitForSourceCaret(host, target);
  expect(returned.state.doc.toString()).toBe(original);
  expect(returned.state.selection.main.head).toBe(target);
  await act(async () => { root.unmount(); });
});

it('临时源码视图卸载后仍将光标恢复到正式视图', async () => {
  const original = '# 开始\n\n正文\n\n## 后段';
  const { host, root } = await mount(original, true);
  await act(async () => { (host.querySelectorAll('[role="treeitem"]')[1] as HTMLButtonElement).click(); });
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', code: 'Slash', ctrlKey: true, bubbles: true }));
    await new Promise((done) => setTimeout(done, 100));
  });
  const source = CodeMirrorView.findFromDOM(host.querySelector('.cm-editor')!)!;
  expect(source.state.doc.lineAt(source.state.selection.main.head).text).toBe('## 后段');
  expect(document.activeElement).toBe(source.contentDOM);
  await act(async () => { root.unmount(); });
});

it('默认字号更大，字号设置限制在可读范围并持久化', () => {
  expect(defaultPreferences.fontSize).toBe(18);
  expect(clampFontSize(8)).toBe(14);
  expect(clampFontSize(32)).toBe(26);
  writePreferences({ ...defaultPreferences, fontSize: 21 });
  expect(readPreferences().fontSize).toBe(21);
});

it('源码模式 Tab 插入四格缩进', async () => {
  const { host, root } = await mount('正文');
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', code: 'Slash', ctrlKey: true, bubbles: true })); });
  const source = CodeMirrorView.findFromDOM(host.querySelector('.cm-editor')!)!;
  await act(async () => {
    source.dispatch({ selection: { anchor: 0 } });
    source.focus();
    source.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  });
  expect(source.state.doc.toString()).toBe('    正文');
  await act(async () => { root.unmount(); });
});

it('文件菜单与 Ctrl+, 打开独立的四分类偏好设置标签并保留原文', async () => {
  const original = '# 设置测试\n\n正文';
  const { host, root } = await mount(original);
  const documentView = CodeMirrorView.findFromDOM(host.querySelector('.cm-editor')!)!;
  await act(async () => {
    [...host.querySelectorAll<HTMLButtonElement>('.menu-trigger')].find(button => button.textContent === '文件')!.click();
  });
  await act(async () => {
    [...host.querySelectorAll<HTMLButtonElement>('.menu-entry button')].find(button => button.textContent === '偏好设置')!.click();
  });
  expect([...host.querySelectorAll('.settings-categories [role="tab"]')].map(tab => tab.textContent))
    .toEqual(['外观', '编辑', '图片与附件', '文件与会话']);
  expect(host.querySelector('.preferences-document-tab [aria-selected="true"]')).not.toBeNull();
  expect(host.querySelector('.desktop-app')?.getAttribute('data-settings-open')).toBe('true');
  await act(async () => {
    [...host.querySelectorAll<HTMLButtonElement>('.settings-categories [role="tab"]')].find(button => button.textContent === '图片与附件')!.click();
  });
  const field = host.querySelector<HTMLInputElement>('[aria-label="资源目录模板"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'images/${filename}');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(readPreferences().imageDirectoryTemplate).toBe('images/${filename}');
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="关闭偏好设置"]')!.click(); });
  expect(host.querySelector('.preferences-document-tab')).toBeNull();
  expect(documentView.state.doc.toString()).toBe(original);
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', code: 'Comma', ctrlKey: true, bubbles: true, cancelable: true }));
  });
  expect(host.querySelector('.preferences-document-tab [aria-selected="true"]')).not.toBeNull();
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', ctrlKey: true, bubbles: true, cancelable: true }));
  });
  expect(host.querySelector('.preferences-document-tab')).toBeNull();
  expect(host.querySelectorAll('.document-tabs [role="tab"]')).toHaveLength(1);
  await act(async () => { root.unmount(); });
});
