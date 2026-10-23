/**
 * Outbound email quotas for mail the app sends on a member's behalf (security review,
 * Wave 1): request emails and invoice send / remind, where the member can type the
 * recipients. Without a cap, one compromised or careless account could use the tenant's
 * verified sending domain to mail thousands of arbitrary addresses.
 *
 * Two fixed windows, both DB-backed (core.outbound_send_counters, migration 178 §10) so
 * they hold across serverless instances:
 *   • per user, per clock hour  — SEND_QUOTA.perUserPerHour recipients
 *   • per org,  per UTC day     — SEND_QUOTA.perOrgPerDay  recipients
 * A send counts one per recipient (To + Cc + Bcc), so a 20-address Cc list costs 20.
 * Both counters are bumped atomically (core.bump_send_quota) BEFORE the provider is
 * called; the send is refused when either is over its limit.
 *
 * Fails CLOSED: if the counter cannot be read the send is refused with a retry message
 * (an outage must not become an unmetered send path). Scheduled sends the system makes
 * on its own cadence (recurring invoices, the request dispatcher) are not metered here —
 * they are bounded by their own cadence and max-sends settings.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceWriter } from '@/lib/db/scoped-writer';

export const SEND_QUOTA = {
  /** Recipients one member may email per clock hour. */
  perUserPerHour: 200,
  /** Recipients one organization may email per UTC day (all members together). */
  perOrgPerDay: 2000,
} as const;

export type SendChannel = 'invoice_send' | 'invoice_remind' | 'request';

export type SendQuotaResult =
  | { ok: true; userCount: number; orgCount: number }
  | { ok: false; status: 429 | 503; code: 'SEND_QUOTA_USER' | 'SEND_QUOTA_ORG' | 'SEND_QUOTA_UNAVAILABLE'; error: string; retryAfterSec: number };

export interface SendQuotaOptions {
  /** Service-role client (tests inject the PGlite one). */
  writer?: SupabaseClient | null;
  /** Clock (tests). */
  now?: () => Date;
  /** Limits override (tests). */
  limits?: { perUserPerHour: number; perOrgPerDay: number };
}

function hourStart(d: Date): Date {
  const x = new Date(d);
  x.setUTCMinutes(0, 0, 0);
  return x;
}

function dayStart(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

async function bump(w: SupabaseClient, orgId: string, scope: 'user_hour' | 'org_day', key: string, windowStart: Date, inc: number): Promise<number | null> {
  const { data, error } = await w.schema('core').rpc('bump_send_quota', {
    p_org: orgId,
    p_scope: scope,
    p_key: key.slice(0, 200),
    p_window_start: windowStart.toISOString(),
    p_inc: inc,
  });
  if (error) return null;
  const n = Number(data);
  return Number.isFinite(n) ? n : null;
}

/**
 * Charge `recipients` outbound recipients to the user's hourly and the org's daily quota.
 * Returns ok, or a refusal the route maps to HTTP (429 over quota / 503 counter down).
 */
export async function consumeSendQuota(
  orgId: string,
  userId: string,
  recipients: number,
  _channel: SendChannel,
  opts: SendQuotaOptions = {},
): Promise<SendQuotaResult> {
  const limits = opts.limits ?? SEND_QUOTA;
  const now = (opts.now ?? (() => new Date()))();
  const inc = Math.max(1, Math.floor(recipients));
  const w = serviceWriter(opts.writer);

  const hour = hourStart(now);
  const day = dayStart(now);
  const [userCount, orgCount] = await Promise.all([
    bump(w, orgId, 'user_hour', userId, hour, inc),
    bump(w, orgId, 'org_day', 'org', day, inc),
  ]);
  if (userCount === null || orgCount === null) {
    return {
      ok: false, status: 503, code: 'SEND_QUOTA_UNAVAILABLE', retryAfterSec: 60,
      error: 'We could not check your sending limit just now, so nothing was sent. Try again in a minute.',
    };
  }
  if (userCount > limits.perUserPerHour) {
    const retry = Math.max(1, Math.ceil((hour.getTime() + 3_600_000 - now.getTime()) / 1000));
    return {
      ok: false, status: 429, code: 'SEND_QUOTA_USER', retryAfterSec: retry,
      error: `You have reached the limit of ${limits.perUserPerHour} emailed recipients per hour. Nothing was sent; try again in ${Math.ceil(retry / 60)} minutes.`,
    };
  }
  if (orgCount > limits.perOrgPerDay) {
    const retry = Math.max(1, Math.ceil((day.getTime() + 86_400_000 - now.getTime()) / 1000));
    return {
      ok: false, status: 429, code: 'SEND_QUOTA_ORG', retryAfterSec: retry,
      error: `Your organization has reached its limit of ${limits.perOrgPerDay} emailed recipients today. Nothing was sent; the limit resets at midnight UTC.`,
    };
  }
  return { ok: true, userCount, orgCount };
}
