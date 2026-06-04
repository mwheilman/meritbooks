export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
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
  // Auth is enforced by middleware; the GL author column is uuid and Clerk ids
  // are text, so attribution is captured via timestamps + sub-ledgers, not here.
  await auth().catch(() => null);

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

    // Canonical org id — the old path read an empty Clerk orgId, so it never
    // resolved the cash/AR accounts and silently posted nothing (audit gap 5).
    const orgId = await resolveOrgId(supabase);

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
