export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { z } from 'zod';
import { buildSalesTaxCalendar } from '@/lib/tax/sales-tax-calendar';

/**
 * GET /api/tax/sales-tax-calendar — sales/use-tax FILING CALENDAR + LIABILITY-OWED.
 *
 * Read-only. For every jurisdiction the tenant has a configured rate in OR collected
 * tax in, computes the filing periods and due dates at that jurisdiction's frequency
 * (monthly/quarterly/annual — default per state, overridden by the tenant's recorded
 * filing cadence), and per period the tax COLLECTED (from the accrual) vs REMITTED
 * (from filing records) → net owed, with upcoming/overdue/due-soon/filed status.
 * Never registers, files, or moves money. RLS scopes everything to the caller's org.
 *
 *   ?today       — YYYY-MM-DD clock override (default: today).
 *   ?location_id — entity/location filter (default: all).
 *   ?lookback    — trailing months of history (default 12, max 36).
 *   ?lookahead   — forward months of upcoming filings (default 3, max 12).
 */
const querySchema = z.object({
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  location_id: z.string().optional(),
  lookback: z.coerce.number().int().min(1).max(36).optional(),
  lookahead: z.coerce.number().int().min(0).max(12).optional(),
});

export const GET = apiQueryHandler(querySchema, async (params, ctx) => {
  if (!ctx.orgId) {
    return NextResponse.json({ error: 'No organization found', code: 'NO_ORG' }, { status: 400 });
  }

  const report = await buildSalesTaxCalendar(ctx.supabase, ctx.orgId, {
    todayISO: params.today,
    locationId: params.location_id ?? null,
    lookbackMonths: params.lookback,
    lookaheadMonths: params.lookahead,
  });

  return NextResponse.json({ data: report });
});
