import { invoke } from '@tauri-apps/api/core';
import { renderExportDocument, type ExportDocument, type ExportOptions } from './renderDocument';

let worker: Worker | undefined, serial = 0, idle: ReturnType<typeof setTimeout> | undefined;
const pending = new Map<number, { resolve: (value: ExportDocument) => void; reject: (cause: Error) => void; progress?: (message: string) => void }>();
export function needsExportWorker(source: string): boolean {
  return source.length > 12_000 || (source.match(/!\[/g)?.length ?? 0) > 4 || (source.match(/\$/g)?.length ?? 0) > 40;
}
const image = (candidate: string, options: Pick<ExportOptions, 'documentPath' | 'sessionId'>) =>
  invoke<string>('read_export_image', { documentPath: options.documentPath, sessionId: options.sessionId, imagePath: candidate });
function getWorker(): Worker {
  clearTimeout(idle);
  if (worker) return worker;
  const url = new URL('./render.worker.ts', import.meta.url);
  // Offscreen native benchmarks import the dev module across origins. Production
  // uses Vite's normal bundled worker and never this dev-only transport.
  if (import.meta.env.DEV && url.origin !== location.origin) {
    const blob = URL.createObjectURL(new Blob([`import ${JSON.stringify(url.href)};`], { type: 'text/javascript' }));
    worker = new Worker(blob, { type: 'module' }); URL.revokeObjectURL(blob);
  } else worker = new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = async ({ data }) => {
    const item = pending.get(data.id); if (!item) return;
    if (data.type === 'progress') item.progress?.(data.message);
    else if (data.type === 'image') {
      const current = worker!;
      try { current.postMessage({ type: 'image-result', request: data.request, value: await image(data.candidate, data) }); }
      catch (cause) { current.postMessage({ type: 'image-result', request: data.request, error: String((cause as { message?: string }).message ?? cause) }); }
    } else {
      pending.delete(data.id);
      if (data.type === 'result') item.resolve(data.result); else item.reject(new Error(data.message));
      if (!pending.size) idle = setTimeout(() => { worker?.terminate(); worker = undefined; }, 60_000);
    }
  };
  worker.onerror = event => {
    for (const item of pending.values()) item.reject(new Error(`导出渲染失败：${event.message}`));
    pending.clear(); worker?.terminate(); worker = undefined;
  };
  return worker;
}
export function renderDocumentForExport(options: ExportOptions, progress?: (message: string) => void): Promise<ExportDocument> {
  if (!needsExportWorker(options.source)) return renderExportDocument(options, { image, progress });
  const current = getWorker(), id = ++serial;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject, progress }); current.postMessage({ id, type: 'render', options }); });
}
if (import.meta.env.VITE_NATIVE_TEST === '1') Object.assign(window, { __MINTDOWN_RENDER_EXPORT__: renderDocumentForExport });
