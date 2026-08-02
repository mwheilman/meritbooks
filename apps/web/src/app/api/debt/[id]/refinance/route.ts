export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { createDebtSchema } from '@/lib/debt/schema';
import { previewRefinance, confirmRefinance } from '@/lib/debt/lifecycle';
import { PostingError } from '@/lib/posting/account-roles';

/**
 * POST /api/debt/[id]/refinance — refinance the loan into a NEW instrument.
 *
 *   action = 'preview'  → old outstanding balance, the balanced debt-rollover entry,
 *                         and the new loan's schedule summary (writes nothing)
 *   action = 'confirm'  → create the new instrument + schedule, post the rollover
 *                         (DR old debt / CR new debt, cash for the difference) by ROLE,
 *                         close the old instrument, and cross-link old<->new.
 *
 * The new-loan terms reuse the create schema. Money-movement note: this posts to the
 * GL, so a dedicated `debt` (or GL-posting) permission SHOULD gate it — REPORTED to
 * the lead; today it gates on authed org context + RLS like the accrual/payment path.
 */
const bodySchema = z.object({
  action: z.enum(['preview', 'confirm']).default('preview'),
  new_loan: createDebtSchema,
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
  const { action, new_loan } = parsed.data;

  try {
    if (action === 'confirm') {
      const result = await confirmRefinance(supabase, orgId, userId, params.id, new_loan);
      return NextResponse.json({ ok: true, action, result });
    }
    const preview = await previewRefinance(supabase, orgId, params.id, new_loan);
    return NextResponse.json({ ok: true, action, preview });
  } catch (e) {
    if (e instanceof PostingError) return NextResponse.json({ error: e.message, code: 'REFINANCE_ERROR' }, { status: 422 });
    console.error('[debt/refinance] failed:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Failed to refinance the loan', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
