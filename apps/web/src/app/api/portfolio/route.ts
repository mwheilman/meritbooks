export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiQueryHandler } from '@/lib/api-handler';
import { gatherPortfolioBoard } from '@/lib/portfolio/board';

/**
 * GET /api/portfolio?year=YYYY&month=M
 *
 * The cross-entity operator board: one row per company (core.location) with live
 * close status, cash, open exceptions, overdue AR/AP and a red/amber/green
 * roll-up. Read-only aggregation over the org's entities. RLS-scoped — tenant
 * isolation is enforced by the database.
 */
const querySchema = z.object({
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

  const board = await gatherPortfolioBoard(ctx.supabase, ctx.orgId, year, month);
  return NextResponse.json(board);
});
