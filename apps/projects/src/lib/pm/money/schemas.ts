/** Zod pieces shared by the money routes. Pure. */
import { z } from 'zod';

export const Cents = z.number().int().min(-1e13).max(1e13);
export const PosCents = z.number().int().min(0).max(1e13);
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-31.');
export const Uuid = z.string().uuid();
/** A fraction 0..1 (10% = 0.1), at most 6 places. */
export const Fraction = z.number().min(0).max(1).refine((n) => Math.abs(n * 1e6 - Math.round(n * 1e6)) < 1e-6, 'At most 6 decimal places.');
/** Rates stored as numeric(5,4): at most 4 places. */
export const Rate = z.number().min(0).max(1).refine((n) => Math.abs(n * 1e4 - Math.round(n * 1e4)) < 1e-6, 'At most 2 decimal places of a percent.');
/** Quantities as decimal strings (numeric(14,4)), so qty × unit rounds like the database. */
export const Qty = z.string().trim().regex(/^\d{1,10}(\.\d{1,4})?$/, 'Up to 4 decimal places, like 12.5.');
export const Text200 = z.string().trim().max(200);
export const Text2000 = z.string().trim().max(2000);
