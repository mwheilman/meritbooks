export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { scanReorderAlerts } from '@/lib/inventory/reorder-detector';

/**
 * POST /api/inventory/reorder/scan — run the book-wide reorder-alert detector.
 *
 * Scans active items with a reorder point, and for any at/below it queues a PROPOSED
 * ai_decisions row (feature 'INVENTORY_REORDER') that surfaces on /exceptions.
 * Detect-only and idempotent (stable dedup_key per item): a second call queues
 * nothing new. It never orders stock or posts to the ledger (canon §3).
 *
 * Reads/writes run through the RLS-scoped client, so the DB enforces org isolation.
 * Gated on 'fixed_assets' create — the interim inventory permission (REPORTED to the
 * lead); it writes only subledger exception rows.
 */
export async function POST(): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'fixed_assets', 'create');
  if (!guard.ok) return guard.response;

  const summary = await scanReorderAlerts(supabase, orgId);
  return NextResponse.json({ data: summary });
}
