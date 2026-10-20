export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { actorHolds, personName, resolveGovActor } from '@/lib/access-governance/server';

/**
 * GET /api/access/directory — pick-lists for the access-governance screens: clients, roles
 * and permission sets anyone may request, plus (for people who administer or audit access)
 * the tenant's members. Also returns what the caller may do on these screens.
 */
export const GET = apiQueryHandler(null, async (_q, ctx) => {
  const admin = createAdminSupabase();
  const actor = await resolveGovActor(ctx.userId, ctx.orgId, admin);
  if (actor instanceof NextResponse) return actor;

  const [canSeePeople, canStartReviews, canSeeLog, canChangeRoles] = await Promise.all([
    actor.isTenantAdmin
      ? Promise.resolve(true)
      : actorHolds(actor, 'core.access.members', 'view', null, admin).then(
          async (v) => v || (await actorHolds(actor, 'core.access.reviews', 'view', null, admin)),
        ),
    actor.isTenantAdmin ? Promise.resolve(true) : actorHolds(actor, 'core.access.reviews', 'create', null, admin),
    actor.isTenantAdmin ? Promise.resolve(true) : actorHolds(actor, 'ctl.audit_trail', 'view', null, admin),
    actor.isTenantAdmin ? Promise.resolve(true) : actorHolds(actor, 'core.access.roles', 'configure', null, admin),
  ]);

  const [clients, roles, sets] = await Promise.all([
    ctx.supabase.schema('core').from('locations').select('id, name, is_active').eq('org_id', actor.orgId).order('name'),
    ctx.supabase
      .schema('core')
      .from('role_definitions')
      .select('id, name, description, owner_level, location_id, audience, status')
      .eq('org_id', actor.orgId)
      .eq('status', 'active')
      .order('name'),
    ctx.supabase
      .schema('core')
      .from('permission_sets')
      .select('id, name, description, is_envelope, is_sealed, status')
      .eq('org_id', actor.orgId)
      .eq('status', 'active')
      .eq('is_envelope', false)
      .eq('is_sealed', false)
      .order('name'),
  ]);
  if (clients.error || roles.error || sets.error) {
    return NextResponse.json({ error: 'Could not load the directory', code: 'QUERY_ERROR' }, { status: 500 });
  }

  let people: Array<{ membershipId: string; name: string; email: string | null }> = [];
  if (canSeePeople) {
    const { data: seats } = await admin
      .schema('core')
      .from('memberships')
      .select('id, user_id, status')
      .eq('org_id', actor.orgId);
    const seatRows = (seats ?? []) as Array<{ id: string; user_id: string; status: string | null }>;
    const { data: users } = seatRows.length
      ? await admin.schema('core').from('users').select('id, first_name, last_name, email').in('id', seatRows.map((s) => s.user_id))
      : { data: [] };
    const byId = new Map(((users ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null }>).map((u) => [u.id, u]));
    people = seatRows
      .map((s) => {
        const u = byId.get(s.user_id);
        return { membershipId: s.id, name: u ? personName(u) : 'Unknown person', email: u?.email ?? null };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  return NextResponse.json({
    data: {
      me: {
        membershipId: actor.membershipId,
        isTenantAdmin: actor.isTenantAdmin,
        canStartReviews,
        canSeeLog: canSeeLog || canSeePeople,
        canChangeRoles,
      },
      clients: ((clients.data ?? []) as Array<{ id: string; name: string; is_active: boolean | null }>)
        .filter((c) => c.is_active !== false)
        .map((c) => ({ id: c.id, name: c.name })),
      roles: ((roles.data ?? []) as Array<{ id: string; name: string; description: string | null; owner_level: string; location_id: string | null; audience: string }>)
        .filter((r) => r.owner_level === 'tenant' || r.owner_level === 'client')
        .map((r) => ({ id: r.id, name: r.name, description: r.description, locationId: r.location_id, audience: r.audience })),
      permissionSets: ((sets.data ?? []) as Array<{ id: string; name: string; description: string | null }>).map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
      })),
      people,
    },
  });
});
