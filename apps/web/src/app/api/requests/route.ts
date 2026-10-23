export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { emailConfigStatus } from '@/lib/email/provider';
import { membershipIdFor } from '@/lib/notify/in-app';
import { describeCadence } from '@/lib/requests/cadence';
import { loadPolicyContext } from '@/lib/requests/policy';
import { REQUESTS_VIEW, REQUESTS_WORK, requireAny } from '@/lib/requests/route-auth';
import { createRequest, RequestError } from '@/lib/requests/service';
import { createVendorDocRequest } from '@/lib/requests/vendor-compliance';
import type { RequestKind, RequestRow } from '@/lib/requests/types';
import { createRequestBody, requestListQuery } from '@/lib/validations/requests';
import { consumeSendQuota } from '@/lib/email/send-quota';

/**
 * /api/requests — the Requests screen (FPB-request-engine-notifications §5).
 *
 * GET  list (RLS-scoped read as the member: org + client scope enforced by the DB),
 *      with the strip counts and whether email is configured.
 * POST create a request. Writes go through the service role (core.requests is
 *      member-SELECT-only, migration 178) AFTER the permission check, with the org pinned
 *      from the session and every referenced row (client, vendor, member) first proven
 *      visible through the caller's own RLS client. A request that emails someone is metered
 *      against the member's / org's outbound quota (lib/email/send-quota) before it is made.
 */

/** Charge one outbound email to the quota when the request will email `address`. */
async function chargeQuota(orgId: string, userId: string, address: string | null | undefined, channels: string[] | undefined): Promise<NextResponse | null> {
  if (!address) return null;
  if (channels && !channels.includes('email')) return null;
  const q = await consumeSendQuota(orgId, userId, 1, 'request');
  if (q.ok) return null;
  return NextResponse.json({ error: q.error, code: q.code }, { status: q.status, headers: { 'Retry-After': String(q.retryAfterSec) } });
}

const LIST_COLS =
  'id, location_id, kind, subject_type, subject_id, title, recipient_type, recipient_name, recipient_email, channels, status, due_date, next_send_at, snoozed_until, sends_count, last_sent_at, escalated_at, bounced_at, unsubscribed_at, fulfilled_at, fulfilled_via, cancelled_at, cadence_anchor, cadence_offsets_minutes, repeat_every_minutes, max_sends, quiet_start, quiet_end, source, created_at, meta';

/** A search term safe inside a PostgREST or() list: no list / grouping syntax, LIKE wildcards escaped. */
function searchTerm(v: string): string {
  return v.replace(/[,()"'*]/g, ' ').replace(/[\\%_]/g, (m) => `\\${m}`).trim();
}

export const GET = apiQueryHandler(requestListQuery, async (raw, { userId, orgId, supabase }) => {
  const q = {
    ...raw,
    view: raw.view ?? 'live',
    band: raw.band ?? 'all',
    kind: raw.kind ? (raw.kind.split(',') as RequestKind[]) : undefined,
    q: raw.q?.trim() || undefined,
    limit: Math.min(200, Math.max(1, Number(raw.limit ?? 50))),
    offset: Math.min(100_000, Math.max(0, Number(raw.offset ?? 0))),
  };
  const guard = await requireAny(userId, REQUESTS_VIEW, '/api/requests');
  if (!guard.ok) return guard.response;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const now = new Date();
  const endOfDay = new Date(now.getTime() + 24 * 3_600_000).toISOString();
  let query = supabase.schema('core').from('requests').select(LIST_COLS, { count: 'exact' }).eq('org_id', orgId);
  if (q.view === 'live') query = query.in('status', ['open', 'sent', 'snoozed']);
  else if (q.view === 'closed') query = query.in('status', ['fulfilled', 'cancelled', 'expired']);
  if (q.view === 'live' && q.band === 'due') query = query.lte('next_send_at', endOfDay);
  if (q.view === 'live' && q.band === 'escalated') query = query.not('escalated_at', 'is', null);
  if (q.view === 'live' && q.band === 'undeliverable') {
    // one or() per query: with a client filter (which uses or()), bounced only
    query = q.location_id ? query.not('bounced_at', 'is', null) : query.or('bounced_at.not.is.null,unsubscribed_at.not.is.null');
  }
  if (q.kind?.length) query = query.in('kind', q.kind);
  const term = q.q ? searchTerm(q.q) : '';
  if (q.location_id) {
    // A client's requests plus the org-level ones (vendor W-9 / COI are org-level: one
    // vendor document covers every client that uses the vendor).
    query = query.or(`location_id.eq.${q.location_id},location_id.is.null`);
    if (term) query = query.ilike('title', `%${term}%`);
  } else if (term && q.band !== 'undeliverable') {
    query = query.or(`title.ilike.%${term}%,recipient_name.ilike.%${term}%,recipient_email.ilike.%${term}%`);
  } else if (term) {
    query = query.ilike('title', `%${term}%`);
  }
  query = q.view === 'live' ? query.order('next_send_at', { ascending: true, nullsFirst: false }) : query.order('updated_at', { ascending: false });
  const { data, error, count } = await query.range(q.offset, q.offset + q.limit - 1);
  if (error) return NextResponse.json({ error: error.message, code: 'QUERY_FAILED' }, { status: 500 });

  // Strip counts over every live request this member can see (RLS-scoped, head counts).
  const live = ['open', 'sent', 'snoozed'];
  const head = () => {
    const h = supabase.schema('core').from('requests').select('id', { count: 'exact', head: true }).eq('org_id', orgId).in('status', live);
    return q.location_id ? h.or(`location_id.eq.${q.location_id},location_id.is.null`) : h;
  };
  const [openC, dueC, escC, badC, kindsRes] = await Promise.all([
    head(),
    head().lte('next_send_at', endOfDay),
    head().not('escalated_at', 'is', null),
    q.location_id ? head().not('bounced_at', 'is', null) : head().or('bounced_at.not.is.null,unsubscribed_at.not.is.null'),
    (q.location_id
      ? supabase.schema('core').from('requests').select('kind').eq('org_id', orgId).in('status', live).or(`location_id.eq.${q.location_id},location_id.is.null`)
      : supabase.schema('core').from('requests').select('kind').eq('org_id', orgId).in('status', live)
    ).limit(5000),
  ]);
  const byKind: Partial<Record<RequestKind, number>> = {};
  for (const r of (kindsRes.data ?? []) as Array<{ kind: RequestKind }>) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;

  const rows = ((data ?? []) as unknown as RequestRow[]).map((r) => ({
    ...r,
    cadence_text: describeCadence({ offsetsMinutes: r.cadence_offsets_minutes, repeatEveryMinutes: r.repeat_every_minutes }, r.cadence_anchor),
    meta: undefined,
    has_portal_link: typeof r.meta?.vendor_portal_token_id === 'string',
  }));

  return NextResponse.json({
    rows,
    total: count ?? rows.length,
    strip: { open: openC.count ?? 0, dueSoon: dueC.count ?? 0, escalated: escC.count ?? 0, undeliverable: badC.count ?? 0, byKind },
    email: emailConfigStatus(),
  });
});

export const POST = apiHandler(createRequestBody, async (b, { userId, orgId, supabase }) => {
  const guard = await requireAny(userId, REQUESTS_WORK, '/api/requests');
  if (!guard.ok) return guard.response;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  // Prove every referenced row is visible to THIS member (RLS: org + client scope).
  if (b.location_id) {
    const { data: loc } = await supabase.schema('core').from('locations').select('id').eq('id', b.location_id).eq('org_id', orgId).maybeSingle();
    if (!loc) return NextResponse.json({ error: 'Client not found', code: 'NOT_FOUND' }, { status: 404 });
  }
  if (b.recipient_membership_id || b.escalate_to_membership_id) {
    const ids = [b.recipient_membership_id, b.escalate_to_membership_id].filter((x): x is string => !!x);
    const { data: ms } = await supabase.schema('core').from('memberships').select('id').eq('org_id', orgId).eq('status', 'active').in('id', ids);
    if ((ms ?? []).length !== new Set(ids).size) return NextResponse.json({ error: 'Team member not found', code: 'NOT_FOUND' }, { status: 404 });
  }

  const writer = serviceWriter();
  const deps = { db: writer, now: () => new Date() };
  const owner = await membershipIdFor(writer, orgId, userId);

  try {
    if (b.kind === 'w9' || b.kind === 'coi') {
      const { data: v } = await supabase.schema('core').from('vendors').select('id, name, display_name, email').eq('id', b.vendor_id!).eq('org_id', orgId).maybeSingle();
      if (!v) return NextResponse.json({ error: 'Vendor not found', code: 'NOT_FOUND' }, { status: 404 });
      const vendor = v as { id: string; name: string; display_name: string | null; email: string | null };
      const email = b.recipient_email ?? vendor.email;
      if (!email) return NextResponse.json({ error: `${vendor.display_name || vendor.name} has no email address. Add one (here or on the vendor) to send the request.`, code: 'NO_EMAIL' }, { status: 422 });
      const limited = await chargeQuota(orgId, userId, email, b.channels);
      if (limited) return limited;
      const ctx = await loadPolicyContext(writer, orgId);
      const docTypes = b.kind === 'w9' ? ['W9'] : ['GL_COI'];
      const res = await createVendorDocRequest(deps, ctx, {
        orgId,
        vendor: { id: vendor.id, name: vendor.display_name || vendor.name, email },
        need:
          b.kind === 'w9'
            ? { kind: 'w9', docTypes, renewal: false, dueDate: null }
            : { kind: 'coi', docTypes, renewal: !!b.renewal, dueDate: b.renewal ? b.due_date ?? null : null },
        createdBy: userId,
        ownerMembershipId: owner,
        source: 'manual',
      });
      return NextResponse.json({ request: res.request, created: res.created }, { status: res.created ? 201 : 200 });
    }

    // A teammate recipient: their email / name come from their user record (so the email
    // channel can reach them too), never from the client.
    let memberEmail: string | null = null;
    let memberName: string | null = null;
    if (b.recipient_type === 'member' && b.recipient_membership_id) {
      const { data: m } = await writer.schema('core').from('memberships').select('user_id').eq('id', b.recipient_membership_id).eq('org_id', orgId).maybeSingle();
      const uid = (m as { user_id?: string } | null)?.user_id;
      if (uid) {
        const { data: u } = await writer.schema('core').from('users').select('email, first_name, last_name').eq('id', uid).maybeSingle();
        const usr = u as { email?: string | null; first_name?: string | null; last_name?: string | null } | null;
        memberEmail = usr?.email ?? null;
        memberName = [usr?.first_name, usr?.last_name].filter(Boolean).join(' ') || null;
      }
    }

    const limited = await chargeQuota(orgId, userId, b.recipient_type === 'member' ? memberEmail : b.recipient_email ?? null, b.channels);
    if (limited) return limited;

    const res = await createRequest(deps, {
      orgId,
      locationId: b.location_id ?? null,
      kind: b.kind,
      title: b.title!,
      message: b.message ?? null,
      recipient: {
        type: b.recipient_type ?? 'email',
        membershipId: b.recipient_membership_id ?? null,
        name: memberName ?? b.recipient_name ?? null,
        email: b.recipient_type === 'member' ? memberEmail : b.recipient_email ?? null,
        timezone: b.recipient_timezone ?? null,
      },
      channels: b.channels,
      dueDate: b.due_date ?? null,
      escalateToMembershipId: b.escalate_to_membership_id ?? null,
      ownerMembershipId: owner,
      source: 'manual',
      createdBy: userId,
    });
    return NextResponse.json({ request: res.request, created: res.created }, { status: 201 });
  } catch (e) {
    if (e instanceof RequestError) return NextResponse.json({ error: e.message, code: 'REQUEST_INVALID' }, { status: e.status });
    throw e;
  }
});
