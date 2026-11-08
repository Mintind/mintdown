import { RangeSet, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { parseSegments } from '../markdown/segments';
import { loadLocalSpellChecker, type SpellChecker } from './localSpelling';
import { localPreviewField } from './localPreview';

class CanonicalSpelling {
  decorations: DecorationSet = Decoration.none;
  private checker: SpellChecker | null = null;
  private timer = 0;
  private active = true;

  constructor(readonly view: EditorView) {
    void loadLocalSpellChecker().then((checker) => {
      if (!this.active) return;
      this.checker = checker;
      this.schedule();
    });
  }

  update(update: ViewUpdate) {
    if (update.docChanged) this.decorations = this.decorations.map(update.changes);
    if (update.docChanged || update.viewportChanged) this.schedule();
  }

  private schedule() {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.refresh(), 280);
  }

  private refresh() {
    if (!this.active || !this.checker) return;
    const source = this.view.state.doc.toString();
    const preview = this.view.state.field(localPreviewField, false);
    const blocked = parseSegments(source).filter((part) => part.kind !== 'milkdown' || /^ {0,3}(`{3,}|~{3,})/.test(part.original))
      .map((part) => ({ from: part.start, to: part.end }));
    for (const span of preview?.spans ?? []) if (span.kind === 'inlineCode') blocked.push(span);
    preview?.atomic.between(0, source.length, (from, to) => { blocked.push({ from, to }); });
    const marks: Range<Decoration>[] = [];
    for (const visible of this.view.visibleRanges) {
      const text = source.slice(visible.from, visible.to);
      const urls = [...text.matchAll(/\b(?:https?:\/\/|www\.)[^\s<>()]+/gi)]
        .map((found) => ({ from: visible.from + found.index!, to: visible.from + found.index! + found[0].length }));
      for (const found of text.matchAll(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)) {
        if (found[0].length < 3 || this.checker.correct(found[0])) continue;
        const from = visible.from + found.index!;
        const to = from + found[0].length;
        if (blocked.some((range) => range.from < to && range.to > from) ||
            urls.some((range) => range.from < to && range.to > from)) continue;
        marks.push(Decoration.mark({ class: 'local-spelling-error', attributes: { 'data-spelling-word': found[0] } }).range(from, to));
      }
    }
    this.decorations = RangeSet.of(marks, true);
    this.view.dispatch({});
  }

  contextMenu(event: MouseEvent): boolean {
    if (!this.checker) return false;
    const position = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (position === null) return false;
    let error: { from: number; to: number; word: string } | undefined;
    this.decorations.between(Math.max(0, position - 1), position + 1, (from, to, decoration) => {
      const word = decoration.spec.attributes?.['data-spelling-word'];
      if (from <= position && position <= to && word) error = { from, to, word };
    });
    if (!error) return false;
    event.preventDefault();
    const current = error;
    const menu = document.createElement('div');
    menu.className = 'spelling-menu'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', '拼写建议');
    menu.style.left = `${Math.min(event.clientX, window.innerWidth - 180)}px`;
    menu.style.top = `${Math.min(event.clientY, window.innerHeight - 180)}px`;
    const close = (click: PointerEvent) => {
      if (menu.contains(click.target as Node)) return;
      menu.remove(); document.removeEventListener('pointerdown', close, true);
    };
    const suggestions = this.checker.suggest(current.word).slice(0, 5);
    if (!suggestions.length) menu.textContent = '没有本地更正建议';
    for (const suggestion of suggestions) {
      const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'menuitem');
      button.textContent = suggestion;
      button.addEventListener('mousedown', (click) => click.preventDefault());
      button.addEventListener('click', () => {
        this.view.dispatch({ changes: { from: current.from, to: current.to, insert: suggestion }, scrollIntoView: true });
        this.view.focus(); menu.remove(); document.removeEventListener('pointerdown', close, true);
      });
      menu.append(button);
    }
    document.querySelector('.spelling-menu')?.remove();
    document.body.append(menu); document.addEventListener('pointerdown', close, true);
    return true;
  }

  destroy() {
    this.active = false;
    window.clearTimeout(this.timer);
    document.querySelector('.spelling-menu')?.remove();
  }
}

export const canonicalSpelling: ViewPlugin<CanonicalSpelling> = ViewPlugin.fromClass(CanonicalSpelling, {
  decorations: (plugin) => plugin.decorations,
  eventHandlers: { contextmenu: (event, view): boolean => view.plugin(canonicalSpelling)?.contextMenu(event) ?? false },
});
