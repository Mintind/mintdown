import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
import { editorViewCtx } from '@milkdown/kit/core';
import { afterEach, expect, it, vi } from 'vitest';
import { DocumentSession } from '../src/document/DocumentSession';
import { createUnifiedMilkdown } from '../src/editor/createUnifiedMilkdown';

const native = vi.hoisted(() => ({
  open: vi.fn(), save: vi.fn(), openWindow: vi.fn(), registerTab: vi.fn(async () => {}), releaseTab: vi.fn(async () => {}),
  loadRecovery: vi.fn(), saveRecovery: vi.fn(), clearRecovery: vi.fn(),
}));
vi.mock('../src/native/fileBridge', () => ({
  nativeFiles: native,
  explainNativeError: (error: unknown) => error,
}));
vi.mock('../src/native/sessionBridge', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/native/sessionBridge')>()),
  nativeSession: { read: vi.fn(async () => null), save: vi.fn(async () => {}), takePendingOpens: vi.fn(async () => []) },
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'file-test', onCloseRequested: async () => () => {}, destroy: vi.fn() }),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(async () => false), open: vi.fn(), save: vi.fn() }));

import { DesktopApp } from '../src/native/DesktopApp';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { document.body.replaceChildren(); vi.clearAllMocks(); history.replaceState({}, '', '/'); });

it('原始文件经源码编辑、Ctrl+S 后保留 BOM、CRLF 和受保护片段，并更新已保存状态', async () => {
  const bytes = readFileSync(resolve('tests/fixtures/hexo-article.md'));
  const original = new DocumentSession(bytes);
  const withBom = new Uint8Array(3 + bytes.length);
  withBom.set([0xef, 0xbb, 0xbf]); withBom.set(bytes, 3);
  const session = new DocumentSession(withBom);
  const source = session.getSource().replace(/\r?\n/g, '\r\n');
  const crlf = new TextEncoder().encode('\ufeff' + source);
  native.open.mockResolvedValue({ path: 'C:\\文章 空格\\测试.md', bytes: Array.from(crlf), fingerprint: 'before' });
  native.loadRecovery.mockResolvedValue(null);
  native.clearRecovery.mockResolvedValue(undefined);
  native.save.mockResolvedValue({ fingerprint: 'after' });
  history.replaceState({}, '', '/?path=' + encodeURIComponent('C:\\文章 空格\\测试.md'));
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<DesktopApp />); await new Promise((done) => setTimeout(done, 0)); });
  expect(host.textContent).toContain('已保存');
  await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === '源码模式')!.click(); });
  const view = EditorView.findFromDOM(host.querySelector('.cm-editor')!)!;
  await act(async () => { view.dispatch({ changes: { from: view.state.doc.length, insert: '\n新增段落' } }); });
  expect(host.textContent).toContain('未保存');
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })); });
  expect(native.save).toHaveBeenCalledTimes(1);
  const [, fingerprint, saved] = native.save.mock.calls[0] as [string, string, Uint8Array];
  expect(fingerprint).toBe('before');
  const text = new TextDecoder().decode(saved);
  expect(Array.from(saved.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
  expect(text).toContain('<!--more-->');
  expect(text).toContain('title: "Hexo: 测试文章"');
  expect(text).toContain('\r\n新增段落');
  expect(text).not.toMatch(/(?<!\r)\n/);
  expect(host.textContent).toContain('已保存');
  expect(original.getSource()).toContain('<!--more-->');
  await act(async () => { root.unmount(); });
});

it('外部修改冲突后保留编辑状态，并要求明确选择', async () => {
  native.open.mockResolvedValue({ path: 'C:\\文章.md', bytes: Array.from(new TextEncoder().encode('原文\n')), fingerprint: 'before' });
  native.loadRecovery.mockResolvedValue(null);
  native.clearRecovery.mockResolvedValue(undefined);
  native.saveRecovery.mockResolvedValue(undefined);
  native.save.mockRejectedValue({ kind: 'conflict', message: '磁盘文件已被其他程序修改' });
  history.replaceState({}, '', '/?path=' + encodeURIComponent('C:\\文章.md'));
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<DesktopApp />); await new Promise((done) => setTimeout(done, 0)); });
  await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === '源码模式')!.click(); });
  const view = EditorView.findFromDOM(host.querySelector('.cm-editor')!)!;
  await act(async () => { view.dispatch({ changes: { from: view.state.doc.length, insert: '本地修改' } }); });
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })); });
  expect(host.textContent).toContain('磁盘文件已变化');
  expect(host.textContent).toContain('未保存');
  expect(view.state.doc.toString()).toContain('本地修改');
  expect(native.saveRecovery).toHaveBeenCalled();
  await act(async () => { root.unmount(); });
});

it('无法安全序列化的可视输入仍可捕获为恢复状态', async () => {
  const host = document.createElement('div'); document.body.append(host);
  const session = DocumentSession.fromText('正文');
  let problem = '';
  let visualState: unknown;
  const editor = createUnifiedMilkdown(host, session.getSource(), (source, error) => {
    problem = error ?? '';
    if (!error) session.setSource(source);
  }, (state) => { visualState = state; });
  await editor.create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  view.dispatch(view.state.tr.insertText('<!--unknown-->', 1));
  expect(problem).toContain('无法安全序列化');
  expect(session.getSource()).toBe('正文');
  expect(JSON.stringify(visualState)).toContain('<!--unknown-->');
  await editor.destroy();
});

it('保存成功后同一会话重置未保存状态且保持原始 BOM', () => {
  const session = new DocumentSession(new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0x0d, 0x0a]));
  session.setSource('A\r\nB\r\n');
  const bytes = session.toBytes();
  session.markSaved(bytes);
  expect(session.isDirty()).toBe(false);
  expect(session.toBytes()).toEqual(bytes);
  expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
});
