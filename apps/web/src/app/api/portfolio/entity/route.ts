export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiQueryHandler } from '@/lib/api-handler';
import { gatherEntitySnapshot } from '@/lib/portfolio/entity';

/**
 * GET /api/portfolio/entity?locationId=<uuid>&year=YYYY&month=M
 *
 * The per-entity drill-in behind the portfolio board: one company's compact
 * snapshot for a fiscal month — mini P&L (with prior-period deltas), key
 * balance-sheet lines (cash / AR / AP / equity), close status, and top open
 * items (overdue AR/AP, open exceptions). Read-only aggregation over existing
 * engines. RLS-scoped — tenant isolation is enforced by the database, and an
 * entity the tenant cannot see resolves to 404.
 *
 * `locationId` is a query param (not a path segment) because apiQueryHandler —
 * the mandatory wrapper — does not forward Next's dynamic route context.
 */
const querySchema = z.object({
  locationId: z.string().uuid(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
});

export const GET = apiQueryHandler(querySchema, async (params, ctx) => {
  if (!ctx.orgId) {
    return NextResponse.json({ error: 'No organization' }, { status: 400 });
  }
  const now = new Date();
  const year = params.year ?? now.getFullYear();
  const month = params.month ?? now.getMonth() + 1;

  const snapshot = await gatherEntitySnapshot(ctx.supabase, ctx.orgId, params.locationId, year, month);
  if (!snapshot) {
    return NextResponse.json({ error: 'Company not found', code: 'NOT_FOUND' }, { status: 404 });
  }
  return NextResponse.json(snapshot);
});
