/**
 * R5 Warranty receivable aging and recovery, R6 Incentive receivable aging — pure.
 */

import { bucketsFromEdges, RECEIVABLE_EDGES } from '@/lib/dealer/engine/summary';
import { diffDays } from '@/lib/dealer/dates';
import { INCENTIVE_STATUS, PROGRAM_TYPE, WARRANTY_STATUS } from '@/lib/dealer/ui/labels';
import { dealerLinks } from '@/lib/dealer/ui/links';
import type { IncentiveStatus, ProgramType, WarrantyStatus } from '@/lib/dealer/types';
import type { DealerReport, DealerReportColumn, DealerReportRow } from './catalog';
import { makeReport } from './build-floor-plan';
import { isoLabel, ratioBps, row, spacer } from './model';

const RECV_BUCKETS = bucketsFromEdges(RECEIVABLE_EDGES);
const bucketCols = (): DealerReportColumn[] =>
  RECV_BUCKETS.map((b, i) => ({ key: `b${i}`, label: b.maxDays == null ? `${b.minDays}+ days` : `${b.minDays}–${b.maxDays} days`, kind: 'money' as const }));

function bucketIndex(days: number): number {
  const i = RECV_BUCKETS.findIndex((b) => days >= b.minDays && (b.maxDays == null || days <= b.maxDays));
  return i < 0 ? RECV_BUCKETS.length - 1 : i;
}

type Acc = Record<string, number | null>;
function add(acc: Acc, v: Acc) {
  for (const [k, x] of Object.entries(v)) if (typeof x === 'number') acc[k] = (acc[k] ?? 0) + x;
}

// ── R5 ────────────────────────────────────────────────────────────────────────

export interface WarrantyClaimRow {
  id: string;
  oem_vendor_id: string;
  oem_claim_number: string | null;
  dealer_claim_ref: string | null;
  serial_number: string | null;
  status: WarrantyStatus;
  claimed_cents: number;
  settled_cents: number;
  written_off_cents: number;
  submitted_date: string | null;
}

export interface WarrantyAgingInput {
  asOf: string;
  entityLabel: string;
  /** Every non-VOID claim (open ones age; closed ones feed recovery / rejection). */
  claims: WarrantyClaimRow[];
  rejectedClaimIds: ReadonlySet<string>;
  oemNames: Map<string, string>;
}

const WARRANTY_OPEN: readonly WarrantyStatus[] = ['DRAFT', 'SUBMITTED', 'PARTIAL', 'RESUBMITTED', 'REJECTED'];
const WARRANTY_RESOLVED: readonly WarrantyStatus[] = ['PAID', 'WRITTEN_OFF', 'DEBITED', 'REJECTED'];

export function warrantyAgingColumns(): DealerReportColumn[] {
  return [
    { key: 'claims', label: 'Claims', kind: 'count' },
    { key: 'open', label: 'Open', kind: 'money' },
    ...bucketCols(),
    { key: 'unsubmitted', label: 'Not yet submitted', kind: 'money' },
    { key: 'recovery', label: 'Recovery', kind: 'percent' },
    { key: 'rejection', label: 'Rejection rate', kind: 'percent' },
  ];
}

export function warrantyOpen(c: Pick<WarrantyClaimRow, 'claimed_cents' | 'settled_cents' | 'written_off_cents'>): number {
  return Math.max(0, c.claimed_cents - c.settled_cents - c.written_off_cents);
}

/** Recovery = settled ÷ claimed on resolved claims; rejection = rejected ÷ submitted. */
export function warrantyRates(claims: WarrantyClaimRow[], rejected: ReadonlySet<string>): { recovery: number | null; rejection: number | null } {
  const resolved = claims.filter((c) => WARRANTY_RESOLVED.includes(c.status));
  const submitted = claims.filter((c) => c.status !== 'DRAFT' && c.status !== 'VOID');
  const rej = submitted.filter((c) => c.status === 'REJECTED' || rejected.has(c.id)).length;
  return {
    recovery: ratioBps(resolved.reduce((s, c) => s + c.settled_cents, 0), resolved.reduce((s, c) => s + c.claimed_cents, 0)),
    rejection: ratioBps(rej, submitted.length),
  };
}

export function buildWarrantyAging(input: WarrantyAgingInput): DealerReport {
  const cols = warrantyAgingColumns();
  const claims = input.claims.filter((c) => c.status !== 'VOID');
  const openClaims = claims.filter((c) => WARRANTY_OPEN.includes(c.status) && warrantyOpen(c) > 0);
  const valuesOf = (c: WarrantyClaimRow): Acc => {
    const open = warrantyOpen(c);
    const v: Acc = { claims: 1, open };
    if (c.status === 'DRAFT' || !c.submitted_date) v.unsubmitted = open;
    else v[`b${bucketIndex(Math.max(0, diffDays(c.submitted_date, input.asOf)))}`] = open;
    return v;
  };
  const oemLabel = (id: string) => input.oemNames.get(id) ?? 'Manufacturer';
  const rows: DealerReportRow[] = [];
  const grand: Acc = {};
  const oems = [...new Set(claims.map((c) => c.oem_vendor_id))].sort((a, b) => oemLabel(a).localeCompare(oemLabel(b)));
  if (openClaims.length) rows.push(row('section', 'By manufacturer', cols, {}));
  for (const oem of oems) {
    const mine = openClaims.filter((c) => c.oem_vendor_id === oem);
    if (mine.length === 0) continue;
    rows.push(row('section', oemLabel(oem), cols, {}, { indent: 1 }));
    const sub: Acc = {};
    for (const c of mine.sort((a, b) => (a.submitted_date ?? '9999').localeCompare(b.submitted_date ?? '9999'))) {
      const ref = c.oem_claim_number ?? c.dealer_claim_ref ?? (c.serial_number ? `serial ${c.serial_number}` : 'unnumbered');
      const v = valuesOf(c);
      rows.push(row('account', `Claim ${ref} · ${WARRANTY_STATUS[c.status]?.label ?? c.status}`, cols, v, { indent: 2, href: dealerLinks.warranty({ claim: c.id }) }));
      add(sub, v);
    }
    const rates = warrantyRates(claims.filter((c) => c.oem_vendor_id === oem), input.rejectedClaimIds);
    rows.push(row('subtotal', `${oemLabel(oem)} total`, cols, { ...sub, recovery: rates.recovery, rejection: rates.rejection }, { indent: 1 }));
    add(grand, sub);
  }
  if (openClaims.length) {
    rows.push(spacer(cols));
    rows.push(row('section', 'By status', cols, {}));
    for (const st of WARRANTY_OPEN) {
      const mine = openClaims.filter((c) => c.status === st);
      if (mine.length === 0) continue;
      const acc: Acc = {};
      for (const c of mine) add(acc, valuesOf(c));
      rows.push(row('account', WARRANTY_STATUS[st]?.label ?? st, cols, acc, { indent: 1, href: dealerLinks.warranty({ status: st }) }));
    }
    const rates = warrantyRates(claims, input.rejectedClaimIds);
    rows.push(spacer(cols));
    rows.push(row('total', 'Total warranty receivable', cols, { ...grand, recovery: rates.recovery, rejection: rates.rejection }, { href: dealerLinks.warranty() }));
  }
  const notes = [
    'Open = claimed less settled and written off. Days outstanding run from the submitted date to the as-of date; drafts are shown as not yet submitted.',
    'Recovery = amount settled ÷ amount claimed on resolved claims (paid, written off, debited or rejected). Rejection rate = claims rejected (now or at any time) ÷ claims submitted.',
    'Effective warranty labor rate is not shown: manufacturer settlements are recorded as one amount per claim, not split between labor and parts, so the labor actually paid per hour can’t be measured honestly.',
  ];
  return makeReport('dealer_warranty_aging', input.entityLabel, { asOf: input.asOf }, cols, rows, notes);
}

// ── R6 ────────────────────────────────────────────────────────────────────────

export interface IncentiveClaimRow {
  id: string;
  program_id: string;
  status: IncentiveStatus;
  claim_reference: string | null;
  earned_date: string;
  submitted_date: string | null;
  claim_deadline: string | null;
  accrued_cents: number;
  claimed_cents: number;
  settled_cents: number;
  written_off_cents: number;
}

export interface IncentiveAgingInput {
  asOf: string;
  entityLabel: string;
  claims: IncentiveClaimRow[];
  programs: Map<string, { name: string; oem_vendor_id: string; program_type: ProgramType }>;
  oemNames: Map<string, string>;
}

const INCENTIVE_OPEN: readonly IncentiveStatus[] = ['ACCRUED', 'SUBMITTED', 'PARTIAL', 'REJECTED'];

export function incentiveAgingColumns(): DealerReportColumn[] {
  return [
    { key: 'claims', label: 'Claims', kind: 'count' },
    { key: 'accrued', label: 'Accrued', kind: 'money' },
    { key: 'claimed', label: 'Claimed', kind: 'money' },
    { key: 'settled', label: 'Settled', kind: 'money' },
    { key: 'open', label: 'Open', kind: 'money' },
    ...bucketCols(),
    { key: 'deadline', label: 'Next claim deadline', kind: 'date' },
  ];
}

export function incentiveOpen(c: Pick<IncentiveClaimRow, 'accrued_cents' | 'claimed_cents' | 'settled_cents' | 'written_off_cents'>): number {
  return Math.max(0, Math.max(c.claimed_cents, c.accrued_cents) - c.settled_cents - c.written_off_cents);
}

export function buildIncentiveAging(input: IncentiveAgingInput): DealerReport {
  const cols = incentiveAgingColumns();
  const open = input.claims.filter((c) => INCENTIVE_OPEN.includes(c.status) && c.earned_date <= input.asOf && incentiveOpen(c) > 0);
  const valuesOf = (c: IncentiveClaimRow): Acc => {
    const v: Acc = { claims: 1, accrued: c.accrued_cents, claimed: c.claimed_cents, settled: c.settled_cents, open: incentiveOpen(c) };
    v[`b${bucketIndex(Math.max(0, diffDays(c.submitted_date ?? c.earned_date, input.asOf)))}`] = incentiveOpen(c);
    return v;
  };
  const nextDeadline = (list: IncentiveClaimRow[]) =>
    list.filter((c) => c.status === 'ACCRUED' && c.claim_deadline).map((c) => c.claim_deadline as string).sort()[0] ?? null;
  const prog = (id: string) => input.programs.get(id);
  const oemOf = (c: IncentiveClaimRow) => prog(c.program_id)?.oem_vendor_id ?? '';
  const oemLabel = (id: string) => input.oemNames.get(id) ?? 'Manufacturer';

  const rows: DealerReportRow[] = [];
  const grand: Acc = {};
  const oems = [...new Set(open.map(oemOf))].sort((a, b) => oemLabel(a).localeCompare(oemLabel(b)));
  for (const oem of oems) {
    rows.push(row('section', oemLabel(oem), cols, {}));
    const oemSub: Acc = {};
    const mine = open.filter((c) => oemOf(c) === oem);
    const programIds = [...new Set(mine.map((c) => c.program_id))].sort((a, b) => (prog(a)?.name ?? '').localeCompare(prog(b)?.name ?? ''));
    for (const pid of programIds) {
      const p = prog(pid);
      const list = mine.filter((c) => c.program_id === pid);
      rows.push(row('section', `${p?.name ?? 'Program'}${p ? ` · ${PROGRAM_TYPE[p.program_type] ?? ''}` : ''}`, cols, {}, { indent: 1 }));
      const sub: Acc = {};
      for (const c of list.sort((a, b) => a.earned_date.localeCompare(b.earned_date))) {
        const v = valuesOf(c);
        rows.push(
          row('account', `${c.claim_reference ? `Claim ${c.claim_reference}` : `Earned ${isoLabel(c.earned_date)}`} · ${INCENTIVE_STATUS[c.status]?.label ?? c.status}`, cols, { ...v, deadline: c.status === 'ACCRUED' ? c.claim_deadline : null }, {
            indent: 2,
            href: dealerLinks.incentives({ claim: c.id }),
            ...(c.status === 'ACCRUED' && c.claim_deadline && c.claim_deadline < input.asOf ? { tone: 'danger' as const } : {}),
          }),
        );
        add(sub, v);
      }
      rows.push(row('subtotal', `${p?.name ?? 'Program'} total`, cols, { ...sub, deadline: nextDeadline(list) }, { indent: 1 }));
      add(oemSub, sub);
    }
    rows.push(row('subtotal', `${oemLabel(oem)} total`, cols, { ...oemSub, deadline: nextDeadline(mine) }));
    add(grand, oemSub);
  }
  if (rows.length) {
    rows.push(spacer(cols));
    rows.push(row('total', 'Total incentives receivable', cols, { ...grand, deadline: nextDeadline(open) }, { href: dealerLinks.incentives() }));
  }
  const notes = [
    'Open claims only (accrued, submitted, partly paid or rejected with money still owed). Open = the larger of accrued and claimed, less settled and written off.',
    'Days outstanding run from the submitted date (or the earned date, if not yet submitted) to the as-of date. Next claim deadline is the earliest deadline on a claim not yet submitted; past deadlines are highlighted.',
  ];
  return makeReport('dealer_incentive_aging', input.entityLabel, { asOf: input.asOf }, cols, rows, notes);
}
