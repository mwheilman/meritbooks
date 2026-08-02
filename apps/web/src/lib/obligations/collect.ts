/**
 * Unified Renewals & Obligations Calendar — collector.
 *
 * ONE read-only aggregate of every date-driven obligation across the platform, so
 * nothing lapses. NO new tables: it stitches together already-existing source tables
 * (leases, debt, covenants, insurance, subscriptions, vendor compliance, recurring
 * invoices) into a single common shape and ranks them by urgency.
 *
 * Two clean layers:
 *   1. PURE (deterministic, unit-tested): date math, severity/horizon bucketing, the
 *      common-shape mapping, ranking. No I/O — same inputs, same outputs.
 *   2. LOADER (`collectObligations`): queries each source RLS-scoped through the
 *      caller's Supabase client and try/catches EACH source independently. A missing
 *      table/column (e.g. `subscriptions`, which may not exist yet) DEGRADES that one
 *      source (it's reported in `degraded[]`) instead of failing the whole calendar.
 *
 * Read-only: no ledger post, no DB write. All money stays bigint cents.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Common shape
// ---------------------------------------------------------------------------

export type ObligationType =
  | 'LEASE'
  | 'DEBT_MATURITY'
  | 'DEBT_PAYMENT'
  | 'COVENANT'
  | 'INSURANCE'
  | 'SUBSCRIPTION'
  | 'VENDOR_W9'
  | 'VENDOR_COI'
  | 'RECURRING_INVOICE';

/** What KIND of deadline this is (drives the human verb/label). */
export type ObligationCategory =
  | 'RENEWAL'
  | 'MATURITY'
  | 'PAYMENT'
  | 'COMPLIANCE'
  | 'TEST'
  | 'BILLING';

/** Urgency band derived purely from days-until-due. */
export type ObligationSeverity = 'OVERDUE' | 'URGENT' | 'SOON' | 'UPCOMING';

/** Coarse grouping used by the UI's "coming due" columns. */
export type HorizonBucket = 'OVERDUE' | 'D30' | 'D60' | 'D90';

export interface Obligation {
  type: ObligationType;
  category: ObligationCategory;
  /** Short human title, e.g. "Prologis lease ends". */
  title: string;
  /** Optional secondary line (company, lender, coverage, …). */
  subtitle: string | null;
  /** yyyy-mm-dd the obligation falls due / must be acted on. */
  dueDate: string;
  /** Money at stake where meaningful (bigint cents); null when N/A. */
  amountCents: number | null;
  /** The underlying record's id (for drill-through). */
  entityId: string;
  /** Where to go to act on it. */
  href: string;
  severity: ObligationSeverity;
  /** Whole days from `asOf` to `dueDate`. Negative = overdue. */
  daysUntil: number;
}

/** Everything needed to build an Obligation except the derived urgency fields. */
export type RawObligation = Omit<Obligation, 'daysUntil' | 'severity'>;

// ---------------------------------------------------------------------------
// PURE date math
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Parse a yyyy-mm-dd string to a UTC-midnight epoch, or null if malformed. */
function isoToUtc(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const t = Date.UTC(Number(y), Number(mo) - 1, Number(d));
  return Number.isFinite(t) ? t : null;
}

/** Whole-day difference (b - a), both yyyy-mm-dd. Null if either is unparseable. */
export function daysBetween(aIso: string, bIso: string): number | null {
  const a = isoToUtc(aIso);
  const b = isoToUtc(bIso);
  if (a === null || b === null) return null;
  return Math.round((b - a) / MS_PER_DAY);
}

/** Days from `asOf` to `dueDate` (negative = already overdue). Null if unparseable. */
export function daysUntilDue(asOf: string, dueDate: string | null | undefined): number | null {
  if (typeof dueDate !== 'string') return null;
  return daysBetween(asOf, dueDate);
}

// ---------------------------------------------------------------------------
// PURE severity + horizon bucketing
// ---------------------------------------------------------------------------

/**
 * Severity strictly from days-until-due:
 *   OVERDUE  (< 0) > URGENT (0–7) > SOON (8–30) > UPCOMING (> 30).
 */
export function severityForDays(days: number): ObligationSeverity {
  if (days < 0) return 'OVERDUE';
  if (days <= 7) return 'URGENT';
  if (days <= 30) return 'SOON';
  return 'UPCOMING';
}

/** Which "coming due" column an item belongs in. */
export function horizonForDays(days: number): HorizonBucket {
  if (days < 0) return 'OVERDUE';
  if (days <= 30) return 'D30';
  if (days <= 60) return 'D60';
  return 'D90';
}

/** True when the item is due within the horizon — overdue items ALWAYS qualify. */
export function withinHorizon(days: number, horizonDays: number): boolean {
  return days <= horizonDays;
}

// ---------------------------------------------------------------------------
// PURE shaping + ranking
// ---------------------------------------------------------------------------

/** Build an Obligation, deriving urgency from `asOf`. Null if the date is unusable. */
export function makeObligation(asOf: string, raw: RawObligation): Obligation | null {
  const days = daysUntilDue(asOf, raw.dueDate);
  if (days === null) return null;
  return { ...raw, daysUntil: days, severity: severityForDays(days) };
}

/** Keep only obligations at/inside the horizon (overdue always kept). */
export function filterToHorizon(items: readonly Obligation[], horizonDays: number): Obligation[] {
  const h = Number.isFinite(horizonDays) ? horizonDays : 0;
  return items.filter((o) => withinHorizon(o.daysUntil, h));
}

/**
 * Deterministic ranking: soonest / most overdue first, then larger money first,
 * then title — so the ordering is stable and never depends on query order.
 */
export function rankObligations(items: readonly Obligation[]): Obligation[] {
  return [...items].sort((a, b) => {
    if (a.daysUntil !== b.daysUntil) return a.daysUntil - b.daysUntil;
    const aAmt = a.amountCents ?? -1;
    const bAmt = b.amountCents ?? -1;
    if (aAmt !== bAmt) return bAmt - aAmt;
    return a.title.localeCompare(b.title);
  });
}

/** Group ranked obligations into the four horizon columns (each stays ranked). */
export function bucketByHorizon(items: readonly Obligation[]): Record<HorizonBucket, Obligation[]> {
  const buckets: Record<HorizonBucket, Obligation[]> = { OVERDUE: [], D30: [], D60: [], D90: [] };
  for (const o of rankObligations(items)) buckets[horizonForDays(o.daysUntil)].push(o);
  return buckets;
}

// ---------------------------------------------------------------------------
// PURE recurrence (for sources with only a frequency, e.g. covenant tests)
// ---------------------------------------------------------------------------

/** Months per recurrence frequency. Null for unknown/one-time. */
export function frequencyMonths(freq: string | null | undefined): number | null {
  switch ((freq ?? '').toUpperCase()) {
    case 'MONTHLY':
      return 1;
    case 'QUARTERLY':
      return 3;
    case 'SEMIANNUAL':
      return 6;
    case 'ANNUAL':
      return 12;
    default:
      return null;
  }
}

/**
 * First occurrence on/after `asOf`, stepping from `anchorIso` by `months`.
 * Returns yyyy-mm-dd, or null if inputs are unusable. Bounded (no infinite loop).
 */
export function nextRecurrence(
  anchorIso: string | null | undefined,
  months: number | null,
  asOf: string,
): string | null {
  const anchor = isoToUtc(anchorIso);
  const start = isoToUtc(asOf);
  if (anchor === null || start === null || !months || months <= 0) return null;

  const d = new Date(anchor);
  // Advance in whole-month steps until we reach/pass asOf. Cap iterations at ~200y.
  let guard = 0;
  while (d.getTime() < start && guard < 2400) {
    d.setUTCMonth(d.getUTCMonth() + months);
    guard += 1;
  }
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// LOADER — one RLS-scoped query per source, each degrade-isolated
// ---------------------------------------------------------------------------

export interface CollectOptions {
  /** yyyy-mm-dd "today". */
  asOf: string;
  /** How far out to look (overdue items are always included). */
  horizonDays: number;
  /** Optional type filter — when set, only these types are returned. */
  types?: readonly ObligationType[];
}

export interface CollectResult {
  obligations: Obligation[];
  /** Source keys that could not be read (missing table/column, query error). */
  degraded: string[];
}

type StringMap = Map<string, string>;

function nameOf(map: StringMap, id: string | null | undefined): string | null {
  if (!id) return null;
  return map.get(id) ?? null;
}

function joinSub(parts: Array<string | null | undefined>): string | null {
  const kept = parts.filter((p): p is string => typeof p === 'string' && p.length > 0);
  return kept.length > 0 ? kept.join(' · ') : null;
}

/** Fetch id→name from `core.locations` (best-effort; blank labels on failure). */
async function loadLocationNames(supabase: SupabaseClient): Promise<StringMap> {
  const map: StringMap = new Map();
  try {
    const { data } = await supabase.schema('core').from('locations').select('id, name');
    for (const r of (data ?? []) as Array<{ id: string; name: string | null }>) {
      if (r.id && r.name) map.set(r.id, r.name);
    }
  } catch {
    /* degrade to blank labels */
  }
  return map;
}

/** Fetch id→name from `vendors` (public, RLS-scoped). Best-effort. */
async function loadVendorNames(supabase: SupabaseClient): Promise<StringMap> {
  const map: StringMap = new Map();
  try {
    const { data } = await supabase.from('vendors').select('id, name, display_name');
    for (const r of (data ?? []) as Array<{ id: string; name: string | null; display_name: string | null }>) {
      if (r.id) map.set(r.id, r.display_name || r.name || '');
    }
  } catch {
    /* degrade */
  }
  return map;
}

const DOC_LABEL: Record<string, string> = {
  W9: 'W-9',
  GL_COI: 'General Liability COI',
  WC_COI: "Workers' Comp COI",
  WC_EXEMPTION: "Workers' Comp Exemption",
};

interface LeaseRow {
  id: string;
  lessor: string | null;
  description: string | null;
  end_date: string | null;
  payment_cents: number | null;
  location_id: string | null;
  status: string | null;
}

async function collectLeases(supabase: SupabaseClient, asOf: string, loc: StringMap): Promise<Obligation[]> {
  const { data, error } = await supabase
    .from('leases')
    .select('id, lessor, description, end_date, payment_cents, location_id, status')
    .eq('status', 'ACTIVE');
  if (error) throw new Error(error.message);
  const out: Obligation[] = [];
  for (const r of (data ?? []) as LeaseRow[]) {
    const o = makeObligation(asOf, {
      type: 'LEASE',
      category: 'MATURITY',
      title: r.lessor ? `${r.lessor} — lease term ends` : 'Lease term ends',
      subtitle: joinSub([r.description, nameOf(loc, r.location_id)]),
      dueDate: r.end_date ?? '',
      amountCents: typeof r.payment_cents === 'number' ? r.payment_cents : null,
      entityId: r.id,
      href: `/leases?focus=${r.id}`,
    });
    if (o) out.push(o);
  }
  return out;
}

interface DebtRow {
  id: string;
  name: string | null;
  lender: string | null;
  maturity_date: string | null;
  current_balance_cents: number | null;
  location_id: string | null;
  status: string | null;
}

async function collectDebtMaturities(supabase: SupabaseClient, asOf: string, loc: StringMap): Promise<Obligation[]> {
  const { data, error } = await supabase
    .from('debt_instruments')
    .select('id, name, lender, maturity_date, current_balance_cents, location_id, status');
  if (error) throw new Error(error.message);
  const out: Obligation[] = [];
  for (const r of (data ?? []) as DebtRow[]) {
    if (r.status && r.status !== 'ACTIVE') continue;
    const o = makeObligation(asOf, {
      type: 'DEBT_MATURITY',
      category: 'MATURITY',
      title: `${r.name ?? 'Loan'} matures`,
      subtitle: joinSub([r.lender, nameOf(loc, r.location_id)]),
      dueDate: r.maturity_date ?? '',
      amountCents: typeof r.current_balance_cents === 'number' ? r.current_balance_cents : null,
      entityId: r.id,
      href: `/debt?focus=${r.id}`,
    });
    if (o) out.push(o);
  }
  return out;
}

interface DebtScheduleRow {
  id: string;
  instrument_id: string;
  period_date: string | null;
  payment_cents: number | null;
}

async function collectDebtPayments(supabase: SupabaseClient, asOf: string, instr: StringMap): Promise<Obligation[]> {
  const { data, error } = await supabase
    .from('debt_schedule_lines')
    .select('id, instrument_id, period_date, payment_cents')
    .gte('period_date', asOf)
    .order('period_date', { ascending: true });
  if (error) throw new Error(error.message);
  const out: Obligation[] = [];
  const seen = new Set<string>();
  for (const r of (data ?? []) as DebtScheduleRow[]) {
    // Rows are date-ascending, so the first per instrument is its NEXT payment.
    if (seen.has(r.instrument_id)) continue;
    seen.add(r.instrument_id);
    const name = nameOf(instr, r.instrument_id) ?? 'Loan';
    const o = makeObligation(asOf, {
      type: 'DEBT_PAYMENT',
      category: 'PAYMENT',
      title: `${name} — next payment`,
      subtitle: null,
      dueDate: r.period_date ?? '',
      amountCents: typeof r.payment_cents === 'number' ? r.payment_cents : null,
      entityId: r.instrument_id,
      href: `/debt?focus=${r.instrument_id}`,
    });
    if (o) out.push(o);
  }
  return out;
}

interface CovenantRow {
  id: string;
  loan_name: string | null;
  facility: string | null;
  lender_name: string | null;
  test_frequency: string | null;
  effective_date: string | null;
  location_id: string | null;
  status: string | null;
}

async function collectCovenants(supabase: SupabaseClient, asOf: string, loc: StringMap): Promise<Obligation[]> {
  const { data, error } = await supabase
    .from('loan_covenants')
    .select('id, loan_name, facility, lender_name, test_frequency, effective_date, location_id, status')
    .eq('status', 'ACTIVE');
  if (error) throw new Error(error.message);
  const out: Obligation[] = [];
  for (const r of (data ?? []) as CovenantRow[]) {
    // No explicit "next test date" column — derive it from the test frequency,
    // anchored on the covenant's effective date. Skip if we can't derive one.
    const next = nextRecurrence(r.effective_date, frequencyMonths(r.test_frequency), asOf);
    if (!next) continue;
    const o = makeObligation(asOf, {
      type: 'COVENANT',
      category: 'TEST',
      title: `${r.loan_name ?? 'Loan'} — covenant test`,
      subtitle: joinSub([r.facility, r.lender_name, nameOf(loc, r.location_id)]),
      dueDate: next,
      amountCents: null,
      entityId: r.id,
      href: `/covenants?focus=${r.id}`,
    });
    if (o) out.push(o);
  }
  return out;
}

interface InsuranceRow {
  id: string;
  carrier: string | null;
  coverage_type: string | null;
  expiration_date: string | null;
  premium_cents: number | null;
  location_id: string | null;
  status: string | null;
}

async function collectInsurance(supabase: SupabaseClient, asOf: string, loc: StringMap): Promise<Obligation[]> {
  const { data, error } = await supabase
    .from('insurance_policies')
    .select('id, carrier, coverage_type, expiration_date, premium_cents, location_id, status')
    .in('status', ['ACTIVE', 'PENDING']);
  if (error) throw new Error(error.message);
  const out: Obligation[] = [];
  for (const r of (data ?? []) as InsuranceRow[]) {
    const coverage = r.coverage_type && r.coverage_type !== 'OTHER' ? r.coverage_type : 'Policy';
    const o = makeObligation(asOf, {
      type: 'INSURANCE',
      category: 'RENEWAL',
      title: `${r.carrier ?? 'Insurance'} — ${coverage} renewal`,
      subtitle: nameOf(loc, r.location_id),
      dueDate: r.expiration_date ?? '',
      amountCents: typeof r.premium_cents === 'number' ? r.premium_cents : null,
      entityId: r.id,
      href: `/insurance?focus=${r.id}`,
    });
    if (o) out.push(o);
  }
  return out;
}

interface SubscriptionRow {
  id: string;
  name: string | null;
  vendor_name: string | null;
  next_renewal_date: string | null;
  amount_cents: number | null;
  status: string | null;
}

async function collectSubscriptions(supabase: SupabaseClient, asOf: string): Promise<Obligation[]> {
  // `subscriptions` may not exist yet — the query throws, the loader degrades it.
  const { data, error } = await supabase
    .from('subscriptions')
    .select('id, name, vendor_name, next_renewal_date, amount_cents, status');
  if (error) throw new Error(error.message);
  const out: Obligation[] = [];
  for (const r of (data ?? []) as SubscriptionRow[]) {
    if (r.status && !['ACTIVE', 'TRIAL', 'PENDING'].includes(r.status)) continue;
    const o = makeObligation(asOf, {
      type: 'SUBSCRIPTION',
      category: 'RENEWAL',
      title: `${r.name ?? r.vendor_name ?? 'Subscription'} — renews`,
      subtitle: r.vendor_name && r.name ? r.vendor_name : null,
      dueDate: r.next_renewal_date ?? '',
      amountCents: typeof r.amount_cents === 'number' ? r.amount_cents : null,
      entityId: r.id,
      href: `/subscriptions?focus=${r.id}`,
    });
    if (o) out.push(o);
  }
  return out;
}

interface VendorDocRow {
  id: string;
  vendor_id: string;
  doc_type: string;
  expiration_date: string | null;
  coverage_amount_cents: number | null;
  status: string | null;
}

async function collectVendorCompliance(supabase: SupabaseClient, asOf: string, vend: StringMap): Promise<Obligation[]> {
  const { data, error } = await supabase
    .from('vendor_compliance_docs')
    .select('id, vendor_id, doc_type, expiration_date, coverage_amount_cents, status')
    .eq('status', 'VALID')
    .not('expiration_date', 'is', null);
  if (error) throw new Error(error.message);
  const out: Obligation[] = [];
  for (const r of (data ?? []) as VendorDocRow[]) {
    const label = DOC_LABEL[r.doc_type] ?? r.doc_type;
    const vendor = nameOf(vend, r.vendor_id) ?? 'Vendor';
    const o = makeObligation(asOf, {
      type: r.doc_type === 'W9' ? 'VENDOR_W9' : 'VENDOR_COI',
      category: 'COMPLIANCE',
      title: `${vendor} — ${label} expires`,
      subtitle: null,
      dueDate: r.expiration_date ?? '',
      amountCents: typeof r.coverage_amount_cents === 'number' ? r.coverage_amount_cents : null,
      entityId: r.id,
      href: `/vendor-compliance?focus=${r.vendor_id}`,
    });
    if (o) out.push(o);
  }
  return out;
}

interface RecurringRow {
  id: string;
  name: string | null;
  next_run_date: string | null;
  is_active: boolean | null;
}

async function collectRecurringInvoices(supabase: SupabaseClient, asOf: string): Promise<Obligation[]> {
  const { data, error } = await supabase
    .from('recurring_invoice_templates')
    .select('id, name, next_run_date, is_active')
    .eq('is_active', true)
    .not('next_run_date', 'is', null);
  if (error) throw new Error(error.message);
  const out: Obligation[] = [];
  for (const r of (data ?? []) as RecurringRow[]) {
    const o = makeObligation(asOf, {
      type: 'RECURRING_INVOICE',
      category: 'BILLING',
      title: `${r.name ?? 'Recurring invoice'} — next run`,
      subtitle: null,
      dueDate: r.next_run_date ?? '',
      amountCents: null,
      entityId: r.id,
      href: `/recurring?focus=${r.id}`,
    });
    if (o) out.push(o);
  }
  return out;
}

/**
 * Gather every upcoming date-driven obligation for the caller's org.
 *
 * Each source is queried RLS-scoped and try/catched INDEPENDENTLY: a missing
 * table/column or query error degrades that one source (recorded in `degraded`)
 * rather than failing the whole calendar. Results are horizon-filtered and ranked.
 */
export async function collectObligations(
  supabase: SupabaseClient,
  opts: CollectOptions,
): Promise<CollectResult> {
  const { asOf, horizonDays } = opts;

  // Best-effort label maps (their own failures just leave labels blank).
  const [locNames, vendorNames] = await Promise.all([
    loadLocationNames(supabase),
    loadVendorNames(supabase),
  ]);

  // id→name for debt instruments (drives the next-payment title). Best-effort.
  const instrNames: StringMap = new Map();
  try {
    const { data } = await supabase.from('debt_instruments').select('id, name');
    for (const r of (data ?? []) as Array<{ id: string; name: string | null }>) {
      if (r.id && r.name) instrNames.set(r.id, r.name);
    }
  } catch {
    /* degrade to blank names */
  }

  const sources: Array<[string, () => Promise<Obligation[]>]> = [
    ['leases', () => collectLeases(supabase, asOf, locNames)],
    ['debt_maturities', () => collectDebtMaturities(supabase, asOf, locNames)],
    ['debt_payments', () => collectDebtPayments(supabase, asOf, instrNames)],
    ['covenants', () => collectCovenants(supabase, asOf, locNames)],
    ['insurance', () => collectInsurance(supabase, asOf, locNames)],
    ['subscriptions', () => collectSubscriptions(supabase, asOf)],
    ['vendor_compliance', () => collectVendorCompliance(supabase, asOf, vendorNames)],
    ['recurring_invoices', () => collectRecurringInvoices(supabase, asOf)],
  ];

  const degraded: string[] = [];
  const results = await Promise.all(
    sources.map(async ([key, fn]) => {
      try {
        return await fn();
      } catch (e) {
        console.error(`[obligations] source '${key}' degraded:`, e instanceof Error ? e.message : e);
        degraded.push(key);
        return [] as Obligation[];
      }
    }),
  );

  let all = results.flat();
  if (opts.types && opts.types.length > 0) {
    const wanted = new Set(opts.types);
    all = all.filter((o) => wanted.has(o.type));
  }
  all = filterToHorizon(all, horizonDays);

  return { obligations: rankObligations(all), degraded };
}
