import { Fragment, type Node as ProseMirrorNode } from '@milkdown/kit/prose/model';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

type PositionedBlock = { position?: { start: { offset?: number }; end: { offset?: number } } };

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml']).use(remarkMath);

function newlines(source: string): number { return (source.match(/\n/g) ?? []).length; }

/** Keep source whitespace as editable empty paragraphs; never insert inside a parsed block. */
export function preserveSourceBlankLines(doc: ProseMirrorNode, source: string): ProseMirrorNode {
  const blocks = (parser.parse(source) as { children: PositionedBlock[] }).children;
  if (!blocks.length || blocks.length !== doc.childCount) return doc;
  const positions = blocks.map((block) => block.position);
  if (positions.some((position) => position?.start.offset === undefined || position.end.offset === undefined)) return doc;

  const result: ProseMirrorNode[] = [];
  const empty = () => result.push(doc.type.schema.nodes.paragraph.create());
  for (let index = 0; index < blocks.length; index++) {
    const start = positions[index]!.start.offset!;
    const previousEnd = index ? positions[index - 1]!.end.offset! : 0;
    const gap = source.slice(previousEnd, start);
    const count = newlines(gap);
    // Two newlines are the ordinary Markdown separator between top-level blocks.
    const extra = index ? Math.max(0, count - 2) : count;
    for (let line = 0; line < extra; line++) empty();
    result.push(doc.child(index));
  }
  const trailing = newlines(source.slice(positions.at(-1)!.end.offset!));
  for (let line = 1; line < trailing; line++) empty();
  return result.length === doc.childCount ? doc : doc.copy(Fragment.fromArray(result));
}
