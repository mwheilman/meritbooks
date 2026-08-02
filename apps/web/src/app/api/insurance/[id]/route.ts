export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { updatePolicySchema } from '@/lib/insurance/schema';

/**
 * /api/insurance/[id]
 *
 * PATCH  — edit a policy definition (partial). RLS scopes the update to the org.
 * DELETE — remove a policy.
 *
 * Dynamic-param routes can't use the apiHandler wrapper, so these validate the body
 * with the shared Zod schema by hand (mirrors the covenants [id] route).
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
  const parsed = updatePolicySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR' }, { status: 422 });
  }

  const b = parsed.data;
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (b.location_id !== undefined) patch.location_id = b.location_id ?? null;
  if (b.carrier !== undefined) patch.carrier = b.carrier ?? null;
  if (b.policy_number !== undefined) patch.policy_number = b.policy_number ?? null;
  if (b.coverage_type !== undefined) patch.coverage_type = b.coverage_type;
  if (b.coverage_limit_cents !== undefined) patch.coverage_limit_cents = b.coverage_limit_cents ?? null;
  if (b.deductible_cents !== undefined) patch.deductible_cents = b.deductible_cents ?? null;
  if (b.premium_cents !== undefined) patch.premium_cents = b.premium_cents ?? null;
  if (b.premium_frequency !== undefined) patch.premium_frequency = b.premium_frequency;
  if (b.effective_date !== undefined) patch.effective_date = b.effective_date ?? null;
  if (b.expiration_date !== undefined) patch.expiration_date = b.expiration_date ?? null;
  if (b.status !== undefined) patch.status = b.status;
  if (b.broker !== undefined) patch.broker = b.broker ?? null;
  if (b.notes !== undefined) patch.notes = b.notes ?? null;

  const { error } = await ctx.supabase.from('insurance_policies').update(patch).eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message, code: 'UPDATE_FAILED' }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: Request, { params }: Params): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;

  const { error } = await ctx.supabase.from('insurance_policies').delete().eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message, code: 'DELETE_FAILED' }, { status: 500 });
  return NextResponse.json({ ok: true });
}
