import { EditorState, StateEffect, StateField, RangeSet, type Range } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { parseSegments } from '../markdown/segments';
import type { SearchOptions, SearchStatus } from '../ui/searchCommands';
import { localPreviewField } from './localPreview';

interface Match { from: number; to: number }
interface VisualSearchState { options: SearchOptions | null; matches: Match[]; decorations: DecorationSet }
const changeQuery = StateEffect.define<SearchOptions | null>();

function findMatches(state: EditorState, options: SearchOptions | null): Match[] {
  if (!options?.text) return [];
  const source = state.doc.toString();
  const preview = state.field(localPreviewField, false);
  const blocked: Match[] = [];
  preview?.atomic.between(0, source.length, (from, to) => { blocked.push({ from, to }); });
  for (const span of preview?.spans ?? []) if (span.kind === 'inlineCode') blocked.push(span);
  for (const block of preview?.blocks ?? []) if (block.kind === 'code') blocked.push(block);
  for (const part of parseSegments(source)) if (part.kind !== 'milkdown') blocked.push({ from: part.start, to: part.end });
  const matches: Match[] = [];
  const escaped = options.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp(escaped, options.caseSensitive ? 'gu' : 'giu');
  for (const found of source.matchAll(expression)) {
    const from = found.index;
    const to = from + found[0].length;
    if (blocked.some((range) => range.from < to && range.to > from)) continue;
    if (options.wholeWord && (/[\p{L}\p{N}_]/u.test(source[from - 1] ?? '') || /[\p{L}\p{N}_]/u.test(source[to] ?? ''))) continue;
    matches.push({ from, to });
  }
  return matches;
}

function decorations(matches: Match[], current: number): DecorationSet {
  const ranges: Range<Decoration>[] = matches.map((match, index) =>
    Decoration.mark({ class: index === current ? 'md-visual-search-current' : 'md-visual-search-match' }).range(match.from, match.to));
  return RangeSet.of(ranges, true);
}

export const visualSourceSearchField = StateField.define<VisualSearchState>({
  create: () => ({ options: null, matches: [], decorations: Decoration.none }),
  update: (previous, transaction) => {
    const effect = transaction.effects.find((item) => item.is(changeQuery));
    const options = effect ? effect.value : previous.options;
    if (!effect && !transaction.docChanged && !transaction.selection) return previous;
    const matches = findMatches(transaction.state, options);
    const selection = transaction.state.selection.main;
    const current = matches.findIndex((match) => match.from === selection.from && match.to === selection.to);
    return { options, matches, decorations: decorations(matches, current) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

export function updateVisualSourceSearch(view: EditorView, options: SearchOptions): SearchStatus {
  view.dispatch({ effects: changeQuery.of(options.text ? options : null) });
  const state = view.state.field(visualSourceSearchField);
  const range = view.state.selection.main;
  return { total: state.matches.length,
    current: state.matches.findIndex((match) => match.from === range.from && match.to === range.to) + 1,
    valid: true };
}

export function runVisualSourceSearch(view: EditorView, options: SearchOptions,
  action: 'next' | 'previous' | 'replace' | 'replaceAll'): boolean {
  if (!options.text) return false;
  view.dispatch({ effects: changeQuery.of(options) });
  const matches = view.state.field(visualSourceSearchField).matches;
  if (!matches.length) return false;
  const selection = view.state.selection.main;
  if (action === 'replaceAll') {
    view.dispatch({ changes: matches.map(({ from, to }) => ({ from, to, insert: options.replace })) });
    return true;
  }
  if (action === 'replace') {
    const match = matches.find((item) => item.from === selection.from && item.to === selection.to);
    if (!match) return runVisualSourceSearch(view, options, 'next');
    view.dispatch({ changes: { from: match.from, to: match.to, insert: options.replace },
      selection: { anchor: match.from + options.replace.length } });
    return true;
  }
  const found = action === 'previous'
    ? [...matches].reverse().find((item) => item.to < selection.from) ?? matches.at(-1)!
    : matches.find((item) => item.from > selection.to || item.from === selection.to && selection.empty) ?? matches[0];
  view.dispatch({ selection: { anchor: found.from, head: found.to }, scrollIntoView: true });
  return true;
}
