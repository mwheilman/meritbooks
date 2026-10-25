/**
 * Draw helpers for the development screens (RED draws: the lender reads the package in their
 * order, the continuation sheet ties, and nothing is sent with a known gap). The database builds
 * the package (pm.dev_draw_package) and runs the pre-check (pm.dev_draw_precheck); these mirror
 * its continuation arithmetic for the screen's live totals and word the issue codes.
 * Integer cents throughout. Pure; unit-tested.
 */

export interface ContinuationLine {
  line_no: number;
  description: string;
  scheduled_cents: number;
  previous_cents: number;
  this_period_cents: number;
}

export interface ContinuationRow extends ContinuationLine {
  completed_cents: number;
  /** 0–1, four places. */
  pct_complete: number;
  balance_cents: number;
  retainage_cents: number;
}

/** Retainage on completed work, half up to the cent (rate as a fraction, e.g. 0.1). */
export function retainageCents(completedCents: number, rate: number): number {
  if (completedCents <= 0 || rate <= 0) return 0;
  const bp = Math.round(rate * 10000);
  return Math.floor((completedCents * bp + 5000) / 10000);
}

export function continuation(lines: ReadonlyArray<ContinuationLine>, retainageRate: number): { rows: ContinuationRow[]; totals: Omit<ContinuationRow, 'line_no' | 'description'> } {
  const rows = [...lines].sort((a, b) => a.line_no - b.line_no).map((l) => {
    const completed = l.previous_cents + l.this_period_cents;
    return {
      ...l,
      completed_cents: completed,
      pct_complete: l.scheduled_cents > 0 ? Math.round((completed / l.scheduled_cents) * 10000) / 10000 : 0,
      balance_cents: l.scheduled_cents - completed,
      retainage_cents: retainageCents(completed, retainageRate),
    };
  });
  const sum = (k: keyof ContinuationRow) => rows.reduce((s, r) => s + (r[k] as number), 0);
  const scheduled = sum('scheduled_cents');
  const completed = sum('completed_cents');
  return {
    rows,
    totals: {
      scheduled_cents: scheduled,
      previous_cents: sum('previous_cents'),
      this_period_cents: sum('this_period_cents'),
      completed_cents: completed,
      pct_complete: scheduled > 0 ? Math.round((completed / scheduled) * 10000) / 10000 : 0,
      balance_cents: scheduled - completed,
      retainage_cents: sum('retainage_cents'),
    },
  };
}

/** Pre-check issue codes from pm.dev_draw_precheck → the sentence the draw screen shows. */
export const DRAW_ISSUE_WORDS: Readonly<Record<string, string>> = {
  OUT_OF_BALANCE: 'The project is out of balance: remaining sources do not cover the cost to complete.',
  WAIVER_NOT_REQUESTED: 'Lien waivers have not been requested from the vendors on this draw.',
  MISSING_CONDITIONAL_WAIVER: 'A conditional waiver for this draw has not come back.',
  MISSING_UNCONDITIONAL_PRIOR: 'An unconditional waiver for the last draw has not come back.',
  UNAPPROVED_INVOICE: 'An invoice on this draw is not approved yet.',
  MISSING_INVOICE_DOC: 'An invoice on this draw has no document attached.',
  COI_MISSING_OR_EXPIRED: 'A vendor’s certificate of insurance is missing or expired.',
  INSPECTION_PENDING: 'The lender’s inspection for this draw is not recorded.',
  LINE_OVER_BUDGET: 'A lender line would be drawn past its budget.',
  PACKAGE_SECTION_MISSING: 'A section the lender requires is missing from the package.',
  SCHEDULE_BEHIND: 'The schedule shows the work behind what this draw asks for.',
  SOURCE_OVER_COMMITMENT: 'A funding source would be drawn past its commitment.',
};

export function issueWords(code: string): string {
  return DRAW_ISSUE_WORDS[code] ?? code.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()) + '.';
}
