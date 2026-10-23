/**
 * Check-stock page geometry — PURE. Letter paper (8.5" × 11" = 612 × 792 pt).
 *
 *   VOUCHER_TOP     check 3.5" on top, two 3.75" stubs below (payee copy, file copy)
 *   VOUCHER_MIDDLE  stub · check · stub
 *   VOUCHER_BOTTOM  two stubs, check at the bottom
 *   THREE_UP        three 3.667" checks per page, no stubs
 *
 * Every coordinate a renderer draws goes through `nudge()` so the per-account printer
 * offset (from the alignment test) moves the whole page together.
 */

export type CheckLayout = 'VOUCHER_TOP' | 'VOUCHER_MIDDLE' | 'VOUCHER_BOTTOM' | 'THREE_UP';

export const CHECK_LAYOUTS: ReadonlyArray<{ value: CheckLayout; label: string; help: string }> = [
  { value: 'VOUCHER_TOP', label: 'Check on top', help: 'Voucher stock: check, then two stubs.' },
  { value: 'VOUCHER_MIDDLE', label: 'Check in the middle', help: 'Voucher stock: stub, check, stub.' },
  { value: 'VOUCHER_BOTTOM', label: 'Check on the bottom', help: 'Voucher stock: two stubs, then the check.' },
  { value: 'THREE_UP', label: '3 per page', help: 'Three checks per sheet, no stubs.' },
];

export const PAGE_W = 612;
export const PAGE_H = 792;
export const PT_PER_IN = 72;

export interface Band {
  kind: 'check' | 'stub';
  top: number;
  height: number;
  /** For stubs: which copy. */
  copy?: 'payee' | 'file';
}

/** The bands of one sheet for a layout. */
export function pageBands(layout: CheckLayout): Band[] {
  const check = 3.5 * PT_PER_IN; // 252
  const stub = 3.75 * PT_PER_IN; // 270
  switch (layout) {
    case 'VOUCHER_TOP':
      return [
        { kind: 'check', top: 0, height: check },
        { kind: 'stub', top: check, height: stub, copy: 'payee' },
        { kind: 'stub', top: check + stub, height: stub, copy: 'file' },
      ];
    case 'VOUCHER_MIDDLE':
      return [
        { kind: 'stub', top: 0, height: stub, copy: 'payee' },
        { kind: 'check', top: stub, height: check },
        { kind: 'stub', top: stub + check, height: stub, copy: 'file' },
      ];
    case 'VOUCHER_BOTTOM':
      return [
        { kind: 'stub', top: 0, height: stub, copy: 'payee' },
        { kind: 'stub', top: stub, height: stub, copy: 'file' },
        { kind: 'check', top: 2 * stub, height: check },
      ];
    case 'THREE_UP': {
      const h = PAGE_H / 3; // 264
      return [0, 1, 2].map((i) => ({ kind: 'check' as const, top: i * h, height: h }));
    }
  }
}

/** Checks per sheet for a layout. */
export function checksPerPage(layout: CheckLayout): number {
  return layout === 'THREE_UP' ? 3 : 1;
}

/** Split checks into sheets: each sheet's check bands get consecutive checks. */
export function paginate<T>(items: readonly T[], layout: CheckLayout): T[][] {
  const per = checksPerPage(layout);
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += per) pages.push(items.slice(i, i + per));
  return pages;
}

export interface Offsets {
  xPt: number;
  yPt: number;
}

export function clampOffset(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(-72, Math.min(72, Math.round(v * 100) / 100));
}

export function nudge(x: number, y: number, o: Offsets): { x: number; y: number } {
  return { x: x + o.xPt, y: y + o.yPt };
}

/**
 * Field boxes inside a check band (points from the band's top-left). The MICR clear band
 * (bottom 5/8") holds nothing but the MICR line.
 */
export const CHECK_FIELDS = {
  payer: { x: 36, y: 20, w: 220, h: 64 },
  bank: { x: 268, y: 20, w: 170, h: 52 },
  number: { x: 456, y: 18, w: 120, h: 16 },
  date: { x: 430, y: 54, w: 146, h: 16 },
  payTo: { x: 36, y: 92, w: 420, h: 18 },
  amountBox: { x: 466, y: 90, w: 110, h: 22 },
  words: { x: 36, y: 120, w: 540, h: 16 },
  payeeAddress: { x: 72, y: 142, w: 260, h: 46 },
  voidAfter: { x: 400, y: 142, w: 176, h: 10 },
  memo: { x: 36, y: 192, w: 250, h: 14 },
  signature1: { x: 372, y: 196, w: 204, h: 1 },
  signature2: { x: 372, y: 164, w: 204, h: 1 },
} as const;

export const CLEAR_BAND_PT = (5 / 8) * PT_PER_IN; // 45
export const MICR_BASELINE_PT = (3 / 16) * PT_PER_IN; // 13.5 above the check's bottom edge

/** Stub rows that fit before the overflow line. */
export const STUB_MAX_LINES = 12;
