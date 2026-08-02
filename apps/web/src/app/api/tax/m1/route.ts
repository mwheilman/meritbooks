export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { z } from 'zod';
import { buildM1Report } from '@/lib/tax/m1-report';

/**
 * GET /api/tax/m1 — Schedule M-1 (and M-3 permanent/temporary summary).
 *
 * Read-only. Computes BOOK net income the same way the income-statement route does, then
 * bridges it to TAXABLE income with the tenant's tagged book-tax differences:
 *   taxable income = book NI + additions − subtractions
 * Every difference is split permanent vs temporary. With no tags, taxable income = book NI
 * and the adjustments list is empty (degrade-safe). RLS scopes everything to the caller's
 * org; nothing is posted or moved.
 *
 *   ?start_date, ?end_date  — YYYY-MM-DD period bounds (default: current month).
 *   ?location_ids           — comma-separated entity/location filter (default: all).
 */
const querySchema = z.object({
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  location_id: z.string().optional(),
  location_ids: z.string().optional(),
});

export const GET = apiQueryHandler(querySchema, async (params, ctx) => {
  if (!ctx.orgId) {
    return NextResponse.json({ error: 'No organization found', code: 'NO_ORG' }, { status: 400 });
  }

  const now = new Date();
  const startDate =
    params.start_date ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const endDate =
    params.end_date ?? new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];

  const locationIds: string[] = [];
  if (params.location_ids) locationIds.push(...params.location_ids.split(',').filter(Boolean));
  else if (params.location_id && params.location_id !== 'all') locationIds.push(params.location_id);

  const report = await buildM1Report(ctx.supabase, { startDate, endDate, locationIds });
  return NextResponse.json({ data: report });
});
