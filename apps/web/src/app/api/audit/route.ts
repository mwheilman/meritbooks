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
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type RawLogRow,
} from '@/lib/trust/audit-query';

/**
 * GET /api/audit — the paginated, filtered action log for the caller's org,
 * newest first.
 *
 * AUTHZ: gated on the existing `audit_trail:view` permission (the same gate the
 * page-guard enforces), so every role that may review the trail — not only
 * company_admin — can load it. RLS additionally scopes core.action_log to the
 * org (org_read policy) and we also pin `.eq('org_id', orgId)`.
 *
 * Filters (all optional): actorType, actorId, action, module, from, to,
 * subjectTable, subjectId, q. Pagination: page (1-based), pageSize.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  // Permission gate — audit_trail:view (custom-role-aware, fails closed).
  const guard = await requirePermission(userId, 'audit_trail', 'view');
  if (!guard.ok) return guard.response;

  const { searchParams } = new URL(req.url);
  const filters = parseAuditFilters(searchParams);

  const pageRaw = Number(searchParams.get('page'));
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;
  const sizeRaw = Number(searchParams.get('pageSize'));
  const pageSize =
    Number.isFinite(sizeRaw) && sizeRaw > 0 ? Math.min(Math.floor(sizeRaw), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  const fromIdx = (page - 1) * pageSize;
  const toIdx = fromIdx + pageSize - 1;

  const base = supabase
    .schema('core')
    .from('action_log')
    .select(
      'id, actor_type, actor_user_id, action, summary, subject_table, subject_id, tier, confidence, created_at',
      { count: 'exact' },
    )
    .eq('org_id', orgId!);

  const filtered = applyAuditFilters(base, filters);

  const { data: rows, count, error } = await filtered
    .order('created_at', { ascending: false })
    .range(fromIdx, toIdx);

  if (error) {
    return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
  }

  const logRows = (rows ?? []) as RawLogRow[];

  const actorIds = logRows
    .filter((r) => r.actor_type === 'HUMAN' && r.actor_user_id)
    .map((r) => r.actor_user_id as string);
  const nameById = await resolveActorNames(createAdminSupabase(), actorIds);

  const data = logRows.map((r) => toAuditRow(r, nameById));
  const total = count ?? data.length;

  return NextResponse.json({
    data,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
}
