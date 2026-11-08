import type { ImageReferenceStyle } from '../assets/imagePaths';

export interface EditorPreferences {
  outlineOpen: boolean;
  outlineWidth: number;
  writingWidth: number;
  fontSize: number;
  theme: 'light' | 'dark';
  density: 'standard' | 'compact';
  spellCheck: boolean;
  restoreLastSession: boolean;
  imageDirectoryTemplate: string;
  imageReferenceStyle: ImageReferenceStyle;
}

const storageKey = 'markdown-editor.b2-1.preferences';

export const defaultPreferences: EditorPreferences = {
  outlineOpen: true,
  outlineWidth: 264,
  writingWidth: 900,
  fontSize: 18,
  theme: 'light',
  density: 'standard',
  spellCheck: true,
  restoreLastSession: true,
  imageDirectoryTemplate: '${filename}.assets',
  imageReferenceStyle: 'relative',
};

export function clampOutlineWidth(value: number): number {
  return Math.max(200, Math.min(420, Math.round(value)));
}

export function clampWritingWidth(value: number): number {
  return Math.max(600, Math.min(1200, Math.round(value)));
}

export function clampFontSize(value: number): number {
  return Math.max(14, Math.min(26, Math.round(value)));
}

export function outlineIndent(level: number, density: EditorPreferences['density']): number {
  return density === 'compact' ? 10 + (level - 1) * 11 : 12 + (level - 1) * 16;
}

export function readPreferences(): EditorPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}') as Partial<EditorPreferences>;
    return {
      outlineOpen: typeof saved.outlineOpen === 'boolean' ? saved.outlineOpen : true,
      outlineWidth: Number.isFinite(saved.outlineWidth) ? clampOutlineWidth(saved.outlineWidth!) : 264,
      writingWidth: Number.isFinite(saved.writingWidth) ? clampWritingWidth(saved.writingWidth!) : 900,
      fontSize: Number.isFinite(saved.fontSize) ? clampFontSize(saved.fontSize!) : 18,
      theme: saved.theme === 'dark' ? 'dark' : 'light',
      density: saved.density === 'compact' ? 'compact' : 'standard',
      spellCheck: typeof saved.spellCheck === 'boolean' ? saved.spellCheck : true,
      restoreLastSession: typeof saved.restoreLastSession === 'boolean' ? saved.restoreLastSession : true,
      imageDirectoryTemplate: typeof saved.imageDirectoryTemplate === 'string' ? saved.imageDirectoryTemplate : defaultPreferences.imageDirectoryTemplate,
      imageReferenceStyle: saved.imageReferenceStyle === 'asset-relative' ? 'asset-relative' : 'relative',
    };
  } catch { return { ...defaultPreferences }; }
}

export function writePreferences(preferences: EditorPreferences): void {
  try { localStorage.setItem(storageKey, JSON.stringify(preferences)); }
  catch { /* The editor continues with in-memory settings if storage is unavailable. */ }
}
