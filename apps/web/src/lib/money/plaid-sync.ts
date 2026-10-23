/**
 * Plaid: scheduled sync entry point + bank-feed health (FPB-payments-fees §17.5, audit BF-02/BF-03).
 *
 *   runPlaidSyncForOrg(adminDb, orgId)  — the one function the scheduler calls (the lead
 *                                         registers `bank.daily_pull` → runBankDailyPullJob).
 *   getBankFeedHealth(db, orgId)        — what the bank feed and cash screens show: the
 *                                         Plaid environment, last successful sync, and a
 *                                         stale / needs-attention verdict.
 *
 * The sync itself is the existing, idempotent syncAllPlaidItems (dedupe on the Plaid
 * transaction id, cursor per Item); nothing here posts to the GL.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { syncAllPlaidItems, type SyncSummary } from '@/lib/money/plaid-feed';
import { plaidMode, type PlaidMode } from '@/lib/money/payments-mode';
import type { JobContext, JobResult } from '@/lib/scheduler/types';

/** A feed is stale when no Item has synced for this long. */
export const STALE_AFTER_HOURS = 48;

/** Sync every Plaid Item of one tenant. Service-role client; scoped to `orgId`. */
export async function runPlaidSyncForOrg(adminDb: SupabaseClient, orgId: string): Promise<SyncSummary> {
  if (!orgId) throw new Error('runPlaidSyncForOrg needs an organization.');
  return syncAllPlaidItems(adminDb, orgId);
}

/** Scheduler adapter (JobDefinition.run) — register as `bank.daily_pull`. */
export async function runBankDailyPullJob(ctx: JobContext): Promise<JobResult> {
  if (!ctx.orgId) return { status: 'skipped', summary: 'This job runs per tenant.' };
  if (!plaidMode().configured) return { status: 'skipped', summary: 'Plaid is not configured on the server.' };
  const { count } = await ctx.admin.from('plaid_items').select('id', { count: 'exact', head: true }).eq('org_id', ctx.orgId);
  if (!count) return { status: 'skipped', summary: 'No bank is connected.' };
  try {
    const s = await runPlaidSyncForOrg(ctx.admin, ctx.orgId);
    const problems = s.errors.length + s.reauthNeeded.length;
    return {
      status: problems === 0 ? 'ok' : s.itemsSynced > 0 ? 'partial' : 'failed',
      itemsProcessed: s.itemsSynced,
      counts: {
        added: s.transactionsAdded,
        modified: s.transactionsModified,
        removed: s.transactionsRemoved,
        balances: s.balancesRefreshed,
        needs_relogin: s.reauthNeeded.length,
        errors: s.errors.length,
      },
      summary: `${s.transactionsAdded} new bank transaction${s.transactionsAdded === 1 ? '' : 's'} from ${s.itemsSynced} connection${s.itemsSynced === 1 ? '' : 's'}`
        + (s.reauthNeeded.length ? `; ${s.reauthNeeded.length} need${s.reauthNeeded.length === 1 ? 's' : ''} the bank login again` : '')
        + (s.errors.length ? `; ${s.errors.length} failed` : ''),
      error: problems > 0 && s.itemsSynced === 0 ? s.errors[0]?.message ?? 'Bank login needed' : undefined,
    };
  } catch (e) {
    return { status: 'failed', error: e instanceof Error ? e.message : 'Plaid sync failed' };
  }
}

// ── health ────────────────────────────────────────────────────────────────────

export type FeedVerdict = 'not_connected' | 'healthy' | 'stale' | 'attention';

export interface FeedItemHealth {
  id: string;
  institutionName: string | null;
  status: string;
  /** Plain-English problem, or null. */
  problem: string | null;
  lastSyncedAt: string | null;
  /** The environment the Item was linked in (test = Sandbox). */
  environment: 'test' | 'live' | null;
}

export interface BankFeedHealth {
  plaid: Pick<PlaidMode, 'label' | 'isLive' | 'configured' | 'warning'>;
  verdict: FeedVerdict;
  lastSyncedAt: string | null;
  hoursSinceSync: number | null;
  staleAfterHours: number;
  items: FeedItemHealth[];
  /** One sentence for the banner. */
  message: string;
}

interface ItemRow {
  id: string;
  institution_name: string | null;
  status: string;
  status_detail: string | null;
  last_synced_at: string | null;
  connection_id: string | null;
  location_id?: string | null;
}

function itemProblem(status: string): string | null {
  if (status === 'login_required') return 'The bank needs you to sign in again.';
  if (status === 'error') return 'The last sync failed.';
  if (status !== 'active') return 'This connection is not active.';
  return null;
}

/** Pure verdict from item rows (unit-tested). */
export function feedVerdict(
  items: ReadonlyArray<Pick<FeedItemHealth, 'status' | 'lastSyncedAt' | 'environment'>>,
  now: Date,
  currentEnv: 'test' | 'live',
): { verdict: FeedVerdict; lastSyncedAt: string | null; hoursSinceSync: number | null } {
  if (items.length === 0) return { verdict: 'not_connected', lastSyncedAt: null, hoursSinceSync: null };
  const last = items.map((i) => i.lastSyncedAt).filter((x): x is string => !!x).sort().pop() ?? null;
  const hours = last ? Math.floor((now.getTime() - new Date(last).getTime()) / 3_600_000) : null;
  const broken = items.some((i) => i.status !== 'active' || (i.environment !== null && i.environment !== currentEnv));
  if (broken) return { verdict: 'attention', lastSyncedAt: last, hoursSinceSync: hours };
  if (hours === null || hours >= STALE_AFTER_HOURS) return { verdict: 'stale', lastSyncedAt: last, hoursSinceSync: hours };
  return { verdict: 'healthy', lastSyncedAt: last, hoursSinceSync: hours };
}

function ago(hours: number | null): string {
  if (hours === null) return 'never';
  if (hours < 1) return 'less than an hour ago';
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/** Bank-feed health for a tenant (optionally one company). Works with the RLS client. */
export async function getBankFeedHealth(db: SupabaseClient, orgId: string, opts: { locationId?: string | null; now?: Date } = {}): Promise<BankFeedHealth> {
  const mode = plaidMode();
  const now = opts.now ?? new Date();
  const { data, error } = await db
    .from('plaid_items')
    .select('id, institution_name, status, status_detail, last_synced_at, connection_id')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  let rows = (data ?? []) as ItemRow[];

  // Environment + company of each Item come from its connection row.
  const connIds = rows.map((r) => r.connection_id).filter((x): x is string => !!x);
  const connById = new Map<string, { environment: 'test' | 'live'; location_id: string | null }>();
  if (connIds.length > 0) {
    const { data: conns } = await db.schema('core').from('provider_connections').select('id, environment, location_id').eq('org_id', orgId).in('id', connIds);
    for (const c of (conns ?? []) as Array<{ id: string; environment: 'test' | 'live'; location_id: string | null }>) connById.set(c.id, c);
  }
  if (opts.locationId) {
    // An Item linked for a company shows on that company; a tenant-wide Item shows everywhere.
    const { data: accts } = await db.from('bank_accounts').select('plaid_item_pk').eq('org_id', orgId).eq('location_id', opts.locationId).not('plaid_item_pk', 'is', null);
    const forCompany = new Set(((accts ?? []) as Array<{ plaid_item_pk: string }>).map((a) => a.plaid_item_pk));
    rows = rows.filter((r) => forCompany.has(r.id) || (r.connection_id ? connById.get(r.connection_id)?.location_id === opts.locationId : false));
  }

  const items: FeedItemHealth[] = rows.map((r) => {
    const env = r.connection_id ? connById.get(r.connection_id)?.environment ?? null : null;
    const envProblem = env !== null && env !== mode.connectionEnv
      ? (env === 'test' ? 'Linked in Plaid Sandbox — link this bank again now that Plaid is in Production.' : 'Linked in Plaid Production, but the server is in Sandbox.')
      : null;
    return {
      id: r.id,
      institutionName: r.institution_name,
      status: r.status,
      problem: envProblem ?? itemProblem(r.status),
      lastSyncedAt: r.last_synced_at,
      environment: env,
    };
  });

  const v = feedVerdict(items, now, mode.connectionEnv);
  const message =
    v.verdict === 'not_connected' ? 'No bank is connected for automatic import yet.'
    : v.verdict === 'attention' ? `A bank connection needs attention. Last sync ${ago(v.hoursSinceSync)}.`
    : v.verdict === 'stale' ? `Bank transactions may be out of date — last sync ${ago(v.hoursSinceSync)}.`
    : `Bank feed up to date — last sync ${ago(v.hoursSinceSync)}.`;

  return {
    plaid: { label: mode.label, isLive: mode.isLive, configured: mode.configured, warning: mode.warning },
    verdict: v.verdict,
    lastSyncedAt: v.lastSyncedAt,
    hoursSinceSync: v.hoursSinceSync,
    staleAfterHours: STALE_AFTER_HOURS,
    items,
    message,
  };
}
