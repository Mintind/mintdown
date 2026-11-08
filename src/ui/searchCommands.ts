import type { EditorView as CodeMirrorView } from 'codemirror';
import { SearchQuery as SourceQuery, findNext as sourceNext, findPrevious as sourcePrevious,
  getSearchQuery, replaceAll as sourceReplaceAll, replaceNext as sourceReplaceNext,
  setSearchQuery } from '@codemirror/search';
import type { EditorView as ProseMirrorView } from '@milkdown/kit/prose/view';
import { SearchQuery as VisualQuery, findNext as visualNext, findPrev as visualPrevious,
  replaceAll as visualReplaceAll, replaceCurrent as visualReplaceCurrent, setSearchState } from 'prosemirror-search';

export interface SearchOptions {
  text: string;
  replace: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
}

export interface SearchStatus { total: number; current: number; valid: boolean }

const emptyStatus: SearchStatus = { total: 0, current: 0, valid: true };

function visualQuery(options: SearchOptions): VisualQuery {
  return new VisualQuery({ search: options.text, replace: options.replace,
    caseSensitive: options.caseSensitive, wholeWord: options.wholeWord,
    filter: (state, match) => {
      const from = state.doc.resolve(match.from);
      const to = state.doc.resolve(match.to);
      // The visual search only works within editable prose. Raw atoms, code,
      // math and Markdown-only attributes stay available in source mode.
      return from.parent === to.parent && from.parent.isTextblock && !from.parent.type.spec.code &&
        !state.doc.rangeHasMark(match.from, match.to, state.schema.marks.inlineCode);
    },
  });
}

function sourceQuery(options: SearchOptions): SourceQuery {
  return new SourceQuery({ search: options.text, replace: options.replace,
    caseSensitive: options.caseSensitive, wholeWord: options.wholeWord, regexp: options.regexp });
}

export function updateSearch(visual: ProseMirrorView | null, source: CodeMirrorView | null,
  options: SearchOptions): SearchStatus {
  if (!options.text) {
    if (visual) visual.dispatch(setSearchState(visual.state.tr.setMeta('addToHistory', false), visualQuery(options)));
    if (source) source.dispatch({ effects: setSearchQuery.of(sourceQuery(options)) });
    return emptyStatus;
  }
  if (source) {
    const query = sourceQuery(options);
    source.dispatch({ effects: setSearchQuery.of(query) });
    if (!query.valid) return { ...emptyStatus, valid: false };
    let total = 0;
    let current = 0;
    const selection = source.state.selection.main;
    const cursor = query.getCursor(source.state);
    for (let found = cursor.next(); !found.done; found = cursor.next()) {
      total++;
      if (found.value.from === selection.from && found.value.to === selection.to) current = total;
    }
    return { total, current, valid: true };
  }
  if (visual) {
    const query = visualQuery(options);
    visual.dispatch(setSearchState(visual.state.tr.setMeta('addToHistory', false), query));
    if (!query.valid) return { ...emptyStatus, valid: false };
    let total = 0;
    let current = 0;
    const selection = visual.state.selection;
    let position = 0;
    while (position < visual.state.doc.content.size) {
      const found = query.findNext(visual.state, position);
      if (!found) break;
      total++;
      if (found.from === selection.from && found.to === selection.to) current = total;
      position = Math.max(found.to, position + 1);
    }
    return { total, current, valid: true };
  }
  return emptyStatus;
}

export function runSearchAction(visual: ProseMirrorView | null, source: CodeMirrorView | null,
  options: SearchOptions, action: 'next' | 'previous' | 'replace' | 'replaceAll'): boolean {
  if (!options.text) return false;
  if (source) {
    const query = sourceQuery(options);
    if (!query.valid) return false;
    if (!getSearchQuery(source.state).eq(query)) source.dispatch({ effects: setSearchQuery.of(query) });
    const command = action === 'next' ? sourceNext : action === 'previous' ? sourcePrevious :
      action === 'replace' ? sourceReplaceNext : sourceReplaceAll;
    return command(source);
  }
  if (visual) {
    const query = visualQuery(options);
    if (!query.valid) return false;
    visual.dispatch(setSearchState(visual.state.tr.setMeta('addToHistory', false), query));
    const command = action === 'next' ? visualNext : action === 'previous' ? visualPrevious :
      action === 'replace' ? visualReplaceCurrent : visualReplaceAll;
    return command(visual.state, visual.dispatch);
  }
  return false;
}
