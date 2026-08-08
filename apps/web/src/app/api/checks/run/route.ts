export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requireMoneyMovement, PAYMENTS_EXECUTE, CHECK_RUN_FEATURE } from '@/lib/rbac/payments-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import {
  createApproval,
  submitForApproval,
  type ApprovalStatus,
} from '@/lib/money/approvals';

/**
 * POST /api/checks/run — the "check run": tee up payments from due bills.
 *
 * SAFETY: this ONLY PREPARES pending approvals (DRAFT -> PENDING_APPROVAL) for
 * payable, due-soon bills. It NEVER releases, settles, disburses, or posts to
 * the GL. Approval (separation of duties) is a separate human step; releasing is
 * entirely out of scope for this feature.
 *
 * A bill is a candidate when: status = 'APPROVED', balance_cents > 0, and
 * due_date <= today + dueWithinDays (optionally filtered by location). Bills that
 * already carry an OPEN approval (DRAFT / PENDING_APPROVAL / APPROVED) for their
 * subject row are skipped so the run is idempotent.
 */

interface RunBody {
  dueWithinDays?: number;
  locationId?: string;
}

// Statuses that mean "there is already a live disbursement approval in flight" —
// skip these bills so re-running the batch does not double-queue.
const OPEN_STATUSES: ReadonlyArray<ApprovalStatus> = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'];

function isoDatePlusDays(days: number): string {
  const d = new Date();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days));
  return target.toISOString().slice(0, 10);
}

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  // Authorize — the check run QUEUES disbursement approvals (the front of the
  // money-movement chain); gate on the GRANULAR `check_run` key (SoD: separate from
  // payroll_release / ap_disbursement_release so a check-runner can hold this WITHOUT
  // holding payroll release). Degrades to the coarse `payments` superset, then to
  // checks:create — never looser than today. Defense-in-depth on top of RLS + the
  // approvals SoD.
  const guard = await requireMoneyMovement(
    userId,
    PAYMENTS_EXECUTE,
    { feature: 'checks', action: 'create' },
    CHECK_RUN_FEATURE,
  );
  if (!guard.ok) return guard.response;

  let body: RunBody = {};
  try {
    body = (await request.json()) as RunBody;
  } catch {
    /* empty body ok — use defaults */
  }

  const dueWithinDays =
    typeof body.dueWithinDays === 'number' && Number.isFinite(body.dueWithinDays) && body.dueWithinDays >= 0
      ? Math.floor(body.dueWithinDays)
      : 7;
  const locationId = typeof body.locationId === 'string' && body.locationId.length > 0 ? body.locationId : null;
  const cutoff = isoDatePlusDays(dueWithinDays);

  // 1. Find payable, due-soon bills (RLS scopes to the caller's org).
  let query = supabase
    .from('bills')
    .select('id, balance_cents, due_date')
    .eq('status', 'APPROVED')
    .gt('balance_cents', 0)
    .lte('due_date', cutoff)
    .order('due_date', { ascending: true });
  if (locationId) query = query.eq('location_id', locationId);

  const { data: bills, error: billsErr } = await query;
  if (billsErr) {
    return NextResponse.json({ error: billsErr.message }, { status: 500 });
  }

  const candidates = (bills ?? []) as Array<{ id: string; balance_cents: number; due_date: string }>;
  if (candidates.length === 0) {
    await logHumanAction(supabase, userId, orgId, {
      action: 'checks.run',
      subjectTable: 'bills',
      summary: `Check run: 0 bills payable within ${dueWithinDays} day(s); nothing queued`,
      metadata: { dueWithinDays, locationId, prepared: 0, skipped: 0 },
    });
    return NextResponse.json({ prepared: 0, skipped: 0 });
  }

  // 2. Which of these bills already have an OPEN approval? Skip them.
  const billIds = candidates.map((b) => b.id);
  const { data: existing, error: existingErr } = await supabase
    .from('approvals')
    .select('subject_id, status')
    .eq('subject_table', 'bills')
    .in('subject_id', billIds);
  if (existingErr) {
    return NextResponse.json({ error: existingErr.message }, { status: 500 });
  }
  const openSubjects = new Set(
    ((existing ?? []) as Array<{ subject_id: string; status: ApprovalStatus }>)
      .filter((r) => OPEN_STATUSES.includes(r.status))
      .map((r) => r.subject_id),
  );

  // 3. Prepare an AP_DISBURSEMENT approval for each remaining bill.
  let prepared = 0;
  let skipped = 0;
  for (const bill of candidates) {
    if (openSubjects.has(bill.id)) {
      skipped += 1;
      continue;
    }
    try {
      const approval = await createApproval(supabase, orgId, {
        kind: 'AP_DISBURSEMENT',
        subjectTable: 'bills',
        subjectId: bill.id,
        amountCents: bill.balance_cents,
        preparedBy: userId,
      });
      // Move DRAFT -> PENDING_APPROVAL so it lands in the approval queue.
      await submitForApproval(supabase, orgId, approval.id, userId);
      prepared += 1;
    } catch {
      // A stale (e.g. previously rejected) approval on the same subject trips the
      // unique index; treat as already-handled rather than failing the batch.
      skipped += 1;
    }
  }

  await logHumanAction(supabase, userId, orgId, {
    action: 'checks.run',
    subjectTable: 'bills',
    summary: `Check run: queued ${prepared} disbursement approval(s), skipped ${skipped} (due within ${dueWithinDays} day(s))`,
    metadata: { dueWithinDays, locationId, prepared, skipped },
  });

  return NextResponse.json({ prepared, skipped });
}
