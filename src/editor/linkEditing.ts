import type { EditorView } from '@codemirror/view';
import { linkAtPosition } from './localPreview';

/** Ctrl+K edits the real Markdown source; unfinished templates remain literal. */
export function insertLinkTemplate(view: EditorView): boolean {
  const range = view.state.selection.main;
  const current = linkAtPosition(view, range.head);
  if (current) {
    view.dispatch({ selection: { anchor: current.contentFrom, head: current.contentTo }, scrollIntoView: true });
    view.focus();
    return true;
  }
  const selected = view.state.doc.sliceString(range.from, range.to);
  const insert = `[${selected}]()`;
  const cursor = range.from + (selected ? selected.length + 3 : 1);
  view.dispatch({ changes: { from: range.from, to: range.to, insert },
    selection: { anchor: cursor }, scrollIntoView: true });
  view.focus();
  return true;
}

/** Tab from a link label to its destination; other Tab keys keep four-space indentation. */
export function jumpToLinkDestination(view: EditorView): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const line = view.state.doc.lineAt(selection.head);
  const expression = /\[([^\]\n]*)\]\(([^)\n]*)\)/g;
  for (const found of line.text.matchAll(expression)) {
    if (found[2]) continue;
    const start = line.from + found.index!;
    const labelEnd = start + 1 + found[1].length;
    const destination = labelEnd + 2;
    if (selection.head >= start + 1 && selection.head <= labelEnd) {
      view.dispatch({ selection: { anchor: destination }, scrollIntoView: true });
      return true;
    }
  }
  return false;
}
