export function collectBuildInfo(root: string, command: string, mode: string): {
  version: string; revision: string; dirty: boolean | null; sourceSha256: string;
  channel: string; mode: string; builtAt: string; id: string;
};
