/**
 * Concentration: top-N share, Herfindahl-Hirschman Index (HHI), Pareto curve and
 * over-threshold flags (lenders ask for any customer over 10% of revenue).
 *
 * Only positive amounts participate (credits / refunds don't make a customer
 * "smaller than zero"). HHI is on the 0–10,000 scale: Σ (share × 100)².
 * Bands follow the US DOJ/FTC 2010 guidelines: < 1,500 unconcentrated,
 * 1,500–2,500 moderately concentrated, > 2,500 highly concentrated.
 */

import { sum } from './numbers';

export interface Amount {
  key: string;
  label?: string;
  cents: number;
}

export interface ShareRow extends Amount {
  share: number;
  cumulativeShare: number;
  rank: number;
}

/** Positive amounts sorted descending with share and cumulative share (Pareto). */
export function shares(amounts: Amount[]): ShareRow[] {
  const pos = amounts.filter((a) => a.cents > 0).sort((a, b) => b.cents - a.cents || a.key.localeCompare(b.key));
  const total = sum(pos.map((a) => a.cents));
  let cum = 0;
  return pos.map((a, i) => {
    cum += a.cents;
    return { ...a, share: total > 0 ? a.cents / total : 0, cumulativeShare: total > 0 ? cum / total : 0, rank: i + 1 };
  });
}

/** Share of the total held by the top N (null when there is nothing positive). */
export function topNShare(amounts: Amount[], n: number): number | null {
  const rows = shares(amounts);
  if (rows.length === 0) return null;
  return sum(rows.slice(0, n).map((r) => r.share));
}

export type HhiBand = 'unconcentrated' | 'moderate' | 'high';

export interface Hhi {
  value: number | null;
  band: HhiBand | null;
  participants: number;
}

export function hhi(amounts: Amount[]): Hhi {
  const rows = shares(amounts);
  if (rows.length === 0) return { value: null, band: null, participants: 0 };
  const value = sum(rows.map((r) => (r.share * 100) ** 2));
  const band: HhiBand = value < 1500 ? 'unconcentrated' : value <= 2500 ? 'moderate' : 'high';
  return { value, band, participants: rows.length };
}

/** Every participant whose share is ≥ threshold (default 10%). */
export function overThreshold(amounts: Amount[], threshold = 0.1): ShareRow[] {
  return shares(amounts).filter((r) => r.share >= threshold);
}

/** Smallest number of participants that make up `fraction` (e.g. 0.8) of the total. */
export function paretoCount(amounts: Amount[], fraction = 0.8): number | null {
  const rows = shares(amounts);
  if (rows.length === 0) return null;
  const idx = rows.findIndex((r) => r.cumulativeShare >= fraction - 1e-12);
  return idx === -1 ? rows.length : idx + 1;
}
