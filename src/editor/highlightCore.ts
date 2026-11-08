import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';

const languages = [
  'c', 'cpp', 'python', 'javascript', 'typescript', 'bash', 'powershell',
  'json', 'yaml', 'html', 'css',
] as const;

const aliases: Record<string, typeof languages[number]> = {
  c: 'c', h: 'c', cpp: 'cpp', 'c++': 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  python: 'python', py: 'python',
  javascript: 'javascript', js: 'javascript', jsx: 'javascript',
  typescript: 'typescript', ts: 'typescript', tsx: 'typescript',
  bash: 'bash', sh: 'bash', shell: 'bash',
  powershell: 'powershell', ps1: 'powershell', pwsh: 'powershell',
  json: 'json', yaml: 'yaml', yml: 'yaml', html: 'html', css: 'css',
};

export function supportedCodeLanguage(language: string | undefined): typeof languages[number] | undefined {
  return language ? aliases[language.trim().toLowerCase()] : undefined;
}

let highlighterPromise: Promise<HighlighterCore> | undefined;

/** A single Shiki engine for both editor implementations and all windows. */
export function loadHighlightCore(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [import('@shikijs/themes/github-light'), import('@shikijs/themes/tokyo-night')],
    langs: [
      import('@shikijs/langs/c'), import('@shikijs/langs/cpp'),
      import('@shikijs/langs/python'), import('@shikijs/langs/javascript'),
      import('@shikijs/langs/typescript'), import('@shikijs/langs/bash'),
      import('@shikijs/langs/powershell'), import('@shikijs/langs/json'),
      import('@shikijs/langs/yaml'), import('@shikijs/langs/html'),
      import('@shikijs/langs/css'),
    ],
    engine: createOnigurumaEngine(import('shiki/wasm')),
  }).catch((error) => { highlighterPromise = undefined; throw error; });
  return highlighterPromise;
}

