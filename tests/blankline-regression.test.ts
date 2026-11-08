import { editorViewCtx } from '@milkdown/kit/core';
import { expect, it } from 'vitest';
import { createUnifiedMilkdown } from '../src/editor/createUnifiedMilkdown';

it('已存在的合法 <br /> 在其他正文编辑后仍原样保留', async () => {
  const source = '第一段\n\n\n第二段\n\n<br />\n\n最后一段\n';
  const host = document.createElement('div');
  document.body.append(host);
  let serialized = source;
  const editor = createUnifiedMilkdown(host, source, (markdown, error) => { if (error) throw new Error(error); serialized = markdown; });
  await editor.create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  view.dispatch(view.state.tr.insertText('！', 3));
  expect(serialized.split('<br />').length - 1).toBe(1);
  await editor.destroy();
  host.remove();
});

it('新增空段落序列化为 Markdown 空行，而非字面量 <br />', async () => {
  const source = '第一段\n\n第二段\n';
  const host = document.createElement('div');
  document.body.append(host);
  let serialized = source;
  const editor = createUnifiedMilkdown(host, source, (markdown, error) => { if (error) throw new Error(error); serialized = markdown; });
  await editor.create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  const empty = view.state.schema.nodes.paragraph.create();
  view.dispatch(view.state.tr.insert(4, empty));
  expect(serialized).toBe('第一段\n\n\n第二段\n');
  await editor.destroy();
  host.remove();
});

it('Front Matter 后编辑空行仍保持文件首行及原始标记', async () => {
  const source = '---\ntitle: 测试\n---\n\n第一段\n\n第二段\n\n<!--more-->\n';
  const host = document.createElement('div'); document.body.append(host);
  let serialized = source;
  const editor = createUnifiedMilkdown(host, source, (markdown, error) => {
    if (error) throw new Error(error);
    serialized = markdown;
  });
  await editor.create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  let afterFirst = -1;
  view.state.doc.forEach((node, position) => {
    if (node.textContent === '第一段') afterFirst = position + node.nodeSize;
  });
  expect(afterFirst).toBeGreaterThan(0);
  view.dispatch(view.state.tr.insert(afterFirst, view.state.schema.nodes.paragraph.create()));
  expect(serialized.startsWith('---\ntitle: 测试\n---')).toBe(true);
  expect(serialized).toContain('第一段\n\n\n第二段');
  expect(serialized).toContain('<!--more-->');
  expect(serialized.split('<br />')).toHaveLength(1);
  await editor.destroy(); host.remove();
});
