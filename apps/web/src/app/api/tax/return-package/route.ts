export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiQueryHandler } from '@/lib/api-handler';
import { buildTaxReturnPackage } from '@/lib/tax/return-package';

/**
 * Tax Return Package (1120-style) — read-only aggregation.
 *
 * GET /api/tax/return-package?start_date&end_date&statutory_rate&location_id&entity_label
 *   Assembles, for one entity + period, the Form 1120 hand-off: pretax book income, the
 *   Schedule M-1 reconciliation → taxable income, the tax-vs-book depreciation delta, the
 *   ASC 740 current + deferred provision + effective rate, and the DTA/DTL rollforward.
 *   Recomputes nothing — it calls the existing tax engines/services under the caller's
 *   RLS-scoped client. Nothing posts or moves money.
 */

const dateRe = /^\d{4}-\d{2}-\d{2}$/;

const querySchema = z.object({
  start_date: z.string().regex(dateRe).optional(),
  end_date: z.string().regex(dateRe).optional(),
  statutory_rate: z.coerce.number().min(0).max(100).optional(),
  location_id: z.string().optional(),
  entity_label: z.string().optional(),
});

export const GET = apiQueryHandler(querySchema, async (params, ctx) => {
  if (!ctx.orgId) {
    return NextResponse.json({ error: 'No organization found', code: 'NO_ORG' }, { status: 400 });
  }

  const now = new Date();
  const startDate = params.start_date ?? `${now.getFullYear()}-01-01`;
  const endDate = params.end_date ?? `${now.getFullYear()}-12-31`;
  const statutoryRatePct = params.statutory_rate ?? 21;
  const locationId = params.location_id && params.location_id !== 'all' ? params.location_id : null;

  try {
    const pkg = await buildTaxReturnPackage(ctx.supabase, ctx.orgId, {
      startDate,
      endDate,
      statutoryRatePct,
      locationId,
      entityLabel: params.entity_label,
    });
    return NextResponse.json({ data: pkg });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to assemble tax return package', code: 'TAX_PACKAGE_ERROR' },
      { status: 500 },
    );
  }
});
