import { useLayoutEffect, useRef } from 'react';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { indentUnit, syntaxHighlighting } from '@codemirror/language';
import { indentLess, indentMore } from '@codemirror/commands';
import { keymap } from '@codemirror/view';
import { search } from '@codemirror/search';
import { isStructuralSeparatorLine, localPreviewComposition, localPreviewField, localPreviewLinks, refreshImagePreviews, selectFocusedCodeBlock, type ImageSyntax } from './localPreview';
import { jumpToLinkDestination } from './linkEditing';
import { visualSourceSearchField } from './visualSourceSearch';
import { canonicalSpelling } from './canonicalSpelling';
import { canonicalHighlight } from './canonicalHighlight';
import { imagePreviewGeneration, setPreviewAssetContext } from './imagePreview';
import type { ImageReferenceStyle } from '../assets/imagePaths';
import { nextTableCell, replaceSelectedTableCells, tableContextMenu, tableSelectionClipboard } from './tableEditing';
import { markdownHighlight } from './markdownHighlight';
import { SourceSyntaxMonitor, type RenderTier } from './performancePolicy';
import { sourceStructure } from './sourceStructure';
import type { SessionPosition } from '../native/sessionBridge';

export function tabAtCaret(view: EditorView): boolean {
  if (view.composing) return false;
  if (nextTableCell(view)) return true;
  const range = view.state.selection.main;
  if (!range.empty && view.state.doc.lineAt(range.from).number !== view.state.doc.lineAt(range.to).number)
    return indentMore(view);
  view.dispatch({ changes: { from: range.from, to: range.to, insert: '    ' },
    selection: { anchor: range.from + 4 } });
  return true;
}

export function shiftTab(view: EditorView): boolean {
  if (view.composing) return false;
  if (nextTableCell(view, true)) return true;
  if (!view.state.selection.main.empty) return indentLess(view);
  const model = view.state.field(localPreviewField, false);
  const head = view.state.selection.main.head;
  if (model?.blocks.some((item) => item.kind === 'code' && item.from <= head && head <= item.to))
    return indentLess(view);
  return true;
}

export function visualEnter(view: EditorView, soft = false): boolean {
  if (view.composing || !view.state.field(localPreviewField, false)) return false;
  const range = view.state.selection.main;
  const head = range.head;
  const model = view.state.field(localPreviewField);
  if (model.tables.some((table) => table.from <= head && head <= table.to) ||
      model.blocks.some((block) => ['code', 'list', 'quote'].includes(block.kind) && block.from <= head && head <= block.to))
    return false;
  const line = view.state.doc.lineAt(head);
  const afterSeparator = head === line.from && line.from >= 2 &&
    view.state.doc.sliceString(line.from - 2, line.from) === '\n\n';
  const insert = soft || !line.text.trim() || afterSeparator ? '\n' : '\n\n';
  view.dispatch({ changes: { from: range.from, to: range.to, insert },
    selection: { anchor: range.from + insert.length } });
  return true;
}

function ordinaryParagraphLine(view: EditorView, from: number, to: number): boolean {
  const model = view.state.field(localPreviewField);
  if (model.tables.some((table) => table.from <= from && to <= table.to) ||
      model.blocks.some((block) => block.from <= from && to <= block.to)) return false;
  const text = view.state.doc.sliceString(from, to).trimStart();
  return Boolean(text) && !/^(?:<!--|<|{%|---\s*$|\$\$|\|)/.test(text);
}

/** Merge only a structural separator between ordinary paragraphs. */
export function visualBoundaryDelete(view: EditorView, backwards: boolean): boolean {
  if (view.composing || !view.state.field(localPreviewField, false)) return false;
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const doc = view.state.doc;
  const line = doc.lineAt(selection.head);
  if (backwards && selection.head === line.from && line.number > 2) {
    const separator = doc.line(line.number - 1);
    const previous = doc.line(line.number - 2);
    if (!separator.text && ordinaryParagraphLine(view, previous.from, previous.to) &&
        ordinaryParagraphLine(view, line.from, line.to)) {
      view.dispatch({ changes: { from: previous.to, to: line.from, insert: '' },
        selection: { anchor: previous.to } });
      return true;
    }
  }
  if (!backwards && selection.head === line.to && line.number + 2 <= doc.lines) {
    const separator = doc.line(line.number + 1);
    const next = doc.line(line.number + 2);
    if (!separator.text && ordinaryParagraphLine(view, line.from, line.to) &&
        ordinaryParagraphLine(view, next.from, next.to)) {
      view.dispatch({ changes: { from: line.to, to: next.from, insert: '' },
        selection: { anchor: line.to } });
      return true;
    }
  }
  return false;
}

/** Keep the caret out of zero-height Markdown separator lines in visual mode. */
export const skipStructuralSeparators = EditorState.transactionFilter.of((transaction) => {
  if (transaction.docChanged || !transaction.selection || !transaction.newSelection.main.empty) return transaction;
  const model = transaction.startState.field(localPreviewField, false);
  if (!model) return transaction;
  const line = transaction.startState.doc.lineAt(transaction.newSelection.main.head);
  if (!isStructuralSeparatorLine(model, line.from, line.to)) return transaction;
  const forward = transaction.newSelection.main.head >= transaction.startState.selection.main.head;
  const anchor = forward ? line.to + 1 : line.from - 1;
  return [transaction, { selection: { anchor }, sequential: true }];
});

interface Props {
  initialSource: string;
  initialPosition?: SessionPosition;
  mode: 'visual' | 'source';
  onEdit: (source: string) => void;
  onViewUpdate?: (view: EditorView | null) => void;
  onOpenExternal?: (url: string) => void;
  spellCheck?: boolean;
  documentPath?: string | null;
  imageSessionId?: string;
  imageDirectoryTemplate?: string;
  imageReferenceStyle?: ImageReferenceStyle;
  onImageFiles?: (files: File[], from: number, to: number, origin: 'paste' | 'drop') => void;
  onRelocateImage?: (image: ImageSyntax) => void;
  active?: boolean;
  performanceTier?: RenderTier;
  onPerformanceSample?: (durationMs: number, view: EditorView) => void;
}

/** One source-backed editor view for both appearances. Mode changes do not remount it. */
export function CanonicalEditor({ initialSource, initialPosition, mode, onEdit, onViewUpdate, onOpenExternal, spellCheck = false, documentPath = null, imageSessionId = '', imageDirectoryTemplate = '${filename}.assets', imageReferenceStyle = 'relative', onImageFiles, onRelocateImage, active = true, performanceTier = 'normal', onPerformanceSample }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const appearance = useRef(new Compartment());
  const spelling = useRef(new Compartment());
  const codeHighlight = useRef(new Compartment());
  const syntax = useRef(new Compartment());
  const sourceSimplified = useRef(false);
  const sourceSyntaxMonitor = useRef(new SourceSyntaxMonitor());
  const source = useRef(initialSource);
  const modeRef = useRef(mode);
  const spellRef = useRef(spellCheck);
  const tierRef = useRef(performanceTier);
  const editCallback = useRef(onEdit);
  const viewCallback = useRef(onViewUpdate);
  const externalCallback = useRef(onOpenExternal);
  const performanceCallback = useRef(onPerformanceSample);
  const imageCallback = useRef(onImageFiles);
  const relocateCallback = useRef(onRelocateImage);
  editCallback.current = onEdit;
  viewCallback.current = onViewUpdate;
  externalCallback.current = onOpenExternal;
  performanceCallback.current = onPerformanceSample;
  imageCallback.current = onImageFiles;
  relocateCallback.current = onRelocateImage;

  const visualExtensions = useRef([
    localPreviewField,
    skipStructuralSeparators,
    visualSourceSearchField,
    localPreviewComposition(),
    localPreviewLinks((url) => externalCallback.current?.(url), (image) => relocateCallback.current?.(image)),
    tableContextMenu(),
    tableSelectionClipboard(),
  ]);
  const pendingInitialScroll = useRef(initialPosition?.scrollTop ?? null);

  useLayoutEffect(() => {
    if (!host.current) return;
    if (active) setPreviewAssetContext(documentPath, imageSessionId, imageDirectoryTemplate, imageReferenceStyle);
    const view = new EditorView({
      doc: source.current,
      parent: host.current,
      dispatchTransactions: (transactions, current) => {
        const started = performance.now();
        current.update(transactions);
        if (transactions.some((transaction) => transaction.docChanged)) {
          const duration = performance.now() - started;
          queueMicrotask(() => {
            if (modeRef.current === 'source' && !sourceSimplified.current) {
              if (sourceSyntaxMonitor.current.observe(duration)) {
                sourceSimplified.current = true;
                current.dispatch({ effects: syntax.current.reconfigure([]) });
              }
            }
            performanceCallback.current?.(duration, current);
          });
        }
      },
      extensions: [
        basicSetup,
        syntax.current.of(markdown()),
        syntaxHighlighting(markdownHighlight),
        search(),
        Prec.highest(keymap.of([{ key: 'Mod-a', run: selectFocusedCodeBlock },
          { key: 'Tab', run: (view) => jumpToLinkDestination(view) || tabAtCaret(view) },
          { key: 'Shift-Tab', run: shiftTab },
          { key: 'Enter', run: (view) => visualEnter(view) },
          { key: 'Shift-Enter', run: (view) => visualEnter(view, true) },
          { key: 'Backspace', run: (view) => replaceSelectedTableCells(view, '') || visualBoundaryDelete(view, true) },
          { key: 'Delete', run: (view) => replaceSelectedTableCells(view, '') || visualBoundaryDelete(view, false) }])),
        indentUnit.of('    '),
        EditorView.lineWrapping,
        EditorView.domEventHandlers({
          paste: (event, current) => {
            const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/'));
            if (!files.length || !imageCallback.current) return false;
            event.preventDefault();
            const { from, to } = current.state.selection.main;
            imageCallback.current(files, from, to, 'paste');
            return true;
          },
          drop: (event, current) => {
            const files = [...(event.dataTransfer?.files ?? [])].filter((file) => file.type.startsWith('image/'));
            if (!files.length || !imageCallback.current) return false;
            event.preventDefault();
            const position = current.posAtCoords({ x: event.clientX, y: event.clientY }) ?? current.state.selection.main.head;
            imageCallback.current(files, position, position, 'drop');
            return true;
          },
        }),
        EditorView.contentAttributes.of({ spellcheck: 'false' }),
        appearance.current.of(modeRef.current === 'visual' ? visualExtensions.current : sourceStructure),
        spelling.current.of(modeRef.current === 'visual' && tierRef.current === 'normal' && spellRef.current ? canonicalSpelling : []),
        codeHighlight.current.of(modeRef.current === 'visual' && tierRef.current === 'normal' ? canonicalHighlight : []),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) editCallback.current(update.state.doc.toString());
          if (update.docChanged || update.selectionSet) viewCallback.current?.(update.view);
        }),
      ],
    });
    viewRef.current = view;
    if (initialPosition) {
      const anchor = Math.min(initialPosition.anchor, view.state.doc.length);
      const head = Math.min(initialPosition.head, view.state.doc.length);
      view.dispatch({ selection: { anchor, head } });
    }
    viewCallback.current?.(view);
    return () => { viewCallback.current?.(null); viewRef.current = null; view.destroy(); if (activeRef.current) setPreviewAssetContext(null, '', '${filename}.assets', 'relative'); };
  }, []);

  useLayoutEffect(() => {
    if (active) {
      const generation = imagePreviewGeneration();
      setPreviewAssetContext(documentPath, imageSessionId, imageDirectoryTemplate, imageReferenceStyle);
      if (imagePreviewGeneration() !== generation && modeRef.current === 'visual')
        viewRef.current?.dispatch({ effects: refreshImagePreviews.of(null) });
      viewRef.current?.requestMeasure();
      viewRef.current?.focus();
      // Restored background tabs mount inside a hidden panel, where scrollTop
      // is clamped to zero. Restore once after the first visible layout instead.
      const view = viewRef.current;
      if (view && pendingInitialScroll.current !== null) view.requestMeasure({
        key: pendingInitialScroll,
        read: () => activeRef.current ? view.dom.closest<HTMLElement>('.editor-scroll') : null,
        write: (pane) => {
          if (!pane || pendingInitialScroll.current === null) return;
          pane.scrollTop = pendingInitialScroll.current;
          pendingInitialScroll.current = null;
        },
      });
    }
  }, [active, documentPath, imageSessionId, imageDirectoryTemplate, imageReferenceStyle]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view || modeRef.current === mode && spellRef.current === spellCheck && tierRef.current === performanceTier) return;
    const pane = view.dom.closest<HTMLElement>('.editor-scroll');
    const before = view.coordsAtPos(view.state.selection.main.head);
    const y = pane && before ? before.top - pane.getBoundingClientRect().top : null;
    if (mode === 'visual') {
      sourceSimplified.current = false;
      sourceSyntaxMonitor.current.reset();
    }
    view.dispatch({ effects: [appearance.current.reconfigure(mode === 'visual' ? visualExtensions.current : sourceStructure),
      spelling.current.reconfigure(mode === 'visual' && performanceTier === 'normal' && spellCheck ? canonicalSpelling : []),
      codeHighlight.current.reconfigure(mode === 'visual' && performanceTier === 'normal' ? canonicalHighlight : []),
      syntax.current.reconfigure(sourceSimplified.current ? [] : markdown())] });
    if (mode === 'visual') {
      const model = view.state.field(localPreviewField, false);
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      if (model && isStructuralSeparatorLine(model, line.from, line.to))
        view.dispatch({ selection: { anchor: line.to + 1 } });
    }
    host.current?.setAttribute('data-mode', mode);
    if (pane && y !== null) {
      const after = view.coordsAtPos(view.state.selection.main.head);
      if (after) pane.scrollTop += after.top - pane.getBoundingClientRect().top - y;
    }
    modeRef.current = mode;
    spellRef.current = spellCheck;
    tierRef.current = performanceTier;
    view.focus();
  }, [mode, spellCheck, performanceTier]);

  return <div ref={host} className="canonical-editor" data-testid="canonical-editor" data-mode={mode} />;
}
