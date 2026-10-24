/**
 * MetricDataSource over the 3A report-engine balances store (migration 185,
 * lib/reports/engine). STUB until the lead wires it: it is complete and tested against
 * a structural `PeriodBalanceFeed` that mirrors the subset of 3A's `EngineData` the
 * metrics need, so the lead can pass `loadEngineData(...)`'s result straight in without
 * this slice importing 3A's in-flux files.
 *
 * GL classes and budgets come from the feed; sub-ledger inputs (AR/AP aging, jobs,
 * headcount, dealer, close cycle) are delegated to another source — normally
 * `createGlQuerySource` — because the balances store holds ledger balances only.
 */

import { addMonths, monthOfIso, type MonthKey } from '@/lib/analytics/months';
import { classifyAccounts, type AccountMeta } from '../classes';
import type { DataSourceRequest, MetricDataSource } from '../data-source';
import { foldBudgets, foldGl, type BudgetLine, type GlLine } from '../fold';
import type { CompanyDataset, MetricDataset, OperationalKey } from '../types';

/** Structural subset of lib/reports/engine/types.ts `EngineData`. */
export interface PeriodBalanceFeed {
  orgFiscalYearStartMonth: number;
  accounts: { id: string; number: string; name: string; type: string; subType: string; isBank: boolean; roles: string[] }[];
  companies: { id: string; name: string }[];
  /** `period` 'YYYY-MM-01', or null for the opening bucket (before the requested from). */
  balances: { companyId: string; accountId: string; period: string | null; kind: string; debit: number; credit: number }[];
  /** Approved-version budgets only, natural sign. */
  budgets: { companyId: string; accountId: string; period: string; naturalCents: number }[];
  periodStatus: { companyId: string; period: string; status: 'OPEN' | 'SOFT_CLOSE' | 'HARD_CLOSE' }[];
  ownership: { entityId: string; method: 'FULL' | 'EQUITY' | 'NONE'; ownershipPercent: number }[];
}

export interface PeriodBalanceSourceOptions {
  /** Load the feed for companies × [from, to] with an opening bucket before `from`. */
  loadFeed(req: { companyIds: string[]; from: MonthKey; to: MonthKey; includeBudgets: boolean }): Promise<PeriodBalanceFeed>;
  /** Fiscal years with an APPROVED budget per company (3A feeds approved budgets only). */
  approvedBudgetYears?(companyIds: string[]): Promise<Map<string, number[]>>;
  /** Supplies operational (sub-ledger) inputs; omit and they read "Not on file". */
  operational?: MetricDataSource;
  /** Org-local today. */
  today: string;
}

export function datasetFromFeed(
  feed: PeriodBalanceFeed,
  req: DataSourceRequest,
  latestMonth: MonthKey,
  approved: Map<string, number[]> = new Map(),
): MetricDataset {
  const accounts: AccountMeta[] = feed.accounts.map((a) => ({ id: a.id, number: a.number, name: a.name, type: a.type, subType: a.subType, isBank: a.isBank, isCreditCard: false }));
  const roles = new Map<string, string[]>();
  for (const a of feed.accounts) for (const r of a.roles) roles.set(r, [...(roles.get(r) ?? []), a.id]);
  const mapping = classifyAccounts(accounts, roles);

  const lines: GlLine[] = feed.balances.map((b) => ({
    companyId: b.companyId,
    accountId: b.accountId,
    month: b.period === null ? null : monthOfIso(b.period),
    kind: b.kind,
    debitCents: b.debit,
    creditCents: b.credit,
  }));
  const gl = foldGl(lines, mapping, req.from);
  const budgetLines: BudgetLine[] = feed.budgets.map((b) => ({ companyId: b.companyId, accountId: b.accountId, month: monthOfIso(b.period), naturalCents: b.naturalCents }));
  const budgets = foldBudgets(budgetLines, mapping);
  const ownership = new Map(feed.ownership.map((o) => [o.entityId, o.method === 'NONE' ? 0 : o.ownershipPercent]));

  const companies: CompanyDataset[] = feed.companies
    .filter((c) => req.companyIds.includes(c.id))
    .map((c) => {
      const hard = feed.periodStatus.filter((p) => p.companyId === c.id && p.status === 'HARD_CLOSE').map((p) => monthOfIso(p.period));
      const hasOpening = feed.balances.some((b) => b.companyId === c.id && b.period === null && (b.debit !== 0 || b.credit !== 0));
      const first = hasOpening ? addMonths(req.from, -1) : gl.firstMonth.get(c.id) ?? null;
      return {
        id: c.id,
        name: c.name,
        ownershipPct: ownership.has(c.id) ? (ownership.get(c.id) as number) : null,
        inGroupFrom: null,
        firstMonthOnFile: first,
        closedThrough: hard.length > 0 ? hard.sort()[hard.length - 1] : null,
        gl: gl.byCompany.get(c.id) ?? {},
        budget: budgets.get(c.id) ?? {},
        budgetApprovedFy: approved.get(c.id) ?? [],
        operational: {},
      };
    });

  return {
    source: 'period-balances-3a',
    fyStartMonth: feed.orgFiscalYearStartMonth || 1,
    rangeStart: req.from,
    latestMonth,
    companies,
    classMapping: mapping,
    operationalAvailable: [],
  };
}

export function createPeriodBalanceSource(opts: PeriodBalanceSourceOptions): MetricDataSource {
  let fy: number | null = null;
  return {
    id: 'period-balances-3a',
    async fiscalYearStartMonth() {
      if (fy !== null) return fy;
      if (opts.operational) {
        fy = await opts.operational.fiscalYearStartMonth();
        return fy;
      }
      const probe = await opts.loadFeed({ companyIds: [], from: monthOfIso(opts.today), to: monthOfIso(opts.today), includeBudgets: false });
      fy = probe.orgFiscalYearStartMonth || 1;
      return fy;
    },
    async load(req) {
      const latestMonth = monthOfIso(opts.today);
      const to = req.to > latestMonth ? latestMonth : req.to;
      const [feed, approved, ops] = await Promise.all([
        opts.loadFeed({ companyIds: req.companyIds, from: req.from, to, includeBudgets: req.needsBudget }),
        req.needsBudget && opts.approvedBudgetYears ? opts.approvedBudgetYears(req.companyIds) : Promise.resolve(new Map<string, number[]>()),
        opts.operational && (req.operational.length > 0 || req.customerRevenue || req.vendorSpend)
          ? opts.operational.load({ ...req, needsBudget: false })
          : Promise.resolve(null),
      ]);
      const ds = datasetFromFeed(feed, { ...req, to }, latestMonth, approved);
      if (!ops) return ds;
      const byId = new Map(ops.companies.map((c) => [c.id, c]));
      return {
        ...ds,
        companies: ds.companies.map((c) => {
          const o = byId.get(c.id);
          return o ? { ...c, operational: o.operational, customerRevenue: o.customerRevenue, vendorSpend: o.vendorSpend, inGroupFrom: o.inGroupFrom } : c;
        }),
        operationalAvailable: ops.operationalAvailable.filter((k: OperationalKey) => req.operational.includes(k) || k === 'credit_sales' || k === 'purchases'),
      };
    },
  };
}
