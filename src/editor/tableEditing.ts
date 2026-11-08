import { EditorView, ViewPlugin } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import { localPreviewField, type TableSyntax } from './localPreview';
import { clearEmptyTableCellFocus, focusedEmptyTableCell, selectedTableRectangle, selectedTableText } from './tableSelection';

export type TableAction = 'row-before' | 'row-after' | 'row-delete' |
  'column-before' | 'column-after' | 'column-delete' |
  'align-left' | 'align-center' | 'align-right' | 'align-default';

function clearEmptyFocus(view: EditorView) {
  clearEmptyTableCellFocus(view);
  view.dom.querySelector('.md-table-focused-empty')?.classList.remove('md-table-focused-empty');
}
function tableSelection(view: EditorView) {
  const selection = view.state.selection.main;
  for (const table of view.state.field(localPreviewField, false)?.tables ?? []) {
    const rectangle = selectedTableRectangle(table, selection);
    if (rectangle) return { table, rectangle };
  }
  return undefined;
}

/** Apply one source transaction to cell contents only, leaving every pipe and row intact. */
export function replaceSelectedTableCells(view: EditorView, text: string): boolean {
  const selected = tableSelection(view);
  if (!selected) return false;
  const { table, rectangle } = selected;
  const cells = table.rows.slice(rectangle.top, rectangle.bottom + 1)
    .flatMap((row) => row.cells.slice(rectangle.left, rectangle.right + 1));
  const changes = cells.flatMap((cell, index) => {
    if (!cell.raw && (index > 0 || !text)) return [];
    const before = view.state.doc.sliceString(cell.from, cell.contentFrom);
    const after = view.state.doc.sliceString(cell.contentTo, cell.to);
    let insert: string;
    if (!cell.raw) insert = ` ${text} `;
    else if (index === 0 && text) insert = text;
    else insert = /[ \t]$/.test(before) && /^[ \t]/.test(after) ? '' : '  ';
    return [{ from: cell.contentFrom, to: cell.contentTo, insert }];
  });
  const first = cells[0];
  const firstInsert = changes.find((change) => change.from === first.contentFrom)?.insert;
  const anchor = first.contentFrom + (!first.raw ? text ? 1 + text.length : Math.min(1, first.contentTo - first.contentFrom)
    : text ? text.length : firstInsert === '  ' ? 1 : 0);
  view.dispatch({ changes, selection: { anchor },
    annotations: isolateHistory.of('full') });
  return true;
}

/** A zero-width GFM cell shares its position with a hidden pipe. Route the
 * first input to the cell that was actually clicked, without changing source
 * on mousedown or relying on a DOM position inside a non-editable widget. */
export function insertIntoFocusedEmptyCell(view: EditorView, text: string): boolean {
  const focused = focusedEmptyTableCell(view);
  if (!focused) return false;
  const table = view.state.field(localPreviewField, false)?.tables.find((item) => item.from === focused.tableFrom);
  const cell = table?.rows[focused.row]?.cells[focused.column];
  if (!cell || cell.raw || cell.contentFrom !== cell.contentTo) {
    clearEmptyFocus(view);
    return false;
  }
  if (!text) return true;
  view.dispatch({ changes: { from: cell.contentFrom, insert: text },
    selection: { anchor: cell.contentFrom + text.length } });
  clearEmptyFocus(view);
  return true;
}

/** Keep the regular CodeMirror selection and history; only table copy uses cell boundaries. */
export function tableSelectionClipboard() {
  return [EditorView.domEventHandlers({
    mousedown: (event, view) => {
      if (!(event.target as HTMLElement).closest('.md-table-empty-cell')) clearEmptyFocus(view);
      return false;
    },
    keydown: (event, view) => {
      if (/^(?:ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown|Tab|Escape)$/.test(event.key)) clearEmptyFocus(view);
      return false;
    },
    blur: (_event, view) => { clearEmptyFocus(view); return false; },
    copy: (event, view) => {
      const selected = tableSelection(view);
      if (!selected || !event.clipboardData) return false;
      event.clipboardData.setData('text/plain', selectedTableText(selected.table, selected.rectangle));
      event.preventDefault();
      return true;
    },
    cut: (event, view) => {
      const selected = tableSelection(view);
      if (!selected) return false;
      event.preventDefault();
      if (!event.clipboardData) return true;
      event.clipboardData.setData('text/plain', selectedTableText(selected.table, selected.rectangle));
      replaceSelectedTableCells(view, '');
      return true;
    },
  }), EditorView.mouseSelectionStyle.of((view, event) => {
    if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return null;
    const element = (event.target as HTMLElement).closest<HTMLElement>('.md-table-cell[data-table-empty="true"]');
    if (!element || element.classList.contains('md-table-empty-cell')) return null;
    const table = view.state.field(localPreviewField, false)?.tables.find((item) => item.from === Number(element.dataset.tableFrom));
    const cell = table?.rows[Number(element.dataset.tableRow)]?.cells[Number(element.dataset.tableColumn)];
    if (!cell || cell.contentFrom === cell.contentTo) return null;
    const anchor = cell.contentFrom + Math.floor((cell.contentTo - cell.contentFrom) / 2);
    return { get: (current) => EditorSelection.single(anchor,
      current === event ? anchor : view.posAtCoords({ x: current.clientX, y: current.clientY }) ?? anchor),
    update: () => false };
  }), EditorView.inputHandler.of((view, _from, _to, text) =>
    insertIntoFocusedEmptyCell(view, text) || replaceSelectedTableCells(view, text))];
}

function selectedCell(view: EditorView) {
  const position = view.state.selection.main.head;
  for (const table of view.state.field(localPreviewField, false)?.tables ?? []) {
    if (position < table.from || position > table.to) continue;
    for (const [rowIndex, row] of table.rows.entries())
      for (const [columnIndex, cell] of row.cells.entries())
        if (cell.from <= position && position <= cell.to)
          return { table, rowIndex, columnIndex };
  }
  return undefined;
}

function selectCell(view: EditorView, tableFrom: number, rowIndex: number, columnIndex: number) {
  clearEmptyFocus(view);
  const table = view.state.field(localPreviewField, false)?.tables.find((item) => item.from === tableFrom);
  const cell = table?.rows[rowIndex]?.cells[columnIndex];
  if (!cell) return false;
  const caret = !cell.raw && cell.contentTo > cell.contentFrom ? cell.contentFrom + 1 : cell.contentFrom;
  view.dispatch({ selection: { anchor: caret }, scrollIntoView: true });
  view.focus();
  return true;
}

function separator(align: string | null | undefined): string {
  return align === 'left' ? ':---' : align === 'center' ? ':---:' : align === 'right' ? '---:' : '---';
}

function serialize(rows: string[][], align: (string | null)[]): string {
  const renderRow = (cells: string[]) => `| ${cells.join(' | ')} |`;
  return [renderRow(rows[0]), renderRow(align.map(separator)), ...rows.slice(1).map(renderRow)].join('\n');
}

export function editTable(view: EditorView, action: TableAction, rowIndex: number, columnIndex: number, tableFrom?: number): boolean {
  const table = (view.state.field(localPreviewField, false)?.tables ?? [])
    .find((item) => item.from === tableFrom) ?? selectedCell(view)?.table;
  if (!table || !table.rows[rowIndex]?.cells[columnIndex]) return false;
  if (action === 'row-before' || action === 'row-after') {
    const at = Math.max(1, rowIndex + (action === 'row-after' ? 1 : 0));
    const row = `| ${Array(table.rows[0].cells.length).fill('').join(' | ')} |`;
    const end = at >= table.rows.length;
    const position = end ? table.to : table.rows[at].from;
    // Insert one row in the original source. Rebuilding the whole table here
    // would rewrite its existing padding and make unrelated cells look changed.
    view.dispatch({ changes: { from: position, insert: end ? `\n${row}` : `${row}\n` },
      annotations: isolateHistory.of('full') });
    return selectCell(view, table.from, at, columnIndex);
  }
  const rows = table.rows.map((row) => row.cells.map((cell) => cell.raw));
  const align = [...table.align];
  while (align.length < rows[0].length) align.push(null);
  let nextRow = rowIndex;
  let nextColumn = columnIndex;
  if (action === 'row-delete') {
    if (rowIndex === 0) return false;
    rows.splice(rowIndex, 1);
    nextRow = Math.min(rowIndex, rows.length - 1);
  } else if (action === 'column-before' || action === 'column-after') {
    const at = columnIndex + (action === 'column-after' ? 1 : 0);
    for (const row of rows) row.splice(at, 0, '');
    align.splice(at, 0, null);
    nextColumn = at;
  } else if (action === 'column-delete') {
    if (rows[0].length < 2) return false;
    for (const row of rows) row.splice(columnIndex, 1);
    align.splice(columnIndex, 1);
    nextColumn = Math.min(columnIndex, rows[0].length - 1);
  } else {
    align[columnIndex] = action === 'align-default' ? null : action.slice('align-'.length);
  }
  view.dispatch({ changes: { from: table.from, to: table.to, insert: serialize(rows, align) },
    annotations: isolateHistory.of('full') });
  selectCell(view, table.from, nextRow, nextColumn);
  return true;
}

export function nextTableCell(view: EditorView, backwards = false): boolean {
  const active = selectedCell(view);
  if (!active) return false;
  const { table, rowIndex, columnIndex } = active;
  const columns = table.rows[0].cells.length;
  let index = rowIndex * columns + columnIndex + (backwards ? -1 : 1);
  if (index < 0) index = 0;
  if (index >= table.rows.length * columns) {
    if (!editTable(view, 'row-after', rowIndex, columnIndex, table.from)) return false;
    return selectCell(view, table.from, rowIndex + 1, 0);
  }
  return selectCell(view, table.from, Math.floor(index / columns), index % columns);
}

const actions: { id: TableAction; label: string }[] = [
  { id: 'row-before', label: '在上方插入行' }, { id: 'row-after', label: '在下方插入行' },
  { id: 'row-delete', label: '删除当前行' },
  { id: 'column-before', label: '在左侧插入列' }, { id: 'column-after', label: '在右侧插入列' },
  { id: 'column-delete', label: '删除当前列' },
  { id: 'align-default', label: '默认对齐' }, { id: 'align-left', label: '左对齐' },
  { id: 'align-center', label: '居中' }, { id: 'align-right', label: '右对齐' },
];

/** The menu changes the same CodeMirror document as typing, so history and saving stay unified. */
export function tableContextMenu() {
  return ViewPlugin.fromClass(class {
    menu: HTMLElement | null = null;
    constructor(readonly view: EditorView) { view.dom.addEventListener('contextmenu', this.onContext, true); }
    close = () => { this.menu?.remove(); this.menu = null; document.removeEventListener('mousedown', this.onOutside); };
    onOutside = (event: MouseEvent) => { if (!this.menu?.contains(event.target as Node)) this.close(); };
    onContext = (event: MouseEvent) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('.md-table-cell');
      if (!target) { this.close(); return; }
      const rowIndex = Number(target.dataset.tableRow);
      const columnIndex = Number(target.dataset.tableColumn);
      const table = this.view.state.field(localPreviewField, false)?.tables.find((item) =>
        item.rows[rowIndex]?.cells[columnIndex]?.contentFrom !== undefined &&
        item.rows[rowIndex].cells[columnIndex].contentFrom <= this.view.posAtDOM(target) &&
        this.view.posAtDOM(target) <= item.rows[rowIndex].cells[columnIndex].to);
      if (!table) return;
      event.preventDefault();
      this.close();
      const menu = document.createElement('div');
      menu.className = 'md-table-context-menu';
      menu.setAttribute('role', 'menu');
      menu.style.left = `${event.clientX}px`;
      menu.style.top = `${event.clientY}px`;
      for (const action of actions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('role', 'menuitem');
        button.textContent = action.label;
        button.addEventListener('mousedown', (mouse) => mouse.preventDefault());
        button.addEventListener('click', () => { editTable(this.view, action.id, rowIndex, columnIndex, table.from); this.close(); });
        menu.append(button);
      }
      document.body.append(menu);
      this.menu = menu;
      document.addEventListener('mousedown', this.onOutside);
    };
    destroy() { this.view.dom.removeEventListener('contextmenu', this.onContext, true); this.close(); }
  });
}
