export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { previewReset, confirmReset } from '@/lib/debt/lifecycle';
import { PostingError } from '@/lib/posting/account-roles';

/**
 * POST /api/debt/[id]/reset — variable-rate reset.
 *
 *   action = 'preview'  → compute the before/after schedule + payment (writes nothing)
 *   action = 'confirm'  → persist the recomputed remaining schedule; already-posted
 *                         periods are never touched. A reset posts NO journal entry.
 *
 * Accounts/ledger are untouched here (a reset only changes future interest). RLS scopes
 * to the org. Dynamic-param routes can't use apiHandler; auth is via requireAuthedContext.
 */
const bodySchema = z.object({
  action: z.enum(['preview', 'confirm']).default('preview'),
  new_rate: z.number().min(0).max(100),
  reset_at_period: z.number().int().positive().nullish(),
  mode: z.enum(['RECALC_PAYMENT', 'KEEP_PAYMENT']).default('RECALC_PAYMENT'),
  reset_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});

interface Params {
  params: { id: string };
}

export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR' }, { status: 422 });
  const { action, new_rate, reset_at_period, mode, reset_date } = parsed.data;

  const args = {
    orgId,
    instrumentId: params.id,
    newRatePercent: new_rate,
    resetAtPeriod: reset_at_period ?? null,
    mode,
    resetDate: reset_date ?? null,
  };

  try {
    const result = action === 'confirm' ? await confirmReset(supabase, args) : await previewReset(supabase, args);
    return NextResponse.json({ ok: true, action, preview: result });
  } catch (e) {
    if (e instanceof PostingError) return NextResponse.json({ error: e.message, code: 'RESET_ERROR' }, { status: 422 });
    console.error('[debt/reset] failed:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Failed to reset the loan', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
