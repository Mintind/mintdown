import { RangeSet, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';

type ScanState = { frontmatter: boolean; fence: string; length: number };
const initial = (): ScanState => ({ frontmatter: false, fence: '', length: 0 });

function lineKind(text: string, number: number, state: ScanState): 'frontmatter' | 'fence' | 'code' | 'heading' | 'list' | '' {
  if (number === 1 && /^---\s*$/.test(text)) { state.frontmatter = true; return 'frontmatter'; }
  if (state.frontmatter) {
    if (/^(?:---|\.\.\.)\s*$/.test(text)) state.frontmatter = false;
    return 'frontmatter';
  }
  if (state.fence) {
    if (new RegExp(`^ {0,3}${state.fence}{${state.length},}\\s*$`).test(text)) {
      state.fence = ''; state.length = 0; return 'fence';
    }
    return 'code';
  }
  const fence = /^ {0,3}(`{3,}|~{3,})/.exec(text)?.[1];
  if (fence) { state.fence = fence[0]; state.length = fence.length; return 'fence'; }
  if (/^ {0,3}#{1,6}[ \t]+/.test(text)) return 'heading';
  if (/^\s*(?:[-+*]|\d+[.)])[ \t]+/.test(text)) return 'list';
  return '';
}

/** Only decorates viewport lines. Checkpoints avoid rescanning the whole document on every scroll. */
class SourceStructure {
  decorations: DecorationSet = Decoration.none;
  private checkpoints = new Map<number, ScanState>([[1, initial()]]);

  constructor(readonly view: EditorView) { this.refresh(); }

  update(update: ViewUpdate) {
    if (update.docChanged) this.checkpoints = new Map([[1, initial()]]);
    if (update.docChanged || update.viewportChanged) this.refresh();
  }

  private stateAt(number: number): ScanState {
    let start = 1, state = initial();
    for (const [line, saved] of this.checkpoints) {
      if (line <= number && line >= start) { start = line; state = { ...saved }; }
    }
    for (let line = start; line < number; line++) {
      lineKind(this.view.state.doc.line(line).text, line, state);
      if (line % 200 === 0) this.checkpoints.set(line + 1, { ...state });
    }
    return state;
  }

  private refresh() {
    const ranges: Range<Decoration>[] = [];
    const doc = this.view.state.doc;
    for (const visible of this.view.visibleRanges) {
      const first = doc.lineAt(visible.from).number;
      const last = doc.lineAt(visible.to).number;
      const state = this.stateAt(first);
      for (let number = first; number <= last; number++) {
        const line = doc.line(number);
        const kind = lineKind(line.text, number, state);
        if (kind) ranges.push(Decoration.line({ class: `md-source-${kind}` }).range(line.from));
        if (kind === 'heading') {
          const marker = /^ {0,3}(#{1,6})/.exec(line.text)?.[1];
          if (marker) {
            const from = line.from + line.text.indexOf(marker);
            ranges.push(Decoration.mark({ class: 'md-source-marker' }).range(from, from + marker.length));
          }
        } else if (kind === 'list') {
          const marker = /^\s*([-+*]|\d+[.)])(?=[ \t])/.exec(line.text)?.[1];
          if (marker) {
            const from = line.from + line.text.indexOf(marker);
            ranges.push(Decoration.mark({ class: 'md-source-marker' }).range(from, from + marker.length));
          }
        } else if (kind === 'fence' && state.fence) {
          const match = /^ {0,3}(`{3,}|~{3,})([^\s`~]*)/.exec(line.text);
          if (match?.[2]) {
            const from = line.from + line.text.indexOf(match[2], match[1].length);
            ranges.push(Decoration.mark({ class: 'md-source-language' }).range(from, from + match[2].length));
          }
        }
        if (kind !== 'code' && kind !== 'fence' && line.text.length <= 5_000) {
          for (const match of line.text.matchAll(/\[[^\]\n]+\]\((?:https?:\/\/)?[^)\n]+\)/g)) {
            const from = line.from + match.index;
            ranges.push(Decoration.mark({ class: 'md-source-link' }).range(from, from + match[0].length));
          }
          for (const match of line.text.matchAll(/\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`/g)) {
            const from = line.from + match.index;
            ranges.push(Decoration.mark({ class: 'md-source-emphasis' }).range(from, from + match[0].length));
          }
        }
        if (number % 200 === 0) this.checkpoints.set(number + 1, { ...state });
      }
    }
    this.decorations = RangeSet.of(ranges, true);
  }
}

export const sourceStructure = ViewPlugin.fromClass(SourceStructure, {
  decorations: (plugin) => plugin.decorations,
});
