export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiQueryHandler } from '@/lib/api-handler';
import { canApprove } from '@/lib/money/approvals';
import { createAdminSupabase } from '@/lib/supabase/server';
import { groupInboxItems } from '@/lib/inbox/collect';
import { capPerLane, loadNeedsAttention, resolveWorkScope } from '@/lib/work/needs-attention';

/**
 * GET /api/inbox
 *
 * The INBOX feed — one ranked, RLS-scoped list of everything that needs the caller
 * right now, in four lanes (one per Inbox tab): approvals (money movement, expense
 * reports, policy blocks), exceptions (AI proposals, flagged bank lines and receipts,
 * job costs), alerts (overdue / near-term obligations) and drafts (manual JEs).
 *
 * CLIENT SCOPE. `location_id` (attached automatically by the shared useQuery hook
 * when a client is active) pins every lane to that client; it is validated against
 * the caller's client scope SERVER-SIDE (403 under `enforce` when out of scope). No
 * `location_id` = every client the caller may see, plus organization-level items.
 *
 * Counts come from lib/work/needs-attention — the same service the home and the rail
 * use — computed over the FULL scoped set; the item list is capped per lane for
 * payload size (`truncated` says which lanes were cut).
 *
 * READ-ONLY — no writes. Each source degrades independently (`degraded`), never a 500.
 * Money-movement approval authority (`canApprove`, on the Core identity spine) only
 * changes an approval's severity; it never relaxes RLS.
 */

/** Rows per lane returned to the client; counts are always over the full set. */
const LIST_CAP_PER_LANE = 500;

const querySchema = z.object({
  /** Days ahead an obligation counts as an inbox alert (overdue always). 1..180, default 30. */
  alert_horizon: z.coerce.number().int().optional(),
  /** Override "today" (yyyy-mm-dd) — testing/hypotheticals. Defaults to the org's date. */
  as_of: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** The active client (core.locations id); absent or 'all' = all clients. */
  location_id: z.string().max(64).optional(),
  /** `counts` = the summary only (the rail's badge poll) — no item list. */
  view: z.enum(['full', 'counts']).optional(),
});

export const GET = apiQueryHandler(querySchema, async (params, ctx) => {
  const resolved = await resolveWorkScope(ctx, params.location_id);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error, code: resolved.code }, { status: resolved.status });
  }

  // Default 30 days, clamped to 1..180.
  const alertHorizonDays =
    params.alert_horizon != null ? Math.min(Math.max(params.alert_horizon, 1), 180) : undefined;

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

  const countsOnly = params.view === 'counts';
  const result = await loadNeedsAttention(ctx.supabase, {
    scope: resolved.scope,
    asOf: params.as_of,
    alertHorizonDays,
    canApproveMoney,
    withNames: !countsOnly,
  });
  if (countsOnly) {
    return NextResponse.json({ asOf: result.asOf, scope: result.scope, counts: result.counts, degraded: result.degraded });
  }
  const { items, truncated } = capPerLane(result.items, LIST_CAP_PER_LANE);

  return NextResponse.json({
    asOf: result.asOf,
    canApproveMoney,
    scope: result.scope,
    items,
    groups: groupInboxItems(items),
    counts: result.counts,
    truncated,
    degraded: result.degraded,
  });
});
