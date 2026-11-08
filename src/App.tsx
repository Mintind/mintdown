import { useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { DesktopApp } from './native/DesktopApp';
import { DocumentSession } from './document/DocumentSession';
import { UnifiedMilkdown } from './editor/UnifiedMilkdown';
import { SourceEditor } from './editor/SourceEditor';
import './style.css';

export function App({ initialSession }: { initialSession?: DocumentSession }) {
  return isTauri() ? <DesktopApp /> : <BrowserApp initialSession={initialSession} />;
}

function BrowserApp({ initialSession }: { initialSession?: DocumentSession }) {
  const [session, setSession] = useState(() => initialSession ?? DocumentSession.fromText('# 编辑引擎验证\n\n打开本地 Markdown 文件开始。\n'));
  const [fileName, setFileName] = useState('untitled.md');
  const [documentRevision, setDocumentRevision] = useState(0);
  const [mode, setMode] = useState<'visual' | 'source'>('visual');
  const [error, setError] = useState('');
  const [, refresh] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const openFile = async (file: File) => {
    try {
      setSession(new DocumentSession(new Uint8Array(await file.arrayBuffer())));
      setDocumentRevision((revision) => revision + 1);
      setFileName(file.name);
      setError('');
      setMode('visual');
    } catch (cause) {
      setError(`打开失败：${String(cause)}`);
    }
  };

  const download = () => {
    if (error && mode === 'visual') return;
    const bytes = session.toBytes();
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const url = URL.createObjectURL(new Blob([copy], { type: 'text/markdown' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return <main>
    <header>
      <strong>Markdown 连续编辑验证 · 阶段 B0</strong>
      <span>{fileName}{session.isDirty() ? ' · 未保存' : ''}</span>
      <button onClick={() => fileInput.current?.click()}>打开文件</button>
      <input ref={fileInput} hidden type="file" accept=".md,.markdown,text/markdown" onChange={(event) => { const file = event.target.files?.[0]; if (file) void openFile(file); }} />
      <button disabled={Boolean(error) && mode === 'visual'} onClick={() => { setMode(mode === 'visual' ? 'source' : 'visual'); setError(''); }}>{mode === 'visual' ? '源码模式' : '可视模式'}</button>
      <button disabled={Boolean(error) && mode === 'visual'} onClick={download}>下载当前内容</button>
    </header>
    {error && <p role="alert" className="error">{error}</p>}
    <p className="hint">这是阶段 B0 的连续编辑验证原型。保存会下载文件；原生磁盘保存属于阶段 B。</p>
    {mode === 'source'
      ? <SourceEditor key="source" initialSource={session.getSource()} onEdit={(source) => { try { session.setSource(source); refresh((count) => count + 1); setError(''); } catch (cause) { setError(String(cause)); } }} />
      : <section className="visual-editor" data-testid="visual-editor">
          <UnifiedMilkdown key={documentRevision} initialSource={session.getSource()} onEdit={(source, problem) => {
            if (problem) { setError(problem); return; }
            try { session.setSource(source); setError(''); refresh((count) => count + 1); }
            catch (cause) { setError(`无法安全保存可视编辑结果：${String(cause)}`); }
          }} onUnsafeOpen={(reason) => { setError(`${reason}。已回退完整源码模式。`); setMode('source'); }} />
        </section>}
  </main>;
}
