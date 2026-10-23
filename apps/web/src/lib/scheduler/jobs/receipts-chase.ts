/**
 * Receipt chase jobs (FPB-workforce-app §15.2, Wave 2B).
 *
 *   receipts.chase_sync     every 15 min, per tenant: card charges → receipt_charge_states;
 *                           one `receipt` request per needed charge (the request engine's
 *                           `requests.remind` sends it); pauses requests when chase is off /
 *                           opted out; re-tries auto-matching receipts still unmatched.
 *   receipts.weekly_digest  Monday 14:00 UTC (≈ 08:00–09:00 US Central): outstanding
 *                           receipts by person to the bookkeeper (in-app + email).
 *
 * Neither touches the GL. TENANCY: service role with every read and write pinned to
 * ctx.orgId (like the request engine and the event drains).
 *
 * REGISTRATION (2E owns lib/scheduler/registry.ts): add RECEIPTS_CHASE_SYNC_JOB and
 * RECEIPTS_DIGEST_JOB to the registry list.
 */

import { emailChannel, outboundAppUrl } from '@/lib/notify/channels';
import { syncReceiptChase } from '@/lib/receipts/chase';
import { sendWeeklyReceiptDigest } from '@/lib/receipts/digest';
import { autoMatchReceipt } from '@/lib/receipts/match';
import { loadReceiptPolicyContext, mergeReceiptPolicy } from '@/lib/receipts/policy';
import { SYSTEM_ACTOR } from '@/lib/receipts/types';
import type { JobContext, JobDefinition, JobResult } from '../types';

/** Re-try matching receipts that arrived before their charge posted (cards post 1–3 days late). */
async function rematchUnmatched(ctx: JobContext, orgId: string): Promise<{ matched: number; suggested: number }> {
  const db = ctx.admin;
  const since = new Date(ctx.now.getTime() - 30 * 86_400_000).toISOString();
  const { data } = await db
    .from('receipts')
    .select('id, location_id, vendor_name, amount_cents, receipt_date, card_assignment_id, bank_transaction_id')
    .eq('org_id', orgId)
    .eq('match_status', 'unmatched')
    .is('bank_transaction_id', null)
    .gte('submitted_at', since)
    .limit(200);
  const rows = (data ?? []) as Array<{ id: string; location_id: string; vendor_name: string | null; amount_cents: number | null; receipt_date: string | null; card_assignment_id: string | null; bank_transaction_id: string | null }>;
  if (rows.length === 0) return { matched: 0, suggested: 0 };
  const pctx = await loadReceiptPolicyContext(db, orgId);
  let matched = 0;
  let suggested = 0;
  for (const r of rows) {
    if (ctx.signal.aborted) break;
    try {
      const out = await autoMatchReceipt(db, orgId, r, mergeReceiptPolicy(pctx.rows, r.location_id), ctx.now, SYSTEM_ACTOR);
      if (out.kind === 'matched') matched++;
      else if (out.kind === 'suggested') suggested++;
    } catch {
      // one bad row never stops the sweep
    }
  }
  return { matched, suggested };
}

export async function runReceiptsChaseSyncJob(ctx: JobContext): Promise<JobResult> {
  if (!ctx.orgId) return { status: 'skipped', summary: 'This job runs per tenant.' };
  const orgId = ctx.orgId;
  let s;
  try {
    s = await syncReceiptChase({ db: ctx.admin, now: () => ctx.now }, orgId, { signal: ctx.signal });
  } catch (e) {
    return { status: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
  let rm = { matched: 0, suggested: 0 };
  try {
    rm = await rematchUnmatched(ctx, orgId);
  } catch (e) {
    s.errors.push(`rematch: ${e instanceof Error ? e.message : String(e)}`);
  }
  const worked = s.created + s.cancelled + rm.matched + rm.suggested;
  const status: JobResult['status'] = s.errors.length === 0 ? (s.charges === 0 && worked === 0 ? 'skipped' : 'ok') : worked > 0 ? 'partial' : 'failed';
  return {
    status,
    itemsProcessed: s.charges,
    counts: {
      charges: s.charges,
      requests_opened: s.created,
      requests_paused: s.cancelled,
      outstanding: s.needed,
      no_cardholder: s.noCardholder,
      chase_off: s.chaseOff,
      matched: s.matched,
      rematched: rm.matched,
      suggested: rm.suggested,
    },
    summary:
      s.charges === 0
        ? 'No card charges in the chase window.'
        : `${s.needed} charge(s) owe a receipt (${s.created} newly asked), ${s.noCardholder} without a cardholder, ${rm.matched} late receipt(s) matched.`,
    error: s.errors.length ? s.errors.slice(0, 10).join('; ') : undefined,
  };
}

export async function runReceiptsDigestJob(ctx: JobContext): Promise<JobResult> {
  if (!ctx.orgId) return { status: 'skipped', summary: 'This job runs per tenant.' };
  try {
    const r = await sendWeeklyReceiptDigest({ db: ctx.admin, email: emailChannel(), now: () => ctx.now, appUrl: outboundAppUrl() }, ctx.orgId);
    if (r.skipped) return { status: 'skipped', summary: r.skipped, counts: { outstanding: r.outstanding } };
    return {
      status: 'ok',
      itemsProcessed: r.recipients,
      counts: { recipients: r.recipients, notified: r.notified, emailed: r.emailed, outstanding: r.outstanding },
      summary: `Digest to ${r.notified} bookkeeper(s) (${r.emailed} emailed): ${r.outstanding} receipt(s) outstanding.`,
    };
  } catch (e) {
    return { status: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
}

export const RECEIPTS_CHASE_SYNC_JOB: JobDefinition = {
  key: 'receipts.chase_sync',
  label: 'Receipt chase',
  description:
    'Finds card charges that need a receipt, asks the cardholder through the request engine (email + in-app; first ask and quiet hours from Settings → Receipt chase), pauses asks when chase is off or the cardholder opted out, and re-matches late receipts. No GL effect.',
  scope: 'org',
  cron: '*/15 * * * *',
  defaultEnabled: true,
  implemented: true,
  ownerCapability: 'exp.receipts',
  owner: 'Receipts & Merit Workforce (FPB-workforce-app §15)',
  postsToGl: false,
  timeoutMs: 120_000,
  maxLatenessMinutes: 60,
  maxAttempts: 3,
  run: (ctx) => runReceiptsChaseSyncJob(ctx),
};

export const RECEIPTS_DIGEST_JOB: JobDefinition = {
  key: 'receipts.weekly_digest',
  label: 'Receipts weekly digest',
  description: 'Monday summary to the bookkeeper: who still owes receipts, how many, how much, oldest first. In-app + email.',
  scope: 'org',
  cron: '0 14 * * 1',
  defaultEnabled: true,
  implemented: true,
  ownerCapability: 'exp.receipts',
  owner: 'Receipts & Merit Workforce (FPB-workforce-app §15)',
  postsToGl: false,
  timeoutMs: 60_000,
  maxLatenessMinutes: 12 * 60,
  maxAttempts: 2,
  run: (ctx) => runReceiptsDigestJob(ctx),
};
