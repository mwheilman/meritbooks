/**
 * `notifications.digest` — daily / weekly digest emails (IA M-13; Wave 1 saved the
 * preference in core.notification_prefs but nothing sent it).
 *
 * Hourly, per tenant. A member gets a digest when ALL hold:
 *   • their prefs say digest 'daily' (any day) or 'weekly' (Mondays), and their channels
 *     include email;
 *   • it is 08:00–08:59 in THEIR time zone (prefs.timezone → org timezone → UTC) and that
 *     hour is not inside their quiet hours;
 *   • they have unread, not-yet-emailed notifications from the last 7 days (muted kinds
 *     excluded).
 * After the provider accepts the email the included notifications are stamped emailed_at,
 * so an item is emailed at most once (idempotent across reruns, DST shifts and retries).
 * 'instant' / 'off' members get nothing here (in-app only).
 *
 * TENANCY: notifications are member-own rows (RLS on membership), so — like the request
 * dispatcher — this runs on the service role with EVERY query pinned to ctx.orgId.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { emailChannel, outboundAppUrl, type EmailChannel } from '@/lib/notify/channels';
import { buildDigestEmail, type DigestItem } from '@/lib/notify/digest-email';
import { inQuietHours, quietHoursOf, resolveTimeZone, zonedParts } from '@/lib/requests/cadence';
import type { CountValue, JobContext, JobDefinition, JobResult } from '../types';

export const DIGEST_LOCAL_HOUR = 8;
const MAX_ITEMS = 25;
const LOOKBACK_DAYS = 7;

interface PrefRow {
  membership_id: string;
  channels: string[] | null;
  digest: string;
  quiet_start: string | null;
  quiet_end: string | null;
  timezone: string | null;
  muted_kinds: string[] | null;
}

export interface DigestDecisionInput {
  digest: string;
  channels: string[] | null;
  timezone: string;
  quietStart: string | null;
  quietEnd: string | null;
  now: Date;
}

/** Pure: is this member due a digest at `now`? */
export function digestDue(i: DigestDecisionInput): { due: boolean; cadence: 'daily' | 'weekly' | null; reason: string } {
  if (i.digest !== 'daily' && i.digest !== 'weekly') return { due: false, cadence: null, reason: 'not a digest subscriber' };
  if (!(i.channels ?? ['in_app', 'email']).includes('email')) return { due: false, cadence: null, reason: 'email channel off' };
  const p = zonedParts(i.now, i.timezone);
  if (p.hour !== DIGEST_LOCAL_HOUR) return { due: false, cadence: null, reason: 'not the digest hour' };
  if (i.digest === 'weekly' && p.weekday !== 1) return { due: false, cadence: null, reason: 'weekly digest goes on Mondays' };
  if (inQuietHours(i.now, quietHoursOf(i.quietStart, i.quietEnd), i.timezone)) return { due: false, cadence: null, reason: 'quiet hours' };
  return { due: true, cadence: i.digest, reason: 'due' };
}

async function memberContacts(admin: SupabaseClient, orgId: string, membershipIds: string[]): Promise<Map<string, { email: string | null; name: string | null }>> {
  const out = new Map<string, { email: string | null; name: string | null }>();
  if (membershipIds.length === 0) return out;
  const { data: ms } = await admin.schema('core').from('memberships').select('id, user_id, status').eq('org_id', orgId).in('id', membershipIds);
  const active = ((ms ?? []) as Array<{ id: string; user_id: string; status: string }>).filter((m) => m.status === 'active');
  const userIds = Array.from(new Set(active.map((m) => m.user_id)));
  if (userIds.length === 0) return out;
  const { data: us } = await admin.schema('core').from('users').select('id, email, first_name').in('id', userIds);
  const byUser = new Map(((us ?? []) as Array<{ id: string; email: string | null; first_name: string | null }>).map((u) => [u.id, u]));
  for (const m of active) {
    const u = byUser.get(m.user_id);
    out.set(m.id, { email: u?.email?.trim() || null, name: u?.first_name ?? null });
  }
  return out;
}

export async function runNotificationDigestJob(ctx: JobContext, overrides: { email?: EmailChannel; appUrl?: string } = {}): Promise<JobResult> {
  if (!ctx.orgId) return { status: 'skipped', summary: 'This job runs per tenant.' };
  const orgId = ctx.orgId;
  const admin = ctx.admin;

  const { data: prefData, error: prefErr } = await admin
    .schema('core')
    .from('notification_prefs')
    .select('membership_id, channels, digest, quiet_start, quiet_end, timezone, muted_kinds')
    .eq('org_id', orgId)
    .in('digest', ['daily', 'weekly']);
  if (prefErr) return { status: 'failed', error: `Could not read notification preferences: ${prefErr.message}` };
  const prefs = (prefData ?? []) as PrefRow[];
  if (prefs.length === 0) return { status: 'ok', itemsProcessed: 0, counts: { subscribers: 0 }, summary: 'Nobody in this tenant chose a daily or weekly digest.' };

  const { data: org } = await admin.schema('core').from('organizations').select('name, timezone').eq('id', orgId).maybeSingle();
  const orgRow = (org ?? {}) as { name?: string | null; timezone?: string | null };

  const due = prefs
    .map((p) => ({ p, d: digestDue({ digest: p.digest, channels: p.channels, timezone: resolveTimeZone(p.timezone, orgRow.timezone), quietStart: p.quiet_start, quietEnd: p.quiet_end, now: ctx.now }) }))
    .filter((x) => x.d.due);
  const counts: Record<string, CountValue> = { subscribers: prefs.length, due_now: due.length };
  if (due.length === 0) return { status: 'ok', itemsProcessed: 0, counts, summary: 'No digests are due this hour.' };

  const email = overrides.email ?? emailChannel();
  const appUrl = overrides.appUrl ?? outboundAppUrl();
  const contacts = await memberContacts(admin, orgId, due.map((x) => x.p.membership_id));
  const since = new Date(ctx.now.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString();

  let sent = 0;
  let empty = 0;
  let noEmail = 0;
  let notConfigured = 0;
  let items = 0;
  const failures: string[] = [];

  for (const { p, d } of due) {
    if (ctx.signal.aborted) break;
    const contact = contacts.get(p.membership_id);
    if (!contact?.email) {
      noEmail++;
      continue;
    }
    const { data: notes, error } = await admin
      .schema('core')
      .from('notifications')
      .select('id, kind, title, body, deep_link, severity, created_at')
      .eq('org_id', orgId)
      .eq('membership_id', p.membership_id)
      .is('read_at', null)
      .is('emailed_at', null)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) {
      failures.push(`${p.membership_id.slice(0, 8)}: ${error.message}`);
      continue;
    }
    const muted = new Set(p.muted_kinds ?? []);
    const rows = ((notes ?? []) as Array<{ id: string; kind: string; title: string; body: string | null; deep_link: string | null; severity: DigestItem['severity']; created_at: string }>).filter((r) => !muted.has(r.kind));
    if (rows.length === 0) {
      empty++;
      continue;
    }
    // Attention-first, then newest.
    rows.sort((a, b) => (a.severity === 'info' ? 1 : 0) - (b.severity === 'info' ? 1 : 0) || b.created_at.localeCompare(a.created_at));
    const shown = rows.slice(0, MAX_ITEMS);
    const mail = buildDigestEmail({
      tenantName: orgRow.name ?? 'MeritBooks',
      recipientName: contact.name,
      cadence: d.cadence as 'daily' | 'weekly',
      items: shown.map((r) => ({ title: r.title, body: r.body, deepLink: r.deep_link, severity: r.severity, createdAt: r.created_at })),
      appUrl,
      more: rows.length - shown.length,
    });
    const out = await email.send({ to: contact.email, subject: mail.subject, html: mail.html, text: mail.text });
    if (out.status === 'not_configured') {
      notConfigured++;
      break; // the same for every member — stop, and say so
    }
    if (out.status === 'failed') {
      failures.push(`${p.membership_id.slice(0, 8)}: ${out.reason}`);
      continue;
    }
    const { error: stampErr } = await admin
      .schema('core')
      .from('notifications')
      .update({ emailed_at: ctx.now.toISOString() })
      .eq('org_id', orgId)
      .eq('membership_id', p.membership_id)
      .in('id', rows.map((r) => r.id));
    if (stampErr) failures.push(`${p.membership_id.slice(0, 8)}: emailed but not stamped (${stampErr.message})`);
    sent++;
    items += rows.length;
  }

  Object.assign(counts, { sent, items, nothing_new: empty, no_email: noEmail, email_not_configured: notConfigured > 0, failed: failures.length });
  if (notConfigured > 0 && sent === 0) {
    return { status: 'skipped', itemsProcessed: 0, counts, summary: 'Email is not set up (RESEND_API_KEY / INVOICE_FROM_EMAIL), so no digests went out.' };
  }
  return {
    status: failures.length === 0 ? 'ok' : sent > 0 ? 'partial' : 'failed',
    itemsProcessed: sent,
    counts,
    summary: sent > 0 ? `Sent ${sent} digest email(s) covering ${items} notification(s).` : `${due.length} digest(s) due; nothing new to send.`,
    error: failures.length ? failures.slice(0, 10).join('; ') : undefined,
  };
}

export const NOTIFICATIONS_DIGEST_JOB: JobDefinition = {
  key: 'notifications.digest',
  label: 'Notification digests',
  description:
    'Hourly: at 8 a.m. in each person’s time zone, emails a digest of their unread notifications to everyone who chose a daily (or, on Mondays, weekly) digest — outside their quiet hours, each item at most once. No GL effect.',
  scope: 'org',
  cron: '5 * * * *',
  defaultEnabled: true,
  implemented: true,
  ownerCapability: 'home.workspace',
  owner: 'Notifications (IA M-13)',
  postsToGl: false,
  timeoutMs: 120_000,
  maxLatenessMinutes: 50,
  maxAttempts: 2,
  run: (ctx) => runNotificationDigestJob(ctx),
};
