import { undo as undoSource, redo as redoSource } from '@codemirror/commands';
import { ChangeSet } from '@codemirror/state';
import type { EditorView as CodeMirrorView } from 'codemirror';
import { toggleMark } from '@milkdown/kit/prose/commands';
import { redo as redoVisual, undo as undoVisual } from '@milkdown/kit/prose/history';
import { NodeSelection } from '@milkdown/kit/prose/state';
import type { EditorView as ProseMirrorView } from '@milkdown/kit/prose/view';
import { parseSegments } from '../markdown/segments';

export function setVisualHeading(view: ProseMirrorView, level: number): boolean {
  const { selection, schema } = view.state;
  const type = level === 0 ? schema.nodes.paragraph : schema.nodes.heading;
  if (!type) return false;
  const selectedNode = selection instanceof NodeSelection ? selection.node : selection.$from.parent;
  if (!['paragraph', 'heading'].includes(selectedNode.type.name)) return false;
  const depth = selection instanceof NodeSelection ? selection.$from.depth : selection.$from.depth - 1;
  const parent = selection.$from.node(depth);
  const index = selection.$from.index(depth);
  if (!parent.canReplaceWith(index, index + 1, type)) return false;
  const position = selection instanceof NodeSelection ? selection.from : selection.$from.before();
  view.dispatch(view.state.tr.setNodeMarkup(position, type, level ? { level } : {}));
  view.focus();
  return true;
}

export function setSourceHeading(view: CodeMirrorView, level: number): boolean {
  const position = view.state.selection.main.head;
  const line = view.state.doc.lineAt(position);
  const source = view.state.doc.toString();
  // Formatting inside a raw block or code fence could change its meaning.
  const segment = parseSegments(source).find((part) => part.start <= line.from && line.from < part.end);
  if (segment && (segment.kind === 'raw' || segment.kind === 'frontmatter' ||
      /^ {0,3}(`{3,}|~{3,})/.test(segment.original))) return false;
  const indentation = /^ {0,3}/.exec(line.text)?.[0] ?? '';
  const oldPrefix = /^#{1,6}(?:[ \t]+|$)/.exec(line.text.slice(indentation.length))?.[0] ?? '';
  const text = line.text.slice(indentation.length + oldPrefix.length);
  const replacement = level ? `${indentation}${'#'.repeat(level)} ${text}` : `${indentation}${text}`;
  if (replacement === line.text) return true;
  const oldTextFrom = line.from + indentation.length + oldPrefix.length;
  const newTextFrom = line.from + indentation.length + (level ? level + 1 : 0);
  const changes = ChangeSet.of([{ from: line.from, to: line.to, insert: replacement }], view.state.doc.length);
  const mapEndpoint = (endpoint: number) => {
    if (endpoint < line.from || endpoint > line.to) return changes.mapPos(endpoint);
    // The Markdown prefix is structural. Map positions through the unchanged
    // paragraph text, rather than preserving an offset into the new prefix.
    return Math.min(line.from + replacement.length,
      newTextFrom + Math.max(0, endpoint - oldTextFrom));
  };
  const { anchor, head } = view.state.selection.main;
  view.dispatch({ changes, selection: { anchor: mapEndpoint(anchor), head: mapEndpoint(head) } });
  view.focus();
  return true;
}

export type TextFormat = 'strong' | 'em' | 'strike_through' | 'inlineCode' | 'link';

function protectedVisualSelection(view: ProseMirrorView): boolean {
  const { from, to, $from } = view.state.selection;
  if ($from.parent.type.spec.code) return true;
  let protectedNode = false;
  view.state.doc.nodesBetween(from, Math.max(to, from), (node) => {
    if (node.type.spec.code || node.type.name.startsWith('preserved_')) protectedNode = true;
  });
  return protectedNode;
}

export function toggleVisualFormat(view: ProseMirrorView, kind: TextFormat, href?: string): boolean {
  if (protectedVisualSelection(view)) return false;
  const mark = view.state.schema.marks[kind === 'em' ? 'emphasis' : kind];
  if (!mark) return false;
  if (kind === 'link' && !href) return false;
  const changed = toggleMark(mark, kind === 'link' ? { href, title: null } : undefined)(view.state, view.dispatch);
  if (changed) view.focus();
  return changed;
}

export function toggleSourceFormat(view: CodeMirrorView, kind: TextFormat, href?: string): boolean {
  const range = view.state.selection.main;
  const source = view.state.doc.toString();
  const protectedSegment = parseSegments(source).some((part) =>
    part.start < Math.max(range.to, range.from + 1) && part.end > range.from &&
    (part.kind === 'raw' || part.kind === 'frontmatter' || /^ {0,3}(`{3,}|~{3,})/.test(part.original)));
  if (protectedSegment) return false;
  const selected = view.state.doc.sliceString(range.from, range.to);
  if (kind === 'link') {
    if (!href) return false;
    const label = selected || '链接文本';
    const insert = `[${label}](${href})`;
    view.dispatch({ changes: { from: range.from, to: range.to, insert },
      selection: { anchor: range.from + 1, head: range.from + 1 + label.length } });
    view.focus();
    return true;
  }
  const marker = kind === 'strong' ? '**' : kind === 'em' ? '*' : kind === 'strike_through' ? '~~' : '`';
  const wrapped = selected.startsWith(marker) && selected.endsWith(marker) && selected.length >= marker.length * 2;
  const surrounding = range.from >= marker.length && range.to + marker.length <= view.state.doc.length &&
    view.state.doc.sliceString(range.from - marker.length, range.from) === marker &&
    view.state.doc.sliceString(range.to, range.to + marker.length) === marker;
  if (surrounding) {
    view.dispatch({ changes: [
      { from: range.from - marker.length, to: range.from, insert: '' },
      { from: range.to, to: range.to + marker.length, insert: '' },
    ], selection: { anchor: range.from - marker.length, head: range.to - marker.length } });
    view.focus();
    return true;
  }
  const insert = wrapped ? selected.slice(marker.length, -marker.length) : `${marker}${selected}${marker}`;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: wrapped ? { anchor: range.from, head: range.from + insert.length } :
      { anchor: range.from + marker.length, head: range.from + marker.length + selected.length },
  });
  view.focus();
  return true;
}

export function undoEditor(visual: ProseMirrorView | null, source: CodeMirrorView | null): boolean {
  if (source) return undoSource(source);
  return visual ? undoVisual(visual.state, visual.dispatch) : false;
}

export function redoEditor(visual: ProseMirrorView | null, source: CodeMirrorView | null): boolean {
  if (source) return redoSource(source);
  return visual ? redoVisual(visual.state, visual.dispatch) : false;
}
