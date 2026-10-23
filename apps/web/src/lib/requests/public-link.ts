/**
 * The public side of a request's magic link (`/r/[token]`, `/r/[token]/unsubscribe`).
 *
 * No login; the token IS the credential, resolved by sha256 with the service role. A
 * bad / expired / closed link reveals nothing about the tenant. What the visitor sees is
 * only what was in their own email: the asking client's name, the title, the message.
 * Every lookup is rate-limited per token and per IP by the caller.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { recordOnce, recordEvent } from './events';
import { resolveRequestToken } from './tokens';
import { vendorPortalPathFor } from './vendor-compliance';
import { KIND_LABEL, type RequestKind } from './types';
import { notifyMembers, tenantAdminMemberships } from '@/lib/notify/in-app';

export interface LandingView {
  senderName: string;
  kind: RequestKind;
  kindLabel: string;
  title: string;
  message: string | null;
  dueDate: string | null;
  recipientEmail: string | null;
  unsubscribed: boolean;
}

export type OpenResult =
  | { state: 'redirect'; to: string }
  | { state: 'landing'; view: LandingView }
  | { state: 'invalid'; reason: 'not_found' | 'expired' | 'closed' };

async function senderFor(admin: SupabaseClient, orgId: string, locationId: string | null): Promise<string> {
  if (locationId) {
    const { data } = await admin.schema('core').from('locations').select('name').eq('id', locationId).eq('org_id', orgId).maybeSingle();
    const n = (data as { name?: string } | null)?.name;
    if (n) return n;
  }
  const { data } = await admin.schema('core').from('organizations').select('name').eq('id', orgId).maybeSingle();
  return (data as { name?: string } | null)?.name ?? 'Your accounting team';
}

/** Open a link: record the (first) click, then forward to the portal or show the landing. */
export async function openRequestLink(admin: SupabaseClient, token: string, now: Date = new Date()): Promise<OpenResult> {
  const res = await resolveRequestToken(admin, token, now);
  if (!res.ok) return { state: 'invalid', reason: res.state };
  const r = res.request;
  await recordOnce(admin, r, `click:${res.tokenId}`, { event_type: 'clicked', actor: 'recipient', detail: 'Opened the link.' }, now).catch(() => false);
  await admin.schema('core').from('request_tokens').update({ last_used_at: now.toISOString() }).eq('id', res.tokenId).eq('org_id', r.org_id);

  if (r.kind === 'w9' || r.kind === 'coi') {
    const to = await vendorPortalPathFor(admin, r.org_id, r.meta ?? {});
    if (to) return { state: 'redirect', to };
  }
  return {
    state: 'landing',
    view: {
      senderName: await senderFor(admin, r.org_id, r.location_id),
      kind: r.kind,
      kindLabel: KIND_LABEL[r.kind],
      title: r.title,
      message: r.message,
      dueDate: r.due_date,
      recipientEmail: r.recipient_email,
      unsubscribed: !!r.unsubscribed_at,
    },
  };
}

/** Unsubscribe the recipient's email address from this tenant's requests (POST only). */
export async function unsubscribeByToken(admin: SupabaseClient, token: string, now: Date = new Date()): Promise<'done' | 'invalid'> {
  const res = await resolveRequestToken(admin, token, now);
  if (!res.ok) return 'invalid';
  const r = res.request;
  const addr = r.recipient_email?.toLowerCase();
  if (addr) {
    const { error } = await admin
      .schema('core')
      .from('request_suppressions')
      .insert({ org_id: r.org_id, location_id: r.location_id, channel: 'email', address: addr, reason: 'unsubscribe', source_request_id: r.id });
    if (error && !/duplicate|unique/i.test(error.message)) throw new Error(`Could not record the unsubscribe: ${error.message}`);
  }
  await admin.schema('core').from('requests').update({ unsubscribed_at: now.toISOString(), updated_at: now.toISOString() }).eq('id', r.id).eq('org_id', r.org_id);
  await recordEvent(admin, r, { event_type: 'unsubscribed', channel: 'email', actor: 'recipient', detail: 'The recipient stopped these emails.' }, now);
  await notifyMembers(admin, r.owner_membership_id ? [r.owner_membership_id] : await tenantAdminMemberships(admin, r.org_id), {
    orgId: r.org_id,
    locationId: r.location_id,
    kind: 'request.unsubscribed',
    severity: 'attention',
    title: `${r.recipient_name ?? r.recipient_email ?? 'A recipient'} stopped request emails`.slice(0, 200),
    body: `No more emails will go to ${r.recipient_email ?? 'them'} for "${r.title}". Follow up another way.`,
    deepLink: `/requests?id=${r.id}`,
    requestId: r.id,
    dedupeKey: `unsubscribed:${r.id}`,
  });
  return 'done';
}
