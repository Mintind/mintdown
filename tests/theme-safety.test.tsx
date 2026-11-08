import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorView as CodeMirrorView } from '@codemirror/view';
import { afterEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  open: vi.fn(), save: vi.fn(), openWindow: vi.fn(), registerTab: vi.fn(async () => {}), releaseTab: vi.fn(async () => {}),
  loadRecovery: vi.fn(), saveRecovery: vi.fn(), clearRecovery: vi.fn(),
}));
vi.mock('../src/native/fileBridge', () => ({ nativeFiles: native, explainNativeError: (error: unknown) => error }));
vi.mock('../src/native/sessionBridge', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/native/sessionBridge')>()),
  nativeSession: { read: vi.fn(async () => null), save: vi.fn(async () => {}), takePendingOpens: vi.fn(async () => []) },
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'theme-test', onCloseRequested: async () => () => {}, destroy: vi.fn() }),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(async () => false), open: vi.fn(), save: vi.fn() }));

import { DesktopApp } from '../src/native/DesktopApp';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-theme');
  localStorage.clear();
  vi.clearAllMocks();
  history.replaceState({}, '', '/');
});

const original = '---\ntitle: 空行测试\n---\n\n# 标题\n\n第一段\n\n\n第二段\n\n<br />\n\n<!--more-->\n\n{% unknown %}\n\n```js\nconst x = 1;\n```\n';
const path = 'C:\\测试 空格\\主题.md';
const bytes = new TextEncoder().encode(original);

async function mount() {
  native.open.mockResolvedValue({ path, bytes: Array.from(bytes), fingerprint: 'fingerprint' });
  native.loadRecovery.mockResolvedValue(null);
  native.clearRecovery.mockResolvedValue(undefined);
  native.save.mockResolvedValue({ fingerprint: 'fingerprint' });
  history.replaceState({}, '', '/?path=' + encodeURIComponent(path));
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<DesktopApp />); await new Promise((done) => setTimeout(done, 0)); });
  for (let attempt = 0; attempt < 50 && !host.querySelector('.canonical-editor .cm-editor'); attempt++)
    await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
  expect(host.querySelector('.canonical-editor .cm-editor')).not.toBeNull();
  return { host, root };
}

async function toggleTheme(host: HTMLElement) {
  await act(async () => {
    [...host.querySelectorAll<HTMLButtonElement>('.menu-trigger')].find((button) => button.textContent === '视图')!.click();
  });
  await act(async () => {
    [...host.querySelectorAll<HTMLButtonElement>('.menu-entry button')].find((button) =>
      button.textContent === (document.documentElement.dataset.theme === 'light' ? '深色主题' : '浅色主题'))!.click();
  });
}

it('可视模式反复切换主题只改变 CSS，不重建编辑器、正文或未保存状态', async () => {
  const { host, root } = await mount();
  const visual = host.querySelector<HTMLElement>('.canonical-editor .cm-editor')!;
  const view = CodeMirrorView.findFromDOM(visual)!;
  expect(visual.textContent).toContain('<!--more-->');
  for (let index = 0; index < 6; index++) {
    await toggleTheme(host);
    expect(host.querySelector('.canonical-editor .cm-editor')).toBe(visual);
    expect(view.state.doc.toString()).toBe(original);
    expect(host.querySelector('.document-name')?.textContent).toContain('已保存');
  }
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })); });
  expect(Array.from(native.save.mock.calls[0][2] as Uint8Array)).toEqual(Array.from(bytes));
  await act(async () => { root.unmount(); });
});

it('源码模式主题切换保留原文、选区，并能保存后重新打开', async () => {
  const { host, root } = await mount();
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', code: 'Slash', ctrlKey: true, bubbles: true })); });
  const source = CodeMirrorView.findFromDOM(host.querySelector('.cm-editor')!)!;
  await act(async () => { source.dispatch({ selection: { anchor: 24, head: 27 } }); });
  for (let index = 0; index < 6; index++) {
    await toggleTheme(host);
    expect(CodeMirrorView.findFromDOM(host.querySelector('.cm-editor')!)).toBe(source);
    expect(source.state.doc.toString()).toBe(original);
    expect(source.state.selection.main.from).toBe(24);
    expect(source.state.selection.main.to).toBe(27);
  }
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })); });
  expect(new TextDecoder().decode(native.save.mock.calls[0][2])).toBe(original);
  await act(async () => { root.unmount(); });
  const reopened = await mount();
  expect(reopened.host.querySelector('.canonical-editor .cm-editor')?.textContent).toContain('第二段');
  expect(reopened.host.querySelector('.document-name')?.textContent).toContain('已保存');
  await act(async () => { reopened.root.unmount(); });
});

it('写盘等待期间出现新编辑时仍保持未保存状态和恢复快照', async () => {
  const { host, root } = await mount();
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', code: 'Slash', ctrlKey: true, bubbles: true })); });
  const view = CodeMirrorView.findFromDOM(host.querySelector('.cm-editor')!)!;
  let finishSave!: (result: { fingerprint: string }) => void;
  native.save.mockImplementation(() => new Promise((resolve) => { finishSave = resolve; }));
  await act(async () => { view.dispatch({ changes: { from: view.state.doc.length, insert: '\n第一次编辑' } }); });
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })); });
  expect(native.save).toHaveBeenCalledTimes(1);
  await act(async () => { view.dispatch({ changes: { from: view.state.doc.length, insert: '\n第二次编辑' } }); });
  await act(async () => { finishSave({ fingerprint: 'saved-first' }); await new Promise((done) => setTimeout(done, 0)); });
  expect(new TextDecoder().decode(native.save.mock.calls[0][2])).toContain('第一次编辑');
  expect(new TextDecoder().decode(native.save.mock.calls[0][2])).not.toContain('第二次编辑');
  expect(host.querySelector('.document-name')?.textContent).toContain('未保存');
  expect(native.saveRecovery).toHaveBeenCalledWith('document:c:\\测试 空格\\主题.md', expect.objectContaining({
    source: expect.stringContaining('第二次编辑'),
  }));
  await act(async () => { root.unmount(); });
});
