/**
 * Forecast sources → ForecastItems (pure). One builder per source; the loader (./load.ts) hands
 * each builder plain normalized rows. Every builder clamps dates to [today, horizonEnd] (items
 * beyond the horizon are dropped here and counted by the engine as "beyond horizon" only when the
 * caller passes them through) and never invents an amount.
 *
 * Timing rules: docs/FPB-reports-fpna.md §4.12 table. Dedupe rules (AC-CF3) live here (subscription
 * / lease vs open bill, payroll run on file vs projection, recurring run already invoiced) and in
 * ./runrate.ts (budget run-rate vs everything else).
 */

import { addDays, addMonths, advanceRecurring, daysBetween, maxIso, MONTHS_PER, payDatesAfter, startOfMonth, type PayFrequency, type RecurringFrequency } from './dates';
import { expectReceipt, profileFor, type PayProfiles } from './receipt-timing';
import type { ForecastItem, ItemFlag } from './types';

export interface Window {
  today: string;
  /** Last day of the horizon (inclusive). */
  horizonEnd: string;
}

function inWindow(d: string, w: Window): boolean {
  return d >= w.today && d <= w.horizonEnd;
}

function cents(v: unknown): number {
  const n = Math.round(Number(v ?? 0));
  return Number.isFinite(n) ? n : 0;
}

/** Normalize a counterparty name for intercompany / dedupe matching. */
export function normName(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b(inc|llc|ltd|co|corp|corporation|company|the)\b/g, '').replace(/\s+/g, ' ').trim();
}

// ── AR ──────────────────────────────────────────────────────────────────────────

export interface OpenInvoice {
  id: string;
  companyId: string;
  number: string | null;
  customerId: string | null;
  customerName: string | null;
  dueDate: string;
  balanceCents: number;
  status: string;
  disputed: boolean;
  /** Customer is linked to another company of the org (core.customers.related_location_id). */
  counterpartyCompanyId?: string | null;
}

export interface ArBuild {
  items: ForecastItem[];
  atRiskCents: number;
  atRiskByCompany: Map<string, number>;
}

export function arItems(invoices: readonly OpenInvoice[], profiles: PayProfiles, w: Window): ArBuild {
  const items: ForecastItem[] = [];
  let atRisk = 0;
  const atRiskByCompany = new Map<string, number>();
  for (const inv of invoices) {
    const bal = cents(inv.balanceCents);
    if (bal <= 0 || !inv.dueDate) continue;
    const prof = profileFor(profiles, inv.customerId);
    const e = expectReceipt({ dueDate: inv.dueDate, balanceCents: bal, today: w.today, profile: prof, disputed: inv.disputed });
    atRisk += e.atRiskCents;
    atRiskByCompany.set(inv.companyId, (atRiskByCompany.get(inv.companyId) ?? 0) + e.atRiskCents);
    if (e.expectedCents <= 0) continue;
    const flags: ItemFlag[] = [];
    if (e.daysPastDue > 0) flags.push('OVERDUE');
    if (inv.disputed) flags.push('DISPUTED');
    const basis =
      prof.basis === 'CUSTOMER'
        ? `pays ${Math.abs(prof.medianDaysLate)} days ${prof.medianDaysLate >= 0 ? 'late' : 'early'} (median of ${prof.samples})`
        : prof.basis === 'ORG'
          ? `no history for this customer — org median ${prof.medianDaysLate} days late`
          : 'no payment history — due date';
    items.push({
      key: `ar:${inv.id}`,
      companyId: inv.companyId,
      direction: 'IN',
      category: 'AR',
      date: e.expectedDate,
      amountCents: e.expectedCents,
      grossCents: bal,
      probability: e.probability,
      certainty: 'EXPECTED',
      label: inv.number ? `Invoice ${inv.number}` : 'Invoice',
      party: inv.customerName,
      partyId: inv.customerId,
      source: { kind: 'INVOICE', id: inv.id },
      dueDate: inv.dueDate.slice(0, 10),
      counterpartyCompanyId: inv.counterpartyCompanyId ?? null,
      flags,
      note: `${Math.round(e.probability * 100)}% likely · ${basis}`,
    });
  }
  return { items, atRiskCents: atRisk, atRiskByCompany };
}

export interface RecurringTemplate {
  id: string;
  companyId: string | null;
  name: string;
  customerId: string | null;
  customerName: string | null;
  frequency: RecurringFrequency;
  intervalCount: number;
  nextRunDate: string | null;
  endDate: string | null;
  occurrencesRemaining: number | null;
  runAmountCents: number;
  termsDays: number;
  counterpartyCompanyId?: string | null;
  /** Run dates that already produced an invoice (source_ref) — never double counted. */
  generatedRunDates?: ReadonlySet<string>;
}

export function recurringArItems(templates: readonly RecurringTemplate[], profiles: PayProfiles, w: Window): ForecastItem[] {
  const out: ForecastItem[] = [];
  for (const t of templates) {
    if (!t.companyId || !t.nextRunDate || !(t.runAmountCents > 0)) continue;
    let run = t.nextRunDate.slice(0, 10);
    let left = t.occurrencesRemaining ?? Number.POSITIVE_INFINITY;
    let guard = 0;
    while (guard++ < 120 && left > 0) {
      if (t.endDate && run > t.endDate) break;
      const due = addDays(run, Math.max(0, t.termsDays));
      if (due > addDays(w.horizonEnd, 366)) break;
      if (!t.generatedRunDates?.has(run)) {
        const prof = profileFor(profiles, t.customerId);
        const e = expectReceipt({ dueDate: maxIso(due, w.today), balanceCents: t.runAmountCents, today: w.today, profile: prof });
        // Not-yet-issued invoices: a small extra haircut for the chance the run is skipped.
        const p = Math.round(e.probability * 0.97 * 10_000) / 10_000;
        if (inWindow(e.expectedDate, w)) {
          out.push({
            key: `recurring:${t.id}:${run}`,
            companyId: t.companyId,
            direction: 'IN',
            category: 'RECURRING_AR',
            date: e.expectedDate,
            amountCents: Math.round(t.runAmountCents * p),
            grossCents: t.runAmountCents,
            probability: p,
            certainty: 'EXPECTED',
            label: `${t.name} (run ${run})`,
            party: t.customerName,
            partyId: t.customerId,
            source: { kind: 'RECURRING_INVOICE', id: t.id },
            dueDate: due,
            counterpartyCompanyId: t.counterpartyCompanyId ?? null,
            projected: true,
            note: `Invoice generates ${run}, due ${due}`,
          });
        } else if (e.expectedDate > w.horizonEnd) {
          break;
        }
      }
      left -= 1;
      run = advanceRecurring(run, t.frequency, t.intervalCount);
    }
  }
  return out;
}

// ── AP ──────────────────────────────────────────────────────────────────────────

export interface OpenBill {
  id: string;
  companyId: string;
  number: string | null;
  vendorId: string | null;
  vendorName: string | null;
  dueDate: string | null;
  balanceCents: number;
  status: string;
  scheduledPaymentDate: string | null;
  /** Pay-by date from a waiting pay-run proposal (PAY_RUN agent run). */
  payRunDate?: string | null;
  counterpartyCompanyId?: string | null;
  /** Expense lines (run-rate dedupe). */
  lines?: Array<{ accountId: string | null; amountCents: number }>;
}

export function apItems(bills: readonly OpenBill[], w: Window, opts: { includeUnapproved?: boolean } = {}): ForecastItem[] {
  const out: ForecastItem[] = [];
  for (const b of bills) {
    const bal = cents(b.balanceCents);
    if (bal <= 0) continue;
    if (b.status === 'PENDING' && opts.includeUnapproved === false) continue;
    const flags: ItemFlag[] = [];
    let date: string;
    let certainty: ForecastItem['certainty'] = 'EXPECTED';
    if (b.status === 'SCHEDULED' && b.scheduledPaymentDate) {
      date = b.scheduledPaymentDate.slice(0, 10);
      certainty = 'COMMITTED';
      flags.push('SCHEDULED');
    } else if (b.payRunDate) {
      date = b.payRunDate.slice(0, 10);
      flags.push('PAY_RUN');
    } else {
      date = (b.dueDate ?? w.today).slice(0, 10);
    }
    if (b.dueDate && b.dueDate.slice(0, 10) < w.today) flags.push('OVERDUE');
    if (b.status === 'ON_HOLD') flags.push('ON_HOLD');
    if (b.status === 'PENDING') flags.push('UNAPPROVED');
    date = maxIso(date, w.today);
    if (date > w.horizonEnd) continue;
    // Bill lines carry the account; the bill's balance is split pro rata over them (run-rate dedupe).
    const lines = (b.lines ?? []).filter((l) => l.amountCents > 0);
    const linesTotal = lines.reduce((s, l) => s + l.amountCents, 0);
    out.push({
      key: `ap:${b.id}`,
      companyId: b.companyId,
      direction: 'OUT',
      category: 'AP',
      date,
      amountCents: bal,
      grossCents: bal,
      probability: 1,
      certainty,
      label: b.number ? `Bill ${b.number}` : 'Bill',
      party: b.vendorName,
      partyId: b.vendorId,
      source: { kind: 'BILL', id: b.id },
      dueDate: b.dueDate ? b.dueDate.slice(0, 10) : null,
      counterpartyCompanyId: b.counterpartyCompanyId ?? null,
      accountId: lines.length === 1 ? lines[0].accountId : null,
      accountSplit:
        linesTotal > 0
          ? lines
              .filter((l): l is { accountId: string; amountCents: number } => !!l.accountId)
              .map((l) => ({ accountId: l.accountId, cents: Math.round((bal * l.amountCents) / linesTotal) }))
          : undefined,
      flags,
    });
  }
  return out;
}

// ── payroll ────────────────────────────────────────────────────────────────────

export interface PaySchedule {
  id: string;
  companyId: string | null;
  name: string;
  frequency: PayFrequency;
  anchorDate: string | null;
}

export interface PayrollRunRow {
  id: string;
  scheduleId: string | null;
  companyId: string | null;
  payDate: string;
  status: string;
  grossCents: number;
  netCents: number;
  employerTaxCents: number;
  employeeTaxCents: number;
}

const DONE_RUN = new Set(['APPROVED', 'RELEASED', 'PROCESSING', 'PAID']);
const OPEN_RUN = new Set(['DRAFT', 'PREVIEWED', 'APPROVED', 'RELEASED', 'PROCESSING']);

/** Net pay and taxes of a run: net = gross − employee tax; taxes = employee + employer tax. */
export function splitRun(r: Pick<PayrollRunRow, 'grossCents' | 'netCents' | 'employerTaxCents' | 'employeeTaxCents'>, employerTaxBps: number | null): { net: number; tax: number } {
  const gross = cents(r.grossCents) > 0 ? cents(r.grossCents) : cents(r.netCents) + cents(r.employeeTaxCents);
  const empTax = cents(r.employeeTaxCents);
  let erTax = cents(r.employerTaxCents);
  if (erTax <= 0 && employerTaxBps && employerTaxBps > 0) erTax = Math.round((gross * employerTaxBps) / 10_000);
  return { net: Math.max(0, gross - empTax), tax: Math.max(0, empTax + erTax) };
}

export function payrollItems(
  schedules: readonly PaySchedule[],
  runs: readonly PayrollRunRow[],
  w: Window,
  opts: { employerTaxBps?: (companyId: string) => number | null; lookbackRuns?: number } = {},
): ForecastItem[] {
  const out: ForecastItem[] = [];
  const bps = opts.employerTaxBps ?? (() => null);
  const look = opts.lookbackRuns ?? 3;
  const onFileDates = new Map<string, Set<string>>();

  // 1. Runs on file with a future pay date — committed (approved+) or expected (draft).
  for (const r of runs) {
    if (!OPEN_RUN.has(r.status) || !r.companyId) continue;
    const d = r.payDate.slice(0, 10);
    if (!inWindow(d, w)) continue;
    const { net, tax } = splitRun(r, bps(r.companyId));
    const certainty = r.status === 'DRAFT' || r.status === 'PREVIEWED' ? 'EXPECTED' : 'COMMITTED';
    if (r.scheduleId) {
      const s = onFileDates.get(r.scheduleId) ?? new Set<string>();
      s.add(d);
      onFileDates.set(r.scheduleId, s);
    }
    const base = { companyId: r.companyId, direction: 'OUT' as const, date: d, probability: 1, certainty: certainty as ForecastItem['certainty'], partyId: null, source: { kind: 'PAYROLL_RUN' as const, id: r.id } };
    if (net > 0) out.push({ ...base, key: `payroll-run:${r.id}:net`, category: 'PAYROLL', amountCents: net, grossCents: net, label: `Payroll ${d}`, party: 'Employees' });
    if (tax > 0) out.push({ ...base, key: `payroll-run:${r.id}:tax`, category: 'PAYROLL_TAX', amountCents: tax, grossCents: tax, label: `Payroll taxes ${d}`, party: 'Tax authorities' });
  }

  // 2. Projected runs per active schedule: recent run size × next pay dates.
  for (const s of schedules) {
    const own = runs
      .filter((r) => r.scheduleId === s.id && DONE_RUN.has(r.status) && r.payDate.slice(0, 10) < w.today)
      .sort((a, b) => (a.payDate < b.payDate ? 1 : -1));
    const companyId = s.companyId ?? own.find((r) => r.companyId)?.companyId ?? null;
    if (!companyId) continue;
    const recent = own.slice(0, look);
    if (recent.length === 0) continue; // never invent a payroll size
    let netSum = 0;
    let taxSum = 0;
    for (const r of recent) {
      const sp = splitRun(r, bps(companyId));
      netSum += sp.net;
      taxSum += sp.tax;
    }
    const net = Math.round(netSum / recent.length);
    const tax = Math.round(taxSum / recent.length);
    // Step from the latest pay date on file (done or open) so a run on file isn't skipped over.
    const allDates = runs.filter((r) => r.scheduleId === s.id).map((r) => r.payDate.slice(0, 10));
    const last = allDates.length ? allDates.reduce((a, b) => (a > b ? a : b)) : (s.anchorDate ?? recent[0].payDate.slice(0, 10));
    const taken = onFileDates.get(s.id) ?? new Set<string>();
    for (const d of payDatesAfter(last, s.frequency, w.horizonEnd)) {
      if (d < w.today) continue;
      // A run on file within 3 days replaces the projection for that date (AC-CF2).
      if (Array.from(taken).some((t) => Math.abs(daysBetween(t, d)) <= 3)) continue;
      const base = { companyId, direction: 'OUT' as const, date: d, probability: 1, certainty: 'ESTIMATED' as const, partyId: null, source: { kind: 'PAY_SCHEDULE' as const, id: s.id }, projected: true, note: `${s.name}: average of the last ${recent.length} run${recent.length === 1 ? '' : 's'}` };
      if (net > 0) out.push({ ...base, key: `payroll:${s.id}:${d}:net`, category: 'PAYROLL', amountCents: net, grossCents: net, label: `${s.name} payroll ${d}`, party: 'Employees' });
      if (tax > 0) out.push({ ...base, key: `payroll:${s.id}:${d}:tax`, category: 'PAYROLL_TAX', amountCents: tax, grossCents: tax, label: `${s.name} payroll taxes ${d}`, party: 'Tax authorities' });
    }
  }
  return out;
}

// ── debt, leases, subscriptions ─────────────────────────────────────────────────

export interface DebtLine {
  instrumentId: string;
  instrumentName: string;
  lender: string | null;
  companyId: string | null;
  period: number;
  date: string;
  paymentCents: number;
  interestCents: number;
  principalCents: number;
}

/** Scheduled, not-yet-posted debt service. `paidRefs` = `debt:payment:{instrument}:{period}`. */
export function debtItems(lines: readonly DebtLine[], paidRefs: ReadonlySet<string>, w: Window): ForecastItem[] {
  const out: ForecastItem[] = [];
  for (const l of lines) {
    if (!l.companyId || !(l.paymentCents > 0)) continue;
    if (paidRefs.has(`debt:payment:${l.instrumentId}:${l.period}`)) continue;
    const overdue = l.date < w.today;
    const date = maxIso(l.date, w.today);
    if (date > w.horizonEnd) continue;
    out.push({
      key: `debt:${l.instrumentId}:${l.period}`,
      companyId: l.companyId,
      direction: 'OUT',
      category: 'DEBT_SERVICE',
      date,
      amountCents: l.paymentCents,
      grossCents: l.paymentCents,
      probability: 1,
      certainty: 'COMMITTED',
      label: `${l.instrumentName} · payment ${l.period}`,
      party: l.lender,
      partyId: null,
      source: { kind: 'DEBT', id: l.instrumentId },
      dueDate: l.date,
      flags: overdue ? ['OVERDUE'] : [],
      breakdown: [
        { label: 'Interest', cents: l.interestCents },
        { label: 'Principal', cents: l.principalCents },
      ],
    });
  }
  return out;
}

export interface LeaseLine {
  leaseId: string;
  lessor: string;
  description: string | null;
  companyId: string;
  period: number;
  periodDate: string;
  paymentCents: number;
  frequency: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
  timing: 'ARREARS' | 'ADVANCE';
}

/** Lease cash date: ARREARS → the schedule line's date; ADVANCE → the 1st of the period's first month. */
export function leasePaymentDate(l: Pick<LeaseLine, 'periodDate' | 'frequency' | 'timing'>): string {
  if (l.timing === 'ARREARS') return l.periodDate.slice(0, 10);
  // The period is the `months` calendar months ending in the line's month; it starts on the 1st.
  const months = MONTHS_PER[l.frequency] ?? 1;
  return addMonths(startOfMonth(l.periodDate.slice(0, 10)), -(months - 1));
}

export function leaseItems(lines: readonly LeaseLine[], w: Window): ForecastItem[] {
  const out: ForecastItem[] = [];
  for (const l of lines) {
    if (!(l.paymentCents > 0)) continue;
    const date = leasePaymentDate(l);
    if (!inWindow(date, w)) continue;
    out.push({
      key: `lease:${l.leaseId}:${l.period}`,
      companyId: l.companyId,
      direction: 'OUT',
      category: 'LEASE',
      date,
      amountCents: l.paymentCents,
      grossCents: l.paymentCents,
      probability: 1,
      certainty: 'COMMITTED',
      label: l.description ? `${l.description}` : `Lease payment ${l.period}`,
      party: l.lessor,
      partyId: null,
      source: { kind: 'LEASE', id: l.leaseId },
    });
  }
  return out;
}

export interface SubscriptionRow {
  id: string;
  companyId: string | null;
  vendorId: string | null;
  vendorName: string;
  product: string | null;
  amountCents: number;
  cadence: string;
  nextRenewalDate: string | null;
  lastChargedDate: string | null;
  status: string;
}

const LIVE_SUBSCRIPTION = new Set(['ACTIVE', 'KEPT', 'UNDER_REVIEW', 'DETECTED']);

export function subscriptionItems(subs: readonly SubscriptionRow[], w: Window): ForecastItem[] {
  const out: ForecastItem[] = [];
  for (const s of subs) {
    if (!s.companyId || !LIVE_SUBSCRIPTION.has(s.status) || !(s.amountCents > 0)) continue;
    const months = MONTHS_PER[s.cadence] ?? null;
    let d = s.nextRenewalDate?.slice(0, 10) ?? (s.lastChargedDate && months ? addMonths(s.lastChargedDate.slice(0, 10), months) : null);
    if (!d) continue;
    let guard = 0;
    while (months && d < w.today && guard++ < 60) d = addMonths(d, months);
    while (d <= w.horizonEnd && guard++ < 80) {
      if (d >= w.today) {
        out.push({
          key: `subscription:${s.id}:${d}`,
          companyId: s.companyId,
          direction: 'OUT',
          category: 'SUBSCRIPTION',
          date: d,
          amountCents: s.amountCents,
          grossCents: s.amountCents,
          probability: 1,
          certainty: s.status === 'DETECTED' ? 'ESTIMATED' : 'EXPECTED',
          label: s.product ? `${s.vendorName} — ${s.product}` : s.vendorName,
          party: s.vendorName,
          partyId: s.vendorId,
          source: { kind: 'SUBSCRIPTION', id: s.id },
          flags: s.status === 'DETECTED' ? ['UNCONFIRMED'] : [],
        });
      }
      if (!months) break;
      d = addMonths(d, months);
    }
  }
  return out;
}

/**
 * Dedupe rule 3: a subscription / lease payment within ±7 days of an open bill to the same vendor
 * (by id, else normalized name) for an amount within 10% is dropped — the bill is the document.
 */
export function dropMatchedByBills(items: readonly ForecastItem[], bills: readonly ForecastItem[], days = 7, tolerance = 0.1): { kept: ForecastItem[]; dropped: ForecastItem[] } {
  const kept: ForecastItem[] = [];
  const dropped: ForecastItem[] = [];
  const used = new Set<string>();
  for (const it of items) {
    if (it.category !== 'SUBSCRIPTION' && it.category !== 'LEASE') {
      kept.push(it);
      continue;
    }
    const match = bills.find(
      (b) =>
        !used.has(b.key) &&
        b.companyId === it.companyId &&
        ((it.partyId && b.partyId === it.partyId) || (normName(b.party) !== '' && normName(b.party) === normName(it.party))) &&
        Math.abs(daysBetween(b.date, it.date)) <= days &&
        Math.abs(b.grossCents - it.grossCents) <= Math.round(it.grossCents * tolerance),
    );
    if (match) {
      used.add(match.key);
      dropped.push(it);
    } else kept.push(it);
  }
  return { kept, dropped };
}

// ── taxes ──────────────────────────────────────────────────────────────────────

export interface SalesTaxFiling {
  jurisdiction: string;
  frequency: 'monthly' | 'quarterly' | 'annual';
  periodEnd: string;
  dueDate: string;
  remittedCents: number;
}

const FILING_MONTHS: Readonly<Record<SalesTaxFiling['frequency'], number>> = { monthly: 1, quarterly: 3, annual: 12 };

/**
 * Next sales-tax payments per jurisdiction from the filing calendar: the period after the latest
 * filing, due on the same offset; amount = mean of the last 3 remitted. `companyId` null = org-level.
 */
export function salesTaxItems(filings: readonly SalesTaxFiling[], companyId: string | null, w: Window): ForecastItem[] {
  const out: ForecastItem[] = [];
  const byJur = new Map<string, SalesTaxFiling[]>();
  for (const f of filings) {
    const list = byJur.get(f.jurisdiction) ?? [];
    list.push(f);
    byJur.set(f.jurisdiction, list);
  }
  for (const [jur, list] of byJur) {
    list.sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : -1));
    const latest = list[0];
    const months = FILING_MONTHS[latest.frequency] ?? 3;
    const remitted = list.filter((f) => f.remittedCents > 0).slice(0, 3);
    if (remitted.length === 0) continue;
    const amount = Math.round(remitted.reduce((s, f) => s + f.remittedCents, 0) / remitted.length);
    let due = latest.dueDate.slice(0, 10);
    let guard = 0;
    while (guard++ < 30) {
      due = addMonths(due, months);
      if (due > w.horizonEnd) break;
      if (due < w.today) continue;
      out.push({
        key: `salestax:${jur}:${due}`,
        companyId,
        direction: 'OUT',
        category: 'TAX',
        date: due,
        amountCents: amount,
        grossCents: amount,
        probability: 1,
        certainty: 'ESTIMATED',
        label: `Sales tax — ${jur}`,
        party: jur,
        partyId: null,
        source: { kind: 'SALES_TAX', id: null },
        note: `Average of the last ${remitted.length} remittance${remitted.length === 1 ? '' : 's'}`,
      });
    }
  }
  return out;
}

/** Estimated income tax: quarterly amount on 15 Apr / 15 Jun / 15 Sep / 15 Jan. */
export function estimatedTaxItems(companyId: string, quarterlyCents: number | null, w: Window): ForecastItem[] {
  if (!quarterlyCents || quarterlyCents <= 0) return [];
  const out: ForecastItem[] = [];
  const y0 = Number(w.today.slice(0, 4));
  for (const y of [y0, y0 + 1]) {
    for (const md of ['01-15', '04-15', '06-15', '09-15']) {
      const d = `${y}-${md}`;
      if (!inWindow(d, w)) continue;
      out.push({
        key: `esttax:${companyId}:${d}`,
        companyId,
        direction: 'OUT',
        category: 'TAX',
        date: d,
        amountCents: quarterlyCents,
        grossCents: quarterlyCents,
        probability: 1,
        certainty: 'ESTIMATED',
        label: 'Estimated income tax',
        party: 'Tax authorities',
        partyId: null,
        source: { kind: 'ESTIMATED_TAX', id: null },
      });
    }
  }
  return out;
}

// ── manual items ────────────────────────────────────────────────────────────────

export interface ManualItemRow {
  id: string;
  companyId: string;
  scenarioId: string | null;
  direction: 'IN' | 'OUT';
  category: ForecastItem['category'];
  label: string;
  expectedDate: string;
  amountCents: number;
  probabilityBps: number;
  recurrence: 'NONE' | 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'QUARTERLY';
  recurrenceEnd: string | null;
  counterpartyCompanyId: string | null;
  accountId: string | null;
  note: string | null;
}

export function manualItems(rows: readonly ManualItemRow[], w: Window, scenarioId: string | null): ForecastItem[] {
  const out: ForecastItem[] = [];
  for (const r of rows) {
    if (r.scenarioId && r.scenarioId !== scenarioId) continue;
    const p = Math.max(0, Math.min(1, r.probabilityBps / 10_000));
    let d = r.expectedDate.slice(0, 10);
    let guard = 0;
    const stop = r.recurrenceEnd ? (r.recurrenceEnd < w.horizonEnd ? r.recurrenceEnd : w.horizonEnd) : w.horizonEnd;
    while (d <= stop && guard++ < 120) {
      if (d >= w.today) {
        out.push({
          key: `manual:${r.id}:${d}`,
          companyId: r.companyId,
          direction: r.direction,
          category: r.category,
          date: d,
          amountCents: Math.round(r.amountCents * p),
          grossCents: r.amountCents,
          probability: p,
          certainty: p >= 1 ? 'COMMITTED' : 'EXPECTED',
          label: r.label,
          party: null,
          partyId: null,
          source: { kind: 'MANUAL', id: r.id },
          counterpartyCompanyId: r.counterpartyCompanyId,
          accountId: r.accountId,
          note: r.note,
        });
      }
      if (r.recurrence === 'NONE') break;
      d =
        r.recurrence === 'WEEKLY'
          ? addDays(d, 7)
          : r.recurrence === 'BIWEEKLY'
            ? addDays(d, 14)
            : r.recurrence === 'MONTHLY'
              ? addMonths(r.expectedDate.slice(0, 10), guard)
              : addMonths(r.expectedDate.slice(0, 10), 3 * guard);
    }
  }
  return out;
}
