import { useEffect, useRef } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting } from '@codemirror/language';
import { indentUnit } from '@codemirror/language';
import { indentWithTab } from '@codemirror/commands';
import { keymap } from '@codemirror/view';
import { search } from '@codemirror/search';
import { markdownHighlight } from './markdownHighlight';

interface Props {
  initialSource: string;
  onEdit: (source: string) => void;
  onViewUpdate?: (view: EditorView | null) => void;
}

export function SourceEditor({ initialSource, onEdit, onViewUpdate }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const callback = useRef(onEdit);
  const viewCallback = useRef(onViewUpdate);
  const startingSource = useRef(initialSource);
  callback.current = onEdit;
  viewCallback.current = onViewUpdate;

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      doc: startingSource.current,
      parent: host.current,
      extensions: [
        keymap.of([indentWithTab]),
        indentUnit.of('    '),
        basicSetup,
        search(),
        EditorView.contentAttributes.of({ spellcheck: 'false' }),
        markdown(),
        syntaxHighlighting(markdownHighlight),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) callback.current(update.state.doc.toString());
          if (update.docChanged || update.selectionSet) viewCallback.current?.(update.view);
        }),
      ],
    });
    viewCallback.current?.(view);
    return () => { viewCallback.current?.(null); view.destroy(); };
  }, []);

  return <div ref={host} className="source-editor" data-testid="source-editor" />;
}
