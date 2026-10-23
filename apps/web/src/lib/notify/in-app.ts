/**
 * In-app notifications (core.notifications, migration 178 / IA M-13).
 *
 * Written ONLY by the service role (members can't write the table — 171 pattern); a
 * member reads their own rows through RLS (membership_id = core.notify_caller_membership()).
 * `dedupeKey` makes a notification idempotent per membership — the dispatcher can rerun
 * and the escalation still arrives exactly once.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type NotificationSeverity = 'info' | 'attention' | 'critical';

export interface NewNotification {
  orgId: string;
  membershipId: string;
  kind: string;
  title: string;
  body?: string | null;
  deepLink?: string | null;
  severity?: NotificationSeverity;
  requestId?: string | null;
  locationId?: string | null;
  dedupeKey?: string | null;
}

/** Internal deep links only ("/x", never "//host" or "https://…"). */
export function safeDeepLink(v: string | null | undefined): string | null {
  if (!v || typeof v !== 'string') return null;
  return v.startsWith('/') && !v.startsWith('//') && !v.includes('\\') ? v.slice(0, 500) : null;
}

export type CreateOutcome = 'created' | 'duplicate' | 'failed';

export async function createNotification(writer: SupabaseClient, n: NewNotification): Promise<CreateOutcome> {
  const { error } = await writer.schema('core').from('notifications').insert({
    org_id: n.orgId,
    membership_id: n.membershipId,
    location_id: n.locationId ?? null,
    kind: n.kind,
    severity: n.severity ?? 'info',
    title: n.title.slice(0, 200),
    body: n.body ? n.body.slice(0, 1000) : null,
    deep_link: safeDeepLink(n.deepLink),
    request_id: n.requestId ?? null,
    dedupe_key: n.dedupeKey ?? null,
  });
  if (!error) return 'created';
  const code = (error as { code?: string }).code;
  if (code === '23505' || /duplicate key|unique/i.test(error.message)) return 'duplicate';
  console.warn('[notify] notification insert failed:', error.message);
  return 'failed';
}

/** Notify several members; returns how many were newly created. Never throws. */
export async function notifyMembers(
  writer: SupabaseClient,
  membershipIds: ReadonlyArray<string>,
  n: Omit<NewNotification, 'membershipId'>,
): Promise<number> {
  let created = 0;
  for (const id of Array.from(new Set(membershipIds))) {
    try {
      if ((await createNotification(writer, { ...n, membershipId: id })) === 'created') created++;
    } catch (e) {
      console.warn('[notify] notifyMembers failed (non-fatal):', e);
    }
  }
  return created;
}

const ADMIN_ROLES = ['owner', 'admin', 'org_admin', 'company_admin', 'cfo', 'accounting_manager', 'merit_controller'];

/** Tenant admins / managers — the escalation fallback when a request has no owner. */
export async function tenantAdminMemberships(db: SupabaseClient, orgId: string): Promise<string[]> {
  const { data, error } = await db
    .schema('core')
    .from('memberships')
    .select('id, role, status')
    .eq('org_id', orgId)
    .eq('status', 'active')
    .in('role', ADMIN_ROLES);
  if (error) return [];
  return ((data ?? []) as Array<{ id: string }>).map((m) => m.id);
}

/** The caller's active membership in the org (Clerk user id → core.users → memberships). */
export async function membershipIdFor(db: SupabaseClient, orgId: string, clerkUserId: string): Promise<string | null> {
  const { data: u } = await db.schema('core').from('users').select('id').eq('clerk_user_id', clerkUserId).maybeSingle();
  const userId = (u as { id?: string } | null)?.id;
  if (!userId) return null;
  const { data: m } = await db
    .schema('core')
    .from('memberships')
    .select('id')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle();
  return (m as { id?: string } | null)?.id ?? null;
}
