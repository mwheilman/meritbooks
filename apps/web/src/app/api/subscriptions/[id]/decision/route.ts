export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { decisionSchema, draftCancellation, type DraftableSubscription } from '@/lib/subscriptions/schema';

/**
 * POST /api/subscriptions/[id]/decision — the human keep/cancel/review workflow.
 *
 *   keep    → status KEPT      (the human reviewed and is keeping it; reviewed_at stamped).
 *   review  → status UNDER_REVIEW (parked for a decision).
 *   cancel  → status CANCELLING + a DRAFTED cancellation message.
 *
 * CANON §3 — NOTHING AUTO-CANCELS. A `cancel` decision does NOT contact the vendor, void a
 * bill, or move money. It DRAFTS a cancellation request (notice-period-aware) and sets the
 * status to CANCELLING so a human can send it and later mark it CANCELLED. RLS scopes the
 * read + write to the org.
 */

interface Params {
  params: { id: string };
}

const DRAFT_SELECT =
  'id, vendor_name, product, amount_cents, billing_cadence, next_renewal_date, notice_period_days, cancellation_method';

export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = decisionSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR' }, { status: 422 });
  }
  const { action, note } = parsed.data;

  const nowIso = new Date().toISOString();
  const patch: Record<string, unknown> = {
    updated_at: nowIso,
    reviewed_at: nowIso,
    reviewed_by_user: ctx.userId,
  };
  if (note) patch.notes = note;

  let draft: string | null = null;

  if (action === 'keep') {
    patch.status = 'KEPT';
  } else if (action === 'review') {
    patch.status = 'UNDER_REVIEW';
  } else {
    // cancel — DRAFT ONLY, never send. Load the subscription to build a notice-aware draft.
    const { data: sub, error: loadErr } = await ctx.supabase
      .from('subscriptions')
      .select(DRAFT_SELECT)
      .eq('id', params.id)
      .single();
    if (loadErr || !sub) {
      return NextResponse.json({ error: 'Subscription not found', code: 'NOT_FOUND' }, { status: 404 });
    }
    draft = draftCancellation(sub as DraftableSubscription);
    patch.status = 'CANCELLING';
    patch.cancellation_draft = draft;
  }

  const { error } = await ctx.supabase.from('subscriptions').update(patch).eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message, code: 'UPDATE_FAILED' }, { status: 500 });

  return NextResponse.json({ ok: true, status: patch.status, cancellationDraft: draft });
}
