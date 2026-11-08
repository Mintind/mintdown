import { EditorView as CodeMirrorView } from '@codemirror/view';
import { search as sourceSearch } from '@codemirror/search';
import { history as sourceHistory } from '@codemirror/commands';
import { editorViewCtx, serializerCtx } from '@milkdown/kit/core';
import { TextSelection } from '@milkdown/kit/prose/state';
import { undo as undoVisual, redo as redoVisual } from '@milkdown/kit/prose/history';
import { afterEach, expect, it } from 'vitest';
import { createUnifiedMilkdown } from '../src/editor/createUnifiedMilkdown';
import { toggleSourceFormat, toggleVisualFormat, undoEditor, redoEditor } from '../src/ui/editorCommands';
import { runSearchAction, updateSearch, type SearchOptions } from '../src/ui/searchCommands';
import { defaultPreferences, readPreferences, writePreferences } from '../src/ui/preferences';
import { setLocalSpellCheck } from '../src/editor/localSpelling';

const options = (text: string, replace = ''): SearchOptions =>
  ({ text, replace, caseSensitive: false, wholeWord: false, regexp: false });

afterEach(() => { document.body.replaceChildren(); localStorage.clear(); });

it('源码搜索覆盖中文、Front Matter 和注释，全部替换是一条可撤销事务', () => {
  const host = document.createElement('div'); document.body.append(host);
  const source = '---\ntitle: 中文\n---\n\n中文 正文\n\n<!--more-->\n\n中文';
  const view = new CodeMirrorView({ doc: source, parent: host, extensions: [sourceSearch(), sourceHistory()] });
  expect(updateSearch(null, view, options('中文')).total).toBe(3);
  expect(runSearchAction(null, view, options('中文'), 'next')).toBe(true);
  expect(updateSearch(null, view, options('中文')).current).toBe(1);
  expect(runSearchAction(null, view, options('中文', '测试'), 'replaceAll')).toBe(true);
  expect(view.state.doc.toString().match(/测试/g)).toHaveLength(3);
  expect(undoEditor(null, view)).toBe(true);
  expect(view.state.doc.toString()).toBe(source);
  expect(redoEditor(null, view)).toBe(true);
  expect(view.state.doc.toString().match(/测试/g)).toHaveLength(3);
  view.destroy();
});

it('源码大小写、全词、正则和跨行查找', () => {
  const host = document.createElement('div'); document.body.append(host);
  const view = new CodeMirrorView({ doc: 'cat cats CAT\n中文\n第二段', parent: host, extensions: [sourceSearch()] });
  expect(updateSearch(null, view, { ...options('cat'), wholeWord: true }).total).toBe(2);
  expect(updateSearch(null, view, { ...options('cat'), wholeWord: true, caseSensitive: true }).total).toBe(1);
  expect(updateSearch(null, view, { ...options('中文\\n第二段'), regexp: true }).total).toBe(1);
  expect(updateSearch(null, view, { ...options('['), regexp: true }).valid).toBe(false);
  view.destroy();
});

it('可视搜索跨段落收集匹配，跳过围栏与原始节点，替换后保留它们', async () => {
  const host = document.createElement('div'); document.body.append(host);
  const source = '前段 中文\n\n后段 中文\n\n<!--more-->\n\n```txt\n中文\n```\n';
  const editor = createUnifiedMilkdown(host, source, () => {});
  await editor.create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  expect(updateSearch(view, null, options('中文')).total).toBe(2);
  expect(runSearchAction(view, null, options('中文'), 'next')).toBe(true);
  expect(updateSearch(view, null, options('中文')).current).toBe(1);
  expect(runSearchAction(view, null, options('中文', '测试'), 'replaceAll')).toBe(true);
  const markdown = editor.action((ctx) => ctx.get(serializerCtx)(view.state.doc));
  expect(markdown).toContain('前段 测试');
  expect(markdown).toContain('后段 测试');
  expect(markdown).toContain('<!--more-->');
  expect(markdown).toContain('```txt\n中文\n```');
  expect(undoVisual(view.state, view.dispatch)).toBe(true);
  expect(view.state.doc.textContent).toContain('前段 中文');
  expect(redoVisual(view.state, view.dispatch)).toBe(true);
  await editor.destroy();
});

it('可视格式支持粗体、斜体、删除线与行内代码，不修改围栏和原始节点', async () => {
  const host = document.createElement('div'); document.body.append(host);
  const editor = createUnifiedMilkdown(host, '中文 ABC\n\n<!--more-->\n\n```txt\ncode\n```', () => {});
  await editor.create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  for (const format of ['strong', 'em', 'strike_through', 'inlineCode'] as const) {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 3)));
    expect(toggleVisualFormat(view, format)).toBe(true);
  }
  const markdown = editor.action((ctx) => ctx.get(serializerCtx)(view.state.doc));
  expect(markdown).toContain('<!--more-->');
  expect(markdown).toContain('```txt\ncode\n```');
  expect(view.state.doc.firstChild?.firstChild?.marks.map((mark) => mark.type.name)).toContain('inlineCode');
  const codePos = view.state.doc.content.size - view.state.doc.lastChild!.nodeSize + 1;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, codePos)));
  expect(toggleVisualFormat(view, 'strong')).toBe(false);
  await editor.destroy();
});

it('源码格式可开关包装，设置持久化包含拼写开关', () => {
  const host = document.createElement('div'); document.body.append(host);
  const view = new CodeMirrorView({ doc: '中文', parent: host });
  view.dispatch({ selection: { anchor: 0, head: 2 } });
  expect(toggleSourceFormat(view, 'strike_through')).toBe(true);
  expect(view.state.doc.toString()).toBe('~~中文~~');
  expect(view.state.selection.main.from).toBe(2);
  expect(toggleSourceFormat(view, 'strike_through')).toBe(true);
  expect(view.state.doc.toString()).toBe('中文');
  view.destroy();
  writePreferences({ ...defaultPreferences, spellCheck: false, writingWidth: 1040 });
  expect(readPreferences()).toMatchObject({ spellCheck: false, writingWidth: 1040 });
});

it('格式操作拒绝源码中的围栏与受保护注释', () => {
  const host = document.createElement('div'); document.body.append(host);
  const markdown = '正文\n\n```js\nconst x = 1\n```\n\n<!--more-->';
  const view = new CodeMirrorView({ doc: markdown, parent: host });
  view.dispatch({ selection: { anchor: markdown.indexOf('const'), head: markdown.indexOf('const') + 5 } });
  expect(toggleSourceFormat(view, 'strong')).toBe(false);
  view.dispatch({ selection: { anchor: markdown.indexOf('more'), head: markdown.indexOf('more') + 4 } });
  expect(toggleSourceFormat(view, 'em')).toBe(false);
  expect(view.state.doc.toString()).toBe(markdown);
  view.destroy();
});

it('离线英文拼写标记正文，跳过代码和原始片段，开关不修改文档', async () => {
  const host = document.createElement('div'); document.body.append(host);
  const markdown = 'This sentense has writting errors.\n\nhttps://writting.example.test/\n\n`writting`\n\n```txt\nwritting\n```\n\n<!--more-->';
  const editor = createUnifiedMilkdown(host, markdown, () => {}, undefined, undefined, true);
  await editor.create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  for (let attempt = 0; attempt < 50 && !host.querySelector('.local-spelling-error'); attempt++)
    await new Promise((done) => setTimeout(done, 80));
  const marked = [...host.querySelectorAll('.local-spelling-error')].map((element) => element.textContent);
  expect(marked).toContain('writting');
  expect(marked.filter((word) => word === 'writting')).toHaveLength(1);
  expect(host.querySelectorAll('code .local-spelling-error')).toHaveLength(0);
  setLocalSpellCheck(view, false);
  expect(host.querySelector('.local-spelling-error')).toBeNull();
  expect(editor.action((ctx) => ctx.get(serializerCtx)(view.state.doc))).toContain('<!--more-->');
  await editor.destroy();
});
