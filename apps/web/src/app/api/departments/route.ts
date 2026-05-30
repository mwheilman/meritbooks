export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';

type ChargeMethod = 'inherit' | 'revenue' | 'cost_transfer';
const CHARGE_METHODS: ChargeMethod[] = ['inherit', 'revenue', 'cost_transfer'];

/** Resolve the active organization (single-tenant resolution, matches other routes). */
async function getOrgId(supabase: ReturnType<typeof createAdminSupabase>): Promise<string | null> {
  const { data: org } = await supabase.from('organizations').select('id').limit(1).single();
  return org?.id ?? null;
}

/** Build a unique, slug-style department code for an org. */
async function makeUniqueCode(
  supabase: ReturnType<typeof createAdminSupabase>,
  orgId: string,
  desired: string,
  ignoreId?: string
): Promise<string> {
  let base = (desired || 'DEPT')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 12);
  if (!base) base = 'DEPT';

  const { data: existing } = await supabase
    .from('departments')
    .select('id, code')
    .eq('org_id', orgId);

  const taken = new Set(
    (existing ?? [])
      .filter((d: { id: string }) => d.id !== ignoreId)
      .map((d: { code: string }) => d.code)
  );

  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

// ── GET: list departments (grouped client-side), with company + parent context ──
export async function GET(_req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const supabase = createAdminSupabase();
    const orgId = await getOrgId(supabase);
    if (!orgId) return NextResponse.json({ departments: [], total: 0 });

    const { data, error } = await supabase
      .from('departments')
      .select('id, name, code, location_id, parent_department_id, internal_charge_method, hierarchy_depth, is_active, created_at')
      .eq('org_id', orgId)
      .order('name');

    if (error) {
      console.error('[departments] list error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const rows = data ?? [];
    const byId = new Map(rows.map((d) => [d.id, d]));

    const departments = rows.map((d) => ({
      id: d.id,
      name: d.name,
      code: d.code,
      locationId: d.location_id,
      parentDepartmentId: d.parent_department_id,
      parentName: d.parent_department_id ? byId.get(d.parent_department_id)?.name ?? null : null,
      internalChargeMethod: d.internal_charge_method as ChargeMethod,
      hierarchyDepth: d.hierarchy_depth ?? 1,
      isActive: d.is_active,
      createdAt: d.created_at,
    }));

    return NextResponse.json({
      departments,
      total: departments.length,
      active: departments.filter((d) => d.isActive).length,
    });
  } catch (err) {
    console.error('[departments] GET unexpected:', err);
    return NextResponse.json({ error: 'Failed to load departments' }, { status: 500 });
  }
}

// ── POST: create a department ──
export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const locationId = typeof body.location_id === 'string' ? body.location_id : null;
    const parentId = typeof body.parent_department_id === 'string' && body.parent_department_id
      ? body.parent_department_id
      : null;
    const chargeMethod: ChargeMethod = CHARGE_METHODS.includes(body.internal_charge_method)
      ? body.internal_charge_method
      : 'inherit';
    const requestedCode = typeof body.code === 'string' ? body.code.trim() : '';

    if (!name) return NextResponse.json({ error: 'Department name is required' }, { status: 400 });
    if (!locationId) return NextResponse.json({ error: 'A company (location) is required' }, { status: 400 });

    const supabase = createAdminSupabase();
    const orgId = await getOrgId(supabase);
    if (!orgId) return NextResponse.json({ error: 'No organization found' }, { status: 400 });

    // Validate company belongs to org
    const { data: loc } = await supabase
      .from('locations')
      .select('id')
      .eq('org_id', orgId)
      .eq('id', locationId)
      .single();
    if (!loc) return NextResponse.json({ error: 'Company not found' }, { status: 400 });

    // Validate + resolve hierarchy depth from parent
    let hierarchyDepth = 1;
    if (parentId) {
      const { data: parent } = await supabase
        .from('departments')
        .select('id, location_id, hierarchy_depth')
        .eq('org_id', orgId)
        .eq('id', parentId)
        .single();
      if (!parent) return NextResponse.json({ error: 'Parent department not found' }, { status: 400 });
      if (parent.location_id && parent.location_id !== locationId) {
        return NextResponse.json({ error: 'Parent department belongs to a different company' }, { status: 400 });
      }
      hierarchyDepth = Math.min((parent.hierarchy_depth ?? 1) + 1, 3);
    }

    const code = await makeUniqueCode(supabase, orgId, requestedCode || name);

    const { data: created, error } = await supabase
      .from('departments')
      .insert({
        org_id: orgId,
        location_id: locationId,
        name,
        code,
        parent_department_id: parentId,
        internal_charge_method: chargeMethod,
        hierarchy_depth: hierarchyDepth,
        is_active: true,
      })
      .select('id, name, code, location_id, parent_department_id, internal_charge_method, hierarchy_depth, is_active')
      .single();

    if (error) {
      console.error('[departments] create error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ department: created }, { status: 201 });
  } catch (err) {
    console.error('[departments] POST unexpected:', err);
    return NextResponse.json({ error: 'Failed to create department' }, { status: 500 });
  }
}

// ── PATCH: update a department ──
export async function PATCH(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => null);
    const id = body && typeof body.id === 'string' ? body.id : '';
    if (!id) return NextResponse.json({ error: 'Department id is required' }, { status: 400 });

    const supabase = createAdminSupabase();
    const orgId = await getOrgId(supabase);
    if (!orgId) return NextResponse.json({ error: 'No organization found' }, { status: 400 });

    const { data: existing } = await supabase
      .from('departments')
      .select('id, location_id')
      .eq('org_id', orgId)
      .eq('id', id)
      .single();
    if (!existing) return NextResponse.json({ error: 'Department not found' }, { status: 404 });

    const update: Record<string, unknown> = {};
    if (typeof body.name === 'string' && body.name.trim()) update.name = body.name.trim();
    if (CHARGE_METHODS.includes(body.internal_charge_method)) update.internal_charge_method = body.internal_charge_method;
    if (typeof body.is_active === 'boolean') update.is_active = body.is_active;
    if (typeof body.code === 'string' && body.code.trim()) {
      update.code = await makeUniqueCode(supabase, orgId, body.code.trim(), id);
    }
    if ('parent_department_id' in body) {
      const parentId = typeof body.parent_department_id === 'string' && body.parent_department_id
        ? body.parent_department_id
        : null;
      if (parentId === id) {
        return NextResponse.json({ error: 'A department cannot be its own parent' }, { status: 400 });
      }
      if (parentId) {
        const { data: parent } = await supabase
          .from('departments')
          .select('id, location_id, hierarchy_depth')
          .eq('org_id', orgId)
          .eq('id', parentId)
          .single();
        if (!parent) return NextResponse.json({ error: 'Parent department not found' }, { status: 400 });
        if (parent.location_id && existing.location_id && parent.location_id !== existing.location_id) {
          return NextResponse.json({ error: 'Parent department belongs to a different company' }, { status: 400 });
        }
        update.hierarchy_depth = Math.min((parent.hierarchy_depth ?? 1) + 1, 3);
      } else {
        update.hierarchy_depth = 1;
      }
      update.parent_department_id = parentId;
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    const { data: updated, error } = await supabase
      .from('departments')
      .update(update)
      .eq('org_id', orgId)
      .eq('id', id)
      .select('id, name, code, location_id, parent_department_id, internal_charge_method, hierarchy_depth, is_active')
      .single();

    if (error) {
      console.error('[departments] update error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ department: updated });
  } catch (err) {
    console.error('[departments] PATCH unexpected:', err);
    return NextResponse.json({ error: 'Failed to update department' }, { status: 500 });
  }
}

// ── DELETE: deactivate a department (soft; preserves GL/job references) ──
export async function DELETE(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id') ?? '';
    if (!id) return NextResponse.json({ error: 'Department id is required' }, { status: 400 });

    const supabase = createAdminSupabase();
    const orgId = await getOrgId(supabase);
    if (!orgId) return NextResponse.json({ error: 'No organization found' }, { status: 400 });

    // Block deactivation if it has active child departments
    const { count: childCount } = await supabase
      .from('departments')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('parent_department_id', id)
      .eq('is_active', true);

    if ((childCount ?? 0) > 0) {
      return NextResponse.json(
        { error: 'Deactivate or reassign the sub-departments first' },
        { status: 409 }
      );
    }

    const { error } = await supabase
      .from('departments')
      .update({ is_active: false })
      .eq('org_id', orgId)
      .eq('id', id);

    if (error) {
      console.error('[departments] deactivate error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[departments] DELETE unexpected:', err);
    return NextResponse.json({ error: 'Failed to deactivate department' }, { status: 500 });
  }
}
