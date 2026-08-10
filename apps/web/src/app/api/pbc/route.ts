export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { resolvePbcCapabilities, forbidden } from '@/lib/audit-access/access';
import { createPbcSchema, listPbcQuery } from '@/lib/audit-access/validation';
import { isOverdue, type PbcStatus } from '@/lib/audit-access/pbc';

const PBC_COLS =
  'id, org_id, location_id, title, description, category, period_label, status, ' +
  'requested_by, assigned_to, due_date, document_id, fulfilled_at, notes, created_at, updated_at';

interface PbcRow {
  id: string;
  location_id: string | null;
  title: string;
  description: string | null;
  category: string | null;
  period_label: string | null;
  status: PbcStatus;
  requested_by: string | null;
  assigned_to: string | null;
  due_date: string | null;
  document_id: string | null;
  fulfilled_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface EmployeeLite {
  id: string;
  clerk_user_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

function empName(e: EmployeeLite | undefined): string | null {
  if (!e) return null;
  const n = [e.first_name, e.last_name].filter(Boolean).join(' ').trim();
  return n || e.email || null;
}

/**
 * GET /api/pbc — the PBC request list (RLS-scoped to the org).
 * Optional filters: status, period, assignedTo, overdue=1. Returns each request with
 * stitched assignee/requester display names + document filename + an `overdue` flag, plus
 * the org's assignable users and the caller's PBC capabilities (so the UI shows only the
 * actions the caller may take).
 */
export async function GET(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const caps = await resolvePbcCapabilities(supabase, orgId, userId);
  if (!caps.canView) return forbidden();

  const parsed = listPbcQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams.entries()));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid query parameters', code: 'VALIDATION_ERROR' }, { status: 422 });
  }
  const q = parsed.data;

  let query = supabase.from('pbc_requests').select(PBC_COLS);
  if (q.status) query = query.eq('status', q.status);
  if (q.period) query = query.eq('period_label', q.period);
  if (q.assignedTo) query = query.eq('assigned_to', q.assignedTo);

  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) {
    console.error('[pbc] list failed:', error);
    return NextResponse.json({ error: 'Failed to load requests', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
  const rows = (data ?? []) as unknown as PbcRow[];

  // Stitch: org employees (for assignee/requester names) + attached document filenames.
  const { data: employees } = await supabase
    .schema('core')
    .from('employees')
    .select('id, clerk_user_id, first_name, last_name, email')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .order('first_name');
  const emps = (employees ?? []) as EmployeeLite[];
  const byId = new Map(emps.map((e) => [e.id, e]));
  const byClerk = new Map(emps.filter((e) => e.clerk_user_id).map((e) => [e.clerk_user_id as string, e]));

  const docIds = Array.from(new Set(rows.map((r) => r.document_id).filter((v): v is string => !!v)));
  const docNames = new Map<string, string>();
  if (docIds.length > 0) {
    const { data: docs } = await supabase.from('documents').select('id, file_name').in('id', docIds);
    for (const d of (docs ?? []) as Array<{ id: string; file_name: string }>) docNames.set(d.id, d.file_name);
  }

  const now = new Date();
  let items = rows.map((r) => ({
    id: r.id,
    locationId: r.location_id,
    title: r.title,
    description: r.description,
    category: r.category,
    periodLabel: r.period_label,
    status: r.status,
    requestedBy: r.requested_by,
    requestedByName: r.requested_by ? empName(byClerk.get(r.requested_by)) : null,
    assignedTo: r.assigned_to,
    assignedToName: r.assigned_to ? empName(byId.get(r.assigned_to)) : null,
    dueDate: r.due_date,
    documentId: r.document_id,
    documentName: r.document_id ? docNames.get(r.document_id) ?? null : null,
    fulfilledAt: r.fulfilled_at,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    overdue: isOverdue(r.due_date, r.status, now),
  }));
  if (q.overdue === '1') items = items.filter((i) => i.overdue);

  return NextResponse.json({
    data: items,
    assignees: emps.map((e) => ({ id: e.id, name: empName(e) ?? 'Unnamed' })),
    can: { view: caps.canView, create: caps.canView, fulfill: caps.canManage, accept: caps.canView },
  });
}

/**
 * POST /api/pbc — raise a new PBC request. Requester tier (compliance.view), which the
 * External Auditor role grants. Starts REQUESTED.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const caps = await resolvePbcCapabilities(supabase, orgId, userId);
  if (!caps.canView) return forbidden();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = createPbcSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors },
      { status: 422 },
    );
  }
  const b = parsed.data;

  const { data, error } = await supabase
    .from('pbc_requests')
    .insert({
      org_id: orgId,
      location_id: b.locationId ?? null,
      title: b.title,
      description: b.description ?? null,
      category: b.category ?? null,
      period_label: b.periodLabel ?? null,
      due_date: b.dueDate ?? null,
      assigned_to: b.assignedTo ?? null,
      notes: b.notes ?? null,
      status: 'REQUESTED',
      requested_by: userId,
    })
    .select(PBC_COLS)
    .single();

  if (error || !data) {
    console.error('[pbc] create failed:', error);
    return NextResponse.json({ error: error?.message ?? 'Failed to create request', code: 'INSERT_ERROR' }, { status: 500 });
  }
  return NextResponse.json({ data }, { status: 201 });
}
