export type PublicFile = { path: string; bytes: number; sha256: string };
export function sha256(bytes: Uint8Array): string;
export function auditPublicDirectory(directory: string): {
  files: PublicFile[];
  applicationSourceIncluded: true;
  allowListPassed: true;
};
