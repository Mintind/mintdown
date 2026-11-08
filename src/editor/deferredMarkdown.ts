import type { Parser, Serializer } from '@milkdown/kit/transformer';
import type { EditorView } from '@milkdown/kit/prose/view';
import { TextSelection } from '@milkdown/kit/prose/state';
import { Fragment, type Node as ProseMirrorNode } from '@milkdown/kit/prose/model';
import { closeHistory } from '@milkdown/kit/prose/history';

type Block = { node: ProseMirrorNode; pos: number };

const openingFence = /^ {0,3}(`{3,}|~{3,})([^\s`~]*)[ \t]*$/;
const closingFence = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const unsafeRaw = /<!--|<\/?[a-z][\w-]*\b|\{%|^:::/i;
const markdownDraft = /[#*`~_!\[\]>|]|^\s*(?:[-+]\s|\d+\.\s)/;

export function unclosedFenceLines(source: string): string[] | undefined {
  const lines = source.split(/\r?\n/);
  let opener = -1;
  let marker = '';
  for (let index = 0; index < lines.length; index++) {
    if (opener < 0) {
      const open = openingFence.exec(lines[index]);
      if (open) { opener = index; marker = open[1]; }
      continue;
    }
    const close = closingFence.exec(lines[index]);
    if (close && close[1][0] === marker[0] && close[1].length >= marker.length) opener = -1;
  }
  return opener < 0 ? undefined : lines.slice(opener);
}

export function codeFenceMarker(node: ProseMirrorNode): string {
  const character = node.attrs.fenceChar === '~' ? '~' : '`';
  const longestContentRun = Math.max(0, ...(node.textContent.match(character === '~' ? /~+/g : /`+/g) ?? []).map((run) => run.length));
  const length = Math.max(3, Number(node.attrs.fenceLength) || 3, longestContentRun + 1);
  return character.repeat(length);
}

/** Put the caret in an ordinary paragraph after a rendered code fence. */
export function moveAfterCodeFence(view: EditorView, pos: number): boolean {
  const node = view.state.doc.nodeAt(pos);
  if (node?.type.name !== 'code_block') return false;
  const after = pos + node.nodeSize;
  const next = view.state.doc.nodeAt(after);
  let tr = view.state.tr;
  if (next?.type.name !== 'paragraph') tr = tr.insert(after, view.state.schema.nodes.paragraph.create());
  tr = tr.setSelection(TextSelection.create(tr.doc, after + 1));
  view.dispatch(tr);
  view.focus();
  return true;
}

/** Backspace at the start of the following paragraph removes the closing fence. */
export function removeClosingCodeFence(view: EditorView): boolean {
  const { selection, doc, schema } = view.state;
  if (!selection.empty || selection.$from.depth !== 1 ||
      selection.$from.parent.type.name !== 'paragraph' || selection.$from.parentOffset !== 0) return false;
  const paragraphPos = selection.$from.before();
  if (paragraphPos === 0) return false;
  const previousIndex = selection.$from.index(0) - 1;
  const previous = previousIndex >= 0 ? doc.child(previousIndex) : null;
  if (previous?.type.name !== 'code_block') return false;
  const codePos = paragraphPos - previous.nodeSize;
  const marker = codeFenceMarker(previous);
  const lines = [`${marker}${previous.attrs.language || ''}`, ...previous.textContent.split('\n')];
  const paragraphs = lines.map((line) => schema.nodes.paragraph.create(null, line ? schema.text(line) : undefined));
  const tr = view.state.tr.replaceWith(codePos, paragraphPos, Fragment.fromArray(paragraphs));
  const cursor = codePos + paragraphs.reduce((size, part) => size + part.nodeSize, 0) - 1;
  tr.setSelection(TextSelection.create(tr.doc, cursor));
  view.dispatch(tr);
  view.focus();
  return true;
}

function topLevelBlocks(view: EditorView): Block[] {
  const blocks: Block[] = [];
  view.state.doc.forEach((node, pos) => blocks.push({ node: node as Block['node'], pos }));
  return blocks;
}

function replaceAndContinue(view: EditorView, from: number, to: number, replacement: Block['node']) {
  const paragraph = view.state.schema.nodes.paragraph.create();
  const tr = view.state.tr.replaceWith(from, to, Fragment.fromArray([replacement, paragraph]));
  tr.setSelection(TextSelection.create(tr.doc, from + replacement.nodeSize + 1));
  view.dispatch(closeHistory(tr).scrollIntoView());
}

/**
 * Markdown input rules stay disabled while a line is being typed. Enter is the
 * commit point for a completed line; a fence waits for a matching closing line.
 */
export function renderCompletedLine(view: EditorView, parse: Parser, safePrefix = ''): boolean {
  if (view.composing || !view.state.selection.empty) return false;
  const { $from } = view.state.selection;
  if ($from.depth !== 1 || $from.parent.type.name !== 'paragraph' ||
      $from.parentOffset !== $from.parent.content.size) return false;

  const blocks = topLevelBlocks(view);
  const currentIndex = $from.index(0);
  const current = blocks[currentIndex];
  const line = current.node.textContent;
  let pending: { index: number; marker: string; language: string } | undefined;
  for (let index = 0; index <= currentIndex; index++) {
    const block = blocks[index];
    if (block.node.type.name !== 'paragraph') { pending = undefined; continue; }
    if (!pending) {
      const open = openingFence.exec(block.node.textContent);
      if (open) pending = { index, marker: open[1], language: open[2] };
      continue;
    }
    const close = closingFence.exec(block.node.textContent);
    if (!close || close[1][0] !== pending.marker[0] || close[1].length < pending.marker.length) continue;
    if (index === currentIndex) {
      const code = blocks.slice(pending.index + 1, currentIndex).map((part) => part.node.textContent).join('\n');
      const codeNode = view.state.schema.nodes.code_block.create(
        { language: pending.language, fenceLength: pending.marker.length, fenceChar: pending.marker[0] },
        code ? view.state.schema.text(code) : undefined,
      );
      replaceAndContinue(view, blocks[pending.index].pos, current.pos + current.node.nodeSize, codeNode);
      return true;
    }
    pending = undefined;
  }
  // Until the matching fence appears, every line inside it stays literal text.
  if (pending) return false;

  if (!line.trim() || unsafeRaw.test(line)) return false;
  const parsed = parse(safePrefix + line + '\n');
  if (parsed.childCount !== (safePrefix ? 2 : 1)) return false;
  const replacement = parsed.lastChild;
  if (!replacement || replacement.type.name === 'preserved_raw_block' ||
      replacement.type.name === 'html' || replacement.eq(current.node)) return false;
  replaceAndContinue(view, current.pos, current.pos + current.node.nodeSize, replacement);
  return true;
}

/** Keep unfinished Markdown as typed instead of letting the serializer escape it. */
export function serializeDeferredDraft(doc: ProseMirrorNode, initialDoc: ProseMirrorNode, serialize: Serializer, preserveInitialOpenFence = false, preserveTrailingNewline = false): string {
  const blocks: ProseMirrorNode[] = [];
  doc.forEach((node) => blocks.push(node));
  const initialNodes = new Set<ProseMirrorNode>();
  initialDoc.forEach((node) => initialNodes.add(node));
  const isDraft = (node: ProseMirrorNode) =>
    node.type.name === 'paragraph' && !initialNodes.has(node) &&
    node.childCount <= 1 && (!node.firstChild || node.firstChild.marks.length === 0) &&
    markdownDraft.test(node.textContent);
  const isCustomCode = (node: ProseMirrorNode) =>
    node.type.name === 'code_block' && (codeFenceMarker(node) !== '```' || node.attrs.fenceChar === '~');
  const isEmptyParagraph = (node: ProseMirrorNode) =>
    node.type.name === 'paragraph' && node.content.size === 0;
  const isPendingOpen = (node: ProseMirrorNode) =>
    node.type.name === 'paragraph' && openingFence.test(node.textContent) &&
    (isDraft(node) || preserveInitialOpenFence);
  // Milkdown serializes an empty paragraph as literal "<br />". Keep it as
  // Markdown whitespace instead; a genuine raw <br /> remains a separate node.
  if (!blocks.some((block) => isDraft(block) || isCustomCode(block) || isPendingOpen(block) || isEmptyParagraph(block))) return serialize(doc);

  const parts: string[] = [];
  let regular: ProseMirrorNode[] = [];
  const flush = () => {
    if (!regular.length) return;
    parts.push(serialize(doc.type.create(null, Fragment.fromArray(regular))).trimEnd());
    regular = [];
  };
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (isPendingOpen(block)) {
      flush();
      const lines = [block.textContent];
      const open = openingFence.exec(block.textContent)!;
      while (index + 1 < blocks.length && blocks[index + 1].type.name === 'paragraph') {
        const next = blocks[++index];
        lines.push(next.textContent);
        const close = closingFence.exec(next.textContent);
        if (close && close[1][0] === open[1][0] && close[1].length >= open[1].length) break;
      }
      parts.push(lines.join('\n'));
    } else if (isCustomCode(block)) {
      flush();
      const marker = codeFenceMarker(block);
      parts.push(`${marker}${block.attrs.language || ''}\n${block.textContent}\n${marker}`);
    } else if (isEmptyParagraph(block)) {
      flush();
      parts.push('');
    } else if (isDraft(block)) {
      flush();
      parts.push(block.textContent);
    } else {
      regular.push(block);
    }
  }
  flush();
  const result = parts.reduce((result, part, index) =>
    index === 0 ? part : result + (parts[index - 1] === '' ? '\n' : '\n\n') + part, '');
  return preserveTrailingNewline && !result.endsWith('\n') ? result + '\n' : result;
}
