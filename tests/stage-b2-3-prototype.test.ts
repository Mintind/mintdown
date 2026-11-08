import { EditorView } from '@codemirror/view';
import { history, undo, redo } from '@codemirror/commands';
import { afterEach, expect, it } from 'vitest';
import { editorViewCtx, serializerCtx } from '@milkdown/kit/core';
import { createUnifiedMilkdown } from '../src/editor/createUnifiedMilkdown';
import { inlineSyntax, localPreviewField, safeExternalUrl } from '../src/editor/localPreview';
import { insertLinkTemplate, jumpToLinkDestination } from '../src/editor/linkEditing';
import { runVisualSourceSearch, updateVisualSourceSearch, visualSourceSearchField } from '../src/editor/visualSourceSearch';
import { DocumentSession } from '../src/document/DocumentSession';

afterEach(() => document.body.replaceChildren());

function editor(source: string) {
  const host = document.createElement('div');
  document.body.append(host);
  return new EditorView({ doc: source, parent: host, extensions: [history(), localPreviewField] });
}

it('源码偏移保留粗体原标记，光标进入展开、离开收起，不产生修改', () => {
  const source = '__中文__ 普通 **文字**';
  const view = editor(source);
  view.dispatch({ selection: { anchor: source.indexOf('普通') } });
  const original = view.state.doc.toString();
  expect(view.dom.textContent).not.toContain('__');
  expect(view.dom.textContent).not.toContain('**');
  expect(view.dom.querySelectorAll('.md-preview-strong')).toHaveLength(2);
  view.dispatch({ selection: { anchor: source.indexOf('中文') + 1 } });
  expect(view.dom.textContent).toContain('__中文__');
  expect(view.dom.textContent).not.toContain('**文字**');
  view.dispatch({ selection: { anchor: source.indexOf('普通') } });
  expect(view.dom.textContent).not.toContain('__中文__');
  expect(view.state.doc.toString()).toBe(original);
  expect(undo(view)).toBe(false);
  view.destroy();
});

it('在展开状态修改分隔符，源码与撤销记录均真实对应输入', () => {
  const view = editor('**文字** 结束');
  view.dispatch({ selection: { anchor: 3 } });
  expect(view.dom.textContent).toContain('**文字**');
  view.dispatch({ changes: { from: 0, to: 2, insert: '' } });
  expect(view.state.doc.toString()).toBe('文字** 结束');
  expect(view.dom.textContent).toContain('文字**');
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe('**文字** 结束');
  expect(redo(view)).toBe(true);
  view.destroy();
});

it('斜体、删除线、行内代码和链接使用原文位置；危险 URL 被拒绝', () => {
  const source = '*斜体* ~~删除~~ `code` [链接](https://example.com/x) 结束';
  const spans = inlineSyntax(source);
  expect(spans.map((span) => span.kind)).toEqual(['emphasis', 'delete', 'inlineCode', 'link']);
  expect(spans.find((span) => span.kind === 'link')?.url).toBe('https://example.com/x');
  const view = editor(source);
  view.dispatch({ selection: { anchor: source.indexOf('结束') } });
  expect(view.dom.textContent).toContain('斜体 删除 code 链接');
  view.dispatch({ selection: { anchor: source.indexOf('链接') + 1 } });
  expect(view.dom.textContent).toContain('[链接](https://example.com/x)');
  expect(view.state.doc.toString()).toBe(source);
  expect(safeExternalUrl('javascript:alert(1)')).toBeUndefined();
  expect(safeExternalUrl('#chapter')).toBeUndefined();
  expect(safeExternalUrl('https://example.com')).toBe('https://example.com/');
  view.destroy();
});

it('行内语法的正文起点和结束位置均展开真实标记，移动本身不改源码', () => {
  const source = '**粗体** *斜体* ~~删除线~~ `code` [链接](https://example.com) 尾';
  const view = editor(source);
  const original = view.state.doc.toString();
  view.dispatch({ selection: { anchor: source.length } });
  for (const span of inlineSyntax(source)) {
    for (const position of [span.contentFrom, span.contentTo, span.to]) {
      view.dispatch({ selection: { anchor: position } });
      expect(view.dom.textContent).toContain(source.slice(span.from, span.to));
      expect(view.state.doc.toString()).toBe(original);
    }
    view.dispatch({ selection: { anchor: source.length } });
    expect(view.dom.textContent).not.toContain(source.slice(span.from, span.to));
  }
  expect(undo(view)).toBe(false);
  view.destroy();
});

it('相邻格式的共享边界按移动方向稳定归属', () => {
  const source = '**甲***乙* 尾';
  const view = editor(source);
  const [left, right] = inlineSyntax(source);
  expect(left.to).toBe(right.from);
  view.dispatch({ selection: { anchor: left.to - 1 } });
  view.dispatch({ selection: { anchor: left.to } });
  expect(view.dom.textContent).toContain(source.slice(right.from, right.to));
  view.dispatch({ selection: { anchor: left.to + 1 } });
  view.dispatch({ selection: { anchor: left.to } });
  expect(view.dom.textContent).toContain(source.slice(left.from, left.to));
  expect(view.state.doc.toString()).toBe(source);
  view.destroy();
});

it('标题与列表在正文末端仍显示可编辑原始前缀', () => {
  const source = '# 标题\n\n- 项目\n\n尾';
  const view = editor(source);
  for (const text of ['标题', '项目']) {
    const end = source.indexOf(text) + text.length;
    view.dispatch({ selection: { anchor: end } });
    expect(view.dom.textContent).toContain(text === '标题' ? '# 标题' : '- 项目');
  }
  expect(view.state.doc.toString()).toBe(source);
  view.destroy();
});

it('现有 ProseMirror mark 保留强调标记种类，但分隔符不是可编辑正文', async () => {
  const host = document.createElement('div'); document.body.append(host);
  const editor = createUnifiedMilkdown(host, '__中文__', () => {});
  await editor.create();
  const { markName, text, serialized, attrs } = editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    return { markName: view.state.doc.firstChild?.firstChild?.marks[0]?.type.name,
      attrs: view.state.doc.firstChild?.firstChild?.marks[0]?.attrs,
      text: view.state.doc.textContent, serialized: ctx.get(serializerCtx)(view.state.doc) };
  });
  expect(markName).toBe('strong');
  expect(attrs?.marker).toBe('_');
  expect(text).toBe('中文');
  expect(serialized).toContain('__中文__');
  await editor.destroy();
});

it('Ctrl+K 插入可编辑原文模板，Tab 在标签后进入 URL', () => {
  const view = editor('前 后');
  view.dispatch({ selection: { anchor: 2 } });
  expect(insertLinkTemplate(view)).toBe(true);
  expect(view.state.doc.toString()).toBe('前 []()后');
  expect(view.state.selection.main.head).toBe(3);
  expect(jumpToLinkDestination(view)).toBe(true);
  expect(view.state.selection.main.head).toBe(5);
  view.dispatch({ changes: { from: 5, insert: 'https://example.com' } });
  expect(view.state.doc.toString()).toBe('前 [](https://example.com)后');
  view.destroy();
  const selected = editor('中文');
  selected.dispatch({ selection: { anchor: 0, head: 2 } });
  expect(insertLinkTemplate(selected)).toBe(true);
  expect(selected.state.doc.toString()).toBe('[中文]()');
  expect(selected.state.selection.main.head).toBe(5);
  selected.destroy();
});

it('已有链接 Ctrl+K 选择真实标签并展开原始 URL，不弹出输入框', () => {
  const source = '前 [标题](https://example.com/?a=1&b=2) 后';
  const view = editor(source);
  view.dispatch({ selection: { anchor: source.indexOf('后') } });
  expect(view.dom.textContent).not.toContain('https://example.com');
  view.dispatch({ selection: { anchor: source.indexOf('标题') + 1 } });
  expect(insertLinkTemplate(view)).toBe(true);
  expect(view.state.selection.main.from).toBe(source.indexOf('标题'));
  expect(view.state.selection.main.to).toBe(source.indexOf('标题') + 2);
  expect(view.dom.textContent).toContain('[标题](https://example.com/?a=1&b=2)');
  expect(view.state.doc.toString()).toBe(source);
  view.destroy();
});

it('链接 URL 与图片路径直接修改源码，失焦后仍能无损保存', () => {
  const view = editor('[链接](https://old.example/x) ![图](assets/a.png) 尾');
  const initial = view.state.doc.toString();
  view.dispatch({ selection: { anchor: initial.indexOf('链接') + 1 } });
  const oldUrl = initial.indexOf('https://old.example/x');
  view.dispatch({ changes: { from: oldUrl, to: oldUrl + 'https://old.example/x'.length, insert: 'https://new.example/y' } });
  const withLink = view.state.doc.toString();
  view.dispatch({ selection: { anchor: withLink.indexOf('assets') + 2 } });
  const oldPath = withLink.indexOf('assets/a.png');
  view.dispatch({ changes: { from: oldPath, to: oldPath + 'assets/a.png'.length, insert: 'assets/b.png' } });
  const finalSource = view.state.doc.toString();
  view.dispatch({ selection: { anchor: finalSource.length } });
  expect(view.dom.querySelector('.md-preview-link')?.textContent).toBe('链接');
  expect(view.dom.querySelector('.md-preview-image')).not.toBeNull();
  const session = DocumentSession.fromText(initial);
  session.setSource(finalSource);
  expect(new TextDecoder().decode(session.toBytes())).toBe('[链接](https://new.example/y) ![图](assets/b.png) 尾');
  view.destroy();
});

it('标题、列表、引用和闭合代码围栏按光标局部展开', () => {
  const source = '# 标题\n\n- 项目\n\n> 引用\n\n```js\nconst x = 1\n```\n\n结束';
  const view = editor(source);
  view.dispatch({ selection: { anchor: source.length } });
  expect(view.dom.textContent).not.toContain('# 标题');
  expect(view.dom.textContent).toContain('```js');
  view.dispatch({ selection: { anchor: source.indexOf('标题') + 1 } });
  expect(view.dom.textContent).toContain('# 标题');
  view.dispatch({ selection: { anchor: source.indexOf('项目') + 1 } });
  expect(view.dom.textContent).toContain('- 项目');
  view.dispatch({ selection: { anchor: source.indexOf('引用') + 1 } });
  expect(view.dom.textContent).toContain('> 引用');
  view.dispatch({ selection: { anchor: source.indexOf('const') + 1 } });
  expect(view.dom.textContent).toContain('```js');
  expect(view.dom.textContent).toContain('```');
  expect(view.state.doc.toString()).toBe(source);
  view.destroy();
});

it('可视查找只命中正文，不替换隐藏 URL、代码或受保护原文', () => {
  const source = '[显示](https://example.com/显示) 显示\n\n```txt\n显示\n```\n\n<!--显示-->';
  const host = document.createElement('div'); document.body.append(host);
  const view = new EditorView({ doc: source, parent: host, extensions: [history(), localPreviewField, visualSourceSearchField] });
  view.dispatch({ selection: { anchor: source.length } });
  const options = { text: '显示', replace: '更改', caseSensitive: false, wholeWord: false, regexp: false };
  expect(updateVisualSourceSearch(view, options).total).toBe(2);
  expect(runVisualSourceSearch(view, options, 'replaceAll')).toBe(true);
  expect(view.state.doc.toString()).toBe('[更改](https://example.com/显示) 更改\n\n```txt\n显示\n```\n\n<!--显示-->');
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe(source);
  view.destroy();
});

it('围栏长度和语言在聚焦时按真实源码编辑，闭合前保持原文', () => {
  const original = '```js\nconst x = 1;\n```\n\n尾段';
  const view = editor(original);
  view.dispatch({ selection: { anchor: original.indexOf('const') + 1 } });
  expect(view.dom.textContent).toContain('```js');
  view.dispatch({ changes: { from: 0, to: 5, insert: '````python' } });
  expect(view.dom.textContent).toContain('````python');
  expect(view.dom.textContent).toContain('```');
  const closing = view.state.doc.toString().lastIndexOf('```');
  view.dispatch({ changes: { from: closing, to: closing + 3, insert: '````' } });
  const source = view.state.doc.toString();
  view.dispatch({ selection: { anchor: source.indexOf('尾段') } });
  expect(view.dom.textContent).toContain('````python');
  const session = DocumentSession.fromText(original);
  session.setSource(source);
  expect(new TextDecoder().decode(session.toBytes())).toBe('````python\nconst x = 1;\n````\n\n尾段');
  view.destroy();
});

it('图片聚焦后仍保留预览并显示可编辑源码，原始内容和未知语法不变', () => {
  const source = '![图](assets/a.png) $x^2$ <!--more--> {% strange %}';
  const view = editor(source);
  view.dispatch({ selection: { anchor: source.length } });
  expect(view.dom.querySelector('.md-preview-image')).not.toBeNull();
  expect(view.dom.querySelector('.md-preview-math .katex')).not.toBeNull();
  expect(view.dom.textContent).toContain('<!--more-->');
  expect(view.dom.textContent).toContain('{% strange %}');
  view.dispatch({ selection: { anchor: source.indexOf('x^2') + 1 } });
  expect(view.dom.textContent).toContain('$x^2$');
  view.dispatch({ selection: { anchor: source.indexOf('assets') + 2 } });
  expect(view.dom.querySelector('.md-image-shell')).not.toBeNull();
  expect(view.dom.querySelector<HTMLInputElement>('.md-image-edit-input')?.value).toBe('![图](assets/a.png)');
  expect(view.state.doc.toString()).toBe(source);
  view.destroy();
});

it('反复移动长文档光标不改变正文、撤销栈或编辑视图', () => {
  const source = Array.from({ length: 200 }, (_, index) => `## 第 ${index} 段\n\n**内容${index}** 与正文\n`).join('\n');
  const view = editor(source);
  for (let index = 0; index < 300; index++)
    view.dispatch({ selection: { anchor: index % 2 ? source.indexOf('内容') + 1 : source.lastIndexOf('正文') + 1 } });
  expect(view.state.doc.toString()).toBe(source);
  expect(view.dom.isConnected).toBe(true);
  expect(undo(view)).toBe(false);
  view.destroy();
});
