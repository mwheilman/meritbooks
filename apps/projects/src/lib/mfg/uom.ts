/**
 * Shop units for the cut list (MFG-20). Mirrors pm.mfg_cut_list in migration 1125: part area in
 * square feet from millimetres, 4×8 sheets (32 sq ft) at the nest's yield (80% when unknown), edge
 * banding linear feet from the banded edges (L = length edges, W = width edges), and board feet
 * for lumber.
 */

export const MM2_PER_SQFT = 92903.04;
export const MM_PER_FT = 304.8;
export const MM3_PER_BOARD_FOOT = 2359737.216;

export interface Edges {
  l1: boolean;
  l2: boolean;
  w1: boolean;
  w2: boolean;
}

/** "L1", "L2W1", "ALL", "4", "L1L2W1W2" → per-edge flags (the CAD export format). */
export function parseEdges(code: string | null | undefined): Edges {
  const c = (code ?? '').trim().toUpperCase();
  if (!c) return { l1: false, l2: false, w1: false, w2: false };
  if (c === 'ALL' || c === '4' || c === 'L1L2W1W2') return { l1: true, l2: true, w1: true, w2: true };
  return { l1: c.includes('L1'), l2: c.includes('L2'), w1: c.includes('W1'), w2: c.includes('W2') };
}

export function edgeCode(e: Edges): string {
  const parts = [e.l1 && 'L1', e.l2 && 'L2', e.w1 && 'W1', e.w2 && 'W2'].filter(Boolean) as string[];
  return parts.length === 4 ? 'ALL' : parts.join('');
}

const r = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

export function partSqft(lengthMm: number, widthMm: number, qty: number): number {
  return r((lengthMm * widthMm * qty) / MM2_PER_SQFT, 3);
}

export function edgeLf(lengthMm: number, widthMm: number, qty: number, e: Edges): number {
  const mm = (e.l1 ? lengthMm : 0) + (e.l2 ? lengthMm : 0) + (e.w1 ? widthMm : 0) + (e.w2 ? widthMm : 0);
  return r((qty * mm) / MM_PER_FT, 2);
}

/** 4×8 sheets for an area of parts at a nest yield (fraction or percent). */
export function sheets4x8(sqft: number, yieldPct: number | null | undefined = 0.8): number {
  const y = yieldPct == null ? 0.8 : yieldPct > 1 ? yieldPct / 100 : yieldPct;
  return Math.ceil(r(sqft / 32 / Math.max(y, 0.3), 6));
}

export function boardFeet(lengthMm: number, widthMm: number, thicknessMm: number, qty: number): number {
  return r((lengthMm * widthMm * thicknessMm * qty) / MM3_PER_BOARD_FOOT, 2);
}

export function inches(mm: number): number {
  return r(mm / 25.4, 3);
}

/** 762.0 mm → 30" or 30 1/16" (nearest 1/16) for the label printer. */
export function fractionalInches(mm: number): string {
  const sixteenths = Math.round((mm / 25.4) * 16);
  const whole = Math.floor(sixteenths / 16);
  let num = sixteenths % 16;
  let den = 16;
  while (num && num % 2 === 0) { num /= 2; den /= 2; }
  return num ? `${whole} ${num}/${den}"` : `${whole}"`;
}
