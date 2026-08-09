export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requireManageUsers } from '@/lib/team/guard';
import { ALL_ROLES } from '@/lib/rbac/permissions';
import { createCustomRoleSchema, deriveCustomRoleKey } from '@/lib/validations/rbac';
import { logHumanAction } from '@/lib/trust/action-log';

/**
 * POST /api/rbac/custom-roles
 *
 * Admin-only. Create a custom role cloned from a base system role (or deny-all when no
 * base). The role's grants are the base role's shipped defaults; the admin then tunes
 * individual cells via /api/rbac/overrides. Fails closed for non-admins.
 *
 * Key derivation is server-side and 'custom_'-prefixed so a custom key can never collide
 * with (or shadow) one of the 9 system role keys. A slug collision within the org gets a
 * numeric suffix.
 */
export async function POST(req: NextRequest) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;

  const grant = await requireManageUsers(supabase, userId, orgId);
  if (grant instanceof NextResponse) return grant;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }

  const parsed = createCustomRoleSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors },
      { status: 422 },
    );
  }

  const { name, description, baseRole } = parsed.data;

  // Defense in depth: baseRole is already enum-validated, but re-check membership in the
  // frozen role set before it becomes a stored default source.
  const base = baseRole && (ALL_ROLES as readonly string[]).includes(baseRole) ? baseRole : null;

  // Derive a unique, collision-proof key within the org.
  const baseKey = deriveCustomRoleKey(name);
  const { data: existing } = await supabase
    .schema('core')
    .from('custom_roles')
    .select('key')
    .eq('org_id', orgId!)
    .ilike('key', `${baseKey}%`);
  const taken = new Set((existing ?? []).map((r: { key: string }) => r.key));
  let key = baseKey;
  let n = 2;
  while (taken.has(key)) {
    key = `${baseKey}_${n++}`;
  }

  const { data: created, error: insErr } = await supabase
    .schema('core')
    .from('custom_roles')
    .insert({
      org_id: orgId!,
      key,
      name: name.trim(),
      description: description?.trim() || null,
      base_role: base,
      created_by: userId,
    })
    .select('key, name, description, base_role')
    .single();

  if (insErr || !created) {
    // A racing insert of the same key trips the (org_id, key) unique index.
    const dup = insErr?.code === '23505';
    return NextResponse.json(
      {
        error: dup ? 'A role with a conflicting key already exists' : insErr?.message ?? 'Failed to create role',
        code: dup ? 'DUPLICATE_ROLE' : 'INSERT_ERROR',
      },
      { status: dup ? 409 : 500 },
    );
  }

  await logHumanAction(supabase, userId, orgId!, {
    action: 'rbac.custom_role.create',
    subjectTable: 'custom_roles',
    subjectId: created.key,
    summary: `Created custom role "${created.name}"${base ? ` (based on ${base})` : ''}`,
    metadata: { key: created.key, baseRole: base },
  });

  return NextResponse.json({ data: created }, { status: 201 });
}
