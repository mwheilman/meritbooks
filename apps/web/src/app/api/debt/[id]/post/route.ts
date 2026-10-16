export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { recordInterestAccrual, recordDebtPayment } from '@/lib/debt/posting';
import { PostingError } from '@/lib/posting/account-roles';
import { requirePermission } from '@/lib/rbac/require-permission';

/**
 * POST /api/debt/[id]/post — record a period's interest accrual OR scheduled payment.
 *
 *   kind = 'ACCRUAL'  → DR Interest Expense / CR Interest Payable
 *   kind = 'PAYMENT'  → DR Interest (payable if accrued, else expense) + DR Debt / CR Cash
 *
 * Accounts resolve BY ROLE; the entry carries a stable source_ref and is guarded
 * against a double post (idempotent). Money-movement note: this posts to the GL, so
 * it is gated on journal_entries:post (no dedicated `debt` key exists yet).
 */

const bodySchema = z.object({
  period: z.number().int().positive(),
  kind: z.enum(['ACCRUAL', 'PAYMENT']),
  entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});

interface Params {
  params: { id: string };
}

export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR' }, { status: 422 });
  }
  const { period, kind, entry_date } = parsed.data;

  // Authorize — both kinds post a balanced entry to the GL (accrual, or payment
  // DR interest/debt CR cash). Gate on journal_entries:post.
  const guard = await requirePermission(userId, 'journal_entries', 'post');
  if (!guard.ok) return guard.response;

  try {
    const result =
      kind === 'ACCRUAL'
        ? await recordInterestAccrual(supabase, { orgId, instrumentId: params.id, period, entryDate: entry_date, userId })
        : await recordDebtPayment(supabase, { orgId, instrumentId: params.id, period, entryDate: entry_date, userId });

    return NextResponse.json({
      ok: true,
      kind,
      already_posted: result.alreadyPosted,
      gl_entry_id: result.gl_entry_id,
      entry_number: result.entry_number,
      interest_cents: result.interest_cents,
      principal_cents: result.principal_cents,
    });
  } catch (e) {
    if (e instanceof PostingError) {
      return NextResponse.json({ error: e.message, code: 'POSTING_ERROR' }, { status: 422 });
    }
    console.error('[debt/post] failed:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Failed to post debt entry', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
