export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { buildReportFromReceipts } from '@/lib/expenses/expense-reports';
import { fetchCoreMap } from '@/lib/stitch-core';
import { tallySeverities, daysSince, type StoredReason } from '@/lib/expenses/queue-summary';

/**
 * GET  /api/expenses?scope=mine|queue|batch  — my reports, the approver queue, or
 *      the reimbursement batch (APPROVED reports ready for payout).
 * POST /api/expenses                          — create a DRAFT report from receipts.
 *
 * RBAC (reported: a dedicated `expenses` permission is the right long-term home;
 * for now we borrow the closest existing internal grants):
 *   list/create → receipts:view / receipts:create.
 *
 * The queue and batch scopes are ENRICHED per report with the submitter/employee
 * name, the submitted/approved aging timestamps, and the deterministic WARN/BLOCK
 * violation breakdown (read straight from the `policy_reasons` the engine already
 * stored on each line — no re-evaluation, no posting). Company scoping: an active
 * company passes `location_id`, which sub-filters within tenant RLS.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const listSchema = z.object({ scope: z.enum(['mine', 'queue', 'batch']).optional() });

const REPORT_SELECT =
  'id, title, status, total_cents, reimbursable_cents, card_cents, policy_flag_count, employee_id, submitted_by, submitted_at, approved_by, approved_at, reimbursed_at, created_by, created_at';

interface ReportListRow {
  id: string;
  status: string;
  employee_id: string | null;
  submitted_at: string | null;
  approved_at: string | null;
}

export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'receipts', 'view');
  if (!guard.ok) return guard.response;

  const { searchParams } = new URL(request.url);
  const parsed = listSchema.safeParse({ scope: searchParams.get('scope') ?? undefined });
  const scope = parsed.success ? parsed.data.scope ?? 'mine' : 'mine';
  const locationParam = searchParams.get('location_id');
  const locationId = locationParam && UUID_RE.test(locationParam) ? locationParam : null;

  let query = supabase.from('expense_reports').select(REPORT_SELECT).eq('org_id', orgId);

  if (scope === 'queue') {
    // Approver queue: submitted reports awaiting a decision.
    query = query.eq('status', 'SUBMITTED');
  } else if (scope === 'batch') {
    // Reimbursement batch: approved reports still to be paid out.
    query = query.eq('status', 'APPROVED');
  } else {
    // My reports: created by me (and, transitionally, drafts I own).
    query = query.eq('created_by', userId);
  }
  if (locationId) query = query.eq('location_id', locationId);

  const sortColumn = scope === 'queue' ? 'submitted_at' : scope === 'batch' ? 'approved_at' : 'created_at';
  const { data, error } = await query.order(sortColumn, { ascending: false, nullsFirst: false }).limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as Array<Record<string, unknown> & ReportListRow>;

  // ── Stable header counts (independent of the active scope) ────────────────
  // A separate lightweight status roll-up over the org so the metric strip stays
  // meaningful whichever tab is open (queue size, batch size, etc.).
  const counts = { DRAFT: 0, SUBMITTED: 0, APPROVED: 0, REIMBURSED: 0, REJECTED: 0 } as Record<string, number>;
  {
    let countQuery = supabase.from('expense_reports').select('status, created_by').eq('org_id', orgId);
    if (locationId) countQuery = countQuery.eq('location_id', locationId);
    const { data: statusRows } = await countQuery.limit(1000);
    for (const r of (statusRows ?? []) as Array<{ status: string; created_by: string | null }>) {
      // Drafts are personal; count only the caller's. Everything else is org-wide.
      if (r.status === 'DRAFT' && r.created_by !== userId) continue;
      if (r.status in counts) counts[r.status] += 1;
    }
  }

  // 'mine' scope stays lean (no cross-line enrichment needed).
  if (scope === 'mine' || rows.length === 0) {
    return NextResponse.json({ data: rows, counts, scope });
  }

  // ── Enrichment for queue / batch ──────────────────────────────────────────
  const now = new Date();
  const reportIds = rows.map((r) => r.id);

  // WARN/BLOCK breakdown per report — read the stored policy_reasons on its lines.
  const violationByReport = new Map<string, { block: number; warn: number; info: number }>();
  {
    const { data: lineRows } = await supabase
      .from('expense_report_lines')
      .select('report_id, policy_reasons')
      .eq('org_id', orgId)
      .in('report_id', reportIds);
    const grouped = new Map<string, StoredReason[][]>();
    for (const l of (lineRows ?? []) as Array<{ report_id: string; policy_reasons: unknown }>) {
      const arr = grouped.get(l.report_id) ?? [];
      arr.push((Array.isArray(l.policy_reasons) ? l.policy_reasons : []) as StoredReason[]);
      grouped.set(l.report_id, arr);
    }
    for (const id of reportIds) violationByReport.set(id, tallySeverities(grouped.get(id) ?? []));
  }

  // Submitter / employee names (cross-schema embed unavailable → stitch by id).
  const employeeIds = Array.from(new Set(rows.map((r) => r.employee_id).filter((x): x is string => !!x)));
  const empMap = employeeIds.length
    ? await fetchCoreMap<{ id: string; first_name: string; last_name: string }>(
        supabase,
        'employees',
        'id, first_name, last_name',
        employeeIds,
      )
    : new Map();

  const enriched = rows.map((r) => {
    const emp = r.employee_id ? empMap.get(r.employee_id) ?? null : null;
    const v = violationByReport.get(r.id) ?? { block: 0, warn: 0, info: 0 };
    const agingFrom = scope === 'queue' ? r.submitted_at : r.approved_at;
    return {
      ...r,
      employee_name: emp ? `${emp.first_name} ${emp.last_name}`.trim() : null,
      block_count: v.block,
      warn_count: v.warn,
      info_count: v.info,
      aging_days: daysSince(agingFrom, now),
    };
  });

  return NextResponse.json({ data: enriched, counts, scope });
}

const createSchema = z.object({
  title: z.string().max(200).optional(),
  receipt_ids: z.array(z.string().uuid()).max(200).optional(),
});

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'receipts', 'create');
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 422 });

  // Resolve the caller's employee id (the person owed the reimbursement).
  let employeeId: string | null = null;
  try {
    const { data: emp } = await supabase
      .schema('core')
      .from('employees')
      .select('id')
      .eq('org_id', orgId)
      .eq('clerk_user_id', userId)
      .eq('is_active', true)
      .maybeSingle();
    employeeId = (emp as { id: string } | null)?.id ?? null;
  } catch {
    /* employee lookup optional */
  }

  try {
    const res = await buildReportFromReceipts(supabase, {
      orgId,
      employeeId,
      createdBy: userId,
      title: parsed.data.title ?? null,
      receiptIds: parsed.data.receipt_ids ?? [],
    });
    return NextResponse.json(res, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to create report' }, { status: 400 });
  }
}
