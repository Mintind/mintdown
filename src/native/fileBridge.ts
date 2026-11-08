import { invoke } from '@tauri-apps/api/core';

export interface OpenedDocument {
  path: string;
  bytes: number[];
  fingerprint: string;
}

export interface SavedDocument { fingerprint: string }
export interface SavedAsDocument extends SavedDocument { path: string }
export interface ArchivedImage { reference: string; name: string }
export interface ImageCopyPlan { token: string; references: { oldUrl: string; newUrl: string }[]; unresolved: string[] }
export interface RelinkArchivePreview { targetDirectory: string; references: { oldUrl: string; newUrl: string }[];
  copies: { source: string; target: string; reused: boolean }[] }
export interface RelinkCandidate { path: string; newUrl: string }
export interface MissingImage { oldUrl: string; fileName: string; reason: string; autoCandidates: number; candidates: RelinkCandidate[] }
export interface RelinkScan { entries: MissingImage[]; scannedFiles: number; alreadyValid: number }
export interface MovePlan { token: string; references: { oldUrl: string; newUrl: string }[]; unresolved: string[];
  resourceTargets: string[]; resourceOperations: { source: string; target: string; action: 'copy' | 'move' | 'reuse' }[];
  targetExists: boolean }
export interface MovedDocument { fingerprint: string; path: string; warning: string | null }

export interface RecoverySnapshot {
  path: string;
  fingerprint: string;
  source: string;
  visualState: unknown | null;
  unsafeVisual: boolean;
  savedAt: string;
}

export interface NativeError { kind: string; message: string }

export function explainNativeError(error: unknown): NativeError {
  if (typeof error === 'object' && error && 'kind' in error && 'message' in error) {
    return error as NativeError;
  }
  return { kind: 'io', message: String(error) };
}

export const nativeFiles = {
  exportTargetFingerprint: (path: string, extension: 'html' | 'pdf') =>
    invoke<string | null>('export_target_fingerprint', { path, extension }),
  writeExportHtml: (path: string, html: string, expected: string | null) =>
    invoke<Record<string, number>>('write_export_html', { path, html, expected }),
  writeExportPdf: (path: string, html: string, expected: string | null) =>
    invoke<Record<string, number>>('write_export_pdf', { path, html, expected }),
  open: (path: string) => invoke<OpenedDocument>('open_document', { path }),
  archiveImage: (documentPath: string | null, sessionId: string, directoryTemplate: string, referenceStyle: string, originalName: string, bytes: Uint8Array) =>
    invoke<ArchivedImage>('archive_document_image', { documentPath, sessionId, directoryTemplate, referenceStyle, originalName, bytes: Array.from(bytes) }),
  archiveLocalImage: (documentPath: string | null, sessionId: string, directoryTemplate: string, referenceStyle: string, sourcePath: string) =>
    invoke<ArchivedImage>('archive_local_image', { documentPath, sessionId, directoryTemplate, referenceStyle, sourcePath }),
  copyImages: (sourceDocument: string | null, sessionId: string, targetDocument: string, directoryTemplate: string, referenceStyle: string, urls: string[]) =>
    invoke<ImageCopyPlan>('copy_document_images', { sourceDocument, sessionId, targetDocument, directoryTemplate, referenceStyle, urls }),
  scanMissingImages: (documentPath: string, directoryTemplate: string, referenceStyle: string, selectedFolder: string, urls: string[], previewFailedUrls: string[] = []) =>
    invoke<RelinkScan>('scan_missing_images', { documentPath, directoryTemplate, referenceStyle, selectedFolder, urls, previewFailedUrls }),
  chooseRelinkImage: (documentPath: string, referenceStyle: string, imagePath: string) =>
    invoke<RelinkCandidate>('choose_relink_image', { documentPath, referenceStyle, imagePath }),
  stageRelinkArchives: (documentPath: string, directoryTemplate: string, referenceStyle: string, selected: [string, string][]) =>
    invoke<ImageCopyPlan>('stage_relink_archives', { documentPath, directoryTemplate, referenceStyle, selected }),
  previewRelinkArchives: (documentPath: string, directoryTemplate: string, referenceStyle: string, selected: [string, string][]) =>
    invoke<RelinkArchivePreview>('preview_relink_archives', { documentPath, directoryTemplate, referenceStyle, selected }),
  prepareMove: (sourcePath: string, targetPath: string, expectedFingerprint: string, directoryTemplate: string, referenceStyle: string, urls: string[]) =>
    invoke<MovePlan>('prepare_document_move', { sourcePath, targetPath, expectedFingerprint, directoryTemplate, referenceStyle, urls }),
  cancelMove: (token: string) => invoke<void>('cancel_document_move', { token }),
  finishMove: (currentWindowLabel: string, currentTabId: string, token: string, bytes: Uint8Array, overwrite: boolean) =>
    invoke<MovedDocument>('finish_document_move', { currentWindowLabel, currentTabId, token, bytes: Array.from(bytes), overwrite }),
  finishImageCopies: (token: string, commit: boolean) => invoke<void>('finish_image_copies', { token, commit }),
  save: (path: string, expectedFingerprint: string, bytes: Uint8Array, force = false) =>
    invoke<SavedDocument>('save_document', { path, expectedFingerprint, bytes: Array.from(bytes), force }),
  saveAs: (currentWindowLabel: string, currentTabId: string, path: string, bytes: Uint8Array, force = false) =>
    invoke<SavedAsDocument>('save_document_as', { currentWindowLabel, currentTabId, path, bytes: Array.from(bytes), force }),
  registerTab: (currentWindowLabel: string, tabId: string, path: string) =>
    invoke<void>('register_document_tab', { currentWindowLabel, tabId, path }),
  releaseTab: (currentWindowLabel: string, tabId: string) =>
    invoke<void>('release_document_tab', { currentWindowLabel, tabId }),
  openWindow: (path: string) => invoke<void>('open_path_window', { path }),
  openTab: (path: string) => invoke<void>('open_path_tab', { path }),
  revealInExplorer: (path: string) => invoke<void>('reveal_document_in_explorer', { path }),
  loadRecovery: (key: string) => invoke<RecoverySnapshot | null>('load_recovery', { key }),
  saveRecovery: (key: string, snapshot: RecoverySnapshot) => invoke<void>('save_recovery', { key, snapshot }),
  clearRecovery: (key: string) => invoke<void>('clear_recovery', { key }),
};
