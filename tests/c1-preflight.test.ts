import { Compartment } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, expect, it } from 'vitest';
import { DocumentSession } from '../src/document/DocumentSession';
import { frontMatterCandidateEnd, frontMatterRange } from '../src/editor/frontMatter';
import { localPreviewField } from '../src/editor/localPreview';
import { revealOutlineItem } from '../src/ui/outlineScroll';

afterEach(() => document.body.replaceChildren());

it('recognizes only valid opening Hexo YAML and keeps its source boundaries', () => {
  const source = '---\ntitle: "Hexo: 标题"\ntags:\n  - 中文\ncustom_field: value\n---\n\n# 正文';
  const range = frontMatterRange(source);
  expect(range).toEqual({ from: 0, openerTo: 4, closerFrom: source.indexOf('\n---\n') + 1, to: source.lastIndexOf('---') + 3 });
  expect(frontMatterRange('---\ntitle: [\n---\n正文')).toBeNull();
  expect(frontMatterRange('---\ntitle: 未闭合')).toBeNull();
  expect(frontMatterRange('# 正文\n\n---\n\ntail')).toBeNull();
  expect(frontMatterRange('---\n普通正文\n---\n后续')).toBeNull();
  expect(frontMatterRange('```yaml\n---\ntitle: x\n---\n```')).toBeNull();
  expect(frontMatterCandidateEnd('---\ntitle: [\n---\n正文')).toBeGreaterThan(0);
});

it('edits YAML in one CodeMirror document without rewriting untouched fields or BOM/CRLF', () => {
  const source = '---\r\ntitle: "旧标题"\r\ntags:\r\n  - 中文\r\ncustom_field: value\r\n---\r\n\r\n# 正文\r\n';
  const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(source)]);
  const session = new DocumentSession(bytes);
  const host = document.createElement('div'); document.body.append(host);
  const appearance = new Compartment();
  const view = new EditorView({ doc: session.getSource(), parent: host, extensions: [appearance.of(localPreviewField)] });
  expect(view.dom.querySelectorAll('.md-preview-frontmatter')).toHaveLength(6);
  expect(view.dom.querySelector('.md-preview-frontmatter-key')?.textContent).toBe('title');
  expect([...view.dom.querySelectorAll('.md-preview-frontmatter-syntax')].map((node) => node.textContent)).toEqual([':', ':', '-', ':']);
  expect([...view.dom.querySelectorAll('.md-preview-frontmatter-delimiter')].map((node) => node.textContent)).toEqual(['---', '---']);
  expect(view.state.doc.toString()).toBe(source.replace(/\r\n/g, '\n'));
  expect(session.isDirty()).toBe(false);
  view.dispatch({ effects: appearance.reconfigure([]) });
  view.dispatch({ effects: appearance.reconfigure(localPreviewField) });
  expect(view.state.doc.toString()).toBe(source.replace(/\r\n/g, '\n'));
  const at = view.state.doc.toString().indexOf('旧标题');
  view.dispatch({ changes: { from: at, to: at + 3, insert: '新标题' } });
  session.setSource(view.state.doc.toString());
  expect(session.getSource()).toContain('tags:\n  - 中文\ncustom_field: value');
  expect(session.getSource()).toContain('title: "新标题"');
  expect([...session.toBytes()].slice(0, 3)).toEqual([0xef, 0xbb, 0xbf]);
  expect(new TextDecoder().decode(session.toBytes().slice(3))).toBe(session.getSource().replace(/\n/g, '\r\n'));
  view.destroy();
});

it('does not visually classify malformed YAML but keeps its blank source lines editable', () => {
  const source = '---\ntitle: [\n\n---\n\n正文';
  const host = document.createElement('div'); document.body.append(host);
  const view = new EditorView({ doc: source, parent: host, extensions: [localPreviewField] });
  expect(view.dom.querySelector('.md-preview-frontmatter')).toBeNull();
  expect(view.dom.querySelectorAll('.md-editable-empty-line').length).toBeGreaterThan(0);
  expect(view.state.doc.toString()).toBe(source);
  view.destroy();
});

it('reveals an outline item only outside the sidebar viewport', () => {
  const container = document.createElement('aside');
  const item = document.createElement('button');
  container.append(item);
  container.scrollTop = 100;
  container.getBoundingClientRect = () => ({ top: 20, bottom: 220 } as DOMRect);
  item.getBoundingClientRect = () => ({ top: 120, bottom: 145 } as DOMRect);
  expect(revealOutlineItem(container, item)).toBe(false);
  expect(container.scrollTop).toBe(100);
  item.getBoundingClientRect = () => ({ top: 250, bottom: 280 } as DOMRect);
  expect(revealOutlineItem(container, item)).toBe(true);
  expect(container.scrollTop).toBe(166);
  item.getBoundingClientRect = () => ({ top: -20, bottom: 5 } as DOMRect);
  expect(revealOutlineItem(container, item)).toBe(true);
  expect(container.scrollTop).toBe(120);
});
