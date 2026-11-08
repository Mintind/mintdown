export type RenderTier = 'normal' | 'light' | 'source';

export interface DocumentCost {
  characters: number;
  tableRows: number;
  codeFences: number;
  images: number;
  formulas: number;
  weighted: number;
}

/** A cheap estimate for the full preview parser's work, not a Markdown parser. */
export function estimateDocumentCost(source: string): DocumentCost {
  let tableRows = 0, codeFences = 0, images = 0, formulas = 0;
  for (const line of source.split('\n')) {
    if (/^\s*\|.+\|\s*$/.test(line)) tableRows++;
    if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) codeFences++;
    images += (line.match(/!\[[^\]]*\]\(/g) ?? []).length;
    formulas += (line.match(/\$/g) ?? []).length / 2;
  }
  return { characters: source.length, tableRows, codeFences, images, formulas,
    weighted: source.length + tableRows * 160 + codeFences * 180 + images * 160 + formulas * 70 };
}

export class PerformanceGovernor {
  tier: RenderTier;
  private slow = 0;
  private fast = 0;
  private since = 0;

  constructor(source: string, now = Date.now()) {
    const weighted = estimateDocumentCost(source).weighted;
    this.tier = weighted >= 150_000 ? 'source' : weighted >= 80_000 ? 'light' : 'normal';
    this.since = now;
  }

  observeVisual(durationMs: number, now = Date.now()): RenderTier {
    if (this.tier === 'source') return this.tier;
    const limit = this.tier === 'normal' ? 50 : 65;
    this.slow = durationMs > limit ? this.slow + 1 : 0;
    this.fast = durationMs < 25 ? this.fast + 1 : 0;
    if (this.slow >= 3) {
      this.tier = this.tier === 'normal' ? 'light' : 'source';
      this.slow = this.fast = 0;
      this.since = now;
    } else if (this.tier === 'light' && this.fast >= 20 && now - this.since >= 5_000) {
      this.tier = 'normal';
      this.slow = this.fast = 0;
      this.since = now;
    }
    return this.tier;
  }

  canRecover(source: string, now: number, lastEditAt: number, interactionSafe: boolean): boolean {
    return this.tier === 'source' && interactionSafe && now - this.since >= 15_000 &&
      now - lastEditAt >= 10_000 && estimateDocumentCost(source).weighted < 65_000;
  }

  recovered(now = Date.now()): void {
    this.tier = 'light';
    this.slow = this.fast = 0;
    this.since = now;
  }

  manualVisual(source: string, now = Date.now()): void {
    this.tier = estimateDocumentCost(source).weighted >= 80_000 ? 'light' : 'normal';
    this.slow = this.fast = 0;
    this.since = now;
  }
}

/** Drop the nested Markdown parser only after repeated slow source edits. */
export class SourceSyntaxMonitor {
  private slow = 0;

  observe(durationMs: number): boolean {
    this.slow = durationMs > 80 ? this.slow + 1 : 0;
    return this.slow >= 3;
  }

  reset(): void { this.slow = 0; }
}
