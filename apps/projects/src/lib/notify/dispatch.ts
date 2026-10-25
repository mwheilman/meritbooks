/**
 * The notification worker (one pass): sweeps (speed-to-lead), then the outbound queue
 * (core.notify_outbound_claim → provider → core.notify_outbound_result), then digests
 * (core.notify_digest_collect → email → core.notify_digest_done). Every step is idempotent in
 * the database (claims, dispatch keys, digest periods), so an overlapping or repeated run never
 * double-sends. Pure orchestration over injected ports — tests drive it with fakes.
 */
import { buildDigestEmail, buildNotificationEmail, type DigestSourceItem } from './digest';
import type { EmailSender } from './email';
import type { PushSender } from './push';
import type { SmsSender } from './sms';
import type { SendOutcome } from './types';

export interface ClaimedRow {
  id: string;
  org_id: string;
  channel: 'email' | 'sms' | 'push';
  audience: 'internal' | 'customer';
  membership_id: string | null;
  to_address: string | null;
  subject: string | null;
  body: string;
  deep_link: string | null;
  data: Record<string, unknown> | null;
  attempts: number;
  push_tokens: string[] | null;
  sms_from: string | null;
}

export interface DigestRow {
  digest_id: string;
  org_id: string;
  org_name: string | null;
  membership_id: string;
  email: string;
  first_name: string | null;
  cadence: 'daily' | 'weekly';
  items: DigestSourceItem[];
}

/** The database side of the worker (service role, core schema RPCs only). */
export interface WorkerPort {
  sweep(now: Date): Promise<number>;
  claim(limit: number): Promise<ClaimedRow[]>;
  result(id: string, outcome: SendOutcome): Promise<void>;
  revokeToken(token: string, reason: string): Promise<void>;
  orgNames(ids: readonly string[]): Promise<Map<string, string>>;
  collectDigests(now: Date): Promise<DigestRow[]>;
  digestDone(id: string, ok: boolean, providerMessageId: string | null, error: string | null): Promise<void>;
}

export interface WorkerDeps {
  port: WorkerPort;
  email: EmailSender;
  sms: SmsSender;
  push: PushSender;
  appUrl: string;
  now?: Date;
  /** Max outbound rows per pass. */
  limit?: number;
}

export interface WorkerSummary {
  swept: number;
  claimed: number;
  sent: number;
  failed: number;
  skipped: number;
  digestsSent: number;
  digestsFailed: number;
  revokedTokens: number;
  notConfigured: string[];
}

async function sendOne(row: ClaimedRow, deps: WorkerDeps, tenant: string, summary: WorkerSummary): Promise<SendOutcome> {
  if (row.channel === 'push') {
    const r = await deps.push.send({
      tokens: row.push_tokens ?? [],
      title: row.subject ?? 'Merit Projects',
      body: row.body,
      deepLink: row.deep_link,
      data: { ...(row.data ?? {}), outboundId: row.id },
    });
    for (const t of r.deadTokens) {
      await deps.port.revokeToken(t, 'DeviceNotRegistered');
      summary.revokedTokens += 1;
    }
    return r.outcome;
  }
  if (row.channel === 'sms') {
    if (!row.to_address) return { status: 'failed', provider: 'twilio', reason: 'No number on the message.', retry: false };
    return deps.sms.send({ to: row.to_address, body: row.body, from: row.sms_from });
  }
  if (!row.to_address) return { status: 'failed', provider: 'resend', reason: 'No address on the message.', retry: false };
  if (row.audience === 'customer') {
    const text = row.body;
    const html = buildNotificationEmail({ tenantName: tenant, title: row.subject ?? tenant, body: row.body, deepLink: null, appUrl: deps.appUrl }).html;
    return deps.email.send({ to: row.to_address, subject: row.subject ?? tenant, html, text });
  }
  const mail = buildNotificationEmail({ tenantName: tenant, title: row.subject ?? 'Notification', body: row.body, deepLink: row.deep_link, appUrl: deps.appUrl });
  return deps.email.send({ to: row.to_address, subject: mail.subject, html: mail.html, text: mail.text });
}

export async function runNotificationWorker(deps: WorkerDeps): Promise<WorkerSummary> {
  const now = deps.now ?? new Date();
  const summary: WorkerSummary = { swept: 0, claimed: 0, sent: 0, failed: 0, skipped: 0, digestsSent: 0, digestsFailed: 0, revokedTokens: 0, notConfigured: [] };
  const notConfigured = new Set<string>();

  summary.swept = await deps.port.sweep(now);

  const rows = await deps.port.claim(deps.limit ?? 200);
  summary.claimed = rows.length;
  const names = await deps.port.orgNames([...new Set(rows.map((r) => r.org_id))]);
  for (const row of rows) {
    const outcome = await sendOne(row, deps, names.get(row.org_id) ?? 'Merit Projects', summary).catch(
      (e: unknown): SendOutcome => ({ status: 'failed', provider: row.channel, reason: e instanceof Error ? e.message : 'send failed', retry: true }),
    );
    if (outcome.status === 'sent') summary.sent += 1;
    else if (outcome.status === 'failed') summary.failed += 1;
    else {
      summary.skipped += 1;
      notConfigured.add(outcome.reason);
    }
    await deps.port.result(row.id, outcome);
  }

  const digests = await deps.port.collectDigests(now);
  for (const d of digests) {
    const mail = buildDigestEmail({ tenantName: d.org_name ?? 'Merit Projects', firstName: d.first_name, cadence: d.cadence, items: d.items, appUrl: deps.appUrl });
    const out = await deps.email.send({ to: d.email, subject: mail.subject, html: mail.html, text: mail.text });
    if (out.status === 'sent') {
      summary.digestsSent += 1;
      await deps.port.digestDone(d.digest_id, true, out.providerMessageId, null);
    } else {
      summary.digestsFailed += 1;
      if (out.status === 'not_configured') notConfigured.add(out.reason);
      await deps.port.digestDone(d.digest_id, false, null, out.reason);
    }
  }
  summary.notConfigured = [...notConfigured];
  return summary;
}

/** The SendOutcome → core.notify_outbound_result arguments. */
export function resultArgs(id: string, o: SendOutcome): { p_id: string; p_status: 'sent' | 'failed' | 'skipped'; p_provider: string | null; p_provider_message_id: string | null; p_error: string | null; p_retry: boolean } {
  if (o.status === 'sent') return { p_id: id, p_status: 'sent', p_provider: o.provider, p_provider_message_id: o.providerMessageId, p_error: null, p_retry: false };
  if (o.status === 'failed') return { p_id: id, p_status: 'failed', p_provider: o.provider, p_provider_message_id: null, p_error: o.reason, p_retry: o.retry };
  return { p_id: id, p_status: 'skipped', p_provider: null, p_provider_message_id: null, p_error: o.reason, p_retry: false };
}
