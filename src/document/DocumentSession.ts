import { parseSegments, type Segment } from '../markdown/segments';

const utf8 = new TextEncoder();
const bom = new Uint8Array([0xef, 0xbb, 0xbf]);

export class DocumentSession {
  private originalBytes: Uint8Array;
  private originalSource: string;
  private source: string;
  private readonly hasBom: boolean;
  private readonly newline: '\n' | '\r\n';

  constructor(bytes: Uint8Array) {
    this.originalBytes = bytes.slice();
    this.hasBom = bytes.length >= 3 && bom.every((part, index) => bytes[index] === part);
    const body = this.hasBom ? bytes.subarray(3) : bytes;
    this.originalSource = new TextDecoder('utf-8', { fatal: true }).decode(body);
    this.source = this.originalSource;
    this.newline = this.originalSource.includes('\r\n') ? '\r\n' : '\n';
  }

  static fromText(source: string): DocumentSession {
    return new DocumentSession(utf8.encode(source));
  }

  getSegments(): Segment[] {
    return parseSegments(this.source);
  }

  getSource(): string {
    return this.source;
  }

  setSource(source: string): void {
    // The canonical source is authoritative, including incomplete Markdown.
    // Parsing every keystroke would both block input and risk leaving the
    // editor ahead of the session if a parser rejects a transient edit.
    this.source = source;
  }

  isDirty(): boolean {
    return this.getSource() !== this.originalSource;
  }

  markSaved(bytes: Uint8Array, sourceAtSave = this.source): void {
    this.originalBytes = bytes.slice();
    this.originalSource = sourceAtSave;
  }

  toBytes(): Uint8Array {
    if (!this.isDirty()) return this.originalBytes.slice();
    const source = this.getSource();
    const normalized = this.newline === '\r\n'
      ? source.replace(/\r?\n/g, '\r\n')
      : source;
    const data = utf8.encode(normalized);
    if (!this.hasBom) return data;
    const result = new Uint8Array(bom.length + data.length);
    result.set(bom);
    result.set(data, bom.length);
    return result;
  }
}
