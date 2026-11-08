export type Snapshot = { head: string; files: Record<string, { sha256: string; text?: string }>; index?: Record<string, string> };
export const project: string;
export function matches(path: string, pattern: string): boolean;
export function capture(root?: string): Snapshot;
export function review(before: Snapshot, after: Snapshot, task: any, areas: any[]): any;
export function checkTask(taskPath: string, snapshotPath?: string, root?: string): any;
export function main(args?: string[]): void;
