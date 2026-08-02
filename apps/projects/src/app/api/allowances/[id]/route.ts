import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';

// PATCH /api/allowances/[id] — record drawdown (consumedCents) and/or open/close
// an allowance. guard ('proj_contracts','edit'). RLS scopes the update to the
// caller's org; a cross-org / missing id updates zero rows → 404.
//
// consumed_cents is the running total consumed to date (an absolute figure, not
// a delta) — matching proj.allowances.consumed_cents. Overruns (consumed >
// allowance) are permitted and surfaced as a negative remaining in the UI;
// tracking the overrun is the point.

const idSchema = z.string().uuid();

const patchSchema = z
  .object({
    consumedCents: z.number().int().nonnegative().optional(),
    status: z.enum(['OPEN', 'CLOSED']).optional(),
  })
  .refine((v) => v.consumedCents !== undefined || v.status !== undefined, {
    message: 'Provide consumedCents and/or status.',
  });

export async function PATCH(
  request: Request,
  context: { params: { id: string } },
): Promise<NextResponse> {
  const parsedId = idSchema.safeParse(context.params.id);
  if (!parsedId.success) {
    return NextResponse.json(
      { error: 'Invalid allowance id', code: 'VALIDATION_ERROR' },
      { status: 422 },
    );
  }
  const allowanceId = parsedId.data;

  return apiHandler(patchSchema, async (body, ctx) => {
    const guard = await requirePermission(ctx, 'proj_contracts', 'edit');
    if (!guard.ok) return guard.response;

    const patch: { consumed_cents?: number; status?: string; updated_at: string } = {
      updated_at: new Date().toISOString(),
    };
    if (body.consumedCents !== undefined) patch.consumed_cents = body.consumedCents;
    if (body.status !== undefined) patch.status = body.status;

    const { data, error } = await ctx.supabase
      .schema('proj')
      .from('allowances')
      .update(patch)
      .eq('id', allowanceId)
      .select('id, allowance_cents, consumed_cents, status')
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message, code: 'UPDATE_FAILED' }, { status: 422 });
    }
    if (!data) {
      return NextResponse.json(
        { error: 'Allowance not found', code: 'ALLOWANCE_NOT_FOUND' },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, allowance: data });
  })(request);
}
