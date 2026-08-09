/**
 * 1099-NEC readiness — the aggregation + readiness logic behind the CPA panel.
 *
 * CPA framing (docs/discovery/books/cpa-tax-assurance.md §A3 / §B4): a vendor is a
 * 1099-NEC candidate when it was paid **$600 or more** for services in the calendar
 * year by a REPORTABLE rail (cash / check / ACH / wire). Card / third-party-network
 * payments are EXCLUDED — those land on the processor's 1099-K, and issuing a
 * 1099-NEC on top would double-report. Getting that rail split right is the whole
 * point of doing this off the owned ledger instead of a spreadsheet.
 *
 * The "reportable payments" number is built from POSTED `bill_payments` in the year
 * (the AP settlement sub-ledger, migration 030), mapped to their vendor via
 * `public.bills`. Vendor tax facts (is_1099_eligible, tin_encrypted, w9_status) come
 * from `core.vendors` (migration 005, carved to core in 019); W-9 currency is
 * cross-checked against any tracked `vendor_compliance_docs` W-9 row so an EXPIRED
 * doc surfaces even though the vendor.w9_status enum has no EXPIRED state.
 *
 * All money is bigint cents. Reads are RLS-scoped by the caller — this module never
 * filters org_id by hand; the database enforces tenant isolation.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  BOX_META,
  classify1099Box,
  apportionCents,
  mergeBoxCents,
  type Box1099Code,
  type Form1099Type,
  type BoxCents,
} from '@/lib/tax/box-classify';

/** IRS reporting floor: $600 OR MORE (not strictly "over") in reportable payments. */
export const REPORTABLE_THRESHOLD_CENTS = 60_000;

export type W9State = 'on_file' | 'missing' | 'expired';
export type Readiness = 'READY' | 'MISSING_W9' | 'NOT_MARKED_1099';

/** One box slice of a vendor's reportable spend (derived from GL expense coding). */
export interface Ten99Box {
  code: Box1099Code;
  form: Form1099Type;
  /** IRS box label (e.g. "Rents"). */
  label: string;
  /** Compact label for dense UI. */
  short: string;
  cents: number;
}

export interface Ten99Row {
  vendorId: string;
  vendorName: string;
  /** Reportable (non-card) payments to this vendor in the tax year, in cents. */
  totalPaidCents: number;
  paymentCount: number;
  is1099Eligible: boolean;
  w9Status: W9State;
  tinPresent: boolean;
  readiness: Readiness;
  /**
   * The reportable total split across 1099 boxes, classified from the GL expense
   * accounts the vendor's paid bills were coded to. Sorted largest first.
   */
  boxes: Ten99Box[];
  /** The form of the largest box — how this candidate should predominantly be filed. */
  primaryForm: Form1099Type;
  /** NEC Box-1 (nonemployee compensation) portion of the reportable total, cents. */
  necReportableCents: number;
}

export interface Ten99Summary {
  taxYear: number;
  thresholdCents: number;
  candidates: number;
  ready: number;
  /** Candidates NOT ready — a W-9/TIN gap or not marked 1099-eligible. */
  missingDocs: number;
  /** Total reportable $ sitting behind un-documented candidates (cents). */
  dollarsAtRiskCents: number;
  /** Candidates whose predominant box is 1099-NEC (nonemployee compensation). */
  necCandidates: number;
  /** Candidates whose predominant box is 1099-MISC (rents / royalties / medical / attorney). */
  miscCandidates: number;
}

export interface Ten99Report {
  summary: Ten99Summary;
  rows: Ten99Row[];
}

/** Facts needed to classify a single vendor's 1099 readiness. Pure inputs. */
export interface ReadinessFacts {
  is1099Eligible: boolean;
  w9Status: W9State;
  tinPresent: boolean;
}

/**
 * Pure readiness decision — unit-testable, no I/O.
 *   NOT_MARKED_1099: crossed the $600 floor but the vendor isn't flagged
 *                    1099-eligible (could be a corporation/exempt — a CPA must
 *                    confirm; it is a documentation GAP until they do).
 *   MISSING_W9:      flagged 1099-eligible but the W-9 isn't on file (or expired)
 *                    or there's no TIN — the January-chase population.
 *   READY:           eligible, W-9 on file, TIN present — safe to file.
 */
export function computeReadiness(f: ReadinessFacts): Readiness {
  if (!f.is1099Eligible) return 'NOT_MARKED_1099';
  if (f.w9Status !== 'on_file' || !f.tinPresent) return 'MISSING_W9';
  return 'READY';
}

/** Card / third-party-network rails are 1099-K, never 1099-NEC — exclude them. */
function isReportableRail(method: string | null, rail: string | null): boolean {
  const m = (method ?? '').toUpperCase();
  const r = (rail ?? '').toUpperCase();
  if (m.includes('CARD') || r.includes('CARD')) return false; // CREDIT_CARD, etc.
  return true;
}

/** Derive a single W-9 state from the vendor flag + any tracked compliance doc. */
function deriveW9State(
  vendorW9Status: string | null,
  doc: { status: string; expiration_date: string | null } | undefined,
  now: Date,
): W9State {
  const vendorOnFile = vendorW9Status === 'RECEIVED' || vendorW9Status === 'VERIFIED';
  let docExpired = false;
  let docValid = false;
  if (doc) {
    if (doc.status === 'EXPIRED') docExpired = true;
    else if (doc.status === 'VALID') {
      if (doc.expiration_date && new Date(doc.expiration_date) < now) docExpired = true;
      else docValid = true;
    }
  }
  if (docExpired) return 'expired';
  if (vendorOnFile || docValid) return 'on_file';
  return 'missing';
}

/**
 * Build the full 1099-NEC readiness report for an org + tax year.
 * `supabase` MUST be an RLS-scoped (authed) client.
 */
export async function buildReadinessReport(
  supabase: SupabaseClient,
  taxYear: number,
): Promise<Ten99Report> {
  const now = new Date();
  const start = `${taxYear}-01-01`;
  const end = `${taxYear}-12-31`;

  const emptyReport = (): Ten99Report => ({
    summary: {
      taxYear,
      thresholdCents: REPORTABLE_THRESHOLD_CENTS,
      candidates: 0,
      ready: 0,
      missingDocs: 0,
      dollarsAtRiskCents: 0,
      necCandidates: 0,
      miscCandidates: 0,
    },
    rows: [],
  });

  // 1. POSTED settlements in the tax year (the reportable-payment source of truth).
  const { data: payRows, error: payErr } = await supabase
    .from('bill_payments')
    .select('bill_id, amount_cents, method, rail, payment_date, status')
    .eq('status', 'POSTED')
    .gte('payment_date', start)
    .lte('payment_date', end)
    .limit(10_000);
  if (payErr) throw new Error(`bill_payments load failed: ${payErr.message}`);
  const payments = (payRows ?? []) as Array<{
    bill_id: string;
    amount_cents: number | string;
    method: string | null;
    rail: string | null;
  }>;
  if (payments.length === 0) return emptyReport();

  // 2. Map each paid bill → its vendor.
  const billIds = [...new Set(payments.map((p) => p.bill_id))];
  const billVendor = new Map<string, string>();
  for (let i = 0; i < billIds.length; i += 500) {
    const slice = billIds.slice(i, i + 500);
    const { data: billsRaw } = await supabase
      .from('bills')
      .select('id, vendor_id')
      .in('id', slice);
    for (const b of (billsRaw ?? []) as Array<{ id: string; vendor_id: string }>) {
      billVendor.set(b.id, b.vendor_id);
    }
  }

  // 2b. Box weights per bill — classify each bill's expense lines into 1099 boxes so a
  //     payment's reportable cents can be apportioned to the correct return (NEC vs the
  //     several MISC boxes). Sourced from the OWNED ledger's GL coding, not a guess.
  const billBoxWeights = new Map<string, BoxCents>();
  {
    // Collect the account_ids coded on the paid bills, then classify them once.
    const lineRows: Array<{ bill_id: string; account_id: string; amount_cents: number | string }> = [];
    for (let i = 0; i < billIds.length; i += 500) {
      const slice = billIds.slice(i, i + 500);
      const { data: rows } = await supabase
        .from('bill_lines')
        .select('bill_id, account_id, amount_cents')
        .in('bill_id', slice);
      for (const r of (rows ?? []) as typeof lineRows) lineRows.push(r);
    }
    const acctIds = [...new Set(lineRows.map((l) => l.account_id).filter(Boolean))];
    const acctBox = new Map<string, Box1099Code>();
    for (let i = 0; i < acctIds.length; i += 500) {
      const slice = acctIds.slice(i, i + 500);
      if (slice.length === 0) break;
      const { data: aRows } = await supabase
        .from('accounts')
        .select('id, account_number, name')
        .in('id', slice);
      for (const a of (aRows ?? []) as Array<{ id: string; account_number: string | null; name: string | null }>) {
        acctBox.set(a.id, classify1099Box(a.account_number, a.name));
      }
    }
    for (const l of lineRows) {
      const box = acctBox.get(l.account_id) ?? 'NEC_1';
      const w = billBoxWeights.get(l.bill_id) ?? {};
      w[box] = (w[box] ?? 0) + (Number(l.amount_cents) || 0);
      billBoxWeights.set(l.bill_id, w);
    }
  }

  // 3. Aggregate reportable (non-card) cents + count + per-box split per vendor.
  const agg = new Map<string, { cents: number; count: number; boxes: BoxCents }>();
  for (const p of payments) {
    if (!isReportableRail(p.method, p.rail)) continue;
    const vendorId = billVendor.get(p.bill_id);
    if (!vendorId) continue;
    const cents = Number(p.amount_cents) || 0;
    const cur = agg.get(vendorId) ?? { cents: 0, count: 0, boxes: {} as BoxCents };
    cur.cents += cents;
    cur.count += 1;
    // Split this payment across boxes by the bill's expense-line coding.
    mergeBoxCents(cur.boxes, apportionCents(cents, billBoxWeights.get(p.bill_id) ?? {}));
    agg.set(vendorId, cur);
  }

  // 4. Keep only vendors at/above the $600 floor — the 1099 candidates.
  const candidateIds = [...agg.entries()]
    .filter(([, v]) => v.cents >= REPORTABLE_THRESHOLD_CENTS)
    .map(([id]) => id);
  if (candidateIds.length === 0) return emptyReport();

  // 5. Vendor tax facts (core.vendors).
  const vendorFacts = new Map<
    string,
    { name: string; is1099: boolean; tin: string | null; w9: string | null }
  >();
  for (let i = 0; i < candidateIds.length; i += 500) {
    const slice = candidateIds.slice(i, i + 500);
    const { data: vRows } = await supabase
      .schema('core')
      .from('vendors')
      .select('id, name, display_name, is_1099_eligible, tin_encrypted, w9_status')
      .in('id', slice);
    for (const v of (vRows ?? []) as Array<{
      id: string;
      name: string;
      display_name: string | null;
      is_1099_eligible: boolean;
      tin_encrypted: string | null;
      w9_status: string | null;
    }>) {
      vendorFacts.set(v.id, {
        name: v.display_name || v.name,
        is1099: v.is_1099_eligible === true,
        tin: v.tin_encrypted,
        w9: v.w9_status,
      });
    }
  }

  // 6. W-9 compliance docs (to catch EXPIRED, which vendor.w9_status can't express).
  const w9Doc = new Map<string, { status: string; expiration_date: string | null }>();
  for (let i = 0; i < candidateIds.length; i += 500) {
    const slice = candidateIds.slice(i, i + 500);
    const { data: dRows } = await supabase
      .from('vendor_compliance_docs')
      .select('vendor_id, status, expiration_date')
      .eq('doc_type', 'W9')
      .in('vendor_id', slice);
    for (const d of (dRows ?? []) as Array<{
      vendor_id: string;
      status: string;
      expiration_date: string | null;
    }>) {
      // Prefer the most "advanced" doc if a vendor somehow has multiple W-9 rows.
      const existing = w9Doc.get(d.vendor_id);
      if (!existing || d.status === 'VALID' || d.status === 'EXPIRED') {
        w9Doc.set(d.vendor_id, { status: d.status, expiration_date: d.expiration_date });
      }
    }
  }

  // 7. Assemble rows.
  const rows: Ten99Row[] = candidateIds.map((vendorId) => {
    const a = agg.get(vendorId)!;
    const facts = vendorFacts.get(vendorId);
    const w9State = deriveW9State(facts?.w9 ?? null, w9Doc.get(vendorId), now);
    const tinPresent = !!(facts?.tin && facts.tin.trim().length > 0);
    const is1099Eligible = facts?.is1099 ?? false;

    // Box breakdown, largest first. Any un-apportioned residue lands in NEC (defensive).
    const boxes: Ten99Box[] = (Object.entries(a.boxes) as [Box1099Code, number][])
      .filter(([, cents]) => (cents || 0) > 0)
      .map(([code, cents]) => ({
        code,
        form: BOX_META[code].form,
        label: BOX_META[code].label,
        short: BOX_META[code].short,
        cents,
      }))
      .sort((x, y) => y.cents - x.cents);
    const boxedTotal = boxes.reduce((s, b) => s + b.cents, 0);
    if (boxedTotal < a.cents) {
      // Payments on bills with no expense lines default to NEC.
      const residue = a.cents - boxedTotal;
      const nec = boxes.find((b) => b.code === 'NEC_1');
      if (nec) nec.cents += residue;
      else
        boxes.push({
          code: 'NEC_1',
          form: 'NEC',
          label: BOX_META.NEC_1.label,
          short: BOX_META.NEC_1.short,
          cents: residue,
        });
      boxes.sort((x, y) => y.cents - x.cents);
    }
    const primaryForm: Form1099Type = boxes[0]?.form ?? 'NEC';
    const necReportableCents = boxes
      .filter((b) => b.form === 'NEC')
      .reduce((s, b) => s + b.cents, 0);

    return {
      vendorId,
      vendorName: facts?.name ?? 'Unknown vendor',
      totalPaidCents: a.cents,
      paymentCount: a.count,
      is1099Eligible,
      w9Status: w9State,
      tinPresent,
      readiness: computeReadiness({ is1099Eligible, w9Status: w9State, tinPresent }),
      boxes,
      primaryForm,
      necReportableCents,
    };
  });

  // Gaps first, then largest dollars — the CPA works top-down.
  const rank: Record<Readiness, number> = { MISSING_W9: 0, NOT_MARKED_1099: 1, READY: 2 };
  rows.sort(
    (x, y) => rank[x.readiness] - rank[y.readiness] || y.totalPaidCents - x.totalPaidCents,
  );

  const ready = rows.filter((r) => r.readiness === 'READY').length;
  const missingDocs = rows.length - ready;
  const dollarsAtRiskCents = rows
    .filter((r) => r.readiness !== 'READY')
    .reduce((s, r) => s + r.totalPaidCents, 0);
  const necCandidates = rows.filter((r) => r.primaryForm === 'NEC').length;
  const miscCandidates = rows.length - necCandidates;

  return {
    summary: {
      taxYear,
      thresholdCents: REPORTABLE_THRESHOLD_CENTS,
      candidates: rows.length,
      ready,
      missingDocs,
      dollarsAtRiskCents,
      necCandidates,
      miscCandidates,
    },
    rows,
  };
}
