export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { z } from 'zod';

/**
 * Edit / delete a single reporting-basis adjustment. RLS scopes both to the caller's org;
 * writes are gated on `journal_entries:create` (same guard as the book-to-tax tags). These
 * are report-presentation deltas — deleting or editing one never touches the GL.
 */

const ADJ_TYPES = ['TIMING', 'PERMANENT', 'RECLASS'] as const;

const patchSchema = z.object({
  description: z.string().max(500).nullable().optional(),
  amount_cents: z.number().int().optional(),
  adjustment_type: z.enum(ADJ_TYPES).nullable().optional(),
  custom_label: z.string().max(120).nullable().optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization found', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'journal_entries', 'create');
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, { status: 422 });
  }
  if (parsed.data.amount_cents === 0) {
    return NextResponse.json({ error: 'A zero adjustment has no effect.', code: 'ZERO_AMOUNT' }, { status: 422 });
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.description !== undefined) update.description = parsed.data.description;
  if (parsed.data.amount_cents !== undefined) update.amount_cents = parsed.data.amount_cents;
  if (parsed.data.adjustment_type !== undefined) update.adjustment_type = parsed.data.adjustment_type;
  if (parsed.data.custom_label !== undefined) update.custom_label = parsed.data.custom_label;

  const { error } = await supabase
    .from('reporting_basis_adjustments')
    .update(update)
    .eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message, code: 'UPDATE_ERROR' }, { status: 500 });
  return NextResponse.json({ data: { ok: true } });
}

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization found', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'journal_entries', 'create');
  if (!guard.ok) return guard.response;

  const { error } = await supabase
    .from('reporting_basis_adjustments')
    .delete()
    .eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message, code: 'DELETE_ERROR' }, { status: 500 });
  return NextResponse.json({ data: { ok: true } });
}
