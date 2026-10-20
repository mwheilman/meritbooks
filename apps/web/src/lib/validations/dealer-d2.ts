import { z } from 'zod';
import { DEALER_REPORT_KEYS } from '@/lib/dealer/reports/catalog';

/**
 * Dealer Pack D2 (slice D) request schemas: scan-now and the dealer reports.
 * (D1's schemas live in ./dealer.ts — not edited here.)
 */

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

/** POST /api/dealer/controls/scan */
export const dealerControlsScan = z.object({ locationId: uuid });

/** GET /api/dealer/reports */
export const dealerReportQuery = z
  .object({
    locationId: uuid,
    report: z.enum(DEALER_REPORT_KEYS),
    start: isoDate.optional(),
    end: isoDate.optional(),
    asOf: isoDate.optional(),
  })
  .refine((q) => !q.start || !q.end || q.start <= q.end, { message: 'The start date must be on or before the end date', path: ['start'] });
