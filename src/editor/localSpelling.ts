import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model';

export interface SpellChecker { correct: (word: string) => boolean; suggest: (word: string) => string[] }
interface SpellState { enabled: boolean; decorations: DecorationSet }
const spellingKey = new PluginKey<SpellState>('local-english-spelling');
let checker: SpellChecker | null = null;
let loading: Promise<SpellChecker> | null = null;

export function loadLocalSpellChecker(): Promise<SpellChecker> {
  if (!loading) loading = Promise.all([
    import('nspell'),
    import('../../node_modules/dictionary-en/index.aff?raw'),
    import('../../node_modules/dictionary-en/index.dic?raw'),
  ]).then(([module, aff, dic]) => {
    checker = module.default(aff.default, dic.default) as SpellChecker;
    return checker;
  });
  return loading;
}

function spellingMarks(doc: ProseMirrorNode): DecorationSet {
  if (!checker) return DecorationSet.empty;
  const marks: Decoration[] = [];
  const unclosedFenceParagraphs = new Set<ProseMirrorNode>();
  let fence = '';
  doc.forEach((block) => {
    if (block.type.name !== 'paragraph') { fence = ''; return; }
    const line = block.textContent;
    const wasPending = Boolean(fence);
    const opening = /^ {0,3}(`{3,}|~{3,})[^`~]*$/.exec(line)?.[1];
    if (!fence && opening) fence = opening;
    if (fence) unclosedFenceParagraphs.add(block);
    if (wasPending && fence && opening && opening[0] === fence[0] && opening.length >= fence.length && line.trim() === opening)
      fence = '';
  });
  doc.descendants((node, position, parent) => {
    if (!node.isText || parent?.type.spec.code || (parent && unclosedFenceParagraphs.has(parent)) ||
        node.marks.some((mark) => ['inlineCode', 'link'].includes(mark.type.name))) return;
    const text = node.text ?? '';
    const urls = [...text.matchAll(/\b(?:https?:\/\/|www\.)[^\s<>()]+/gi)]
      .map((found) => [found.index!, found.index! + found[0].length] as const);
    const word = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;
    for (const found of text.matchAll(word)) {
      if (urls.some(([start, end]) => found.index! >= start && found.index! < end)) continue;
      if (found[0].length < 3 || checker!.correct(found[0])) continue;
      const from = position + found.index!;
      marks.push(Decoration.inline(from, from + found[0].length,
        { class: 'local-spelling-error' }, { word: found[0] }));
    }
  });
  return DecorationSet.create(doc, marks);
}

export function setLocalSpellCheck(view: EditorView, enabled: boolean): void {
  view.dispatch(view.state.tr.setMeta(spellingKey, enabled).setMeta('addToHistory', false));
}

export function localSpelling(initialEnabled: boolean): Plugin {
  return new Plugin<SpellState>({
    key: spellingKey,
    state: {
      init: () => ({ enabled: initialEnabled, decorations: DecorationSet.empty }),
      apply: (transaction, previous) => {
        const meta: unknown = transaction.getMeta(spellingKey);
        const enabled = typeof meta === 'boolean' ? meta : previous.enabled;
        if (!enabled) return { enabled, decorations: DecorationSet.empty };
        if (meta === 'refresh' || typeof meta === 'boolean')
          return { enabled, decorations: spellingMarks(transaction.doc) };
        return { enabled, decorations: transaction.docChanged
          ? previous.decorations.map(transaction.mapping, transaction.doc) : previous.decorations };
      },
    },
    props: {
      decorations: (state) => spellingKey.getState(state)?.decorations ?? DecorationSet.empty,
      handleDOMEvents: {
        contextmenu: (view, event) => {
          const pointer = event as MouseEvent;
          const state = spellingKey.getState(view.state);
          if (!state?.enabled || !checker) return false;
          const position = view.posAtCoords({ left: pointer.clientX, top: pointer.clientY })?.pos;
          if (position === undefined) return false;
          const decoration = state.decorations.find(Math.max(0, position - 1), position + 1)
            .find((item) => item.from <= position && position <= item.to && item.spec.word);
          if (!decoration) return false;
          event.preventDefault();
          const menu = document.createElement('div');
          menu.className = 'spelling-menu';
          menu.setAttribute('role', 'menu');
          menu.setAttribute('aria-label', '拼写建议');
          menu.style.left = `${Math.min(pointer.clientX, window.innerWidth - 180)}px`;
          menu.style.top = `${Math.min(pointer.clientY, window.innerHeight - 180)}px`;
          const close = (click: PointerEvent) => {
            if (menu.contains(click.target as Node)) return;
            menu.remove();
            document.removeEventListener('pointerdown', close, true);
          };
          const suggestions = checker.suggest(decoration.spec.word).slice(0, 5);
          if (!suggestions.length) menu.textContent = '没有本地更正建议';
          for (const suggestion of suggestions) {
            const button = document.createElement('button');
            button.type = 'button';
            button.setAttribute('role', 'menuitem');
            button.textContent = suggestion;
            button.addEventListener('mousedown', (click) => click.preventDefault());
            button.addEventListener('click', () => {
              view.dispatch(view.state.tr.insertText(suggestion, decoration.from, decoration.to).scrollIntoView());
              view.focus();
              menu.remove();
              document.removeEventListener('pointerdown', close, true);
            });
            menu.append(button);
          }
          document.querySelector('.spelling-menu')?.remove();
          document.body.append(menu);
          document.addEventListener('pointerdown', close, true);
          return true;
        },
      },
    },
    view: (view) => {
      let active = true;
      let timer: number | undefined;
      const refresh = () => {
        if (!active || !spellingKey.getState(view.state)?.enabled) return;
        view.dispatch(view.state.tr.setMeta(spellingKey, 'refresh').setMeta('addToHistory', false));
      };
      const schedule = () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(refresh, 280);
      };
      const ensure = () => {
        if (!spellingKey.getState(view.state)?.enabled) return;
        if (checker) { schedule(); return; }
        void loadLocalSpellChecker().then(() => { if (active) schedule(); });
      };
      ensure();
      return {
        update: (_view, previous) => {
          if (!previous.doc.eq(view.state.doc)) schedule();
          if (spellingKey.getState(previous)?.enabled !== spellingKey.getState(view.state)?.enabled) ensure();
        },
        destroy: () => { active = false; window.clearTimeout(timer); document.querySelector('.spelling-menu')?.remove(); },
      };
    },
  });
}
