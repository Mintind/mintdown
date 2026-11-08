export function decodePng(bytes: Buffer): { width: number; height: number; channels: number; pixels: Buffer };
export function comparePng(actual: Buffer, expected: Buffer, tolerance?: number, maximumRatio?: number): any;
