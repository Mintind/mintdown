export type ImageReferenceStyle = 'relative' | 'asset-relative';

const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const invalid = /[<>:"|?*\x00-\x1f]/;

export function resolveImageDirectory(template: string, documentName: string): string {
  const filename = documentName.replace(/\.(?:md|markdown)$/i, '');
  if (!filename) throw new Error('文档文件名无效');
  const value = template.replaceAll('${filename}', filename).replaceAll('\\', '/');
  if (!value || value.startsWith('/') || /^[a-z]:/i.test(value) || value.includes('${')) throw new Error('资源目录必须是相对路径');
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || invalid.test(part) || reserved.test(part) || /[. ]$/.test(part)))
    throw new Error('资源目录包含非法或越界路径');
  return parts.join('/');
}

export function imageReference(directory: string, name: string, style: ImageReferenceStyle): string {
  const path = style === 'relative' ? `${directory}/${name}` : name;
  return `![](${path.split('/').map(encodeURIComponent).join('/')})`;
}

export function imageSettingsPreview(template: string, style: ImageReferenceStyle, documentPath: string | null): { folder: string; markdown: string } {
  const path = documentPath ?? 'article.md';
  const name = path.split(/[\\/]/).pop() || 'article.md';
  const folder = resolveImageDirectory(template, name);
  const parent = path.slice(0, path.length - name.length);
  return { folder: `${parent}${folder.replaceAll('/', '\\')}`, markdown: imageReference(folder, 'image.png', style) };
}
