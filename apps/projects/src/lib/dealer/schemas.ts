/** Zod pieces the 1122 industry-depth routes share. Money is integer cents; dates are ISO days. */
import { z } from 'zod';

export const Uuid = z.string().uuid();
export const Cents = z.number().int().min(-1e13).max(1e13);
export const PosCents = z.number().int().min(0).max(1e13);
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-25');
export const Qty = z.number().min(0).max(1e8);
export const Pct = z.number().min(0).max(1);
export const Text = (max: number) => z.string().trim().max(max);
export const Req = (max: number, what = 'This') => z.string().trim().min(1, `${what} is required`).max(max);
export const UuidList = z.array(Uuid).max(500);

/** ?company=… on GETs that read one company's board. */
export const CompanyQ = z.object({ company: Uuid, from: IsoDate.optional(), to: IsoDate.optional() });
export const CompanyOnlyQ = z.object({ company: Uuid });
export const JobQ = z.object({ job: Uuid });

/** A JSON object the database reads key by key (the definer function validates every key). */
export const JsonObject = z.record(z.string().max(80), z.union([z.string().max(5000), z.number(), z.boolean(), z.null(), z.array(z.union([z.string().max(500), z.number()])).max(200)]));
