export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { z } from 'zod';
import { getRetainageRegister, releaseRetainage } from '@/lib/services/retainage';
import {
  requireMoneyMovement,
  PAYMENTS_EXECUTE,
  AP_DISBURSEMENT_RELEASE_FEATURE,
} from '@/lib/rbac/payments-permission';

// ─── GET: retainage register (held / released / outstanding per bill) ─────────
export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) {
    return NextResponse.json({ rows: [], totals: { withheldCents: 0, releasedCents: 0, outstandingCents: 0 } });
  }
  const overview = await getRetainageRegister(supabase, orgId);
  return NextResponse.json(overview);
}

// ─── POST: release (and pay) withheld retainage on a bill ─────────────────────
const releaseSchema = z.object({
  bill_id: z.string().uuid(),
  amount_cents: z.number().int().positive(),
  release_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  payment_method: z.string().max(40).optional(),
  memo: z.string().max(1000).optional(),
});

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;

  // Authorize — releasing retainage PAYS the subcontractor (DR Retainage Payable /
  // CR Operating bank). It is AP money-out, so it carries the same gate as releasing
  // an AP disbursement batch: the granular `ap_disbursement_release` key, degrading
  // to the coarse `payments` superset, then to checks:create. Fails closed.
  const guard = await requireMoneyMovement(
    userId,
    PAYMENTS_EXECUTE,
    { feature: 'checks', action: 'create' },
    AP_DISBURSEMENT_RELEASE_FEATURE,
  );
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = releaseSchema.safeParse(raw);
  if (!parsed.success) {
    const details: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const k = issue.path.join('.') || '_root';
      (details[k] ??= []).push(issue.message);
    }
    return NextResponse.json({ error: 'Validation failed', details }, { status: 422 });
  }

  if (!orgId) return NextResponse.json({ error: 'No organization found' }, { status: 400 });

  const res = await releaseRetainage(supabase, {
    orgId,
    billId: parsed.data.bill_id,
    amountCents: parsed.data.amount_cents,
    releaseDate: parsed.data.release_date,
    method: parsed.data.payment_method,
    memo: parsed.data.memo,
  });

  if (!res.success) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json(
    { release_id: res.releaseId, entry_number: res.entryNumber, outstanding_cents: res.outstandingCents },
    { status: 201 },
  );
}
