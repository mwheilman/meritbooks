/**
 * Estimate labor lines (1108): the trigger writes the breakdown to ext._labor. A labor line's
 * unit cost is the estimating rate (what the bid must recover); its cost_cents is hours × the
 * job-cost rate (pay + burden), which is what becomes the budget. Pure.
 */
export interface LaborBreakdown {
  rateCardId: string;
  label: string;
  hours: number;
  costRateCents: number;
  estimatingRateCents: number;
  overheadRateCents: number;
  costCents: number;
  overheadCents: number;
  estimatingCents: number;
  burdenPct: number;
  overheadPct: number;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

export function laborBreakdown(ext: Record<string, unknown> | null | undefined): LaborBreakdown | null {
  const l = ext?._labor;
  if (!l || typeof l !== 'object') return null;
  const o = l as Record<string, unknown>;
  const cr = num(o.cost_rate_cents);
  const er = num(o.estimating_rate_cents);
  if (cr == null || er == null || typeof o.rate_card_id !== 'string') return null;
  return {
    rateCardId: o.rate_card_id,
    label: typeof o.label === 'string' ? o.label : 'Labor',
    hours: num(o.hours) ?? 0,
    costRateCents: cr,
    estimatingRateCents: er,
    overheadRateCents: num(o.overhead_rate_cents) ?? er - cr,
    costCents: num(o.cost_cents) ?? 0,
    overheadCents: num(o.overhead_cents) ?? 0,
    estimatingCents: num(o.estimating_cents) ?? 0,
    burdenPct: num(o.burden_pct) ?? 0,
    overheadPct: num(o.overhead_pct) ?? 0,
  };
}

/** Σ overhead the labor lines' bids recover (it shows up in the margin, never in cost). */
export function overheadInLines(lines: ReadonlyArray<{ ext: Record<string, unknown>; labor_rate_card_id?: string | null }>): number {
  return lines.reduce((s, l) => s + (l.labor_rate_card_id ? laborBreakdown(l.ext)?.overheadCents ?? 0 : 0), 0);
}

/** "Cost $37.50 + overhead $5.63 = $43.13 per hour" for the line's tooltip. */
export function laborTooltip(b: LaborBreakdown, fmt: (c: number) => string): string {
  return `${b.label}: job cost ${fmt(b.costRateCents)}/h (pay + burden) + overhead ${fmt(b.overheadRateCents)}/h = estimating ${fmt(b.estimatingRateCents)}/h. `
    + `Budget gets ${fmt(b.costCents)}; the ${fmt(b.overheadCents)} overhead is recovered in margin, never charged to the job.`;
}
