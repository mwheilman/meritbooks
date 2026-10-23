export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiQueryHandler } from '@/lib/api-handler';
import { loadNeedsAttention, resolveWorkScope, toExceptionItems } from '@/lib/work/needs-attention';

/**
 * GET /api/exceptions — the Inbox's EXCEPTIONS lane (AI proposals, flagged bank lines
 * and receipts, job costs to approve) in the normalized exception shape.
 *
 * Kept for compatibility; the Inbox itself now reads every lane from /api/inbox. Both
 * are built by lib/work/needs-attention over the same scoped item set, so this list,
 * its counts and the Inbox's Exceptions tab always agree. Approvals and bills on
 * policy hold live in the Approvals lane (no longer double-counted here).
 *
 * `location_id` pins the lane to one client, validated against the caller's client
 * scope server-side (403 under `enforce` when out of scope). READ-ONLY; RLS-scoped.
 */

const querySchema = z.object({
  location_id: z.string().max(64).optional(),
});

export const GET = apiQueryHandler(querySchema, async (params, ctx) => {
  const resolved = await resolveWorkScope(ctx, params.location_id);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error, code: resolved.code }, { status: resolved.status });
  }
  const result = await loadNeedsAttention(ctx.supabase, { scope: resolved.scope });
  const data = toExceptionItems(result.items);
  const bySource: Record<string, number> = {};
  for (const it of data) bySource[it.source] = (bySource[it.source] ?? 0) + 1;
  const { unscored, ...byDisposition } = result.counts.byDisposition;

  return NextResponse.json({
    data,
    counts: { total: data.length, bySource, byDisposition, unscored },
    degraded: result.degraded,
  });
});
