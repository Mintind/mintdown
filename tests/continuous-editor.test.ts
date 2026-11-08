import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { EditorView as CodeMirrorView } from 'codemirror';
import { editorViewCtx, serializerCtx } from '@milkdown/kit/core';
import { NodeSelection, TextSelection } from '@milkdown/kit/prose/state';
import { undo, redo } from '@milkdown/kit/prose/history';
import { createUnifiedMilkdown } from '../src/editor/createUnifiedMilkdown';
import { DocumentSession } from '../src/document/DocumentSession';
import { parseSegments } from '../src/markdown/segments';

it.each(['hexo-article.md', 'normal-article.md', 'unknown-block.md'])('unified %s', async (fixture) => {
  const original = readFileSync(`tests/fixtures/${fixture}`, 'utf8');
  const host = document.createElement('div');
  document.body.append(host);
  const editor = createUnifiedMilkdown(host, original, () => {});
  await editor.create();
  const view = editor.action(ctx => ctx.get(editorViewCtx));
  const serialized = editor.action(ctx => ctx.get(serializerCtx)(view.state.doc));
  if (fixture === 'hexo-article.md') {
    expect(serialized).toContain('title: "Hexo: 测试文章"');
    expect(serialized).toContain('<!--more-->');
    expect(serialized).toContain('<div data-name="raw-block">\n  保留的 HTML 片段\n</div>');
    expect(view.dom.querySelectorAll('[data-preserved-raw]')).toHaveLength(4);
  }
  if (fixture === 'normal-article.md') {
    expect(view.dom.querySelector('table')).not.toBeNull();
    expect(view.dom.querySelector('[data-inline-math] .katex')).not.toBeNull();
    expect(view.dom.querySelector('[data-block-math] .katex')).not.toBeNull();
    expect(serialized).toContain('$E=mc^2$');
    expect(serialized).toContain('\\sum_{i=1}^{n}');
  }
  if (fixture === 'unknown-block.md') {
    expect(serialized).toContain('{% unknown_hexo_extension some_value %}');
    expect(serialized).toContain('::: future-container\nshould be kept intact\n:::');
    expect(serialized).toContain('<!-- custom-comment foo="bar" -->');
    expect(view.dom.querySelector('kbd')).toBeNull();
  }
  await editor.destroy();
});

it.each([
  ['hexo-article.md', '这里应保持结构'],
  ['normal-article.md', '普通 Markdown'],
  ['unknown-block.md', '正常段落 A'],
])('编辑 %s 的普通正文后，受保护原文保存重开仍存在', async (fixture, target) => {
  const original = readFileSync(`tests/fixtures/${fixture}`, 'utf8');
  const session = DocumentSession.fromText(original);
  const protectedParts = parseSegments(original).filter((part) => ['frontmatter', 'more', 'raw', 'math'].includes(part.kind));
  const host = document.createElement('div');
  document.body.append(host);
  const editor = createUnifiedMilkdown(host, original, (markdown, problem) => {
    expect(problem).toBeUndefined();
    session.setSource(markdown);
  });
  await editor.create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  let insertAt = -1;
  view.state.doc.descendants((node, pos) => {
    if (node.isText && node.text?.includes(target)) insertAt = pos;
  });
  expect(insertAt).toBeGreaterThan(0);
  view.dispatch(view.state.tr.insertText('新增', insertAt));
  expect(session.getSource()).toContain(`新增${target}`);
  await editor.destroy();
  const reopened = new DocumentSession(session.toBytes());
  for (const part of protectedParts) expect(reopened.getSource()).toContain(part.original);
  if (fixture === 'hexo-article.md') {
    expect(reopened.getSource()).toContain('```html\n<!--more-->');
    expect(reopened.getSegments().filter((part) => part.kind === 'raw' && part.original === '<!--more-->')).toHaveLength(1);
  }
});

it('跨段落选择、复制、删除合并、Undo/Redo、源码切换和重新打开', async () => {
  const session = DocumentSession.fromText('---\ntitle: "原样"\n---\n\n第一段\n\n第二段\n\n<!-- more -->\n\n结尾。\n');
  const host = document.createElement('div');
  document.body.append(host);
  const editor = createUnifiedMilkdown(host, session.getSource(), (markdown, problem) => {
    expect(problem).toBeUndefined();
    session.setSource(markdown);
  });
  await editor.create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  let firstEnd = -1;
  let secondStart = -1;
  view.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === '第一段') firstEnd = pos + node.text.length;
    if (node.isText && node.text === '第二段') secondStart = pos;
  });
  expect(firstEnd).toBeGreaterThan(0);
  expect(secondStart).toBeGreaterThan(firstEnd);
  const initialBlockCount = view.state.doc.childCount;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, firstEnd, secondStart)));
  const copied = view.state.selection.content();
  expect(copied.size).toBeGreaterThan(0);
  view.dispatch(view.state.tr.deleteSelection());
  expect(view.state.doc.textContent).toContain('第一段第二段');
  expect(view.state.doc.childCount).toBe(initialBlockCount - 1);
  expect(session.getSource()).toContain('第一段第二段');
  expect(undo(view.state, view.dispatch)).toBe(true);
  expect(view.state.doc.childCount).toBe(initialBlockCount);
  expect(redo(view.state, view.dispatch)).toBe(true);
  expect(view.state.doc.childCount).toBe(initialBlockCount - 1);
  expect(view.state.doc.textContent).toContain('第一段第二段');

  const savedVisual = editor.action((ctx) => ctx.get(serializerCtx)(view.state.doc));
  expect(savedVisual).toContain('<!-- more -->');
  expect(savedVisual).toContain('title: "原样"');
  await editor.destroy();

  const cmHost = document.createElement('div');
  document.body.append(cmHost);
  const cm = new CodeMirrorView({ doc: session.getSource(), parent: cmHost });
  const titleOffset = cm.state.doc.toString().indexOf('title: "原样"');
  cm.dispatch({ changes: { from: titleOffset, to: titleOffset + 'title: "原样"'.length, insert: 'title: "源码改动"' } });
  session.setSource(cm.state.doc.toString());
  cm.destroy();
  const reopened = new DocumentSession(session.toBytes());
  expect(reopened.getSource()).toContain('title: "源码改动"');
  expect(reopened.getSource()).toContain('<!-- more -->');
  expect(reopened.getSource()).toContain('第一段第二段');
});

it('注释原文可选中删除，Undo 恢复原始写法', async () => {
  const source = '# 标题\n\n<!--more-->\n\n下一段';
  const host = document.createElement('div');
  document.body.append(host);
  const editor = createUnifiedMilkdown(host, source, () => {});
  await editor.create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  let markerPos = -1;
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === 'preserved_raw_block' && node.attrs.raw === '<!--more-->') markerPos = pos;
  });
  expect(markerPos).toBeGreaterThan(0);
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, markerPos)));
  expect(view.state.selection.content().content.firstChild?.attrs.raw).toBe('<!--more-->');
  expect(view.someProp('clipboardTextSerializer', (serialize) => serialize(view.state.selection.content(), view))).toBe('<!--more-->');
  view.dispatch(view.state.tr.deleteSelection());
  expect(editor.action((ctx) => ctx.get(serializerCtx)(view.state.doc))).not.toContain('<!--more-->');
  expect(undo(view.state, view.dispatch)).toBe(true);
  expect(editor.action((ctx) => ctx.get(serializerCtx)(view.state.doc))).toContain('<!--more-->');
  await editor.destroy();
});

it('跨原始注释选择并删除可合并前后段落，撤销会恢复原始注释', async () => {
  const source = '前段\n\n<!-- more -->\n\n后段';
  const host = document.createElement('div');
  document.body.append(host);
  const editor = createUnifiedMilkdown(host, source, () => {});
  await editor.create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  let beforeEnd = -1;
  let afterStart = -1;
  view.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === '前段') beforeEnd = pos + node.text.length;
    if (node.isText && node.text === '后段') afterStart = pos;
  });
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, beforeEnd, afterStart)));
  expect(view.state.selection.content().content.childCount).toBeGreaterThan(0);
  expect(view.someProp('clipboardTextSerializer', (serialize) => serialize(view.state.selection.content(), view))).toContain('<!-- more -->');
  view.dispatch(view.state.tr.deleteSelection());
  expect(view.state.doc.textContent).toContain('前段后段');
  expect(editor.action((ctx) => ctx.get(serializerCtx)(view.state.doc))).not.toContain('<!-- more -->');
  expect(undo(view.state, view.dispatch)).toBe(true);
  expect(editor.action((ctx) => ctx.get(serializerCtx)(view.state.doc))).toContain('<!-- more -->');
  await editor.destroy();
});

it('可视模式新输入未知 HTML 时阻止静默改写，撤销后可恢复安全状态', async () => {
  const source = '普通正文。';
  const session = DocumentSession.fromText(source);
  const host = document.createElement('div');
  document.body.append(host);
  let problem: string | undefined;
  const editor = createUnifiedMilkdown(host, source, (markdown, error) => {
    problem = error;
    if (!error) session.setSource(markdown);
  });
  await editor.create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  view.dispatch(view.state.tr.insertText('<!--future-->', 1));
  expect(problem).toMatch(/源码模式/);
  expect(session.getSource()).toBe(source);
  expect(undo(view.state, view.dispatch)).toBe(true);
  expect(problem).toBeUndefined();
  expect(session.getSource()).toBe(source);
  expect(session.toBytes()).toEqual(new TextEncoder().encode(source));
  await editor.destroy();
});
