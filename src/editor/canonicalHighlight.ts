import { RangeSet, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { localPreviewField } from './localPreview';
import { loadHighlightCore, supportedCodeLanguage } from './syntaxHighlight';
import type { HighlighterCore } from 'shiki/core';

class CanonicalHighlight {
  decorations: DecorationSet = Decoration.none;
  private highlighter: HighlighterCore | null = null;
  private timer = 0;
  private active = true;
  private loading = false;

  constructor(readonly view: EditorView) {
    this.ensure();
  }

  private ensure() {
    if (this.loading || this.highlighter || !/^ {0,3}(?:`{3,}|~{3,})[^\n]*$/m.test(this.view.state.doc.toString())) return;
    this.loading = true;
    void loadHighlightCore().then((highlighter) => {
      if (!this.active) return;
      this.highlighter = highlighter;
      this.schedule();
    }).catch(() => { this.loading = false; });
  }

  update(update: ViewUpdate) {
    if (update.docChanged) this.decorations = this.decorations.map(update.changes);
    if (update.docChanged) this.ensure();
    if (update.docChanged || update.viewportChanged) this.schedule();
  }

  private schedule() {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.refresh(), 160);
  }

  private refresh() {
    if (!this.active || !this.highlighter) return;
    const state = this.view.state;
    const source = state.doc.toString();
    const blocks = state.field(localPreviewField, false)?.blocks.filter((item) => item.kind === 'code') ?? [];
    const ranges: Range<Decoration>[] = [];
    for (const block of blocks) {
      if (block.prefixes.length !== 2 || !this.view.visibleRanges.some((visible) => visible.from < block.to && visible.to > block.from)) continue;
      const opener = state.doc.lineAt(block.from);
      const language = supportedCodeLanguage(/^ {0,3}(?:`{3,}|~{3,})([^\s`~]*)/.exec(opener.text)?.[1]);
      if (!language) continue;
      const bodyFrom = opener.to + 1;
      const bodyTo = block.prefixes[1].from;
      const code = source.slice(bodyFrom, bodyTo).replace(/\n$/, '');
      const tokens = this.highlighter.codeToTokensWithThemes(code,
        { lang: language, themes: { light: 'github-light', dark: 'tokyo-night' } });
      let lineStart = bodyFrom;
      for (const line of tokens) {
        let offset = lineStart;
        for (const token of line) {
          const to = Math.min(offset + token.content.length, bodyTo);
          if (to > offset) {
            const light = token.variants.light?.color;
            const dark = token.variants.dark?.color;
            if (light || dark) ranges.push(Decoration.mark({ class: 'md-shiki-token',
              attributes: { style: `--shiki-light:${light ?? 'inherit'};--shiki-dark:${dark ?? 'inherit'}` } }).range(offset, to));
          }
          offset = to;
        }
        const newline = source.indexOf('\n', lineStart);
        if (newline < 0 || newline >= bodyTo) break;
        lineStart = newline + 1;
      }
    }
    this.decorations = RangeSet.of(ranges, true);
    this.view.dispatch({});
  }

  destroy() { this.active = false; window.clearTimeout(this.timer); }
}

export const canonicalHighlight = ViewPlugin.fromClass(CanonicalHighlight, {
  decorations: (plugin) => plugin.decorations,
});
