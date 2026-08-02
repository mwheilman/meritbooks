/**
 * Covenant ledger resolver — turns the owned GL into the deterministic engine's
 * inputs. RLS-scoped (runs as the user); NEVER calls the model. Every figure the
 * covenant value is built from is computed here, in code, from POSTED journal
 * lines, and returned as a transparent `components` breakdown so a human can see
 * exactly what fed the ratio.
 *
 * Families are identified BY TYPE / SUB-TYPE / NAME-ROLE, never by a hard-coded
 * account number (canon §2: reference accounts by role; high numbers may not exist).
 * All money is bigint cents. Missing data degrades to `undefined` inputs, which the
 * pure engine reads as "not computable" (band UNKNOWN) — the monitor never breaks.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildForecast,
  type ForecastCashflowItem,
} from '@/lib/cash/forecast';
import type { CovenantInputs } from './compute';

export interface CovenantMeasurementConfig {
  /** Trailing window (months) for the P&L flows feeding EBITDA / interest. Default 12. */
  trailingMonths?: number;
  /** Scheduled principal amortization over the window (cents) — not in the P&L. */
  annualPrincipalCents?: number;
  /** Fixed-charge add-ons for FCCR (rent / operating leases), cents. */
  fixedChargeAddonCents?: number;
  /** Undrawn revolver availability added to liquidity, cents. */
  revolverAvailabilityCents?: number;
  /** Intangibles/goodwill to subtract for tangible net worth, cents (on top of name-matched). */
  intangiblesCents?: number;
  /** LEVERAGE: net funded debt of cash (default true) vs gross. */
  netOfCash?: boolean;
  /** CUSTOM covenant explicit numerator / denominator (cents). */
  numeratorCents?: number;
  denominatorCents?: number;
}

export interface CovenantComponents {
  revenueCents: number;
  cogsCents: number;
  opexCents: number;
  daAddbackCents: number;
  ebitdaCents: number;
  interestExpenseCents: number;
  scheduledPrincipalCents: number;
  debtServiceCents: number;
  fixedChargesCents: number;
  totalDebtCents: number;
  cashCents: number;
  netDebtCents: number;
  currentAssetsCents: number;
  currentLiabilitiesCents: number;
  liquidityCents: number;
  equityCents: number;
  intangiblesCents: number;
  tangibleNetWorthCents: number;
  periodStart: string;
  periodEnd: string;
}

export interface ResolvedInputs {
  inputs: CovenantInputs;
  components: CovenantComponents;
}

interface AcctMeta {
  id: string;
  accountType: string;
  subType: string;
  name: string;
  isBank: boolean;
}

interface LineSum {
  debit: number;
  credit: number;
}

const INTEREST_RE = /interest/i;
const DA_RE = /deprec|amort/i;
const DEBT_NAME_RE = /loan|note|debt|line of credit|revolver|mortgage|bond|term loan/i;
const INTANGIBLE_RE = /goodwill|intangible|trademark|patent/i;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** period_end minus `months`, as an ISO yyyy-mm-dd (UTC). */
function minusMonths(endIso: string, months: number): string {
  const d = new Date(endIso + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() - months);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

async function fetchAccounts(supabase: SupabaseClient): Promise<Map<string, AcctMeta>> {
  const { data, error } = await supabase
    .from('accounts')
    .select('id, account_type, account_sub_type, name, is_bank_account');
  if (error) throw new Error(error.message);
  const map = new Map<string, AcctMeta>();
  for (const a of data ?? []) {
    map.set(a.id as string, {
      id: a.id as string,
      accountType: (a.account_type as string) ?? '',
      subType: (a.account_sub_type as string) ?? '',
      name: (a.name as string) ?? '',
      isBank: Boolean(a.is_bank_account),
    });
  }
  return map;
}

async function fetchEntryIds(
  supabase: SupabaseClient,
  opts: { start?: string; end: string; locationId?: string | null },
): Promise<string[]> {
  let q = supabase
    .from('gl_entries')
    .select('id')
    .eq('status', 'POSTED')
    .lte('entry_date', opts.end);
  if (opts.start) q = q.gte('entry_date', opts.start);
  if (opts.locationId) q = q.eq('location_id', opts.locationId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []).map((e: { id: string }) => e.id as string);
}

/** Sum debit/credit per account across a set of entries (chunked for the IN clause). */
async function sumLinesByAccount(
  supabase: SupabaseClient,
  entryIds: string[],
): Promise<Map<string, LineSum>> {
  const sums = new Map<string, LineSum>();
  const CHUNK = 500;
  for (let i = 0; i < entryIds.length; i += CHUNK) {
    const slice = entryIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('gl_entry_lines')
      .select('account_id, debit_cents, credit_cents')
      .in('gl_entry_id', slice);
    if (error) throw new Error(error.message);
    for (const l of data ?? []) {
      const id = l.account_id as string;
      const cur = sums.get(id) ?? { debit: 0, credit: 0 };
      cur.debit += Number(l.debit_cents ?? 0);
      cur.credit += Number(l.credit_cents ?? 0);
      sums.set(id, cur);
    }
  }
  return sums;
}

/** Debit-normal net (assets, expenses): debit − credit. */
const debitNet = (s: LineSum | undefined) => (s ? s.debit - s.credit : 0);
/** Credit-normal net (liabilities, equity, revenue): credit − debit. */
const creditNet = (s: LineSum | undefined) => (s ? s.credit - s.debit : 0);

/**
 * Resolve every covenant input + component for one covenant as of `periodEnd`.
 * Flow figures (EBITDA / interest) use the trailing window; stock figures (debt,
 * current assets/liabilities, equity, cash) are cumulative as-of period_end.
 */
export async function resolveCovenantInputs(
  supabase: SupabaseClient,
  covenant: {
    location_id: string | null;
    measurement: CovenantMeasurementConfig | null;
  },
  periodEnd: string,
): Promise<ResolvedInputs> {
  const cfg = covenant.measurement ?? {};
  const trailingMonths = cfg.trailingMonths ?? 12;
  const periodStart = minusMonths(periodEnd, trailingMonths);
  const locationId = covenant.location_id;

  const accounts = await fetchAccounts(supabase);

  // Flow window (P&L) and as-of window (balance sheet).
  const [flowEntryIds, asOfEntryIds] = await Promise.all([
    fetchEntryIds(supabase, { start: periodStart, end: periodEnd, locationId }),
    fetchEntryIds(supabase, { end: periodEnd, locationId }),
  ]);
  const [flowSums, asOfSums] = await Promise.all([
    sumLinesByAccount(supabase, flowEntryIds),
    sumLinesByAccount(supabase, asOfEntryIds),
  ]);

  // ── P&L flows (trailing window) ─────────────────────────────────────────────
  let revenueCents = 0;
  let cogsCents = 0;
  let opexCents = 0;
  let daAddbackCents = 0; // D&A sitting inside OPEX (added back to reach EBITDA)
  let interestExpenseCents = 0; // interest across all P&L (feeds debt service)

  for (const [id, s] of flowSums) {
    const a = accounts.get(id);
    if (!a) continue;
    switch (a.accountType) {
      case 'REVENUE':
        revenueCents += creditNet(s);
        break;
      case 'COGS':
        cogsCents += debitNet(s);
        break;
      case 'OPEX': {
        const net = debitNet(s);
        opexCents += net;
        if (DA_RE.test(a.name)) daAddbackCents += net;
        if (INTEREST_RE.test(a.name)) interestExpenseCents += net;
        break;
      }
      case 'OTHER':
        // Below-the-line: interest often lives here (OTHER_EXPENSE). Only interest is relevant.
        if (INTEREST_RE.test(a.name)) interestExpenseCents += debitNet(s);
        break;
      default:
        break;
    }
  }

  // Interest booked inside OPEX was subtracted from operating income; DSCR needs
  // EBITDA (before interest) — so add interest-in-opex back alongside D&A.
  let interestInOpexCents = 0;
  for (const [id, s] of flowSums) {
    const a = accounts.get(id);
    if (a && a.accountType === 'OPEX' && INTEREST_RE.test(a.name)) interestInOpexCents += debitNet(s);
  }

  const ebitCents = revenueCents - cogsCents - opexCents;
  const ebitdaCents = ebitCents + daAddbackCents + interestInOpexCents;

  const scheduledPrincipalCents = Math.round(cfg.annualPrincipalCents ?? 0);
  const debtServiceCents = interestExpenseCents + scheduledPrincipalCents;
  const fixedChargesCents = debtServiceCents + Math.round(cfg.fixedChargeAddonCents ?? 0);

  // ── Balance sheet (as-of) ───────────────────────────────────────────────────
  let totalDebtCents = 0;
  let cashCents = 0;
  let currentAssetsCents = 0;
  let currentLiabilitiesCents = 0;
  let equityCents = 0;
  let intangiblesCents = Math.round(cfg.intangiblesCents ?? 0);

  for (const [id, s] of asOfSums) {
    const a = accounts.get(id);
    if (!a) continue;
    switch (a.accountType) {
      case 'ASSET': {
        const net = debitNet(s);
        if (a.isBank) cashCents += net;
        if (a.subType === 'CURRENT_ASSET') currentAssetsCents += net;
        if (INTANGIBLE_RE.test(a.name)) intangiblesCents += net;
        break;
      }
      case 'LIABILITY': {
        const net = creditNet(s);
        if (a.subType === 'CURRENT_LIABILITY') currentLiabilitiesCents += net;
        if (a.subType === 'LONG_TERM_LIABILITY' || DEBT_NAME_RE.test(a.name)) totalDebtCents += net;
        break;
      }
      case 'EQUITY':
        equityCents += creditNet(s);
        break;
      default:
        break;
    }
  }

  const netOfCash = cfg.netOfCash !== false;
  const netDebtCents = totalDebtCents - cashCents;
  const leverageDebtCents = netOfCash ? netDebtCents : totalDebtCents;
  const liquidityCents = cashCents + Math.round(cfg.revolverAvailabilityCents ?? 0);
  const tangibleNetWorthCents = equityCents - intangiblesCents;

  const components: CovenantComponents = {
    revenueCents,
    cogsCents,
    opexCents,
    daAddbackCents: daAddbackCents + interestInOpexCents,
    ebitdaCents,
    interestExpenseCents,
    scheduledPrincipalCents,
    debtServiceCents,
    fixedChargesCents,
    totalDebtCents,
    cashCents,
    netDebtCents,
    currentAssetsCents,
    currentLiabilitiesCents,
    liquidityCents,
    equityCents,
    intangiblesCents,
    tangibleNetWorthCents,
    periodStart,
    periodEnd,
  };

  const inputs: CovenantInputs = {
    ebitdaCents,
    debtServiceCents,
    fixedChargesCents,
    totalDebtCents: leverageDebtCents,
    currentAssetsCents,
    currentLiabilitiesCents,
    liquidityCents,
    tangibleNetWorthCents,
    numeratorCents: cfg.numeratorCents,
    denominatorCents: cfg.denominatorCents,
  };

  return { inputs, components };
}

export interface CashDeltaPoint {
  date: string;
  cumulativeCashDeltaCents: number;
}

/**
 * Project cumulative cash deltas off the EXISTING 13-week cash forecast engine:
 * fetch open AR (inflows) / AP (outflows) by due date, roll them through
 * `buildForecast`, and return each week's (closing − starting) as the cumulative
 * cash movement. These feed `buildForecastSeries` so the covenant trajectory is
 * grounded in the same deterministic forecast the /forecast page shows.
 */
export async function projectCashDeltas(
  supabase: SupabaseClient,
  locationId: string | null,
): Promise<CashDeltaPoint[]> {
  const OPEN_INVOICE_STATUSES = ['SENT', 'PARTIALLY_PAID', 'OVERDUE'];
  const OPEN_BILL_STATUSES = ['PENDING', 'APPROVED', 'PARTIALLY_PAID', 'ON_HOLD'];

  let baQ = supabase
    .from('bank_accounts')
    .select('current_balance_cents, location_id, account_type')
    .eq('is_active', true)
    .in('account_type', ['CHECKING', 'SAVINGS']);
  if (locationId) baQ = baQ.eq('location_id', locationId);

  let invQ = supabase
    .from('invoices')
    .select('id, invoice_number, due_date, balance_cents, status')
    .in('status', OPEN_INVOICE_STATUSES)
    .gt('balance_cents', 0);
  if (locationId) invQ = invQ.eq('location_id', locationId);

  let billQ = supabase
    .from('bills')
    .select('id, bill_number, due_date, balance_cents, status')
    .in('status', OPEN_BILL_STATUSES)
    .gt('balance_cents', 0);
  if (locationId) billQ = billQ.eq('location_id', locationId);

  const [baRes, invRes, billRes] = await Promise.all([baQ, invQ, billQ]);
  if (baRes.error) throw new Error(baRes.error.message);
  if (invRes.error) throw new Error(invRes.error.message);
  if (billRes.error) throw new Error(billRes.error.message);

  const startingCashCents = (baRes.data ?? []).reduce(
    (s: number, a: { current_balance_cents: number | string | null }) => s + Number(a.current_balance_cents ?? 0),
    0,
  );

  const inflows: ForecastCashflowItem[] = (invRes.data ?? []).map((i: {
    id: string; invoice_number: string | null; due_date: string; balance_cents: number | string | null; status: string;
  }) => ({
    id: i.id,
    dueDate: i.due_date,
    amountCents: Number(i.balance_cents ?? 0),
    label: i.invoice_number ?? 'Invoice',
    party: 'Customer',
    status: i.status,
    overdue: false,
  }));

  const outflows: ForecastCashflowItem[] = (billRes.data ?? []).map((b: {
    id: string; bill_number: string | null; due_date: string; balance_cents: number | string | null; status: string;
  }) => ({
    id: b.id,
    dueDate: b.due_date,
    amountCents: Number(b.balance_cents ?? 0),
    label: b.bill_number ?? 'Bill',
    party: 'Vendor',
    status: b.status,
    overdue: false,
  }));

  const forecast = buildForecast({ startingCashCents, inflows, outflows });
  return forecast.weeks.map((w) => ({
    date: w.endDate,
    cumulativeCashDeltaCents: w.closingCents - startingCashCents,
  }));
}
