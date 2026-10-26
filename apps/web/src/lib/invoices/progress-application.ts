/**
 * Progress billing as an Application and Certificate for Payment (AIA G702/G703 style).
 * PURE — no I/O. invoice-doc.ts loads the facts; invoice-pdf.tsx renders the result.
 *
 * Why: a progress bill (invoices.is_progress_bill / application_number) printed as a plain
 * invoice — one "Progress draw #1" line and a total — so an owner, architect or lender had
 * no contract sum, completed-to-date, retainage or previous-certificates figures to certify.
 *
 * Sources (all Books facts; nothing invented):
 *   - contract sum: core.jobs.original_contract_cents (before change orders) and
 *     contract_amount_cents (current, change orders included). Unknown → null ("—").
 *   - work completed: the gross amount of REVENUE lines on every issued progress bill for
 *     the job up to and including this one (prior = earlier invoice date, or same date and a
 *     lower invoice number). DRAFT / VOIDED bills never count.
 *   - retainage: invoices.retainage_cents withheld, less retainage-release lines (lines on a
 *     balance-sheet account — CR Retainage receivable, see services/billing-consumer.ts).
 *   - Books does not track stored materials separately, so "materials presently stored" is 0.
 *
 * G702 lines:
 *   1 original contract sum · 2 net change by change orders · 3 contract sum to date (1+2)
 *   4 total completed & stored to date · 5 retainage · 6 total earned less retainage (4−5)
 *   7 less previous certificates for payment · 8 current payment due (6−7)
 *   9 balance to finish, including retainage (3−6)
 * Line 8 ties to this invoice: gross work − retainage withheld + retainage released
 * (sales tax, if any, is added below line 8 on the document — it is not part of G702).
 *
 * All money is integer cents.
 */

export interface ProgressLineFact {
  description: string;
  amountCents: number;
  /** A retainage release line (balance-sheet account), not completed work. */
  isRelease: boolean;
}

export interface ProgressBillFact {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  status: string;
  applicationNumber: number | null;
  /** Retainage WITHHELD on this bill (invoices.retainage_cents). */
  retainageCents: number;
  lines: ProgressLineFact[];
}

export interface ProgressContractFact {
  originalContractCents: number | null;
  contractSumToDateCents: number | null;
}

export interface ProgressSummary {
  applicationNumber: number;
  originalContractCents: number | null;
  netChangeOrdersCents: number | null;
  contractSumToDateCents: number | null;
  completedToDateCents: number;
  retainageToDateCents: number;
  earnedLessRetainageCents: number;
  previousCertificatesCents: number;
  currentPaymentDueCents: number;
  balanceToFinishCents: number | null;
  /** completed ÷ contract sum to date, 0–100+ (null when the contract sum is unknown). */
  percentComplete: number | null;
}

export interface ContinuationRow {
  itemNo: string;
  description: string;
  scheduledValueCents: number | null;
  previousCents: number;
  thisPeriodCents: number;
  materialsStoredCents: number;
  completedToDateCents: number;
  percentComplete: number | null;
  balanceToFinishCents: number | null;
  retainageCents: number;
}

export interface ProgressApplication {
  summary: ProgressSummary;
  rows: ContinuationRow[];
  totals: ContinuationRow;
  /** Bills counted as previous applications (oldest first). */
  previousBills: Array<{ invoiceNumber: string; invoiceDate: string; applicationNumber: number | null }>;
  /** True when the schedule of values comes from bill lines, not a contract SOV. */
  derivedSchedule: boolean;
}

const NOT_ISSUED = new Set(['DRAFT', 'VOIDED']);

/** Does this invoice print as a progress application? */
export function isProgressBilling(inv: { is_progress_bill?: boolean | null; application_number?: number | null }): boolean {
  return inv.is_progress_bill === true || (inv.application_number != null && Number.isFinite(Number(inv.application_number)));
}

/** Bills on the same job issued before `current` (date, then invoice number), oldest first. */
export function priorProgressBills(current: Pick<ProgressBillFact, 'id' | 'invoiceDate' | 'invoiceNumber'>, all: readonly ProgressBillFact[]): ProgressBillFact[] {
  return all
    .filter((b) => b.id !== current.id && !NOT_ISSUED.has(b.status))
    .filter((b) => b.invoiceDate < current.invoiceDate || (b.invoiceDate === current.invoiceDate && b.invoiceNumber < current.invoiceNumber))
    .sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate) || a.invoiceNumber.localeCompare(b.invoiceNumber));
}

const gross = (b: ProgressBillFact) => b.lines.filter((l) => !l.isRelease).reduce((s, l) => s + l.amountCents, 0);
const released = (b: ProgressBillFact) => b.lines.filter((l) => l.isRelease).reduce((s, l) => s + l.amountCents, 0);
const netRetainage = (bills: readonly ProgressBillFact[]) => bills.reduce((s, b) => s + b.retainageCents - released(b), 0);
const norm = (d: string) => d.trim().replace(/\s+/g, ' ').toLowerCase();

function pct(part: number, whole: number | null): number | null {
  if (whole === null || whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

/** Split `total` across `weights` in proportion, largest remainder — the parts always sum to `total`. */
export function allocateProRata(total: number, weights: readonly number[]): number[] {
  const sumW = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (weights.length === 0) return [];
  if (sumW <= 0 || total === 0) return weights.map(() => 0);
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const raw = weights.map((w) => (Math.max(0, w) * abs) / sumW);
  const out = raw.map((r) => Math.floor(r));
  let left = abs - out.reduce((s, v) => s + v, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k++, left--) out[order[k].i] += 1;
  return out.map((v) => v * sign);
}

export function buildProgressApplication(input: {
  current: ProgressBillFact;
  /** Every progress bill on the job (the current one may be included; it is skipped). */
  jobBills: readonly ProgressBillFact[];
  contract: ProgressContractFact | null;
}): ProgressApplication {
  const { current } = input;
  const prior = priorProgressBills(current, input.jobBills);

  // ── G702 ────────────────────────────────────────────────────────────────────
  const original = input.contract?.originalContractCents ?? input.contract?.contractSumToDateCents ?? null;
  const toDate = input.contract?.contractSumToDateCents ?? input.contract?.originalContractCents ?? null;
  const netCO = original !== null && toDate !== null ? toDate - original : null;
  const priorCompleted = prior.reduce((s, b) => s + gross(b), 0);
  const completed = priorCompleted + gross(current);
  const priorRetainage = netRetainage(prior);
  const retainage = priorRetainage + current.retainageCents - released(current);
  const earned = completed - retainage;
  const previousCerts = priorCompleted - priorRetainage;
  const applicationNumber = current.applicationNumber ?? prior.length + 1;

  const summary: ProgressSummary = {
    applicationNumber,
    originalContractCents: original,
    netChangeOrdersCents: netCO,
    contractSumToDateCents: toDate,
    completedToDateCents: completed,
    retainageToDateCents: retainage,
    earnedLessRetainageCents: earned,
    previousCertificatesCents: previousCerts,
    currentPaymentDueCents: earned - previousCerts,
    balanceToFinishCents: toDate === null ? null : toDate - earned,
    percentComplete: pct(completed, toDate),
  };

  // ── G703 continuation sheet — rows keyed by line description across the job's bills ──
  const order: string[] = [];
  const byKey = new Map<string, { description: string; previous: number; current: number }>();
  const add = (l: ProgressLineFact, which: 'previous' | 'current') => {
    if (l.isRelease) return;
    const k = norm(l.description) || '(no description)';
    let r = byKey.get(k);
    if (!r) {
      r = { description: l.description.trim() || 'Work completed', previous: 0, current: 0 };
      byKey.set(k, r);
      order.push(k);
    }
    r[which] += l.amountCents;
  };
  for (const b of prior) for (const l of b.lines) add(l, 'previous');
  for (const l of current.lines) add(l, 'current');

  // A single row IS the whole contract; with several rows we have no per-line scheduled
  // value (no contract SOV in Books), so those cells print "—" and only the total carries it.
  const single = order.length === 1;
  const rowRetainage = allocateProRata(retainage, order.map((k) => byKey.get(k)!.previous + byKey.get(k)!.current));
  const rows: ContinuationRow[] = order.map((k, i) => {
    const r = byKey.get(k)!;
    const done = r.previous + r.current;
    const scheduled = single ? toDate : null;
    return {
      itemNo: String(i + 1),
      description: r.description,
      scheduledValueCents: scheduled,
      previousCents: r.previous,
      thisPeriodCents: r.current,
      materialsStoredCents: 0,
      completedToDateCents: done,
      percentComplete: pct(done, scheduled),
      balanceToFinishCents: scheduled === null ? null : scheduled - done,
      retainageCents: rowRetainage[i],
    };
  });
  const totals: ContinuationRow = {
    itemNo: '',
    description: 'Grand total',
    scheduledValueCents: toDate,
    previousCents: priorCompleted,
    thisPeriodCents: gross(current),
    materialsStoredCents: 0,
    completedToDateCents: completed,
    percentComplete: pct(completed, toDate),
    balanceToFinishCents: toDate === null ? null : toDate - completed,
    retainageCents: retainage,
  };

  return {
    summary,
    rows,
    totals,
    previousBills: prior.map((b) => ({ invoiceNumber: b.invoiceNumber, invoiceDate: b.invoiceDate, applicationNumber: b.applicationNumber })),
    derivedSchedule: true,
  };
}
