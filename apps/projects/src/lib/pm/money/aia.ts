/**
 * AIA G702 / G703 and progress-billing math, client side, to the cent of the SQL in
 * 1102_pm_commitments_billing.sql (pm.generate_sov_billing, pm.generate_progress_billing,
 * pm.v_pay_application). Pure and unit-tested against the migration harness numbers.
 *
 * Postgres `round(numeric)` rounds half away from zero on exact decimals. JavaScript
 * floats cannot do that reliably, so every product of cents and a rate goes through
 * BigInt on the rate's decimal digits (the same digits the JSON body carries to SQL).
 */

/** "0.25" / 0.25 → { num: 25n, scale: 100n }. Throws on anything that is not a plain decimal. */
export function decimalParts(rate: number | string): { num: bigint; scale: bigint } {
  let s = typeof rate === 'number' ? (Number.isFinite(rate) ? String(rate) : 'x') : rate.trim();
  if (/e/i.test(s)) s = Number(s).toFixed(12);
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new RangeError(`Not a decimal: ${String(rate)}`);
  const frac = m[3] ?? '';
  const digits = `${m[2] || '0'}${frac}`;
  const num = BigInt(digits) * (m[1] === '-' ? -1n : 1n);
  return { num, scale: 10n ** BigInt(frac.length) };
}

/** Integer division of a/b rounded half away from zero (b > 0). */
function divRound(a: bigint, b: bigint): bigint {
  const q = a / b;
  const r = a % b;
  const twice = (r < 0n ? -r : r) * 2n;
  if (twice >= b) return a < 0n ? q - 1n : q + 1n;
  return q;
}

/** round(cents × rate) exactly as Postgres numeric does it. */
export function roundMul(cents: number, rate: number | string): number {
  if (!Number.isSafeInteger(cents)) throw new RangeError(`Cents must be an integer: ${cents}`);
  const { num, scale } = decimalParts(rate);
  return Number(divRound(BigInt(cents) * num, scale));
}

/** round(part / whole, 6) — G703 column G ÷ C. Null when whole is 0. */
export function ratio6(part: number, whole: number): number | null {
  if (whole === 0) return null;
  return Number(divRound(BigInt(part) * 1_000_000n, BigInt(whole))) / 1_000_000;
}

// ---------------------------------------------------------------------------
// G703 continuation sheet
// ---------------------------------------------------------------------------

/** What earlier counted applications (EMITTED | ISSUED | UNISSUED | REJECTED) did on one SOV lineage. */
export interface G703Prior {
  /** D: work completed from previous applications (Σ E). */
  previousWorkCents: number;
  /** F′: materials stored on the latest previous application. */
  previousStoredCents: number;
  /** Retainage already held on this line (Σ retainage this period). */
  previousRetainageCents: number;
}

/** One line's entry this period. Omitted = carry forward (E = 0, F = F′). */
export interface G703Entry {
  /** Work completed to date as a fraction of C (excludes stored materials). Wins over the others. */
  pctComplete?: number | null;
  workToDateCents?: number | null;
  thisPeriodCents?: number | null;
  /** F: the stored balance now; defaults to F′. */
  storedMaterialsCents?: number | null;
}

export interface G703Input {
  scheduledCents: number;
  /** Line rate, else the SOV version rate, else the contract rate, else 0. */
  rate: number | string;
  prior: G703Prior;
  entry?: G703Entry | null;
}

export type G703Error = 'PCT_RANGE' | 'NEGATIVE' | 'OVER_SCHEDULED';

export interface G703Line {
  /** C */ scheduled: number;
  /** D */ previous: number;
  /** E */ thisPeriod: number;
  /** F */ stored: number;
  /** F′ */ previousStored: number;
  /** G = D + E + F */ completedStored: number;
  /** G ÷ C, 6 places */ pct: number | null;
  /** H = C − G */ balance: number;
  /** Billed this period = E + F − F′ (the line's amount on the request). */
  billed: number;
  retainageWorkToDate: number;
  retainageStoredToDate: number;
  /** I: retainage held by this application on the line (before any contract cap). */
  retainageThisPeriod: number;
  error: G703Error | null;
}

export function g703Line(i: G703Input): G703Line {
  const c = i.scheduledCents;
  const d = i.prior.previousWorkCents;
  const fp = i.prior.previousStoredCents;
  const en = i.entry ?? null;
  let error: G703Error | null = null;
  let e = 0;
  if (en) {
    if (en.pctComplete != null) {
      if (en.pctComplete < 0 || en.pctComplete > 1) error = 'PCT_RANGE';
      e = roundMul(c, en.pctComplete) - d;
    } else if (en.workToDateCents != null) {
      e = en.workToDateCents - d;
    } else {
      e = en.thisPeriodCents ?? 0;
    }
  }
  const f = en?.storedMaterialsCents ?? fp;
  if (!error && (d + e < 0 || f < 0)) error = 'NEGATIVE';
  const g = d + e + f;
  if (!error && g > c) error = 'OVER_SCHEDULED';
  const rw = roundMul(d + e, i.rate);
  const rs = roundMul(f, i.rate);
  return {
    scheduled: c, previous: d, thisPeriod: e, stored: f, previousStored: fp, completedStored: g,
    pct: ratio6(g, c), balance: c - g, billed: e + f - fp,
    retainageWorkToDate: rw, retainageStoredToDate: rs, retainageThisPeriod: rw + rs - i.prior.previousRetainageCents,
    error,
  };
}

// ---------------------------------------------------------------------------
// Prior applications by SOV lineage (the generator's D, F′ and held retainage)
// ---------------------------------------------------------------------------

export const COUNTED_STATUSES: ReadonlySet<string> = new Set(['EMITTED', 'ISSUED', 'UNISSUED', 'REJECTED']);

export interface PriorLineInput {
  sov_lineage_id: string | null;
  line_type: string;
  this_period_work_cents: number | null;
  stored_materials_cents: number | null;
  retainage_this_period_cents: number;
  /** The request the line belongs to. */
  request: { status: string; application_no: number | null; created_at: string };
}

/** Σ E, latest F and Σ held retainage per lineage, over counted applications only. */
export function priorByLineage(lines: ReadonlyArray<PriorLineInput>): Map<string, G703Prior> {
  const out = new Map<string, G703Prior & { _app: number; _at: string }>();
  for (const l of lines) {
    if (!l.sov_lineage_id || l.line_type !== 'STANDARD' || !COUNTED_STATUSES.has(l.request.status)) continue;
    const cur = out.get(l.sov_lineage_id) ?? { previousWorkCents: 0, previousStoredCents: 0, previousRetainageCents: 0, _app: -Infinity, _at: '' };
    cur.previousWorkCents += l.this_period_work_cents ?? 0;
    cur.previousRetainageCents += l.retainage_this_period_cents;
    // latest by application_no desc nulls last, created_at desc
    const app = l.request.application_no ?? -Infinity;
    if (app > cur._app || (app === cur._app && l.request.created_at > cur._at)) {
      cur._app = app;
      cur._at = l.request.created_at;
      cur.previousStoredCents = l.stored_materials_cents ?? 0;
    }
    out.set(l.sov_lineage_id, cur);
  }
  return new Map([...out].map(([k, v]) => [k, { previousWorkCents: v.previousWorkCents, previousStoredCents: v.previousStoredCents, previousRetainageCents: v.previousRetainageCents }]));
}

// ---------------------------------------------------------------------------
// G702 application summary (pm.v_pay_application)
// ---------------------------------------------------------------------------

export interface G702Input {
  originalContractCents: number;
  /** Σ net of earlier counted SOV applications (line 7). */
  previousCertificatesCents: number;
  /** Σ retainage held by earlier counted SOV applications. */
  previousRetainageHeldCents: number;
}

export interface G702 {
  /** 1 */ originalContract: number;
  /** 2 */ netChangeByCo: number;
  /** 3 */ contractSumToDate: number;
  /** 4 */ completedStoredToDate: number;
  /** 5a */ retainageWork: number;
  /** 5b */ retainageStored: number;
  /** 5 */ retainageTotal: number;
  /** 6 */ earnedLessRetainage: number;
  /** 7 */ previousCertificates: number;
  /** 8 */ currentPaymentDue: number;
  /** 9 */ balanceToFinishInclRetainage: number;
  /** The request: Σ billed (gross) and gross − retainage this period (net). */
  grossThisPeriod: number;
  retainageThisPeriod: number;
  netThisPeriod: number;
}

export function g702(lines: ReadonlyArray<G703Line>, i: G702Input): G702 {
  let scheduled = 0, completed = 0, rw = 0, rs = 0, retThis = 0, gross = 0;
  for (const l of lines) {
    scheduled += l.scheduled;
    completed += l.completedStored;
    rw += l.retainageWorkToDate;
    rs += l.retainageStoredToDate;
    retThis += l.retainageThisPeriod;
    gross += l.billed;
  }
  const retTotal = i.previousRetainageHeldCents + retThis;
  const earned = completed - retTotal;
  return {
    originalContract: i.originalContractCents,
    netChangeByCo: scheduled - i.originalContractCents,
    contractSumToDate: scheduled,
    completedStoredToDate: completed,
    retainageWork: rw,
    retainageStored: rs,
    retainageTotal: retTotal,
    earnedLessRetainage: earned,
    previousCertificates: i.previousCertificatesCents,
    currentPaymentDue: earned - i.previousCertificatesCents,
    balanceToFinishInclRetainage: scheduled - earned,
    grossThisPeriod: gross,
    retainageThisPeriod: retThis,
    netThisPeriod: gross - retThis,
  };
}

/** A drafted request's stored G703 columns → the same shape the preview uses. */
export function g703FromStored(l: {
  scheduled_value_cents: number | null; previous_work_cents: number | null; this_period_work_cents: number | null;
  stored_materials_cents: number | null; previous_stored_cents: number | null; total_completed_cents: number | null;
  pct_complete: number | null; balance_to_finish_cents: number | null; amount_cents: number;
  retainage_work_to_date_cents: number | null; retainage_stored_to_date_cents: number | null; retainage_this_period_cents: number;
}): G703Line {
  return {
    scheduled: l.scheduled_value_cents ?? 0,
    previous: l.previous_work_cents ?? 0,
    thisPeriod: l.this_period_work_cents ?? 0,
    stored: l.stored_materials_cents ?? 0,
    previousStored: l.previous_stored_cents ?? 0,
    completedStored: l.total_completed_cents ?? 0,
    pct: l.pct_complete,
    balance: l.balance_to_finish_cents ?? 0,
    billed: l.amount_cents,
    retainageWorkToDate: l.retainage_work_to_date_cents ?? 0,
    retainageStoredToDate: l.retainage_stored_to_date_cents ?? 0,
    retainageThisPeriod: l.retainage_this_period_cents,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Progress % billing (pm.generate_progress_billing)
// ---------------------------------------------------------------------------

export interface ProgressInput {
  revisedContractCents: number;
  /** 0..1 */
  pct: number;
  /** Σ gross of counted requests, excluding retainage releases. */
  billedToDateCents: number;
  /** Contract retention rate. */
  rate: number | string;
  /** Σ retainage this period already held on STANDARD lines of counted requests. */
  heldToDateCents: number;
}

export interface ProgressPreview {
  earnedToDate: number;
  thisBill: number;
  retainageThisPeriod: number;
  net: number;
  /** Nothing to bill: earned ≤ billed to date. */
  nothing: boolean;
  outOfRange: boolean;
}

export function progressPreview(i: ProgressInput): ProgressPreview {
  const earned = roundMul(i.revisedContractCents, i.pct);
  const thisBill = earned - i.billedToDateCents;
  const ret = roundMul(earned, i.rate) - i.heldToDateCents;
  return { earnedToDate: earned, thisBill, retainageThisPeriod: ret, net: thisBill - ret, nothing: thisBill <= 0, outOfRange: i.pct < 0 || i.pct > 1 };
}

// ---------------------------------------------------------------------------
// Estimate lines (qty × unit, markup)
// ---------------------------------------------------------------------------

/** round(qty × unit cents) — the estimate/commitment line defaults in the triggers. */
export function extendCents(qty: number | string, unitCents: number): number {
  return roundMul(unitCents, qty);
}

/** Unit price from unit cost and a markup fraction (0.2 = 20%): cost + round(cost × markup). */
export function priceFromMarkup(unitCostCents: number, markup: number | string): number {
  return unitCostCents + roundMul(unitCostCents, markup);
}

/** Markup implied by a cost and a price; null without a cost. */
export function markupOf(unitCostCents: number | null, unitPriceCents: number | null): number | null {
  if (unitCostCents == null || unitPriceCents == null || unitCostCents === 0) return null;
  return (unitPriceCents - unitCostCents) / unitCostCents;
}

/** A pm.v_pay_application row (plus its request) → the G702 shape the preview uses. */
export function g702FromView(v: {
  original_contract_cents: number; net_change_by_co_cents: number; contract_sum_to_date_cents: number; total_completed_stored_cents: number;
  retainage_work_cents: number; retainage_stored_cents: number; retainage_total_cents: number; total_earned_less_retainage_cents: number;
  previous_certificates_cents: number; current_payment_due_cents: number; balance_to_finish_incl_retainage_cents: number;
}, request: { gross_earned_cents: number; retainage_cents: number; net_cents: number }): G702 {
  return {
    originalContract: v.original_contract_cents,
    netChangeByCo: v.net_change_by_co_cents,
    contractSumToDate: v.contract_sum_to_date_cents,
    completedStoredToDate: v.total_completed_stored_cents,
    retainageWork: v.retainage_work_cents,
    retainageStored: v.retainage_stored_cents,
    retainageTotal: v.retainage_total_cents,
    earnedLessRetainage: v.total_earned_less_retainage_cents,
    previousCertificates: v.previous_certificates_cents,
    currentPaymentDue: v.current_payment_due_cents,
    balanceToFinishInclRetainage: v.balance_to_finish_incl_retainage_cents,
    grossThisPeriod: request.gross_earned_cents,
    retainageThisPeriod: request.retainage_cents,
    netThisPeriod: request.net_cents,
  };
}

/** Counted SOV applications before `applicationNo` (all when null): line 7 and the retainage they held. */
export function previousApplications(
  requests: ReadonlyArray<{ id: string; billing_subtype: string | null; status: string; application_no: number | null; net_cents: number; retainage_cents: number }>,
  applicationNo: number | null,
): { previousCertificatesCents: number; previousRetainageHeldCents: number } {
  let net = 0, held = 0;
  for (const r of requests) {
    if (r.billing_subtype !== 'SOV' || !COUNTED_STATUSES.has(r.status)) continue;
    if (applicationNo != null && (r.application_no == null || r.application_no >= applicationNo)) continue;
    net += r.net_cents;
    held += r.retainage_cents;
  }
  return { previousCertificatesCents: net, previousRetainageHeldCents: held };
}
