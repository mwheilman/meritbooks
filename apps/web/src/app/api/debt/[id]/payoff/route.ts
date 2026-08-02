export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { previewPayoff, confirmPayoff } from '@/lib/debt/lifecycle';
import { PostingError } from '@/lib/posting/account-roles';

/**
 * POST /api/debt/[id]/payoff — settle and close the loan.
 *
 *   action = 'preview'  → remaining principal + accrued interest + per-diem, the
 *                         resulting entry, and total cash (writes nothing)
 *   action = 'confirm'  → post DR remaining principal + DR accrued interest / CR cash
 *                         by ROLE (source_ref-guarded), mark PAID_OFF, zero the
 *                         schedule forward.
 *
 * Money-movement note: this posts cash out, so a dedicated `debt`/`payments` permission
 * SHOULD gate it — REPORTED to the lead; today it gates on authed org context + RLS.
 */
const bodySchema = z.object({
  action: z.enum(['preview', 'confirm']).default('preview'),
  payoff_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  additional_interest_cents: z.number().int().min(0).nullish(),
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
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR' }, { status: 422 });
  const { action, payoff_date, additional_interest_cents } = parsed.data;

  const args = {
    orgId,
    instrumentId: params.id,
    payoffDate: payoff_date ?? null,
    additionalInterestCents: additional_interest_cents ?? null,
    userId,
  };

  try {
    if (action === 'confirm') {
      const result = await confirmPayoff(supabase, args);
      return NextResponse.json({ ok: true, action, result });
    }
    const preview = await previewPayoff(supabase, args);
    return NextResponse.json({ ok: true, action, preview });
  } catch (e) {
    if (e instanceof PostingError) return NextResponse.json({ error: e.message, code: 'PAYOFF_ERROR' }, { status: 422 });
    console.error('[debt/payoff] failed:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Failed to pay off the loan', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
