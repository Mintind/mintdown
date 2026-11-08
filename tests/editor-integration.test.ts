import { afterEach, expect, it } from 'vitest';
import { EditorView as CodeMirrorView } from 'codemirror';
import { editorViewCtx, serializerCtx } from '@milkdown/kit/core';
import { DocumentSession } from '../src/document/DocumentSession';
import { createUnifiedMilkdown } from '../src/editor/createUnifiedMilkdown';

afterEach(() => { document.body.replaceChildren(); });

it('整篇文档经 Milkdown 编辑、CodeMirror 修改源码、重新打开仍保留 Front Matter 和注释', async () => {
  const session = DocumentSession.fromText('---\ntitle: "标题"\n---\n\n正文。\n\n<!--more-->\n\n| 项目 | 状态 |\n| --- | --- |\n| **A** | ok |\n');
  const host = document.createElement('div');
  document.body.append(host);
  const editor = createUnifiedMilkdown(host, session.getSource(), (markdown, problem) => {
    expect(problem).toBeUndefined();
    session.setSource(markdown);
  });
  await editor.create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  let paragraphPos = -1;
  view.state.doc.descendants((node, pos) => { if (node.isText && node.text === '正文。') paragraphPos = pos; });
  view.dispatch(view.state.tr.insertText('已编辑', paragraphPos));
  expect(session.getSource()).toContain('已编辑正文');
  expect(session.getSource()).toContain('<!--more-->');
  await editor.destroy();

  const sourceHost = document.createElement('div');
  document.body.append(sourceHost);
  const sourceView = new CodeMirrorView({ doc: session.getSource(), parent: sourceHost });
  const position = sourceView.state.doc.toString().indexOf('title: "标题"');
  sourceView.dispatch({ changes: { from: position, to: position + 'title: "标题"'.length, insert: 'title: "源码已改"' } });
  session.setSource(sourceView.state.doc.toString());
  sourceView.destroy();

  const reopened = new DocumentSession(session.toBytes());
  expect(reopened.getSource()).toContain('title: "源码已改"');
  expect(reopened.getSource()).toContain('<!--more-->');
  expect(reopened.getSource()).toContain('| **A** | ok |');
  const newHost = document.createElement('div');
  document.body.append(newHost);
  const again = createUnifiedMilkdown(newHost, reopened.getSource(), () => {});
  await again.create();
  expect(again.action((ctx) => ctx.get(editorViewCtx).dom.textContent)).toContain('已编辑正文');
  await again.destroy();
});

it('GFM 表格、任务列表、代码块在统一编辑器中渲染', async () => {
  const source = '| A | B |\n| --- | ---: |\n| **x** | `ok` |\n\n- [ ] 待办\n- [x] 完成\n\n```html\n<!--more-->\n```';
  const host = document.createElement('div');
  document.body.append(host);
  const editor = createUnifiedMilkdown(host, source, () => {});
  await editor.create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  expect(view.dom.querySelector('table')).not.toBeNull();
  expect(view.dom.querySelectorAll('li[data-item-type="task"]')).toHaveLength(2);
  expect(view.dom.querySelector('li[data-checked="true"]')?.textContent).toContain('完成');
  expect(view.dom.querySelector('pre')?.textContent).toContain('<!--more-->');
  expect(view.dom.querySelector('[data-preserved-raw]')).toBeNull();
  const serialized = editor.action((ctx) => ctx.get(serializerCtx)(view.state.doc));
  expect(serialized).toContain('<!--more-->');
  await editor.destroy();
});
