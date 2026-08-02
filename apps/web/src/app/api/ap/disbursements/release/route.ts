export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requireMoneyMovement, PAYMENTS_EXECUTE } from '@/lib/rbac/payments-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import { recordBillPayment } from '@/lib/posting/lifecycle';
import { PostingError } from '@/lib/posting/account-roles';
import { markReleased } from '@/lib/money/approvals';
import { assembleApprovedBatch } from '@/lib/ap/assemble-batch';
import { buildDisbursementBatch } from '@/lib/ap/disbursement-batch';

/**
 * POST /api/ap/disbursements/release — the explicit human RELEASE of a batch.
 *
 * This is the ONLY place the money-out MVP posts to the GL. It does so through
 * the EXISTING deterministic payment-posting path (recordBillPayment → DR A/P /
 * CR Cash, clearing the payable — NEVER re-expensing) and marks each authorizing
 * approval RELEASED via the EXISTING approval engine. It NEVER contacts a bank or
 * payment API and NEVER originates a live ACH/wire — the actual money movement
 * happens when the human uploads the exported file to their bank.
 *
 * Controls enforced here (Canon §3 + money-movement authorization):
 *   - RBAC: the dedicated `payments` money-movement permission (execute).
 *   - Separation of duties: each line was already APPROVED by a non-preparer on
 *     /checks (preparer != approver, DB CHECK + canApprove). Here we ADDITIONALLY
 *     enforce releaser != preparer — the releaser cannot release a line they
 *     prepared.
 *   - Duplicate-payment guard: a batch with a CRITICAL intra-batch duplicate is
 *     BLOCKED unless the caller explicitly overrides.
 *   - Vendor-compliance gate: recordBillPayment re-checks W-9/COI at pay time.
 *
 * RLS scopes every read/write to the caller's org (same RLS-scoped client the
 * approve + bank-feed settlement paths already post through).
 */

interface ReleaseBody {
  approvalIds?: string[];
  bankAccountId?: string;
  overrideDuplicates?: boolean;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  // Authorize — releasing a batch posts to the GL: a money-movement action. Gate
  // on the dedicated `payments` execute permission (falls back to checks:create
  // until the reserved catalog adopts `payments`). Fails closed.
  const guard = await requireMoneyMovement(userId, PAYMENTS_EXECUTE, {
    feature: 'checks',
    action: 'create',
  });
  if (!guard.ok) return guard.response;

  let body: ReleaseBody = {};
  try {
    body = (await request.json()) as ReleaseBody;
  } catch {
    /* empty body ok — release all approved */
  }
  const approvalIds = Array.isArray(body.approvalIds) && body.approvalIds.length > 0 ? body.approvalIds : undefined;

  // Assemble the approved batch (RLS-scoped).
  let assembled;
  try {
    assembled = await assembleApprovedBatch(supabase, { approvalIds });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Assembly failed' }, { status: 500 });
  }
  if (assembled.items.length === 0) {
    return NextResponse.json({ error: 'No approved disbursements to release' }, { status: 409 });
  }

  const batch = buildDisbursementBatch(assembled.items);

  // Duplicate guard — block a batch with a critical intra-batch duplicate unless
  // the human explicitly overrides after reviewing the warnings.
  if (batch.controls.hasBlockingDuplicates && !body.overrideDuplicates) {
    return NextResponse.json(
      {
        error: 'Batch contains likely duplicate payments — review and override to proceed.',
        code: 'DUPLICATE_BLOCK',
        duplicateWarnings: batch.duplicateWarnings,
      },
      { status: 409 },
    );
  }

  // Optional: pin the cash-side to a specific bank account's GL account.
  let cashAccountId: string | undefined;
  if (body.bankAccountId) {
    const { data: ba } = await supabase
      .from('bank_accounts')
      .select('account_id')
      .eq('id', body.bankAccountId)
      .maybeSingle();
    cashAccountId = (ba as { account_id: string } | null)?.account_id ?? undefined;
  }

  const paymentDate = today();
  const released: Array<{ approvalId: string; billId: string; paymentId: string; amountCents: number }> = [];
  const failed: Array<{ approvalId: string; billId: string; error: string }> = [];
  const blocked: Array<{ approvalId: string; billId: string; reason: string }> = [];
  let totalReleasedCents = 0;

  for (const group of batch.groups) {
    for (const item of group.items) {
      // Separation of duties: the releaser cannot release a line they prepared.
      if (item.preparedBy === userId) {
        blocked.push({
          approvalId: item.approvalId,
          billId: item.billId,
          reason: 'Separation of duties: you prepared this line and cannot release it.',
        });
        continue;
      }
      try {
        const pay = await recordBillPayment(supabase, {
          orgId,
          billId: item.billId,
          amountCents: item.amountCents,
          paymentDate,
          method: item.method,
          cashAccountId,
          createdBy: null,
        });
        await markReleased(supabase, orgId, item.approvalId, userId, `bill_payment:${pay.payment_id}`);
        released.push({ approvalId: item.approvalId, billId: item.billId, paymentId: pay.payment_id, amountCents: item.amountCents });
        totalReleasedCents += item.amountCents;
      } catch (e) {
        const msg = e instanceof PostingError ? e.message : e instanceof Error ? e.message : 'Release failed';
        failed.push({ approvalId: item.approvalId, billId: item.billId, error: msg });
      }
    }
  }

  await logHumanAction(supabase, userId, orgId, {
    action: 'ap.disbursements.release',
    subjectTable: 'approvals',
    summary: `Released ${released.length} disbursement(s) (${(totalReleasedCents / 100).toFixed(2)}); ${failed.length} failed, ${blocked.length} blocked (SoD)`,
    metadata: {
      released: released.length,
      failed: failed.length,
      blocked: blocked.length,
      totalReleasedCents,
      overrideDuplicates: !!body.overrideDuplicates,
    },
  }).catch(() => {});

  return NextResponse.json({
    released: released.length,
    failed: failed.length,
    blocked: blocked.length,
    totalReleasedCents,
    results: { released, failed, blocked },
  });
}
