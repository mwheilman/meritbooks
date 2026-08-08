export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { z } from 'zod';
import { findDuplicateGroups, duplicateIdSet, type DupTxn } from '@/lib/bank/duplicate-detect';

/**
 * GET /api/bank-feed/duplicates
 *   [?location_id=<uuid>]   — scope to one entity
 *   [?window_days=<int>]    — date proximity window (default 3, max 14)
 *
 * DETECT-ONLY. Groups likely-duplicate bank transactions (same normalized
 * description + same absolute amount within a small date window) so a human can
 * review before approving. Never mutates or deletes. RLS-scoped read.
 *
 * Only a recent slice is scanned (last 120 days by transaction_date, capped at
 * 2000 rows) so a large history doesn't turn this into a table scan; that window
 * comfortably covers a fresh import overlapping an existing feed — the case that
 * actually produces duplicates.
 */
const schema = z.object({
  location_id: z.string().uuid().optional(),
  window_days: z.coerce.number().int().min(1).max(14).optional(),
});

export const GET = apiQueryHandler(schema, async (params, ctx) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const since = new Date();
  since.setDate(since.getDate() - 120);
  const sinceIso = since.toISOString().split('T')[0];

  let query = ctx.supabase
    .from('bank_transactions')
    .select('id, description, amount_cents, transaction_date, status')
    .gte('transaction_date', sinceIso)
    .order('transaction_date', { ascending: false })
    .limit(2000);

  if (params.location_id) query = query.eq('location_id', params.location_id);

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
  }

  const txns: DupTxn[] = (data ?? []).map((r) => ({
    id: r.id as string,
    description: (r.description as string) ?? '',
    amountCents: Number(r.amount_cents),
    date: r.transaction_date as string,
    status: (r.status as string) ?? undefined,
  }));

  const groups = findDuplicateGroups(txns, { windowDays: params.window_days ?? 3 });
  const ids = [...duplicateIdSet(groups)];

  return NextResponse.json({
    groups,
    duplicate_ids: ids,
    total_flagged: ids.length,
    group_count: groups.length,
  });
});
