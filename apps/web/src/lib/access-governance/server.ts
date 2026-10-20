/**
 * Server-side helpers for the access-governance API routes (wave 2D).
 *
 * The AUTHORITY for every write is the database: the migration-166 definer functions re-check
 * the caller's seat, the delegation ceiling (05 §4.2), H1 and review / suggestion rights, and
 * they are EXECUTE-granted to service_role only. Routes therefore:
 *   1. resolve the caller's core.users id + active membership in the session tenant
 *      (fail closed → 403),
 *   2. call the definer RPC with the service-role client, passing that id as the actor,
 *   3. map the database's refusal (SQLSTATE) to an HTTP status with its plain-English message.
 * Reads go through the caller's RLS-scoped client wherever the 166 policies allow.
 */

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requestClientIp } from '@/lib/auth/client-ip';

export interface GovActor {
  orgId: string;
  userId: string; // core.users.id
  membershipId: string;
  isTenantAdmin: boolean;
}

/** Caller's seat in the session tenant, or a 403 the route must return. */
export async function resolveGovActor(
  clerkUserId: string,
  orgId: string | null,
  admin: SupabaseClient = createAdminSupabase(),
): Promise<GovActor | NextResponse> {
  if (!orgId) return NextResponse.json({ error: 'No organization on session', code: 'NO_ORG' }, { status: 403 });
  const { data: u } = await admin.schema('core').from('users').select('id').eq('clerk_user_id', clerkUserId).maybeSingle();
  const userId = (u as { id: string } | null)?.id;
  if (!userId) return NextResponse.json({ error: 'Forbidden', code: 'NO_SEAT' }, { status: 403 });
  const { data: m } = await admin
    .schema('core')
    .from('memberships')
    .select('id, status')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .maybeSingle();
  const row = m as { id: string; status: string | null } | null;
  if (!row || (row.status ?? 'active') !== 'active') {
    return NextResponse.json({ error: 'Forbidden', code: 'NO_SEAT' }, { status: 403 });
  }
  const { data: isAdmin } = await admin.schema('core').rpc('access_is_tenant_admin', { p_membership: row.id });
  return { orgId, userId, membershipId: row.id, isTenantAdmin: isAdmin === true };
}

/** Does the caller hold capability:action (tenant context, or on one client)? */
export async function actorHolds(
  actor: GovActor,
  capability: string,
  action: string,
  locationId: string | null = null,
  admin: SupabaseClient = createAdminSupabase(),
): Promise<boolean> {
  const { data } = await admin.schema('core').rpc('access_holds', {
    p_membership: actor.membershipId,
    p_location: locationId,
    p_capability: capability,
    p_action: action,
  });
  return !!data && typeof data === 'object' && (data as { allowed?: unknown }).allowed === true;
}

/** Client IP for the log — platform-set headers only (lib/auth/client-ip.ts). */
export function requestIp(): string | null {
  return requestClientIp();
}

interface PgError {
  code?: string;
  message?: string;
}

/** Map a definer-function refusal to an HTTP response with its plain-English message. */
export function dbErrorResponse(err: PgError): NextResponse {
  const message = (err.message ?? 'Request failed').replace(/^Delegation ceiling: /, '');
  switch (err.code) {
    case '42501': // insufficient_privilege (ceiling, H1, rights)
      return NextResponse.json({ error: message, code: 'FORBIDDEN' }, { status: 403 });
    case '23514': // check_violation (validation / state)
    case '23505':
      return NextResponse.json({ error: message, code: 'REJECTED' }, { status: 422 });
    case 'P0002': // no_data_found
      return NextResponse.json({ error: message, code: 'NOT_FOUND' }, { status: 404 });
    default:
      return NextResponse.json({ error: message, code: 'DB_ERROR' }, { status: 500 });
  }
}

/** core.users id → display name, limited to people with a seat in the tenant. */
export async function userNames(admin: SupabaseClient, orgId: string, userIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const { data: seats } = await admin.schema('core').from('memberships').select('user_id').eq('org_id', orgId).in('user_id', ids);
  const allowed = new Set(((seats ?? []) as Array<{ user_id: string }>).map((s) => s.user_id));
  if (!allowed.size) return out;
  const { data } = await admin.schema('core').from('users').select('id, first_name, last_name, email').in('id', [...allowed]);
  for (const u of (data ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null }>) {
    out.set(u.id, personName(u));
  }
  return out;
}

/** membership id → display name (same tenant only). */
export async function memberNames(admin: SupabaseClient, orgId: string, membershipIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(membershipIds.filter(Boolean))];
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const { data: seats } = await admin.schema('core').from('memberships').select('id, user_id').eq('org_id', orgId).in('id', ids);
  const rows = (seats ?? []) as Array<{ id: string; user_id: string }>;
  const names = await userNames(admin, orgId, rows.map((r) => r.user_id));
  for (const r of rows) out.set(r.id, names.get(r.user_id) ?? 'Unknown person');
  return out;
}

export function personName(u: { first_name: string | null; last_name: string | null; email: string | null }): string {
  const n = `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim();
  return n || u.email || 'Unknown person';
}

/** location id → name (same tenant only). */
export async function locationNames(db: SupabaseClient, orgId: string, ids: readonly string[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, string>();
  if (!uniq.length) return out;
  const { data } = await db.schema('core').from('locations').select('id, name').eq('org_id', orgId).in('id', uniq);
  for (const l of (data ?? []) as Array<{ id: string; name: string }>) out.set(l.id, l.name);
  return out;
}
