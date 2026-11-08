import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

type SourceBlock = { position?: { start: { offset?: number }; end: { offset?: number } } };
type MatchedBlock = { from: number; to: number; pmFrom: number; node: ProseMirrorNode };
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml']).use(remarkMath);

function matchBlocks(doc: ProseMirrorNode, source: string): MatchedBlock[] {
  const sourceBlocks = (parser.parse(source) as { children: SourceBlock[] }).children;
  const visualBlocks: { node: ProseMirrorNode; pmFrom: number }[] = [];
  doc.forEach((node, pmFrom) => {
    if (node.type.name !== 'paragraph' || node.content.size) visualBlocks.push({ node, pmFrom });
  });
  if (sourceBlocks.length !== visualBlocks.length) return [];
  return sourceBlocks.map((block, index) => ({
    from: block.position?.start.offset ?? 0,
    to: block.position?.end.offset ?? source.length,
    ...visualBlocks[index],
  }));
}

function textStart(source: string, block: MatchedBlock): number {
  const raw = source.slice(block.from, block.to);
  const text = block.node.textContent;
  if (!text) return block.from;
  const found = raw.indexOf(text);
  if (found >= 0) return block.from + found;
  const firstLine = text.split('\n', 1)[0];
  const lineFound = raw.indexOf(firstLine);
  return lineFound >= 0 ? block.from + lineFound : block.from;
}

function blankParagraphs(doc: ProseMirrorNode, from: number, to: number): number[] {
  const positions: number[] = [];
  doc.forEach((node, position) => {
    if (position >= from && position < to && node.type.name === 'paragraph' && node.content.size === 0)
      positions.push(position + 1);
  });
  return positions;
}

function lineStarts(source: string, from: number, to: number, leading: boolean): number[] {
  const starts = leading ? [0] : [];
  for (let index = from; index < to; index++) if (source[index] === '\n') starts.push(index + 1);
  return starts;
}

export function sourceToVisualPosition(doc: ProseMirrorNode, source: string, offset: number): number {
  const blocks = matchBlocks(doc, source);
  if (!blocks.length) return Math.min(1, doc.content.size);
  const containing = blocks.find((block) => offset >= block.from && offset <= block.to);
  if (!containing) {
    const next = blocks.find((block) => block.from > offset);
    const previous = [...blocks].reverse().find((block) => block.to < offset);
    const gapStart = previous?.to ?? 0;
    const gapEnd = next?.from ?? source.length;
    const empty = blankParagraphs(doc, previous ? previous.pmFrom + previous.node.nodeSize : 0,
      next?.pmFrom ?? doc.content.size);
    const starts = lineStarts(source, gapStart, gapEnd, !previous);
    let line = 0;
    for (let index = 0; index < starts.length && starts[index] <= offset; index++) line = index;
    if (line < empty.length) return empty[line];
  }
  const current = containing ?? blocks.find((block) => block.from > offset) ?? blocks.at(-1)!;
  const textOffset = Math.max(0, Math.min(current.node.content.size, offset - textStart(source, current)));
  return Math.min(doc.content.size, current.pmFrom + 1 + textOffset);
}

export function visualToSourcePosition(doc: ProseMirrorNode, source: string, position: number): number {
  const blocks = matchBlocks(doc, source);
  if (!blocks.length) return Math.min(source.length, position);
  const containing = blocks.find((block) => position >= block.pmFrom && position < block.pmFrom + block.node.nodeSize);
  if (!containing) {
    const next = blocks.find((block) => block.pmFrom > position);
    const previous = [...blocks].reverse().find((block) => block.pmFrom + block.node.nodeSize <= position);
    const gapStart = previous?.to ?? 0;
    const gapEnd = next?.from ?? source.length;
    const empty = blankParagraphs(doc, previous ? previous.pmFrom + previous.node.nodeSize : 0,
      next?.pmFrom ?? doc.content.size);
    const index = empty.findIndex((at) => position >= at - 1 && position <= at);
    if (index >= 0) return lineStarts(source, gapStart, gapEnd, !previous)[index] ?? gapStart;
  }
  const current = containing ?? blocks.find((block) => block.pmFrom > position) ?? blocks.at(-1)!;
  const textOffset = Math.max(0, Math.min(current.node.content.size, position - current.pmFrom - 1));
  return Math.min(source.length, textStart(source, current) + textOffset);
}
