/**
 * Operator Console — cross-tenant BUSINESS metrics for the platform operator.
 *
 * This is the PLATFORM plane: the operator (MeritBooks) looking across every tenant
 * to see the health of the business it runs — how many tenants it serves, what it
 * earns, and what those tenants COST it to run (AI/API spend, storage). It is NOT a
 * tenant's book of record and it NEVER leaks one tenant's figures into another tenant's
 * view: every number here is an explicit cross-tenant AGGREGATE, produced only for a
 * confirmed platform-staff caller on the admin (service-role) client.
 *
 * WHAT IS REAL vs NOT-YET-INSTRUMENTED (be honest — canon, Rule 3/Rule 10):
 *   • Tenants / seats      — REAL: core.organizations + core.memberships.
 *   • Realized fee revenue — REAL: derived from the payment sub-ledger + each merchant's
 *                            fee schedule (see ./fee-revenue.ts — the operator's earned
 *                            processor income).
 *   • AI / API cost        — REAL: SUM(core.ai_usage_log.cost_cents) — the metering ledger.
 *   • Storage usage        — REAL: SUM(public.documents.size_bytes) — bytes actually held.
 *   • Storage COST         — ESTIMATE: usage × a labeled per-GB-month rate constant.
 *   • Subscription revenue — LIST-PRICE, COMPUTED: each tenant's plan (core.organizations
 *                            .billing_plan / .custom_mrr_cents) priced against its active
 *                            company count (active core.locations) through the shared,
 *                            deterministic pricing model (lib/billing/pricing). This is
 *                            LIST-PRICE MRR — what each tenant WOULD be billed under its
 *                            plan. Live billing/charging of tenants is NOT wired; no money
 *                            moves. Labeled "list-price MRR (computed)" everywhere it shows.
 *
 * All money is bigint cents. Storage is bytes (a plain count, not money).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { computeFeeRevenue, type FeeRevenueReport, type FeeRevenuePeriod } from './fee-revenue';
import { planFor, planMrrCents, type BillingPlan } from '@/lib/billing/pricing';

/**
 * Estimated blended storage cost, in cents per GB-month. Labeled an ESTIMATE
 * everywhere it surfaces — object storage list price is ~$0.021/GB-month; we round to
 * a conservative round number. This is the ONLY non-measured cost line and it is always
 * presented as "estimated". Never book this to a ledger.
 */
export const STORAGE_COST_PER_GB_MONTH_CENTS = 2.5; // ≈ $0.025 / GB / month (estimate)
const BYTES_PER_GB = 1024 * 1024 * 1024;

const PAGE = 1000;

export interface TenantSummary {
  orgId: string;
  orgName: string;
  onboarded: boolean; // setup_complete
  createdAt: string | null;
  activeSeats: number; // active memberships
  aiCostCents: number; // AI/API spend in the window
  storageBytes: number; // documents held (point-in-time snapshot)
  realizedFeeCents: number; // processor fee earned in the window
  billingPlan: BillingPlan; // subscription plan
  activeCompanies: number; // active core.locations (billable entities)
  listPriceMrrCents: number; // computed list-price MRR under the plan (NOT charged)
}

export interface SignupPoint {
  month: string; // YYYY-MM
  newTenants: number; // orgs created that month
  cumulativeTenants: number; // running total at month end
}

export interface OperatorOverview {
  window: { from: string | null; to: string | null };
  tenants: {
    total: number; // every org = a subscription (for now)
    onboarded: number; // setup_complete = true
    activeSeats: number; // active memberships across all tenants
    newInWindow: number; // orgs created within [from,to]
    signupTrend: SignupPoint[]; // last 12 buckets (or fewer)
    recent: { orgId: string; orgName: string; createdAt: string | null; onboarded: boolean }[];
  };
  revenue: {
    realizedFeeCents: number; // REAL — processor fee earned in the window
    grossProcessedCents: number; // gross payment volume (context for the fee)
    // LIST-PRICE, COMPUTED — each tenant's plan priced against its active company count
    // through the shared pricing model. This is what tenants WOULD be billed; live
    // charging is NOT wired, so no money moves against this figure.
    subscriptionMrrCents: number; // Σ list-price MRR across tenants
    subscriptionArrCents: number; // subscriptionMrrCents × 12
    subscriptionStatus: 'list_price_computed';
    subscriptionBillingActivated: false; // charging is NOT wired
  };
  costs: {
    aiCostCents: number; // REAL — SUM(ai_usage_log.cost_cents) in the window
    aiCallCount: number; // rows metered in the window
    storageBytes: number; // REAL — SUM(documents.size_bytes) snapshot
    storageDocCount: number;
    storageCostCentsEstimate: number; // ESTIMATE — usage × rate constant
    storageCostIsEstimate: true;
    totalInstrumentedCostCents: number; // aiCost + estimated storage cost
  };
  perTenant: TenantSummary[];
  meta: {
    generatedAt: string;
    storageRatePerGbMonthCents: number;
    // A truthful ledger of which lines are measured vs estimated vs missing.
    dataSources: {
      tenants: 'core.organizations';
      seats: 'core.memberships';
      realizedFee: 'derived_from_payment_subledger';
      aiCost: 'core.ai_usage_log.cost_cents';
      storage: 'public.documents.size_bytes';
      storageCost: 'estimated';
      subscriptionRevenue: 'list_price_computed';
    };
  };
}

interface OrgRow {
  id: string;
  name: string | null;
  setup_complete: boolean | null;
  created_at: string | null;
  billing_plan: string | null;
  custom_mrr_cents: number | string | null;
}

/** Sum a bigint column per-org across a paged, optionally date-windowed table. */
async function sumByOrg(
  db: SupabaseClient,
  opts: {
    schema?: 'core' | 'public';
    table: string;
    valueCol: string;
    dateCol?: string;
    from?: string | null;
    to?: string | null;
  },
): Promise<{ byOrg: Map<string, number>; total: number; rowCount: number }> {
  const byOrg = new Map<string, number>();
  let total = 0;
  let rowCount = 0;

  const cols = `org_id, ${opts.valueCol}`;
  for (let offset = 0; ; offset += PAGE) {
    const base = opts.schema === 'core' ? db.schema('core') : db;
    let q = base
      .from(opts.table)
      .select(cols)
      .order('org_id', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (opts.dateCol && opts.from) q = q.gte(opts.dateCol, opts.from);
    if (opts.dateCol && opts.to) q = q.lte(opts.dateCol, `${opts.to}T23:59:59.999Z`);

    const { data, error } = await q;
    if (error) throw new Error(`${opts.table} read failed: ${error.message}`);
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    for (const r of rows) {
      const orgId = String(r.org_id ?? '');
      if (!orgId) continue;
      const v = Number(r[opts.valueCol] ?? 0);
      if (!Number.isFinite(v)) continue;
      byOrg.set(orgId, (byOrg.get(orgId) ?? 0) + v);
      total += v;
      rowCount += 1;
    }
    if (rows.length < PAGE) break;
  }
  return { byOrg, total, rowCount };
}

/** Count active memberships per org (status = 'active'), paged. */
async function activeSeatsByOrg(db: SupabaseClient): Promise<Map<string, number>> {
  const byOrg = new Map<string, number>();
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db
      .schema('core')
      .from('memberships')
      .select('org_id, status')
      .eq('status', 'active')
      .order('org_id', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`memberships read failed: ${error.message}`);
    const rows = (data ?? []) as { org_id: string }[];
    for (const r of rows) {
      const orgId = String(r.org_id ?? '');
      if (!orgId) continue;
      byOrg.set(orgId, (byOrg.get(orgId) ?? 0) + 1);
    }
    if (rows.length < PAGE) break;
  }
  return byOrg;
}

/** Count ACTIVE companies (core.locations where is_active) per org, paged. */
async function activeCompaniesByOrg(db: SupabaseClient): Promise<Map<string, number>> {
  const byOrg = new Map<string, number>();
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db
      .schema('core')
      .from('locations')
      .select('org_id, is_active')
      .eq('is_active', true)
      .order('org_id', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`locations read failed: ${error.message}`);
    const rows = (data ?? []) as { org_id: string }[];
    for (const r of rows) {
      const orgId = String(r.org_id ?? '');
      if (!orgId) continue;
      byOrg.set(orgId, (byOrg.get(orgId) ?? 0) + 1);
    }
    if (rows.length < PAGE) break;
  }
  return byOrg;
}

/** Build the last-12-month signup trend (cumulative tenant count) from org created_at. */
function buildSignupTrend(orgs: OrgRow[]): SignupPoint[] {
  const perMonth = new Map<string, number>();
  for (const o of orgs) {
    if (!o.created_at) continue;
    const m = o.created_at.slice(0, 7); // YYYY-MM
    perMonth.set(m, (perMonth.get(m) ?? 0) + 1);
  }
  // Materialize the trailing 12 calendar months so the chart has an even axis.
  const now = new Date();
  const months: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  // Cumulative total is every org created on/before each bucket's end.
  const priorTotal = (endMonth: string): number =>
    orgs.filter((o) => o.created_at && o.created_at.slice(0, 7) <= endMonth).length;

  return months.map((month) => ({
    month,
    newTenants: perMonth.get(month) ?? 0,
    cumulativeTenants: priorTotal(month),
  }));
}

/**
 * Build the full operator business overview. `db` MUST be an admin (service-role)
 * client — this is a legitimate cross-tenant platform aggregate. The route confirms
 * platform staff before calling in. Returns explicit aggregates only; no per-tenant
 * figure is ever surfaced outside the operator console.
 */
export async function computeOperatorOverview(
  db: SupabaseClient,
  period: FeeRevenuePeriod,
): Promise<OperatorOverview> {
  // Fetch orgs (all — the tenant roster is small relative to metering rows).
  const orgsRes = await db
    .schema('core')
    .from('organizations')
    .select('id, name, setup_complete, created_at, billing_plan, custom_mrr_cents')
    .order('created_at', { ascending: false });
  if (orgsRes.error) throw new Error(`organizations read failed: ${orgsRes.error.message}`);
  const orgs = (orgsRes.data ?? []) as OrgRow[];
  const orgName = new Map<string, string>();
  for (const o of orgs) orgName.set(o.id, o.name ?? 'Unnamed tenant');

  // Parallelize the heavy aggregates.
  const [seats, companies, ai, storage, fee]: [
    Map<string, number>,
    Map<string, number>,
    { byOrg: Map<string, number>; total: number; rowCount: number },
    { byOrg: Map<string, number>; total: number; rowCount: number },
    FeeRevenueReport,
  ] = await Promise.all([
    activeSeatsByOrg(db),
    activeCompaniesByOrg(db),
    sumByOrg(db, {
      schema: 'core',
      table: 'ai_usage_log',
      valueCol: 'cost_cents',
      dateCol: 'occurred_at',
      from: period.from,
      to: period.to,
    }),
    // Storage is a point-in-time snapshot of what is currently held — NOT windowed.
    sumByOrg(db, { schema: 'public', table: 'documents', valueCol: 'size_bytes' }),
    computeFeeRevenue(db, period),
  ]);

  const feeByOrg = new Map<string, number>();
  for (const t of fee.byTenant) feeByOrg.set(t.orgId, t.feeCents);

  // Per-tenant table: union of every org (so a tenant with zero activity still shows).
  // List-price MRR is each tenant's plan priced against its active company count through
  // the shared, deterministic pricing model — NOT a charge (no billing is wired).
  const perTenant: TenantSummary[] = orgs
    .map((o) => {
      const { plan, customCents } = planFor(o);
      const activeCompanies = companies.get(o.id) ?? 0;
      return {
        orgId: o.id,
        orgName: orgName.get(o.id) ?? 'Unnamed tenant',
        onboarded: o.setup_complete === true,
        createdAt: o.created_at,
        activeSeats: seats.get(o.id) ?? 0,
        aiCostCents: ai.byOrg.get(o.id) ?? 0,
        storageBytes: storage.byOrg.get(o.id) ?? 0,
        realizedFeeCents: feeByOrg.get(o.id) ?? 0,
        billingPlan: plan,
        activeCompanies,
        listPriceMrrCents: planMrrCents(plan, activeCompanies, customCents),
      };
    })
    .sort(
      (a, b) =>
        b.realizedFeeCents - a.realizedFeeCents ||
        b.aiCostCents - a.aiCostCents ||
        b.storageBytes - a.storageBytes,
    );

  const totalActiveSeats = [...seats.values()].reduce((s, n) => s + n, 0);
  const totalListPriceMrrCents = perTenant.reduce((s, t) => s + t.listPriceMrrCents, 0);
  const newInWindow = orgs.filter(
    (o) =>
      o.created_at &&
      (!period.from || o.created_at.slice(0, 10) >= period.from) &&
      (!period.to || o.created_at.slice(0, 10) <= period.to),
  ).length;

  const storageCostCentsEstimate = Math.round(
    (storage.total / BYTES_PER_GB) * STORAGE_COST_PER_GB_MONTH_CENTS,
  );
  const totalInstrumentedCostCents = ai.total + storageCostCentsEstimate;

  return {
    window: { from: period.from, to: period.to },
    tenants: {
      total: orgs.length,
      onboarded: orgs.filter((o) => o.setup_complete === true).length,
      activeSeats: totalActiveSeats,
      newInWindow,
      signupTrend: buildSignupTrend(orgs),
      recent: orgs.slice(0, 8).map((o) => ({
        orgId: o.id,
        orgName: orgName.get(o.id) ?? 'Unnamed tenant',
        createdAt: o.created_at,
        onboarded: o.setup_complete === true,
      })),
    },
    revenue: {
      realizedFeeCents: fee.totals.feeCents,
      grossProcessedCents: fee.totals.grossCents,
      subscriptionMrrCents: totalListPriceMrrCents, // Σ list-price MRR (computed, not charged)
      subscriptionArrCents: totalListPriceMrrCents * 12,
      subscriptionStatus: 'list_price_computed',
      subscriptionBillingActivated: false,
    },
    costs: {
      aiCostCents: ai.total,
      aiCallCount: ai.rowCount,
      storageBytes: storage.total,
      storageDocCount: storage.rowCount,
      storageCostCentsEstimate,
      storageCostIsEstimate: true,
      totalInstrumentedCostCents,
    },
    perTenant,
    meta: {
      generatedAt: new Date().toISOString(),
      storageRatePerGbMonthCents: STORAGE_COST_PER_GB_MONTH_CENTS,
      dataSources: {
        tenants: 'core.organizations',
        seats: 'core.memberships',
        realizedFee: 'derived_from_payment_subledger',
        aiCost: 'core.ai_usage_log.cost_cents',
        storage: 'public.documents.size_bytes',
        storageCost: 'estimated',
        subscriptionRevenue: 'list_price_computed',
      },
    },
  };
}
