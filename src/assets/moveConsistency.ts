import { DocumentSession } from '../document/DocumentSession';
import { imageUrlChanges } from './imageReferences';

type Reference = { oldUrl: string; newUrl: string };

/** Prepare the exact bytes that the native move will commit. Fail before touching disk. */
export function prepareMovedMarkdown(session: DocumentSession, source: string, references: Reference[],
  managedDirectories?: { before: string; after: string }) {
  const changes = imageUrlChanges(source, references);
  const changedUrls = new Set(references.filter(({ oldUrl, newUrl }) => oldUrl !== newUrl).map(({ oldUrl }) => oldUrl));
  for (const oldUrl of changedUrls) {
    if (!changes.some((change) => source.slice(change.from, change.to) === oldUrl))
      throw new Error(`迁移计划中的图片引用未能写入目标 Markdown：${oldUrl}`);
  }
  let targetSource = source;
  for (const change of [...changes].reverse())
    targetSource = targetSource.slice(0, change.from) + change.insert + targetSource.slice(change.to);
  if (managedDirectories && managedDirectories.before !== managedDirectories.after) {
    // A protected/raw Markdown region may contain an image that remark did not
    // expose as an image node. Never move its asset folder and strand the link.
    const oldPrefix = managedDirectories.before.split('/').map(encodeURIComponent).join('/') + '/';
    const escaped = oldPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`!\\[[^\\r\\n]*?\\]\\(\\s*<?${escaped}`, 'u').test(targetSource))
      throw new Error('仍有无法安全改写的旧资源目录图片引用；迁移已取消，请先在源码模式检查');
  }
  const staged = new DocumentSession(session.toBytes());
  staged.setSource(targetSource);
  const bytes = staged.toBytes();
  const writtenSource = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0));
  if (writtenSource.replace(/\r\n/g, '\n') !== targetSource.replace(/\r\n/g, '\n'))
    throw new Error('目标 Markdown 写盘字节与迁移预览不一致');
  return { targetSource, bytes, changes };
}
