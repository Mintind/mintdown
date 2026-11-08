import { invoke } from '@tauri-apps/api/core';
import { resolveImageDirectory, type ImageReferenceStyle } from '../assets/imagePaths';

let documentPath: string | null = null;
let sessionId = '';
let directoryTemplate = '${filename}.assets';
let referenceStyle: ImageReferenceStyle = 'relative';
const cache = new Map<string, Promise<string>>();
const resolved = new Map<string, string>();
let previewGeneration = 0;

export function imagePreviewGeneration(): number { return previewGeneration; }

export function setPreviewDocumentPath(path: string | null): void {
  if (path === documentPath) return;
  documentPath = path;
  for (const pending of cache.values()) void pending.then((url) => URL.revokeObjectURL(url), () => {});
  cache.clear();
  resolved.clear();
}

export function setPreviewAssetContext(path: string | null, session: string, template: string, style: ImageReferenceStyle): void {
  const changed = path !== documentPath || session !== sessionId || template !== directoryTemplate || style !== referenceStyle;
  if (!changed) return;
  previewGeneration++;
  setPreviewDocumentPath(path);
  sessionId = session;
  directoryTemplate = template;
  referenceStyle = style;
  for (const pending of cache.values()) void pending.then((url) => URL.revokeObjectURL(url), () => {});
  cache.clear();
  resolved.clear();
}

export function cachedPreviewImageUrl(raw: string): string | undefined {
  if (/^https?:\/\//i.test(raw)) return raw;
  let imagePath: string;
  try { imagePath = decodeURIComponent(raw); } catch { return undefined; }
  return resolved.get(`${documentPath}\0${sessionId}\0${directoryTemplate}\0${referenceStyle}\0${imagePath}`);
}

export function retryPreviewImageUrl(raw: string): Promise<string> {
  let imagePath: string;
  try { imagePath = decodeURIComponent(raw); } catch { return Promise.reject(new Error('图片路径编码无效')); }
  const key = `${documentPath}\0${sessionId}\0${directoryTemplate}\0${referenceStyle}\0${imagePath}`;
  const previous = cache.get(key);
  cache.delete(key); resolved.delete(key);
  if (previous) void previous.then((url) => window.setTimeout(() => URL.revokeObjectURL(url), 30_000), () => {});
  return previewImageUrl(raw);
}

export function imagePreviewFailure(cause: unknown): string {
  const problem = cause && typeof cause === 'object' ? cause as { kind?: string; message?: string } : null;
  if (problem?.kind === 'not_found') return '图片未找到';
  if (problem?.kind === 'permission_denied') return '无权读取图片';
  if (problem?.kind === 'invalid_image' || problem?.message?.includes('无法解码')) return '图片无法解码';
  return '图片无法显示';
}

/** Native bridge reads only bounded raster files; relative paths may point outside the document directory. */
export function previewImageUrl(raw: string): Promise<string> {
  if (/^https?:\/\//i.test(raw)) return Promise.resolve(raw);
  if (/^[a-z][a-z\d+.-]*:/i.test(raw)) return Promise.reject(new Error('不支持此图片路径'));
  let imagePath: string;
  try { imagePath = decodeURIComponent(raw); }
  catch { return Promise.reject(new Error('图片路径编码无效')); }
  const key = `${documentPath}\0${sessionId}\0${directoryTemplate}\0${referenceStyle}\0${imagePath}`;
  let cached = cache.get(key);
  if (!cached) {
    const filename = documentPath?.split(/[\\/]/).pop() || 'untitled.md';
    let candidates = [imagePath];
    if (referenceStyle === 'asset-relative' && !imagePath.startsWith('./') && !imagePath.startsWith('../')) {
      try { candidates = [`${resolveImageDirectory(directoryTemplate, filename)}/${imagePath}`, imagePath]; }
      catch { /* An invalid new template must not hide an existing image. */ }
    }
    const read = async () => {
      let lastError: unknown;
      for (const candidate of candidates) {
        try {
          return documentPath
            ? await invoke<{ mime: string; bytes: number[] }>('read_document_image', { documentPath, imagePath: candidate })
            : await invoke<{ mime: string; bytes: number[] }>('read_draft_document_image', { sessionId, imagePath: candidate });
        } catch (cause) {
          if (!lastError || (lastError as { kind?: string })?.kind === 'not_found') lastError = cause;
        }
      }
      throw lastError ?? new Error('图片未找到');
    };
    cached = read().then(({ mime, bytes }) => {
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
      if (cache.get(key) === cached) resolved.set(key, url);
      return url;
    });
    cache.set(key, cached);
    if (cache.size > 64) {
      const oldest = cache.keys().next().value;
      if (oldest && oldest !== key) {
        const old = cache.get(oldest)!;
        cache.delete(oldest);
        resolved.delete(oldest);
        // A pending image may still be assigning this URL to its DOM node.
        // Revoke after the browser has had time to finish the load.
        void old.then((url) => window.setTimeout(() => URL.revokeObjectURL(url), 30_000), () => {});
      }
    }
  }
  return cached;
}
