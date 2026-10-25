/**
 * Flooring unit-of-measure engine (FLR-09) — the exact mirror of migration 1122's
 * pm.flr_material_qty. Integer hundredths, half-up, so the quote preview in the browser and the
 * line the database writes are the same number. Inputs carry at most 2 decimals (SF, LF, feet)
 * and waste at most 4 (a fraction: 0.10 = 10 %). Pure; unit-tested for parity against SQL.
 *
 *   gross SF = sf × (1 + waste)
 *   SF      → ⌈gross⌉
 *   SY      → ⌈gross ÷ 9⌉ to 0.01 SY; with a roll width: roll LF = ⌈gross ÷ width⌉, SY = LF × width ÷ 9 (half-up 0.01)
 *   ROLL    → roll LF (whole running feet off the roll)
 *   CARTON  → ⌈gross ÷ carton SF⌉
 *   LF      → ⌈lf × (1 + waste)⌉
 *   STEP    → ⌈steps⌉ (no waste)
 *   EA      → ⌈each × (1 + waste)⌉
 */

export const FLOORING_UOMS = ['SF', 'SY', 'ROLL', 'CARTON', 'LF', 'STEP', 'EA'] as const;
export type FlooringUom = (typeof FLOORING_UOMS)[number];

export interface MaterialQtyInput {
  uom: FlooringUom;
  sf?: number | null;
  lf?: number | null;
  each?: number | null;
  /** Fraction, e.g. 0.1 for 10 %. */
  waste?: number | null;
  cartonSf?: number | null;
  rollWidthFt?: number | null;
}

export interface MaterialQty {
  uom: FlooringUom;
  qty: number;
  netSf: number;
  grossSf: number;
  rollLf: number | null;
  cartons: number | null;
  coveredSf: number | null;
}

export class UomError extends Error {}

const hundredths = (v: number | null | undefined): number => Math.round((v ?? 0) * 100);
const basisPoints4 = (v: number | null | undefined): number => Math.round((v ?? 0) * 10000);

/** ⌊(a × (10000 + w) + 5000) ÷ 10000⌋ — a hundredths quantity grossed up by waste, half-up. */
function grossUp(aHundredths: number, wasteBp: number): number {
  return Math.floor((aHundredths * (10000 + wasteBp) + 5000) / 10000);
}

export function materialQty(i: MaterialQtyInput): MaterialQty {
  if ((i.sf ?? 0) < 0 || (i.lf ?? 0) < 0 || (i.each ?? 0) < 0 || (i.waste ?? 0) < 0) throw new UomError('Quantities and waste must be zero or more.');
  const w = basisPoints4(i.waste);
  const gross = grossUp(hundredths(i.sf), w);
  let qty: number;
  let rollLf: number | null = null;
  let cartons: number | null = null;
  let coveredSf: number | null = null;
  switch (i.uom) {
    case 'SF':
      qty = Math.ceil(gross / 100);
      break;
    case 'SY': {
      if ((i.rollWidthFt ?? 0) > 0) {
        const width = hundredths(i.rollWidthFt);
        rollLf = Math.ceil(gross / width);
        qty = Math.floor((rollLf * width * 100 + 450) / 900) / 100;
      } else {
        qty = Math.ceil(gross / 9) / 100;
      }
      break;
    }
    case 'ROLL': {
      if (!((i.rollWidthFt ?? 0) > 0)) throw new UomError('A roll product needs a roll width.');
      const width = hundredths(i.rollWidthFt);
      rollLf = Math.ceil(gross / width);
      qty = rollLf;
      break;
    }
    case 'CARTON': {
      if (!((i.cartonSf ?? 0) > 0)) throw new UomError('A carton product needs its coverage (SF per carton).');
      const carton = hundredths(i.cartonSf);
      qty = Math.ceil(gross / carton);
      cartons = qty;
      coveredSf = (qty * carton) / 100;
      break;
    }
    case 'LF':
      qty = Math.ceil(grossUp(hundredths(i.lf), w) / 100);
      break;
    case 'STEP':
      qty = Math.ceil(i.each ?? 0);
      break;
    case 'EA':
      qty = Math.ceil((hundredths(i.each) * (10000 + w)) / 1_000_000);
      break;
  }
  return { uom: i.uom, qty, netSf: i.sf ?? 0, grossSf: gross / 100, rollLf, cartons, coveredSf };
}

/** Square feet ↔ square yards (exact; display only). */
export const sfToSy = (sf: number): number => Math.round((sf / 9) * 100) / 100;
export const syToSf = (sy: number): number => Math.round(sy * 9 * 100) / 100;

/** The sell unit a product category is normally quoted in. */
export function defaultUom(category: string, hasRollWidth: boolean, hasCarton: boolean): FlooringUom {
  if (category === 'CARPET') return 'SY';
  if (category === 'VINYL_SHEET') return hasRollWidth ? 'SY' : 'SF';
  if (category === 'PAD') return 'SY';
  if (category === 'TRANSITION') return 'EA';
  if (hasCarton) return 'CARTON';
  return 'SF';
}

/** Extended price (cents) of a quantity at a unit price, half-up — matches round(qty × price) in SQL. */
export function extendCents(qty: number, unitCents: number): number {
  const q = Math.round(qty * 10000);
  return Math.floor((q * unitCents + 5000) / 10000);
}
