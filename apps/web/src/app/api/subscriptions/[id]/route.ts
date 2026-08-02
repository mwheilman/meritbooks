export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { updateSubscriptionSchema } from '@/lib/subscriptions/schema';

/**
 * /api/subscriptions/[id]
 *
 * PATCH  — edit a subscription (partial): confirm terms, set notice period, notes, etc.
 * DELETE — remove a subscription from the register.
 *
 * Dynamic-param routes can't use the apiHandler wrapper, so these validate the body with
 * the shared Zod schema by hand (mirrors the insurance / covenants [id] routes). RLS
 * scopes every write to the org.
 */

interface Params {
  params: { id: string };
}

export async function PATCH(request: Request, { params }: Params): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = updateSubscriptionSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR' }, { status: 422 });
  }

  const b = parsed.data;
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (b.location_id !== undefined) patch.location_id = b.location_id ?? null;
  if (b.vendor_id !== undefined) patch.vendor_id = b.vendor_id ?? null;
  if (b.vendor_name !== undefined) patch.vendor_name = b.vendor_name;
  if (b.product !== undefined) patch.product = b.product ?? null;
  if (b.category !== undefined) patch.category = b.category ?? null;
  if (b.amount_cents !== undefined) patch.amount_cents = b.amount_cents;
  if (b.billing_cadence !== undefined) patch.billing_cadence = b.billing_cadence;
  if (b.first_seen_date !== undefined) patch.first_seen_date = b.first_seen_date ?? null;
  if (b.last_charged_date !== undefined) patch.last_charged_date = b.last_charged_date ?? null;
  if (b.next_renewal_date !== undefined) patch.next_renewal_date = b.next_renewal_date ?? null;
  if (b.status !== undefined) patch.status = b.status;
  if (b.auto_renews !== undefined) patch.auto_renews = b.auto_renews;
  if (b.notice_period_days !== undefined) patch.notice_period_days = b.notice_period_days ?? null;
  if (b.cancellation_terms !== undefined) patch.cancellation_terms = b.cancellation_terms ?? null;
  if (b.cancellation_method !== undefined) patch.cancellation_method = b.cancellation_method ?? null;
  if (b.notes !== undefined) patch.notes = b.notes ?? null;

  const { error } = await ctx.supabase.from('subscriptions').update(patch).eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message, code: 'UPDATE_FAILED' }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: Request, { params }: Params): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;

  const { error } = await ctx.supabase.from('subscriptions').delete().eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message, code: 'DELETE_FAILED' }, { status: 500 });
  return NextResponse.json({ ok: true });
}
