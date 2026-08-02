export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler, requireAuthedContext } from '@/lib/api-handler';

/**
 * Ownership / consolidation-structure editor API (GATE 11a, migration 076).
 *
 *   GET    → the tenant's entities + their current ownership structure rows.
 *   POST   → upsert one parent→child ownership edge (percent + method + dates).
 *   DELETE → remove a structure row (?id=…). Absence of a row = FULL/100% default.
 *
 * All routes are RLS-scoped (public.entity_ownership org_isolation via get_org_id()).
 * The engine degrades safe, so this table is purely additive configuration.
 */

const upsertSchema = z.object({
  id: z.string().uuid().optional(),
  parent_entity_id: z.string().uuid(),
  child_entity_id: z.string().uuid(),
  ownership_percent: z.number().min(0).max(100),
  consolidation_method: z.enum(['FULL', 'EQUITY', 'NONE']),
  effective_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  effective_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().max(500).optional(),
});
type UpsertBody = z.infer<typeof upsertSchema>;

export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) {
    return NextResponse.json({ error: 'No organization in session', code: 'NO_ORG' }, { status: 400 });
  }

  const { data: locs } = await supabase
    .schema('core')
    .from('locations')
    .select('id, name, short_code, parent_entity_id')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .order('name');

  let ownershipTableAvailable = true;
  const { data: rows, error } = await supabase
    .from('entity_ownership')
    .select(
      'id, parent_entity_id, child_entity_id, ownership_percent, consolidation_method, effective_start, effective_end, notes',
    )
    .eq('org_id', orgId)
    .order('effective_start', { ascending: false });
  if (error) ownershipTableAvailable = false;

  return NextResponse.json({
    entities: (locs ?? []).map((l: Record<string, unknown>) => ({
      id: l.id as string,
      name: l.name as string,
      shortCode: (l.short_code as string) ?? null,
      parentEntityId: (l.parent_entity_id as string) ?? null,
    })),
    ownership: rows ?? [],
    ownershipTableAvailable,
  });
}

export const POST = apiHandler(upsertSchema, async (body: UpsertBody, ctx) => {
  if (!ctx.orgId) {
    return NextResponse.json({ error: 'No organization in session', code: 'NO_ORG' }, { status: 400 });
  }
  if (body.parent_entity_id === body.child_entity_id) {
    return NextResponse.json(
      { error: 'Parent and child entity must differ.', code: 'INVALID_EDGE' },
      { status: 422 },
    );
  }
  const row = {
    org_id: ctx.orgId,
    parent_entity_id: body.parent_entity_id,
    child_entity_id: body.child_entity_id,
    ownership_percent: body.ownership_percent,
    consolidation_method: body.consolidation_method,
    effective_start: body.effective_start ?? new Date().toISOString().slice(0, 10),
    effective_end: body.effective_end ?? null,
    notes: body.notes ?? null,
    created_by: null,
  };

  const query = body.id
    ? ctx.supabase.from('entity_ownership').update(row).eq('id', body.id).eq('org_id', ctx.orgId).select('id').single()
    : ctx.supabase
        .from('entity_ownership')
        .upsert(row, { onConflict: 'org_id,parent_entity_id,child_entity_id,effective_start' })
        .select('id')
        .single();

  const { data, error } = await query;
  if (error) {
    const code = /relation .* does not exist/i.test(error.message) ? 'MIGRATION_PENDING' : 'DB_ERROR';
    const status = code === 'MIGRATION_PENDING' ? 503 : 500;
    return NextResponse.json({ error: error.message, code }, { status });
  }
  return NextResponse.json({ id: data?.id, ok: true });
});

export async function DELETE(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) {
    return NextResponse.json({ error: 'No organization in session', code: 'NO_ORG' }, { status: 400 });
  }
  const id = new URL(request.url).searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: 'id is required', code: 'MISSING_ID' }, { status: 400 });
  }
  const { error } = await supabase.from('entity_ownership').delete().eq('id', id).eq('org_id', orgId);
  if (error) {
    return NextResponse.json({ error: error.message, code: 'DB_ERROR' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
