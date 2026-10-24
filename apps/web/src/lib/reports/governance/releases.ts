/**
 * Release services (FPB §18.2, G-1/G-2). Callers (routes / the nightly job) have ALREADY
 * checked close_mgmt:manage; every write goes through the scoped writer (service role, org
 * pinned, client scope asserted — lib/db/scoped-writer.ts). Reads use the caller's client.
 *
 *   releasePeriod        manual release of an ended SOFT/HARD-closed month + baseline snapshot
 *                        (a re-release compares against the previous baseline first)
 *   withdrawRelease      take a month back (reason required); also blocks the auto rule
 *   materializeAutoReleases  write AUTO rows + snapshots for months the rule has released
 *   saveReleaseSettings / saveCoverage
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { scopedWriter } from '@/lib/db/scoped-writer';
import { computeSnapshot, fromSnapshotRow, loadAccounts, postgrestLedger, snapshotHashConsistent, snapshotRow, verifiedSnapshotHash, SNAPSHOT_COLUMNS, type LedgerSource, type SnapshotDbRow } from './snapshot';
import { boundsFor, recordRestatement } from './restatements';
import { loadGovernanceFacts, isMissingRelation } from './load';
import { earlierUnreleased, manualReleaseBlock, releaseState } from './policy';
import { addMonths, monthLabel, periodKey } from './periods';
import type { DeadlineDef } from './types';

export class ReleaseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ReleaseError';
  }
}

/** The DB's release-order trigger (mig 186) refuses out-of-order releases / withdrawals. */
export function isReleaseOrderError(e: { message?: string } | null | undefined): boolean {
  return !!e && /RELEASE_ORDER/.test(e.message ?? '');
}

function orderError(fallback: string): ReleaseError {
  return new ReleaseError(fallback, 409, 'RELEASE_ORDER');
}

const BLOCK_TEXT = {
  no_period: 'This company has no fiscal period for that month.',
  not_ended: "That month hasn't ended yet.",
  open: 'That month is still open. Soft-close or close it before releasing.',
} as const;

interface ReleaseRow {
  id: string;
  status: 'RELEASED' | 'WITHDRAWN';
  release_mode: 'MANUAL' | 'AUTO';
  baseline_snapshot_id: string | null;
}

export interface ReleaseInput {
  locationId: string;
  year: number;
  month: number;
  note?: string | null;
}

export interface ReleaseResult {
  releaseId: string;
  snapshotId: string;
  alreadyReleased: boolean;
  restatementId: string | null;
}

async function findRelease(writer: SupabaseClient, orgId: string, i: { locationId: string; year: number; month: number }): Promise<ReleaseRow | null> {
  const { data, error } = await writer
    .from('report_releases')
    .select('id, status, release_mode, baseline_snapshot_id')
    .eq('org_id', orgId)
    .eq('location_id', i.locationId)
    .eq('period_year', i.year)
    .eq('period_month', i.month)
    .maybeSingle();
  if (error) throw new Error(`Could not read the release: ${error.message}`);
  return (data as ReleaseRow | null) ?? null;
}

async function insertSnapshot(
  writer: SupabaseClient,
  orgId: string,
  i: { locationId: string; year: number; month: number },
  releaseId: string,
  reason: 'RELEASE' | 'AUTO_RELEASE',
  actor: string,
  totals: Awaited<ReturnType<typeof computeSnapshot>>,
): Promise<string> {
  const { data, error } = await writer
    .from('report_release_snapshots')
    .insert({
      org_id: orgId,
      location_id: i.locationId,
      release_id: releaseId,
      period_year: i.year,
      period_month: i.month,
      reason,
      captured_by: actor,
      ...snapshotRow(totals),
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Could not save the snapshot: ${error?.message ?? 'no row'}`);
  const id = (data as { id: string }).id;
  const { error: upErr } = await writer
    .from('report_releases')
    .update({ baseline_snapshot_id: id, updated_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('id', releaseId);
  if (upErr) throw new Error(`Could not set the release baseline: ${upErr.message}`);
  return id;
}

export async function releasePeriod(
  caller: SupabaseClient,
  orgId: string,
  actor: string,
  input: ReleaseInput,
  opts: { now?: Date; ledger?: LedgerSource } = {},
): Promise<ReleaseResult> {
  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const key = periodKey(input.year, input.month);
  const facts = await loadGovernanceFacts(caller, orgId, [input.locationId]);
  const company = facts.companies[input.locationId];
  if (!company) throw new ReleaseError('You do not have access to that company.', 403, 'FORBIDDEN');
  const block = manualReleaseBlock(company, key, today);
  if (block) throw new ReleaseError(BLOCK_TEXT[block], 409, `NOT_RELEASABLE_${block.toUpperCase()}`);
  // Months are released IN ORDER: the previous month (with a period) must be released first,
  // so a withheld month can never be derived from two released balance sheets.
  const held = earlierUnreleased(company, key, today);
  if (held) throw orderError(`Release ${monthLabel(held)} first — months are released in order.`);

  const writer = await scopedWriter(caller, orgId, [input.locationId]);
  const existing = await findRelease(writer, orgId, input);
  const accounts = await loadAccounts(caller, orgId);
  const totals = await computeSnapshot(opts.ledger ?? postgrestLedger(caller), orgId, input.locationId, boundsFor(input.year, input.month), accounts);

  // Compare with what was last reported (released, or released then withdrawn).
  let restatementId: string | null = null;
  if (existing?.baseline_snapshot_id) {
    const { data: prior } = await caller
      .from('report_release_snapshots')
      .select(SNAPSHOT_COLUMNS)
      .eq('org_id', orgId)
      .eq('id', existing.baseline_snapshot_id)
      .maybeSingle();
    if (prior) {
      const p = prior as unknown as SnapshotDbRow;
      // Server-side hash over the stored nets (and the stored hash must agree with them).
      if (existing.status === 'RELEASED' && snapshotHashConsistent(p) && verifiedSnapshotHash(p) === totals.statementHash) {
        return { releaseId: existing.id, snapshotId: p.id, alreadyReleased: true, restatementId: null };
      }
      const period = company.periods.find((x) => x.year === input.year && x.month === input.month) ?? null;
      restatementId = await recordRestatement(caller, writer, {
        orgId,
        locationId: input.locationId,
        releaseId: existing.id,
        year: input.year,
        month: input.month,
        prior: { id: p.id, capturedAt: p.captured_at, snap: fromSnapshotRow(p) },
        next: totals,
        accounts,
        detection: 'ON_RELEASE',
        actor,
        reopenReason: period?.reopenReason ?? null,
      });
    }
  }

  const nowIso = now.toISOString();
  let releaseId: string;
  if (existing) {
    const { error } = await writer
      .from('report_releases')
      .update({ status: 'RELEASED', release_mode: 'MANUAL', released_at: nowIso, released_by: actor, release_note: input.note ?? null, updated_at: nowIso })
      .eq('org_id', orgId)
      .eq('id', existing.id);
    if (isReleaseOrderError(error)) throw orderError('Release the previous month first — months are released in order.');
    if (error) throw new Error(`Could not release: ${error.message}`);
    releaseId = existing.id;
  } else {
    const fp = await caller
      .from('fiscal_periods')
      .select('id')
      .eq('org_id', orgId)
      .eq('location_id', input.locationId)
      .eq('period_year', input.year)
      .eq('period_month', input.month)
      .maybeSingle();
    const { data, error } = await writer
      .from('report_releases')
      .insert({
        org_id: orgId,
        location_id: input.locationId,
        fiscal_period_id: (fp.data as { id: string } | null)?.id ?? null,
        period_year: input.year,
        period_month: input.month,
        status: 'RELEASED',
        release_mode: 'MANUAL',
        released_at: nowIso,
        released_by: actor,
        release_note: input.note ?? null,
      })
      .select('id')
      .single();
    if (isReleaseOrderError(error)) throw orderError('Release the previous month first — months are released in order.');
    if (error || !data) throw new Error(`Could not release: ${error?.message ?? 'no row'}`);
    releaseId = (data as { id: string }).id;
  }
  // A restatement already moved the baseline to the new snapshot; otherwise capture one.
  let snapshotId: string;
  if (restatementId) {
    const { data } = await writer.from('report_releases').select('baseline_snapshot_id').eq('org_id', orgId).eq('id', releaseId).maybeSingle();
    snapshotId = (data as { baseline_snapshot_id: string } | null)?.baseline_snapshot_id ?? '';
  } else {
    snapshotId = await insertSnapshot(writer, orgId, input, releaseId, 'RELEASE', actor, totals);
  }
  return { releaseId, snapshotId, alreadyReleased: false, restatementId };
}

export async function withdrawRelease(
  caller: SupabaseClient,
  orgId: string,
  actor: string,
  input: ReleaseInput & { reason: string },
  opts: { now?: Date } = {},
): Promise<{ releaseId: string }> {
  const reason = input.reason.trim();
  if (reason.length < 4) throw new ReleaseError('Give a reason for taking this month back (at least 4 characters).', 422, 'REASON_REQUIRED');
  const facts = await loadGovernanceFacts(caller, orgId, [input.locationId]);
  const company = facts.companies[input.locationId];
  if (!company) throw new ReleaseError('You do not have access to that company.', 403, 'FORBIDDEN');
  // In order: a month cannot be taken back while the month after it is explicitly released.
  const next = addMonths(periodKey(input.year, input.month), 1);
  const nextRow = company.releases.find((r) => periodKey(r.year, r.month) === next && r.status === 'RELEASED');
  if (nextRow) throw orderError(`Take back ${monthLabel(next)} first — ${monthLabel(next)} is released and builds on this month.`);
  const writer = await scopedWriter(caller, orgId, [input.locationId]);
  const existing = await findRelease(writer, orgId, input);
  const nowIso = (opts.now ?? new Date()).toISOString();
  const patch = { status: 'WITHDRAWN', withdrawn_at: nowIso, withdrawn_by: actor, withdraw_reason: reason, updated_at: nowIso };
  if (existing) {
    const { error } = await writer.from('report_releases').update(patch).eq('org_id', orgId).eq('id', existing.id);
    if (isReleaseOrderError(error)) throw orderError('Take back the next month first — months are released in order.');
    if (error) throw new Error(`Could not withdraw: ${error.message}`);
    return { releaseId: existing.id };
  }
  // No row: the month is released by the auto rule (or not at all). A WITHDRAWN row stops
  // the rule from releasing it.
  const { data, error } = await writer
    .from('report_releases')
    .insert({
      org_id: orgId,
      location_id: input.locationId,
      period_year: input.year,
      period_month: input.month,
      release_mode: 'AUTO',
      ...patch,
    })
    .select('id')
    .single();
  if (isReleaseOrderError(error)) throw orderError('Take back the next month first — months are released in order.');
  if (error || !data) throw new Error(`Could not withdraw: ${error?.message ?? 'no row'}`);
  return { releaseId: (data as { id: string }).id };
}

/**
 * Write AUTO release rows (+ baseline snapshots) for months the rule has released but no row
 * exists yet — newest first, at most `limit` per run (first enable on a long history).
 */
export async function materializeAutoReleases(
  caller: SupabaseClient,
  orgId: string,
  opts: { now?: Date; limit?: number; actor?: string; ledger?: LedgerSource } = {},
): Promise<{ materialized: number }> {
  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const actor = opts.actor ?? 'system:auto-release';
  const facts = await loadGovernanceFacts(caller, orgId, []);
  const due: Array<{ locationId: string; year: number; month: number; on: string }> = [];
  for (const c of Object.values(facts.companies)) {
    if (!c.settings.autoReleaseEnabled) continue;
    for (const p of c.periods) {
      if (c.releases.some((r) => r.year === p.year && r.month === p.month)) continue;
      const st = releaseState(c, periodKey(p.year, p.month), today);
      if (st.released && st.derived && st.releasedOn) due.push({ locationId: c.locationId, year: p.year, month: p.month, on: st.releasedOn });
    }
  }
  due.sort((a, b) => b.year - a.year || b.month - a.month);
  const batch = due.slice(0, opts.limit ?? 24);
  if (batch.length === 0) return { materialized: 0 };
  const accounts = await loadAccounts(caller, orgId);
  let n = 0;
  for (const d of batch) {
    const writer = await scopedWriter(caller, orgId, [d.locationId]);
    const releasedAt = `${d.on}T00:00:00.000Z` < now.toISOString() ? `${d.on}T00:00:00.000Z` : now.toISOString();
    const { data, error } = await writer
      .from('report_releases')
      .insert({
        org_id: orgId,
        location_id: d.locationId,
        period_year: d.year,
        period_month: d.month,
        status: 'RELEASED',
        release_mode: 'AUTO',
        released_at: releasedAt,
        released_by: actor,
      })
      .select('id')
      .single();
    if (error || !data) {
      // A concurrent run (or a person) wrote the row first — fine, skip it.
      if (/duplicate|unique/i.test(error?.message ?? '')) continue;
      // The DB refused it as out of order (an earlier month is not released) — skip it.
      if (isReleaseOrderError(error)) continue;
      throw new Error(`Could not record the auto release: ${error?.message ?? 'no row'}`);
    }
    const totals = await computeSnapshot(opts.ledger ?? postgrestLedger(caller), orgId, d.locationId, boundsFor(d.year, d.month), accounts);
    await insertSnapshot(writer, orgId, d, (data as { id: string }).id, 'AUTO_RELEASE', actor, totals);
    n += 1;
  }
  return { materialized: n };
}

export interface SettingsInput {
  locationId: string | null;
  autoReleaseEnabled: boolean;
  autoReleaseDays: number;
  autoReleaseMinStatus: 'SOFT_CLOSE' | 'HARD_CLOSE';
  deadlines: DeadlineDef[];
}

export async function saveReleaseSettings(caller: SupabaseClient, orgId: string, actor: string, s: SettingsInput): Promise<void> {
  const writer = await scopedWriter(caller, orgId, s.locationId ? [s.locationId] : []);
  let q = writer.from('report_governance_settings').select('id').eq('org_id', orgId);
  q = s.locationId ? q.eq('location_id', s.locationId) : q.is('location_id', null);
  const { data: existing, error: readErr } = await q.maybeSingle();
  if (readErr && !isMissingRelation(readErr)) throw new Error(readErr.message);
  const row = {
    auto_release_enabled: s.autoReleaseEnabled,
    auto_release_days: s.autoReleaseDays,
    auto_release_min_status: s.autoReleaseMinStatus,
    deadlines: s.deadlines.map((d) => ({ key: d.key, label: d.label, cadence: d.cadence, days_after_period_end: d.daysAfterPeriodEnd, recipient: d.recipient ?? null })),
    updated_by: actor,
    updated_at: new Date().toISOString(),
  };
  const { error } = existing
    ? await writer.from('report_governance_settings').update(row).eq('org_id', orgId).eq('id', (existing as { id: string }).id)
    : await writer.from('report_governance_settings').insert({ org_id: orgId, location_id: s.locationId, ...row });
  if (error) throw new Error(`Could not save the release settings: ${error.message}`);
}

/** Remove a company override so the company follows the tenant rule again. */
export async function clearCompanySettings(caller: SupabaseClient, orgId: string, locationId: string): Promise<void> {
  const writer = await scopedWriter(caller, orgId, [locationId]);
  const { error } = await writer.from('report_governance_settings').delete().eq('org_id', orgId).eq('location_id', locationId);
  if (error) throw new Error(error.message);
}

export interface CoverageInput {
  locationId: string;
  inGroupFrom: string | null;
  inGroupUntil: string | null;
  note: string | null;
}

export async function saveCoverage(caller: SupabaseClient, orgId: string, actor: string, c: CoverageInput): Promise<void> {
  if (c.inGroupFrom && c.inGroupUntil && c.inGroupUntil < c.inGroupFrom) {
    throw new ReleaseError('"In group until" must be on or after "in group from".', 422, 'BAD_DATES');
  }
  const writer = await scopedWriter(caller, orgId, [c.locationId]);
  const { data: existing } = await writer
    .from('report_company_coverage')
    .select('id')
    .eq('org_id', orgId)
    .eq('location_id', c.locationId)
    .maybeSingle();
  const row = { in_group_from: c.inGroupFrom, in_group_until: c.inGroupUntil, note: c.note, updated_by: actor, updated_at: new Date().toISOString() };
  const { error } = existing
    ? await writer.from('report_company_coverage').update(row).eq('org_id', orgId).eq('id', (existing as { id: string }).id)
    : await writer.from('report_company_coverage').insert({ org_id: orgId, location_id: c.locationId, ...row });
  if (error) throw new Error(`Could not save the group dates: ${error.message}`);
}
