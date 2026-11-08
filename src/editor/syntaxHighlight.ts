import { createParser } from '@milkdown/plugin-highlight/shiki';
import type { Parser } from 'prosemirror-highlight';
import { loadHighlightCore, supportedCodeLanguage } from './highlightCore';
export { loadHighlightCore, supportedCodeLanguage } from './highlightCore';

let parserPromise: Promise<Parser> | undefined;
let loadedParser: Parser | undefined;

/** A single Shiki parser for the legacy ProseMirror recovery view. */
export function loadHighlightParser(): Promise<Parser> {
  parserPromise ??= loadHighlightCore().then((highlighter) => {
    const parse = createParser(highlighter, {
      themes: { light: 'github-light', dark: 'tokyo-night' },
    });
    const guardedParser: Parser = (options) => {
      const language = supportedCodeLanguage(options.language);
      return language ? parse({ ...options, language }) : [];
    };
    loadedParser = guardedParser;
    return guardedParser;
  }).catch((error) => {
    parserPromise = undefined;
    throw error;
  });
  return parserPromise;
}

/** Async on the first rendered code block; subsequent edits use the same engine. */
export const parseHighlightedCode: Parser = (options) => {
  const language = supportedCodeLanguage(options.language);
  if (!language) return [];
  if (loadedParser) return loadedParser({ ...options, language });
  return loadHighlightParser().then(() => {});
};
