import katex from 'katex';
import remarkFrontmatter from 'remark-frontmatter';
import remarkMath from 'remark-math';
import { Editor, defaultValueCtx, editorStateOptionsCtx, parserCtx, rootCtx, serializerCtx } from '@milkdown/kit/core';
import { codeBlockSchema, commonmark, inputRules as commonmarkInputRules, markInputRules as commonmarkMarkInputRules } from '@milkdown/kit/preset/commonmark';
import { gfm, inputRules as gfmInputRules, markInputRules as gfmMarkInputRules } from '@milkdown/kit/preset/gfm';
import { history } from '@milkdown/kit/plugin/history';
import { highlight, highlightPluginConfig } from '@milkdown/plugin-highlight';
import { Plugin, TextSelection } from '@milkdown/kit/prose/state';
import { search as proseSearch } from 'prosemirror-search';
import { $nodeSchema, $prose, $remark, $view } from '@milkdown/kit/utils';
import { Fragment, type Node as ProseMirrorNode } from '@milkdown/kit/prose/model';
import type { EditorView } from '@milkdown/kit/prose/view';
import { parseSegments } from '../markdown/segments';
import { codeFenceMarker, moveAfterCodeFence, removeClosingCodeFence, renderCompletedLine, serializeDeferredDraft, unclosedFenceLines } from './deferredMarkdown';
import { parseHighlightedCode } from './syntaxHighlight';
import { preserveSourceBlankLines } from './sourceBlankLines';
import { localSpelling } from './localSpelling';

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[]; position?: { start: { offset?: number }; end: { offset?: number } }; raw?: string };

const immediateRules = new Set([...commonmarkInputRules, ...commonmarkMarkInputRules, ...gfmInputRules, ...gfmMarkInputRules]);

const visibleCodeFence = $view(codeBlockSchema.node, () => (node, view, getPos) => {
  const dom = document.createElement('div');
  dom.dataset.codeFence = 'true';
  const opener = document.createElement('div');
  opener.dataset.codeFenceLine = 'opening';
  opener.contentEditable = 'false';
  const marker = document.createTextNode(codeFenceMarker(node));
  opener.append(marker);
  const language = document.createElement('input');
  language.dataset.codeLanguage = 'true';
  language.setAttribute('aria-label', '代码语言');
  language.value = node.attrs.language ?? '';
  language.size = Math.max(4, language.value.length + 1);
  language.addEventListener('input', () => {
    const pos = getPos();
    if (typeof pos !== 'number') return;
    const current = view.state.doc.nodeAt(pos);
    if (!current) return;
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, language: language.value }));
    language.size = Math.max(4, language.value.length + 1);
  });
  opener.append(language);
  const fenceLength = document.createElement('input');
  fenceLength.dataset.codeFenceLength = 'true';
  fenceLength.type = 'number';
  fenceLength.min = '3';
  fenceLength.step = '1';
  fenceLength.title = '围栏长度';
  fenceLength.setAttribute('aria-label', '围栏长度');
  fenceLength.value = String(codeFenceMarker(node).length);
  fenceLength.addEventListener('input', () => {
    const value = Number(fenceLength.value);
    const pos = getPos();
    if (!Number.isInteger(value) || value < 3 || typeof pos !== 'number') return;
    const current = view.state.doc.nodeAt(pos);
    if (current) view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, fenceLength: value }));
  });
  fenceLength.addEventListener('blur', () => {
    const pos = getPos();
    const current = typeof pos === 'number' ? view.state.doc.nodeAt(pos) : null;
    if (current) fenceLength.value = String(codeFenceMarker(current).length);
  });
  opener.append(fenceLength);
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.dataset.codeCopy = 'true';
  copy.setAttribute('aria-label', '复制代码块');
  copy.textContent = '复制';
  copy.contentEditable = 'false';
  copy.addEventListener('click', () => {
    const pos = getPos();
    const current = typeof pos === 'number' ? view.state.doc.nodeAt(pos) : null;
    if (!current) return;
    void navigator.clipboard.writeText(current.textContent).then(() => {
      copy.textContent = '已复制';
      window.setTimeout(() => { copy.textContent = '复制'; }, 1600);
    }).catch(() => { copy.textContent = '复制失败'; });
  });
  opener.append(copy);
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  pre.append(code);
  const closer = document.createElement('div');
  closer.dataset.codeFenceLine = 'closing';
  closer.contentEditable = 'false';
  closer.textContent = codeFenceMarker(node);
  closer.title = '点击进入代码块后的正文；在下一行行首按 Backspace 可删除结束围栏';
  closer.addEventListener('mousedown', (event) => {
    event.preventDefault();
    const pos = getPos();
    if (typeof pos === 'number') moveAfterCodeFence(view, pos);
  });
  dom.append(opener, pre, closer);
  return {
    dom,
    contentDOM: code,
    update(updated) {
      if (updated.type !== node.type) return false;
      marker.textContent = codeFenceMarker(updated);
      closer.textContent = codeFenceMarker(updated);
      if (document.activeElement !== language) language.value = updated.attrs.language ?? '';
      if (document.activeElement !== fenceLength) fenceLength.value = String(codeFenceMarker(updated).length);
      return true;
    },
    stopEvent(event) { return event.target === language || event.target === fenceLength || event.target === closer || event.target === copy; },
    ignoreMutation(mutation) { return !code.contains(mutation.target); },
  };
});

const rawBlock = $nodeSchema('preserved_raw_block', () => ({
  group: 'block',
  atom: true,
  selectable: true,
  attrs: { raw: { default: '', validate: 'string' } },
  parseDOM: [{ tag: 'div[data-preserved-raw]', getAttrs: (element) => ({ raw: (element as HTMLElement).dataset.raw ?? '' }) }],
  toDOM: (node) => ['div', { 'data-preserved-raw': 'true', 'data-raw': node.attrs.raw }, node.attrs.raw],
  parseMarkdown: {
    match: (node) => node.type === 'preservedRaw',
    runner: (state, node, type) => state.addNode(type, { raw: node.raw as string }),
  },
  toMarkdown: {
    match: (node) => node.type.name === 'preserved_raw_block',
    runner: (state, node) => state.addNode('html', undefined, node.attrs.raw),
  },
}));

const inlineMath = $nodeSchema('preserved_inline_math', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  attrs: { value: { default: '', validate: 'string' } },
  parseDOM: [{ tag: 'span[data-inline-math]', getAttrs: (element) => ({ value: (element as HTMLElement).dataset.value ?? '' }) }],
  toDOM: (node) => {
    const span = document.createElement('span');
    span.dataset.inlineMath = 'true';
    span.dataset.value = node.attrs.value;
    katex.render(node.attrs.value, span, { throwOnError: false, trust: false });
    return span;
  },
  parseMarkdown: {
    match: (node) => node.type === 'inlineMath',
    runner: (state, node, type) => state.addNode(type, { value: node.value as string }),
  },
  toMarkdown: {
    match: (node) => node.type.name === 'preserved_inline_math',
    runner: (state, node) => state.addNode('inlineMath', undefined, node.attrs.value),
  },
}));

const blockMath = $nodeSchema('preserved_block_math', () => ({
  group: 'block',
  atom: true,
  selectable: true,
  attrs: { value: { default: '', validate: 'string' } },
  parseDOM: [{ tag: 'div[data-block-math]', getAttrs: (element) => ({ value: (element as HTMLElement).dataset.value ?? '' }) }],
  toDOM: (node) => {
    const div = document.createElement('div');
    div.dataset.blockMath = 'true';
    div.dataset.value = node.attrs.value;
    katex.render(node.attrs.value, div, { displayMode: true, throwOnError: false, trust: false });
    return div;
  },
  parseMarkdown: {
    match: (node) => node.type === 'math',
    runner: (state, node, type) => state.addNode(type, { value: node.value as string }),
  },
  toMarkdown: {
    match: (node) => node.type.name === 'preserved_block_math',
    runner: (state, node) => state.addNode('math', undefined, node.attrs.value),
  },
}));

function protectedRawInDoc(doc: ProseMirrorNode): string[] {
  const values: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === 'preserved_raw_block') values.push(node.attrs.raw ?? '');
  });
  return values;
}

export function missingProtectedRaw(markdown: string, values: string[]): string | undefined {
  const required = new Map<string, number>();
  for (const value of values) if (value) required.set(value, (required.get(value) ?? 0) + 1);
  for (const [value, count] of required) {
    if (markdown.split(value).length - 1 < count) return value;
  }
  return undefined;
}

function unprotectedRawText(doc: ProseMirrorNode): string | undefined {
  let suspicious: string | undefined;
  const pendingParagraphs = new Set<ProseMirrorNode>();
  let pending: string | undefined;
  doc.forEach((block) => {
    if (block.type.name !== 'paragraph') { pending = undefined; return; }
    const wasPending = Boolean(pending);
    if (!pending) pending = /^ {0,3}(`{3,}|~{3,})[^\s`~]*[ \t]*$/.exec(block.textContent)?.[1];
    if (!pending) return;
    pendingParagraphs.add(block);
    const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(block.textContent);
    if (wasPending && close && close[1][0] === pending[0] && close[1].length >= pending.length) pending = undefined;
  });
  doc.descendants((node, _position, parent) => {
    if (parent && pendingParagraphs.has(parent)) return;
    if (!node.isText || parent?.type.spec.code || node.marks.some((mark) => mark.type.name === 'inlineCode')) return;
    if (/<!--|<\/?[a-z][\w-]*\b|\{%|(^|\n):::/i.test(node.text ?? '')) suspicious = node.text?.slice(0, 40);
  });
  return suspicious;
}

function clipboardPlainText(fragment: Fragment): string {
  const parts: string[] = [];
  fragment.forEach((node, _offset, index) => {
    if (index > 0 && node.isBlock) parts.push('\n\n');
    if (node.type.name === 'preserved_raw_block') parts.push(node.attrs.raw);
    else if (node.type.name === 'preserved_inline_math') parts.push(`$${node.attrs.value}$`);
    else if (node.type.name === 'preserved_block_math') parts.push(`$$\n${node.attrs.value}\n$$`);
    else if (node.isText) parts.push(node.text ?? '');
    else parts.push(clipboardPlainText(node.content));
  });
  return parts.join('');
}

function indentWithFourSpaces(view: EditorView): boolean {
  const { selection } = view.state;
  const { $from, $to } = selection;
  if ($from.parent.type.name === 'code_block' && $to.parent === $from.parent) {
    if (selection.empty) {
      view.dispatch(view.state.tr.insertText('    ').scrollIntoView());
      return true;
    }
    const startPos = $from.before() + 1;
    const source = $from.parent.textContent;
    const from = selection.from - startPos;
    const to = selection.to - startPos;
    const start = source.lastIndexOf('\n', from - 1) + 1;
    const lastSelected = Math.max(from, to - 1);
    const nextNewline = source.indexOf('\n', lastSelected);
    const end = nextNewline < 0 ? source.length : nextNewline;
    const replacement = source.slice(start, end).split('\n').map((line) => `    ${line}`).join('\n');
    const tr = view.state.tr.insertText(replacement, startPos + start, startPos + end);
    tr.setSelection(TextSelection.create(tr.doc, startPos + start, startPos + start + replacement.length));
    view.dispatch(tr.scrollIntoView());
    return true;
  }
  if (!$from.sameParent($to)) return false;
  const tr = selection.empty
    ? view.state.tr.insertText('    ')
    : view.state.tr.insertText('    ', $from.before() + 1);
  view.dispatch(tr.scrollIntoView());
  return true;
}

export function createUnifiedMilkdown(
  root: HTMLElement,
  source: string,
  onChange: (markdown: string, error?: string) => void,
  onDocumentState?: (state: unknown) => void,
  onViewUpdate?: (view: EditorView) => void,
  spellCheck = false,
) {
  const protectedSegments = parseSegments(source).filter((segment) => segment.kind === 'frontmatter' || segment.kind === 'raw');
  const protectedByStart = new Map(protectedSegments.map((segment) => [segment.start, segment.original]));
  const initialUnclosedFence = unclosedFenceLines(source);
  let parserPadding = 1;
  while (protectedByStart.has(parserPadding + 2)) parserPadding++;
  const safeLinePrefix = 'x'.repeat(parserPadding) + '\n\n';
  const editableCodeBlock = codeBlockSchema.extendSchema((original) => (ctx) => {
    const base = original(ctx);
    return {
      ...base,
      attrs: {
        ...base.attrs,
        fenceLength: { default: 3, validate: 'number' },
        fenceChar: { default: '`', validate: 'string' },
      },
      parseMarkdown: {
        ...base.parseMarkdown,
        runner: (state, node, type) => {
          const offset = node.position?.start.offset;
          const line = offset === undefined ? '' : source.slice(offset).split(/\r?\n/, 1)[0];
          const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
          state.openNode(type, {
            language: node.lang ?? '',
            fenceLength: fence?.[1].length ?? 3,
            fenceChar: fence?.[1][0] ?? '`',
          });
          if (typeof node.value === 'string') state.addText(node.value);
          state.closeNode();
        },
      },
    };
  });
  const frontmatterPlugin = $remark('b0-frontmatter', () => remarkFrontmatter, ['yaml']);
  const mathPlugin = $remark('b0-math', () => remarkMath);
  const rawPlugin = $remark('b0-raw', () => () => (tree: MarkdownNode) => {
    if (!tree.children) return;
    tree.children = tree.children.map((node) => {
      const raw = node.position?.start.offset === undefined ? undefined : protectedByStart.get(node.position.start.offset);
      if (raw === undefined) return node;
      return { type: 'preservedRaw', raw, value: raw, position: node.position };
    });
  });
  const syncChanges = $prose((ctx) => new Plugin({
    props: {
      clipboardTextSerializer: (slice) => clipboardPlainText(slice.content),
      handleKeyDown: (view, event) => {
        if (view.composing || event.isComposing) return false;
        if (event.key.toLowerCase() === 'a' && (event.ctrlKey || event.metaKey) &&
            !event.altKey && !event.shiftKey && view.state.selection.$from.parent.type.name === 'code_block') {
          const block = view.state.selection.$from;
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc,
            block.before() + 1, block.after() - 1)));
          event.preventDefault();
          return true;
        }
        if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
          if (!indentWithFourSpaces(view)) return false;
          event.preventDefault();
          return true;
        }
        if (event.key === 'Backspace' && !event.ctrlKey && !event.altKey && !event.metaKey)
          return removeClosingCodeFence(view);
        if ((event.key === 'ArrowDown' || event.key === 'ArrowRight') && !event.shiftKey &&
            !event.ctrlKey && !event.altKey && !event.metaKey && view.state.selection.empty) {
          const { $from } = view.state.selection;
          if ($from.depth === 1 && $from.parent.type.name === 'code_block' &&
              $from.parentOffset === $from.parent.content.size)
            return moveAfterCodeFence(view, $from.before());
        }
        if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return false;
        return renderCompletedLine(view, ctx.get(parserCtx), safeLinePrefix);
      },
    },
    view: (mountedView) => {
      const initialDoc = mountedView.state.doc;
      onViewUpdate?.(mountedView);
      return { update: (view, previous) => {
        onViewUpdate?.(view);
        if (previous.doc.eq(view.state.doc)) return;
        onDocumentState?.(view.state.doc.toJSON());
        try {
          const currentDoc = view.state.doc;
          const trailing = currentDoc.lastChild;
          const onlyNavigationParagraph = initialDoc.lastChild?.type.name === 'code_block' &&
            currentDoc.childCount === initialDoc.childCount + 1 &&
            trailing?.type.name === 'paragraph' && trailing.content.size === 0 &&
            currentDoc.content.cut(0, currentDoc.content.size - trailing.nodeSize).eq(initialDoc.content);
          if (currentDoc.eq(initialDoc) || onlyNavigationParagraph) {
            onChange(source);
            return;
          }
          const unsafeText = unprotectedRawText(view.state.doc);
          if (unsafeText) {
            onChange('', `输入包含无法安全序列化的原始语法（${unsafeText}）；请撤销这次输入后在源码模式编辑`);
            return;
          }
          const markdown = serializeDeferredDraft(view.state.doc, initialDoc, ctx.get(serializerCtx), Boolean(initialUnclosedFence), source.endsWith('\n'));
          const rawValues = protectedRawInDoc(view.state.doc);
          const missing = missingProtectedRaw(markdown, rawValues);
          if (missing) onChange(markdown, '可视编辑结果未能保留原始片段，已阻止更新；请撤销后改用源码模式');
          else onChange(markdown);
        } catch (error) {
          onChange('', `可视编辑结果无法安全序列化：${String(error)}`);
        }
      } };
    },
  }));
  const searchPlugin = $prose(() => proseSearch());
  const spellingPlugin = $prose(() => localSpelling(spellCheck));

  return Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, source);
      ctx.update(editorStateOptionsCtx, (previous) => (options) => {
        const configured = previous(options);
        const doc = configured.doc;
        if (!doc) return configured;
        const preserved = preserveSourceBlankLines(doc, source);
        if (!initialUnclosedFence || preserved.lastChild?.type.name !== 'code_block')
          return { ...configured, doc: preserved };
        const nodes: ProseMirrorNode[] = [];
        preserved.forEach((node, _offset, index) => { if (index < preserved.childCount - 1) nodes.push(node); });
        for (const line of initialUnclosedFence) {
          nodes.push(doc.type.schema.nodes.paragraph.create(null, line ? doc.type.schema.text(line) : undefined));
        }
        return { ...configured, doc: preserved.copy(Fragment.fromArray(nodes)) };
      });
    })
    .config((ctx) => {
      ctx.set(highlightPluginConfig.key, { parser: parseHighlightedCode });
    })
    .use(commonmark.filter((plugin) => !immediateRules.has(plugin)))
    .use(gfm.filter((plugin) => !immediateRules.has(plugin)))
    .use(frontmatterPlugin)
    .use(mathPlugin)
    .use(rawPlugin)
    .use(rawBlock)
    .use(inlineMath)
    .use(blockMath)
    .use(editableCodeBlock)
    .use(visibleCodeFence)
    .use(highlight)
    .use(history)
    .use(searchPlugin)
    .use(spellingPlugin)
    .use(syncChanges);
}
