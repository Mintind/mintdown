import { Compartment } from '@codemirror/state';
import { history, undo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { afterEach, expect, it } from 'vitest';
import { localPreviewField } from '../src/editor/localPreview';
import { editTable, nextTableCell, tableContextMenu } from '../src/editor/tableEditing';

afterEach(() => document.body.replaceChildren());

it('GFM 表格单元格直接编辑，视图不退化为整表管道符且撤销共享同一文档', () => {
  const source = '# 说明\n\n| 路径 | 用途 |\n| --- | --- |\n| `AGENTS.md` | **规则** |\n| `rules/` | *中文* |\n\n尾段';
  const host = document.createElement('div'); document.body.append(host);
  const mode = new Compartment();
  const view = new EditorView({ doc: source, parent: host, extensions: [history(), mode.of(localPreviewField)] });
  expect(view.dom.querySelectorAll('.md-table-row')).toHaveLength(3);
  expect(view.dom.querySelector('.md-table-row .md-preview-code')?.textContent).toBe('AGENTS.md');
  expect(view.dom.querySelector('.md-table-row .md-preview-strong')?.textContent).toBe('规则');
  expect(view.dom.querySelector('.md-table-row .md-preview-emphasis')?.textContent).toBe('中文');
  expect(view.dom.textContent).not.toContain('| --- |');
  const at = source.indexOf('规则');
  view.dispatch({ selection: { anchor: at }, changes: { from: at, to: at + 2, insert: '约定' } });
  expect(view.dom.querySelectorAll('.md-table-row')).toHaveLength(3);
  expect(view.state.doc.toString()).toContain('**约定**');
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe(source);
  view.dispatch({ effects: mode.reconfigure([]) });
  expect(view.dom.querySelector('.md-table-row')).toBeNull();
  expect(view.state.doc.toString()).toBe(source);
  view.dispatch({ effects: mode.reconfigure(localPreviewField) });
  expect(view.dom.querySelectorAll('.md-table-row')).toHaveLength(3);
  view.destroy();
});

it('单元格边缘刚输入的空格在光标处保持可见且不改变列归属', () => {
  const source = '| 左列 | 右列 |\n| --- | --- |\n| 中文Alpha | EnglishBeta |';
  const host = document.createElement('div'); document.body.append(host);
  const view = new EditorView({ doc: source, parent: host, extensions: [localPreviewField] });
  const cell = view.state.field(localPreviewField).tables[0].rows[1].cells[0];
  view.dispatch({ selection: { anchor: cell.contentTo } });
  view.dispatch({ changes: { from: cell.contentTo, insert: ' ' }, selection: { anchor: cell.contentTo + 1 } });
  expect(view.state.doc.toString()).toContain('| 中文Alpha  | EnglishBeta |');
  expect(view.dom.querySelectorAll('.md-table-row')[1]?.querySelector('.md-table-cell')?.textContent).toBe('中文Alpha ');
  const next = view.state.field(localPreviewField).tables[0].rows[1].cells[1];
  view.dispatch({ selection: { anchor: next.contentFrom } });
  expect(view.dom.querySelectorAll('.md-table-row')[1]?.querySelector('.md-table-cell')?.textContent).toBe('中文Alpha');
  expect(view.state.doc.toString()).toContain('| 中文Alpha  | EnglishBeta |');
  view.destroy();
});

it('表格 Tab 导航、末格追加行，行列与对齐操作保存为有效 GFM', () => {
  const source = '| 中文 | 链接 |\n| :--- | ---: |\n| `代码` | [站点](https://example.com) |';
  const host = document.createElement('div'); document.body.append(host);
  const view = new EditorView({ doc: source, parent: host, extensions: [history(), localPreviewField, tableContextMenu()] });
  expect(view.dom.querySelector('.md-table-row .md-preview-link')?.textContent).toBe('站点');
  view.dispatch({ selection: { anchor: source.indexOf('中文') } });
  expect(nextTableCell(view)).toBe(true);
  expect(view.state.selection.main.head).toBe(view.state.field(localPreviewField).tables[0].rows[0].cells[1].contentFrom);
  expect(nextTableCell(view, true)).toBe(true);
  expect(editTable(view, 'column-after', 0, 0, 0)).toBe(true);
  expect(view.state.field(localPreviewField).tables[0].rows[0].cells).toHaveLength(3);
  expect(editTable(view, 'align-center', 0, 1, 0)).toBe(true);
  expect(view.state.doc.toString()).toContain(':---:');
  expect(editTable(view, 'row-after', 1, 0, 0)).toBe(true);
  expect(view.state.field(localPreviewField).tables[0].rows).toHaveLength(3);
  expect(editTable(view, 'row-delete', 2, 0, 0)).toBe(true);
  expect(editTable(view, 'column-delete', 0, 1, 0)).toBe(true);
  expect(view.state.doc.toString()).toContain('`代码`');
  expect(view.state.doc.toString()).toContain('[站点](https://example.com)');
  const table = view.state.field(localPreviewField).tables[0];
  const last = table.rows.at(-1)!.cells.at(-1)!;
  view.dispatch({ selection: { anchor: last.contentFrom } });
  expect(nextTableCell(view)).toBe(true);
  expect(view.state.field(localPreviewField).tables[0].rows).toHaveLength(3);
  const reopened = new EditorView({ doc: view.state.doc.toString(), parent: host, extensions: [localPreviewField] });
  expect(reopened.state.field(localPreviewField).tables[0].rows).toHaveLength(3);
  expect(reopened.state.field(localPreviewField).tables[0].rows[1].cells[0].raw).toBe('`代码`');
  reopened.destroy();
  view.destroy();
});

it('表格结构操作可以撤销，转义管道符与中文内容在保存往返后不丢失', () => {
  const source = '| 项目 | 值 |\n| --- | --- |\n| 中文\\|标记 | `x` |';
  const host = document.createElement('div'); document.body.append(host);
  const view = new EditorView({ doc: source, parent: host, extensions: [history(), localPreviewField] });
  expect(view.state.field(localPreviewField).tables[0].rows[1].cells[0].raw).toBe('中文\\|标记');
  expect(editTable(view, 'row-after', 1, 0, 0)).toBe(true);
  expect(view.state.field(localPreviewField).tables[0].rows).toHaveLength(3);
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe(source);
  view.destroy();
});

it('分隔空行与真实空段落分类稳定，移动光标不改变源文档或行类名', () => {
  const source = '# 标题\n\n正文\n\n\n- 项目\n\n尾段';
  const host = document.createElement('div'); document.body.append(host);
  const view = new EditorView({ doc: source, parent: host, extensions: [localPreviewField] });
  const classes = () => [...view.dom.querySelectorAll('.cm-line')].map((line) => line.className);
  const before = classes();
  expect(view.dom.querySelectorAll('.md-structural-separator')).toHaveLength(3);
  expect(view.dom.querySelectorAll('.md-editable-empty-line')).toHaveLength(1);
  view.dispatch({ selection: { anchor: source.indexOf('\n\n') + 1 } });
  expect(classes()).toEqual(before);
  expect(view.state.doc.toString()).toBe(source);
  view.destroy();
  const spaced = new EditorView({ doc: '甲\n \n\n乙', parent: host, extensions: [localPreviewField] });
  expect(spaced.dom.querySelectorAll('.md-structural-separator')).toHaveLength(1);
  expect(spaced.dom.querySelectorAll('.md-editable-empty-line')).toHaveLength(1);
  spaced.destroy();
});

it('表格中的原始 HTML 只作为文本展示，编辑不会执行脚本', () => {
  const source = '开头\n\n| 值 |\n| --- |\n| <script>alert(1)</script> |\n\n结尾';
  const host = document.createElement('div'); document.body.append(host);
  const view = new EditorView({ doc: source, parent: host, extensions: [localPreviewField] });
  expect(view.dom.querySelector('.md-table-row')?.textContent).toContain('值');
  expect(view.dom.querySelectorAll('.md-table-row')[1]?.textContent).toContain('<script>alert(1)</script>');
  expect(view.dom.querySelector('script')).toBeNull();
  expect(view.state.doc.toString()).toBe(source);
  view.destroy();
});
