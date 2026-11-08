import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderExportDocument, type ExportOptions } from '../src/export/renderDocument';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const base: ExportOptions = {
  source: '', documentPath: 'D:\\笔记 空格\\文章.md', sessionId: 'draft-1',
  directoryTemplate: '${filename}.assets', referenceStyle: 'relative', format: 'html',
};

describe('standalone export renderer', () => {
  beforeEach(() => invoke.mockReset());

  it('keeps current Markdown semantics without app chrome or unsafe HTML', async () => {
    const source = [
      '---', 'title: 导出标题', 'author: 张三', '---', '# 中文正文', '',
      '这是 **粗体** 和 $x^2$。', '', '<!--more-->', '',
      '| 左 | 右 |', '|:---|---:|', '| 甲 | 乙 |', '',
      '- [x] 完成', '', '```html', '<!--more-->', '<script>alert(1)</script>', '```', '',
      '<script>alert(2)</script>', '', '最后一段。',
    ].join('\n');
    const result = await renderExportDocument({ ...base, source });
    expect(result.title).toBe('导出标题');
    expect(result.html).toContain('<title>导出标题</title>');
    expect(result.html).toContain('<h1>中文正文</h1>');
    expect(result.html).toContain('<table>');
    expect(result.html).toContain('<math');
    expect(result.html).toContain('最后一段。');
    expect(result.html).not.toContain('author: 张三');
    expect(result.html).not.toContain('<!--more-->');
    expect(new DOMParser().parseFromString(result.html, 'text/html').querySelector('pre')?.textContent).toContain('<!--more-->');
    expect(new DOMParser().parseFromString(result.html, 'text/html').body.textContent).toContain('<script>alert(2)</script>');
    expect(result.html).not.toContain('<script>');
    expect(result.html).not.toContain('app-menu-bar');
    expect(result.html).toContain('Content-Security-Policy');
  });

  it('embeds readable local images and warns about missing and remote images', async () => {
    invoke.mockImplementation(async (_command: string, args?: { imagePath?: string }) => {
      if (!_command) return undefined;
      if (args?.imagePath?.endsWith('found.png')) return { mime: 'image/png', bytes: [137, 80, 78, 71] };
      return Promise.reject(new Error('not found'));
    });
    const source = '![图](文章.assets/found.png)\n\n![缺失](missing.png)\n\n![远程](https://example.com/a.png)';
    const html = await renderExportDocument({ ...base, source });
    expect(html.html).toContain('data:image/png;base64,iVBORw==');
    expect(html.html).toContain('图片未找到：missing.png');
    expect(html.html).toContain('https://example.com/a.png');
    expect(html.warnings.some((warning) => warning.includes('远程图片依赖网络'))).toBe(true);
    const pdf = await renderExportDocument({ ...base, source, format: 'pdf' });
    expect(pdf.html).not.toContain('src="https://example.com/a.png"');
  });

  it('shows invalid frontmatter instead of silently dropping it', async () => {
    const result = await renderExportDocument({ ...base, source: '---\ntitle: [broken\n---\n\n# 正文' });
    expect(new DOMParser().parseFromString(result.html, 'text/html').querySelector('pre')?.textContent).toContain('title: [broken');
    expect(result.warnings).toContain('Front Matter 无效，已作为原始文本输出。');
  });

  it('uses configured asset-relative directory and disables executable links', async () => {
    invoke.mockResolvedValue({ mime: 'image/png', bytes: [1, 2, 3] });
    const result = await renderExportDocument({ ...base, referenceStyle: 'asset-relative',
      source: '![图](图片.png)\n\n[不能执行](javascript:alert%281%29)\n\n<!-- more -->' });
    expect(invoke).toHaveBeenCalledWith('read_document_image', {
      documentPath: base.documentPath, imagePath: '文章.assets/图片.png',
    });
    expect(result.html).toContain('data:image/png;base64,AQID');
    expect(result.html).not.toContain('href="javascript:');
    expect(result.html).not.toContain('<!-- more -->');
  });

  it('reads repeated images once per export but refreshes the next export', async () => {
    let value = 'data:image/png;base64,FIRST';
    const image = vi.fn(async () => value);
    const options = { ...base, source: '![甲](same.png)\n\n![乙](same.png)' };
    const first = await renderExportDocument(options, { image });
    expect(image).toHaveBeenCalledTimes(1);
    expect(first.html.match(/base64,FIRST/g)).toHaveLength(2);
    value = 'data:image/png;base64,SECOND';
    const next = await renderExportDocument({ ...options, source: options.source + '\n\n新正文' }, { image });
    expect(image).toHaveBeenCalledTimes(2);
    expect(next.html).toContain('新正文');
    expect(next.html).toContain('base64,SECOND');
    expect(next.html).not.toContain('base64,FIRST');
  });
});
