import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

interface ImageNode {
  type: string;
  url?: string;
  children?: ImageNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

const parser = unified().use(remarkParse).use(remarkGfm);

export function imageUrls(source: string): string[] {
  const urls = new Set<string>();
  const visit = (node: ImageNode) => {
    if (node.type === 'image' && node.url) urls.add(node.url);
    node.children?.forEach(visit);
  };
  visit(parser.parse(source) as ImageNode);
  return [...urls];
}

export function imageReferenceExamples(source: string): Map<string, { syntax: string; count: number }> {
  const examples = new Map<string, { syntax: string; count: number }>();
  const visit = (node: ImageNode) => {
    if (node.type === 'image' && node.url && node.position?.start.offset !== undefined && node.position.end.offset !== undefined) {
      const existing = examples.get(node.url);
      if (existing) existing.count++;
      else examples.set(node.url, {
        syntax: source.slice(node.position.start.offset, node.position.end.offset), count: 1,
      });
    }
    node.children?.forEach(visit);
  };
  visit(parser.parse(source) as ImageNode);
  return examples;
}

export function imageUrlChanges(source: string, mappings: { oldUrl: string; newUrl: string }[]): { from: number; to: number; insert: string }[] {
  const replacements = new Map(mappings.map((item) => [item.oldUrl, item.newUrl]));
  const changes: { from: number; to: number; insert: string }[] = [];
  const visit = (node: ImageNode) => {
    const replacement = node.type === 'image' && node.url ? replacements.get(node.url) : undefined;
    if (replacement && replacement !== node.url && node.position?.start.offset !== undefined && node.position.end.offset !== undefined) {
      const start = node.position.start.offset;
      const raw = source.slice(start, node.position.end.offset);
      const relative = raw.lastIndexOf(node.url!);
      if (relative < 0) throw new Error(`无法安全定位图片引用：${node.url}`);
      changes.push({ from: start + relative, to: start + relative + node.url!.length, insert: replacement });
    }
    node.children?.forEach(visit);
  };
  visit(parser.parse(source) as ImageNode);
  return changes.sort((a, b) => a.from - b.from);
}

/** Restrict a relocation to the clicked image. Other images may share its URL. */
export function imageUrlChangeAt(source: string, from: number, to: number, oldUrl: string, newUrl: string) {
  const matches = imageUrlChanges(source, [{ oldUrl, newUrl }])
    .filter((change) => change.from >= from && change.to <= to);
  if (matches.length !== 1) throw new Error('当前图片语法已变化，请重新选择图片');
  return matches[0];
}

export function rewriteImageUrls(source: string, mappings: { oldUrl: string; newUrl: string }[]): string {
  for (const change of imageUrlChanges(source, mappings).reverse())
    source = source.slice(0, change.from) + change.insert + source.slice(change.to);
  return source;
}
