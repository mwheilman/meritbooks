export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiQueryHandler } from '@/lib/api-handler';
import {
  collectObligations,
  bucketByHorizon,
  type ObligationType,
} from '@/lib/obligations/collect';

/**
 * GET /api/obligations
 *
 * The Unified Renewals & Obligations Calendar feed: one ranked, RLS-scoped list of
 * every date-driven obligation across the platform (lease term-ends, debt maturities
 * + next amortization payments, covenant tests, insurance renewals, subscription
 * renewals, vendor W-9/COI expirations, recurring-invoice runs).
 *
 * READ-ONLY aggregate — no new tables, no writes. Each source is queried through the
 * caller's user-scoped client and degrades independently (missing table/column is
 * reported in `degraded`, never a 500). apiQueryHandler enforces Clerk auth + Zod;
 * RLS enforces tenant isolation. Page + route are gated on `reports:view`.
 */

const OBLIGATION_TYPES: readonly ObligationType[] = [
  'LEASE',
  'DEBT_MATURITY',
  'DEBT_PAYMENT',
  'COVENANT',
  'INSURANCE',
  'SUBSCRIPTION',
  'VENDOR_W9',
  'VENDOR_COI',
  'RECURRING_INVOICE',
] as const;

const querySchema = z.object({
  /** Days to look ahead (overdue items are always included). 1..730, default 90. */
  horizon: z.coerce.number().int().optional(),
  /** Optional CSV of obligation types to include. Unknown values are ignored. */
  type: z.string().max(300).optional(),
  /** Override "today" (yyyy-mm-dd) — testing/hypotheticals. Defaults to server date. */
  as_of: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export const GET = apiQueryHandler(querySchema, async (params, ctx) => {
  const asOf = params.as_of ?? todayIso();
  // Default 90 days, clamped to 1..730 (previously done in the schema transform).
  const horizonDays =
    params.horizon != null ? Math.min(Math.max(params.horizon, 1), 730) : 90;

  const typeFilter = (params.type ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s): s is ObligationType => (OBLIGATION_TYPES as readonly string[]).includes(s));

  const { obligations, degraded } = await collectObligations(ctx.supabase, {
    asOf,
    horizonDays,
    types: typeFilter.length > 0 ? typeFilter : undefined,
  });

  const buckets = bucketByHorizon(obligations);

  const summary = {
    total: obligations.length,
    overdue: buckets.OVERDUE.length,
    d30: buckets.D30.length,
    d60: buckets.D60.length,
    d90: buckets.D90.length,
    amountCentsAtRisk: obligations.reduce((sum, o) => sum + (o.amountCents ?? 0), 0),
  };

  return NextResponse.json({
    asOf,
    horizonDays,
    obligations,
    buckets,
    summary,
    degraded,
  });
});
