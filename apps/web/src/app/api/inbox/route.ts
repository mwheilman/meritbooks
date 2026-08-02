export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiQueryHandler } from '@/lib/api-handler';
import { collectInbox } from '@/lib/inbox/collect';
import { canApprove } from '@/lib/money/approvals';
import { createAdminSupabase } from '@/lib/supabase/server';

/**
 * GET /api/inbox
 *
 * The ACTION INBOX feed — one ranked, RLS-scoped list of everything that needs the
 * caller right now: pending money-movement approvals, submitted expense reports,
 * bills held by AP policy, expense-policy-flagged drafts, open AI proposals,
 * overdue/near-term obligations, and unposted manual journal-entry drafts.
 *
 * READ-ONLY aggregate — no new tables, no writes. Each source degrades independently
 * (a missing table is reported in `degraded`, never a 500). apiQueryHandler enforces
 * Clerk auth + Zod; RLS enforces tenant isolation. Page + route gate on `reports:view`.
 *
 * Money-movement approval authority (`canApprove`) is resolved ONCE, on the Core
 * identity spine (admin client, read-only) — it decides whether a pending approval is
 * ranked CRITICAL ("you can clear this") vs HIGH ("waiting, but not on you"). It never
 * relaxes RLS: the approval rows themselves come from the user-scoped client.
 */

const querySchema = z.object({
  /** Days ahead an obligation counts as an inbox alert (overdue always). 1..180, default 30. */
  alert_horizon: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .transform((v) => (v ? Math.min(Math.max(parseInt(v, 10), 1), 180) : 30)),
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

  // Resolve money-movement approval authority once, on the identity spine. Read-only;
  // fails closed to "cannot approve" so nothing is over-elevated on a lookup error.
  let canApproveMoney = false;
  if (ctx.orgId) {
    try {
      canApproveMoney = await canApprove(createAdminSupabase(), ctx.orgId, ctx.userId);
    } catch {
      canApproveMoney = false;
    }
  }

  const { items, groups, counts, degraded } = await collectInbox(ctx.supabase, {
    asOf,
    canApproveMoney,
    alertHorizonDays: params.alert_horizon,
  });

  return NextResponse.json({
    asOf,
    canApproveMoney,
    items,
    groups,
    counts,
    degraded,
  });
});
