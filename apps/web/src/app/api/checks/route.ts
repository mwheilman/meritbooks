export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import type { ApprovalStatus } from '@/lib/money/approvals';

/**
 * GET /api/checks — the check-run approval queue.
 *
 * Lists AP_DISBURSEMENT approvals that are still actionable (PENDING_APPROVAL or
 * APPROVED) for the caller's org, newest first, enriched with the underlying
 * bill/vendor for display. Read-only. RLS scopes every query to the org.
 */

interface CheckRow {
  id: string;
  status: ApprovalStatus;
  amountCents: number | null;
  preparedBy: string;
  approvedBy: string | null;
  createdAt: string;
  billId: string;
  billNumber: string | null;
  dueDate: string | null;
  billStatus: string | null;
  vendorName: string | null;
}

const QUEUE_STATUSES: ReadonlyArray<ApprovalStatus> = ['PENDING_APPROVAL', 'APPROVED'];

export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { data: approvals, error: apprErr } = await supabase
    .from('approvals')
    .select('id, status, amount_cents, subject_id, prepared_by, approved_by, created_at')
    .eq('kind', 'AP_DISBURSEMENT')
    .eq('subject_table', 'bills')
    .in('status', [...QUEUE_STATUSES])
    .order('created_at', { ascending: false });
  if (apprErr) {
    return NextResponse.json({ error: apprErr.message }, { status: 500 });
  }

  const rows = (approvals ?? []) as Array<{
    id: string;
    status: ApprovalStatus;
    amount_cents: number | null;
    subject_id: string;
    prepared_by: string;
    approved_by: string | null;
    created_at: string;
  }>;

  if (rows.length === 0) {
    return NextResponse.json({ data: [] as CheckRow[] });
  }

  // Enrich with the underlying bill + vendor. subject_id is a generic uuid (not a
  // declared FK), so we fetch the bills separately and stitch by id.
  const billIds = Array.from(new Set(rows.map((r) => r.subject_id)));
  const { data: bills, error: billsErr } = await supabase
    .from('bills')
    .select('id, bill_number, due_date, status, vendor:vendors ( name, display_name )')
    .in('id', billIds);
  if (billsErr) {
    return NextResponse.json({ error: billsErr.message }, { status: 500 });
  }

  type BillJoin = {
    id: string;
    bill_number: string | null;
    due_date: string | null;
    status: string | null;
    vendor: { name: string | null; display_name: string | null } | null;
  };
  const billById = new Map<string, BillJoin>(
    ((bills ?? []) as unknown as BillJoin[]).map((b) => [b.id, b]),
  );

  const data: CheckRow[] = rows.map((r) => {
    const bill = billById.get(r.subject_id);
    const vendorName = bill?.vendor?.display_name ?? bill?.vendor?.name ?? null;
    return {
      id: r.id,
      status: r.status,
      amountCents: r.amount_cents,
      preparedBy: r.prepared_by,
      approvedBy: r.approved_by,
      createdAt: r.created_at,
      billId: r.subject_id,
      billNumber: bill?.bill_number ?? null,
      dueDate: bill?.due_date ?? null,
      billStatus: bill?.status ?? null,
      vendorName,
    };
  });

  return NextResponse.json({ data });
}
