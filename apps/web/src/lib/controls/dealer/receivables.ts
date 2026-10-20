/**
 * Manufacturer receivables — DL-5 / DL-6 warranty and DL-7 incentives (FPB §6).
 *
 *   DL-5 deadline   DRAFT claim within `warranty_deadline_warn_days` of its filing
 *                   deadline (or past it)                               → HIGH
 *   DL-5 aging      SUBMITTED / RESUBMITTED / PARTIAL unpaid longer than
 *                   `warranty_submitted_aging_days`                     → MEDIUM
 *   DL-6 short pay  PARTIAL with a manufacturer credit and money still open → MEDIUM
 *   DL-6 rejected   REJECTED with money still open                      → MEDIUM
 *   DL-6 rate       a manufacturer rejected more than 10% of the claims submitted in
 *                   the last 90 days (at least 5 claims, so one rejection of one
 *                   claim is not a "rate")                              → MEDIUM, per OEM + month
 *   DL-7 deadline   ACCRUED incentive not submitted within
 *                   `incentive_deadline_warn_days` of its claim deadline → MEDIUM
 *   DL-7 aging      SUBMITTED / PARTIAL unpaid longer than
 *                   `incentive_submitted_aging_days`                    → MEDIUM
 */

import { addDays, diffDays } from '@/lib/dealer/dates';
import { openCents } from '@/lib/dealer/engine/warranty';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { dateLabel, bpsToPct } from '@/lib/dealer/ui/format';
import { fetchAll } from '@/lib/supabase/fetch-all';
import {
  DEALER_FEATURES,
  money,
  monthKey,
  plural,
  readFail,
  vendorNames,
  type ClientScan,
  type DealerDetectorDef,
  type DealerFinding,
} from './shared';

/** DL-6 rate rule (FPB: "over 10% in 90 days"). */
export const WARRANTY_REJECTION = { windowDays: 90, rateBps: 1000, minClaims: 5 } as const;

export interface WarrantyClaimIn {
  id: string;
  oem_vendor_id: string;
  oem_claim_number: string | null;
  dealer_claim_ref: string | null;
  serial_number: string | null;
  status: string;
  filing_deadline: string | null;
  submitted_date: string | null;
  claimed_cents: number;
  settled_cents: number;
  written_off_cents: number;
}

function claimRef(c: Pick<WarrantyClaimIn, 'oem_claim_number' | 'dealer_claim_ref' | 'serial_number'>): string {
  if (c.oem_claim_number) return `claim ${c.oem_claim_number}`;
  if (c.dealer_claim_ref) return `claim ${c.dealer_claim_ref}`;
  if (c.serial_number) return `claim for serial ${c.serial_number}`;
  return 'an unnumbered claim';
}

export function warrantyFindings(input: {
  asOf: string;
  deadlineWarnDays: number;
  submittedAgingDays: number;
  claims: WarrantyClaimIn[];
  /** Warranty claims with a REJECTED event (any time) — counts toward the rate. */
  rejectedClaimIds: ReadonlySet<string>;
  oemNames: Map<string, string>;
}): DealerFinding[] {
  const out: DealerFinding[] = [];
  for (const c of input.claims) {
    const open = openCents(c);
    const ref = claimRef(c);
    const base = {
      href: dealerLinks.warranty({ claim: c.id }),
      subjects: { warranty_claim_id: c.id, oem_vendor_id: c.oem_vendor_id },
      subjectTable: 'warranty_claims',
      subjectId: c.id,
    };
    if (c.status === 'DRAFT' && c.filing_deadline) {
      const left = diffDays(input.asOf, c.filing_deadline);
      if (left <= input.deadlineWarnDays) {
        out.push({
          ...base,
          control: 'DL-5',
          kind: 'deadline',
          dedupKey: `DL-5:${c.id}:deadline`,
          severity: 'HIGH',
          amountAtRiskCents: c.claimed_cents,
          title:
            left >= 0
              ? `Warranty claim not filed: ${ref} · ${money(c.claimed_cents)}, filing deadline ${left === 0 ? 'today' : `in ${plural(left, 'day')}`}`
              : `Warranty filing deadline passed: ${ref} · ${money(c.claimed_cents)}, ${plural(-left, 'day')} ago`,
          reason: `The ${money(c.claimed_cents)} warranty claim is still a draft and the manufacturer's filing deadline is ${dateLabel(c.filing_deadline)}. A claim filed late is usually refused.`,
          question: 'Finish and submit the claim to the manufacturer before the deadline.',
          facts: { filing_deadline: c.filing_deadline, days_left: left },
        });
      }
    }
    if ((c.status === 'SUBMITTED' || c.status === 'RESUBMITTED' || c.status === 'PARTIAL') && c.submitted_date && open > 0) {
      const days = diffDays(c.submitted_date, input.asOf);
      if (days > input.submittedAgingDays) {
        out.push({
          ...base,
          control: 'DL-5',
          kind: 'aging',
          dedupKey: `DL-5:${c.id}:aging`,
          severity: 'MEDIUM',
          amountAtRiskCents: open,
          title: `Warranty claim unpaid: ${ref} · ${money(open)} outstanding ${plural(days, 'day')}`,
          reason: `The claim was submitted ${dateLabel(c.submitted_date)} and ${money(open)} is still unpaid after ${plural(days, 'day')} (the follow-up point is ${plural(input.submittedAgingDays, 'day')}).`,
          question: 'Follow up with the manufacturer on this claim, or check the latest manufacturer statement for the credit.',
          facts: { submitted_date: c.submitted_date, days_outstanding: days },
        });
      }
    }
    if (c.status === 'PARTIAL' && c.settled_cents > 0 && open > 0) {
      out.push({
        ...base,
        control: 'DL-6',
        kind: 'short_pay',
        dedupKey: `DL-6:${c.id}:short_pay`,
        severity: 'MEDIUM',
        amountAtRiskCents: open,
        title: `Warranty short-pay: ${ref} · paid ${money(c.settled_cents)} of ${money(c.claimed_cents)} (${money(open)} short)`,
        reason: `The manufacturer credited ${money(c.settled_cents)} against a ${money(c.claimed_cents)} claim, leaving ${money(open)} unpaid.`,
        question: 'Accept the short-pay (a parts & service manager approves; it goes to warranty policy expense) or resubmit the difference.',
      });
    }
    if (c.status === 'REJECTED' && open > 0) {
      out.push({
        ...base,
        control: 'DL-6',
        kind: 'rejected',
        dedupKey: `DL-6:${c.id}:rejected`,
        severity: 'MEDIUM',
        amountAtRiskCents: open,
        title: `Warranty claim rejected: ${ref} · ${money(open)}`,
        reason: `The manufacturer rejected this claim; ${money(open)} remains on the warranty receivable until it is resubmitted or written off.`,
        question: 'Resubmit the claim with the missing support, or write it off (an approver signs off).',
      });
    }
  }

  // Rejection rate per manufacturer over the trailing window.
  const windowStart = addDays(input.asOf, -WARRANTY_REJECTION.windowDays);
  const byOem = new Map<string, { submitted: number; rejected: number; rejectedCents: number }>();
  for (const c of input.claims) {
    if (c.status === 'DRAFT' || c.status === 'VOID' || !c.submitted_date) continue;
    if (c.submitted_date < windowStart || c.submitted_date > input.asOf) continue;
    const agg = byOem.get(c.oem_vendor_id) ?? { submitted: 0, rejected: 0, rejectedCents: 0 };
    agg.submitted += 1;
    if (c.status === 'REJECTED' || input.rejectedClaimIds.has(c.id)) {
      agg.rejected += 1;
      agg.rejectedCents += c.claimed_cents;
    }
    byOem.set(c.oem_vendor_id, agg);
  }
  for (const [oem, a] of byOem) {
    if (a.submitted < WARRANTY_REJECTION.minClaims) continue;
    const bps = Math.floor((a.rejected * 10_000) / a.submitted);
    if (bps <= WARRANTY_REJECTION.rateBps) continue;
    const name = input.oemNames.get(oem) ?? 'one manufacturer';
    out.push({
      control: 'DL-6',
      kind: 'rejection_rate',
      dedupKey: `DL-6:rate:${oem}:${monthKey(input.asOf)}`,
      severity: 'MEDIUM',
      amountAtRiskCents: a.rejectedCents,
      title: `Warranty rejection rate high: ${name} · ${a.rejected} of ${a.submitted} claims (${bpsToPct(bps, 0)}) in ${WARRANTY_REJECTION.windowDays} days`,
      reason: `${name} rejected ${a.rejected} of the ${a.submitted} warranty claims submitted in the last ${WARRANTY_REJECTION.windowDays} days (${bpsToPct(bps, 1)}; the warning level is ${bpsToPct(WARRANTY_REJECTION.rateBps, 0)}). A high rejection rate usually means a documentation or labor-time problem in the claim process.`,
      question: 'Review the rejected claims with the service manager and fix the common cause before submitting more.',
      href: dealerLinks.warranty({ status: 'REJECTED' }),
      subjects: { oem_vendor_id: oem },
      subjectTable: 'warranty_claims',
      subjectId: null,
      facts: { submitted: a.submitted, rejected: a.rejected, rate_bps: bps, window_days: WARRANTY_REJECTION.windowDays },
    });
  }
  return out;
}

function toWarranty(r: Record<string, unknown>): WarrantyClaimIn {
  return {
    id: r.id as string,
    oem_vendor_id: r.oem_vendor_id as string,
    oem_claim_number: (r.oem_claim_number as string | null) ?? null,
    dealer_claim_ref: (r.dealer_claim_ref as string | null) ?? null,
    serial_number: (r.serial_number as string | null) ?? null,
    status: String(r.status),
    filing_deadline: (r.filing_deadline as string | null) ?? null,
    submitted_date: (r.submitted_date as string | null) ?? null,
    claimed_cents: Number(r.claimed_cents ?? 0),
    settled_cents: Number(r.settled_cents ?? 0),
    written_off_cents: Number(r.written_off_cents ?? 0),
  };
}

const WARRANTY_COLS = 'id, oem_vendor_id, oem_claim_number, dealer_claim_ref, serial_number, status, filing_deadline, submitted_date, claimed_cents, settled_cents, written_off_cents';

async function collectWarranty(c: ClientScan): Promise<DealerFinding[]> {
  const windowStart = addDays(c.asOf, -WARRANTY_REJECTION.windowDays);
  const [openRes, recentRes, eventsRes] = await Promise.all([
    fetchAll<Record<string, unknown>>(
      () =>
        c.db.from('warranty_claims').select(WARRANTY_COLS).eq('org_id', c.orgId).eq('location_id', c.locationId)
          .in('status', ['DRAFT', 'SUBMITTED', 'RESUBMITTED', 'PARTIAL', 'REJECTED']),
      { label: 'DL-5 open warranty claims' },
    ),
    fetchAll<Record<string, unknown>>(
      () =>
        c.db.from('warranty_claims').select(WARRANTY_COLS).eq('org_id', c.orgId).eq('location_id', c.locationId)
          .gte('submitted_date', windowStart),
      { label: 'DL-6 recent warranty claims' },
    ),
    fetchAll<Record<string, unknown>>(
      () =>
        c.db.from('dealer_claim_events').select('id, warranty_claim_id').eq('org_id', c.orgId).eq('location_id', c.locationId)
          .eq('claim_kind', 'WARRANTY').eq('event_type', 'REJECTED').gte('event_date', windowStart),
      { label: 'DL-6 rejection events' },
    ),
  ]);
  for (const r of [openRes, recentRes, eventsRes]) if (r.error) readFail('Warranty lookup failed', r.error);
  const byId = new Map<string, WarrantyClaimIn>();
  for (const r of [...(openRes.data ?? []), ...(recentRes.data ?? [])]) {
    const w = toWarranty(r);
    if (w.status !== 'VOID') byId.set(w.id, w);
  }
  const claims = [...byId.values()];
  const oemNames = await vendorNames(c.db, claims.map((x) => x.oem_vendor_id));
  return warrantyFindings({
    asOf: c.asOf,
    deadlineWarnDays: c.settings.warranty_deadline_warn_days,
    submittedAgingDays: c.settings.warranty_submitted_aging_days,
    claims,
    rejectedClaimIds: new Set((eventsRes.data ?? []).map((e) => e.warranty_claim_id as string)),
    oemNames,
  });
}

export const WARRANTY_DETECTOR: DealerDetectorDef = {
  key: 'dealer_warranty',
  feature: DEALER_FEATURES.WARRANTY,
  control: 'DL-5/DL-6',
  label: 'Warranty claim aging, deadlines, short-pays and rejections',
  collect: collectWarranty,
};

// ── DL-7 ─────────────────────────────────────────────────────────────────────

export interface IncentiveClaimIn {
  id: string;
  program_id: string;
  program_name: string;
  claim_reference: string | null;
  status: string;
  earned_date: string;
  claim_deadline: string | null;
  submitted_date: string | null;
  accrued_cents: number;
  claimed_cents: number;
  settled_cents: number;
  written_off_cents: number;
}

export function incentiveOpenCents(c: Pick<IncentiveClaimIn, 'accrued_cents' | 'claimed_cents' | 'settled_cents' | 'written_off_cents'>): number {
  return Math.max(0, Math.max(c.claimed_cents, c.accrued_cents) - c.settled_cents - c.written_off_cents);
}

export function incentiveFindings(input: {
  asOf: string;
  deadlineWarnDays: number;
  submittedAgingDays: number;
  claims: IncentiveClaimIn[];
}): DealerFinding[] {
  const out: DealerFinding[] = [];
  for (const c of input.claims) {
    const open = incentiveOpenCents(c);
    if (open <= 0) continue;
    const what = c.claim_reference ? `${c.program_name} (${c.claim_reference})` : c.program_name;
    const base = {
      control: 'DL-7',
      amountAtRiskCents: open,
      href: dealerLinks.incentives({ claim: c.id }),
      subjects: { incentive_claim_id: c.id, program_id: c.program_id },
      subjectTable: 'oem_incentive_claims',
      subjectId: c.id,
    };
    if (c.status === 'ACCRUED' && c.claim_deadline) {
      const left = diffDays(input.asOf, c.claim_deadline);
      if (left <= input.deadlineWarnDays) {
        out.push({
          ...base,
          kind: 'deadline',
          dedupKey: `DL-7:${c.id}:deadline`,
          severity: 'MEDIUM',
          title:
            left >= 0
              ? `Incentive not claimed: ${what} · ${money(open)}, claim deadline ${left === 0 ? 'today' : `in ${plural(left, 'day')}`}`
              : `Incentive claim deadline passed: ${what} · ${money(open)}, ${plural(-left, 'day')} ago`,
          reason: `${money(open)} was earned on ${dateLabel(c.earned_date)} and booked as owed by the manufacturer, but the claim hasn't been submitted. The program's claim deadline is ${dateLabel(c.claim_deadline)}.`,
          question: 'Submit the incentive claim to the manufacturer before the deadline.',
          facts: { claim_deadline: c.claim_deadline, days_left: left },
        });
      }
    }
    if ((c.status === 'SUBMITTED' || c.status === 'PARTIAL') && c.submitted_date) {
      const days = diffDays(c.submitted_date, input.asOf);
      if (days > input.submittedAgingDays) {
        out.push({
          ...base,
          kind: 'aging',
          dedupKey: `DL-7:${c.id}:aging`,
          severity: 'MEDIUM',
          title: `Incentive unpaid: ${what} · ${money(open)} outstanding ${plural(days, 'day')}`,
          reason: `The claim was submitted ${dateLabel(c.submitted_date)} and ${money(open)} is still unpaid after ${plural(days, 'day')} (the follow-up point is ${plural(input.submittedAgingDays, 'day')}).`,
          question: 'Follow up with the manufacturer, or check the latest manufacturer statement for the credit.',
          facts: { submitted_date: c.submitted_date, days_outstanding: days },
        });
      }
    }
  }
  return out;
}

async function collectIncentives(c: ClientScan): Promise<DealerFinding[]> {
  const res = await fetchAll<Record<string, unknown>>(
    () =>
      c.db
        .from('oem_incentive_claims')
        .select('id, program_id, claim_reference, status, earned_date, claim_deadline, submitted_date, accrued_cents, claimed_cents, settled_cents, written_off_cents')
        .eq('org_id', c.orgId)
        .eq('location_id', c.locationId)
        .in('status', ['ACCRUED', 'SUBMITTED', 'PARTIAL']),
    { label: 'DL-7 incentive claims' },
  );
  if (res.error) readFail('Incentive lookup failed', res.error);
  const rows = res.data ?? [];
  const programIds = [...new Set(rows.map((r) => r.program_id as string))];
  const names = new Map<string, string>();
  for (let i = 0; i < programIds.length; i += 200) {
    const p = await c.db.from('oem_programs').select('id, name').eq('org_id', c.orgId).in('id', programIds.slice(i, i + 200));
    if (p.error) readFail('Programs lookup failed', p.error);
    for (const x of (p.data ?? []) as Array<{ id: string; name: string }>) names.set(x.id, x.name);
  }
  return incentiveFindings({
    asOf: c.asOf,
    deadlineWarnDays: c.settings.incentive_deadline_warn_days,
    submittedAgingDays: c.settings.incentive_submitted_aging_days,
    claims: rows.map((r) => ({
      id: r.id as string,
      program_id: r.program_id as string,
      program_name: names.get(r.program_id as string) ?? 'Manufacturer program',
      claim_reference: (r.claim_reference as string | null) ?? null,
      status: String(r.status),
      earned_date: r.earned_date as string,
      claim_deadline: (r.claim_deadline as string | null) ?? null,
      submitted_date: (r.submitted_date as string | null) ?? null,
      accrued_cents: Number(r.accrued_cents ?? 0),
      claimed_cents: Number(r.claimed_cents ?? 0),
      settled_cents: Number(r.settled_cents ?? 0),
      written_off_cents: Number(r.written_off_cents ?? 0),
    })),
  });
}

export const INCENTIVE_DETECTOR: DealerDetectorDef = {
  key: 'dealer_incentive',
  feature: DEALER_FEATURES.INCENTIVE,
  control: 'DL-7',
  label: 'Incentive aging and unclaimed incentives',
  collect: collectIncentives,
};
