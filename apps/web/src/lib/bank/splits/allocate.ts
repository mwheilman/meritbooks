/**
 * Split allocation arithmetic (FPB-bank-feed-splits §4/§7, AC-1, AC-8) — pure, integer cents.
 *
 * Percentages are carried as BASIS POINTS (1% = 100 bp, 100% = 10000 bp) so no floating
 * point ever touches money. A % allocation floors every line and puts the rounding
 * remainder on the LAST line, so the lines always sum to the total exactly.
 */

export const FULL_BP = 10_000;
export const MAX_SPLIT_LINES = 50;

/**
 * Allocate `totalCents` across `bps` (basis points). When the bps sum to 100% the
 * remainder goes to the last line and the result sums to `totalCents`; when they don't,
 * each line is floored and the caller's "remaining" meter shows the gap.
 */
export function allocateByPercent(totalCents: number, bps: ReadonlyArray<number>): number[] {
  if (!Number.isInteger(totalCents) || totalCents < 0) throw new Error('total must be non-negative integer cents');
  if (bps.length === 0) return [];
  for (const b of bps) {
    if (!Number.isInteger(b) || b < 0 || b > FULL_BP) throw new Error('percent must be 0–10000 basis points');
  }
  const amounts = bps.map((b) => Math.floor((totalCents * b) / FULL_BP));
  const bpSum = bps.reduce((s, b) => s + b, 0);
  if (bpSum === FULL_BP) {
    const allocated = amounts.reduce((s, a) => s + a, 0);
    amounts[amounts.length - 1] += totalCents - allocated;
  }
  return amounts;
}

/**
 * Basis points from amounts (to save a dollar split as a % rule, or to suggest from a
 * past split). Rounds each line and fixes the last so the result sums to exactly 10000.
 */
export function percentagesFromAmounts(amounts: ReadonlyArray<number>): number[] {
  const total = amounts.reduce((s, a) => s + a, 0);
  if (amounts.length === 0 || total <= 0) return amounts.map(() => 0);
  const bps = amounts.map((a) => Math.round((a * FULL_BP) / total));
  const sum = bps.reduce((s, b) => s + b, 0);
  bps[bps.length - 1] += FULL_BP - sum;
  return bps;
}

/** Cents still to allocate (negative = over-allocated). */
export function remainingCents(totalCents: number, lineAmounts: ReadonlyArray<number | null | undefined>): number {
  return totalCents - lineAmounts.reduce<number>((s, a) => s + (typeof a === 'number' && Number.isFinite(a) ? a : 0), 0);
}

/** "33.33" / "33.3" / "33" / "33.333" (truncated to 2 dp) → basis points; null when not a percent. */
export function parsePercentToBp(text: string): number | null {
  const t = text.trim().replace(/%$/, '').trim();
  if (!/^\d{1,3}(\.\d*)?$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  const bp = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return bp >= 0 && bp <= FULL_BP ? bp : null;
}

/** 3333 → "33.33". */
export function formatBp(bp: number): string {
  const whole = Math.floor(bp / 100);
  const frac = String(bp % 100).padStart(2, '0');
  return `${whole}.${frac}`;
}

export interface SplitAmountCheck {
  ok: boolean;
  error?: string;
}

/** The server-side gate: 1–50 lines, every line > 0 integer cents, Σ = total exactly. */
export function checkSplitAmounts(totalCents: number, lineAmounts: ReadonlyArray<number>): SplitAmountCheck {
  if (lineAmounts.length === 0) return { ok: false, error: 'A split needs at least one line.' };
  if (lineAmounts.length > MAX_SPLIT_LINES) return { ok: false, error: `A split can have at most ${MAX_SPLIT_LINES} lines.` };
  for (const [i, a] of lineAmounts.entries()) {
    if (!Number.isInteger(a) || a <= 0) return { ok: false, error: `Line ${i + 1}: amount must be more than $0.00.` };
  }
  const rem = remainingCents(totalCents, lineAmounts);
  if (rem !== 0) {
    const abs = Math.abs(rem);
    const dollars = `$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
    return {
      ok: false,
      error: rem > 0 ? `The split is ${dollars} short of the transaction total.` : `The split is ${dollars} over the transaction total.`,
    };
  }
  return { ok: true };
}
