/**
 * The workspace view request (GET query string, also the POST body of Summarize / Export).
 * Same period keys as the page URL (lib/period/url.ts): period · basis · compare. PURE.
 */

import { z } from 'zod';
import { METRICS } from '@/lib/metrics/registry';
import { FPNA_TABS, type DashboardCard, type FpnaTab } from './types';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export const viewQuerySchema = z.object({
  tab: z.enum(FPNA_TABS as unknown as [FpnaTab, ...FpnaTab[]]).default('dashboard'),
  period: z.string().regex(MONTH).optional(),
  basis: z.enum(['month', 'qtd', 'quarter', 'ytd', 'fy', 'ttm']).optional(),
  compare: z.enum(['none', 'prior_period', 'prior_year', 'budget']).optional(),
  /** Comma-separated company ids; empty = every company the reader can see. */
  companies: z
    .string()
    .max(4000)
    .optional()
    .transform((s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []))
    .refine((ids) => ids.length <= 100 && ids.every((id) => /^[0-9a-f-]{36}$/i.test(id)), { message: 'companies must be up to 100 company ids' }),
  weighting: z.enum(['full', 'ownership']).default('full'),
  /** Months on the monthly charts. */
  range: z.enum(['12', '24', '36']).default('12').transform((v) => Number(v) as 12 | 24 | 36),
  /** Dashboard tab: 'pack:<key>' | dashboard id | 'default'. */
  dashboard: z.string().max(64).optional(),
  /**
   * Dashboard tab, edit preview: the cards being edited ("metric:size,metric:size"), so the
   * reader sees exactly what they would save. Unknown metrics are refused.
   */
  cards: z
    .string()
    .max(4000)
    .optional()
    .transform((v): DashboardCard[] | undefined =>
      v
        ? v.split(',').filter(Boolean).map((part) => {
            const [metric, size] = part.split(':');
            return { metric, size: size === 's' || size === 'l' ? size : 'm' };
          })
        : undefined,
    )
    .refine((c) => !c || (c.length >= 1 && c.length <= 48 && c.every((x) => METRICS.has(x.metric)) && new Set(c.map((x) => x.metric)).size === c.length), { message: 'cards must be 1–48 distinct registry metrics' }),
  /** Dashboard tab: sparkline length override (12 | 24). */
  spark: z.enum(['12', '24']).optional(),
  /** Profitability tab. */
  by: z.enum(['company', 'department', 'class', 'job', 'customer']).default('company'),
  /** Bridges tab: the earlier period end (default: a year before `period`). */
  from: z.string().regex(MONTH).optional(),
  /** Budget tab materiality. */
  mat_amount: z.coerce.number().int().min(0).max(1_000_000_000_00).optional(),
  mat_pct: z.coerce.number().min(0).max(1).optional(),
});

export type ViewQuery = z.output<typeof viewQuerySchema>;
export type ViewQueryInput = z.input<typeof viewQuerySchema>;

/**
 * `apiHandler` / `apiQueryHandler` take a `ZodSchema<T>` whose input type equals its output.
 * This schema has defaults and transforms (string query → typed values), so it is handed to
 * them through this alias; the runtime parse is the same schema.
 */
export const viewQueryRouteSchema = viewQuerySchema as unknown as z.ZodType<ViewQuery>;
