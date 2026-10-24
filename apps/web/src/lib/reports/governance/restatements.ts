/**
 * Restatement detection (FPB §18.2, §18.5 G-6).
 *
 * For every RELEASED company-month with a baseline snapshot, re-hash the month's posted
 * activity. A different hash ⇒ a new snapshot (reason RESTATEMENT), a restatement row with
 * the deltas, the changed accounts, the journal entries posted / voided in the month since
 * the prior snapshot (the cause) and the period's reopen reason; the release baseline moves
 * to the new snapshot so the next check compares against what is now reported.
 *
 * A month that is currently OPEN (reopened after release) is skipped: edits accumulate and
 * are logged once, when it is closed again (or re-released). Reads use the caller's client;
 * writes go through the scoped writer (org pin + client scope).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { scopedWriter } from '@/lib/db/scoped-writer';
import {
  SNAPSHOT_COLUMNS,
  computeSnapshot,
  diffSnapshots,
  fromSnapshotRow,
  loadAccounts,
  postgrestLedger,
  snapshotRow,
  verifiedSnapshotHash,
  summarizeActivity,
  type AccountMeta,
  type LedgerSource,
  type ComparableSnapshot,
  type SnapshotDbRow,
  type SnapshotTotals,
} from './snapshot';
import { monthEnd, periodKey } from './periods';

export type Detection = 'ON_READ' | 'ON_RELEASE' | 'SCHEDULED' | 'MANUAL';

export interface CauseEntry {
  gl_entry_id: string;
  entry_number: string | null;
  entry_date: string | null;
  posted_at: string | null;
  voided_at: string | null;
  memo: string | null;
  source_module: string | null;
}

interface EntryRow {
  id: string;
  entry_number: string | null;
  entry_date: string | null;
  posted_at: string | null;
  voided_at: string | null;
  memo: string | null;
  source_module: string | null;
}

export function boundsFor(year: number, month: number): { startDate: string; endDate: string } {
  const k = periodKey(year, month);
  return { startDate: `${k}-01`, endDate: monthEnd(k) };
}

/** Journal entries in the month posted or voided after `sinceISO`. */
export async function loadCauseEntries(
  supabase: SupabaseClient,
  orgId: string,
  locationId: string,
  year: number,
  month: number,
  sinceISO: string,
): Promise<CauseEntry[]> {
  const b = boundsFor(year, month);
  const since = new Date(sinceISO).toISOString();
  const { data, error } = await supabase
    .from('gl_entries')
    .select('id, entry_number, entry_date, posted_at, voided_at, memo, source_module')
    .eq('org_id', orgId)
    .eq('location_id', locationId)
    .gte('entry_date', b.startDate)
    .lte('entry_date', b.endDate)
    .or(`posted_at.gt.${since},voided_at.gt.${since}`)
    .order('posted_at', { ascending: true })
    .limit(200);
  if (error) return [];
  return ((data ?? []) as EntryRow[]).map((e) => ({
    gl_entry_id: e.id,
    entry_number: e.entry_number,
    entry_date: e.entry_date,
    posted_at: e.posted_at,
    voided_at: e.voided_at,
    memo: e.memo,
    source_module: e.source_module,
  }));
}

export interface RecordRestatementInput {
  orgId: string;
  locationId: string;
  releaseId: string;
  year: number;
  month: number;
  prior: { id: string; capturedAt: string; snap: ComparableSnapshot };
  next: SnapshotTotals;
  accounts: ReadonlyMap<string, AccountMeta>;
  detection: Detection;
  actor: string;
  reopenReason: string | null;
}

/** Write the new snapshot + the restatement row + move the baseline. Returns the restatement id. */
export async function recordRestatement(
  caller: SupabaseClient,
  writer: SupabaseClient,
  i: RecordRestatementInput,
): Promise<string | null> {
  const diff = diffSnapshots(i.prior.snap, {
    statementHash: i.next.statementHash,
    revenueCents: i.next.revenueCents,
    cogsCents: i.next.cogsCents,
    opexCents: i.next.opexCents,
    otherNetCents: i.next.otherNetCents,
    netIncomeCents: i.next.netIncomeCents,
    assetsCents: i.next.assetsCents,
    liabilitiesCents: i.next.liabilitiesCents,
    equityCents: i.next.equityCents,
    accountBalances: i.next.accountBalances,
  }, i.accounts);
  if (!diff.changed) return null;

  const { data: snap, error: snapErr } = await writer
    .from('report_release_snapshots')
    .insert({
      org_id: i.orgId,
      location_id: i.locationId,
      release_id: i.releaseId,
      period_year: i.year,
      period_month: i.month,
      reason: 'RESTATEMENT',
      captured_by: i.actor,
      ...snapshotRow(i.next),
    })
    .select('id')
    .single();
  if (snapErr || !snap) throw new Error(`Could not save the restated snapshot: ${snapErr?.message ?? 'no row'}`);
  const newId = (snap as { id: string }).id;

  const causes = await loadCauseEntries(caller, i.orgId, i.locationId, i.year, i.month, i.prior.capturedAt);
  const { data: rs, error: rsErr } = await writer
    .from('report_restatements')
    .insert({
      org_id: i.orgId,
      location_id: i.locationId,
      release_id: i.releaseId,
      period_year: i.year,
      period_month: i.month,
      prior_snapshot_id: i.prior.id,
      new_snapshot_id: newId,
      detected_by: i.actor,
      detection: i.detection,
      revenue_delta_cents: diff.revenueDeltaCents,
      cogs_delta_cents: diff.cogsDeltaCents,
      opex_delta_cents: diff.opexDeltaCents,
      other_net_delta_cents: diff.otherNetDeltaCents,
      net_income_delta_cents: diff.netIncomeDeltaCents,
      assets_delta_cents: diff.assetsDeltaCents,
      liabilities_delta_cents: diff.liabilitiesDeltaCents,
      equity_delta_cents: diff.equityDeltaCents,
      changed_accounts: diff.changedAccounts.slice(0, 100),
      cause_entries: causes,
      reopen_reason: i.reopenReason,
    })
    .select('id')
    .single();
  if (rsErr || !rs) throw new Error(`Could not log the restatement: ${rsErr?.message ?? 'no row'}`);

  const { error: upErr } = await writer
    .from('report_releases')
    .update({ baseline_snapshot_id: newId, updated_at: new Date().toISOString() })
    .eq('org_id', i.orgId)
    .eq('id', i.releaseId);
  if (upErr) throw new Error(`Could not move the release baseline: ${upErr.message}`);
  return (rs as { id: string }).id;
}

interface ReleaseRow {
  id: string;
  location_id: string;
  period_year: number;
  period_month: number;
  baseline_snapshot_id: string | null;
}
interface PeriodRow { location_id: string; period_year: number; period_month: number; status: string; close_override_reason: string | null }

export interface CheckResult {
  checked: number;
  restated: number;
  skippedOpen: number;
  restatementIds: string[];
}

/** Check every released month (optionally limited to some companies) for restatement. */
export async function checkRestatements(
  caller: SupabaseClient,
  orgId: string,
  opts: { locationIds?: readonly string[]; detection: Detection; actor: string; limit?: number; ledger?: LedgerSource },
): Promise<CheckResult> {
  const result: CheckResult = { checked: 0, restated: 0, skippedOpen: 0, restatementIds: [] };
  let q = caller
    .from('report_releases')
    .select('id, location_id, period_year, period_month, baseline_snapshot_id')
    .eq('org_id', orgId)
    .eq('status', 'RELEASED')
    .not('baseline_snapshot_id', 'is', null)
    .order('period_year', { ascending: false })
    .order('period_month', { ascending: false })
    .limit(opts.limit ?? 500);
  if (opts.locationIds?.length) q = q.in('location_id', [...opts.locationIds]);
  const { data: rels, error } = await q;
  if (error) throw new Error(`Could not read releases: ${error.message}`);
  const releases = (rels ?? []) as ReleaseRow[];
  if (releases.length === 0) return result;

  const locIds = Array.from(new Set(releases.map((r) => r.location_id)));
  const { data: pers } = await caller
    .from('fiscal_periods')
    .select('location_id, period_year, period_month, status, close_override_reason')
    .eq('org_id', orgId)
    .in('location_id', locIds);
  const periods = (pers ?? []) as PeriodRow[];
  const periodOf = (r: ReleaseRow) =>
    periods.find((p) => p.location_id === r.location_id && p.period_year === r.period_year && p.period_month === r.period_month) ?? null;

  const snapIds = releases.map((r) => r.baseline_snapshot_id as string);
  const { data: snaps, error: snapErr } = await caller.from('report_release_snapshots').select(SNAPSHOT_COLUMNS).eq('org_id', orgId).in('id', snapIds);
  if (snapErr) throw new Error(`Could not read snapshots: ${snapErr.message}`);
  const snapById = new Map(((snaps ?? []) as unknown as SnapshotDbRow[]).map((s) => [s.id, s]));

  const ledger = opts.ledger ?? postgrestLedger(caller);
  let accounts: Map<string, AccountMeta> | null = null;
  for (const r of releases) {
    const baseline = snapById.get(r.baseline_snapshot_id as string);
    if (!baseline) continue;
    const period = periodOf(r);
    if (period?.status === 'OPEN') {
      result.skippedOpen += 1;
      continue;
    }
    result.checked += 1;
    accounts ??= await loadAccounts(caller, orgId);
    const bounds = boundsFor(r.period_year, r.period_month);
    const activity = summarizeActivity(await ledger.periodActivity(orgId, r.location_id, bounds), accounts);
    // Compare against the hash RECOMPUTED from the baseline's stored nets, never the stored
    // hash column alone (a stale / edited hash can't mask a change).
    if (activity.statementHash === verifiedSnapshotHash(baseline) && baseline.statement_hash === activity.statementHash) continue;

    const next = await computeSnapshot(ledger, orgId, r.location_id, bounds, accounts);
    const writer = await scopedWriter(caller, orgId, [r.location_id]);
    const id = await recordRestatement(caller, writer, {
      orgId,
      locationId: r.location_id,
      releaseId: r.id,
      year: r.period_year,
      month: r.period_month,
      prior: { id: baseline.id, capturedAt: baseline.captured_at, snap: fromSnapshotRow(baseline) },
      next,
      accounts,
      detection: opts.detection,
      actor: opts.actor,
      reopenReason: period?.close_override_reason ?? null,
    });
    if (id) {
      result.restated += 1;
      result.restatementIds.push(id);
    }
  }
  return result;
}

/** Finance adds an explanation to a logged restatement (≥ 4 chars). */
export async function acknowledgeRestatement(
  caller: SupabaseClient,
  orgId: string,
  actor: string,
  id: string,
  note: string,
): Promise<{ locationId: string; year: number; month: number }> {
  const text = note.trim();
  if (text.length < 4) throw new Error('Say what changed and why (at least 4 characters).');
  const { data, error } = await caller
    .from('report_restatements')
    .select('id, location_id, period_year, period_month')
    .eq('org_id', orgId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Restatement not found');
  const row = data as { location_id: string; period_year: number; period_month: number };
  const writer = await scopedWriter(caller, orgId, [row.location_id]);
  // report_restatements is append-only (mig 186 trigger): the acknowledgement columns are the
  // ONLY thing an UPDATE may change — never send any other column here.
  const { error: upErr } = await writer
    .from('report_restatements')
    .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: actor, acknowledgement: text })
    .eq('org_id', orgId)
    .eq('id', id);
  if (upErr) throw new Error(upErr.message);
  return { locationId: row.location_id, year: row.period_year, month: row.period_month };
}
