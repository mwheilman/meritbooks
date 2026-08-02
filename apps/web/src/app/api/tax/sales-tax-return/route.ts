export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { z } from 'zod';
import { buildSalesTaxReturn } from '@/lib/tax/sales-tax-return';

/**
 * GET /api/tax/sales-tax-return — filing-ready sales/use-tax return worksheet.
 *
 * Read-only. Aggregates collected sales tax by destination jurisdiction over the
 * period, splits taxable / exempt / non-taxable sales, reconciles collected tax
 * to the expected statutory rate, ties the total to the Sales Tax Payable GL
 * balance, and cross-references the EC-7 economic-nexus tripwire (states where
 * you SHOULD be collecting but aren't). Never registers, files, or moves money.
 * RLS scopes everything to the caller's org.
 *
 *   ?start_date, ?end_date  — YYYY-MM-DD period bounds (default: current month).
 *   ?jurisdiction           — 2-letter state to focus the displayed lines on.
 *   ?location_id            — entity/location filter (default: all).
 */
const querySchema = z.object({
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  jurisdiction: z.string().max(40).optional(),
  location_id: z.string().optional(),
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

  if (endDate < startDate) {
    return NextResponse.json(
      { error: 'end_date must be on or after start_date', code: 'BAD_RANGE' },
      { status: 422 },
    );
  }

  const report = await buildSalesTaxReturn(ctx.supabase, ctx.orgId, {
    startDate,
    endDate,
    jurisdiction: params.jurisdiction ?? null,
    locationId: params.location_id ?? null,
  });

  return NextResponse.json({ data: report });
});
