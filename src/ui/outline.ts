import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

export interface OutlineHeading {
  level: number;
  text: string;
  position: number;
}

type MarkdownNode = {
  type: string;
  value?: string;
  alt?: string;
  depth?: number;
  children?: MarkdownNode[];
  position?: { start: { offset?: number } };
};

const outlineParser = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml']);

function visibleText(node: MarkdownNode): string {
  if (node.value) return node.value;
  if (node.alt) return node.alt;
  return node.children?.map(visibleText).join('') ?? '';
}

export function outlineFromMarkdown(source: string): OutlineHeading[] {
  const tree = outlineParser.parse(source) as MarkdownNode;
  return (tree.children ?? []).flatMap((node) => node.type === 'heading' && node.depth &&
    node.position?.start.offset !== undefined
    ? [{ level: node.depth, text: visibleText(node).trim() || '（空标题）', position: node.position.start.offset }]
    : []);
}

export function outlineFromDocument(doc: ProseMirrorNode): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  doc.descendants((node, position) => {
    if (node.type.name === 'heading') headings.push({
      level: Number(node.attrs.level) || 1,
      text: node.textContent.trim() || '（空标题）',
      position,
    });
  });
  return headings;
}

export function activeHeadingIndex(headings: OutlineHeading[], position: number): number {
  let index = -1;
  for (let current = 0; current < headings.length; current++) {
    if (headings[current].position > position) break;
    index = current;
  }
  return index;
}

export function sameOutline(a: OutlineHeading[], b: OutlineHeading[]): boolean {
  return a.length === b.length && a.every((item, index) =>
    item.level === b[index].level && item.text === b[index].text && item.position === b[index].position);
}
