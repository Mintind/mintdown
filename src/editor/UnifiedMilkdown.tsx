import { useEffect, useRef } from 'react';
import { editorViewCtx, serializerCtx } from '@milkdown/kit/core';
import type { EditorView } from '@milkdown/kit/prose/view';
import { parseSegments } from '../markdown/segments';
import { createUnifiedMilkdown, missingProtectedRaw } from './createUnifiedMilkdown';
import { setLocalSpellCheck } from './localSpelling';
import '@milkdown/kit/prose/view/style/prosemirror.css';
import 'katex/dist/katex.min.css';

interface Props {
  initialSource: string;
  onEdit: (source: string, error?: string) => void;
  onUnsafeOpen: (reason: string) => void;
  onDocumentState?: (state: unknown) => void;
  restoredState?: unknown;
  onViewUpdate?: (view: EditorView | null) => void;
  spellCheck?: boolean;
}

export function UnifiedMilkdown({ initialSource, onEdit, onUnsafeOpen, onDocumentState, restoredState, onViewUpdate, spellCheck = true }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const startingSource = useRef(initialSource);
  const spelling = useRef(spellCheck);
  const editorView = useRef<EditorView | null>(null);
  spelling.current = spellCheck;
  const editCallback = useRef(onEdit);
  const unsafeCallback = useRef(onUnsafeOpen);
  const documentStateCallback = useRef(onDocumentState);
  const viewCallback = useRef(onViewUpdate);
  editCallback.current = onEdit;
  unsafeCallback.current = onUnsafeOpen;
  documentStateCallback.current = onDocumentState;
  viewCallback.current = onViewUpdate;

  useEffect(() => {
    if (editorView.current) setLocalSpellCheck(editorView.current, spellCheck);
  }, [spellCheck]);

  useEffect(() => {
    if (!host.current) return;
    let active = true;
    const source = startingSource.current;
    const recovery = restoredState;
    const editor = createUnifiedMilkdown(host.current, source, (markdown, error) => {
      if (active) editCallback.current(markdown, error);
    }, (state) => { if (active) documentStateCallback.current?.(state); },
    (view) => {
      if (!active) return;
      editorView.current = view;
      viewCallback.current?.(view);
      if (view) {
        view.dom.spellcheck = false;
      }
    }, spelling.current);
    void editor.create().then(() => {
      if (!active) return;
      if (recovery) {
        try {
          editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const doc = view.state.schema.nodeFromJSON(recovery);
            view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content));
          });
        } catch (cause) { unsafeCallback.current(`恢复可视编辑状态失败：${String(cause)}`); }
      }
      const serialized = editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc));
      const expected = parseSegments(source)
        .filter((segment) => ['frontmatter', 'raw'].includes(segment.kind))
        .map((segment) => segment.original);
      const missing = missingProtectedRaw(serialized, expected);
      if (missing) unsafeCallback.current(`可视模式不能安全保留原始片段：${missing.slice(0, 40)}`);
    }).catch((error: unknown) => {
      if (active) unsafeCallback.current(`可视编辑器加载失败：${String(error)}`);
    });
    return () => { active = false; editorView.current = null; viewCallback.current?.(null); void editor.destroy(); };
  }, []);

  return <div ref={host} className="unified-milkdown" data-testid="unified-milkdown" />;
}
