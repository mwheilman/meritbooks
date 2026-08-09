export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import {
  parseAuditFilters,
  applyAuditFilters,
  resolveActorNames,
  toAuditRow,
  toCsv,
  EXPORT_CAP,
  type RawLogRow,
} from '@/lib/trust/audit-query';

/**
 * GET /api/audit/export — the CURRENTLY-FILTERED audit log as a CSV download for
 * auditors. Applies the exact same filters as the list view (so "what you see is
 * what you export"), streams up to EXPORT_CAP most-recent matching rows, and
 * returns a text/csv attachment.
 *
 * READ-ONLY: this surface never writes to core.action_log (the write path is owned
 * elsewhere and left untouched); it only reads and serializes.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;

  const guard = await requirePermission(userId, 'audit_trail', 'view');
  if (!guard.ok) return guard.response;

  const { searchParams } = new URL(req.url);
  const filters = parseAuditFilters(searchParams);

  const base = supabase
    .schema('core')
    .from('action_log')
    .select(
      'id, actor_type, actor_user_id, action, summary, subject_table, subject_id, tier, confidence, created_at',
    )
    .eq('org_id', orgId!);

  const { data: rows, error } = await applyAuditFilters(base, filters)
    .order('created_at', { ascending: false })
    .limit(EXPORT_CAP);

  if (error) {
    return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
  }

  const logRows = (rows ?? []) as RawLogRow[];
  const actorIds = logRows
    .filter((r) => r.actor_type === 'HUMAN' && r.actor_user_id)
    .map((r) => r.actor_user_id as string);
  const nameById = await resolveActorNames(createAdminSupabase(), actorIds);

  const csv = toCsv(logRows.map((r) => toAuditRow(r, nameById)));

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="audit-log_${stamp}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
