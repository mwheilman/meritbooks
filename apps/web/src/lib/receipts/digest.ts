/**
 * Weekly digest to the bookkeeper (FPB-workforce-app §15.2): outstanding receipts by
 * person, oldest first. One in-app notification (deduped per ISO week) and, when the
 * notification is new, one email in the Merit style. Recipients: each client's
 * bookkeeper from the receipt policy (tenant row as the default), else the tenant admins.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { formatMoney } from '@meritbooks/shared';
import { esc } from '@/lib/notify/request-email';
import type { EmailChannel } from '@/lib/notify/channels';
import { createNotification, tenantAdminMemberships } from '@/lib/notify/in-app';
import { listOutstanding, type OutstandingGroup } from './bookkeeper';
import { loadReceiptPolicyContext, mergeReceiptPolicy } from './policy';

/** ISO week key "2026-W43". Pure. */
export function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86_400_000 + 1) / 7);
  return `${y}-W${String(week).padStart(2, '0')}`;
}

export interface DigestContent {
  title: string;
  body: string;
  subject: string;
  html: string;
  text: string;
}

/** Build the digest from grouped outstanding receipts. Pure. */
export function buildDigest(groups: ReadonlyArray<OutstandingGroup>, tenantName: string, appUrl: string): DigestContent | null {
  const people = groups.filter((g) => g.count > 0);
  if (people.length === 0) return null;
  const count = people.reduce((n, g) => n + g.count, 0);
  const total = people.reduce((n, g) => n + g.totalCents, 0);
  const title = `${count} receipt${count === 1 ? '' : 's'} outstanding · ${formatMoney(total)}`;
  const top = people.slice(0, 8);
  const lines = top.map((g) => `${g.holderName}: ${g.count} · ${formatMoney(g.totalCents)} · oldest ${g.oldestDays} d`);
  const body = lines.slice(0, 3).join(' // ') + (people.length > 3 ? ` // +${people.length - 3} more` : '');
  const link = `${appUrl.replace(/\/$/, '')}/receipts`;
  const rows = top
    .map(
      (g) =>
        `<tr><td style="padding:8px 0;border-bottom:1px solid #E4E1DA;">${esc(g.holderName)}</td><td style="padding:8px 0;border-bottom:1px solid #E4E1DA;text-align:right;font-variant-numeric:tabular-nums;">${g.count}</td><td style="padding:8px 0;border-bottom:1px solid #E4E1DA;text-align:right;font-variant-numeric:tabular-nums;">${esc(formatMoney(g.totalCents))}</td><td style="padding:8px 0;border-bottom:1px solid #E4E1DA;text-align:right;font-variant-numeric:tabular-nums;">${g.oldestDays} d</td></tr>`,
    )
    .join('');
  const html = `<!doctype html><html lang="en"><body style="margin:0;background:#F5F3EF;font-family:'DM Sans',-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#0A1628;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px;"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#FDFCFA;border:1px solid #E4E1DA;">
<tr><td style="background:#0A1628;padding:18px 28px;"><div style="color:#fff;font-size:16px;font-weight:700;">${esc(tenantName)}</div>
<div style="color:#3B82F6;font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;margin-top:4px;">Receipts <span style="color:#8494A7">//</span> weekly</div></td></tr>
<tr><td style="height:2px;background:#2563EB;line-height:2px;font-size:0;">&nbsp;</td></tr>
<tr><td style="padding:24px 28px 8px;"><div style="font-size:20px;font-weight:700;">${esc(title)}</div>
<div style="font-size:14px;color:#3D4F65;margin-top:6px;">Who still owes a receipt, oldest first. Reminders keep going on their schedule.</div></td></tr>
<tr><td style="padding:8px 28px 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">
<tr><th align="left" style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#3D4F65;padding-bottom:6px;">Cardholder</th><th align="right" style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#3D4F65;">Owed</th><th align="right" style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#3D4F65;">Amount</th><th align="right" style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#3D4F65;">Oldest</th></tr>
${rows}</table></td></tr>
<tr><td style="padding:16px 28px 28px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#2563EB;"><a href="${esc(link)}" style="display:inline-block;padding:12px 24px;color:#fff;font-weight:700;text-decoration:none;">Open receipts</a></td></tr></table></td></tr>
</table></td></tr></table></body></html>`;
  const text = [title, '', ...lines, people.length > top.length ? `+${people.length - top.length} more` : '', '', `Open receipts: ${link}`].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
  return { title, body, subject: `${tenantName}: ${title}`.slice(0, 180), html, text };
}

export interface DigestDeps {
  db: SupabaseClient;
  email: EmailChannel;
  now: () => Date;
  appUrl: string;
}

export interface DigestSummary {
  recipients: number;
  notified: number;
  emailed: number;
  outstanding: number;
  skipped: string | null;
}

async function memberEmail(db: SupabaseClient, orgId: string, membershipId: string): Promise<string | null> {
  const { data: m } = await db.schema('core').from('memberships').select('user_id').eq('org_id', orgId).eq('id', membershipId).eq('status', 'active').maybeSingle();
  const uid = (m as { user_id?: string } | null)?.user_id;
  if (!uid) return null;
  const { data: u } = await db.schema('core').from('users').select('email').eq('id', uid).maybeSingle();
  return (u as { email?: string | null } | null)?.email ?? null;
}

/** Send this week's digest for one tenant. Idempotent per ISO week per recipient. */
export async function sendWeeklyReceiptDigest(deps: DigestDeps, orgId: string): Promise<DigestSummary> {
  const now = deps.now();
  const ctx = await loadReceiptPolicyContext(deps.db, orgId);
  const tenantPolicy = mergeReceiptPolicy(ctx.rows, null);
  if (!tenantPolicy.digestEnabled) return { recipients: 0, notified: 0, emailed: 0, outstanding: 0, skipped: 'Digest is turned off.' };
  const { data: org } = await deps.db.schema('core').from('organizations').select('name').eq('id', orgId).maybeSingle();
  const tenantName = (org as { name?: string } | null)?.name ?? 'Your books';

  // Recipient → the companies they watch (null = every company).
  const scopes = new Map<string, Set<string> | null>();
  const clientRows = ctx.rows.filter((r) => r.location_id && r.bookkeeper_membership_id);
  for (const r of clientRows) {
    const set = scopes.get(r.bookkeeper_membership_id as string);
    if (set === null) continue;
    scopes.set(r.bookkeeper_membership_id as string, (set ?? new Set<string>()).add(r.location_id as string));
  }
  if (tenantPolicy.bookkeeperMembershipId) scopes.set(tenantPolicy.bookkeeperMembershipId, null);
  if (scopes.size === 0) for (const m of await tenantAdminMemberships(deps.db, orgId)) scopes.set(m, null);

  const { groups: all, strip } = await listOutstanding(deps.db, orgId, { now });
  const week = isoWeekKey(now);
  const summary: DigestSummary = { recipients: scopes.size, notified: 0, emailed: 0, outstanding: strip.outstanding, skipped: null };
  if (strip.outstanding === 0) return { ...summary, skipped: 'Nothing outstanding.' };

  for (const [membershipId, locs] of scopes) {
    const groups = locs
      ? all
          .map((g) => {
            const charges = g.charges.filter((c) => locs.has(c.locationId));
            return { ...g, charges, count: charges.length, totalCents: charges.reduce((n, c) => n + c.amountCents, 0), oldestDays: charges.reduce((n, c) => Math.max(n, c.ageDays), 0) };
          })
          .filter((g) => g.count > 0)
      : all;
    const content = buildDigest(groups, tenantName, deps.appUrl);
    if (!content) continue;
    const made = await createNotification(deps.db, {
      orgId,
      membershipId,
      kind: 'receipts.digest',
      severity: 'info',
      title: content.title,
      body: content.body,
      deepLink: '/receipts',
      dedupeKey: `receipts.digest:${week}`,
    });
    if (made !== 'created') continue;
    summary.notified++;
    const to = await memberEmail(deps.db, orgId, membershipId);
    if (to) {
      const out = await deps.email.send({ to, subject: content.subject, html: content.html, text: content.text });
      if (out.status === 'sent') summary.emailed++;
    }
  }
  return summary;
}
