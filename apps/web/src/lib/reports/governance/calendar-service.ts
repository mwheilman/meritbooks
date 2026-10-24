/**
 * The reporting-calendar read model (GET /api/report-governance/calendar). Server-only.
 * Finance callers with release authority first catch the books up: materialize auto
 * releases and re-check released months for restatement (ON_READ) — best effort, reported
 * as `maintenance` warnings, never blocking the read.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { buildCalendar, type Calendar } from './calendar';
import { loadFreshness, type FreshnessCard } from './freshness';
import { loadGovernanceFacts } from './load';
import { materializeAutoReleases } from './releases';
import { checkRestatements } from './restatements';
import type { GovernanceAudience, ReleaseSettings } from './types';

export interface RestatementLogEntry {
  id: string;
  locationId: string;
  companyName: string;
  periodKey: string;
  detectedAt: string;
  detectedBy: string | null;
  detection: string;
  revenueDeltaCents: number;
  netIncomeDeltaCents: number;
  assetsDeltaCents: number | null;
  changedAccounts: Array<{ account_number: string | null; name: string | null; delta_cents: number }>;
  causeEntries: Array<{ gl_entry_id: string; entry_number: string | null; entry_date: string | null; memo: string | null; voided_at: string | null }>;
  reopenReason: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  acknowledgement: string | null;
}

export interface CalendarResponse {
  audience: GovernanceAudience;
  canRelease: boolean;
  today: string;
  calendar: Calendar;
  tenantSettings: ReleaseSettings;
  freshness: FreshnessCard[];
  restatements: RestatementLogEntry[];
  maintenance: { materialized: number; restated: number; warnings: string[] };
}

interface RestatementRow {
  id: string;
  location_id: string;
  period_year: number;
  period_month: number;
  detected_at: string;
  detected_by: string | null;
  detection: string;
  revenue_delta_cents: number | string;
  net_income_delta_cents: number | string;
  assets_delta_cents: number | string | null;
  changed_accounts: RestatementLogEntry['changedAccounts'] | null;
  cause_entries: RestatementLogEntry['causeEntries'] | null;
  reopen_reason: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  acknowledgement: string | null;
}

export async function loadCalendar(
  supabase: SupabaseClient,
  orgId: string,
  opts: { audience: GovernanceAudience; canRelease: boolean; actor: string; months: number; now?: Date },
): Promise<CalendarResponse> {
  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const maintenance = { materialized: 0, restated: 0, warnings: [] as string[] };
  if (opts.canRelease) {
    try {
      maintenance.materialized = (await materializeAutoReleases(supabase, orgId, { now, limit: 12 })).materialized;
    } catch (e) {
      maintenance.warnings.push(`Auto-release could not run: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      maintenance.restated = (await checkRestatements(supabase, orgId, { detection: 'ON_READ', actor: opts.actor, limit: 60 })).restated;
    } catch (e) {
      maintenance.warnings.push(`The restatement check could not run: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const facts = await loadGovernanceFacts(supabase, orgId, []);
  const calendar = buildCalendar(facts, { today, months: opts.months });
  const companies = Object.values(facts.companies);
  const freshness = await loadFreshness(supabase, orgId, companies, today);

  const names = new Map(companies.map((c) => [c.locationId, c.name]));
  const { data, error } = await supabase
    .from('report_restatements')
    .select('id, location_id, period_year, period_month, detected_at, detected_by, detection, revenue_delta_cents, net_income_delta_cents, assets_delta_cents, changed_accounts, cause_entries, reopen_reason, acknowledged_at, acknowledged_by, acknowledgement')
    .eq('org_id', orgId)
    .order('detected_at', { ascending: false })
    .limit(100);
  if (error && !/does not exist|could not find/i.test(error.message)) maintenance.warnings.push(`Restatement log: ${error.message}`);
  const restatements: RestatementLogEntry[] = ((data ?? []) as RestatementRow[])
    .filter((r) => names.has(r.location_id))
    .map((r) => ({
      id: r.id,
      locationId: r.location_id,
      companyName: names.get(r.location_id) ?? 'Company',
      periodKey: `${r.period_year}-${String(r.period_month).padStart(2, '0')}`,
      detectedAt: r.detected_at,
      detectedBy: r.detected_by,
      detection: r.detection,
      revenueDeltaCents: Number(r.revenue_delta_cents) || 0,
      netIncomeDeltaCents: Number(r.net_income_delta_cents) || 0,
      assetsDeltaCents: r.assets_delta_cents === null ? null : Number(r.assets_delta_cents),
      changedAccounts: (r.changed_accounts ?? []).slice(0, 10),
      causeEntries: (r.cause_entries ?? []).slice(0, 10),
      reopenReason: r.reopen_reason,
      acknowledgedAt: r.acknowledged_at,
      acknowledgedBy: r.acknowledged_by,
      acknowledgement: r.acknowledgement,
    }));

  return { audience: opts.audience, canRelease: opts.canRelease, today, calendar, tenantSettings: facts.tenantSettings, freshness, restatements, maintenance };
}

export interface PeriodDetail {
  release: {
    id: string;
    status: 'RELEASED' | 'WITHDRAWN';
    mode: 'MANUAL' | 'AUTO';
    releasedAt: string | null;
    releasedBy: string | null;
    note: string | null;
    withdrawnAt: string | null;
    withdrawnBy: string | null;
    withdrawReason: string | null;
  } | null;
  snapshot: {
    id: string;
    capturedAt: string;
    reason: string;
    revenueCents: number;
    cogsCents: number;
    opexCents: number;
    otherNetCents: number;
    netIncomeCents: number;
    assetsCents: number | null;
    liabilitiesCents: number | null;
    equityCents: number | null;
    postedEntryCount: number;
    statementHash: string;
  } | null;
}

interface ReleaseDbRow {
  id: string;
  status: 'RELEASED' | 'WITHDRAWN';
  release_mode: 'MANUAL' | 'AUTO';
  released_at: string | null;
  released_by: string | null;
  release_note: string | null;
  withdrawn_at: string | null;
  withdrawn_by: string | null;
  withdraw_reason: string | null;
  baseline_snapshot_id: string | null;
}
interface SnapRow {
  id: string;
  captured_at: string;
  reason: string;
  revenue_cents: number | string;
  cogs_cents: number | string;
  opex_cents: number | string;
  other_net_cents: number | string;
  net_income_cents: number | string;
  assets_cents: number | string | null;
  liabilities_cents: number | string | null;
  equity_cents: number | string | null;
  posted_entry_count: number;
  statement_hash: string;
}

const n = (v: number | string | null): number | null => (v === null ? null : Number(v));

/** One company-month: its release row and the snapshot partners were shown. */
export async function loadPeriodDetail(supabase: SupabaseClient, orgId: string, locationId: string, year: number, month: number): Promise<PeriodDetail> {
  const { data: rel } = await supabase
    .from('report_releases')
    .select('id, status, release_mode, released_at, released_by, release_note, withdrawn_at, withdrawn_by, withdraw_reason, baseline_snapshot_id')
    .eq('org_id', orgId)
    .eq('location_id', locationId)
    .eq('period_year', year)
    .eq('period_month', month)
    .maybeSingle();
  const r = rel as ReleaseDbRow | null;
  let snapshot: PeriodDetail['snapshot'] = null;
  if (r?.baseline_snapshot_id) {
    const { data: s } = await supabase
      .from('report_release_snapshots')
      .select('id, captured_at, reason, revenue_cents, cogs_cents, opex_cents, other_net_cents, net_income_cents, assets_cents, liabilities_cents, equity_cents, posted_entry_count, statement_hash')
      .eq('org_id', orgId)
      .eq('id', r.baseline_snapshot_id)
      .maybeSingle();
    const x = s as SnapRow | null;
    if (x) {
      snapshot = {
        id: x.id,
        capturedAt: x.captured_at,
        reason: x.reason,
        revenueCents: Number(x.revenue_cents),
        cogsCents: Number(x.cogs_cents),
        opexCents: Number(x.opex_cents),
        otherNetCents: Number(x.other_net_cents),
        netIncomeCents: Number(x.net_income_cents),
        assetsCents: n(x.assets_cents),
        liabilitiesCents: n(x.liabilities_cents),
        equityCents: n(x.equity_cents),
        postedEntryCount: x.posted_entry_count,
        statementHash: x.statement_hash,
      };
    }
  }
  return {
    release: r
      ? {
          id: r.id,
          status: r.status,
          mode: r.release_mode,
          releasedAt: r.released_at,
          releasedBy: r.released_by,
          note: r.release_note,
          withdrawnAt: r.withdrawn_at,
          withdrawnBy: r.withdrawn_by,
          withdrawReason: r.withdraw_reason,
        }
      : null,
    snapshot,
  };
}
