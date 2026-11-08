import { afterEach, expect, it } from 'vitest';
import { editorViewCtx, inputRulesCtx, parserCtx, serializerCtx } from '@milkdown/kit/core';
import { TextSelection } from '@milkdown/kit/prose/state';
import { undo, undoNoScroll } from '@milkdown/kit/prose/history';
import { createUnifiedMilkdown } from '../src/editor/createUnifiedMilkdown';
import { renderCompletedLine } from '../src/editor/deferredMarkdown';

afterEach(() => document.body.replaceChildren());

it('keeps heading markers literal while typing and renders the completed line on Enter', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = createUnifiedMilkdown(host, '', () => {});
  await editor.create();
  expect(editor.action((ctx) => ctx.get(inputRulesCtx))).toHaveLength(0);
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  view.dispatch(view.state.tr.insertText('# 新标题', 1));
  expect(view.state.doc.firstChild?.type.name).toBe('paragraph');
  expect(view.dom.textContent).toContain('# 新标题');
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  view.dom.dispatchEvent(event);
  expect(view.state.doc.firstChild?.type.name).toBe('heading');
  expect(view.state.doc.firstChild?.textContent).toBe('新标题');
  expect(view.state.doc.lastChild?.type.name).toBe('paragraph');
  expect(editor.action((ctx) => ctx.get(serializerCtx)(view.state.doc))).toContain('# 新标题');
  expect(undo(view.state, view.dispatch)).toBe(true);
  expect(view.state.doc.firstChild?.textContent).toBe('# 新标题');
  await editor.destroy();
});

it('renders inline Markdown only when its line is completed', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = createUnifiedMilkdown(host, '', () => {});
  await editor.create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  view.dispatch(view.state.tr.insertText('**重点**', 1));
  expect(view.state.doc.firstChild?.textContent).toBe('**重点**');
  expect(view.state.doc.firstChild?.firstChild?.marks).toHaveLength(0);
  view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  expect(view.state.doc.firstChild?.textContent).toBe('重点');
  expect(view.state.doc.firstChild?.firstChild?.marks[0]?.type.name).toBe('strong');
  await editor.destroy();
});

it('renders a newly typed heading after an existing Front Matter block', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = createUnifiedMilkdown(host, '---\ntitle: 原文\n---\n\n正文', () => {});
  await editor.create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  const paragraph = view.state.schema.nodes.paragraph.create(null, view.state.schema.text('# 后续标题'));
  view.dispatch(view.state.tr.insert(view.state.doc.content.size, paragraph));
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, view.state.doc.content.size - 1)));
  view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  expect([...view.dom.querySelectorAll('h1')].map((heading) => heading.textContent)).toContain('后续标题');
  expect(editor.action((ctx) => ctx.get(serializerCtx)(view.state.doc))).toContain('title: 原文');
  await editor.destroy();
});

it('waits for a matching closing fence, keeps both fences visible, and lets language change', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  let draft = '';
  const editor = createUnifiedMilkdown(host, '', (source, problem) => { if (!problem) draft = source; });
  await editor.create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  const paragraph = view.state.schema.nodes.paragraph;
  const lines = ['```js', 'const n = 1;', '```'];
  view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, lines.slice(0, 2).map((line) =>
    paragraph.create(null, view.state.schema.text(line)))));
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, view.state.doc.content.size - 1)));
  expect(renderCompletedLine(view, editor.action((ctx) => ctx.get(parserCtx)))).toBe(false);
  expect(view.dom.textContent).toContain('```js');
  expect(view.dom.querySelector('[data-code-fence]')).toBeNull();
  expect(draft).toContain('```js\nconst n = 1;');

  view.dispatch(view.state.tr.insert(view.state.doc.content.size, paragraph.create(null, view.state.schema.text(lines[2]))));
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, view.state.doc.content.size - 1)));
  expect(renderCompletedLine(view, editor.action((ctx) => ctx.get(parserCtx)))).toBe(true);
  expect(view.state.doc.firstChild?.type.name).toBe('code_block');
  expect(view.dom.querySelector('[data-code-fence-line="opening"]')?.textContent).toContain('```');
  expect(view.dom.querySelector('[data-code-fence-line="closing"]')?.textContent).toBe('```');
  expect(view.dom.querySelector('pre code')?.textContent).toBe('const n = 1;');
  expect(editor.action((ctx) => ctx.get(serializerCtx)(view.state.doc))).toContain('```js\nconst n = 1;\n```');

  const language = view.dom.querySelector<HTMLInputElement>('[data-code-language]')!;
  expect(language.value).toBe('js');
  language.value = 'typescript';
  language.dispatchEvent(new Event('input', { bubbles: true }));
  expect(view.state.doc.firstChild?.attrs.language).toBe('typescript');
  expect(editor.action((ctx) => ctx.get(serializerCtx)(view.state.doc))).toContain('```typescript');
  const fenceLength = view.dom.querySelector<HTMLInputElement>('[data-code-fence-length]')!;
  fenceLength.value = '5';
  fenceLength.dispatchEvent(new Event('input', { bubbles: true }));
  expect(view.state.doc.firstChild?.attrs.fenceLength).toBe(5);
  expect(view.dom.querySelector('[data-code-fence-line="closing"]')?.textContent).toBe('`````');
  expect(draft).toContain('`````typescript\nconst n = 1;\n`````');
  await editor.destroy();
});

it('keeps a longer source fence when the code body is edited', async () => {
  const original = '````js\n``` inside\n````';
  let edited = '';
  const host = document.createElement('div');
  document.body.append(host);
  const editor = createUnifiedMilkdown(host, original, (source, problem) => {
    expect(problem).toBeUndefined();
    edited = source;
  });
  await editor.create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  expect(view.state.doc.firstChild?.attrs.fenceLength).toBe(4);
  expect(view.dom.querySelector('[data-code-fence-line="opening"]')?.textContent).toContain('````');
  expect(view.dom.querySelector('[data-code-fence-line="closing"]')?.textContent).toBe('````');
  view.dispatch(view.state.tr.insertText('more ', 1));
  expect(edited).toContain('````js\nmore ``` inside\n````');
  await editor.destroy();
});

it('can move past a loaded closing fence, type after it, and delete only that fence with Backspace', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  let draft = '';
  const editor = createUnifiedMilkdown(host, '```js\nconst n = 1;\n```', (source, problem) => {
    expect(problem).toBeUndefined();
    draft = source;
  });
  await editor.create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  const code = view.state.doc.firstChild!;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, code.nodeSize - 1)));
  view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  expect(view.state.selection.$from.parent.type.name).toBe('paragraph');
  view.dispatch(view.state.tr.insertText('后续正文'));
  expect(draft).toContain('```js\nconst n = 1;\n```');
  expect(draft).toContain('后续正文');
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, code.nodeSize + 1)));
  view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
  expect(view.dom.querySelector('[data-code-fence]')).toBeNull();
  expect([...view.dom.querySelectorAll('p')].map((p) => p.textContent)).toEqual(['```js', 'const n = 1;', '后续正文']);
  expect(draft).toContain('```js\nconst n = 1;');
  expect(draft).not.toContain('\n```\n');
  expect(undoNoScroll(view.state, view.dispatch)).toBe(true);
  expect(view.dom.querySelector('[data-code-fence-line="closing"]')?.textContent).toBe('```');
  await editor.destroy();
});

it('clicking a closing fence places the caret after it', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  let serialized = '';
  const editor = createUnifiedMilkdown(host, '```\ncode\n```', (source, problem) => {
    expect(problem).toBeUndefined();
    serialized = source;
  });
  await editor.create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  view.dom.querySelector('[data-code-fence-line="closing"]')!.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
  );
  expect(view.state.selection.$from.parent.type.name).toBe('paragraph');
  expect(view.state.doc.firstChild?.type.name).toBe('code_block');
  expect(serialized).toBe('```\ncode\n```');
  await editor.destroy();
});

it('treats an opening-looking line inside a code fence as code content', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = createUnifiedMilkdown(host, '', () => {});
  await editor.create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  const paragraph = view.state.schema.nodes.paragraph;
  view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size,
    ['````js', '```ts', 'body', '````'].map((line) => paragraph.create(null, view.state.schema.text(line)))));
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, view.state.doc.content.size - 1)));
  expect(renderCompletedLine(view, editor.action((ctx) => ctx.get(parserCtx)))).toBe(true);
  expect(view.state.doc.firstChild?.textContent).toBe('```ts\nbody');
  expect(view.state.doc.firstChild?.attrs.fenceLength).toBe(4);
  await editor.destroy();
});

it('reopens an unfinished fence as editable literal lines without losing raw code', async () => {
  const original = '```md\n<!--more-->\n# raw\n';
  let draft = original;
  const host = document.createElement('div');
  document.body.append(host);
  const editor = createUnifiedMilkdown(host, original, (source, problem) => {
    expect(problem).toBeUndefined();
    draft = source;
  });
  await editor.create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  expect(view.dom.querySelector('[data-code-fence]')).toBeNull();
  expect([...view.dom.querySelectorAll('p')].map((paragraph) => paragraph.textContent)).toEqual(['```md', '<!--more-->', '# raw', '']);
  let editAt = -1;
  view.state.doc.descendants((node, pos) => { if (node.isText && node.text === '# raw') editAt = pos; });
  view.dispatch(view.state.tr.insertText('改', editAt));
  expect(draft).toContain('```md\n<!--more-->\n改# raw');
  await editor.destroy();
  const reopenedHost = document.createElement('div');
  document.body.append(reopenedHost);
  const reopened = createUnifiedMilkdown(reopenedHost, draft, () => {});
  await reopened.create();
  expect(reopenedHost.querySelector('[data-code-fence]')).toBeNull();
  expect(reopenedHost.textContent).toContain('改# raw');
  const reopenedView = reopened.action((ctx) => ctx.get(editorViewCtx));
  reopenedView.dispatch(reopenedView.state.tr.insertText('```', reopenedView.state.doc.content.size - 1));
  reopenedView.dispatch(reopenedView.state.tr.setSelection(TextSelection.create(reopenedView.state.doc, reopenedView.state.doc.content.size - 1)));
  reopenedView.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  expect(reopenedView.state.doc.firstChild?.type.name).toBe('code_block');
  expect(reopenedView.state.doc.firstChild?.textContent).toContain('<!--more-->');
  await reopened.destroy();
});
