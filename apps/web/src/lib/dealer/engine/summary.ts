/**
 * Dashboard math for D2's dealer home (FPB §7 widgets) — pure.
 */

import { dayNumber, diffDays } from '../dates';

export interface AgeBucket {
  label: string;
  minDays: number;
  maxDays: number | null;
  count: number;
  cents: number;
}

/** Bucket edges from the client's aging_buckets, e.g. {90,180,270,365} → 0–90, 91–180 … 366+. */
export function bucketsFromEdges(edges: number[]): Omit<AgeBucket, 'count' | 'cents'>[] {
  const sorted = [...new Set(edges.filter((e) => Number.isInteger(e) && e > 0))].sort((a, b) => a - b);
  const out: Omit<AgeBucket, 'count' | 'cents'>[] = [];
  let lo = 0;
  for (const e of sorted) {
    out.push({ label: `${lo === 0 ? 0 : lo}-${e}`, minDays: lo, maxDays: e });
    lo = e + 1;
  }
  out.push({ label: `${lo}+`, minDays: lo, maxDays: null });
  return out;
}

export function ageBucket<T>(
  items: T[],
  edges: number[],
  asOf: string,
  pick: (t: T) => { date: string | null; cents: number },
): { buckets: AgeBucket[]; undated: { count: number; cents: number } } {
  const buckets: AgeBucket[] = bucketsFromEdges(edges).map((b) => ({ ...b, count: 0, cents: 0 }));
  const undated = { count: 0, cents: 0 };
  const asOfN = dayNumber(asOf);
  for (const it of items) {
    const { date, cents } = pick(it);
    if (!date) {
      undated.count++;
      undated.cents += cents;
      continue;
    }
    const age = Math.max(0, asOfN - dayNumber(date));
    const b = buckets.find((x) => age >= x.minDays && (x.maxDays == null || age <= x.maxDays)) ?? buckets[buckets.length - 1];
    b.count++;
    b.cents += cents;
  }
  return { buckets, undated };
}

export const RECEIVABLE_EDGES = [30, 60, 90];

export function oldestDays(dates: (string | null)[], asOf: string): number | null {
  const ds = dates.filter((d): d is string => !!d);
  if (ds.length === 0) return null;
  return Math.max(...ds.map((d) => diffDays(d, asOf)));
}

export interface TieoutRow {
  bucket: string;
  account_id: string | null;
  subledger_cents: number;
  gl_cents: number;
  difference_cents: number;
}

/** AC12 / enable gate: every bucket must tie to the cent, and every bucket must resolve an account. */
export function evaluateTieout(rows: TieoutRow[]): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  for (const r of rows) {
    if (!r.account_id) problems.push(`${r.bucket}: no account mapped`);
    else if (Number(r.difference_cents) !== 0) {
      problems.push(`${r.bucket}: subledger ${r.subledger_cents} vs GL ${r.gl_cents} (difference ${r.difference_cents})`);
    }
  }
  return { ok: problems.length === 0, problems };
}
