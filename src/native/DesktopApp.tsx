import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { ask, message as dialogMessage, open, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { EditorView as CodeMirrorView } from 'codemirror';
import { isolateHistory } from '@codemirror/commands';
import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView as ProseMirrorView } from '@milkdown/kit/prose/view';
import { DocumentSession } from '../document/DocumentSession';
import { renderDocumentForExport } from '../export/workerClient';
import { CanonicalEditor } from '../editor/CanonicalEditor';
import { imageReferenceExamples, imageUrlChangeAt, imageUrlChanges, imageUrls, rewriteImageUrls } from '../assets/imageReferences';
import { prepareMovedMarkdown } from '../assets/moveConsistency';
import { archiveNameForFile } from '../assets/imageNames';
import { resolveImageDirectory } from '../assets/imagePaths';
import type { ImageSyntax } from '../editor/localPreview';
import { PerformanceGovernor, type RenderTier } from '../editor/performancePolicy';
import { insertLinkTemplate } from '../editor/linkEditing';
import { runVisualSourceSearch, updateVisualSourceSearch } from '../editor/visualSourceSearch';
import { SourceEditor } from '../editor/SourceEditor';
import { UnifiedMilkdown } from '../editor/UnifiedMilkdown';
import { sourceToVisualPosition, visualToSourcePosition } from '../editor/cursorMapping';
import { explainNativeError, nativeFiles, type ImageCopyPlan, type MissingImage, type MovePlan, type OpenedDocument, type RecoverySnapshot, type RelinkArchivePreview } from './fileBridge';
import { nativeSession, validPosition, type SessionPosition, type SessionTab, type WindowSession } from './sessionBridge';
import { EditorChrome, type MenuGroup } from '../ui/EditorChrome';
import { buildDescription } from '../ui/buildInfo';
import { redoEditor, setSourceHeading, setVisualHeading, toggleSourceFormat, toggleVisualFormat, undoEditor, type TextFormat } from '../ui/editorCommands';
import { activeHeadingIndex, outlineFromDocument, outlineFromMarkdown, sameOutline, type OutlineHeading } from '../ui/outline';
import { clampFontSize, clampWritingWidth, readPreferences, writePreferences } from '../ui/preferences';
import { runSearchAction, updateSearch, type SearchOptions, type SearchStatus } from '../ui/searchCommands';

type Mode = 'visual' | 'source';
type TabRecord = SessionTab & { dirty?: boolean; initialOpened?: OpenedDocument };
type TabActions = { dirty: () => boolean; flush: () => Promise<void>; saveForClose: () => Promise<boolean>;
  saveAs: () => Promise<boolean>; move: () => Promise<void>; relink: () => Promise<void>; discard: () => Promise<void>;
  exportDocument: (format: 'html' | 'pdf') => Promise<void> };
type ExportNotice = { id: string; name: string; phase: 'working' | 'success' | 'error'; message: string; details?: string[] };
type RelinkPreview = { source: string; path: string; fingerprint: string; folder: string; template: string; style: string;
  entries: MissingImage[]; choices: Record<string, number>; scannedFiles: number; alreadyValid: number; previewFailedUrls: string[] };
type OperationResult = { title: string; summary: string; note?: string; details?: string[] };

function selectedRelinks(plan: RelinkPreview) {
  return plan.entries.flatMap((entry) => {
    const selectedPath = plan.choices[entry.oldUrl];
    const candidate = entry.candidates[selectedPath ?? (entry.candidates.length === 1 ? 0 : -1)];
    return candidate && candidate.newUrl !== entry.oldUrl ? [{ oldUrl: entry.oldUrl, ...candidate }] : [];
  });
}

async function refreshRelinkPlan(plan: RelinkPreview, source: string, template: string, style: string): Promise<RelinkPreview> {
  const scan = await nativeFiles.scanMissingImages(plan.path, template, style, plan.folder, imageUrls(source), plan.previewFailedUrls);
  const previous = selectedRelinks(plan);
  const entries = await Promise.all(scan.entries.map(async (entry) => {
    const chosen = previous.find((item) => item.oldUrl === entry.oldUrl);
    if (!chosen || entry.candidates.some((candidate) => candidate.path === chosen.path)) return entry;
    try {
      const candidate = await nativeFiles.chooseRelinkImage(plan.path, style, chosen.path);
      return { ...entry, candidates: [...entry.candidates, candidate] };
    } catch { return entry; }
  }));
  const choices = Object.fromEntries(entries.map((entry) => [entry.oldUrl,
    entry.candidates.findIndex((candidate) => candidate.path === previous.find((item) => item.oldUrl === entry.oldUrl)?.path)]));
  return { ...plan, source, template, style, entries, choices, scannedFiles: scan.scannedFiles, alreadyValid: scan.alreadyValid };
}

function equivalentRelinks(before: RelinkPreview, after: RelinkPreview): boolean {
  const signature = (plan: RelinkPreview) => JSON.stringify({
    missing: plan.entries.map((entry) => [entry.oldUrl,
      entry.candidates.map((candidate) => [candidate.path, candidate.newUrl]).sort()]).sort(),
    selected: selectedRelinks(plan).map(({ oldUrl, path, newUrl }) => [oldUrl, path, newUrl]).sort(),
  });
  return signature(before) === signature(after);
}

function sameMoveResult(left: MovePlan, right: MovePlan): boolean {
  const signature = (plan: MovePlan) => JSON.stringify({
    references: plan.references.map(({ oldUrl, newUrl }) => [oldUrl, newUrl]).sort(),
    unresolved: [...plan.unresolved].sort(), resources: [...plan.resourceTargets].sort(),
    operations: plan.resourceOperations.map(({ source, target, action }) => [source, target, action]).sort(), targetExists: plan.targetExists,
  });
  return signature(left) === signature(right);
}
type TabProps = {
  tab: TabRecord; active: boolean; preferencesActive: boolean;
  onOpenPreferences: () => void; onClosePreferences: () => void;
  preferences: ReturnType<typeof readPreferences>;
  setPreferences: (next: ReturnType<typeof readPreferences>) => void;
  onPathChange: (id: string, path: string | null) => void;
  onDirtyChange: (id: string, dirty: boolean) => void;
  onLoaded: (id: string) => void;
  onOpenPath: (path: string) => Promise<void>;
  onNewTab: () => void;
  onCloseTab: (id: string) => void;
  onActionsChange: (id: string, actions: TabActions | null) => void;
  onPositionChange: (id: string, position: Partial<SessionPosition>) => void;
  onExportNotice: (id: string, notice: ExportNotice | null) => void;
};

function basename(path: string): string { return path.split(/[\\/]/).pop() || 'untitled.md'; }
function readableWindowsPath(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) return `\\\\${path.slice(8)}`;
  return path.startsWith('\\\\?\\') ? path.slice(4) : path;
}
function recoveryReason(cause: unknown): string {
  const error = explainNativeError(cause);
  if (error.kind === 'not_found') return '文件不存在或已移动';
  if (error.kind === 'permission_denied') return '没有读取权限';
  return error.message.length > 140 ? `${error.message.slice(0, 140)}…` : error.message;
}
function recoveryKey(path: string | null, windowLabel: string): string {
  return path ? `document:${path.replace(/\//g, '\\').toLowerCase()}` : windowLabel;
}

// Deterministic answers for offscreen native lifecycle tests. Production builds
// always use the Windows dialogs.
type RecoveryChoice = 'restore' | 'discard' | 'cancel';
type NativeTestDialogs = { ask?: (message: string) => boolean; recovery?: () => RecoveryChoice; save?: (options?: { defaultPath: string }) => string | null; openImage?: () => string | null; openFolder?: () => string | null };
function nativeTestDialogs(): NativeTestDialogs | undefined {
  return import.meta.env.DEV || import.meta.env.VITE_NATIVE_TEST === '1'
    ? (window as unknown as { __MINTDOWN_TEST_DIALOGS__?: NativeTestDialogs }).__MINTDOWN_TEST_DIALOGS__ : undefined;
}
function askToClose(message: string, title: string): Promise<boolean> {
  const answer = nativeTestDialogs()?.ask;
  return answer ? Promise.resolve(answer(message)) : ask(message, { title, kind: 'warning' });
}
async function chooseRecovery(message: string): Promise<RecoveryChoice> {
  const hooks = nativeTestDialogs();
  if (hooks?.recovery) return hooks.recovery();
  if (hooks?.ask) return hooks.ask(message) ? 'restore' : 'discard';
  // ask() turns both No and a closed dialog into false. Only explicit discard
  // may delete a snapshot; Cancel/close must leave it available for retry.
  const result = await dialogMessage(message, { title: '恢复编辑内容', kind: 'warning',
    buttons: { yes: '恢复', no: '放弃快照', cancel: '取消' } });
  return result === '恢复' || result === 'Yes' ? 'restore'
    : result === '放弃快照' || result === 'No' ? 'discard' : 'cancel';
}
function chooseSavePath(defaultPath: string): Promise<string | null> {
  const answer = nativeTestDialogs()?.save;
  return answer ? Promise.resolve(answer()) : saveDialog({ defaultPath, filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }] });
}
function chooseExportPath(defaultPath: string, format: 'html' | 'pdf'): Promise<string | null> {
  const answer = nativeTestDialogs()?.save;
  return answer ? Promise.resolve(answer({ defaultPath })) : saveDialog({ defaultPath,
    filters: [{ name: format === 'html' ? 'HTML 文档' : 'PDF 文档', extensions: [format] }] });
}
function chooseImagePath(): Promise<string | null> {
  const answer = nativeTestDialogs()?.openImage;
  return answer ? Promise.resolve(answer()) : open({ multiple: false, filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }] });
}
function chooseImageFolder(): Promise<string | null> {
  const answer = nativeTestDialogs()?.openFolder;
  return answer ? Promise.resolve(answer()) : open({ multiple: false, directory: true });
}

function placeHeadingNearTop(scroller: HTMLElement | null, headingTop: number | null): void {
  if (!scroller || headingTop === null) return;
  const viewportTop = scroller.getBoundingClientRect().top;
  const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  scroller.scrollTop = Math.max(0, Math.min(maxScroll, scroller.scrollTop + headingTop - viewportTop - 90));
}

function codeMirrorHeadingTop(view: CodeMirrorView, position: number): number {
  const { node } = view.domAtPos(position);
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest('.cm-line')?.getBoundingClientRect().top ??
    view.coordsAtPos(position)?.top ?? view.documentTop + view.lineBlockAt(position).top;
}

function placeCodeMirrorHeadingNearTop(view: CodeMirrorView, position: number): void {
  // Local preview decorations can change a line's height when the selection enters it.
  // Measure after CodeMirror has applied those decorations, before the next paint.
  view.requestMeasure({
    read: current => {
      const scroller = current.dom.closest<HTMLElement>('.editor-scroll');
      return scroller && current.state.selection.main.head === position
        ? scroller.scrollTop + codeMirrorHeadingTop(current, position) - scroller.getBoundingClientRect().top
        : null;
    },
    write: (offset, current) => {
      const scroller = current.dom.closest<HTMLElement>('.editor-scroll');
      if (!scroller || offset === null) return;
      scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, offset - 90));
    },
  });
}

function DocumentTabApp({ tab, active, preferencesActive, onOpenPreferences, onClosePreferences, preferences, setPreferences, onPathChange, onDirtyChange, onLoaded, onOpenPath, onNewTab, onCloseTab, onActionsChange, onPositionChange, onExportNotice }: TabProps) {
  const [session, setSession] = useState(() => DocumentSession.fromText(''));
  const [path, setPath] = useState<string | null>(null);
  const [fingerprint, setFingerprint] = useState('');
  const [mode, setMode] = useState<Mode>('visual');
  const modeRef = useRef<Mode>('visual');
  modeRef.current = mode;
  const [performanceTier, setPerformanceTier] = useState<RenderTier>('normal');
  const performanceTierRef = useRef<RenderTier>('normal');
  const governor = useRef(new PerformanceGovernor(''));
  const autoSource = useRef(false);
  const pendingTier = useRef<RenderTier | null>(null);
  const pointerDown = useRef(false);
  const lastEditAt = useRef(Date.now());
  const [revision, setRevision] = useState(0);
  const [documentRevision, setDocumentRevision] = useState(0);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [unsafeVisual, setUnsafeVisual] = useState(false);
  const [restoredState, setRestoredState] = useState<unknown>();
  const [ready, setReady] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [recoveryDeferred, setRecoveryDeferred] = useState(false);
  const recoveryDeferredRef = useRef(false);
  const [outline, setOutline] = useState<OutlineHeading[]>([]);
  const [activeHeading, setActiveHeading] = useState(-1);
  const [searchMode, setSearchMode] = useState<'find' | 'replace' | null>(null);
  const [searchOptions, setSearchOptions] = useState<SearchOptions>({ text: '', replace: '', caseSensitive: false, wholeWord: false, regexp: false });
  const [searchStatus, setSearchStatus] = useState<SearchStatus>({ total: 0, current: 0, valid: true });
  const [helpOpen, setHelpOpen] = useState(false);
  const [relinkPlan, setRelinkPlan] = useState<RelinkPreview | null>(null);
  const [relinkArchivePreview, setRelinkArchivePreview] = useState<RelinkArchivePreview | null>(null);
  const [relinkPreviewError, setRelinkPreviewError] = useState('');
  useEffect(() => {
    setRelinkArchivePreview(null);
    setRelinkPreviewError('');
    if (!relinkPlan) return;
    const selected = selectedRelinks(relinkPlan).map((item): [string, string] => [item.oldUrl, item.path]);
    if (!selected.length) return;
    let cancelled = false;
    void nativeFiles.previewRelinkArchives(relinkPlan.path, relinkPlan.template, relinkPlan.style, selected)
      .then((preview) => { if (!cancelled) setRelinkArchivePreview(preview); })
      .catch((cause) => { if (!cancelled) setRelinkPreviewError(explainNativeError(cause).message); });
    return () => { cancelled = true; };
  }, [relinkPlan]);
  const [operationResult, setOperationResult] = useState<OperationResult | null>(null);
  const resultButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (operationResult) resultButtonRef.current?.focus(); }, [operationResult]);
  const closeOperationResult = () => {
    setOperationResult(null);
    (canonicalView.current ?? sourceView.current)?.focus();
  };
  const [movePlan, setMovePlan] = useState<{ source: string; fingerprint: string; sourcePath: string; targetPath: string;
    template: string; style: string; plan: MovePlan } | null>(null);
  const [retainMissingOnMove, setRetainMissingOnMove] = useState(false);
  const movePlanRef = useRef<MovePlan | null>(null);
  useEffect(() => () => {
    if (movePlanRef.current) void nativeFiles.cancelMove(movePlanRef.current.token).catch(() => {});
  }, []);
  const imageFileInput = useRef<HTMLInputElement>(null);
  const visualView = useRef<ProseMirrorView | null>(null);
  const sourceView = useRef<CodeMirrorView | null>(null);
  const canonicalView = useRef<CodeMirrorView | null>(null);
  const outlineDocument = useRef<CodeMirrorView['state']['doc'] | null>(null);
  const outlineTimer = useRef<number | null>(null);
  const outlineRef = useRef(outline);
  outlineRef.current = outline;
  const initialPosition = useRef(validPosition(tab));
  const discarded = useRef(false);
  const pendingCursor = useRef<{ mode: Mode; anchor: number; head: number } | null>(null);
  const windowLabel = getCurrentWindow().label;
  const key = tab.id;
  const live = useRef({ session, path, fingerprint, unsafeVisual: false, visualState: null as unknown, conflict: false });
  live.current.session = session;
  live.current.path = path;
  live.current.fingerprint = fingerprint;
  live.current.conflict = conflict;

  const flushRecovery = useCallback(async () => {
    if (discarded.current || recoveryDeferredRef.current) return;
    const state = live.current;
    const snapshotKey = recoveryKey(state.path, key);
    if (!state.session.isDirty() && !state.unsafeVisual) {
      await nativeFiles.clearRecovery(snapshotKey);
      return;
    }
    const snapshot: RecoverySnapshot = {
      path: state.path ?? '', fingerprint: state.fingerprint,
      source: state.session.getSource(),
      visualState: state.unsafeVisual ? state.visualState : null,
      unsafeVisual: state.unsafeVisual,
      savedAt: new Date().toISOString(),
    };
    await nativeFiles.saveRecovery(snapshotKey, snapshot);
  }, [key]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const opened = (loadAttempt === 0 ? tab.initialOpened : undefined) ?? (tab.path ? await nativeFiles.open(tab.path) : null);
        const next = opened ? new DocumentSession(Uint8Array.from(opened.bytes)) : DocumentSession.fromText('');
        const primaryKey = recoveryKey(opened?.path ?? null, key);
        const primarySnapshot = await nativeFiles.loadRecovery(primaryKey);
        const legacySnapshot = primarySnapshot || primaryKey === key ? null : await nativeFiles.loadRecovery(key);
        const snapshot = primarySnapshot ?? (legacySnapshot?.path === opened?.path ? legacySnapshot : null);
        const snapshotKey = primarySnapshot ? primaryKey : key;
        if (cancelled) return;
        let restored: unknown;
        let baseFingerprint = opened?.fingerprint ?? '';
        if (snapshot && (snapshot.unsafeVisual || snapshot.source !== next.getSource())) {
          const choice = await chooseRecovery(`检测到 ${snapshot.path || '未命名文档'} 于 ${snapshot.savedAt} 保存的恢复快照。只有明确选择“放弃快照”才会删除；取消或关闭将保留快照。`);
          if (choice === 'cancel') {
            recoveryDeferredRef.current = true; setRecoveryDeferred(true);
            setPath(opened?.path ?? null); live.current.path = opened?.path ?? null;
            setReady(false); onLoaded(key);
            setError('恢复已取消，快照保留。使用“重新加载”重新选择；确认前不会编辑或保存此文档。');
            return;
          }
          if (choice === 'restore') {
            next.setSource(snapshot.source);
            // Keep the disk version this draft was based on, including in its
            // next recovery snapshot. A restart must not erase a disk conflict.
            baseFingerprint = snapshot.fingerprint;
            restored = snapshot.unsafeVisual ? snapshot.visualState : undefined;
            live.current.unsafeVisual = snapshot.unsafeVisual;
            live.current.visualState = snapshot.visualState;
            setUnsafeVisual(snapshot.unsafeVisual);
            if (opened && snapshot.fingerprint !== opened.fingerprint) {
              live.current.conflict = true;
              setConflict(true);
              setError('恢复快照建立后磁盘文件已变化。保存前请重新加载、另存为或明确确认覆盖。');
            }
          } else {
            await nativeFiles.clearRecovery(snapshotKey);
          }
        }
        recoveryDeferredRef.current = false; setRecoveryDeferred(false);
        setSession(next);
        live.current.session = next;
        setPath(opened?.path ?? null);
        live.current.path = opened?.path ?? null;
        onPathChange(key, opened?.path ?? null);
        setFingerprint(baseFingerprint);
        live.current.fingerprint = baseFingerprint;
        setRestoredState(restored);
        const cost = new PerformanceGovernor(next.getSource());
        governor.current = cost;
        const tier = restored ? 'normal' : cost.tier;
        performanceTierRef.current = tier;
        setPerformanceTier(tier);
        autoSource.current = tier === 'source';
        setMode(tier === 'source' ? 'source' : 'visual');
        lastEditAt.current = Date.now();
        setOutline(next.getSource().length < 20_000 ? outlineFromMarkdown(next.getSource()) : []);
        setActiveHeading(-1);
        setDocumentRevision((value) => value + 1);
        setReady(true);
        onLoaded(key);
      } catch (cause) {
        if (!cancelled) { setError(`打开失败：${explainNativeError(cause).message}`); if (!recoveryDeferredRef.current) setReady(true); }
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [key, loadAttempt]);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => {
      void flushRecovery().catch((cause) => setError(`恢复快照写入失败：${explainNativeError(cause).message}`));
    }, 600);
    return () => window.clearTimeout(timer);
  }, [revision, flushRecovery, ready]);

  const saveCurrent = useCallback(async (force = false) => {
    if (recoveryDeferredRef.current) { setError('快照保留；请先使用“重新加载”确认恢复选择。'); return false; }
    const state = live.current;
    if (state.unsafeVisual) {
      await flushRecovery();
      setError('可视编辑内容尚不能安全转换为 Markdown，已保存恢复快照；请先撤销有问题的输入。');
      return false;
    }
    if (state.conflict && !force) {
      await flushRecovery();
      setError('磁盘文件已变化。请重新加载、另存为或明确确认覆盖。');
      return false;
    }
    if (!state.path) return false;
    try {
      const sourceAtSave = state.session.getSource();
      const bytes = state.session.toBytes();
      const result = await nativeFiles.save(state.path, state.fingerprint, bytes, force);
      state.session.markSaved(bytes, sourceAtSave);
      state.fingerprint = result.fingerprint;
      state.conflict = false;
      setFingerprint(result.fingerprint);
      setConflict(false);
      setError('');
      setRevision((value) => value + 1);
      const stillDirty = state.session.isDirty() || state.unsafeVisual;
      try {
        if (stillDirty) await flushRecovery();
        else {
          await nativeFiles.clearRecovery(recoveryKey(state.path, key));
          if (recoveryKey(state.path, key) !== key) await nativeFiles.clearRecovery(key);
        }
      }
      catch (cause) { setError(`文件已保存，但更新恢复快照失败：${explainNativeError(cause).message}`); }
      if (stillDirty) setError('保存期间又有新编辑；已写入较早版本，当前修改仍未保存。');
      return !stillDirty;
    } catch (cause) {
      const failure = explainNativeError(cause);
      if (failure.kind === 'conflict') { state.conflict = true; setConflict(true); }
      setError(`保存失败：${failure.message}`);
      await flushRecovery().catch((snapshotError) => setError(`保存失败：${failure.message}；恢复快照也写入失败：${explainNativeError(snapshotError).message}`));
      return false;
    }
  }, [flushRecovery, key]);

  const saveAsFile = useCallback(async (): Promise<boolean> => {
    if (recoveryDeferredRef.current) { setError('快照保留；请先使用“重新加载”确认恢复选择。'); return false; }
    const state = live.current;
    if (state.unsafeVisual) { await flushRecovery(); setError('无法安全序列化可视内容；已保存恢复快照。'); return false; }
    const target = await chooseSavePath(basename(state.path ?? 'untitled.md'));
    if (!target) return false;
    if (target === state.path) return saveCurrent();
    const oldRecoveryKey = recoveryKey(state.path, key);
    const sourceAtSave = state.session.getSource();
    let savedSource = sourceAtSave;
    let imageCopies: ImageCopyPlan | null = null;
    let result;
    let bytes: Uint8Array;
    try {
      imageCopies = await nativeFiles.copyImages(state.path, key, target, preferences.imageDirectoryTemplate,
        preferences.imageReferenceStyle, imageUrls(sourceAtSave));
      savedSource = rewriteImageUrls(sourceAtSave, imageCopies.references);
      if (savedSource === sourceAtSave) bytes = state.session.toBytes();
      else {
        const staged = new DocumentSession(state.session.toBytes());
        staged.setSource(savedSource);
        bytes = staged.toBytes();
      }
      try { result = await nativeFiles.saveAs(windowLabel, key, target, bytes); }
      catch (cause) {
        if (explainNativeError(cause).kind !== 'conflict' ||
          !await askToClose(`目标文件 ${target} 已存在。确定覆盖？`, '另存为覆盖确认')) throw cause;
        result = await nativeFiles.saveAs(windowLabel, key, target, bytes, true);
      }
    } catch (cause) {
      if (imageCopies) await nativeFiles.finishImageCopies(imageCopies.token, false).catch((rollback) =>
        setError(`图片复制回滚失败：${explainNativeError(rollback).message}`));
      setError(`另存为失败：${explainNativeError(cause).message}`);
      await flushRecovery().catch((snapshotError) => setError(`另存为失败；恢复快照也写入失败：${explainNativeError(snapshotError).message}`));
      return false;
    }
    // The write has committed. Move this editor's identity immediately so a later
    // Ctrl+S cannot accidentally write the old file, even if recovery cleanup fails.
    if (imageCopies?.references.length) {
      const view = canonicalView.current;
      if (view) {
        const changes = imageUrlChanges(view.state.doc.toString(), imageCopies.references);
        if (changes.length) view.dispatch({ changes });
      }
      else state.session.setSource(rewriteImageUrls(state.session.getSource(), imageCopies.references));
    }
    state.session.markSaved(bytes, savedSource);
    if (imageCopies) await nativeFiles.finishImageCopies(imageCopies.token, true).catch((cause) =>
      setError(`文件已保存，但图片复制记录清理失败：${explainNativeError(cause).message}`));
    state.path = result.path;
    state.fingerprint = result.fingerprint;
    state.conflict = false;
    setPath(result.path);
    onPathChange(key, result.path);
    setFingerprint(result.fingerprint);
    setConflict(false);
    setRevision((value) => value + 1);
    const stillDirty = state.session.isDirty() || state.unsafeVisual;
    try {
      if (stillDirty) await flushRecovery();
      else await nativeFiles.clearRecovery(recoveryKey(result.path, key));
      if (oldRecoveryKey !== recoveryKey(result.path, key)) await nativeFiles.clearRecovery(oldRecoveryKey);
      const unarchived = imageCopies?.unresolved ?? [];
      setError(stillDirty ? '另存为期间又有新编辑；新文件已写入较早版本，当前修改仍未保存。' :
        unarchived.length ? `以下图片未能复制，原引用已保留：${unarchived.slice(0, 4).join('；')}${unarchived.length > 4 ? `；另有 ${unarchived.length - 4} 项` : ''}` : '');
    } catch (cause) {
      setError(`文件已另存到 ${target}，但恢复快照更新失败：${explainNativeError(cause).message}`);
    }
    return !stillDirty;
  }, [flushRecovery, key, onPathChange, preferences.imageDirectoryTemplate, preferences.imageReferenceStyle, saveCurrent, windowLabel]);

  const saveAs = saveAsFile;

  const exporting = useRef(false);
  const exportDocument = useCallback(async (format: 'html' | 'pdf') => {
    if (recoveryDeferredRef.current) { setError('快照保留；请先使用“重新加载”确认恢复选择。'); return; }
    if (exporting.current) return;
    const state = live.current;
    const name = basename(state.path ?? 'untitled.md');
    const notify = (phase: ExportNotice['phase'], message: string, details?: string[]) => onExportNotice(key, { id: key, name, phase, message, details });
    if (state.unsafeVisual) {
      notify('error', '导出失败：当前可视输入无法安全序列化，请先处理保存安全提示。');
      return;
    }
    exporting.current = true;
    try {
      const source = (canonicalView.current ?? sourceView.current)?.state.doc.toString() ?? state.session.getSource();
      const defaultPath = state.path
        ? state.path.replace(/\.(?:md|markdown)$/i, '') + `.${format}` : `untitled.${format}`;
      const target = await chooseExportPath(defaultPath, format);
      if (!target) return;
      const expected = await nativeFiles.exportTargetFingerprint(target, format);
      if (expected !== null && !await askToClose(`目标文件 ${target} 已存在。确定覆盖？`, '确认覆盖导出文件')) return;
      notify('working', '正在准备文档与图片…');
      const rendered = await renderDocumentForExport({ source, documentPath: state.path, sessionId: key,
        directoryTemplate: preferences.imageDirectoryTemplate, referenceStyle: preferences.imageReferenceStyle, format }, message => notify('working', message));
      if (rendered.bytes > 25 * 1024 * 1024 && !await askToClose(
        `内嵌图片后导出文件约 ${(rendered.bytes / 1048576).toFixed(1)} MB。继续导出？`, '导出文件较大')) { onExportNotice(key, null); return; }
      notify('working', format === 'pdf' ? '正在生成 PDF 与书签…' : '正在写入 HTML…');
      const native = format === 'html' ? await nativeFiles.writeExportHtml(target, rendered.html, expected)
        : await nativeFiles.writeExportPdf(target, rendered.html, expected);
      if (import.meta.env.VITE_NATIVE_TEST === '1') Object.assign(window, { __MINTDOWN_LAST_EXPORT__: { tabId: key, target, format, timings: rendered.timings, native } });
      notify('success', `${format.toUpperCase()} 导出完成`, [target, ...rendered.warnings]);
    } catch (cause) {
      notify('error', `${format.toUpperCase()} 导出失败：${explainNativeError(cause).message}`);
    } finally { exporting.current = false; }
  }, [key, onExportNotice, preferences.imageDirectoryTemplate, preferences.imageReferenceStyle]);

  const insertImageFiles = useCallback(async (files: File[], from?: number, to?: number, origin: 'paste' | 'drop' | 'insert' = 'insert') => {
    const view = canonicalView.current;
    if (!view || !files.length) return;
    const originalDocument = view.state.doc;
    const originalPath = live.current.path;
    let insertion = from === undefined ? view.state.selection.main.from : from;
    let end = to === undefined ? view.state.selection.main.to : to;
    for (const [index, file] of files.entries()) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const archived = await nativeFiles.archiveImage(originalPath, key, preferences.imageDirectoryTemplate,
          preferences.imageReferenceStyle, archiveNameForFile(file.name, origin), bytes);
        if (canonicalView.current !== view || live.current.path !== originalPath) {
          setError('图片已归档，但当前文档已切换；请在资源目录中确认该图片。');
          return;
        }
        const range = view.state.doc === originalDocument ? { from: insertion, to: end } : view.state.selection.main;
        const prefix = index === 0 ? '' : '\n';
        const text = `${prefix}${archived.reference}`;
        view.dispatch({ changes: { from: range.from, to: range.to, insert: text }, selection: { anchor: range.from + text.length } });
        view.focus();
        insertion = range.from + text.length;
        end = insertion;
        setError('');
      } catch (cause) {
        setError(`图片归档失败：${explainNativeError(cause).message}`);
        return;
      }
    }
  }, [key, preferences.imageDirectoryTemplate, preferences.imageReferenceStyle]);

  const relocateImage = useCallback(async (image: ImageSyntax) => {
    const view = canonicalView.current;
    if (!view) return;
    const originalPath = live.current.path;
    const original = view.state.doc.sliceString(image.from, image.to);
    if (!original || !imageUrls(original).includes(image.url)) {
      setError('无法安全定位原始图片路径；请在源码模式中检查。'); return;
    }
    const selected = await chooseImagePath();
    if (!selected) return;
    if (canonicalView.current !== view || live.current.path !== originalPath || view.state.doc.sliceString(image.from, image.to) !== original) {
      setError('图片语法已变化，请重新选择图片。'); return;
    }
    let staged: ImageCopyPlan | null = null;
    try {
      const archivePreview = originalPath ? await nativeFiles.previewRelinkArchives(originalPath,
        preferences.imageDirectoryTemplate, preferences.imageReferenceStyle, [[image.url, selected]]) : null;
      const nextUrl = originalPath ? (staged = await nativeFiles.stageRelinkArchives(originalPath,
        preferences.imageDirectoryTemplate, preferences.imageReferenceStyle, [[image.url, selected]])).references[0].newUrl
        : (await nativeFiles.archiveLocalImage(null, key, preferences.imageDirectoryTemplate,
          preferences.imageReferenceStyle, selected)).reference.slice(4, -1);
      if (archivePreview && staged && JSON.stringify(archivePreview.references) !== JSON.stringify(staged.references))
        throw new Error('图片归档目标在预览后变化，请重新选择图片');
      if (canonicalView.current !== view || live.current.path !== originalPath || view.state.doc.sliceString(image.from, image.to) !== original)
        throw new Error('选择图片期间原始语法或文档路径发生变化，修改已取消');
      const change = imageUrlChangeAt(view.state.doc.toString(), image.from, image.to, image.url, nextUrl);
      view.dispatch({ changes: change, selection: { anchor: change.from + nextUrl.length },
        annotations: isolateHistory.of('full') });
      if (live.current.session.getSource() !== view.state.doc.toString()) {
        live.current.session.setSource(view.state.doc.toString());
        setRevision((value) => value + 1);
      }
      if (staged) await nativeFiles.finishImageCopies(staged.token, true);
      view.focus();
      setError('');
      setOperationResult({ title: '图片重新定位完成', summary: '已更新 1 处 Markdown 图片引用。',
        note: 'Ctrl+Z 只撤销 Markdown 引用，不删除已复制的图片。',
        details: [...(archivePreview?.copies.map((copy) => `${copy.reused ? '复用' : '复制'}：${copy.source} → ${copy.target}`) ??
          [`归档来源：${selected}`]), `引用：${image.url} → ${nextUrl}`] });
    } catch (cause) {
      if (staged) await nativeFiles.finishImageCopies(staged.token, false).catch(() => {});
      setError('');
      setOperationResult({ title: '图片重新定位失败', summary: '图片引用未完成更新。',
        details: [explainNativeError(cause).message] });
    }
  }, [key, preferences.imageDirectoryTemplate, preferences.imageReferenceStyle]);

  const beginBatchRelink = useCallback(async () => {
    const state = live.current;
    if (!state.path) { setError('请先保存 Markdown 文档，再批量重新定位图片。'); return; }
    const selected = await chooseImageFolder();
    if (!selected) return;
    const source = (canonicalView.current ?? sourceView.current)?.state.doc.toString() ?? state.session.getSource();
    const previewFailedUrls = [...(canonicalView.current?.dom.querySelectorAll<HTMLElement>('.md-image-shell.missing') ?? [])]
      .filter((element) => Boolean(element.title)).map((element) =>
        element.textContent?.includes('图片无法解码') ? `decode:${element.title}` : element.title);
    try {
      const scan = await nativeFiles.scanMissingImages(state.path, preferences.imageDirectoryTemplate,
        preferences.imageReferenceStyle, selected, imageUrls(source), previewFailedUrls);
      const latest = (canonicalView.current ?? sourceView.current)?.state.doc.toString() ?? state.session.getSource();
      const currentScan = latest === source ? scan : await nativeFiles.scanMissingImages(state.path, preferences.imageDirectoryTemplate,
        preferences.imageReferenceStyle, selected, imageUrls(latest), previewFailedUrls);
      setRelinkPlan({ source: latest, path: state.path, fingerprint: state.fingerprint, folder: selected,
        template: preferences.imageDirectoryTemplate, style: preferences.imageReferenceStyle, ...currentScan, previewFailedUrls, choices: {} });
      setError('');
    } catch (cause) { setError(`扫描缺失图片失败：${explainNativeError(cause).message}`); }
  }, [preferences.imageDirectoryTemplate, preferences.imageReferenceStyle]);

  const manuallyChooseRelink = useCallback(async (oldUrl: string) => {
    if (!relinkPlan) return;
    const selected = await chooseImagePath();
    if (!selected) return;
    try {
      const candidate = await nativeFiles.chooseRelinkImage(relinkPlan.path, relinkPlan.style, selected);
      setRelinkPlan((current) => {
        if (!current || current.path !== relinkPlan.path || !current.entries.some((entry) => entry.oldUrl === oldUrl)) return current;
        const entries = current.entries.map((entry) => entry.oldUrl !== oldUrl ? entry : {
          ...entry, candidates: entry.candidates.some((item) => item.path === candidate.path)
            ? entry.candidates : [...entry.candidates, candidate],
        });
        const index = entries.find((entry) => entry.oldUrl === oldUrl)!.candidates.findIndex((item) => item.path === candidate.path);
        return { ...current, entries, choices: { ...current.choices, [oldUrl]: index } };
      });
      setError('');
    } catch (cause) { setError(`无法选择图片：${explainNativeError(cause).message}`); }
  }, [relinkPlan]);

  const applyBatchRelink = useCallback(async () => {
    if (!relinkPlan) return;
    const view = canonicalView.current ?? sourceView.current;
    if (!view || !live.current.path) return;
    if (live.current.path !== relinkPlan.path || live.current.fingerprint !== relinkPlan.fingerprint) {
      setRelinkPlan(null);
      setError('文件身份已变化，已取消旧图片预览；当前文档未修改。');
      return;
    }
    let currentPlan = relinkPlan;
    let source = view.state.doc.toString();
    if (source !== currentPlan.source || currentPlan.template !== preferences.imageDirectoryTemplate ||
      currentPlan.style !== preferences.imageReferenceStyle) {
      try {
        const refreshed = await refreshRelinkPlan(currentPlan, source, preferences.imageDirectoryTemplate,
          preferences.imageReferenceStyle);
        if (!equivalentRelinks(currentPlan, refreshed)) {
          setRelinkPlan(refreshed);
          setError('文档中的图片引用已更新，预览已同步，请确认新的修改清单。');
          return;
        }
        currentPlan = refreshed;
      } catch (cause) { setError(`无法更新图片预览：${explainNativeError(cause).message}`); return; }
    }
    const choices = selectedRelinks(currentPlan);
    if (!choices.length) return;
    const selectedForArchive = choices.map((item): [string, string] => [item.oldUrl, item.path]);
    if (!relinkArchivePreview || relinkPreviewError) return;
    let staged: ImageCopyPlan | null = null;
    try {
      for (const choice of choices) {
        const checked = await nativeFiles.chooseRelinkImage(currentPlan.path, currentPlan.style, choice.path);
        if (checked.path !== choice.path || checked.newUrl !== choice.newUrl)
          throw new Error(`图片位置已变化，请重新选择：${choice.path}`);
      }
      const latestPreview = await nativeFiles.previewRelinkArchives(currentPlan.path,
        preferences.imageDirectoryTemplate, preferences.imageReferenceStyle, selectedForArchive);
      if (JSON.stringify(latestPreview) !== JSON.stringify(relinkArchivePreview)) {
        setRelinkArchivePreview(latestPreview);
        setError('资源目录发生变化，请确认更新后的复制与引用清单。');
        return;
      }
      staged = await nativeFiles.stageRelinkArchives(currentPlan.path, preferences.imageDirectoryTemplate,
        preferences.imageReferenceStyle, selectedForArchive);
      if (JSON.stringify(staged.references) !== JSON.stringify(latestPreview.references))
        throw new Error('复制期间目标目录发生变化，已取消本批操作。');
      if (view.state.doc.toString() !== source) {
        if (staged) await nativeFiles.finishImageCopies(staged.token, false);
        const latest = view.state.doc.toString();
        setRelinkPlan(await refreshRelinkPlan(currentPlan, latest, preferences.imageDirectoryTemplate,
          preferences.imageReferenceStyle));
        setError('图片修改期间正文发生变化，预览已更新，请确认新的清单。');
        return;
      }
      const mappings = staged.references;
      const changes = imageUrlChanges(source, mappings);
      await nativeFiles.finishImageCopies(staged.token, true);
      staged = null;
      if (changes.length) view.dispatch({ changes, annotations: isolateHistory.of('full') });
      if (live.current.session.getSource() !== view.state.doc.toString()) {
        live.current.session.setSource(view.state.doc.toString());
        setRevision((value) => value + 1);
      }
      setRelinkPlan(null);
      setError('');
      setOperationResult({ title: '图片重新定位完成',
        summary: `成功更新 ${changes.length} 处图片引用，未处理 ${currentPlan.entries.length - choices.length} 项。`,
        note: 'Ctrl+Z 只撤销 Markdown 引用，不删除已复制的图片。',
        details: [
          ...latestPreview.copies.map((copy) => `${copy.reused ? '复用' : '复制'}：${copy.source} → ${copy.target}`),
          ...latestPreview.references.filter((item) => item.oldUrl !== item.newUrl).map((item) => `引用：${item.oldUrl} → ${item.newUrl}`),
          ...currentPlan.entries.filter((entry) => !choices.some((choice) => choice.oldUrl === entry.oldUrl))
            .map((entry) => `${entry.oldUrl}：${entry.candidates.length ? '存在多个候选，未选择' : '未找到可用图片'}`)] });
    } catch (cause) {
      if (staged) await nativeFiles.finishImageCopies(staged.token, false).catch(() => {});
      setError('');
      setOperationResult({ title: '图片重新定位失败', summary: '批量修改未完成。',
        details: [explainNativeError(cause).message] });
    }
  }, [preferences.imageDirectoryTemplate, preferences.imageReferenceStyle, relinkArchivePreview, relinkPlan, relinkPreviewError]);

  const cancelMove = useCallback(async () => {
    const token = movePlanRef.current?.token;
    movePlanRef.current = null;
    setMovePlan(null);
    if (token) await nativeFiles.cancelMove(token).catch((cause) => setError(`取消迁移时清理资源失败：${explainNativeError(cause).message}`));
  }, []);

  const beginMove = useCallback(async () => {
    if (movePlanRef.current) await cancelMove();
    if (!live.current.path) { setError('请先保存文档，再重命名或移动。'); return; }
    const state = live.current;
    if (state.unsafeVisual || state.conflict) { setError('当前编辑存在保存安全问题，请先解决后再迁移。'); return; }
    const target = await chooseSavePath(state.path!);
    if (!target || target.replace(/\//g, '\\').toLowerCase() === state.path?.replace(/\//g, '\\').toLowerCase()) return;
    const source = (canonicalView.current ?? sourceView.current)?.state.doc.toString() ?? state.session.getSource();
    try {
      const plan = await nativeFiles.prepareMove(state.path!, target, state.fingerprint,
        preferences.imageDirectoryTemplate, preferences.imageReferenceStyle, imageUrls(source));
      movePlanRef.current = plan;
      setMovePlan({ source, fingerprint: state.fingerprint, sourcePath: state.path!, targetPath: target,
        template: preferences.imageDirectoryTemplate, style: preferences.imageReferenceStyle, plan });
      setRetainMissingOnMove(false);
      setError('');
    } catch (cause) { setError(`准备重命名或移动失败：${explainNativeError(cause).message}`); }
  }, [cancelMove, preferences.imageDirectoryTemplate, preferences.imageReferenceStyle]);

  const moveDocument = useCallback(async () => {
    if (recoveryDeferredRef.current) { setError('快照保留；请先使用“重新加载”确认恢复选择。'); return; }
    if (!live.current.path && !await saveAsFile()) return;
    await beginMove();
  }, [beginMove, saveAsFile]);
  const relinkDocument = useCallback(async () => {
    if (recoveryDeferredRef.current) { setError('快照保留；请先使用“重新加载”确认恢复选择。'); return; }
    if (!live.current.path && !await saveAsFile()) return;
    await beginBatchRelink();
  }, [beginBatchRelink, saveAsFile]);

  const applyMove = useCallback(async () => {
    if (!movePlan) return;
    let { plan, source, sourcePath, targetPath } = movePlan;
    const state = live.current;
    const view = canonicalView.current ?? sourceView.current;
    if (!view || state.path !== sourcePath || state.unsafeVisual || state.conflict) {
      await cancelMove(); setError('文档状态已变化，迁移已取消；原文件未修改。'); return;
    }
    const currentSource = view.state.doc.toString();
    if (currentSource !== source || state.fingerprint !== movePlan.fingerprint || state.session.getSource() !== currentSource ||
      movePlan.template !== preferences.imageDirectoryTemplate || movePlan.style !== preferences.imageReferenceStyle) {
      await cancelMove();
      try {
        const refreshed = await nativeFiles.prepareMove(sourcePath, targetPath, state.fingerprint,
          preferences.imageDirectoryTemplate, preferences.imageReferenceStyle, imageUrls(currentSource));
        movePlanRef.current = refreshed;
        setMovePlan({ source: currentSource, fingerprint: state.fingerprint, sourcePath, targetPath,
          template: preferences.imageDirectoryTemplate, style: preferences.imageReferenceStyle, plan: refreshed });
        if (!sameMoveResult(plan, refreshed)) {
          setRetainMissingOnMove(false);
          setError('文档内容已更新，迁移预览已同步；请确认新的文件和图片修改清单。');
          return;
        }
        source = currentSource;
        plan = refreshed;
      } catch (cause) { setError(`无法更新迁移预览：${explainNativeError(cause).message}`); return; }
    }
    if (plan.unresolved.length && !retainMissingOnMove) {
      setError('仍有缺失图片；请先修复，或明确勾选“保留失效引用并继续移动”。'); return;
    }
    if (plan.targetExists && !await askToClose(`目标文件 ${targetPath} 已存在。确定覆盖该 Markdown 文件？图片资源不会覆盖同名文件。`, '确认覆盖目标文件')) return;
    try {
      const { targetSource: savedSource, bytes, changes } = prepareMovedMarkdown(state.session, source, plan.references, {
        before: resolveImageDirectory(movePlan.template, basename(sourcePath)),
        after: resolveImageDirectory(movePlan.template, basename(targetPath)),
      });
      const result = await nativeFiles.finishMove(windowLabel, key, plan.token, bytes, plan.targetExists);
      movePlanRef.current = null; setMovePlan(null);
      // Native commit has moved the file. Update the tab identity first so any
      // later UI or recovery failure cannot make Ctrl+S write to the old path.
      state.path = result.path; state.fingerprint = result.fingerprint; state.conflict = false;
      setPath(result.path); onPathChange(key, result.path); setFingerprint(result.fingerprint); setConflict(false);
      const changedDuringMove = view.state.doc.toString() !== source;
      if (!changedDuringMove) {
        if (changes.length) view.dispatch({ changes, annotations: isolateHistory.of('full') });
        // The disk commit must not depend on CodeMirror's update listener
        // running before this session is marked saved.
        state.session.setSource(savedSource);
      }
      state.session.markSaved(bytes, savedSource);
      const previousKey = recoveryKey(sourcePath, key);
      setRevision((value) => value + 1);
      let warning = result.warning ?? '';
      try { await nativeFiles.clearRecovery(previousKey); }
      catch (cause) { warning = `${warning}；旧恢复快照清理失败：${explainNativeError(cause).message}`; }
      setError('');
      setOperationResult({ title: '文档迁移完成',
        summary: `已移动 Markdown，并更新 ${changes.length} 处图片引用；${plan.unresolved.length} 张图片未解析。`,
        note: changedDuringMove ? '迁移期间又有编辑，当前修改仍未保存。磁盘资源移动和复制无法通过 Ctrl+Z 撤销。' :
          'Ctrl+Z 只能撤销编辑器支持的 Markdown 修改，不能恢复已移动或复制的磁盘资源。',
        details: [`Markdown：${sourcePath} → ${result.path}`,
          ...plan.resourceOperations.map(({ source, target, action }) =>
            `${action === 'move' ? warning ? '已复制，旧目录保留' : '移动' : action === 'reuse' ? '复用' : '复制'}：${source} → ${target}`),
          ...plan.references.filter(({ oldUrl, newUrl }) => oldUrl !== newUrl).map(({ oldUrl, newUrl }) => `引用：${oldUrl} → ${newUrl}`),
          ...plan.unresolved.map((url) => `跳过：${url} — 找不到可读取的本地图片`),
          ...(warning ? [warning] : [])] });
    } catch (cause) {
      movePlanRef.current = null; setMovePlan(null);
      setError('');
      setOperationResult({ title: '文档迁移失败', summary: '没有完成文档迁移。',
        details: [explainNativeError(cause).message] });
      await flushRecovery().catch(() => {});
    }
  }, [cancelMove, flushRecovery, key, movePlan, onPathChange, preferences.imageDirectoryTemplate, preferences.imageReferenceStyle, retainMissingOnMove, windowLabel]);

  const reload = useCallback(async () => {
    if (recoveryDeferredRef.current) { setError(''); setLoadAttempt(value => value + 1); return; }
    const state = live.current;
    if (!state.path) return;
    if (state.session.isDirty() || state.unsafeVisual) {
      await flushRecovery();
      const consent = await ask('重新加载会替换当前编辑内容。恢复快照已保存，确定继续？', { title: '重新加载文件', kind: 'warning' });
      if (!consent) return;
    }
    try {
      const opened = await nativeFiles.open(state.path);
      const next = new DocumentSession(Uint8Array.from(opened.bytes));
      setSession(next); state.session = next;
      setFingerprint(opened.fingerprint); state.fingerprint = opened.fingerprint;
      setUnsafeVisual(false); state.unsafeVisual = false; state.visualState = null;
      setConflict(false); state.conflict = false; setError(''); setRestoredState(undefined);
      const cost = new PerformanceGovernor(next.getSource());
      governor.current = cost;
      performanceTierRef.current = cost.tier; setPerformanceTier(cost.tier);
      autoSource.current = cost.tier === 'source';
      lastEditAt.current = Date.now();
      setOutline(next.getSource().length < 20_000 ? outlineFromMarkdown(next.getSource()) : []); setActiveHeading(-1);
      setMode(cost.tier === 'source' ? 'source' : 'visual'); setDocumentRevision((value) => value + 1); setRevision((value) => value + 1);
      await nativeFiles.clearRecovery(recoveryKey(state.path, key));
    } catch (cause) { setError(`重新加载失败：${explainNativeError(cause).message}`); }
  }, [flushRecovery, key]);

  const openAnother = useCallback(async () => {
    try {
      const selected = await open({ multiple: false, filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }] });
      if (typeof selected === 'string') { await onOpenPath(selected); setError(''); }
    } catch (cause) { setError(`打开失败：${explainNativeError(cause).message}`); }
  }, [onOpenPath]);

  const openNewWindow = useCallback(async () => {
    try {
      const selected = await open({ multiple: false, filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }] });
      if (typeof selected === 'string') await nativeFiles.openWindow(selected);
    } catch (cause) { setError(`新窗口打开失败：${explainNativeError(cause).message}`); }
  }, []);

  const onVisualViewUpdate = useCallback((view: ProseMirrorView | null) => {
    visualView.current = view;
    if (!view) return;
    const next = outlineFromDocument(view.state.doc);
    setOutline((current) => sameOutline(current, next) ? current : next);
    setActiveHeading(activeHeadingIndex(next, view.state.selection.from));
    if (pendingCursor.current?.mode === 'visual') {
      const target = pendingCursor.current;
      // A temporary view may be destroyed during mount. Leave the cursor pending
      // until the view that will receive it is still current in the next task.
      window.setTimeout(() => {
        if (visualView.current !== view || pendingCursor.current !== target) return;
        pendingCursor.current = null;
        const source = live.current.session.getSource();
        const anchor = sourceToVisualPosition(view.state.doc, source, target.anchor);
        const head = sourceToVisualPosition(view.state.doc, source, target.head);
        view.dispatch(view.state.tr.setSelection(TextSelection.between(
          view.state.doc.resolve(anchor), view.state.doc.resolve(head))).scrollIntoView());
        view.focus();
        const restoredSelection = view.state.selection;
        // ProseMirror's scrollIntoView does not always scroll our outer editor pane
        // after a fresh Milkdown mount. Wait for layout, then reveal the real caret.
        window.requestAnimationFrame(() => {
          if (visualView.current !== view || !view.state.selection.eq(restoredSelection)) return;
          const scroller = view.dom.closest<HTMLElement>('.editor-scroll');
          if (!scroller) return;
          try {
            const caret = view.coordsAtPos(view.state.selection.head);
            const area = scroller.getBoundingClientRect();
            scroller.scrollTop += caret.top - area.top - area.height * 0.4;
          } catch { /* The selection may have moved while layout was settling. */ }
        });
      }, 0);
    }
  }, []);

  const onSourceViewUpdate = useCallback((view: CodeMirrorView | null) => {
    sourceView.current = view;
    if (!view) return;
    const next = outlineFromMarkdown(view.state.doc.toString());
    setOutline((current) => sameOutline(current, next) ? current : next);
    setActiveHeading(activeHeadingIndex(next, view.state.selection.main.head));
    if (pendingCursor.current?.mode === 'source') {
      const target = pendingCursor.current;
      window.setTimeout(() => {
        if (sourceView.current !== view || pendingCursor.current !== target) return;
        pendingCursor.current = null;
        view.dispatch({ selection: { anchor: target.anchor, head: target.head }, scrollIntoView: true });
        view.focus();
        window.requestAnimationFrame(() => {
          if (sourceView.current !== view) return;
          const scroller = view.dom.closest<HTMLElement>('.editor-scroll');
          const caret = view.coordsAtPos(view.state.selection.main.head);
          if (!scroller || !caret) return;
          const area = scroller.getBoundingClientRect();
          scroller.scrollTop += caret.top - area.top - area.height * 0.4;
        });
      }, 0);
    }
  }, []);

  const onCanonicalViewUpdate = useCallback((view: CodeMirrorView | null) => {
    canonicalView.current = view;
    if (!view) {
      outlineDocument.current = null;
      if (outlineTimer.current !== null) window.clearTimeout(outlineTimer.current);
      outlineTimer.current = null;
      return;
    }
    if (outlineDocument.current !== view.state.doc) {
      const doc = view.state.doc;
      outlineDocument.current = doc;
      if (outlineTimer.current !== null) window.clearTimeout(outlineTimer.current);
      const refreshOutline = () => {
        if (canonicalView.current !== view || view.state.doc !== doc) return;
        const next = outlineFromMarkdown(doc.toString());
        setOutline((current) => sameOutline(current, next) ? current : next);
        setActiveHeading(activeHeadingIndex(next, view.state.selection.main.head));
      };
      if (doc.length < 20_000) refreshOutline();
      else outlineTimer.current = window.setTimeout(refreshOutline, 250);
    } else setActiveHeading(activeHeadingIndex(outlineRef.current, view.state.selection.main.head));
    const range = view.state.selection.main;
    onPositionChange(key, { anchor: range.anchor, head: range.head,
      scrollTop: view.dom.closest<HTMLElement>('.editor-scroll')?.scrollTop ?? tab.scrollTop });
  }, [key, onPositionChange, tab.scrollTop]);

  const interactionSafe = useCallback(() => {
    const view = canonicalView.current;
    return Boolean(view && !view.composing && view.state.selection.main.empty && !pointerDown.current);
  }, []);

  const applyPerformanceTier = useCallback((tier: RenderTier) => {
    if (tier === performanceTierRef.current) return;
    performanceTierRef.current = tier;
    setPerformanceTier(tier);
    if (tier === 'source' && modeRef.current === 'visual') {
      autoSource.current = true;
      setMode('source');
    } else if (tier !== 'source' && autoSource.current) {
      autoSource.current = false;
      setMode('visual');
    }
  }, []);

  const onPerformanceSample = useCallback((durationMs: number, view: CodeMirrorView) => {
    if (canonicalView.current !== view) return;
    lastEditAt.current = Date.now();
    if (modeRef.current !== 'visual') return;
    const tier = governor.current.observeVisual(durationMs);
    if (tier === performanceTierRef.current) return;
    if (interactionSafe()) applyPerformanceTier(tier);
    else pendingTier.current = tier;
  }, [applyPerformanceTier, interactionSafe]);

  useEffect(() => {
    if (!active || !ready || restoredState) return;
    const down = () => { pointerDown.current = true; };
    const up = () => { pointerDown.current = false; };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    const timer = window.setInterval(() => {
      if (!interactionSafe()) return;
      if (pendingTier.current) {
        const tier = pendingTier.current;
        pendingTier.current = null;
        applyPerformanceTier(tier);
      }
      if (autoSource.current && governor.current.canRecover(live.current.session.getSource(), Date.now(), lastEditAt.current, true)) {
        governor.current.recovered();
        applyPerformanceTier('light');
      }
    }, 2_000);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
  }, [active, ready, restoredState, interactionSafe, applyPerformanceTier]);

  const switchMode = useCallback(() => {
    if (canonicalView.current) {
      pendingTier.current = null;
      if (mode === 'source') {
        autoSource.current = false;
        governor.current.manualVisual(live.current.session.getSource());
        performanceTierRef.current = governor.current.tier;
        setPerformanceTier(governor.current.tier);
        setMode('visual');
      } else {
        autoSource.current = false;
        setMode('source');
      }
      return;
    }
    if (live.current.unsafeVisual) { setError('当前可视输入无法安全序列化；请先撤销，或关闭窗口后从恢复快照恢复。'); return; }
    if (mode === 'visual' && visualView.current) {
      const view = visualView.current;
      const source = live.current.session.getSource();
      pendingCursor.current = { mode: 'source',
        anchor: visualToSourcePosition(view.state.doc, source, view.state.selection.anchor),
        head: visualToSourcePosition(view.state.doc, source, view.state.selection.head) };
    } else if (mode === 'source' && sourceView.current) {
      const selection = sourceView.current.state.selection.main;
      pendingCursor.current = { mode: 'visual', anchor: selection.anchor, head: selection.head };
    }
    setMode((value) => value === 'visual' ? 'source' : 'visual');
  }, [mode]);

  useEffect(() => {
    if (!searchMode || !ready) return;
    if (canonicalView.current && mode === 'visual') {
      setSearchStatus(updateVisualSourceSearch(canonicalView.current, searchOptions));
      return;
    }
    const visual = mode === 'visual' ? visualView.current : null;
    const source = canonicalView.current ?? (mode === 'source' ? sourceView.current : null);
    setSearchStatus(updateSearch(visual, source, searchOptions));
  }, [searchMode, searchOptions, mode, revision, ready]);

  const closeSearch = useCallback(() => {
    if (canonicalView.current && mode === 'visual') {
      updateVisualSourceSearch(canonicalView.current, { ...searchOptions, text: '' });
      setSearchMode(null);
      setSearchStatus({ total: 0, current: 0, valid: true });
      window.requestAnimationFrame(() => canonicalView.current?.focus());
      return;
    }
    const visual = mode === 'visual' ? visualView.current : null;
    const source = canonicalView.current ?? (mode === 'source' ? sourceView.current : null);
    updateSearch(visual, source, { ...searchOptions, text: '' });
    setSearchMode(null);
    setSearchStatus({ total: 0, current: 0, valid: true });
    window.requestAnimationFrame(() => (source ?? visual)?.focus());
  }, [mode, searchOptions]);

  const searchAction = useCallback((action: 'next' | 'previous' | 'replace' | 'replaceAll') => {
    if (canonicalView.current && mode === 'visual') {
      if (runVisualSourceSearch(canonicalView.current, searchOptions, action))
        setSearchStatus(updateVisualSourceSearch(canonicalView.current, searchOptions));
      return;
    }
    const visual = mode === 'visual' ? visualView.current : null;
    const source = canonicalView.current ?? (mode === 'source' ? sourceView.current : null);
    if (runSearchAction(visual, source, searchOptions, action))
      setSearchStatus(updateSearch(visual, source, searchOptions));
  }, [mode, searchOptions]);

  const heading = useCallback((level: number) => {
    if (canonicalView.current) {
      if (!setSourceHeading(canonicalView.current, level)) setError('当前段落包含受保护的原始语法或代码围栏，无法应用标题格式。');
      return;
    }
    const view = mode === 'visual' ? visualView.current : sourceView.current;
    const changed = mode === 'visual'
      ? !!view && setVisualHeading(view as ProseMirrorView, level)
      : !!view && setSourceHeading(view as CodeMirrorView, level);
    if (!changed) setError('当前段落包含受保护的原始语法或代码围栏，无法应用标题格式。');
  }, [mode]);

  const format = useCallback((kind: TextFormat) => {
    if (canonicalView.current) {
      const changed = kind === 'link' ? insertLinkTemplate(canonicalView.current) :
        toggleSourceFormat(canonicalView.current, kind);
      if (!changed) setError('当前选择包含代码块或受保护的原始语法，无法应用此格式。');
      return;
    }
    if (kind === 'link') {
      if (mode === 'source' && sourceView.current) insertLinkTemplate(sourceView.current);
      else setError('旧版恢复快照中的链接无法安全展开原始语法；请先完成恢复并使用源码模式编辑。');
      return;
    }
    const changed = mode === 'visual' && visualView.current
      ? toggleVisualFormat(visualView.current, kind)
      : mode === 'source' && sourceView.current
        ? toggleSourceFormat(sourceView.current, kind) : false;
    if (!changed) setError('当前选择包含代码块或受保护的原始语法，无法应用此格式；可在源码模式中编辑。');
  }, [mode]);

  const undo = useCallback(() => { undoEditor(mode === 'visual' ? visualView.current : null, canonicalView.current ?? (mode === 'source' ? sourceView.current : null)); }, [mode]);
  const redo = useCallback(() => { redoEditor(mode === 'visual' ? visualView.current : null, canonicalView.current ?? (mode === 'source' ? sourceView.current : null)); }, [mode]);

  const jumpToHeading = useCallback((index: number) => {
    const section = outline[index];
    if (!section) return;
    if (canonicalView.current) {
      const view = canonicalView.current;
      view.dispatch({ selection: { anchor: section.position }, scrollIntoView: true });
      view.focus();
      placeCodeMirrorHeadingNearTop(view, section.position);
    } else if (mode === 'source' && sourceView.current) {
      const view = sourceView.current;
      view.dispatch({ selection: { anchor: section.position }, scrollIntoView: true });
      view.focus();
      placeCodeMirrorHeadingNearTop(view, section.position);
    } else if (mode === 'visual' && visualView.current) {
      const view = visualView.current;
      const position = Math.min(section.position + 1, view.state.doc.content.size);
      view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(position))));
      view.focus();
      placeHeadingNearTop(view.dom.closest<HTMLElement>('.editor-scroll'), view.coordsAtPos(position).top);
    }
    setActiveHeading(index);
  }, [mode, outline]);

  useEffect(() => {
    onActionsChange(key, {
      dirty: () => recoveryDeferredRef.current || live.current.session.isDirty() || live.current.unsafeVisual,
      flush: flushRecovery,
      saveForClose: () => live.current.path ? saveCurrent() : saveAsFile(),
      saveAs: saveAsFile,
      move: moveDocument,
      relink: relinkDocument,
      exportDocument,
      discard: async () => {
        discarded.current = true;
        try {
          await nativeFiles.clearRecovery(recoveryKey(live.current.path, key));
          if (live.current.path) await nativeFiles.clearRecovery(key);
        } catch (cause) {
          discarded.current = false;
          throw cause;
        }
      },
    });
    return () => onActionsChange(key, null);
  }, [exportDocument, flushRecovery, key, moveDocument, onActionsChange, relinkDocument, saveAsFile, saveCurrent]);

  useEffect(() => {
    if (!ready || !active) return;
    const scroller = canonicalView.current?.dom.closest<HTMLElement>('.editor-scroll');
    if (!scroller) return;
    const onScroll = () => {
      onPositionChange(key, { scrollTop: scroller.scrollTop });
      const view = canonicalView.current;
      if (!view || !outlineRef.current.length) return;
      const content = view.contentDOM.getBoundingClientRect();
      const viewport = scroller.getBoundingClientRect();
      const position = view.posAtCoords({ x: content.left + 8, y: Math.min(viewport.bottom - 8, viewport.top + 96) });
      if (position !== null) setActiveHeading(activeHeadingIndex(outlineRef.current, position));
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [active, key, onPositionChange, ready]);

  useEffect(() => {
    if (!active) return;
    const scroller = canonicalView.current?.dom.closest<HTMLElement>('.editor-scroll');
    if (scroller) canonicalView.current?.requestMeasure();
  }, [active]);

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (!active) return;
      if (event.isComposing || event.key === 'Process' || event.keyCode === 229) return;
      if (event.key === 'Escape' && searchMode) { event.preventDefault(); closeSearch(); return; }
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const keyName = event.key.toLowerCase();
      const inEditor = (event.target as Element | null)?.closest?.('.ProseMirror, .cm-content');
      if (keyName === 's') { event.preventDefault(); void (event.shiftKey || !live.current.path ? saveAs() : saveCurrent()); return; }
      if (event.code === 'Comma' && !event.shiftKey) { event.preventDefault(); onOpenPreferences(); return; }
      if (keyName === 'n' && !event.shiftKey) { event.preventDefault(); onNewTab(); return; }
      if (keyName === 'o') { event.preventDefault(); void openAnother(); return; }
      if (!event.shiftKey && (event.key === '/' || event.code === 'Slash')) { event.preventDefault(); switchMode(); return; }
      if (!event.shiftKey && keyName === 'f') { event.preventDefault(); setSearchMode('find'); document.querySelector<HTMLInputElement>('[aria-label="查找文本"]')?.focus(); return; }
      if (!event.shiftKey && (keyName === 'h' || keyName === 'r')) { event.preventDefault(); setSearchMode('replace'); document.querySelector<HTMLInputElement>('[aria-label="查找文本"]')?.focus(); return; }
      if (keyName === 'e' && !event.shiftKey && inEditor) { event.preventDefault(); format('inlineCode'); return; }
      if (keyName === 'k' && !event.shiftKey && inEditor) { event.preventDefault(); format('link'); return; }
      if (!inEditor) return;
      if (!event.shiftKey && /^[0-6]$/.test(event.key)) { event.preventDefault(); heading(Number(event.key)); return; }
      if (keyName === 'z' && event.shiftKey || keyName === 'y' && !event.shiftKey) { event.preventDefault(); redo(); return; }
      if (keyName === 'z' && !event.shiftKey) { event.preventDefault(); undo(); return; }
      if (!event.shiftKey && keyName === 'b') { event.preventDefault(); format('strong'); return; }
      if (!event.shiftKey && keyName === 'i') { event.preventDefault(); format('em'); return; }
    };
    window.addEventListener('keydown', handle, true);
    return () => window.removeEventListener('keydown', handle, true);
  }, [active, closeSearch, format, heading, onNewTab, onOpenPreferences, openAnother, redo, saveAs, saveCurrent, searchMode, switchMode, undo]);

  const dirty = session.isDirty() || unsafeVisual || recoveryDeferred;
  const sourceForCount = session.getSource();
  const characterCount = useMemo(() => {
    let count = 0;
    for (const character of sourceForCount) if (!/\s/u.test(character)) count++;
    return count;
  }, [sourceForCount]);
  useEffect(() => { onDirtyChange(key, dirty); }, [dirty, key, onDirtyChange]);
  const menus: MenuGroup[] = [
    { label: '文件', actions: [
      { label: '新建文档', shortcut: 'Ctrl+N', onSelect: onNewTab },
      { label: '打开文件', shortcut: 'Ctrl+O', onSelect: () => void openAnother() },
      { label: '在新窗口打开', onSelect: () => void openNewWindow() },
      { label: '保存 Ctrl+S', onSelect: () => void (path ? saveCurrent() : saveAs()) },
      { label: '导出', children: [
        { label: 'HTML…', onSelect: () => void exportDocument('html') },
        { label: 'PDF…', onSelect: () => void exportDocument('pdf') },
      ] },
      { label: '偏好设置', shortcut: 'Ctrl+,', onSelect: onOpenPreferences },
      { label: '插入图片', onSelect: () => imageFileInput.current?.click() },
      { label: '关闭当前标签', shortcut: 'Ctrl+W', onSelect: () => onCloseTab(key) },
      { label: '重新加载', onSelect: () => void reload(), disabled: !path && !recoveryDeferred },
    ] },
    { label: '编辑', actions: [
      { label: '撤销', shortcut: 'Ctrl+Z', onSelect: undo },
      { label: '重做', shortcut: 'Ctrl+Y', onSelect: redo },
      { label: '查找', shortcut: 'Ctrl+F', onSelect: () => setSearchMode('find') },
      { label: '替换', shortcut: 'Ctrl+H', onSelect: () => setSearchMode('replace') },
    ] },
    { label: '段落', actions: [
      { label: '普通段落', shortcut: 'Ctrl+0', onSelect: () => heading(0) },
      ...Array.from({ length: 6 }, (_, index) => ({ label: `${index + 1} 级标题`, shortcut: `Ctrl+${index + 1}`, onSelect: () => heading(index + 1) })),
    ] },
    { label: '格式', actions: [
      { label: '粗体', shortcut: 'Ctrl+B', onSelect: () => format('strong') },
      { label: '斜体', shortcut: 'Ctrl+I', onSelect: () => format('em') },
      { label: '删除线', onSelect: () => format('strike_through') },
      { label: '行内代码', shortcut: 'Ctrl+E', onSelect: () => format('inlineCode') },
      { label: '链接', shortcut: 'Ctrl+K', onSelect: () => format('link') },
    ] },
    { label: '视图', actions: [
      { label: mode === 'visual' ? '源码模式' : '可视模式', shortcut: 'Ctrl+/', onSelect: switchMode },
      { label: preferences.outlineOpen ? '隐藏大纲' : '显示大纲', onSelect: () => setPreferences({ ...preferences, outlineOpen: !preferences.outlineOpen }) },
      { label: preferences.theme === 'light' ? '深色主题' : '浅色主题', onSelect: () => setPreferences({ ...preferences, theme: preferences.theme === 'light' ? 'dark' : 'light' }) },
    ], extra: <div className="view-settings"><label className="writing-width-setting">正文宽度 <input aria-label="正文最大宽度" type="range" min="600" max="1200" step="20" value={preferences.writingWidth}
      onChange={(event) => setPreferences({ ...preferences, writingWidth: clampWritingWidth(Number(event.target.value)) })} /> {preferences.writingWidth}px</label>
      <label className="writing-width-setting">正文字号 <input aria-label="正文字号" type="range" min="14" max="26" step="1" value={preferences.fontSize}
        onChange={(event) => setPreferences({ ...preferences, fontSize: clampFontSize(Number(event.target.value)) })} /> {preferences.fontSize}px</label></div> },
    { label: '帮助', actions: [{ label: '快捷键说明', onSelect: () => setHelpOpen((value) => !value) },
      { label: '构建信息', onSelect: () => setOperationResult({ title: '构建信息', summary: buildDescription() }) }] },
  ];

  const moveChangeCount = useMemo(() => {
    if (!movePlan) return 0;
    try { return imageUrlChanges(movePlan.source, movePlan.plan.references).length; }
    catch { return null; }
  }, [movePlan]);
  const relinkExamples = useMemo(() => relinkPlan ? imageReferenceExamples(relinkPlan.source) : new Map(), [relinkPlan]);
  const feedback = <>
    {movePlan && <div className="image-relink-panel" role="dialog" aria-label="重命名或移动预览">
      <strong>重命名或移动文档</strong>
      <p>{movePlan.sourcePath} → {movePlan.targetPath}</p>
      <p>图片引用更新 {moveChangeCount ?? '无法安全计算'} 处；未解析 {movePlan.plan.unresolved.length} 项。{movePlan.plan.targetExists && '目标 Markdown 已存在，确认时将再次询问是否覆盖。'}</p>
      <p>预计处理 {movePlan.plan.resourceOperations.length} 个资源文件并写入目标 Markdown。专用资源目录在迁移成功后清理旧目录；共享和外部资源保留原件。</p>
      <div className="image-move-operations">{movePlan.plan.resourceOperations.map(({ source, target, action }, index) =>
        <div key={`${source}-${index}`}>{action === 'move' ? '移动' : action === 'reuse' ? '复用' : '复制'}：{source} → {target}</div>)}</div>
      {movePlan.plan.unresolved.length > 0 && <>
        <p role="alert">以下图片不存在或无法读取，迁移不会修复这些引用：</p>
        <ul className="image-move-unresolved">{movePlan.plan.unresolved.map((url) => <li key={url}>{url} — 找不到可读取的本地图片</li>)}</ul>
        <button type="button" onClick={() => void beginBatchRelink()}>先修复缺失图片…</button>
        <label className="image-move-retain"><input type="checkbox" checked={retainMissingOnMove}
          onChange={(event) => setRetainMissingOnMove(event.target.checked)} />保留失效引用并继续移动</label>
      </>}
      <div className="image-relink-list">{movePlan.plan.references.filter((item) => item.oldUrl !== item.newUrl).map((item) =>
        <label key={item.oldUrl}><span>{item.oldUrl}</span><span>→ {item.newUrl}</span></label>)}</div>
      <div className="image-relink-actions"><button className="dialog-button" onClick={() => void cancelMove()}>取消</button><button className="dialog-button dialog-button-primary" onClick={() => void applyMove()}>确认迁移</button></div>
    </div>}
    {relinkPlan && <div className="image-relink-panel" role="dialog" aria-label="批量重新定位缺失图片">
      <strong>批量重新定位缺失图片</strong>
      <p>当前文档：<span title={relinkPlan.path}>{basename(relinkPlan.path)}</span><br /><span className="relink-path">{relinkPlan.path}</span></p>
      <p>图片来源目录：<span className="relink-path">{relinkPlan.folder}</span> <button type="button" className="relink-choose-folder" onClick={() => void beginBatchRelink()}>重新选择目录…</button></p>
      <p>目标资源目录：<span className="relink-path">{relinkArchivePreview?.targetDirectory ?? '计算中…'}</span></p>
      <p>扫描 {relinkPlan.scannedFiles} 个文件；缺失或预览失败的引用 {relinkPlan.entries.length} 条；唯一同名 {relinkPlan.entries.filter((entry) => entry.autoCandidates === 1).length} 条；需人工选择 {relinkPlan.entries.filter((entry) => entry.autoCandidates > 1 && relinkPlan.choices[entry.oldUrl] === undefined).length} 条；未找到同名 {relinkPlan.entries.filter((entry) => entry.reason.includes('没有同名图片')).length} 条；同名文件不可用 {relinkPlan.entries.filter((entry) => entry.reason.includes('找到同名文件，但')).length} 条。原路径有效 {relinkPlan.alreadyValid} 条。</p>
      <p>匹配成功 {selectedRelinks(relinkPlan).length} 项；即将复制 {relinkArchivePreview?.copies.filter((copy) => !copy.reused).length ?? '计算中'} 个文件，复用 {relinkArchivePreview?.copies.filter((copy) => copy.reused).length ?? 0} 个；预计修改 {relinkArchivePreview?.references.filter((item) => item.oldUrl !== item.newUrl).length ?? selectedRelinks(relinkPlan).length} 项；未选择 {relinkPlan.entries.length - selectedRelinks(relinkPlan).length} 项。未匹配的引用保持原样。</p>
      {relinkPreviewError && <p role="alert">复制计划无法生成：{relinkPreviewError}</p>}
      <div className="image-relink-list">{relinkPlan.entries.map((entry) => <label key={entry.oldUrl}>
        <span title={relinkExamples.get(entry.oldUrl)?.syntax ?? entry.oldUrl}>{relinkExamples.get(entry.oldUrl)?.syntax ?? entry.oldUrl}{(relinkExamples.get(entry.oldUrl)?.count ?? 0) > 1 && `（共 ${relinkExamples.get(entry.oldUrl)?.count} 处）`}</span>
        <small>查找文件名：{entry.fileName} · {entry.reason}</small>
        {entry.candidates.length ? <select aria-label={`新图片路径 ${entry.oldUrl}`}
          value={relinkPlan.choices[entry.oldUrl] ?? (entry.candidates.length === 1 ? 0 : -1)}
          onChange={(event) => setRelinkPlan((current) => current && ({ ...current, choices: { ...current.choices, [entry.oldUrl]: Number(event.target.value) } }))}>
          {entry.candidates.length > 1 && <option value={-1}>同名文件有多个，请选择</option>}
          {entry.candidates.map((candidate, index) => <option key={candidate.path} value={index}>{candidate.path}</option>)}
        </select> : <em>没有找到同名图片；原引用保持不变</em>}
        {relinkArchivePreview?.references.find((item) => item.oldUrl === entry.oldUrl) && <small>引用：{entry.oldUrl} → {relinkArchivePreview.references.find((item) => item.oldUrl === entry.oldUrl)?.newUrl}</small>}
        <button type="button" className="relink-manual" onClick={() => void manuallyChooseRelink(entry.oldUrl)}>手动选择图片…</button>
      </label>)}{relinkArchivePreview?.copies.map((copy) => <small key={copy.source} className="relink-copy-preview">{copy.reused ? '复用' : '复制'}：{copy.source} → {copy.target}</small>)}</div>
      <div className="image-relink-actions"><button className="dialog-button" onClick={() => setRelinkPlan(null)}>{selectedRelinks(relinkPlan).length ? '取消' : '完成'}</button>{selectedRelinks(relinkPlan).length > 0 && <button className="dialog-button dialog-button-primary" disabled={!relinkArchivePreview || !!relinkPreviewError} onClick={() => void applyBatchRelink()}>复制并更新引用</button>}</div>
    </div>}
    {operationResult && <div className="operation-result-backdrop">
      <div className="operation-result-dialog" role="dialog" aria-modal="true" aria-label={operationResult.title}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); closeOperationResult(); } }}>
        <div className="operation-result-heading"><strong>{operationResult.title}</strong>
          <button className="dialog-close" type="button" aria-label="关闭操作结果" onClick={closeOperationResult}>×</button></div>
        <p>{operationResult.summary}</p>
        {operationResult.note && <p>{operationResult.note}</p>}
        {!!operationResult.details?.length && <details><summary>查看详情</summary><ul>{operationResult.details.map((detail, index) => <li key={index}>{detail}</li>)}</ul></details>}
        <div className="image-relink-actions"><button ref={resultButtonRef} className="dialog-button dialog-button-primary" type="button" onClick={closeOperationResult}>完成</button></div>
      </div>
    </div>}
    {error && <p role="alert" className="error">{error}</p>}
    {conflict && <div className="conflict" role="alert">
      <strong>磁盘文件已变化，当前修改尚未覆盖它。</strong>
      <button className="dialog-button" onClick={() => void reload()}>重新加载</button>
      <button className="dialog-button" onClick={() => void saveAs()}>另存为</button>
      <button className="dialog-button dialog-button-primary" onClick={() => void (async () => {
        const consent = await ask('这会覆盖磁盘上其他程序的修改。确定覆盖？', { title: '确认覆盖', kind: 'warning' });
        if (consent) await saveCurrent(true);
      })()}>确认覆盖</button>
    </div>}
    {helpOpen && <div className="shortcut-popover" role="dialog" aria-label="快捷键说明">Tab 插入四格缩进 · 代码块内 Ctrl+A 只选代码 · Ctrl+0～6 设置段落和标题 · Ctrl+/ 切换模式 · Ctrl+S 保存 · Ctrl+Z 撤销 · Ctrl+Y / Ctrl+Shift+Z 重做 · Ctrl+F 查找 · Ctrl+H 替换 · Ctrl+B 粗体 · Ctrl+I 斜体 · Ctrl+E 行内代码 · Ctrl+K 链接
      <button type="button" onClick={() => setHelpOpen(false)} aria-label="关闭快捷键说明">×</button></div>}
  </>;

  return <section className="document-tab-panel" data-tab-id={key} hidden={!active}>
    <input ref={imageFileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden
      onChange={(event) => { void insertImageFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
    <EditorChrome fileName={basename(path ?? 'untitled.md')} dirty={dirty} mode={mode}
    documentPath={path}
    characterCount={characterCount} outline={outline} activeHeading={activeHeading}
    onHeadingClick={jumpToHeading} preferences={preferences} onPreferencesChange={setPreferences}
    menus={menus} searchMode={searchMode} onCloseSearch={closeSearch} searchOptions={searchOptions}
    searchStatus={searchStatus} onSearchOptionsChange={setSearchOptions} onSearchAction={searchAction}
    settingsOpen={preferencesActive} onCloseSettings={onClosePreferences} onBatchRelink={() => void beginBatchRelink()} feedback={feedback}>
    {!ready ? <p className="editor-loading">{recoveryDeferred ? '恢复已暂停，快照尚未丢弃。' : '正在加载文档…'}</p> : !restoredState
      ? <CanonicalEditor key={documentRevision} initialSource={session.getSource()} initialPosition={initialPosition.current} mode={mode} performanceTier={performanceTier} onPerformanceSample={onPerformanceSample} spellCheck={preferences.spellCheck} documentPath={path} active={active}
          imageSessionId={key} imageDirectoryTemplate={preferences.imageDirectoryTemplate} imageReferenceStyle={preferences.imageReferenceStyle}
          onImageFiles={(files, from, to, origin) => { void insertImageFiles(files, from, to, origin); }}
          onRelocateImage={(image) => { void relocateImage(image); }}
          onViewUpdate={onCanonicalViewUpdate} onEdit={(source) => {
            try { session.setSource(source); setError(''); setRevision((value) => value + 1); }
            catch (cause) { setError(`源码更新失败：${String(cause)}`); }
          }} onOpenExternal={(url) => { void openUrl(url).catch((cause) =>
            setError(`无法在默认浏览器打开链接：${String(cause)}`)); }} />
      : mode === 'source'
      ? <SourceEditor key={`source-${documentRevision}`} initialSource={session.getSource()} onViewUpdate={onSourceViewUpdate} onEdit={(source) => {
          try { session.setSource(source); setError(''); setRevision((value) => value + 1); }
          catch (cause) { setError(`源码解析失败：${String(cause)}`); }
        }} />
      : <section className="visual-editor" data-testid="visual-editor">
           <UnifiedMilkdown key={documentRevision} initialSource={session.getSource()} restoredState={restoredState} onViewUpdate={onVisualViewUpdate} spellCheck={preferences.spellCheck}
            onDocumentState={(state) => { live.current.visualState = state; setRevision((value) => value + 1); }}
            onEdit={(source, problem) => {
              if (problem) { live.current.unsafeVisual = true; setUnsafeVisual(true); setError(problem); setRevision((value) => value + 1); return; }
              try { session.setSource(source); live.current.unsafeVisual = false; setUnsafeVisual(false); setError(''); setRevision((value) => value + 1); }
              catch (cause) { live.current.unsafeVisual = true; setUnsafeVisual(true); setError(`无法安全保存可视编辑结果：${String(cause)}`); setRevision((value) => value + 1); }
            }} onUnsafeOpen={(reason) => { setError(`${reason}。已切换源码模式。`); setMode('source'); }} />
        </section>}
    </EditorChrome>
  </section>;
}

function samePath(left: string | null, right: string | null): boolean {
  return Boolean(left && right && left.replace(/\//g, '\\').toLowerCase() === right.replace(/\//g, '\\').toLowerCase());
}

export function DesktopApp() {
  const windowLabel = getCurrentWindow().label;
  const sessionKey = new URLSearchParams(window.location.search).get('session') ?? 'main';
  const launchPath = new URLSearchParams(window.location.search).get('path');
  const [tabs, setTabs] = useState<TabRecord[]>([]);
  const tabsRef = useRef(tabs);
  const [activeId, setActiveId] = useState('');
  const [preferencesTabOpen, setPreferencesTabOpen] = useState(false);
  const [preferencesTabActive, setPreferencesTabActive] = useState(false);
  const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number; preferences: boolean } | null>(null);
  const [tabExportOpen, setTabExportOpen] = useState(false);
  const [exportNotices, setExportNotices] = useState<Record<string, ExportNotice>>({});
  const onExportNotice = useCallback((id: string, notice: ExportNotice | null) => setExportNotices(current => {
    const next = { ...current }; if (notice) next[id] = notice; else delete next[id]; return next;
  }), []);
  const tabMenuRef = useRef<HTMLDivElement>(null);
  const tabMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const activeRef = useRef(activeId);
  const [booted, setBooted] = useState(false);
  const bootedRef = useRef(false);
  const queuedPaths = useRef<string[]>([]);
  const actionsRef = useRef(new Map<string, TabActions>());
  const [preferences, setPreferences] = useState(readPreferences);
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const [workspaceError, setWorkspaceError] = useState('');
  const [restoreFailures, setRestoreFailures] = useState<string[]>([]);
  const persistTimer = useRef<number | null>(null);
  const writeQueue = useRef<Promise<void>>(Promise.resolve());
  const themeQueue = useRef<Promise<void>>(Promise.resolve());

  const serializeSession = useCallback((items = tabsRef.current, selected = activeRef.current): WindowSession => ({
    key: sessionKey,
    tabs: items.map(({ id, path, anchor, head, scrollTop }) => ({ id, path, ...validPosition({ anchor, head, scrollTop }) })),
    activeId: selected || null,
  }), [sessionKey]);
  const persistNow = useCallback((session = serializeSession()): Promise<void> => {
    if (persistTimer.current !== null) { window.clearTimeout(persistTimer.current); persistTimer.current = null; }
    writeQueue.current = writeQueue.current.catch(() => {}).then(() =>
      nativeSession.save(session, preferencesRef.current.restoreLastSession));
    return writeQueue.current;
  }, [serializeSession]);
  const schedulePersist = useCallback(() => {
    if (!bootedRef.current) return;
    if (persistTimer.current !== null) window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => {
      persistTimer.current = null;
      void persistNow().catch((cause) => setWorkspaceError(`记录会话失败：${explainNativeError(cause).message}`));
    }, 300);
  }, [persistNow]);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = preferences.theme;
    document.documentElement.dataset.density = preferences.density;
  }, [preferences.theme, preferences.density]);
  useEffect(() => {
    themeQueue.current = themeQueue.current.catch(() => {}).then(async () => {
      const nativeWindow = getCurrentWindow();
      await nativeWindow.setTheme(preferences.theme);
      document.documentElement.dataset.nativeWindowTheme = await nativeWindow.theme() ?? 'system';
    });
    void themeQueue.current.catch((cause) =>
      setWorkspaceError(`同步原生窗口主题失败：${explainNativeError(cause).message}`));
  }, [preferences.theme]);
  useEffect(() => {
    writePreferences(preferences);
    schedulePersist();
  }, [preferences, schedulePersist]);

  const updateTabs = useCallback((next: TabRecord[]) => { tabsRef.current = next; setTabs(next); schedulePersist(); }, [schedulePersist]);
  const activate = useCallback((id: string) => { activeRef.current = id; setActiveId(id); setPreferencesTabActive(false); schedulePersist(); }, [schedulePersist]);
  const openPreferences = useCallback(() => { setPreferencesTabOpen(true); setPreferencesTabActive(true); }, []);
  const closePreferences = useCallback(() => { setPreferencesTabOpen(false); setPreferencesTabActive(false); }, []);
  useLayoutEffect(() => {
    const menu = tabMenuRef.current;
    if (!menu || !tabMenu) return;
    menu.style.left = `${Math.max(8, Math.min(tabMenu.x, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(tabMenu.y, window.innerHeight - menu.offsetHeight - 8))}px`;
    menu.dataset.openLeft = String(menu.getBoundingClientRect().right + 145 > window.innerWidth);
    menu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [tabMenu]);
  useEffect(() => {
    if (!tabMenu) return;
    const dismiss = (event: PointerEvent) => { if (!tabMenuRef.current?.contains(event.target as Node)) setTabMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setTabMenu(null); tabMenuTriggerRef.current?.focus({ preventScroll: true }); } };
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('keydown', escape, true);
    return () => { window.removeEventListener('pointerdown', dismiss, true); window.removeEventListener('keydown', escape, true); };
  }, [tabMenu]);
  const onPositionChange = useCallback((id: string, changed: Partial<SessionPosition>) => {
    const current = tabsRef.current.find((item) => item.id === id);
    if (!current) return;
    const next = { ...current, ...changed };
    if (next.anchor === current.anchor && next.head === current.head && next.scrollTop === current.scrollTop) return;
    tabsRef.current = tabsRef.current.map((item) => item.id === id ? next : item);
    schedulePersist();
  }, [schedulePersist]);
  const onPathChange = useCallback((id: string, path: string | null) => {
    const next = tabsRef.current.map((item) => item.id === id ? { ...item, path } : item);
    updateTabs(next);
  }, [updateTabs]);
  const onDirtyChange = useCallback((id: string, dirty: boolean) => {
    if (tabsRef.current.find((item) => item.id === id)?.dirty === dirty) return;
    updateTabs(tabsRef.current.map((item) => item.id === id ? { ...item, dirty } : item));
  }, [updateTabs]);
  const onLoaded = useCallback((id: string) => {
    if (!tabsRef.current.some((item) => item.id === id && item.initialOpened)) return;
    updateTabs(tabsRef.current.map((item) => item.id === id ? { ...item, initialOpened: undefined } : item));
  }, [updateTabs]);
  const onActionsChange = useCallback((id: string, actions: TabActions | null) => {
    if (actions) actionsRef.current.set(id, actions);
    else actionsRef.current.delete(id);
  }, []);

  const openPath = useCallback(async (requestedPath: string) => {
    const opened = await nativeFiles.open(requestedPath);
    const existing = tabsRef.current.find((item) => samePath(item.path, opened.path));
    if (existing) { activate(existing.id); return; }
    const id = `tab-${crypto.randomUUID()}`;
    try { await nativeFiles.registerTab(windowLabel, id, opened.path); }
    catch (cause) {
      if (explainNativeError(cause).kind === 'already_open') {
        await nativeFiles.openWindow(opened.path);
        return;
      }
      throw cause;
    }
    updateTabs([...tabsRef.current, { id, path: opened.path, initialOpened: opened,
      anchor: 0, head: 0, scrollTop: 0 }]);
    activate(id);
    setWorkspaceError('');
  }, [activate, updateTabs, windowLabel]);
  const newTab = useCallback(() => {
    const id = `tab-${crypto.randomUUID()}`;
    updateTabs([...tabsRef.current, { id, path: null, anchor: 0, head: 0, scrollTop: 0 }]);
    activate(id);
  }, [activate, updateTabs]);

  useEffect(() => {
    let cancelled = false;
    const restore = async () => {
      const restored: TabRecord[] = [];
      const failures: string[] = [];
      let selected = '';
      try {
        const saved = preferencesRef.current.restoreLastSession ? await nativeSession.read(sessionKey) : null;
        for (const tab of saved?.tabs ?? []) {
          if (cancelled) return;
          if (!tab.id || restored.some((item) => item.id === tab.id)) continue;
          if (!tab.path) { restored.push({ id: tab.id, path: null, ...validPosition(tab) }); continue; }
          if (restored.some((item) => samePath(item.path, tab.path))) continue;
          try {
            const opened = await nativeFiles.open(tab.path);
            await nativeFiles.registerTab(windowLabel, tab.id, opened.path);
            restored.push({ id: tab.id, path: opened.path, initialOpened: opened, ...validPosition(tab) });
          } catch (cause) {
            if (basename(tab.path).toLowerCase() === 'untitled.md' && explainNativeError(cause).kind === 'not_found') {
              try {
                const byId = await nativeFiles.loadRecovery(tab.id);
                const byOldPath = byId ? null : await nativeFiles.loadRecovery(recoveryKey(tab.path, tab.id));
                if (!byId && byOldPath?.path === '') await nativeFiles.saveRecovery(tab.id, byOldPath);
                if (!byId?.path && !byOldPath?.path) {
                  restored.push({ id: tab.id, path: null, ...validPosition(tab) });
                  continue;
                }
              } catch (snapshotError) {
                failures.push(`未命名文档：恢复快照读取失败：${recoveryReason(snapshotError)}`);
                continue;
              }
            }
            failures.push(`${basename(tab.path)}：${recoveryReason(cause)}`);
          }
        }
        selected = restored.some((item) => item.id === saved?.activeId) ? saved!.activeId! : restored[0]?.id ?? '';
        if (launchPath) {
          try {
            const opened = await nativeFiles.open(launchPath);
            const existing = restored.find((item) => samePath(item.path, opened.path));
            if (existing) selected = existing.id;
            else {
              const id = restored.length ? `tab-${crypto.randomUUID()}` : windowLabel;
              await nativeFiles.registerTab(windowLabel, id, opened.path);
              restored.push({ id, path: opened.path, initialOpened: opened, anchor: 0, head: 0, scrollTop: 0 });
              selected = id;
            }
          } catch (cause) { failures.push(`${basename(launchPath)}：${recoveryReason(cause)}`); }
        }
        if (cancelled) return;
        if (!restored.length) {
          const id = windowLabel;
          restored.push({ id, path: null, anchor: 0, head: 0, scrollTop: 0 });
          selected = id;
        }
        tabsRef.current = restored;
        activeRef.current = selected;
        setTabs(restored);
        setActiveId(selected);
        setRestoreFailures(failures);
        bootedRef.current = true;
        setBooted(true);
        schedulePersist();
        if (failures.length) void persistNow({ key: sessionKey,
          tabs: restored.map(({ id, path, anchor, head, scrollTop }) => ({ id, path, anchor, head, scrollTop })),
          activeId: selected || null }).catch((cause) => setWorkspaceError(`清理失效会话记录失败：${recoveryReason(cause)}`));
        for (const pending of queuedPaths.current.splice(0)) {
          try { await openPath(pending); }
          catch (cause) { setWorkspaceError(`打开失败：${explainNativeError(cause).message}`); }
        }
      } catch (cause) {
        if (cancelled) return;
        const id = windowLabel;
        const fallback = [{ id, path: null, anchor: 0, head: 0, scrollTop: 0 }];
        tabsRef.current = fallback; activeRef.current = id;
        setTabs(fallback); setActiveId(id); setBooted(true); bootedRef.current = true;
        setWorkspaceError(`恢复会话失败：${explainNativeError(cause).message}`);
      }
    };
    void restore();
    return () => { cancelled = true; };
  }, [launchPath, openPath, persistNow, schedulePersist, sessionKey, windowLabel]);

  useEffect(() => {
    if (!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) return;
    let dispose: (() => void) | undefined;
    let mounted = true;
    const consume = async (fallback?: string) => {
      let paths: string[];
      try { paths = await nativeSession.takePendingOpens(windowLabel); }
      catch (cause) {
        if (!fallback) { setWorkspaceError(`接收打开文件请求失败：${explainNativeError(cause).message}`); return; }
        paths = [];
      }
      if (fallback && !paths.includes(fallback)) paths.push(fallback);
      for (const path of paths) {
        if (!bootedRef.current) queuedPaths.current.push(path);
        else try { await openPath(path); }
          catch (cause) { setWorkspaceError(`打开失败：${explainNativeError(cause).message}`); }
      }
    };
    void listen<string>('open-document', (event) => { void consume(event.payload); })
      .then((unlisten) => { if (mounted) { dispose = unlisten; void consume(); } else unlisten(); });
    return () => { mounted = false; dispose?.(); };
  }, [openPath, windowLabel]);

  const prepareClose = useCallback(async (tab: TabRecord): Promise<boolean> => {
    const actions = actionsRef.current.get(tab.id);
    if (!actions?.dirty()) return true;
    try { await actions.flush(); }
    catch (cause) { setWorkspaceError(`关闭已取消：恢复快照写入失败：${explainNativeError(cause).message}`); return false; }
    const saveFirst = await askToClose(`${basename(tab.path ?? '未命名文档')} 有未保存修改。是否保存并关闭？`, '未保存的修改');
    if (saveFirst) return actions.saveForClose();
    if (!await askToClose('不保存修改并关闭？这会删除该标签的恢复快照。选择“不”可继续编辑。', '关闭文档')) return false;
    try { await actions.discard(); return true; }
    catch (cause) { setWorkspaceError(`关闭已取消：清理恢复快照失败：${explainNativeError(cause).message}`); return false; }
  }, []);

  const closeTab = useCallback(async (id: string) => {
    const tab = tabsRef.current.find((item) => item.id === id);
    if (!tab || !await prepareClose(tab)) return;
    if (tabsRef.current.length === 1) {
      try { await persistNow(serializeSession([], '')); }
      catch (cause) { setWorkspaceError(`关闭已取消：会话记录失败：${explainNativeError(cause).message}`); return; }
      await nativeFiles.releaseTab(windowLabel, id);
      await getCurrentWindow().destroy();
      return;
    }
    try { await nativeFiles.releaseTab(windowLabel, id); }
    catch (cause) { setWorkspaceError(`关闭标签时更新文件登记失败：${explainNativeError(cause).message}`); return; }
    const index = tabsRef.current.findIndex((item) => item.id === id);
    const next = tabsRef.current.filter((item) => item.id !== id);
    updateTabs(next);
    if (activeRef.current === id) activate(next[Math.min(index, next.length - 1)].id);
    try { await persistNow(); }
    catch (cause) { setWorkspaceError(`已关闭标签，但会话记录失败：${explainNativeError(cause).message}`); }
  }, [activate, persistNow, prepareClose, serializeSession, updateTabs, windowLabel]);

  useEffect(() => {
    const windowHandle = getCurrentWindow();
    let dispose: (() => void) | undefined;
    let mounted = true;
    let closing = false;
    void windowHandle.onCloseRequested(async (event) => {
      event.preventDefault();
      if (closing) return;
      if (!bootedRef.current) return;
      closing = true;
      try {
        for (const tab of tabsRef.current) {
          if (!await prepareClose(tab)) return;
        }
        await persistNow();
        await windowHandle.destroy();
      } catch (cause) { setWorkspaceError(`关闭已取消：${explainNativeError(cause).message}`); }
      finally { closing = false; }
    }).then((unlisten) => { if (mounted) dispose = unlisten; else unlisten(); });
    return () => { mounted = false; dispose?.(); };
  }, [persistNow, prepareClose]);

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.isComposing || event.key === 'Process' || event.keyCode === 229 || event.altKey || !(event.ctrlKey || event.metaKey)) return;
      if (event.key === 'Tab') {
        event.preventDefault();
        const order = [...tabsRef.current.map((item) => item.id), ...(preferencesTabOpen ? ['preferences'] : [])];
        const current = preferencesTabActive ? 'preferences' : activeRef.current;
        const index = order.indexOf(current);
        const next = order[(index + (event.shiftKey ? -1 : 1) + order.length) % order.length];
        if (next === 'preferences') setPreferencesTabActive(true); else activate(next);
      } else if (event.key.toLowerCase() === 'w' && !event.shiftKey) {
        event.preventDefault();
        if (preferencesTabActive) closePreferences(); else void closeTab(activeRef.current);
      }
    };
    window.addEventListener('keydown', handle, true);
    return () => window.removeEventListener('keydown', handle, true);
  }, [activate, closePreferences, closeTab, preferencesTabActive, preferencesTabOpen]);

  useEffect(() => {
    const tab = tabs.find((item) => item.id === activeId);
    const update = getCurrentWindow().setTitle?.(`${tab?.dirty ? '● ' : ''}${basename(tab?.path ?? 'untitled.md')} — Mintdown`);
    void update?.catch((cause) => setWorkspaceError(`更新窗口标题失败：${explainNativeError(cause).message}`));
  }, [activeId, tabs]);

  const tabFilePath = async (id: string): Promise<string | null> => {
    const current = tabsRef.current.find((item) => item.id === id);
    if (current?.path) return current.path;
    if (!await actionsRef.current.get(id)?.saveAs()) return null;
    return tabsRef.current.find((item) => item.id === id)?.path ?? null;
  };
  const runTabMenu = async (id: string, action: 'saveAs' | 'move' | 'relink' | 'reveal' | 'copy' | 'close' | 'html' | 'pdf') => {
    setTabMenu(null);
    try {
      const operations = actionsRef.current.get(id);
      if (action === 'html' || action === 'pdf') {
        if (!preferencesTabActive) document.querySelector<HTMLElement>('.document-tab-panel:not([hidden]) .cm-content')?.focus({ preventScroll: true });
        await operations?.exportDocument(action);
      }
      else if (action === 'saveAs') { activate(id); await operations?.saveAs(); }
      else if (action === 'move') { activate(id); await operations?.move(); }
      else if (action === 'relink') { activate(id); await operations?.relink(); }
      else if (action === 'close') await closeTab(id);
      else {
        const path = await tabFilePath(id);
        if (!path) return;
        if (action === 'reveal') await nativeFiles.revealInExplorer(path);
        else {
          const visiblePath = readableWindowsPath(path);
          try { await navigator.clipboard.writeText(visiblePath); }
          catch {
            const input = document.createElement('textarea');
            input.value = visiblePath; input.style.position = 'fixed'; input.style.left = '-10000px';
            document.body.append(input); input.select();
            const copied = document.execCommand('copy'); input.remove();
            if (!copied) throw new Error('系统剪贴板不可用');
          }
        }
      }
    } catch (cause) { setWorkspaceError(`标签操作失败：${explainNativeError(cause).message}`); }
  };
  const tabMenuKeys = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowRight' && document.activeElement?.getAttribute('aria-haspopup') === 'menu') {
      event.preventDefault(); setTabExportOpen(true); requestAnimationFrame(() => tabMenuRef.current?.querySelector<HTMLButtonElement>('.menu-submenu button')?.focus()); return;
    }
    if (event.key === 'ArrowLeft' && tabExportOpen) { event.preventDefault(); setTabExportOpen(false); tabMenuRef.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.focus(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].filter(e => !e.closest('[hidden]'));
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
      (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus({ preventScroll: true });
  };
  const showTabMenu = (id: string, preferencesTab: boolean, trigger: HTMLButtonElement, x: number, y: number) => {
    tabMenuTriggerRef.current = trigger;
    setTabExportOpen(false);
    setTabMenu({ id, x, y, preferences: preferencesTab });
  };
  const tabMenuKeyboard = (event: React.KeyboardEvent<HTMLButtonElement>, id: string, preferencesTab: boolean) => {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    showTabMenu(id, preferencesTab, event.currentTarget, bounds.left + 12, bounds.bottom);
  };

  if (!booted) return <div className="tab-workspace"><p className="editor-loading">正在恢复上次会话…</p></div>;
  const untitledCount = tabs.filter((tab) => !tab.path).length;
  return <div className="tab-workspace" data-outline-open={preferences.outlineOpen}
    style={{ '--outline-width': `${preferences.outlineWidth}px` } as React.CSSProperties}>
    <div className="document-tabs" role="tablist" aria-label="打开的文档">
      {tabs.map((tab) => <div className="document-tab" key={tab.id}
        onContextMenu={(event) => { event.preventDefault(); showTabMenu(tab.id, false, event.currentTarget.querySelector<HTMLButtonElement>('[role="tab"]')!, event.clientX, event.clientY); }}>
        <button type="button" role="tab" aria-selected={!preferencesTabActive && tab.id === activeId} onClick={() => activate(tab.id)} onKeyDown={(event) => tabMenuKeyboard(event, tab.id, false)}
          title={tab.path ?? '未命名文档'}>{tab.path ? basename(tab.path) : untitledCount > 1
            ? `未命名 ${tabs.filter((item) => !item.path).findIndex((item) => item.id === tab.id) + 1}.md` : 'untitled.md'}
          {tab.dirty && <span className="tab-dirty" aria-label="未保存"> ●</span>}</button>
        <button type="button" className="tab-close" aria-label={`关闭 ${basename(tab.path ?? '未命名文档')}`} onClick={() => void closeTab(tab.id)}>×</button>
      </div>)}
      {preferencesTabOpen && <div className="document-tab preferences-document-tab"
        onContextMenu={(event) => { event.preventDefault(); showTabMenu('preferences', true, event.currentTarget.querySelector<HTMLButtonElement>('[role="tab"]')!, event.clientX, event.clientY); }}>
        <button type="button" role="tab" aria-selected={preferencesTabActive} onClick={() => setPreferencesTabActive(true)} onKeyDown={(event) => tabMenuKeyboard(event, 'preferences', true)}>偏好设置</button>
        <button type="button" className="tab-close" aria-label="关闭偏好设置" onClick={closePreferences}>×</button>
      </div>}
    </div>
    {tabMenu && <div ref={tabMenuRef} className="tab-context-menu" role="menu" aria-label={tabMenu.preferences ? '设置标签菜单' : '文档标签菜单'} onKeyDown={tabMenuKeys}>
      {tabMenu.preferences ? <button type="button" role="menuitem" onClick={() => { setTabMenu(null); closePreferences(); }}>关闭偏好设置</button> : <>
        <button type="button" role="menuitem" onClick={() => void runTabMenu(tabMenu.id, 'saveAs')}>另存为…</button>
        <div className="menu-entry" onMouseEnter={() => setTabExportOpen(true)}>
          <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={tabExportOpen} onClick={() => setTabExportOpen(!tabExportOpen)}>导出 ▸</button>
          <div className="menu-submenu" role="menu" aria-label="导出" hidden={!tabExportOpen}>
            <button type="button" role="menuitem" onClick={() => void runTabMenu(tabMenu.id, 'html')}>HTML…</button>
            <button type="button" role="menuitem" onClick={() => void runTabMenu(tabMenu.id, 'pdf')}>PDF…</button>
          </div>
        </div>
        <button type="button" role="menuitem" onClick={() => void runTabMenu(tabMenu.id, 'move')}>重命名或移动…</button>
        <button type="button" role="menuitem" onClick={() => void runTabMenu(tabMenu.id, 'relink')}>重新定位图片…</button>
        <div className="tab-context-separator" role="separator" />
        <button type="button" role="menuitem" onClick={() => void runTabMenu(tabMenu.id, 'reveal')}>在资源管理器中显示</button>
        <button type="button" role="menuitem" onClick={() => void runTabMenu(tabMenu.id, 'copy')}>复制完整文件路径</button>
        <button type="button" role="menuitem" onClick={() => void runTabMenu(tabMenu.id, 'close')}>关闭标签</button>
      </>}
    </div>}
    <div className="export-notices" aria-live="polite">{Object.values(exportNotices).map(notice => <aside className="export-notice" key={notice.id} data-phase={notice.phase} role={notice.phase === 'error' ? 'alert' : 'status'}>
      <span><strong>{notice.name}</strong> · {notice.message}</span>
      {notice.details?.length ? <details><summary>详情</summary><ul>{notice.details.map((detail, i) => <li key={i}>{detail}</li>)}</ul></details> : null}
      {notice.phase !== 'working' && <button type="button" aria-label="关闭导出状态" onClick={() => onExportNotice(notice.id, null)}>×</button>}
    </aside>)}</div>
    {workspaceError && <p className="workspace-error" role="alert">{workspaceError}</p>}
    {restoreFailures.length > 0 && <aside className="restore-notice" role="dialog" aria-label="会话恢复提示">
      <div className="restore-notice-heading"><strong>部分文件未恢复</strong><button type="button" aria-label="关闭恢复提示" onClick={() => setRestoreFailures([])}>×</button></div>
      <ul>{restoreFailures.map((failure, index) => <li key={`${index}-${failure}`}>{failure}</li>)}</ul>
      <button type="button" className="restore-notice-ack" onClick={() => setRestoreFailures([])}>知道了</button>
    </aside>}
    {tabs.map((tab) => <DocumentTabApp key={tab.id} tab={tab} active={tab.id === activeId} preferencesActive={preferencesTabActive && tab.id === activeId}
      onOpenPreferences={openPreferences} onClosePreferences={closePreferences}
      preferences={preferences} setPreferences={setPreferences} onPathChange={onPathChange} onDirtyChange={onDirtyChange} onLoaded={onLoaded}
      onOpenPath={openPath} onNewTab={newTab} onCloseTab={(id) => void closeTab(id)} onActionsChange={onActionsChange} onPositionChange={onPositionChange} onExportNotice={onExportNotice} />)}
  </div>;
}
