import { RangeSet, StateEffect, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view';
import { StateField } from '@codemirror/state';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { cachedPreviewImageUrl, imagePreviewFailure, imagePreviewGeneration, previewImageUrl, retryPreviewImageUrl } from './imagePreview';
import { focusEmptyTableCell, selectedTableRectangle } from './tableSelection';
import katex from 'katex';
import { frontMatterCandidateEnd, frontMatterRange, type FrontMatterRange } from './frontMatter';

export type InlineKind = 'strong' | 'emphasis' | 'delete' | 'inlineCode' | 'link';
export interface InlineSyntax {
  kind: InlineKind;
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
  url?: string;
}
interface BlockSyntax {
  kind: 'heading' | 'list' | 'quote' | 'code';
  from: number;
  to: number;
  prefixes: { from: number; to: number; label?: string }[];
  level?: number;
}
export interface ImageSyntax { kind: 'image'; from: number; to: number; url: string; alt: string }
interface MathSyntax { kind: 'math'; from: number; to: number; formula: string }
export interface TableCellSyntax { from: number; to: number; contentFrom: number; contentTo: number; raw: string }
export interface TableRowSyntax { from: number; to: number; cells: TableCellSyntax[] }
export interface TableSyntax {
  from: number; to: number; source: string; rows: TableRowSyntax[];
  align: (string | null)[]; separator: { from: number; to: number };
}
interface SyntaxModel { source: string; spans: InlineSyntax[]; blocks: BlockSyntax[]; images: ImageSyntax[]; math: MathSyntax[]; tables: TableSyntax[]; frontmatter: FrontMatterRange | null; frontmatterCandidateEnd: number }

/** Markdown's first blank separator between blocks is layout, not an editable empty paragraph. */
export function isStructuralSeparatorLine(model: SyntaxModel, from: number, to: number): boolean {
  const { source } = model;
  if (from < model.frontmatterCandidateEnd) return false;
  if (from === 0 || source.slice(from, to).trim() || !source.slice(0, from).trimEnd() || !source.slice(to).trimStart()) return false;
  if (model.blocks.some(block => block.kind === 'code' && block.from <= from && to <= block.to) ||
      model.tables.some(table => table.from <= from && to <= table.to)) return false;
  const previousLineFrom = source.lastIndexOf('\n', from - 2) + 1;
  return Boolean(source.slice(previousLineFrom, from - 1).trim());
}
type MdastNode = {
  type: string;
  url?: string;
  alt?: string;
  value?: string;
  depth?: number;
  align?: (string | null)[];
  children?: MdastNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml']).use(remarkMath);

function lineEnd(source: string, from: number): number {
  const newline = source.indexOf('\n', from);
  return newline < 0 ? source.length : newline;
}

function offsets(node: MdastNode): { from: number; to: number } | undefined {
  const from = node.position?.start.offset;
  const to = node.position?.end.offset;
  return from === undefined || to === undefined ? undefined : { from, to };
}

function escapedPipe(source: string, offset: number): boolean {
  let slashes = 0;
  while (offset - slashes - 1 >= 0 && source[offset - slashes - 1] === '\\') slashes++;
  return slashes % 2 === 1;
}

function tableSyntax(source: string, node: MdastNode, from: number, to: number): TableSyntax | undefined {
  const rows = node.children?.map((row): TableRowSyntax | undefined => {
    const bounds = offsets(row);
    if (!bounds) return undefined;
    const cells = row.children?.map((cell): TableCellSyntax | undefined => {
      const cellBounds = offsets(cell);
      if (!cellBounds) return undefined;
      let contentFrom = cellBounds.from;
      let contentTo = cellBounds.to;
      if (source[contentFrom] === '|') contentFrom++;
      if (contentTo > contentFrom && source[contentTo - 1] === '|' && !escapedPipe(source, contentTo - 1)) contentTo--;
      const innerFrom = contentFrom;
      const innerTo = contentTo;
      while (contentFrom < contentTo && /[ \t]/.test(source[contentFrom])) contentFrom++;
      while (contentTo > contentFrom && /[ \t]/.test(source[contentTo - 1])) contentTo--;
      const raw = source.slice(contentFrom, contentTo);
      // Keep existing whitespace as editable DOM in empty cells. Otherwise the
      // only caret position can coincide with the hidden pipe between cells.
      if (!raw && innerFrom < innerTo) { contentFrom = innerFrom; contentTo = innerTo; }
      return { ...cellBounds, contentFrom, contentTo, raw };
    });
    if (!cells?.length || cells.some((cell) => !cell)) return undefined;
    return { ...bounds, cells: cells as TableCellSyntax[] };
  });
  if (!rows?.length || rows.some((row) => !row)) return undefined;
  const headerEnd = lineEnd(source, from);
  const separatorFrom = headerEnd + 1;
  const separatorTo = lineEnd(source, separatorFrom);
  if (separatorFrom >= to || !/^\s*\|?\s*:?-+/.test(source.slice(separatorFrom, separatorTo))) return undefined;
  return { from, to, source: source.slice(from, to), rows: rows as TableRowSyntax[],
    align: node.align ?? [], separator: { from: separatorFrom, to: separatorTo } };
}

/** Offsets always refer to real characters in the current Markdown source. */
function analyzeMarkdown(source: string): SyntaxModel {
  const root = parser.parse(source) as MdastNode;
  const result: SyntaxModel = { source, spans: [], blocks: [], images: [], math: [], tables: [],
    frontmatter: frontMatterRange(source), frontmatterCandidateEnd: frontMatterCandidateEnd(source) };
  const visit = (node: MdastNode) => {
    const from = node.position?.start.offset;
    const to = node.position?.end.offset;
    if (from !== undefined && to !== undefined && to > from) {
      if (node.type === 'image' && node.url)
        result.images.push({ kind: 'image', from, to, url: node.url, alt: node.alt ?? '' });
      if (node.type === 'inlineMath' && source[from] === '$' && source[to - 1] === '$')
        result.math.push({ kind: 'math', from, to, formula: source.slice(from + 1, to - 1) });
      if (node.type === 'table') {
        const table = tableSyntax(source, node, from, to);
        if (table) result.tables.push(table);
      }
      if (node.type === 'heading') {
        const prefix = /^ {0,3}#{1,6}[ \t]+/.exec(source.slice(from, lineEnd(source, from)))?.[0];
        if (prefix) result.blocks.push({ kind: 'heading', from, to,
          prefixes: [{ from, to: from + prefix.length }], level: node.depth ?? 1 });
      }
      if (node.type === 'listItem') {
        const prefix = /^\s*(?:[-+*]|\d+[.)])[ \t]+/.exec(source.slice(from, lineEnd(source, from)))?.[0];
        if (prefix) result.blocks.push({ kind: 'list', from, to,
          prefixes: [{ from, to: from + prefix.length, label: /^\s*\d/.test(prefix) ? prefix.trim() : '•' }] });
      }
      if (node.type === 'blockquote') {
        const prefixes: BlockSyntax['prefixes'] = [];
        for (let line = from; line < to; line = lineEnd(source, line) + 1) {
          const prefix = /^ {0,3}>[ \t]?/.exec(source.slice(line, lineEnd(source, line)))?.[0];
          if (prefix) prefixes.push({ from: line, to: line + prefix.length });
          if (lineEnd(source, line) >= to) break;
        }
        if (prefixes.length) result.blocks.push({ kind: 'quote', from, to, prefixes });
      }
      if (node.type === 'code') {
        const firstEnd = lineEnd(source, from);
        const marker = /^ {0,3}(`{3,}|~{3,})/.exec(source.slice(from, firstEnd))?.[1];
        const lastStart = source.lastIndexOf('\n', to - 1) + 1;
        if (marker && lastStart > from && new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`).test(source.slice(lastStart, to)))
          result.blocks.push({ kind: 'code', from, to,
            prefixes: [{ from, to: firstEnd }, { from: lastStart, to }] });
      }
    }
    const kind = node.type as InlineKind;
    if (from !== undefined && to !== undefined && to > from &&
        ['strong', 'emphasis', 'delete', 'inlineCode', 'link'].includes(kind)) {
      let contentFrom: number | undefined;
      let contentTo: number | undefined;
      if (kind === 'inlineCode') {
        const opener = /^`+/.exec(source.slice(from, to))?.[0];
        if (opener) { contentFrom = from + opener.length; contentTo = to - opener.length; }
      } else if (node.children?.length) {
        contentFrom = node.children[0].position?.start.offset;
        contentTo = node.children.at(-1)?.position?.end.offset;
      }
      if (kind === 'link' && source[from] !== '[') contentFrom = undefined;
      if (contentFrom !== undefined && contentTo !== undefined &&
          contentFrom >= from && contentTo <= to && contentFrom <= contentTo &&
          (contentFrom > from || contentTo < to))
        result.spans.push({ kind, from, to, contentFrom, contentTo, url: node.url });
    }
    node.children?.forEach(visit);
  };
  visit(root);
  result.spans.sort((a, b) => a.from - b.from || b.to - a.to);
  result.blocks.sort((a, b) => a.from - b.from || b.to - a.to);
  return result;
}

export function inlineSyntax(source: string): InlineSyntax[] { return analyzeMarkdown(source).spans; }

function containsSelection(span: { from: number; to: number }, view: { from: number; to: number }): boolean {
  return view.from === view.to
    ? span.from <= view.from && view.from <= span.to
    : span.from < view.to && span.to > view.from;
}

interface PreviewState extends SyntaxModel { decorations: DecorationSet; outer: DecorationSet; atomic: DecorationSet; composing: boolean; lastHead: number; dismissedImageFrom: number | null }
const composingEffect = StateEffect.define<boolean>();
export const refreshImagePreviews = StateEffect.define<null>();
const dismissImageEdit = StateEffect.define<number | null>();
const pendingImageSize = new Map<number, { width: number; height: number }>();
const loadedImageSize = new Map<string, { width: number; height: number }>();

class TextWidget extends WidgetType {
  constructor(readonly text: string, readonly className: string) { super(); }
  eq(other: TextWidget) { return this.text === other.text && this.className === other.className; }
  toDOM() { const span = document.createElement('span'); span.className = this.className; span.textContent = this.text; return span; }
}

class ImageWidget extends WidgetType {
  readonly generation = imagePreviewGeneration();
  constructor(readonly image: ImageSyntax, readonly block = false) { super(); }
  eq(other: ImageWidget) { return this.generation === other.generation && this.image.url === other.image.url && this.image.alt === other.image.alt && this.image.from === other.image.from && this.block === other.block; }
  toDOM() {
    const shell = document.createElement('span');
    shell.className = `md-image-shell${this.block ? ' md-image-block' : ''}`;
    shell.dataset.markdownImageFrom = String(this.image.from);
    shell.title = this.image.url;
    const image = document.createElement('img');
    image.className = 'md-preview-image';
    image.alt = '';
    const cacheKey = `${this.generation}\0${this.image.url}`;
    const cachedSize = loadedImageSize.get(cacheKey);
    const cachedUrl = cachedPreviewImageUrl(this.image.url);
    if (cachedSize && cachedUrl) {
      shell.style.width = `${cachedSize.width}px`;
      shell.style.height = `${cachedSize.height}px`;
      shell.style.overflow = 'hidden';
      shell.classList.add('loaded');
    }
    image.onload = () => {
      shell.classList.add('loaded'); shell.classList.remove('missing');
      shell.style.removeProperty('width'); shell.style.removeProperty('height'); shell.style.removeProperty('overflow');
      const bounds = shell.getBoundingClientRect();
      loadedImageSize.set(cacheKey, { width: bounds.width, height: bounds.height });
      if (loadedImageSize.size > 128) loadedImageSize.delete(loadedImageSize.keys().next().value!);
    };
    let retried = false;
    image.onerror = () => {
      if (this.generation !== imagePreviewGeneration()) return;
      if (/^https?:\/\//i.test(this.image.url)) {
        image.removeAttribute('src'); label.textContent = '图片无法显示';
        shell.classList.add('missing'); shell.classList.remove('loaded');
        return;
      }
      if (!retried) {
        retried = true;
        void retryPreviewImageUrl(this.image.url).then((url) => { if (shell.isConnected) image.src = url; },
          (cause) => { label.textContent = imagePreviewFailure(cause); shell.classList.add('missing'); shell.classList.remove('loaded'); });
        return;
      }
      const failedUrl = image.src;
      void (async () => {
        let reason = '图片预览失败';
        try {
          const blob = await fetch(failedUrl).then((response) => response.blob());
          if (typeof createImageBitmap === 'function') {
            try { await createImageBitmap(blob).then((bitmap) => bitmap.close()); }
            catch { reason = '图片无法解码'; }
          }
        } catch { /* Unavailable Blob URL is a preview failure, not evidence of corrupt bytes. */ }
        if (!shell.isConnected) return;
        image.removeAttribute('src'); label.textContent = reason;
        shell.classList.add('missing'); shell.classList.remove('loaded');
      })();
    };
    const placeholder = document.createElement('span');
    placeholder.className = 'md-image-placeholder';
    const icon = document.createElement('span'); icon.className = 'md-image-icon'; icon.textContent = '▧'; icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span'); label.className = 'md-image-missing-label'; label.textContent = '正在加载图片';
    const filename = document.createElement('span'); filename.className = 'md-image-filename';
    try { filename.textContent = decodeURIComponent(this.image.url.split(/[\\/]/).pop() || this.image.url); }
    catch { filename.textContent = this.image.url.split(/[\\/]/).pop() || this.image.url; }
    filename.title = this.image.url;
    const relocate = document.createElement('button');
    relocate.className = 'md-image-relocate'; relocate.type = 'button'; relocate.textContent = '重新定位';
    relocate.addEventListener('mousedown', (event) => { event.preventDefault(); event.stopPropagation(); });
    relocate.addEventListener('click', (event) => {
      event.preventDefault(); event.stopPropagation();
      shell.dispatchEvent(new CustomEvent<ImageSyntax>('md-image-relocate', { bubbles: true, detail: this.image }));
    });
    placeholder.append(icon, label, filename, relocate);
    shell.append(image, placeholder);
    if (cachedUrl) image.src = cachedUrl;
    else void previewImageUrl(this.image.url).then((url) => { if (shell.isConnected) image.src = url; },
      (cause) => { label.textContent = imagePreviewFailure(cause); shell.classList.add('missing'); });
    return shell;
  }
}

function imageExitPosition(view: EditorView, from: number, to: number): number {
  const images = view.state.field(localPreviewField, false)?.images ?? [];
  const source = view.state.doc.toString();
  let next = Math.min(source.length, to + 1);
  while (next < source.length) {
    const covering = images.find((image) => image.from <= next && next <= image.to);
    if (covering) { next = covering.to + 1; continue; }
    if (/\s/.test(source[next])) { next++; continue; }
    return next;
  }
  let previous = from - 1;
  while (previous >= 0) {
    const covering = images.find((image) => image.from <= previous && previous <= image.to);
    if (covering) { previous = covering.from - 1; continue; }
    if (/\s/.test(source[previous])) { previous--; continue; }
    return previous + 1;
  }
  return source.length;
}

class ImageEditWidget extends WidgetType {
  readonly generation = imagePreviewGeneration();
  constructor(readonly image: ImageSyntax, readonly raw: string, readonly block = false) { super(); }
  eq(other: ImageEditWidget) { return this.generation === other.generation && this.image.from === other.image.from && this.raw === other.raw && this.block === other.block; }
  toDOM(view: EditorView) {
    const frame = document.createElement('span');
    frame.className = `md-image-edit-frame${this.block ? ' md-image-edit-block' : ''}`;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'md-image-edit-input';
    input.dataset.imageFrom = String(this.image.from);
    input.setAttribute('aria-label', '图片 Markdown 源码');
    input.value = this.raw;
    const finish = (focusEditor: boolean) => {
      const current = view.state.doc.sliceString(this.image.from, this.image.to);
      if (current !== this.raw) return;
      const next = input.value;
      if (next !== this.raw) {
        view.dispatch({ changes: { from: this.image.from, to: this.image.to, insert: next }, effects: dismissImageEdit.of(this.image.from),
          selection: { anchor: this.image.from + next.length } });
      } else if (focusEditor) {
        view.dispatch({ selection: { anchor: imageExitPosition(view, this.image.from, this.image.to) },
          effects: dismissImageEdit.of(this.image.from) });
      }
      if (focusEditor) view.focus();
      else setTimeout(() => {
        // Blur can precede a whole-source replacement or a tab teardown. This
        // callback belongs to that image, not to a later document at its offset.
        if (!view.dom.isConnected || view.state.doc.sliceString(this.image.from, this.image.from + next.length) !== next) return;
        const head = view.state.selection.main.head;
        if (head >= this.image.from && head <= this.image.from + next.length)
        view.dispatch({ selection: { anchor: imageExitPosition(view, this.image.from, this.image.from + next.length) },
          effects: dismissImageEdit.of(this.image.from) });
      }, 0);
    };
    input.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); finish(true); }
      else if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); input.value = this.raw;
        view.dispatch({ selection: { anchor: imageExitPosition(view, this.image.from, this.image.to) },
          effects: dismissImageEdit.of(this.image.from) });
        view.focus();
      }
    });
    input.addEventListener('blur', () => { if (input.isConnected) finish(false); });
    input.addEventListener('mousedown', (event) => event.stopPropagation());
    const shell = new ImageWidget(this.image, this.block).toDOM();
    const size = pendingImageSize.get(this.image.from);
    if (size) {
      pendingImageSize.delete(this.image.from);
      shell.style.width = `${size.width}px`;
      shell.style.height = `${size.height}px`;
      shell.style.overflow = 'hidden';
      shell.querySelector('img')?.addEventListener('load', () => {
        shell.style.removeProperty('width'); shell.style.removeProperty('height'); shell.style.removeProperty('overflow');
      }, { once: true });
    }
    frame.append(input, shell);
    return frame;
  }
  ignoreEvent(event: Event) { return event.target instanceof HTMLInputElement; }
}

class CodeCopyWidget extends WidgetType {
  constructor(readonly source: string) { super(); }
  eq(other: CodeCopyWidget) { return this.source === other.source; }
  toDOM() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'md-preview-code-copy';
    button.textContent = '复制代码';
    button.title = '复制此代码块';
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
      event.preventDefault(); event.stopPropagation();
      void navigator.clipboard.writeText(this.source).then(() => { button.textContent = '已复制'; },
        () => { button.textContent = '复制失败'; });
    });
    return button;
  }
}

class MathWidget extends WidgetType {
  constructor(readonly formula: string) { super(); }
  eq(other: MathWidget) { return this.formula === other.formula; }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'md-preview-math';
    try { katex.render(this.formula, span, { throwOnError: false, trust: false }); }
    catch { span.textContent = `$${this.formula}$`; }
    return span;
  }
}

class EmptyTableCellWidget extends WidgetType {
  constructor(readonly position: number, readonly tableFrom: number, readonly row: number, readonly column: number, readonly selected: boolean) { super(); }
  eq(other: EmptyTableCellWidget) { return this.position === other.position && this.tableFrom === other.tableFrom && this.row === other.row && this.column === other.column && this.selected === other.selected; }
  toDOM(view: EditorView) {
    const cell = document.createElement('span');
    cell.className = `md-table-cell md-table-empty-cell${this.selected ? ' md-table-selected-cell' : ''}`;
    cell.dataset.tableRow = String(this.row);
    cell.dataset.tableColumn = String(this.column);
    cell.dataset.tableFrom = String(this.tableFrom);
    cell.dataset.tableEmpty = 'true';
    cell.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      view.dom.querySelector('.md-table-focused-empty')?.classList.remove('md-table-focused-empty');
      cell.classList.add('md-table-focused-empty');
      focusEmptyTableCell(view, { tableFrom: this.tableFrom, row: this.row, column: this.column });
      view.dispatch({ selection: { anchor: this.position } });
      view.focus();
    });
    return cell;
  }
}

function decorate(model: SyntaxModel, selection: { ranges: readonly { from: number; to: number; anchor: number; head: number }[]; main: { head: number } }, previousHead?: number, dismissedImageFrom: number | null = null): PreviewState {
  const visual: Range<Decoration>[] = [];
  const outer: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  const head = selection.main.head;
  const direction = previousHead === undefined ? 0 : Math.sign(head - previousHead);
  const inlineStarts = new Set(model.spans.map((span) => span.from));
  const inlineEnds = new Set(model.spans.map((span) => span.to));
  if (model.frontmatter) {
    const meta = model.frontmatter;
    for (let from = meta.from; from <= meta.to;) {
      const to = lineEnd(model.source, from);
      const delimiter = from === meta.from || from === meta.closerFrom;
      visual.push(Decoration.line({ class: `md-preview-frontmatter${delimiter ? ' md-preview-frontmatter-delimiter' : ''}${from === meta.from ? ' md-preview-frontmatter-first' : ''}${from === meta.closerFrom ? ' md-preview-frontmatter-last' : ''}` }).range(from));
      if (!delimiter) {
        const line = model.source.slice(from, to);
        const list = /^(\s*)-(?=\s)/.exec(line);
        if (list) {
          const markerFrom = from + list[1].length;
          visual.push(Decoration.mark({ class: 'md-preview-frontmatter-syntax' }).range(markerFrom, markerFrom + 1));
        }
        const field = /^(\s*(?:-\s+)?)([^:#][^:]*?)(\s*:)(?=\s|$)/.exec(line);
        if (field) {
          const keyFrom = from + field[1].length;
          visual.push(Decoration.mark({ class: 'md-preview-frontmatter-key' }).range(keyFrom, keyFrom + field[2].length));
          const colonFrom = from + field[0].length - 1;
          visual.push(Decoration.mark({ class: 'md-preview-frontmatter-syntax' }).range(colonFrom, colonFrom + 1));
          const valueFrom = from + field[0].length;
          if (valueFrom < to) visual.push(Decoration.mark({ class: 'md-preview-frontmatter-value' }).range(valueFrom, to));
        }
      }
      if (to >= meta.to) break;
      from = to + 1;
    }
  }
  for (const span of model.spans) {
    const active = selection.ranges.some((range) => {
      if (!containsSelection(span, range)) return false;
      if (range.from !== range.to) return true;
      // Two adjacent constructs share one caret position. Keep the construct
      // entered from the direction of travel, so neither boundary oscillates.
      if (range.head === span.from && direction < 0 && inlineEnds.has(span.from)) return false;
      if (range.head === span.to && direction > 0 && inlineStarts.has(span.to)) return false;
      return true;
    });
    if (active) continue;
    for (const [from, to] of [[span.from, span.contentFrom], [span.contentTo, span.to]]) {
      if (from >= to) continue;
      const hidden = Decoration.replace({}).range(from, to);
      visual.push(hidden);
      atomic.push(hidden);
    }
    if (span.contentFrom < span.contentTo) {
      const className = span.kind === 'inlineCode' ? 'md-preview-code' : `md-preview-${span.kind}`;
      visual.push(Decoration.mark({ class: className }).range(span.contentFrom, span.contentTo));
    }
  }
  for (const block of model.blocks) {
    const active = selection.ranges.some((range) => containsSelection(block, range));
    if (block.kind === 'heading') {
      visual.push(Decoration.line({ class: `md-preview-heading md-preview-h${block.level}` }).range(block.from));
    }
    if (block.kind === 'quote') for (const prefix of block.prefixes)
      visual.push(Decoration.line({ class: 'md-preview-quote' }).range(prefix.from));
    if (block.kind === 'list') visual.push(Decoration.line({ class: 'md-preview-list' }).range(block.from));
    if (block.kind === 'code') {
      for (let line = block.from; line < block.to; line = lineEnd(model.source, line) + 1) {
        visual.push(Decoration.line({ class: 'md-preview-code-line' }).range(line));
        if (block.prefixes.some((prefix) => prefix.from === line))
          visual.push(Decoration.line({ class: 'md-preview-code-fence-line' }).range(line));
        if (lineEnd(model.source, line) >= block.to) break;
      }
      if (block.prefixes.length === 2) {
        const bodyFrom = lineEnd(model.source, block.prefixes[0].from) + 1;
        const bodyTo = block.prefixes[1].from;
        visual.push(Decoration.widget({ widget: new CodeCopyWidget(model.source.slice(bodyFrom, bodyTo).replace(/\n$/, '')), side: -1 }).range(bodyFrom));
      }
    }
    // Keep fenced-code delimiters in the document flow even when the caret is
    // outside the block. Revealing a collapsed fence during mousedown moves
    // the code line under the pointer before CodeMirror resolves the selection.
    if (active || block.kind === 'code') continue;
    for (const prefix of block.prefixes) {
      const widget = block.kind === 'list' ? new TextWidget(prefix.label ?? '•', 'md-preview-bullet') : undefined;
      const hidden = Decoration.replace(widget ? { widget } : {}).range(prefix.from, prefix.to);
      visual.push(hidden); atomic.push(hidden);
    }
  }
  for (const image of model.images) {
    const lineStart = model.source.lastIndexOf('\n', image.from - 1) + 1;
    const nextBreak = model.source.indexOf('\n', image.to);
    const lineEnd = nextBreak < 0 ? model.source.length : nextBreak;
    const block = model.source.slice(lineStart, lineEnd).trim() === model.source.slice(image.from, image.to).trim();
    if (image.from !== dismissedImageFrom && selection.ranges.some((range) => containsSelection(image, range))) {
      const raw = model.source.slice(image.from, image.to);
      if (raw.includes('\n')) {
        visual.push(Decoration.widget({ widget: new ImageWidget(image, block), side: -1 }).range(image.from));
        visual.push(Decoration.mark({ class: 'md-image-source-editor' }).range(image.from, image.to));
      } else {
        visual.push(Decoration.replace({ widget: new ImageEditWidget(image, raw, block) }).range(image.from, image.to));
      }
    } else {
      const hidden = Decoration.replace({ widget: new ImageWidget(image, block) }).range(image.from, image.to);
      visual.push(hidden); atomic.push(hidden);
    }
  }
  for (const math of model.math) {
    if (selection.ranges.some((range) => containsSelection(math, range))) continue;
    const hidden = Decoration.replace({ widget: new MathWidget(math.formula) }).range(math.from, math.to);
    visual.push(hidden); atomic.push(hidden);
  }
  for (const table of model.tables) {
    const columns = table.rows[0]?.cells.length ?? 0;
    const rectangle = selection.ranges.map((range) => selectedTableRectangle(table, range)).find(Boolean);
    for (const [rowIndex, row] of table.rows.entries()) {
      visual.push(Decoration.line({ class: `md-table-row${rowIndex ? '' : ' md-table-header md-table-first-row'}${rowIndex === table.rows.length - 1 ? ' md-table-last-row' : ''}`,
        attributes: { style: `--md-table-columns:${columns}` } }).range(row.from));
      for (const [columnIndex, cell] of row.cells.entries()) {
        const selected = rectangle && rectangle.top <= rowIndex && rowIndex <= rectangle.bottom &&
          rectangle.left <= columnIndex && columnIndex <= rectangle.right;
        // GFM trims delimiter padding from cell contents. A just-typed space at
        // the content edge must remain visible while the caret is in it;
        // otherwise the hidden range moves the DOM selection to the next cell.
        let visibleFrom = cell.contentFrom;
        let visibleTo = cell.contentTo;
        for (const range of selection.ranges) {
          if (range.from !== range.to || range.head < cell.from || range.head > cell.to) continue;
          if (range.head < visibleFrom && /^\s*$/.test(model.source.slice(range.head, visibleFrom)))
            visibleFrom = range.head;
          if (range.head > visibleTo && /^\s*$/.test(model.source.slice(visibleTo, range.head)))
            visibleTo = range.head;
        }
        for (const [from, to] of [[cell.from, visibleFrom], [visibleTo, cell.to]]) {
          if (from >= to) continue;
          const hidden = Decoration.replace({}).range(from, to);
          visual.push(hidden); atomic.push(hidden);
        }
        if (visibleFrom < visibleTo)
          outer.push(Decoration.mark({ class: `md-table-cell${selected ? ' md-table-selected-cell' : ''}`, attributes: {
            'data-table-row': String(rowIndex), 'data-table-column': String(columnIndex),
            'data-table-align': table.align[columnIndex] ?? '', 'data-table-from': String(table.from),
            'data-table-empty': cell.raw ? 'false' : 'true',
          } }).range(visibleFrom, visibleTo));
        else visual.push(Decoration.widget({ widget: new EmptyTableCellWidget(cell.contentFrom, table.from, rowIndex, columnIndex, Boolean(selected)) }).range(cell.contentFrom));
      }
    }
    visual.push(Decoration.line({ class: 'md-table-separator' }).range(table.separator.from));
    if (table.separator.from < table.separator.to) {
      const hidden = Decoration.replace({}).range(table.separator.from, table.separator.to);
      visual.push(hidden); atomic.push(hidden);
    }
  }
  const multilineBlocks = [
    ...model.blocks.filter((block) => block.kind === 'code'), ...model.tables,
  ].sort((a, b) => a.from - b.from);
  let blockIndex = 0;
  for (let from = 0; from <= model.source.length;) {
    const to = lineEnd(model.source, from);
    while (blockIndex < multilineBlocks.length && multilineBlocks[blockIndex].to < from) blockIndex++;
    const block = multilineBlocks[blockIndex];
    if (!model.source.slice(from, to).trim() && !(block && block.from <= from && to <= block.to)) {
      visual.push(Decoration.line({ class: isStructuralSeparatorLine(model, from, to)
        ? 'md-structural-separator' : 'md-editable-empty-line' }).range(from));
    }
    if (to === model.source.length) break;
    from = to + 1;
  }
  return { ...model, decorations: RangeSet.of(visual, true), outer: RangeSet.of(outer, true),
    atomic: RangeSet.of(atomic, true), composing: false, lastHead: head, dismissedImageFrom };
}

export const localPreviewField = StateField.define<PreviewState>({
  create: (state) => decorate(analyzeMarkdown(state.doc.toString()), state.selection),
  update: (value, transaction) => {
    if (transaction.effects.some((effect) => effect.is(refreshImagePreviews)))
      return decorate(analyzeMarkdown(transaction.state.doc.toString()), transaction.state.selection, value.lastHead, value.dismissedImageFrom);
    const imageVisibility = transaction.effects.find((effect) => effect.is(dismissImageEdit));
    const dismissedImageFrom = imageVisibility ? imageVisibility.value : transaction.docChanged ||
      !transaction.state.selection.eq(transaction.startState.selection) ? null : value.dismissedImageFrom;
    const composition = transaction.effects.find((effect) => effect.is(composingEffect));
    if (composition?.value === false) return decorate(analyzeMarkdown(transaction.state.doc.toString()), transaction.state.selection, value.lastHead, dismissedImageFrom);
    if (value.composing || composition?.value === true) return { ...value, composing: true,
      decorations: transaction.docChanged ? value.decorations.map(transaction.changes) : value.decorations,
      outer: transaction.docChanged ? value.outer.map(transaction.changes) : value.outer,
      atomic: transaction.docChanged ? value.atomic.map(transaction.changes) : value.atomic };
    if (!transaction.docChanged && transaction.state.selection.eq(transaction.startState.selection) && !imageVisibility) return value;
    const model = transaction.docChanged ? analyzeMarkdown(transaction.state.doc.toString()) : value;
    return decorate(model, transaction.state.selection, value.lastHead, dismissedImageFrom);
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.outerDecorations.from(field, (value) => value.outer),
    EditorView.atomicRanges.of((view) => view.state.field(field).atomic),
  ],
});

export function localPreviewComposition() {
  return EditorView.domEventHandlers({
    compositionstart: (_event, view) => { view.dispatch({ effects: composingEffect.of(true) }); return false; },
    compositionend: (_event, view) => { view.dispatch({ effects: composingEffect.of(false) }); return false; },
  });
}

export function selectFocusedCodeBlock(view: EditorView): boolean {
  const head = view.state.selection.main.head;
  const block = view.state.field(localPreviewField, false)?.blocks.find((item) =>
    item.kind === 'code' && item.from <= head && head <= item.to && item.prefixes.length === 2);
  if (!block) return false;
  const from = view.state.doc.lineAt(block.prefixes[0].from).to + 1;
  const to = block.prefixes[1].from > from ? block.prefixes[1].from - 1 : from;
  view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
  return true;
}

export function linkAtPosition(view: EditorView, position: number): InlineSyntax | undefined {
  return (view.state.field(localPreviewField, false)?.spans ?? inlineSyntax(view.state.doc.toString()))
    .filter((span) => span.kind === 'link' && span.from <= position && position <= span.to)
    .sort((a, b) => (a.to - a.from) - (b.to - b.from))[0];
}

export function safeExternalUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined;
  } catch { return undefined; }
}

export function localPreviewLinks(openExternal: (url: string) => void, onRelocate?: (image: ImageSyntax) => void) {
  return ViewPlugin.fromClass(class {
    constructor(readonly view: EditorView) {
      view.dom.addEventListener('mousedown', this.mousedown, true);
      view.dom.addEventListener('md-image-relocate', this.relocate);
    }
    relocate = (event: Event) => { if (event instanceof CustomEvent) onRelocate?.(event.detail as ImageSyntax); };
    mousedown = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('.md-image-relocate')) return;
      const imageFrom = target.closest<HTMLElement>('[data-markdown-image-from]')?.dataset.markdownImageFrom;
      if (imageFrom !== undefined && !event.ctrlKey) {
        event.preventDefault();
        event.stopPropagation();
        const shell = target.closest<HTMLElement>('[data-markdown-image-from]');
        if (shell) {
          const bounds = shell.getBoundingClientRect();
          pendingImageSize.set(Number(imageFrom), { width: bounds.width, height: bounds.height });
        }
        this.view.dispatch({ selection: { anchor: Number(imageFrom) + 2 }, effects: dismissImageEdit.of(null) });
        const editor = this.view.dom.querySelector<HTMLInputElement>(`.md-image-edit-input[data-image-from="${imageFrom}"]`);
        if (editor) {
          const frame = editor.closest<HTMLElement>('.md-image-edit-frame');
          const scrollArea = (this.view.dom.closest('.editor-scroll') ?? this.view.scrollDOM).getBoundingClientRect();
          if (frame) {
            const bounds = frame.getBoundingClientRect();
            editor.classList.toggle('md-image-edit-below', bounds.top - scrollArea.top < 38);
            editor.style.width = `${Math.max(180, Math.min(720, scrollArea.right - bounds.left - 12))}px`;
          }
          editor.focus({ preventScroll: true });
        } else this.view.contentDOM.focus({ preventScroll: true });
        return;
      }
      if (event.button !== 0 || !event.ctrlKey) return;
      const at = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
      const link = at === null ? undefined : linkAtPosition(this.view, at);
      const url = safeExternalUrl(link?.url);
      if (!url) return;
      event.preventDefault();
      event.stopPropagation();
      openExternal(url);
    };
    destroy() {
      this.view.dom.removeEventListener('mousedown', this.mousedown, true);
      this.view.dom.removeEventListener('md-image-relocate', this.relocate);
    }
  });
}
