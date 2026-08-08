export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-handler';
import { requireMoneyMovement, PAYMENTS_EXECUTE, PAYMENTS_EXECUTE_FEATURE } from '@/lib/rbac/payments-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { z } from 'zod';
import { resolveOrgId, recordCustomerPayment } from '@/lib/posting/lifecycle';
import { PostingError } from '@/lib/posting/account-roles';

const paymentSchema = z.object({
  customer_id: z.string().uuid(),
  location_id: z.string().uuid(),
  payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount_cents: z.number().int().min(1, 'Amount must be positive'),
  payment_method: z.enum(['CHECK', 'ACH', 'WIRE', 'CREDIT_CARD', 'CASH', 'OTHER']),
  reference_number: z.string().max(100).optional(),
  bank_account_id: z.string().uuid().optional(),
  applications: z.array(z.object({
    invoice_id: z.string().uuid(),
    amount_cents: z.number().int().min(1),
  })).min(1, 'Must apply to at least one invoice'),
});

export async function POST(request: Request) {
  // Authenticate — fail CLOSED (this previously swallowed auth() and relied on
  // middleware alone). The GL author column is uuid and Clerk ids are text, so
  // attribution is still captured via timestamps + sub-ledgers, not here.
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId, orgId: claimOrgId } = authResult;

  // Authorize — recording a customer payment applies cash to AR and posts to the
  // GL: a money-movement action. Gate on the GRANULAR `payments_execute` key (SoD:
  // distinct from payroll_release / check_run / ap_disbursement_release) the moment
  // the RESERVED catalog carries it; until then it degrades to the coarse `payments`
  // superset, and finally to the AR-write gate (invoices:create) — never looser than
  // today. See lib/rbac/payments-permission.ts and the session report.
  const guard = await requireMoneyMovement(
    userId,
    PAYMENTS_EXECUTE,
    { feature: 'invoices', action: 'create' },
    PAYMENTS_EXECUTE_FEATURE,
  );
  if (!guard.ok) return guard.response;

  try {
    const raw = await request.json();
    const result = paymentSchema.safeParse(raw);

    if (!result.success) {
      const errors: Record<string, string[]> = {};
      for (const issue of result.error.issues) {
        const path = issue.path.join('.') || '_root';
        if (!errors[path]) errors[path] = [];
        errors[path].push(issue.message);
      }
      return NextResponse.json({ error: 'Validation failed', details: errors }, { status: 422 });
    }

    const body = result.data;
    const supabase = createAdminSupabase();

    // Operational org = the VERIFIED claim (ctx.orgId), matching RLS get_org_id();
    // first-org lookup remains only as a transitional fallback when no claim.
    const orgId = await resolveOrgId(supabase, claimOrgId);

    // If an explicit bank account was chosen, post the cash side to ITS GL account.
    let cashAccountId: string | undefined;
    if (body.bank_account_id) {
      const { data: ba } = await supabase
        .from('bank_accounts')
        .select('account_id')
        .eq('org_id', orgId)
        .eq('id', body.bank_account_id)
        .maybeSingle();
      cashAccountId = (ba as { account_id: string } | null)?.account_id;
    }

    try {
      const res = await recordCustomerPayment(supabase, {
        orgId,
        customerId: body.customer_id,
        locationId: body.location_id,
        paymentDate: body.payment_date,
        amountCents: body.amount_cents,
        method: body.payment_method,
        cashAccountId,
        referenceNumber: body.reference_number ?? null,
        bankAccountId: body.bank_account_id ?? null,
        applications: body.applications,
      });
      return NextResponse.json(res, { status: 201 });
    } catch (e) {
      if (e instanceof PostingError) {
        return NextResponse.json({ error: e.message }, { status: 422 });
      }
      throw e;
    }
  } catch (error) {
    console.error('[Payment Error]', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Internal server error' }, { status: 500 });
  }
}
