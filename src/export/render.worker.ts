import { renderExportDocument, type ExportOptions } from './renderDocument';
let serial = 0;
const images = new Map<number, { resolve: (value: string) => void; reject: (cause: Error) => void }>();
let queue = Promise.resolve();
self.onmessage = ({ data }) => {
  if (data.type === 'image-result') {
    const item = images.get(data.request); images.delete(data.request);
    if (data.error) item?.reject(new Error(data.error)); else item?.resolve(data.value);
    return;
  }
  if (data.type !== 'render') return;
  const { id, options }: { id: number; options: ExportOptions } = data;
  queue = queue.then(async () => {
    try {
      const result = await renderExportDocument(options, {
        progress: message => self.postMessage({ id, type: 'progress', message }),
        image: (candidate, opts) => new Promise((resolve, reject) => {
          const request = ++serial; images.set(request, { resolve, reject });
          self.postMessage({ id, type: 'image', request, candidate, documentPath: opts.documentPath, sessionId: opts.sessionId });
        }),
      });
      self.postMessage({ id, type: 'result', result });
    } catch (cause) { self.postMessage({ id, type: 'error', message: String(cause) }); }
  });
};
