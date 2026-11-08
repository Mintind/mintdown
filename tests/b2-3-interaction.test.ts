import { Decoration, EditorView } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import { afterEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { localPreviewField } from '../src/editor/localPreview';
import { shiftTab, skipStructuralSeparators, tabAtCaret, visualBoundaryDelete, visualEnter } from '../src/editor/CanonicalEditor';
import { insertLinkTemplate, jumpToLinkDestination } from '../src/editor/linkEditing';
import { editTable, insertIntoFocusedEmptyCell, replaceSelectedTableCells } from '../src/editor/tableEditing';
import { focusEmptyTableCell, selectedTableRectangle, selectedTableText } from '../src/editor/tableSelection';

afterEach(() => document.body.replaceChildren());
function editor(source: string) {
  const host = document.createElement('div'); document.body.append(host);
  return new EditorView({ doc: source, parent: host, extensions: [history(), localPreviewField] });
}

it('可视模式跳过零高度结构分隔行，保留真实空段落及原始换行', () => {
  const source = '甲段\n\n乙段\n\n\n丙段';
  const host = document.createElement('div'); document.body.append(host);
  const view = new EditorView({ doc: source, parent: host,
    extensions: [history(), localPreviewField, skipStructuralSeparators] });
  const separator = view.state.doc.line(2);
  view.dispatch({ selection: { anchor: separator.from } });
  expect(view.state.selection.main.head).toBe(view.state.doc.line(3).from);
  view.dispatch({ selection: { anchor: source.length } });
  view.dispatch({ selection: { anchor: view.state.doc.line(4).from } });
  expect(view.state.selection.main.head).toBe(view.state.doc.line(3).to);
  const realEmpty = view.state.doc.line(5);
  view.dispatch({ selection: { anchor: realEmpty.from } });
  expect(view.state.selection.main.head).toBe(realEmpty.from);
  expect(view.dom.querySelectorAll('.md-editable-empty-line')).toHaveLength(1);
  expect(view.state.doc.toString()).toBe(source);
  expect(undo(view)).toBe(false);
  view.destroy();
});

it('闭合行内代码失焦显示样式，返回可编辑真实反引号，转义与多反引号保持原样', () => {
  const source = '前 `code` 后 ``a`b`` 和 \\`字面\\`';
  const view = editor(source);
  view.dispatch({ selection: { anchor: source.indexOf('后') } });
  expect(view.dom.querySelectorAll('.md-preview-code')).toHaveLength(2);
  expect(view.dom.textContent).toContain('code');
  expect(view.dom.textContent).not.toContain('`code`');
  view.dispatch({ selection: { anchor: source.indexOf('code') + 1 } });
  expect(view.dom.textContent).toContain('`code`');
  view.dispatch({ changes: { from: source.indexOf('`'), to: source.indexOf('`') + 1, insert: '' } });
  expect(view.state.doc.toString()).toContain('code`');
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe(source);
  view.destroy();
});

it('Tab 在正文与围栏代码的光标处插入四个可保存空格，链接占位优先跳转', () => {
  const view = editor('中文尾\n\n```js\nabcdef\n```');
  view.dispatch({ selection: { anchor: 2 } });
  expect(tabAtCaret(view)).toBe(true);
  expect(view.state.doc.toString()).toContain('中文    尾');
  const codeAt = view.state.doc.toString().indexOf('abcdef') + 3;
  view.dispatch({ selection: { anchor: codeAt } });
  expect(tabAtCaret(view)).toBe(true);
  expect(view.state.doc.toString()).toContain('abc    def');
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toContain('abcdef');
  const link = editor('文字');
  link.dispatch({ selection: { anchor: 2 } });
  expect(insertLinkTemplate(link)).toBe(true);
  expect(jumpToLinkDestination(link)).toBe(true);
  expect(link.state.doc.toString()).toBe('文字[]()');
  expect(link.state.selection.main.head).toBe(5);
  link.destroy(); view.destroy();
});

it('Enter 创建段落，Shift+Enter 为段内换行，连续空段落稳定且不产生 br 标签', () => {
  const view = editor('第一段第二段');
  view.dispatch({ selection: { anchor: 3 } });
  expect(visualEnter(view)).toBe(true);
  expect(view.state.doc.toString()).toBe('第一段\n\n第二段');
  expect(view.dom.querySelectorAll('.md-structural-separator')).toHaveLength(1);
  expect(visualEnter(view)).toBe(true);
  expect(view.state.doc.toString()).toBe('第一段\n\n\n第二段');
  expect(view.dom.querySelectorAll('.md-editable-empty-line')).toHaveLength(1);
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  expect(visualEnter(view, true)).toBe(true);
  expect(view.state.doc.toString()).toBe('第一段\n\n\n第二段\n');
  expect(view.state.doc.toString()).not.toContain('<br />');
  view.destroy();
});

it('普通段落边界 Backspace/Delete 合并两段，真实空段落和原始注释不被额外吞掉', () => {
  const view = editor('第一段\n\n第二段');
  view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('第二段') } });
  expect(visualBoundaryDelete(view, true)).toBe(true);
  expect(view.state.doc.toString()).toBe('第一段第二段');
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe('第一段\n\n第二段');
  view.dispatch({ selection: { anchor: '第一段'.length } });
  expect(visualBoundaryDelete(view, false)).toBe(true);
  expect(view.state.doc.toString()).toBe('第一段第二段');
  view.destroy();
  const blank = editor('第一段\n\n\n第二段');
  blank.dispatch({ selection: { anchor: blank.state.doc.toString().indexOf('第二段') } });
  expect(visualBoundaryDelete(blank, true)).toBe(false);
  blank.destroy();
  const raw = editor('第一段\n\n<!--more-->');
  raw.dispatch({ selection: { anchor: raw.state.doc.toString().indexOf('<!--more-->') } });
  expect(visualBoundaryDelete(raw, true)).toBe(false);
  raw.destroy();
});

it('表格 Tab 优先于空格缩进与已完成链接，Shift+Tab 返回前一单元格', () => {
  const source = '| 甲 | 乙 |\n| --- | --- |\n| [中文](https://example.com) | 后 |';
  const view = editor(source);
  view.dispatch({ selection: { anchor: source.indexOf('中文') } });
  expect(tabAtCaret(view)).toBe(true);
  const table = view.state.field(localPreviewField).tables[0];
  expect(view.state.selection.main.head).toBe(table.rows[1].cells[1].contentFrom);
  expect(shiftTab(view)).toBe(true);
  expect(view.state.selection.main.head).toBe(table.rows[1].cells[0].contentFrom);
  expect(view.state.doc.toString()).toBe(source);
  view.destroy();
});

it('新增表格行后空单元格有独立的可编辑源码位置', () => {
  const view = editor('| 甲 | 乙 |\n| --- | --- |\n| 一 | 二 |');
  const table = view.state.field(localPreviewField).tables[0];
  view.dispatch({ selection: { anchor: table.rows[1].cells[1].contentFrom } });
  expect(tabAtCaret(view)).toBe(true);
  const after = view.state.field(localPreviewField).tables[0];
  const empty = after.rows[2].cells[0];
  expect(view.state.selection.main.head).toBe(empty.contentFrom + 1);
  expect(empty.contentTo).toBeGreaterThan(empty.contentFrom);
  view.dispatch({ changes: { from: view.state.selection.main.head, insert: '中文' } });
  const typed = view.state.field(localPreviewField).tables[0];
  expect(typed.rows[2].cells[0].raw).toBe('中文');
  expect(view.state.doc.toString()).toContain('| 中文 |  |');
  view.destroy();
});

it('跨行跨列源码选区映射为矩形单元格并复制 TSV，改单元格与结构操作仍可撤销', () => {
  const source = '| 甲 | 乙 |\n| --- | --- |\n| 一 | 二 |\n| 三 | 四 |';
  const view = editor(source);
  const table = view.state.field(localPreviewField).tables[0];
  const rectangle = selectedTableRectangle(table, {
    anchor: table.rows[1].cells[0].contentTo,
    head: table.rows[2].cells[1].contentFrom,
  });
  expect(rectangle).toEqual({ top: 1, bottom: 2, left: 0, right: 1 });
  expect(selectedTableText(table, rectangle!)).toBe('一\t二\n三\t四');
  view.dispatch({ selection: { anchor: table.rows[1].cells[0].contentTo, head: table.rows[2].cells[1].contentFrom } });
  expect(view.dom.querySelectorAll('.md-table-selected-cell')).toHaveLength(4);
  expect(replaceSelectedTableCells(view, '')).toBe(true);
  const cleared = view.state.field(localPreviewField).tables[0];
  expect(cleared.rows.slice(1).flatMap((row) => row.cells.map((cell) => cell.raw))).toEqual(['', '', '', '']);
  expect(cleared.rows).toHaveLength(3);
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe(source);
  view.dispatch({ selection: { anchor: table.rows[1].cells[0].contentFrom } });
  expect(view.dom.querySelectorAll('.md-table-selected-cell')).toHaveLength(0);
  expect(editTable(view, 'row-after', 2, 0, table.from)).toBe(true);
  expect(view.state.field(localPreviewField).tables[0].rows).toHaveLength(4);
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe(source);
  view.destroy();
});

it('真实三列长表从 AST 到源码模型及 DOM 均保持列归属，插行不重排旧行', () => {
  const source = readFileSync('tests/fixtures/long-table-mintdown.md', 'utf8');
  const ast = unified().use(remarkParse).use(remarkGfm).parse(source);
  const node = ast.children[0];
  expect(node.type).toBe('table');
  expect('children' in node && node.children?.map((row) => 'children' in row ? row.children?.length : 0)).toEqual([3, 3, 3, 3]);
  const view = editor(source);
  const table = view.state.field(localPreviewField).tables[0];
  expect(table.rows.map((row) => row.cells.length)).toEqual([3, 3, 3, 3]);
  expect(table.rows[1].cells.map((cell) => cell.raw)).toEqual([
    '`unexpected_network_request`',
    '目标服务处理 PoC 后主动访问了受限制的内部测试服务，可信接收端记录到该连接',
    '连接是否来自目标服务、目标地址、正常策略及触发关联',
  ]);
  expect(table.rows[3].cells.map((cell) => cell.raw)).toEqual([
    '`trust_validation_bypass`（新增）',
    '目标客户端在明确要求校验证书的情况下，接受了不受信任的测试服务证书并继续建立受保护会话',
    '测试证书状态、实际握手行为、预期信任策略、有效证书对照',
  ]);
  expect([...view.dom.querySelectorAll('.md-table-row')].map((row) => row.querySelectorAll('.md-table-cell').length)).toEqual([3, 3, 3, 3]);
  expect(view.state.doc.toString()).toBe(source);
  expect(editTable(view, 'row-after', 3, 2, table.from)).toBe(true);
  expect(view.state.doc.toString()).toBe(`${source.trimEnd()}\n|  |  |  |\n`);
  const added = view.state.field(localPreviewField).tables[0].rows.at(-1)!;
  for (const [column, text] of ['新列一中文Alpha', '新列二English', '新列三中文Beta'].entries()) {
    const cell = view.state.field(localPreviewField).tables[0].rows.at(-1)!.cells[column];
    const at = cell.contentFrom + 1;
    view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length } });
  }
  expect(view.state.field(localPreviewField).tables[0].rows.at(-1)!.cells.map((cell) => cell.raw)).toEqual([
    '新列一中文Alpha', '新列二English', '新列三中文Beta',
  ]);
  expect(view.state.doc.toString()).toContain(source.trimEnd());
  expect(added.cells).toHaveLength(3);
  view.destroy();
});

it('零宽空单元格的首次输入按被点击的列写入，不落入邻列或下一行', () => {
  const source = '| A | B | C |\n|---|---|---|\n||||\n';
  for (const [column, text] of ['甲', '乙', '丙'].entries()) {
    const view = editor(source);
    const table = view.state.field(localPreviewField).tables[0];
    expect(table.rows[1].cells[column].contentFrom).toBe(table.rows[1].cells[column].contentTo);
    focusEmptyTableCell(view, { tableFrom: table.from, row: 1, column });
    expect(insertIntoFocusedEmptyCell(view, text)).toBe(true);
    expect(view.state.field(localPreviewField).tables[0].rows[1].cells.map((cell) => cell.raw))
      .toEqual(['甲', '乙', '丙'].map((value, index) => index === column ? value : ''));
    expect(view.state.doc.toString().split('\n')).toHaveLength(4);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(source);
    view.destroy();
  }
});

it('行内高亮装饰只能嵌套在单元格内，不得把一个 Grid 单元格拆成多列', () => {
  const source = readFileSync('tests/fixtures/long-table-mintdown.md', 'utf8');
  const host = document.createElement('div'); document.body.append(host);
  const from = source.indexOf('PoC');
  const inlineHighlight = Decoration.set([Decoration.mark({ class: 'test-inline-highlight' }).range(from, from + 3)]);
  const view = new EditorView({ doc: source, parent: host,
    extensions: [localPreviewField, EditorView.decorations.of(inlineHighlight)] });
  const row = view.dom.querySelectorAll('.md-table-row')[1];
  const cells = row.querySelectorAll(':scope > .md-table-cell');
  expect(cells).toHaveLength(3);
  expect(cells[1].textContent).toContain('目标服务处理 PoC 后');
  expect(cells[1].querySelector('.test-inline-highlight')?.textContent).toBe('PoC');
  expect(cells[2].textContent).toContain('连接是否来自目标服务');
  view.destroy();
});
