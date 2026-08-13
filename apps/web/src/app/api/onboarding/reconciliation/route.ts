export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiQueryHandler } from '@/lib/api-handler';
import { loadSession } from '@/lib/onboarding/session';
import { buildConversionReconciliation } from '@/lib/onboarding/reconciliation/build';
import { subledgerControlBlockers } from '@/lib/onboarding/reconciliation/tie-out';
import { reconciliationBlockers } from '@/lib/onboarding/reconciliation/report';

/**
 * GET /api/onboarding/reconciliation?sessionId=… — the Conversion Reconciliation
 * report (read-only): opening Balance Sheet, A/R aging, A/P aging, and (for job
 * businesses) the WIP schedule, each MeritBooks vs. Source with a variance that must
 * be zero to go live. Source figures come from the staged conversion session; the
 * MeritBooks figures come from the live GL + subledgers. RLS-scoped (runs as the user).
 */

const querySchema = z.object({ sessionId: z.string().min(1, 'sessionId is required') });

export const GET = apiQueryHandler(querySchema, async ({ sessionId }, ctx) => {
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const session = await loadSession(supabase, orgId, sessionId);
  if (!session) return NextResponse.json({ error: 'Conversion session not found' }, { status: 404 });

  const result = await buildConversionReconciliation(
    supabase,
    orgId,
    { data: session.data, postedGlEntryId: session.postedGlEntryId },
    new Date().toISOString(),
  );

  const varianceBlockers = reconciliationBlockers(result.report);
  const internalTieBlockers = subledgerControlBlockers(result.internalTies);

  return NextResponse.json({
    sessionId,
    companyShortCode: result.companyShortCode,
    asOfDate: result.asOfDate,
    posted: result.posted,
    report: result.report,
    internalTies: result.internalTies,
    /** Non-zero variances (source vs MeritBooks) — must be empty to finish go-live. */
    varianceBlockers,
    /** Live subledger-to-control mismatches (informational integrity check). */
    internalTieBlockers,
    /** True ⇒ every applicable section ties AND live subledgers foot to their controls. */
    ready: result.report.ties && internalTieBlockers.length === 0,
  });
});
