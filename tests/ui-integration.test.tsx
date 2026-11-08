import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
import { afterEach, expect, it } from 'vitest';
import { App } from '../src/App';
import { DocumentSession } from '../src/document/DocumentSession';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => document.body.replaceChildren());

it('单一可视编辑流显示原文、Front Matter、KaTeX；切源码再切回仍保留', async () => {
  const source = readFileSync(resolve('tests/fixtures/hexo-article.md'), 'utf8') + '\n公式：$E=mc^2$\n';
  const session = DocumentSession.fromText(source);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<App initialSession={session} />); });
  expect(session.isDirty()).toBe(false);
  expect(host.querySelectorAll('.ProseMirror')).toHaveLength(1);
  expect(host.querySelectorAll('[data-preserved-raw]')).toHaveLength(4);
  expect(host.querySelector('[data-preserved-raw]')?.textContent).toContain('title: "Hexo: 测试文章"');
  expect(host.querySelector('[data-preserved-raw]')?.textContent).not.toContain('摘要分隔线');
  expect(host.querySelector('.katex')).not.toBeNull();
  expect(host.querySelector('[data-preserved-raw]')?.querySelector('script')).toBeNull();

  const button = [...host.querySelectorAll('button')].find((item) => item.textContent === '源码模式')!;
  await act(async () => { button.click(); });
  expect(host.querySelector('[data-testid="source-editor"]')).not.toBeNull();
  expect(host.querySelector('.cm-content')?.textContent).toContain('<!--more-->');
  expect(host.querySelector('.cm-content')?.textContent).toContain('data-name="raw-block"');
  const cm = EditorView.findFromDOM(host.querySelector('.cm-editor')!);
  expect(cm).not.toBeNull();
  const start = cm!.state.doc.toString().indexOf('title: "Hexo: 测试文章"');
  await act(async () => {
    cm!.dispatch({ changes: { from: start, to: start + 'title: "Hexo: 测试文章"'.length, insert: 'title: "源码修改"' } });
  });
  const visual = [...host.querySelectorAll('button')].find((item) => item.textContent === '可视模式')!;
  await act(async () => { visual.click(); });
  expect(host.querySelector('[data-preserved-raw]')?.textContent).toContain('源码修改');
  expect(host.querySelectorAll('.ProseMirror')).toHaveLength(1);
  expect(host.querySelectorAll('[data-preserved-raw]')).toHaveLength(4);
  expect(session.getSource()).toContain('<!-- some-unrecognized-comment: do-not-drop -->');
  await act(async () => { root.unmount(); });
});

it('原始 script 作为同一编辑流中的可见文本，不成为 DOM 脚本节点', async () => {
  const session = DocumentSession.fromText('# 标题\n\n<script>window.__stageAUnsafe = true</script>\n');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<App initialSession={session} />); });
  expect(host.querySelector('script')).toBeNull();
  expect(host.querySelector('[data-preserved-raw]')?.textContent).toContain('<script>window.__stageAUnsafe = true</script>');
  expect(session.toBytes()).toEqual(new TextEncoder().encode(session.getSource()));
  await act(async () => { root.unmount(); });
});

it('在可视模式打开另一份文件会重新创建统一编辑器并显示新内容', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<App initialSession={DocumentSession.fromText('# 旧文件')} />); });
  expect(host.querySelector('.ProseMirror')?.textContent).toContain('旧文件');
  const bytes = new TextEncoder().encode('# 新文件\n\n<!-- more -->');
  const file = new File([bytes], 'new.md', { type: 'text/markdown' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer });
  const input = host.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(host.querySelector('.ProseMirror')?.textContent).toContain('新文件');
  expect(host.querySelector('[data-preserved-raw]')?.textContent).toBe('<!-- more -->');
  await act(async () => { root.unmount(); });
});
