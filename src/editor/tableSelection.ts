import type { TableSyntax } from './localPreview';
import type { EditorView } from '@codemirror/view';

export interface FocusedEmptyTableCell { tableFrom: number; row: number; column: number }
const focusedEmptyCells = new WeakMap<EditorView, FocusedEmptyTableCell>();
export function focusEmptyTableCell(view: EditorView, cell: FocusedEmptyTableCell) { focusedEmptyCells.set(view, cell); }
export function focusedEmptyTableCell(view: EditorView) { return focusedEmptyCells.get(view); }
export function clearEmptyTableCellFocus(view: EditorView) { focusedEmptyCells.delete(view); }

export interface TableRectangle { top: number; bottom: number; left: number; right: number }

function cellAt(table: TableSyntax, position: number) {
  for (const [rowIndex, row] of table.rows.entries())
    for (const [columnIndex, cell] of row.cells.entries())
      if (cell.contentFrom <= position && position <= cell.contentTo)
        return { rowIndex, columnIndex };
  for (const [rowIndex, row] of table.rows.entries())
    for (const [columnIndex, cell] of row.cells.entries())
      if (cell.from <= position && position <= cell.to)
        return { rowIndex, columnIndex };
  return undefined;
}

/** A cross-cell CodeMirror selection represents a rectangular table selection. */
export function selectedTableRectangle(table: TableSyntax, selection: { anchor: number; head: number }): TableRectangle | undefined {
  if (selection.anchor === selection.head) return undefined;
  const anchor = cellAt(table, selection.anchor);
  const head = cellAt(table, selection.head);
  if (!anchor || !head || anchor.rowIndex === head.rowIndex && anchor.columnIndex === head.columnIndex) return undefined;
  return { top: Math.min(anchor.rowIndex, head.rowIndex), bottom: Math.max(anchor.rowIndex, head.rowIndex),
    left: Math.min(anchor.columnIndex, head.columnIndex), right: Math.max(anchor.columnIndex, head.columnIndex) };
}

export function selectedTableText(table: TableSyntax, rectangle: TableRectangle): string {
  return table.rows.slice(rectangle.top, rectangle.bottom + 1)
    .map((row) => row.cells.slice(rectangle.left, rectangle.right + 1).map((cell) => cell.raw).join('\t'))
    .join('\n');
}
