/**
 * Assemble the base forecast items from loaded inputs (pure). The loader (./load.ts) reads; this
 * module decides — every dedupe and intercompany rule is applied here so it is unit-testable.
 *
 * Order matters for the no-double-counting rule (AC-CF3): document-backed items first (AR, AP,
 * payroll runs, debt, leases, subscriptions, taxes, manual), then subscription / lease vs bill
 * matching, then the budget run-rate LAST, net of everything already counted.
 */

import {
  apItems,
  arItems,
  debtItems,
  dropMatchedByBills,
  estimatedTaxItems,
  leaseItems,
  manualItems,
  normName,
  payrollItems,
  recurringArItems,
  salesTaxItems,
  subscriptionItems,
  type DebtLine,
  type LeaseLine,
  type ManualItemRow,
  type OpenBill,
  type OpenInvoice,
  type PayrollRunRow,
  type PaySchedule,
  type RecurringTemplate,
  type SalesTaxFiling,
  type SubscriptionRow,
  type Window,
} from './sources';
import { buildPayProfiles, type OutcomeRow, type PaidHistoryRow } from './receipt-timing';
import { computeRunRate, countedFromItems, type AccountFamily, type MonthlyBasisRow, type RunRateMonth } from './runrate';
import type { ForecastItem } from './types';

export type RunRateBasis = 'BUDGET' | 'TRAILING_3M' | 'OFF';

export interface CompanySettings {
  minimumCashCents: number;
  alertsEnabled: boolean;
  employerTaxBps: number | null;
  estimatedTaxQuarterlyCents: number | null;
  runrateBasis: RunRateBasis;
  includeUnapprovedBills: boolean;
  /** true when a cash_settings row exists (vs. defaults). */
  configured: boolean;
}

export const DEFAULT_SETTINGS: CompanySettings = {
  minimumCashCents: 0,
  alertsEnabled: true,
  employerTaxBps: null,
  estimatedTaxQuarterlyCents: null,
  runrateBasis: 'BUDGET',
  includeUnapprovedBills: true,
  configured: false,
};

export interface CompanyInput {
  id: string;
  name: string;
  settings: CompanySettings;
}

export interface ForecastInputs {
  companies: CompanyInput[];
  invoices: OpenInvoice[];
  paidHistory: PaidHistoryRow[];
  outcomes: OutcomeRow[];
  recurring: RecurringTemplate[];
  bills: OpenBill[];
  schedules: PaySchedule[];
  runs: PayrollRunRow[];
  debtLines: DebtLine[];
  paidDebtRefs: Set<string>;
  leaseLines: LeaseLine[];
  subscriptions: SubscriptionRow[];
  salesTax: SalesTaxFiling[];
  manual: ManualItemRow[];
  /** Monthly opex basis per company × account × month (budget or trailing actual, per company setting). */
  runRateBasis: MonthlyBasisRow[];
  accountFamilies: Map<string, AccountFamily>;
  accountNames: Map<string, string>;
}

export interface AssembleResult {
  items: ForecastItem[];
  atRiskCents: number;
  atRiskByCompany: Map<string, number>;
  runRate: RunRateMonth[];
  dedupe: { subscriptionsMatchedToBills: number; leasesMatchedToBills: number };
  notes: string[];
}

export function emptyInputs(companies: CompanyInput[] = []): ForecastInputs {
  return {
    companies,
    invoices: [],
    paidHistory: [],
    outcomes: [],
    recurring: [],
    bills: [],
    schedules: [],
    runs: [],
    debtLines: [],
    paidDebtRefs: new Set(),
    leaseLines: [],
    subscriptions: [],
    salesTax: [],
    manual: [],
    runRateBasis: [],
    accountFamilies: new Map(),
    accountNames: new Map(),
  };
}

/** Vendor ↔ company name match (a bill from another company of the org is intercompany). */
export function companyByName(companies: readonly { id: string; name: string }[]): (name: string | null | undefined) => string | null {
  const map = new Map<string, string>();
  for (const c of companies) {
    const k = normName(c.name);
    if (k) map.set(k, c.id);
  }
  return (name) => {
    const k = normName(name);
    return k ? (map.get(k) ?? null) : null;
  };
}

export function assembleItems(inp: ForecastInputs, w: Window, scenarioId: string | null): AssembleResult {
  const notes: string[] = [];
  const settings = new Map(inp.companies.map((c) => [c.id, c.settings]));
  const s = (id: string | null) => (id ? settings.get(id) : undefined) ?? DEFAULT_SETTINGS;
  const companyIds = new Set(inp.companies.map((c) => c.id));
  const vendorCompany = companyByName(inp.companies);

  const profiles = buildPayProfiles(inp.paidHistory, inp.outcomes);
  const ar = arItems(inp.invoices, profiles, w);
  const recurring = recurringArItems(inp.recurring, profiles, w);

  const billsWithIc = inp.bills.map((b) => ({ ...b, counterpartyCompanyId: b.counterpartyCompanyId ?? (() => { const c = vendorCompany(b.vendorName); return c && c !== b.companyId ? c : null; })() }));
  const ap: ForecastItem[] = [];
  for (const c of inp.companies) {
    ap.push(...apItems(billsWithIc.filter((b) => b.companyId === c.id), w, { includeUnapproved: c.settings.includeUnapprovedBills }));
  }

  const payroll = payrollItems(inp.schedules, inp.runs, w, { employerTaxBps: (id) => s(id).employerTaxBps });
  const debt = debtItems(inp.debtLines, inp.paidDebtRefs, w);
  const leases = leaseItems(inp.leaseLines, w);
  const subs = subscriptionItems(inp.subscriptions, w);

  // Sales tax is filed at the org: owned by the one company when there is only one, else org-level.
  const taxOwner = inp.companies.length === 1 ? inp.companies[0].id : null;
  const taxes = salesTaxItems(inp.salesTax, taxOwner, w);
  if (taxes.length && taxOwner === null) notes.push('Sales tax is filed for the whole organization, so it appears in the all-companies view only.');
  for (const c of inp.companies) taxes.push(...estimatedTaxItems(c.id, c.settings.estimatedTaxQuarterlyCents, w));

  const manual = manualItems(inp.manual.filter((m) => companyIds.has(m.companyId)), w, scenarioId);

  // Dedupe rule 3: a subscription / lease matched by an open bill → the bill wins.
  const matched = dropMatchedByBills([...subs, ...leases], ap);
  const subsDropped = matched.dropped.filter((i) => i.category === 'SUBSCRIPTION').length;
  const leasesDropped = matched.dropped.filter((i) => i.category === 'LEASE').length;

  const docItems = [...ar.items, ...recurring, ...ap, ...payroll, ...debt, ...matched.kept, ...taxes, ...manual];

  // Run-rate LAST, net of everything already counted (AC-CF3).
  const covered = new Map<string, Set<AccountFamily>>();
  const cover = (id: string | null, f: AccountFamily) => {
    if (!id) return;
    const set = covered.get(id) ?? new Set<AccountFamily>();
    set.add(f);
    covered.set(id, set);
  };
  for (const sch of inp.schedules) cover(sch.companyId, 'PAYROLL');
  for (const it of docItems) {
    if (it.category === 'PAYROLL' || it.category === 'PAYROLL_TAX') cover(it.companyId, 'PAYROLL');
    if (it.category === 'LEASE') cover(it.companyId, 'RENT_LEASE');
    if (it.category === 'DEBT_SERVICE') cover(it.companyId, 'INTEREST');
  }
  for (const l of inp.leaseLines) cover(l.companyId, 'RENT_LEASE');
  const basis = inp.runRateBasis.filter((b) => companyIds.has(b.companyId) && s(b.companyId).runrateBasis !== 'OFF');
  const rr = computeRunRate({
    basis,
    counted: countedFromItems(docItems),
    families: inp.accountFamilies,
    accountNames: inp.accountNames,
    coveredFamilies: (id) => covered.get(id) ?? new Set<AccountFamily>(),
    today: w.today,
    horizonEnd: w.horizonEnd,
    basisLabel: 'Published budget / trailing actuals',
  });

  // Name the accounts in bill splits for the drill (display only).
  const items = [...docItems, ...rr.items].map((it) =>
    it.accountSplit && !it.breakdown
      ? { ...it, breakdown: it.accountSplit.map((a) => ({ label: inp.accountNames.get(a.accountId) ?? 'Account', cents: a.cents })) }
      : it,
  );

  return {
    items,
    atRiskCents: ar.atRiskCents,
    atRiskByCompany: ar.atRiskByCompany,
    runRate: rr.months,
    dedupe: { subscriptionsMatchedToBills: subsDropped, leasesMatchedToBills: leasesDropped },
    notes,
  };
}
