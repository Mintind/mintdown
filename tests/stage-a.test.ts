import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DocumentSession } from '../src/document/DocumentSession';
import { parseSegments, type Segment } from '../src/markdown/segments';

const fixture = (name: string) => new Uint8Array(readFileSync(resolve('tests/fixtures', name)));
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const replaceSegment = (session: DocumentSession, segment: Segment, replacement: string) => {
  const source = session.getSource();
  session.setSource(source.slice(0, segment.start) + replacement + source.slice(segment.end));
};

describe('A01 原样保存', () => {
  it.each(['hexo-article.md', 'normal-article.md', 'unknown-block.md'])('%s 未编辑时字节不变', (name) => {
    const bytes = fixture(name);
    expect(new DocumentSession(bytes).toBytes()).toEqual(bytes);
  });

  it('保留 CRLF、UTF-8 BOM 和末尾换行；拒绝非法 UTF-8', () => {
    const original = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('---\r\ntitle: 测试\r\n---\r\n\r\n正文\r\n')]);
    const session = new DocumentSession(original);
    expect(session.toBytes()).toEqual(original);
    const paragraph = session.getSegments().find((part) => part.original === '正文')!;
    replaceSegment(session, paragraph, '正文已修改');
    const saved = session.toBytes();
    expect(saved.slice(0, 3)).toEqual(new Uint8Array([0xef, 0xbb, 0xbf]));
    expect(text(saved)).toContain('title: 测试\r\n---\r\n\r\n正文已修改\r\n');
    expect(() => new DocumentSession(new Uint8Array([0xff]))).toThrow();
  });
});

describe('A02–A05 受保护语法', () => {
  it('Hexo 正文编辑后保留 Front Matter、more、代码内标记、HTML 和注释的原始内容与顺序', () => {
    const original = text(fixture('hexo-article.md'));
    const session = DocumentSession.fromText(original);
    const segments = session.getSegments();
    expect(segments.filter((part) => part.kind === 'raw' && part.original === '<!--more-->')).toHaveLength(1);
    expect(segments.filter((part) => part.kind === 'frontmatter')).toHaveLength(1);
    expect(segments.some((part) => part.kind === 'raw' && part.original.includes('<div'))).toBe(true);
    const code = segments.find((part) => part.original.startsWith('```html'))!;
    expect(code.kind).toBe('milkdown');
    expect(code.original).toContain('<!--more-->');

    const paragraph = segments.find((part) => part.original.includes('这里应保持结构'))!;
    replaceSegment(session, paragraph, '这里已修改结构，摘要分隔符仍须保留。');
    const reopened = new DocumentSession(session.toBytes());
    const saved = reopened.getSource();
    expect(saved).toContain('这里已修改结构');
    expect(saved.match(/<!--more-->/g)).toHaveLength(3);
    expect(reopened.getSegments().filter((part) => part.kind === 'raw' && part.original === '<!--more-->')).toHaveLength(1);
    expect(saved.indexOf('\n<!--more-->\n')).toBeLessThan(saved.indexOf('## 正文'));
    expect(saved.slice(0, original.indexOf('# Hexo'))).toBe(original.slice(0, original.indexOf('# Hexo')));
    expect(saved).toContain('<div data-name="raw-block">\n  保留的 HTML 片段\n</div>');
    expect(saved).toContain('<!-- some-unrecognized-comment: do-not-drop -->');
  });

  it('兼容带空格的 more 标记并保留原样，围栏内不转换', () => {
    const source = '# 标题\n\n<!-- more -->\n\n```html\n<!--more-->\n```\n';
    const segments = parseSegments(source);
    expect(segments.filter((part) => part.kind === 'raw' && part.original === '<!-- more -->').map((part) => part.original)).toEqual(['<!-- more -->']);
    expect(segments.find((part) => part.original.startsWith('```'))?.kind).toBe('milkdown');
    const session = DocumentSession.fromText(source);
    replaceSegment(session, segments[0], '# 新标题');
    expect(session.getSource()).toContain('<!-- more -->\n\n```html\n<!--more-->');
  });

  it('未知扩展和行内 HTML 原文不被静默送入 Milkdown', () => {
    const original = text(fixture('unknown-block.md'));
    const session = DocumentSession.fromText(original);
    const protectedParts = session.getSegments().filter((part) => part.kind === 'raw');
    expect(protectedParts.length).toBeGreaterThanOrEqual(3);
    expect(protectedParts.some((part) => part.original.includes('{% unknown_hexo_extension'))).toBe(true);
    expect(protectedParts.some((part) => part.original.includes('<kbd>'))).toBe(true);
    const paragraph = session.getSegments().find((part) => part.original.includes('正常段落 A'))!;
    replaceSegment(session, paragraph, '正常段落 A（已修改）。');
    const saved = new DocumentSession(session.toBytes()).getSource();
    for (const part of protectedParts) expect(saved).toContain(part.original);
    expect(protectedParts.every((part) => saved.includes(part.original))).toBe(true);
  });

  it('受保护内容在源码模式可修改，再切回可视分段且原文保留', () => {
    const session = DocumentSession.fromText('# 标题\n\n<!--more-->\n');
    session.setSource(session.getSource().replace('<!--more-->', '<!-- more -->'));
    expect(session.getSegments().find((part) => part.kind === 'raw' && part.original === '<!-- more -->')?.original).toBe('<!-- more -->');
    expect(new DocumentSession(session.toBytes()).getSource()).toContain('<!-- more -->');
  });
});

describe('A06 GFM/数学 AST', () => {
  it('表格、任务列表由 Milkdown 路径处理；公式走 KaTeX 预览路径', () => {
    const segments = parseSegments(text(fixture('normal-article.md')));
    expect(segments.some((part) => part.kind === 'milkdown' && part.original.startsWith('| 项目'))).toBe(true);
    expect(segments.some((part) => part.kind === 'milkdown' && part.original.includes('- [x]'))).toBe(true);
    expect(segments.filter((part) => part.kind === 'math')).toHaveLength(2);
    const session = new DocumentSession(fixture('normal-article.md'));
    const heading = segments.find((part) => part.original === '# 普通 Markdown')!;
    replaceSegment(session, heading, '# 修改后');
    const reopened = new DocumentSession(session.toBytes());
    expect(reopened.getSource()).toContain('$E=mc^2$');
    expect(reopened.getSource()).toContain('\\sum_{i=1}^{n}');
    expect(reopened.getSource()).toContain('| :--- | ---: |');
    expect(reopened.getSource()).toContain('![中文文件](<normal-article.assets/测试 图片.png>)');
  });
});
