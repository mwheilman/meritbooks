/**
 * Governance facts loader — the I/O boundary for `evaluateGovernance`. Every read uses the
 * CALLER's RLS-scoped client, so a company outside the caller's org or client scope simply
 * never comes back and is treated as out of scope by the policy (fail closed).
 *
 * Degrades SAFE before migration 186 is applied: a missing governance table reads as "no
 * releases / no settings", so non-finance audiences see nothing (nothing is released) and
 * finance sees preview. It never degrades to "everything released".
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllIn, type PageableQuery } from '@/lib/supabase/fetch-all';
import {
  DEFAULT_RELEASE_SETTINGS,
  type CompanyFacts,
  type CoverageFact,
  type DeadlineDef,
  type FiscalPeriodFact,
  type GovernanceFacts,
  type PeriodStatus,
  type ReleaseFact,
  type ReleaseSettings,
  type RestatementFact,
} from './types';

interface LocationRow { id: string; name: string | null; fiscal_year_start_month: number | null }
interface PeriodRow {
  id: string;
  location_id: string;
  period_year: number;
  period_month: number;
  status: PeriodStatus;
  end_date: string;
  closed_at: string | null;
  close_override_reason: string | null;
}
interface ReleaseRow {
  id: string;
  location_id: string;
  period_year: number;
  period_month: number;
  status: 'RELEASED' | 'WITHDRAWN';
  release_mode: 'MANUAL' | 'AUTO';
  released_at: string | null;
  released_by: string | null;
  withdrawn_at: string | null;
  withdraw_reason: string | null;
  baseline_snapshot_id: string | null;
}
interface RestatementRow {
  id: string;
  location_id: string;
  period_year: number;
  period_month: number;
  detected_at: string;
  net_income_delta_cents: number | string;
  acknowledged_at: string | null;
}
interface CoverageRow { location_id: string; in_group_from: string | null; in_group_until: string | null }
export interface SettingsRow {
  location_id: string | null;
  auto_release_enabled: boolean;
  auto_release_days: number;
  auto_release_min_status: 'SOFT_CLOSE' | 'HARD_CLOSE';
  deadlines: unknown;
}

/** PostgREST / Postgres "relation does not exist" (pre-migration) — read as empty. */
export function isMissingRelation(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  return err.code === '42P01' || err.code === 'PGRST205' || /does not exist|could not find the table/i.test(err.message ?? '');
}

export function parseDeadlines(v: unknown): DeadlineDef[] {
  if (!Array.isArray(v)) return [];
  const out: DeadlineDef[] = [];
  for (const d of v) {
    if (!d || typeof d !== 'object') continue;
    const o = d as Record<string, unknown>;
    const cadence = o.cadence;
    const days = Number(o.days_after_period_end ?? o.daysAfterPeriodEnd);
    if (cadence !== 'monthly' && cadence !== 'quarterly' && cadence !== 'annual') continue;
    if (!Number.isInteger(days) || days < 0 || days > 400) continue;
    const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : 'Reporting package';
    const key = typeof o.key === 'string' && o.key.trim() ? o.key.trim() : `${cadence}-${days}`;
    out.push({ key, label, cadence, daysAfterPeriodEnd: days, recipient: typeof o.recipient === 'string' ? o.recipient : null });
  }
  return out;
}

export function settingsFromRow(r: SettingsRow | null | undefined, fallback: ReleaseSettings = DEFAULT_RELEASE_SETTINGS): ReleaseSettings {
  if (!r) return fallback;
  return {
    autoReleaseEnabled: !!r.auto_release_enabled,
    autoReleaseDays: Number.isInteger(r.auto_release_days) ? r.auto_release_days : fallback.autoReleaseDays,
    autoReleaseMinStatus: r.auto_release_min_status === 'SOFT_CLOSE' ? 'SOFT_CLOSE' : 'HARD_CLOSE',
    deadlines: parseDeadlines(r.deadlines),
  };
}

async function readIn<T>(
  ids: string[],
  make: (chunk: string[]) => PageableQuery<unknown>,
  label: string,
): Promise<T[]> {
  // fetchAllIn over id chunks; a missing table (pre-migration) reads as [].
  const { data, error } = await fetchAllIn(ids, make, { label });
  if (error) {
    if (isMissingRelation(error)) return [];
    throw new Error(`${label}: ${error.message ?? 'read failed'}`);
  }
  return (data ?? []) as T[];
}

/**
 * Load the facts for these companies. `locationIds` empty → every company the caller can
 * read in the org (the reporting calendar).
 */
export async function loadGovernanceFacts(
  supabase: SupabaseClient,
  orgId: string,
  locationIds: readonly string[],
): Promise<GovernanceFacts> {
  // 1. Companies — RLS + client scope decide which come back.
  let locQ = supabase.schema('core').from('locations').select('id, name, fiscal_year_start_month').eq('org_id', orgId);
  if (locationIds.length) locQ = locQ.in('id', [...new Set(locationIds)]);
  const { data: locs, error: locErr } = await locQ;
  if (locErr) throw new Error(`Could not read companies: ${locErr.message}`);
  const locations = (locs ?? []) as LocationRow[];
  const ids = locations.map((l) => l.id);

  // 2. Settings (tenant + company overrides).
  let settingsRows: SettingsRow[] = [];
  {
    const { data, error } = await supabase
      .from('report_governance_settings')
      .select('location_id, auto_release_enabled, auto_release_days, auto_release_min_status, deadlines')
      .eq('org_id', orgId);
    if (error && !isMissingRelation(error)) throw new Error(`Could not read release settings: ${error.message}`);
    settingsRows = (data ?? []) as SettingsRow[];
  }
  const tenantSettings = settingsFromRow(settingsRows.find((r) => r.location_id === null));
  const companySettings = new Map(settingsRows.filter((r) => r.location_id).map((r) => [r.location_id as string, r]));

  const facts: GovernanceFacts = { companies: {}, tenantSettings, companyOverrides: Array.from(companySettings.keys()) };
  if (ids.length === 0) return facts;

  const [periods, releases, restatements, coverage] = await Promise.all([
    readIn<PeriodRow>(
      ids,
      (chunk) =>
        supabase
          .from('fiscal_periods')
          .select('id, location_id, period_year, period_month, status, end_date, closed_at, close_override_reason')
          .eq('org_id', orgId)
          .in('location_id', chunk),
      'governance fiscal periods',
    ),
    readIn<ReleaseRow>(
      ids,
      (chunk) =>
        supabase
          .from('report_releases')
          .select('id, location_id, period_year, period_month, status, release_mode, released_at, released_by, withdrawn_at, withdraw_reason, baseline_snapshot_id')
          .eq('org_id', orgId)
          .in('location_id', chunk),
      'governance releases',
    ),
    readIn<RestatementRow>(
      ids,
      (chunk) =>
        supabase
          .from('report_restatements')
          .select('id, location_id, period_year, period_month, detected_at, net_income_delta_cents, acknowledged_at')
          .eq('org_id', orgId)
          .in('location_id', chunk),
      'governance restatements',
    ),
    readIn<CoverageRow>(
      ids,
      (chunk) =>
        supabase
          .from('report_company_coverage')
          .select('location_id, in_group_from, in_group_until')
          .eq('org_id', orgId)
          .in('location_id', chunk),
      'governance coverage',
    ),
  ]);

  for (const l of locations) {
    const ps: FiscalPeriodFact[] = periods
      .filter((p) => p.location_id === l.id)
      .map((p) => ({
        id: p.id,
        year: p.period_year,
        month: p.period_month,
        status: p.status,
        endDate: String(p.end_date).slice(0, 10),
        closedAt: p.closed_at,
        reopenReason: p.close_override_reason,
      }));
    const rs: ReleaseFact[] = releases
      .filter((r) => r.location_id === l.id)
      .map((r) => ({
        id: r.id,
        year: r.period_year,
        month: r.period_month,
        status: r.status,
        mode: r.release_mode,
        releasedAt: r.released_at,
        releasedBy: r.released_by,
        withdrawnAt: r.withdrawn_at,
        withdrawReason: r.withdraw_reason,
        baselineSnapshotId: r.baseline_snapshot_id,
      }));
    const st: RestatementFact[] = restatements
      .filter((r) => r.location_id === l.id)
      .map((r) => ({
        id: r.id,
        year: r.period_year,
        month: r.period_month,
        detectedAt: r.detected_at,
        netIncomeDeltaCents: Number(r.net_income_delta_cents) || 0,
        acknowledged: !!r.acknowledged_at,
      }));
    const cv = coverage.find((c) => c.location_id === l.id);
    const cov: CoverageFact | null = cv ? { inGroupFrom: cv.in_group_from, inGroupUntil: cv.in_group_until } : null;
    const company: CompanyFacts = {
      locationId: l.id,
      name: l.name ?? 'Company',
      fiscalYearStartMonth: l.fiscal_year_start_month && l.fiscal_year_start_month >= 1 && l.fiscal_year_start_month <= 12 ? l.fiscal_year_start_month : 1,
      periods: ps,
      releases: rs,
      restatements: st,
      coverage: cov,
      settings: settingsFromRow(companySettings.get(l.id), tenantSettings),
    };
    facts.companies[l.id] = company;
  }
  return facts;
}
