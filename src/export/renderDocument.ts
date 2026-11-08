import { invoke } from '@tauri-apps/api/core';
import type { Root as MdRoot, RootContent as MdContent } from 'mdast';
import type { Root as HtmlRoot, RootContent as HtmlContent, Element as HtmlElement } from 'hast';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkFrontmatter from 'remark-frontmatter';
import remarkRehype from 'remark-rehype';
import rehypeKatex from 'rehype-katex';
import rehypeStringify from 'rehype-stringify';
import { unified } from 'unified';
import YAML from 'yaml';
import { loadHighlightCore, supportedCodeLanguage } from '../editor/highlightCore';
import { resolveImageDirectory } from '../assets/imagePaths';
import documentCss from '../styles/export-document.css?raw';

export interface ExportOptions {
  source: string;
  documentPath: string | null;
  sessionId: string;
  directoryTemplate: string;
  referenceStyle: 'relative' | 'asset-relative';
  format: 'html' | 'pdf';
}
export interface ExportTimings { parseMs: number; transformMs: number; mathMs: number; imagesMs: number; highlightMs: number; serializeMs: number; totalMs: number }
export interface ExportDocument { html: string; title: string; warnings: string[]; bytes: number; timings: ExportTimings }
type ImageBytes = { mime: string; bytes: number[] };
export interface ExportServices { image?: (candidate: string, options: ExportOptions) => Promise<string>; progress?: (message: string) => void }
const codeCache = new Map<string, HtmlContent[]>();
let codeCacheCharacters = 0;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
function imageName(raw: string): string {
  const name = raw.split(/[\\/]/).at(-1) || raw;
  try { return decodeURIComponent(name); } catch { return name; }
}
function toBase64(bytes: number[]): string {
  const chunks: string[] = [];
  for (let start = 0; start < bytes.length; start += 32_768)
    chunks.push(String.fromCharCode(...bytes.slice(start, start + 32_768)));
  return btoa(chunks.join(''));
}
function textOf(node: HtmlContent): string {
  if (node.type === 'text') return node.value;
  return 'children' in node ? node.children.map((child) => textOf(child as HtmlContent)).join('') : '';
}
function missingImage(raw: string): HtmlElement {
  return { type: 'element', tagName: 'span', properties: { className: ['missing-image'] },
    children: [{ type: 'text', value: `图片未找到：${imageName(raw)}` }] };
}
function localCandidates(raw: string, options: ExportOptions): string[] {
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { throw new Error('图片路径编码无效'); }
  if (/^[a-z][\d+a-z.-]*:/i.test(decoded) || decoded.startsWith('//')) throw new Error('图片路径格式不受支持');
  if (options.referenceStyle !== 'asset-relative' || decoded.startsWith('./') || decoded.startsWith('../')) return [decoded];
  const fileName = options.documentPath?.split(/[\\/]/).at(-1) || 'untitled.md';
  return [`${resolveImageDirectory(options.directoryTemplate, fileName)}/${decoded}`, decoded];
}
async function readImage(raw: string, options: ExportOptions, services: ExportServices): Promise<string> {
  let lastError: unknown;
  for (const candidate of localCandidates(raw, options)) {
    try {
      if (services.image) return await services.image(candidate, options);
      const image = options.documentPath
        ? await invoke<ImageBytes>('read_document_image', { documentPath: options.documentPath, imagePath: candidate })
        : await invoke<ImageBytes>('read_draft_document_image', { sessionId: options.sessionId, imagePath: candidate });
      return `data:${image.mime};base64,${toBase64(image.bytes)}`;
    } catch (error) { lastError = error; }
  }
  throw lastError ?? new Error('图片未找到');
}

function normalizeMarkdown(tree: MdRoot, defaultTitle: string, warnings: string[]): string {
  let title = defaultTitle;
  const first = tree.children[0];
  if (first?.type === 'yaml') {
    const parsed = YAML.parseDocument(first.value, { prettyErrors: false });
    if (parsed.errors.length === 0) {
      const yamlTitle = parsed.get('title');
      if (typeof yamlTitle === 'string' && yamlTitle.trim()) title = yamlTitle.trim();
      tree.children.shift();
    } else {
      warnings.push('Front Matter 无效，已作为原始文本输出。');
      tree.children[0] = { type: 'code', lang: 'yaml', value: `---\n${first.value}\n---` };
    }
  }
  const clean = (children: MdContent[]) => {
    for (let index = children.length - 1; index >= 0; index--) {
      const node = children[index];
      if (node.type === 'html') {
        if (/^<!--\s*more\s*-->$/i.test(node.value.trim())) children.splice(index, 1);
        else { warnings.push('原始 HTML 已作为文字安全显示。'); children[index] = { type: 'text', value: node.value }; }
      } else if ('children' in node && Array.isArray(node.children)) clean(node.children as MdContent[]);
    }
  };
  clean(tree.children);
  return title;
}

async function decorateHtml(tree: HtmlRoot, options: ExportOptions, warnings: string[], timings: ExportTimings, services: ExportServices): Promise<void> {
  let highlighter: Awaited<ReturnType<typeof loadHighlightCore>> | null = null;
  // Per export only: files are read again on every export, never stale across jobs.
  const images = new Map<string, Promise<string>>();
  const walk = async (children: HtmlContent[]) => {
    for (let index = 0; index < children.length; index++) {
      const node = children[index];
      if (node.type !== 'element') continue;
      if (node.tagName === 'img') {
        const raw = String(node.properties.src ?? '');
        if (/^https?:\/\//i.test(raw)) {
          warnings.push(`远程图片依赖网络：${raw}`);
          if (options.format === 'pdf') children[index] = missingImage(raw);
        } else {
          try {
            const start = performance.now();
            if (!images.has(raw)) images.set(raw, readImage(raw, options, services));
            node.properties.src = await images.get(raw)!;
            timings.imagesMs += performance.now() - start;
          } catch (error) {
            warnings.push(`图片未能嵌入：${raw}（${String((error as { message?: string }).message ?? error)}）`);
            children[index] = missingImage(raw);
          }
        }
        continue;
      }
      if (node.tagName === 'a') {
        const href = String(node.properties.href ?? '');
        if (/^(?:javascript|data|vbscript|file):/i.test(href) || href.startsWith('//')) {
          delete node.properties.href;
          warnings.push(`已禁用不安全链接：${href}`);
        }
      }
      if (node.tagName === 'pre') {
        const code = node.children.find((item): item is HtmlElement => item.type === 'element' && item.tagName === 'code');
        const classList = code?.properties.className;
        const rawLanguage = Array.isArray(classList) ? String(classList.find((value) => String(value).startsWith('language-')) ?? '').slice(9) : '';
        const language = supportedCodeLanguage(rawLanguage);
        if (code && language) {
          try {
            const start = performance.now();
            const text = textOf(code), key = language + '\0' + text;
            let children = codeCache.get(key);
            if (children) { codeCache.delete(key); codeCache.set(key, children); }
            else {
              highlighter ??= await loadHighlightCore();
              const { tokens } = highlighter.codeToTokens(text, { lang: language, theme: 'github-light' });
              children = tokens.flatMap((line, lineIndex) => [
              ...(lineIndex ? [{ type: 'text' as const, value: '\n' }] : []),
              ...line.map((token) => ({ type: 'element' as const, tagName: 'span',
                properties: token.color ? { style: `color:${token.color}` } : {},
                children: [{ type: 'text' as const, value: token.content }] })),
              ]);
              if (key.length < 64_000) {
                while (codeCacheCharacters + key.length > 512_000 || codeCache.size >= 100) {
                  const oldest = codeCache.keys().next().value!; codeCache.delete(oldest); codeCacheCharacters -= oldest.length;
                }
                codeCache.set(key, children); codeCacheCharacters += key.length;
              }
            }
            code.children = children as HtmlElement['children'];
            timings.highlightMs += performance.now() - start;
          } catch { warnings.push(`代码语言 ${language} 未能高亮，已保留原始代码。`); }
        }
      }
      await walk(node.children as HtmlContent[]);
    }
  };
  await walk(tree.children);
}

export async function renderExportDocument(options: ExportOptions, services: ExportServices = {}): Promise<ExportDocument> {
  const start = performance.now();
  const timings: ExportTimings = { parseMs: 0, transformMs: 0, mathMs: 0, imagesMs: 0, highlightMs: 0, serializeMs: 0, totalMs: 0 };
  const warnings: string[] = [];
  services.progress?.('正在解析 Markdown…');
  const defaultTitle = options.documentPath?.split(/[\\/]/).at(-1)?.replace(/\.(md|markdown)$/i, '') || '未命名文档';
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkFrontmatter, ['yaml'])
    .use(remarkRehype).use(() => {
      const math = rehypeKatex({ output: 'mathml', trust: false });
      return (tree, file) => { services.progress?.('正在渲染公式…'); const began = performance.now(); math(tree as HtmlRoot, file); timings.mathMs += performance.now() - began; };
    })
    .use(() => async (tree) => { services.progress?.('正在处理图片与代码…'); await decorateHtml(tree as HtmlRoot, options, warnings, timings, services); })
    .use(rehypeStringify);
  const markdown = processor.parse(options.source) as MdRoot;
  const title = normalizeMarkdown(markdown, defaultTitle, warnings);
  timings.parseMs = performance.now() - start;
  const transformStart = performance.now();
  const htmlTree = await processor.run(markdown);
  timings.transformMs = performance.now() - transformStart;
  const serializeStart = performance.now();
  services.progress?.('正在生成 HTML…');
  const body = processor.stringify(htmlTree);
  const html = `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: http: https:; style-src 'unsafe-inline'; font-src data:"><title>${escapeHtml(title)}</title><style>${documentCss}</style></head><body><main>${body}</main></body></html>`;
  const bytes = new TextEncoder().encode(html).length;
  timings.serializeMs = performance.now() - serializeStart;
  timings.totalMs = performance.now() - start;
  return { html, title, warnings: [...new Set(warnings)], bytes, timings };
}

if (import.meta.env.VITE_NATIVE_TEST === '1' && typeof window !== 'undefined')
  Object.assign(window, { __MINTDOWN_RENDER_EXPORT__: renderExportDocument });
