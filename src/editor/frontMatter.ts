import YAML from 'yaml';

export interface FrontMatterRange {
  from: number;
  to: number;
  openerTo: number;
  closerFrom: number;
}

/** Source offsets are retained verbatim; YAML is parsed only to validate display. */
export function frontMatterRange(source: string): FrontMatterRange | null {
  const from = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const firstBreak = source.indexOf('\n', from);
  if (firstBreak < 0 || !/^---[ \t]*\r?$/.test(source.slice(from, firstBreak))) return null;
  const openerTo = firstBreak + 1;
  for (let lineFrom = openerTo; lineFrom <= source.length;) {
    const breakAt = source.indexOf('\n', lineFrom);
    const lineTo = breakAt < 0 ? source.length : breakAt;
    const line = source.slice(lineFrom, lineTo).replace(/\r$/, '');
    if (/^(?:---|\.\.\.)[ \t]*$/.test(line)) {
      const rawYaml = source.slice(openerTo, lineFrom);
      try {
        const parsed = YAML.parseDocument(rawYaml, { uniqueKeys: false });
        if (parsed.errors.length || parsed.contents && !YAML.isMap(parsed.contents)) return null;
      } catch { return null; }
      return { from, to: lineTo, openerTo, closerFrom: lineFrom };
    }
    if (breakAt < 0) break;
    lineFrom = breakAt + 1;
  }
  return null;
}

/** Keep blank source lines visible even when an opening delimiter is incomplete. */
export function frontMatterCandidateEnd(source: string): number {
  const from = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const firstBreak = source.indexOf('\n', from);
  if (firstBreak < 0 || !/^---[ \t]*\r?$/.test(source.slice(from, firstBreak))) return -1;
  for (let lineFrom = firstBreak + 1; lineFrom <= source.length;) {
    const breakAt = source.indexOf('\n', lineFrom);
    const lineTo = breakAt < 0 ? source.length : breakAt;
    if (/^(?:---|\.\.\.)[ \t]*\r?$/.test(source.slice(lineFrom, lineTo))) return lineTo;
    if (breakAt < 0) break;
    lineFrom = breakAt + 1;
  }
  return source.length;
}
