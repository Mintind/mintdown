import { editorViewCtx } from '@milkdown/kit/core';
import { expect, it } from 'vitest';
import { createUnifiedMilkdown } from '../src/editor/createUnifiedMilkdown';
import { loadHighlightParser, supportedCodeLanguage } from '../src/editor/syntaxHighlight';

const examples: Record<string, string> = {
  c: 'int count = 1;',
  cpp: 'std::string name = "x";',
  python: 'print("hello")',
  javascript: 'const value = 1;',
  typescript: 'const value: number = 1;',
  bash: 'echo "hello"',
  powershell: 'Write-Output "hello"',
  json: '{"value": 1}',
  yaml: 'value: true',
  html: '<main>hello</main>',
  css: 'main { color: red; }',
};

it('全部指定围栏语言和常用别名均可选择，未知语言安全回退', () => {
  for (const language of Object.keys(examples)) expect(supportedCodeLanguage(language)).toBe(language);
  expect(supportedCodeLanguage('JS')).toBe('javascript');
  expect(supportedCodeLanguage('py')).toBe('python');
  expect(supportedCodeLanguage('ps1')).toBe('powershell');
  expect(supportedCodeLanguage('no-such-language')).toBeUndefined();
});

it('Milkdown 代码围栏使用 Shiki 双主题装饰，未知语言保持纯文本且不改原文', async () => {
  await loadHighlightParser();
  const source = Object.entries(examples).map(([language, content]) => '```' + language + '\n' + content + '\n```').join('\n\n') +
    '\n\n```not-known\nkeep plain\n```\n';
  const host = document.createElement('div'); document.body.append(host);
  const changes: string[] = [];
  const editor = createUnifiedMilkdown(host, source, (markdown, error) => {
    if (error) throw new Error(error);
    changes.push(markdown);
  });
  await editor.create();
  const blocks = host.querySelectorAll('[data-code-fence]');
  expect(blocks).toHaveLength(Object.keys(examples).length + 1);
  for (const [index, language] of Object.keys(examples).entries()) {
    const block = blocks[index];
    expect((block.querySelector('[data-code-language]') as HTMLInputElement).value).toBe(language);
    expect(block.querySelectorAll('code .shiki').length).toBeGreaterThan(0);
    expect(block.querySelector('code .shiki')?.getAttribute('style')).toContain('--shiki-dark');
  }
  expect(blocks[blocks.length - 1].querySelectorAll('code .shiki')).toHaveLength(0);
  expect(blocks[blocks.length - 1].querySelector('code')?.textContent).toBe('keep plain');
  expect(changes).toEqual([]);
  const parser = await loadHighlightParser();
  expect(parser({ content: 'plain', language: 'unknown', pos: 0, size: 7 })).toEqual([]);
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  expect(view.state.doc.childCount).toBe(blocks.length);
  await editor.destroy(); host.remove();
});
