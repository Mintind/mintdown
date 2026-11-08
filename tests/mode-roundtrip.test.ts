import { editorViewCtx } from '@milkdown/kit/core';
import { expect, it, vi } from 'vitest';
import { TextSelection } from '@milkdown/kit/prose/state';
import { readFileSync } from 'node:fs';
import { createUnifiedMilkdown } from '../src/editor/createUnifiedMilkdown';
import { sourceToVisualPosition, visualToSourcePosition } from '../src/editor/cursorMapping';

it('保留源码中的连续空行，切回可视模式后编辑仍不丢失', async () => {
  const source = '# 标题\n\n\n\n第一段\n\n\n第二段\n';
  const host = document.createElement('div'); document.body.append(host);
  let serialized = source;
  const editor = createUnifiedMilkdown(host, source, (markdown, error) => {
    if (error) throw new Error(error);
    serialized = markdown;
  });
  await editor.create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  expect(view.state.doc.childCount).toBeGreaterThan(3);
  const last = view.state.doc.lastChild!;
  view.dispatch(view.state.tr.insertText('！', view.state.doc.content.size - last.nodeSize + 2));
  expect(serialized).toBe('# 标题\n\n\n\n第一段\n\n\n第！二段\n');
  await editor.destroy(); host.remove();
});

it('保留文末以及 Front Matter 和原始语法旁边的空行', async () => {
  const source = '---\ntitle: 标题\n---\n\n\n<!--more-->\n\n\n正文\n\n\n';
  const host = document.createElement('div'); document.body.append(host);
  let serialized = source;
  const editor = createUnifiedMilkdown(host, source, (markdown, error) => {
    if (error) throw new Error(error);
    serialized = markdown;
  });
  await editor.create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  let position = -1;
  view.state.doc.forEach((node, from) => { if (node.textContent === '正文') position = from + 2; });
  expect(position).toBeGreaterThan(0);
  view.dispatch(view.state.tr.insertText('！', position));
  expect(serialized).toBe(source.replace('正文', '正！文'));
  await editor.destroy(); host.remove();
});

it('保留普通文档开头的空行', async () => {
  const source = '\n\n第一段\n\n第二段';
  const host = document.createElement('div'); document.body.append(host);
  let serialized = source;
  const editor = createUnifiedMilkdown(host, source, (markdown, error) => {
    if (error) throw new Error(error);
    serialized = markdown;
  });
  await editor.create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  view.dispatch(view.state.tr.insertText('！', view.state.doc.content.size - 2));
  expect(serialized).toBe('\n\n第一段\n\n第二！段');
  await editor.destroy(); host.remove();
});

it('源码与可视模式映射正文和标题内的光标位置', async () => {
  const source = '# 第一章\n\n\n\n第一段正文\n\n第二段正文';
  const host = document.createElement('div'); document.body.append(host);
  const editor = createUnifiedMilkdown(host, source, () => {});
  await editor.create();
  const doc = editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
  for (const needle of ['第一章', '第一段正文', '第二段正文']) {
    const offset = source.indexOf(needle) + 2;
    const visual = sourceToVisualPosition(doc, source, offset);
    expect(visualToSourcePosition(doc, source, visual)).toBe(offset);
  }
  const firstBlank = source.indexOf('\n') + 1;
  for (const offset of [firstBlank, firstBlank + 1]) {
    const visual = sourceToVisualPosition(doc, source, offset);
    expect(doc.resolve(visual).parent.type.name).toBe('paragraph');
    expect(doc.resolve(visual).parent.content.size).toBe(0);
    expect(visualToSourcePosition(doc, source, visual)).toBe(offset);
  }
  await editor.destroy(); host.remove();
});

it('源码光标落在受保护原文时可安全回到可视文档', async () => {
  const source = '开头\n\n<!--more-->\n\n结尾';
  const host = document.createElement('div'); document.body.append(host);
  const editor = createUnifiedMilkdown(host, source, () => {});
  await editor.create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  const position = sourceToVisualPosition(view.state.doc, source, source.indexOf('more'));
  const selection = TextSelection.between(view.state.doc.resolve(position), view.state.doc.resolve(position));
  expect(selection.from).toBeGreaterThanOrEqual(0);
  expect(view.state.doc.textContent).toContain('结尾');
  await editor.destroy(); host.remove();
});

it('长文档中的源码光标映射到文末，而非回到文首', async () => {
  const fixture = readFileSync('tests/fixtures/hexo-article.md', 'utf8');
  const source = `${fixture}\n${Array.from({ length: 80 }, (_, index) => `第 ${index + 1} 段内容。`).join('\n\n')}\n\n文末定位标记。\n`;
  const host = document.createElement('div'); document.body.append(host);
  const editor = createUnifiedMilkdown(host, source, () => {});
  await editor.create();
  const doc = editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
  const visual = sourceToVisualPosition(doc, source, source.indexOf('文末定位标记。') + 3);
  expect(doc.resolve(visual).parent.textContent).toContain('文末定位标记。');
  await editor.destroy(); host.remove();
});

it.each([
  ['tests/fixtures/unknown-block.md', '正常段落 B。'],
  ['tests/fixtures/normal-article.md', '转义测试：'],
])('已有语法夹具的可视光标进入源码后仍指向原句：%s', async (file, needle) => {
  const source = readFileSync(file, 'utf8');
  const host = document.createElement('div'); document.body.append(host);
  const editor = createUnifiedMilkdown(host, source, () => {});
  await editor.create();
  const doc = editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
  let visual = -1;
  doc.descendants((node, position) => {
    if (node.isText && node.text?.includes(needle)) visual = position + node.text.indexOf(needle) + 2;
  });
  expect(visual).toBeGreaterThan(0);
  const mapped = visualToSourcePosition(doc, source, visual);
  expect(source.slice(mapped - 2, mapped + needle.length)).toContain(needle);
  await editor.destroy(); host.remove();
});

it('可视编辑 Tab 输入四个空格，代码块内 Ctrl+A 只选择代码，复制按钮只复制代码', async () => {
  const source = '前文\n\n```javascript\nconst n = 1;\n```\n\n后文';
  const host = document.createElement('div'); document.body.append(host);
  let serialized = source;
  const editor = createUnifiedMilkdown(host, source, (markdown, error) => {
    if (error) throw new Error(error);
    serialized = markdown;
  });
  await editor.create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  let codeFrom = -1;
  view.state.doc.forEach((node, from) => { if (node.type.name === 'code_block') codeFrom = from; });
  const code = view.state.doc.nodeAt(codeFrom)!;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, codeFrom + 3)));
  const select = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true });
  view.dom.dispatchEvent(select);
  expect(select.defaultPrevented).toBe(true);
  expect(view.state.selection.from).toBe(codeFrom + 1);
  expect(view.state.selection.to).toBe(codeFrom + code.nodeSize - 1);

  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  (view.dom.querySelector('[data-code-copy]') as HTMLButtonElement).click();
  await Promise.resolve();
  expect(writeText).toHaveBeenCalledWith('const n = 1;');
  expect(serialized).toBe(source);

  const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  view.dom.dispatchEvent(tab);
  expect(tab.defaultPrevented).toBe(true);
  expect(view.state.doc.nodeAt(codeFrom)?.textContent).toBe('    const n = 1;');
  expect(serialized).toContain('```javascript\n    const n = 1;\n```');
  await editor.destroy(); host.remove();
});
