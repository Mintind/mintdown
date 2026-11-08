import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ open: vi.fn(), registerTab: vi.fn(async () => {}), releaseTab: vi.fn(async () => {}),
  loadRecovery: vi.fn(), clearRecovery: vi.fn(async () => {}), saveRecovery: vi.fn(async (_key: string, _snapshot: {fingerprint: string}) => {}), save: vi.fn(), saveAs: vi.fn() }));
const dialogs = vi.hoisted(() => ({ ask: vi.fn(async () => false), message: vi.fn(async () => 'Cancel'), open: vi.fn(), save: vi.fn() }));
vi.mock('../src/native/fileBridge', () => ({ nativeFiles: native, explainNativeError: (e: any) => e }));
vi.mock('../src/native/sessionBridge', async original => ({ ...(await original<typeof import('../src/native/sessionBridge')>()),
  nativeSession: { read: vi.fn(async () => null), save: vi.fn(async () => {}), takePendingOpens: vi.fn(async () => []) } }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'd3-recovery', onCloseRequested: async () => () => {}, destroy: vi.fn() }) }));
vi.mock('@tauri-apps/plugin-dialog', () => dialogs);
import { DesktopApp } from '../src/native/DesktopApp';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot>;
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.replaceChildren(); localStorage.clear(); vi.clearAllMocks(); history.replaceState({}, '', '/'); });
async function mount(answer: string, named = true) {
  dialogs.message.mockResolvedValue(answer); dialogs.ask.mockResolvedValue(false);
  native.open.mockResolvedValue({ path: 'C:\\D3\\恢复.md', bytes: [...new TextEncoder().encode('# 磁盘正文\n')], fingerprint: 'disk' });
  native.loadRecovery.mockResolvedValue({ path: named ? 'C:\\D3\\恢复.md' : '', source: '# 恢复草稿\n', fingerprint: named ? 'disk' : '', unsafeVisual: false, savedAt: 'D3', visualState: null });
  localStorage.setItem('markdown-editor.b2-1.preferences', JSON.stringify({ spellCheck: false }));
  history.replaceState({}, '', named ? '/?path=' + encodeURIComponent('C:\\D3\\恢复.md') : '/');
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => { root.render(<DesktopApp />); await new Promise(done => setTimeout(done, 40)); });
  return host;
}
it.each([true, false])('cancel/close recovery preserves the snapshot and blocks empty writes (named=%s)', async named => {
  const host = await mount('Cancel', named);
  await act(async () => { await new Promise(done => setTimeout(done, 750)); });
  expect(native.clearRecovery).not.toHaveBeenCalled();
  expect(native.saveRecovery).not.toHaveBeenCalled();
  expect(host.textContent).toContain('快照保留');
  expect(host.querySelector('.cm-content')).toBeNull();
  await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent === '保存 Ctrl+S')!.click(); });
  expect(native.save).not.toHaveBeenCalled(); expect(native.saveAs).not.toHaveBeenCalled();
  dialogs.message.mockResolvedValue('恢复');
  await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent === '重新加载')!.click(); await new Promise(done => setTimeout(done, 40)); });
  expect(host.querySelector('.cm-content')?.textContent).toContain('恢复草稿');
  expect(native.clearRecovery).not.toHaveBeenCalled();
});
it('explicit discard loads disk content and clears the rejected snapshot', async () => {
  const host = await mount('放弃快照');
  expect(native.clearRecovery).toHaveBeenCalled();
  expect(host.querySelector('.cm-content')?.textContent).toContain('磁盘正文');
});
it('explicit restore loads unsaved content and marks it dirty', async () => {
  const host = await mount('恢复');
  expect(host.querySelector('.cm-content')?.textContent).toContain('恢复草稿');
  expect(host.textContent).toContain('未保存'); expect(native.clearRecovery).not.toHaveBeenCalled();
});
it('a recovered stale snapshot keeps its original disk fingerprint through subsequent snapshots', async () => {
  const host = await mount('Cancel');
  native.loadRecovery.mockResolvedValue({path:'C:\\D3\\恢复.md',source:'# 旧快照\n',fingerprint:'obsolete',unsafeVisual:false,savedAt:'D3',visualState:null});
  dialogs.message.mockResolvedValue('恢复');
  await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent === '重新加载')!.click(); await new Promise(done => setTimeout(done,40)); });
  await act(async () => { await new Promise(done => setTimeout(done,750)); });
  expect(host.textContent).toContain('磁盘文件已变化');
  expect(native.saveRecovery).toHaveBeenCalled();
  expect(native.saveRecovery.mock.calls.at(-1)![1].fingerprint).toBe('obsolete');
});
