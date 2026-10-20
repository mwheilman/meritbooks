export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { accessLogQuerySchema } from '@/lib/validations/access-governance';
import { actorHolds, resolveGovActor, locationNames, memberNames, requestIp, userNames } from '@/lib/access-governance/server';
import { describeLogEntry, LOG_EVENT_GROUPS } from '@/lib/access-governance/describe';
import { toCsv } from '@/lib/access-governance/csv';
import type { AccessLogEntry, LogSource, LogSubjectType } from '@/lib/access-governance/types';

/**
 * GET /api/access/log — the access change log (05-RBAC-SPEC §5.5, §6.9 A9).
 *
 * Filters: member (membership id), client (location id; also matches all-clients grants),
 * group (event family), from / to (dates), q (free text over event / reason), before (seq
 * cursor), limit. `format=csv` streams the filtered log (up to 5,000 rows) as audit evidence,
 * formula-injection safe, and records the export itself in the log.
 *
 * AUTHORITY: rows are read through the caller's RLS client — migration 166's policy only
 * returns rows to tenant admins and holders of ctl.audit_trail:view / core.access.reviews:view.
 */

interface LogRow {
  id: string;
  seq: number;
  at: string;
  event: string;
  source: LogSource;
  actor_context: string;
  actor_user_id: string | null;
  subject_type: LogSubjectType;
  subject_id: string | null;
  affected_membership_ids: string[] | null;
  location_ids: string[] | null;
  all_clients: boolean;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  approval_ref: string | null;
}

const CSV_MAX = 5000;

export const GET = apiQueryHandler(accessLogQuerySchema, async (q, ctx) => {
  const admin = createAdminSupabase();
  const actor = await resolveGovActor(ctx.userId, ctx.orgId, admin);
  if (actor instanceof NextResponse) return actor;
  // Same rule as the RLS policy, checked up front so the screen can offer "Request access"
  // instead of an empty log.
  const mayRead =
    actor.isTenantAdmin ||
    (await actorHolds(actor, 'ctl.audit_trail', 'view', null, admin)) ||
    (await actorHolds(actor, 'core.access.reviews', 'view', null, admin));
  if (!mayRead) {
    return NextResponse.json(
      { error: 'You do not have access to the access log.', code: 'FORBIDDEN', capability: 'ctl.audit_trail', action: 'view' },
      { status: 403 },
    );
  }

  const limit = q.format === 'csv' ? CSV_MAX : q.limit ?? 50;
  let query = ctx.supabase
    .schema('core')
    .from('access_change_log')
    .select('id, seq, at, event, source, actor_context, actor_user_id, subject_type, subject_id, affected_membership_ids, location_ids, all_clients, before, after, reason, approval_ref')
    .eq('org_id', actor.orgId)
    .order('seq', { ascending: false })
    .limit(limit + 1);
  if (q.member) query = query.contains('affected_membership_ids', [q.member]);
  if (q.client) query = query.or(`location_ids.cs.{${q.client}},all_clients.eq.true`);
  if (q.from) query = query.gte('at', new Date(q.from).toISOString());
  if (q.to) {
    const end = new Date(q.to);
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.to)) end.setUTCDate(end.getUTCDate() + 1); // inclusive day
    query = query.lt('at', end.toISOString());
  }
  if (q.before) query = query.lt('seq', q.before);
  if (q.group) {
    const g = LOG_EVENT_GROUPS.find((x) => x.key === q.group);
    if (g) {
      const ors = g.prefixes.map((p) => (p.endsWith('.') ? `event.like.${p}%` : `event.eq.${p}`)).join(',');
      query = query.or(ors);
    }
  }
  if (q.q) {
    const term = q.q.replace(/[%,()*]/g, ' ').trim();
    if (term) query = query.or(`event.ilike.%${term}%,reason.ilike.%${term}%`);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
  const rows = (data ?? []) as LogRow[];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  const [actors, members, locations] = await Promise.all([
    userNames(admin, actor.orgId, page.map((r) => r.actor_user_id).filter((x): x is string => !!x)),
    memberNames(admin, actor.orgId, page.flatMap((r) => r.affected_membership_ids ?? [])),
    locationNames(ctx.supabase, actor.orgId, page.flatMap((r) => r.location_ids ?? [])),
  ]);
  const subjectIds = page.filter((r) => r.subject_type === 'role' || r.subject_type === 'permission_set').map((r) => r.subject_id!);
  const subjectNames = new Map<string, string>();
  if (subjectIds.length) {
    const [roles, sets] = await Promise.all([
      ctx.supabase.schema('core').from('role_definitions').select('id, name').in('id', [...new Set(subjectIds)]),
      ctx.supabase.schema('core').from('permission_sets').select('id, name').in('id', [...new Set(subjectIds)]),
    ]);
    for (const r of [...((roles.data ?? []) as Array<{ id: string; name: string }>), ...((sets.data ?? []) as Array<{ id: string; name: string }>)]) {
      subjectNames.set(r.id, r.name);
    }
  }

  const entries: AccessLogEntry[] = page.map((r) => {
    const affectedNames = (r.affected_membership_ids ?? []).map((m) => members.get(m) ?? 'Former member');
    return {
      id: r.id,
      seq: Number(r.seq),
      at: r.at,
      event: r.event,
      source: r.source,
      actorContext: r.actor_context,
      actorUserId: r.actor_user_id,
      actorName: r.actor_user_id ? actors.get(r.actor_user_id) ?? 'Former member' : null,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      affectedMembershipIds: r.affected_membership_ids ?? [],
      affectedNames,
      locationIds: r.location_ids ?? [],
      locationNames: (r.location_ids ?? []).map((l) => locations.get(l) ?? 'Removed client'),
      allClients: r.all_clients,
      before: r.before,
      after: r.after,
      reason: r.reason,
      approvalRef: r.approval_ref,
      summary: describeLogEntry({
        event: r.event,
        before: r.before,
        after: r.after,
        affectedNames,
        subjectName: r.subject_id ? subjectNames.get(r.subject_id) ?? null : null,
      }),
    };
  });

  if (q.format === 'csv') {
    await admin.schema('core').rpc('access_log_append', {
      p_org: actor.orgId,
      p_actor: actor.userId,
      p_event: 'log.export',
      p_subject_type: 'export',
      p_subject_id: null,
      p_affected: q.member ? [q.member] : [],
      p_locations: q.client ? [q.client] : [],
      p_after: { rows: entries.length, filters: { member: q.member ?? null, client: q.client ?? null, group: q.group ?? null, from: q.from ?? null, to: q.to ?? null } },
      p_reason: 'Access log exported',
      p_ip: requestIp(),
    });
    const csv = toCsv(
      ['When (UTC)', 'What happened', 'Event', 'By', 'People affected', 'Clients', 'All clients', 'Reason', 'Source', 'Approval reference', 'Before', 'After'],
      entries.map((e) => [
        e.at,
        e.summary,
        e.event,
        e.actorName ?? (e.actorContext.startsWith('system') ? 'MeritBooks (automatic)' : ''),
        e.affectedNames.join('; '),
        e.locationNames.join('; '),
        e.allClients ? 'yes' : 'no',
        e.reason,
        e.source,
        e.approvalRef,
        e.before ? JSON.stringify(e.before) : '',
        e.after ? JSON.stringify(e.after) : '',
      ]),
    );
    const stamp = new Date().toISOString().slice(0, 10);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="access-log-${stamp}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  return NextResponse.json({
    data: {
      entries,
      nextCursor: hasMore ? entries[entries.length - 1]?.seq ?? null : null,
    },
  });
});
