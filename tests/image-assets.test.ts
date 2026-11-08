import { expect, it } from 'vitest';
import { imageReference, imageSettingsPreview, resolveImageDirectory } from '../src/assets/imagePaths';
import { imageUrlChangeAt, imageUrlChanges, imageUrls, rewriteImageUrls } from '../src/assets/imageReferences';
import { defaultPreferences, readPreferences, writePreferences } from '../src/ui/preferences';
import { archiveNameForFile } from '../src/assets/imageNames';
import { prepareMovedMarkdown } from '../src/assets/moveConsistency';
import { DocumentSession } from '../src/document/DocumentSession';

it('resolves both presets and two custom folders independently of reference format', () => {
  expect(resolveImageDirectory('${filename}', 'article.md')).toBe('article');
  expect(resolveImageDirectory('${filename}.assets', 'article.md')).toBe('article.assets');
  expect(resolveImageDirectory('${filename}.assets', 'article.markdown')).toBe('article.assets');
  expect(resolveImageDirectory('images/${filename}', 'article.md')).toBe('images/article');
  expect(resolveImageDirectory('assets', 'article.md')).toBe('assets');
  expect(imageReference('images/article', 'my image.png', 'relative')).toBe('![](images/article/my%20image.png)');
  expect(imageReference('images/article', 'my image.png', 'asset-relative')).toBe('![](my%20image.png)');
  expect(imageSettingsPreview('images/${filename}', 'relative', 'D:\\posts\\文章.md')).toEqual({
    folder: 'D:\\posts\\images\\文章', markdown: '![](images/%E6%96%87%E7%AB%A0/image.png)',
  });
});

it('names clipboard bitmaps with a millisecond timestamp and keeps real file names', () => {
  const now = new Date(2026, 9, 30, 12, 22, 31, 482);
  expect(archiveNameForFile('image.png', 'paste', now)).toBe('image-20261030-122231-482.png');
  expect(archiveNameForFile('', 'paste', now)).toBe('image-20261030-122231-482.png');
  expect(archiveNameForFile('diagram.png', 'paste', now)).toBe('diagram.png');
  expect(archiveNameForFile('image.png', 'drop', now)).toBe('image.png');
});

it('rejects unsafe templates and only rewrites parsed image URLs', () => {
  for (const template of ['', '../outside', 'C:/outside', '/absolute', 'images//article', 'CON', 'assets/${other}'])
    expect(() => resolveImageDirectory(template, 'article.md')).toThrow();
  const source = '![图](article.assets/my%20image.png)\n\n`![](article.assets/my%20image.png)`\n\n<!--more-->\n';
  expect(imageUrls(source)).toEqual(['article.assets/my%20image.png']);
  const mappings = [{ oldUrl: 'article.assets/my%20image.png', newUrl: 'images/copy/my%20image.png' }];
  expect(imageUrlChanges(source, mappings)).toHaveLength(1);
  expect(imageUrlChanges(source, [{ oldUrl: 'article.assets/my%20image.png', newUrl: 'article.assets/my%20image.png' }])).toHaveLength(0);
  expect(rewriteImageUrls(source, mappings)).toBe('![图](images/copy/my%20image.png)\n\n`![](article.assets/my%20image.png)`\n\n<!--more-->\n');
});

it('relinks only the clicked image and leaves identical references elsewhere untouched', () => {
  const source = '![一](missing.png)\n![二](missing.png)\n`![示例](missing.png)`';
  const from = source.indexOf('![二]');
  const change = imageUrlChangeAt(source, from, from + '![二](missing.png)'.length,
    'missing.png', 'article.assets/new.png');
  const edited = source.slice(0, change.from) + change.insert + source.slice(change.to);
  expect(edited).toBe('![一](missing.png)\n![二](article.assets/new.png)\n`![示例](missing.png)`');
  expect(() => imageUrlChangeAt(source, from, from + 1, 'missing.png', 'new.png')).toThrow();
});

it('commits exactly the previewed renamed Markdown, including repeated references and BOM/CRLF', () => {
  const before = '\ufeff# 标题\r\n\r\n![一](VSCode2test3.assets/image.png)\r\n![二](VSCode2test3.assets/image.png)\r\n![外部](other.png)\r\n![网络](https://example.com/a.png)\r\n```md\r\n![代码](VSCode2test3.assets/image.png)\r\n```\r\n';
  const session = new DocumentSession(new TextEncoder().encode(before));
  const plan = [{ oldUrl: 'VSCode2test3.assets/image.png', newUrl: 'VSCode2test4.assets/image.png' }];
  const prepared = prepareMovedMarkdown(session, session.getSource(), plan);
  expect(prepared.changes).toHaveLength(2);
  expect(prepared.targetSource).toContain('![一](VSCode2test4.assets/image.png)');
  expect(prepared.targetSource).toContain('![二](VSCode2test4.assets/image.png)');
  expect(prepared.targetSource).toContain('![代码](VSCode2test3.assets/image.png)');
  expect([...prepared.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  expect(new TextDecoder().decode(prepared.bytes)).toBe(before.slice(1).replaceAll('![一](VSCode2test3.assets/', '![一](VSCode2test4.assets/')
    .replaceAll('![二](VSCode2test3.assets/', '![二](VSCode2test4.assets/'));
  expect(() => prepareMovedMarkdown(session, session.getSource(), [{ oldUrl: 'not-present.png', newUrl: 'new.png' }])).toThrow();
  const raw = DocumentSession.fromText('<div>\n![未解析](VSCode2test3.assets/image.png)\n</div>\n');
  expect(imageUrls(raw.getSource())).toEqual([]);
  expect(() => prepareMovedMarkdown(raw, raw.getSource(), [],
    { before: 'VSCode2test3.assets', after: 'VSCode2test4.assets' })).toThrow('无法安全改写');
});

it('persists directory template and reference style independently', () => {
  const saved = { ...defaultPreferences, imageDirectoryTemplate: 'assets/${filename}', imageReferenceStyle: 'asset-relative' as const };
  writePreferences(saved);
  expect(readPreferences()).toMatchObject({ imageDirectoryTemplate: 'assets/${filename}', imageReferenceStyle: 'asset-relative' });
  writePreferences({ ...saved, imageDirectoryTemplate: '${filename}' });
  expect(readPreferences()).toMatchObject({ imageDirectoryTemplate: '${filename}', imageReferenceStyle: 'asset-relative' });
  localStorage.clear();
});
