import { invoke } from '@tauri-apps/api/core';

export interface SessionPosition {
  anchor: number;
  head: number;
  scrollTop: number;
}

export interface SessionTab extends SessionPosition {
  id: string;
  path: string | null;
}

export interface WindowSession {
  key: string;
  tabs: SessionTab[];
  activeId: string | null;
}

export const nativeSession = {
  read: (key: string) => invoke<WindowSession | null>('read_window_session', { key }),
  save: (session: WindowSession, restoreOnStartup: boolean) =>
    invoke<void>('save_window_session', { session, restoreOnStartup }),
  takePendingOpens: (label: string) => invoke<string[]>('take_pending_open_requests', { label }),
};

export function validPosition(value: Partial<SessionPosition> | null | undefined): SessionPosition {
  const clamp = (number: unknown) => typeof number === 'number' && Number.isFinite(number) && number >= 0
    ? Math.floor(number) : 0;
  return { anchor: clamp(value?.anchor), head: clamp(value?.head),
    scrollTop: typeof value?.scrollTop === 'number' && Number.isFinite(value.scrollTop) && value.scrollTop >= 0
      ? value.scrollTop : 0 };
}
