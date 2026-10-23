/**
 * Month-end schedule jobs (SC-06 / CL-08): the scheduled depreciation & amortization runs.
 *
 *   close.depreciation   1st of the month: last month's depreciation (fixed assets) and
 *                        amortization (intangibles) for every company. Gated by the
 *                        "Scheduled depreciation & amortization" dial. Also REPORTS lease
 *                        periods that are due — those are never auto-posted (each lease
 *                        entry carries the cash payment leg, which the bank feed also sees;
 *                        a person records it from Leases once the payment clears).
 *   insurance.amortize   1st of the month: due prepaid-insurance periods. Gated by the
 *                        "Scheduled insurance amortization" dial.
 *
 * Each run first PREVIEWS what the engine would post through the last day of the prior
 * month (depreciation-plan.ts — the engines' own pure schedule math), grouped one line per
 * company. Then:
 *   dial PROPOSE / OFF / kill switch / over the cap → nothing posts; the run log + an in-app
 *     note to the tenant's admins say "October depreciation is ready: $X across N companies".
 *   dial AUTO_UNDER_LIMIT and the month's total ≤ the cap → post through the SAME engines
 *     the Fixed assets / Intangibles / Insurance "Run" buttons use (balanced JEs, run
 *     ledgers unique per asset/schedule + period = idempotent, HARD_CLOSE months refused).
 *
 * Idempotent per period: re-running the same month posts nothing new (run ledgers), and a
 * proposal is just a recomputation. HARD_CLOSE months are excluded from the preview and the
 * engine stops an asset's catch-up there, so a locked month is never touched.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { runDepreciation } from '@/lib/posting/depreciation-engine';
import { runAmortization } from '@/lib/intangibles/amortization';
import { runInsuranceAmortizations } from '@/lib/insurance/amortize';
import {
  postingGate,
  SCHEDULED_DEPRECIATION_FEATURE,
  SCHEDULED_INSURANCE_FEATURE,
} from '../posting-gate';
import type { CountValue, JobContext, JobResult } from '../types';
import { planAsset, planSchedule, rollupByCompany, type AssetForPlan, type CompanyRollup, type ScheduleForPlan } from './depreciation-plan';
import { dollars, lastDayOfPriorMonth, loadCompanyNames, loadLockedPeriods, monthOf, notifyTenantAdmins, scopedOrFail } from './shared';

const ASSET_COLS =
  'id, location_id, category, acquisition_date, acquisition_cost_cents, salvage_value_cents, useful_life_months, depreciation_method, accumulated_depreciation_cents, last_depreciation_date, total_expected_units, units_used';

function companyLine(rows: CompanyRollup[], names: Map<string, string>, max = 6): string {
  const shown = rows.filter((r) => r.periods > 0).slice(0, max).map((r) => `${names.get(r.locationId) ?? 'Company'} ${dollars(r.amountCents)}`);
  const more = rows.filter((r) => r.periods > 0).length - shown.length;
  return shown.join(', ') + (more > 0 ? `, +${more} more` : '');
}

/** Earliest date a catch-up could reach (for the lock lookup window). */
function earliest(dates: Array<string | null | undefined>, fallback: string): string {
  let min = fallback;
  for (const d of dates) if (d && d < min) min = d;
  return min;
}

export interface DepreciationPreview {
  asOf: string;
  companies: CompanyRollup[];
  depreciationCents: number;
  amortizationCents: number;
  periods: number;
  assetsDue: number;
  blockedByLock: number;
  skipped: number;
}

export async function previewDepreciation(db: SupabaseClient, orgId: string, asOf: string): Promise<DepreciationPreview> {
  const { data, error } = await db.from('fixed_assets').select(ASSET_COLS).eq('org_id', orgId).eq('status', 'ACTIVE');
  if (error) throw new Error(`Could not read fixed assets: ${error.message}`);
  const assets = (data ?? []) as AssetForPlan[];
  const from = earliest(assets.map((a) => a.last_depreciation_date ?? a.acquisition_date), asOf);
  const locked = assets.length ? await loadLockedPeriods(db, from, asOf) : new Set<string>();
  const plans = assets.map((a) => planAsset(a, asOf, locked));
  const due = plans.filter((p) => p.periods > 0);
  return {
    asOf,
    companies: rollupByCompany(plans),
    depreciationCents: due.filter((p) => p.kind === 'depreciation').reduce((s, p) => s + p.amountCents, 0),
    amortizationCents: due.filter((p) => p.kind === 'amortization').reduce((s, p) => s + p.amountCents, 0),
    periods: due.reduce((s, p) => s + p.periods, 0),
    assetsDue: due.length,
    blockedByLock: plans.filter((p) => p.blockedByLock).length,
    skipped: plans.filter((p) => p.skipped).length,
  };
}

/** Lease periods dated on/before `asOf` that nobody has recorded yet (never auto-posted). */
async function leasePeriodsDue(db: SupabaseClient, orgId: string, asOf: string): Promise<{ periods: number; paymentCents: number; leases: number }> {
  const { data: leases, error } = await db.from('leases').select('id').eq('org_id', orgId).eq('status', 'ACTIVE');
  if (error || !leases || leases.length === 0) return { periods: 0, paymentCents: 0, leases: 0 };
  const ids = (leases as Array<{ id: string }>).map((l) => l.id);
  const { data: lines } = await db
    .from('lease_schedule_lines')
    .select('lease_id, payment_cents, period_date')
    .eq('org_id', orgId)
    .in('lease_id', ids)
    .is('gl_entry_id', null)
    .lte('period_date', asOf);
  const rows = (lines ?? []) as Array<{ lease_id: string; payment_cents: number | string }>;
  return {
    periods: rows.length,
    paymentCents: rows.reduce((s, r) => s + Number(r.payment_cents ?? 0), 0),
    leases: new Set(rows.map((r) => r.lease_id)).size,
  };
}

export async function runDepreciationJob(ctx: JobContext): Promise<JobResult> {
  const s = scopedOrFail(ctx);
  if (!s.ok) return s.result;
  const asOf = lastDayOfPriorMonth(ctx.slotAt);
  const month = monthOf(asOf);

  const [preview, lease, names] = await Promise.all([
    previewDepreciation(s.db, s.orgId, asOf),
    leasePeriodsDue(s.db, s.orgId, asOf).catch(() => ({ periods: 0, paymentCents: 0, leases: 0 })),
    loadCompanyNames(s.db),
  ]);
  const total = preview.depreciationCents + preview.amortizationCents;
  const counts: Record<string, CountValue> = {
    as_of: asOf,
    companies: preview.companies.filter((c) => c.periods > 0).length,
    assets_due: preview.assetsDue,
    periods_due: preview.periods,
    depreciation_cents: preview.depreciationCents,
    amortization_cents: preview.amortizationCents,
    blocked_by_hard_close: preview.blockedByLock,
    skipped_assets: preview.skipped,
    lease_periods_due: lease.periods,
  };
  const leaseNote = lease.periods > 0
    ? ` ${lease.periods} lease period(s) across ${lease.leases} lease(s) are due — record them from Leases once each payment clears (never automatic: they include the cash payment).`
    : '';
  const lockNote = preview.blockedByLock > 0 ? ` ${preview.blockedByLock} asset(s) wait on a hard-closed month (reopen it to catch up).` : '';

  if (preview.periods === 0) {
    return {
      status: 'ok',
      itemsProcessed: 0,
      counts: { ...counts, mode: 'nothing_due' },
      summary: `No depreciation or amortization is due through ${asOf}.${lockNote}${leaseNote}`,
    };
  }

  const gate = await postingGate(ctx.admin, s.orgId, SCHEDULED_DEPRECIATION_FEATURE, total);
  counts.gate = gate.disposition;
  if (!gate.allowed) {
    await notifyTenantAdmins(ctx.admin, s.orgId, {
      kind: 'scheduler.depreciation',
      title: `${month} depreciation is ready to post: ${dollars(total)}`,
      body: `${preview.periods} period(s) across ${counts.companies} compan${counts.companies === 1 ? 'y' : 'ies'} — ${companyLine(preview.companies, names)}. Review and post from Fixed assets.${lockNote}`,
      deepLink: '/fixed-assets',
      dedupeKey: `depreciation:${month}`,
    });
    return {
      status: 'ok',
      itemsProcessed: 0,
      counts: { ...counts, mode: 'proposed' },
      summary: `Proposed: ${month} depreciation & amortization of ${dollars(total)} (${companyLine(preview.companies, names)}). Post it from Fixed assets. (${gate.reason})${lockNote}${leaseNote}`,
    };
  }

  // Intangibles first (their own memo / source), then everything else.
  const amort = await runAmortization(s.db, s.orgId, asOf);
  const depr = await runDepreciation(s.db, s.orgId, asOf);
  const posted = amort.periods_posted + depr.periods_posted;
  const errors = [...amort.errors, ...depr.errors];
  return {
    status: errors.length === 0 ? 'ok' : posted > 0 ? 'partial' : 'failed',
    itemsProcessed: posted,
    counts: { ...counts, mode: 'posted', periods_posted: posted, errors: errors.length },
    summary: `Posted ${posted} depreciation / amortization period(s) for ${month}, about ${dollars(total)} (within your auto-post limit).${lockNote}${leaseNote}`,
    error: errors.length ? errors.slice(0, 10).map((e) => `${e.asset_id} ${e.period}: ${e.error}`).join('; ') : undefined,
  };
}

// ── insurance.amortize ───────────────────────────────────────────────────────

export async function previewInsurance(db: SupabaseClient, asOf: string): Promise<{ companies: CompanyRollup[]; periods: number; amountCents: number; blocked: number }> {
  const { data, error } = await db
    .from('insurance_amortization_schedules')
    .select('id, location_id, total_cents, months, start_date, periods_posted')
    .eq('status', 'ACTIVE');
  if (error) throw new Error(`Could not read insurance schedules: ${error.message}`);
  const rows = (data ?? []) as ScheduleForPlan[];
  const locked = rows.length ? await loadLockedPeriods(db, earliest(rows.map((r) => r.start_date), asOf), asOf) : new Set<string>();
  const plans = rows.map((r) => planSchedule(r, asOf, locked));
  return {
    companies: rollupByCompany(plans),
    periods: plans.reduce((s, p) => s + p.periods, 0),
    amountCents: plans.reduce((s, p) => s + p.amountCents, 0),
    blocked: plans.filter((p) => p.blockedByLock).length,
  };
}

export async function runInsuranceAmortizeJob(ctx: JobContext): Promise<JobResult> {
  const s = scopedOrFail(ctx);
  if (!s.ok) return s.result;
  const asOf = lastDayOfPriorMonth(ctx.slotAt);
  const month = monthOf(asOf);
  const [due, names] = await Promise.all([previewInsurance(s.db, asOf), loadCompanyNames(s.db)]);
  const counts: Record<string, CountValue> = {
    as_of: asOf, periods_due: due.periods, amount_cents: due.amountCents, blocked_by_hard_close: due.blocked,
    companies: due.companies.filter((c) => c.periods > 0).length,
  };
  const lockNote = due.blocked > 0 ? ` ${due.blocked} schedule(s) wait on a hard-closed month.` : '';
  if (due.periods === 0) {
    return { status: 'ok', itemsProcessed: 0, counts: { ...counts, mode: 'nothing_due' }, summary: `No insurance amortization is due through ${asOf}.${lockNote}` };
  }
  const gate = await postingGate(ctx.admin, s.orgId, SCHEDULED_INSURANCE_FEATURE, due.amountCents);
  counts.gate = gate.disposition;
  if (!gate.allowed) {
    await notifyTenantAdmins(ctx.admin, s.orgId, {
      kind: 'scheduler.insurance',
      title: `${month} insurance amortization is ready to post: ${dollars(due.amountCents)}`,
      body: `${due.periods} period(s) — ${companyLine(due.companies, names)}. Post from Insurance.`,
      deepLink: '/insurance',
      dedupeKey: `insurance:${month}`,
    });
    return {
      status: 'ok',
      itemsProcessed: 0,
      counts: { ...counts, mode: 'proposed' },
      summary: `Proposed: ${due.periods} insurance period(s), ${dollars(due.amountCents)} (${companyLine(due.companies, names)}). Post them from Insurance. (${gate.reason})${lockNote}`,
    };
  }
  const run = await runInsuranceAmortizations(s.db, s.orgId, { asOf });
  const failed = run.errors.length;
  return {
    status: failed === 0 ? 'ok' : run.periods_posted > 0 ? 'partial' : 'failed',
    itemsProcessed: run.periods_posted,
    counts: { ...counts, mode: 'posted', periods_posted: run.periods_posted, amount_posted_cents: run.amount_posted_cents, errors: failed },
    summary: `Posted ${run.periods_posted} insurance period(s), ${dollars(run.amount_posted_cents)} (within your auto-post limit).${lockNote}`,
    error: failed ? run.errors.slice(0, 10).map((e) => `${e.schedule_id} ${e.period}: ${e.error}`).join('; ') : undefined,
  };
}
