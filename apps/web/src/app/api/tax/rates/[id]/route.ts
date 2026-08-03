export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';

/**
 * Edit / retire one sales-tax rate row (GATE 11d). PATCH toggles is_active or updates
 * end_date / rate; DELETE deactivates (soft) to preserve the audit trail behind any
 * tax already accrued at that rate. RLS + settings_acct:edit.
 */

const patchSchema = z.object({
  is_active: z.boolean().optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  combined_rate_pct: z.number().min(0).max(30).optional(),
  notes: z.string().max(500).nullable().optional(),
});

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;
  const guard = await requirePermission(userId, 'settings_acct', 'edit');
  if (!guard.ok) return guard.response;

  const raw = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 422 });
  }
  const patch: Record<string, unknown> = {};
  if (parsed.data.is_active !== undefined) patch.is_active = parsed.data.is_active;
  if (parsed.data.end_date !== undefined) patch.end_date = parsed.data.end_date;
  if (parsed.data.combined_rate_pct !== undefined) patch.combined_rate_pct = parsed.data.combined_rate_pct;
  if (parsed.data.notes !== undefined) patch.notes = parsed.data.notes?.trim() || null;
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'No changes' }, { status: 400 });

  const { error } = await supabase
    .from('sales_tax_rates')
    .update(patch)
    .eq('id', params.id)
    .eq('org_id', orgId ?? '');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;
  const guard = await requirePermission(userId, 'settings_acct', 'edit');
  if (!guard.ok) return guard.response;

  // Soft-retire — keep the row so the rate history behind accrued tax is preserved.
  const { error } = await supabase
    .from('sales_tax_rates')
    .update({ is_active: false })
    .eq('id', params.id)
    .eq('org_id', orgId ?? '');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
