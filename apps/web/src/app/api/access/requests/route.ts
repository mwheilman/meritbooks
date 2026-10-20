export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { accessRequestCreateSchema } from '@/lib/validations/access-governance';
import { dbErrorResponse, memberNames, requestIp, resolveGovActor, userNames } from '@/lib/access-governance/server';
import { describeGrant } from '@/lib/access-governance/describe';
import type { AccessRequestView, RequestKind, RequestStatus } from '@/lib/access-governance/types';

/**
 * Request access (05-RBAC-SPEC §6.11, R-9).
 *
 * POST /api/access/requests  any member asks for a capability, a role, a permission set or
 *                            access to a client. core.access_request_create validates it,
 *                            de-duplicates open requests, refuses what you already hold and
 *                            routes it to everyone who could grant it (tenant admins + the
 *                            delegation ceiling).
 * GET  /api/access/requests  { mine, inbox } — your own requests, and the requests you can
 *                            decide (routed to you, or every request for access admins),
 *                            including approvals waiting for a second grantor.
 */

interface RequestRow {
  id: string;
  kind: RequestKind;
  capability: string | null;
  actions: string[];
  role_id: string | null;
  permission_set_id: string | null;
  location_id: string | null;
  duration_days: number | null;
  reason: string;
  status: RequestStatus;
  requester_membership_id: string;
  routed_to_membership_ids: string[];
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  needs_second_approval: boolean;
  assignment_id: string | null;
  created_at: string;
  expires_at: string;
}

function whatOf(r: RequestRow, roleName: string | null, setName: string | null, locationName: string | null): string {
  const where = r.location_id ? ` on ${locationName ?? 'a client'}` : r.kind === 'client' ? '' : ' on every client';
  const span = r.duration_days ? ` for ${r.duration_days} day${r.duration_days === 1 ? '' : 's'}` : '';
  switch (r.kind) {
    case 'capability':
      return `${describeGrant(r.capability ?? '', r.actions)}${where}${span}`.replace(/^./, (c) => c.toUpperCase());
    case 'role':
      return `${roleName ?? 'A role'}${where}${span}`;
    case 'permission_set':
      return `${setName ?? 'A permission set'}${where}${span}`;
    case 'client':
      return `Access to ${locationName ?? 'a client'}${roleName ? ` as ${roleName}` : ''}${span}`;
  }
}

export const GET = apiQueryHandler(null, async (_q, ctx) => {
  const admin = createAdminSupabase();
  const actor = await resolveGovActor(ctx.userId, ctx.orgId, admin);
  if (actor instanceof NextResponse) return actor;

  const { data, error } = await ctx.supabase
    .schema('core')
    .from('access_requests')
    .select('id, kind, capability, actions, role_id, permission_set_id, location_id, duration_days, reason, status, requester_membership_id, routed_to_membership_ids, decided_by, decided_at, decision_note, needs_second_approval, assignment_id, created_at, expires_at')
    .eq('org_id', actor.orgId)
    .order('created_at', { ascending: false })
    .limit(300);
  if (error) return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
  const rows = (data ?? []) as RequestRow[];

  const assignmentIds = rows.filter((r) => r.needs_second_approval && r.assignment_id).map((r) => r.assignment_id!);
  const [requesters, deciders, roles, sets, locs, pending] = await Promise.all([
    memberNames(admin, actor.orgId, rows.map((r) => r.requester_membership_id)),
    userNames(admin, actor.orgId, rows.map((r) => r.decided_by).filter((x): x is string => !!x)),
    ctx.supabase.schema('core').from('role_definitions').select('id, name').in('id', rows.map((r) => r.role_id).filter((x): x is string => !!x)),
    ctx.supabase.schema('core').from('permission_sets').select('id, name').in('id', rows.map((r) => r.permission_set_id).filter((x): x is string => !!x)),
    ctx.supabase.schema('core').from('locations').select('id, name').eq('org_id', actor.orgId).in('id', rows.map((r) => r.location_id).filter((x): x is string => !!x)),
    assignmentIds.length
      ? admin.schema('core').from('access_assignments').select('id, status, granted_by').eq('org_id', actor.orgId).in('id', assignmentIds)
      : Promise.resolve({ data: [] }),
  ]);
  const roleName = new Map(((roles.data ?? []) as Array<{ id: string; name: string }>).map((x) => [x.id, x.name]));
  const setName = new Map(((sets.data ?? []) as Array<{ id: string; name: string }>).map((x) => [x.id, x.name]));
  const locName = new Map(((locs.data ?? []) as Array<{ id: string; name: string }>).map((x) => [x.id, x.name]));
  const pendingById = new Map(((pending.data ?? []) as Array<{ id: string; status: string; granted_by: string | null }>).map((x) => [x.id, x]));

  const view = (r: RequestRow): AccessRequestView => {
    const p = r.assignment_id ? pendingById.get(r.assignment_id) : undefined;
    const roleN = r.role_id ? roleName.get(r.role_id) ?? null : null;
    const setN = r.permission_set_id ? setName.get(r.permission_set_id) ?? null : null;
    const locN = r.location_id ? locName.get(r.location_id) ?? null : null;
    const expired = r.status === 'pending' && new Date(r.expires_at).getTime() <= Date.now();
    return {
      id: r.id,
      kind: r.kind,
      what: whatOf(r, roleN, setN, locN),
      capability: r.capability,
      actions: r.actions ?? [],
      roleId: r.role_id,
      roleName: roleN,
      permissionSetName: setN,
      locationId: r.location_id,
      locationName: locN,
      durationDays: r.duration_days,
      reason: r.reason,
      status: expired ? 'expired' : r.status,
      requesterMembershipId: r.requester_membership_id,
      requesterName: requesters.get(r.requester_membership_id) ?? 'Unknown person',
      decidedByName: r.decided_by ? deciders.get(r.decided_by) ?? null : null,
      decidedAt: r.decided_at,
      decisionNote: r.decision_note,
      needsSecondApproval: r.needs_second_approval,
      awaitingSecondApproval: !!p && p.status === 'pending_approval',
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      routedCount: (r.routed_to_membership_ids ?? []).length,
    };
  };

  const mine = rows.filter((r) => r.requester_membership_id === actor.membershipId).map(view);
  const inbox = rows
    .filter((r) => r.requester_membership_id !== actor.membershipId)
    .filter((r) => actor.isTenantAdmin || (r.routed_to_membership_ids ?? []).includes(actor.membershipId))
    .map(view)
    .filter((v) => v.status === 'pending' || v.awaitingSecondApproval)
    // a second approval can't come from the first approver
    .filter((v) => {
      if (!v.awaitingSecondApproval) return true;
      const r = rows.find((x) => x.id === v.id);
      const p = r?.assignment_id ? pendingById.get(r.assignment_id) : undefined;
      return p?.granted_by !== actor.userId;
    });
  const recent = actor.isTenantAdmin
    ? rows
        .filter((r) => r.requester_membership_id !== actor.membershipId && r.status !== 'pending')
        .slice(0, 25)
        .map(view)
        .filter((v) => !v.awaitingSecondApproval)
    : [];

  return NextResponse.json({ data: { mine, inbox, recent } });
});

export const POST = apiHandler(accessRequestCreateSchema, async (body, ctx) => {
  const admin = createAdminSupabase();
  const actor = await resolveGovActor(ctx.userId, ctx.orgId, admin);
  if (actor instanceof NextResponse) return actor;

  const { data, error } = await admin.schema('core').rpc('access_request_create', {
    p_org: actor.orgId,
    p_requester_user: actor.userId,
    p_kind: body.kind,
    p_capability: body.kind === 'capability' ? body.capability ?? null : null,
    p_actions: body.kind === 'capability' ? body.actions ?? [] : [],
    p_role: body.kind === 'role' ? body.roleId ?? null : null,
    p_permission_set: body.kind === 'permission_set' ? body.permissionSetId ?? null : null,
    p_location: body.locationId ?? null,
    p_duration_days: body.durationDays ?? null,
    p_reason: body.reason,
    p_ip: requestIp(),
  });
  if (error) return dbErrorResponse(error);

  const { data: row } = await admin
    .schema('core')
    .from('access_requests')
    .select('id, status, routed_to_membership_ids')
    .eq('id', data as string)
    .eq('org_id', actor.orgId)
    .maybeSingle();
  const r = row as { id: string; status: string; routed_to_membership_ids: string[] } | null;
  return NextResponse.json(
    { data: { id: data as string, status: r?.status ?? 'pending', routedCount: r?.routed_to_membership_ids?.length ?? 0 } },
    { status: 201 },
  );
});
