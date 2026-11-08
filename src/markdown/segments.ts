import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import remarkMath from 'remark-math';
import type { Root, RootContent } from 'mdast';

export type SegmentKind = 'milkdown' | 'frontmatter' | 'math' | 'raw';

export interface Segment {
  id: number;
  kind: SegmentKind;
  original: string;
  start: number;
  end: number;
  reason?: string;
}

const parser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, ['yaml'])
  .use(remarkMath);

const unsupportedPattern = /\{%|%\}|(^|\n):::/;

function descendants(node: RootContent): RootContent[] {
  const result: RootContent[] = [];
  const visit = (item: RootContent) => {
    result.push(item);
    if ('children' in item && Array.isArray(item.children)) {
      for (const child of item.children) visit(child as RootContent);
    }
  };
  visit(node);
  return result;
}

function classify(node: RootContent, original: string): Pick<Segment, 'kind' | 'reason'> {
  if (node.type === 'yaml') return { kind: 'frontmatter' };
  if (node.type === 'html') return { kind: 'raw', reason: '原始 HTML/注释按原文保留；请在源码模式修改' };
  if (node.type === 'math') return { kind: 'math' };
  if (unsupportedPattern.test(original)) return { kind: 'raw', reason: '未知扩展语法按原文保留；请在源码模式修改' };

  const nodes = descendants(node);
  if (nodes.some((item) => item.type === 'inlineMath')) return { kind: 'math' };
  if (nodes.some((item) => item.type === 'html')) {
    return { kind: 'raw', reason: '行内 HTML 按原文保留；请在源码模式修改' };
  }
  const supported = new Set([
    'heading', 'paragraph', 'text', 'strong', 'emphasis', 'delete', 'inlineCode',
    'code', 'blockquote', 'list', 'listItem', 'table', 'tableRow', 'tableCell',
    'link', 'image', 'break', 'thematicBreak', 'linkReference', 'imageReference',
    'definition', 'footnoteReference',
  ]);
  const unknown = nodes.find((item) => !supported.has(item.type));
  if (unknown) return { kind: 'raw', reason: `未知 AST 节点 ${unknown.type} 按原文保留` };
  // References depend on definitions elsewhere. Keep both as source-only until
  // the editor can prove their relationships survive serialization.
  if (nodes.some((item) => ['linkReference', 'imageReference', 'definition', 'footnoteReference'].includes(item.type))) {
    return { kind: 'raw', reason: '引用式链接或扩展引用按原文保留；请在源码模式修改' };
  }
  return { kind: 'milkdown' };
}

export function parseSegments(source: string): Segment[] {
  const tree = parser.parse(source) as Root;
  return tree.children.map((node, id) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined || start > end) {
      throw new Error(`Markdown 节点 ${id} 缺少可靠的源码位置`);
    }
    const original = source.slice(start, end);
    return { id, original, start, end, ...classify(node, original) };
  });
}
