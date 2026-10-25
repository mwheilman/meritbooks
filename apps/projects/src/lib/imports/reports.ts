/**
 * Reconciliation reports shown BEFORE anything is committed (the "count, deferred dollars and
 * visits owed before go-live" of FS-65, the c-Systems unit tie-out of DLR-81, the mid-stream WIP
 * roll-up of CGC-08). The same checks run again in SQL after commit against what Books holds
 * (pm.opening_tieout). Pure.
 */
import { computeWipLine } from './opening';
import type { CellValue, StagedRow } from './types';

const num = (d: Record<string, CellValue>, k: string) => (typeof d[k] === 'number' ? (d[k] as number) : null);
const str = (d: Record<string, CellValue>, k: string) => (typeof d[k] === 'string' ? (d[k] as string) : null);
const ok = (r: StagedRow) => r.validation !== 'INVALID';

export interface AgreementReconciliation {
  agreements: number;
  deferredCents: number;
  visitsOwed: number;
  byPlan: { plan: string; count: number; deferredCents: number; visitsOwed: number }[];
  noBilling: { row: number; ref: string | null; plan: string | null }[];
  noVisits: { row: number; ref: string | null; plan: string | null }[];
  expired: { row: number; ref: string | null; endsOn: string | null }[];
  endingIn90Days: number;
  sourceReportedDeferredCents: number | null;
  /** imported − reported (null when no reported figure) */
  differenceCents: number | null;
}

export function agreementReconciliation(rows: StagedRow[], today: string, sourceReportedDeferredCents: number | null = null): AgreementReconciliation {
  const live = rows.filter(ok);
  const byPlan = new Map<string, { plan: string; count: number; deferredCents: number; visitsOwed: number }>();
  const in90 = new Date(`${today}T00:00:00Z`);
  in90.setUTCDate(in90.getUTCDate() + 90);
  const horizon = in90.toISOString().slice(0, 10);
  let deferred = 0;
  let owed = 0;
  let ending = 0;
  for (const r of live) {
    const plan = str(r.data, 'tier') ?? str(r.data, 'plan_name') ?? 'Plan';
    const g = byPlan.get(plan) ?? { plan, count: 0, deferredCents: 0, visitsOwed: 0 };
    g.count += 1;
    g.deferredCents += num(r.data, 'deferred_cents') ?? 0;
    g.visitsOwed += num(r.data, 'visits_remaining') ?? 0;
    byPlan.set(plan, g);
    deferred += num(r.data, 'deferred_cents') ?? 0;
    owed += num(r.data, 'visits_remaining') ?? 0;
    const end = str(r.data, 'ends_on');
    if (end && end >= today && end <= horizon) ending += 1;
  }
  return {
    agreements: live.length, deferredCents: deferred, visitsOwed: owed,
    byPlan: [...byPlan.values()].sort((a, b) => b.count - a.count),
    noBilling: live.filter((r) => (num(r.data, 'price_cents') ?? 0) === 0).map((r) => ({ row: r.row_number, ref: r.external_ref, plan: str(r.data, 'plan_name') })),
    noVisits: live.filter((r) => (num(r.data, 'visits_per_term') ?? 0) === 0).map((r) => ({ row: r.row_number, ref: r.external_ref, plan: str(r.data, 'plan_name') })),
    expired: live.filter((r) => (str(r.data, 'ends_on') ?? '9999') < today).map((r) => ({ row: r.row_number, ref: r.external_ref, endsOn: str(r.data, 'ends_on') })),
    endingIn90Days: ending,
    sourceReportedDeferredCents,
    differenceCents: sourceReportedDeferredCents == null ? null : deferred - sourceReportedDeferredCents,
  };
}

export interface UnitSummary {
  units: number;
  costCents: number;
  flooredUnits: number;
  floorCents: number;
  byLender: { lender: string; units: number; floorCents: number; costCents: number }[];
  byCondition: Record<string, number>;
  flooredWithoutLender: string[];
  floorOverCost: string[];
}

export function unitSummary(rows: StagedRow[]): UnitSummary {
  const live = rows.filter(ok);
  const lenders = new Map<string, { lender: string; units: number; floorCents: number; costCents: number }>();
  const byCondition: Record<string, number> = {};
  for (const r of live) {
    const c = str(r.data, 'condition') ?? 'NEW';
    byCondition[c] = (byCondition[c] ?? 0) + 1;
    const floor = num(r.data, 'floor_balance_cents') ?? 0;
    if (floor > 0) {
      const l = str(r.data, 'floor_lender') ?? '(no lender)';
      const g = lenders.get(l) ?? { lender: l, units: 0, floorCents: 0, costCents: 0 };
      g.units += 1; g.floorCents += floor; g.costCents += num(r.data, 'cost_cents') ?? 0;
      lenders.set(l, g);
    }
  }
  return {
    units: live.length,
    costCents: live.reduce((a, r) => a + (num(r.data, 'cost_cents') ?? 0), 0),
    flooredUnits: live.filter((r) => (num(r.data, 'floor_balance_cents') ?? 0) > 0).length,
    floorCents: live.reduce((a, r) => a + (num(r.data, 'floor_balance_cents') ?? 0), 0),
    byLender: [...lenders.values()].sort((a, b) => b.floorCents - a.floorCents),
    byCondition,
    flooredWithoutLender: live.filter((r) => (num(r.data, 'floor_balance_cents') ?? 0) > 0 && !str(r.data, 'floor_lender')).map((r) => str(r.data, 'serial_number') ?? `row ${r.row_number}`),
    floorOverCost: live.filter((r) => (num(r.data, 'floor_balance_cents') ?? 0) > (num(r.data, 'cost_cents') ?? Number.MAX_SAFE_INTEGER)).map((r) => str(r.data, 'serial_number') ?? `row ${r.row_number}`),
  };
}

export type UnitTieStatus = 'ok' | 'missing_in_books' | 'missing_in_import' | 'cost_differs' | 'floor_differs' | 'lender_differs';

export interface BooksUnit {
  serial_number: string;
  cost_cents: number;
  floor_cents: number;
  lender: string | null;
}

const key = (s: string | null | undefined) => (s ?? '').trim().toUpperCase();
const lenderKey = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\b(llc|inc|co|corp|ltd|the|bank|financial|finance|credit)\b/g, ' ').replace(/\s+/g, ' ').trim();

/** Unit by unit (the same rules as pm.opening_tieout's DEALER_UNITS section; $1 tolerance). */
export function unitByUnit(imported: { serial_number: string | null; cost_cents: number; floor_balance_cents: number; floor_lender: string | null }[], books: BooksUnit[]) {
  const bySerial = new Map(books.map((b) => [key(b.serial_number), b]));
  const seen = new Set<string>();
  const lines: { serial: string; status: UnitTieStatus; sourceCostCents: number | null; booksCostCents: number | null; sourceFloorCents: number | null; booksFloorCents: number | null }[] = [];
  for (const u of imported) {
    const k = key(u.serial_number);
    seen.add(k);
    const b = bySerial.get(k);
    let status: UnitTieStatus = 'ok';
    if (!b) status = 'missing_in_books';
    else if (Math.abs(b.cost_cents - u.cost_cents) > 100) status = 'cost_differs';
    else if (Math.abs(b.floor_cents - u.floor_balance_cents) > 100) status = 'floor_differs';
    else if (u.floor_balance_cents > 0 && b.lender && u.floor_lender && lenderKey(b.lender) !== lenderKey(u.floor_lender)) status = 'lender_differs';
    lines.push({ serial: u.serial_number ?? '', status, sourceCostCents: u.cost_cents, booksCostCents: b?.cost_cents ?? null, sourceFloorCents: u.floor_balance_cents, booksFloorCents: b?.floor_cents ?? null });
  }
  for (const b of books) if (!seen.has(key(b.serial_number))) {
    lines.push({ serial: b.serial_number, status: 'missing_in_import', sourceCostCents: null, booksCostCents: b.cost_cents, sourceFloorCents: null, booksFloorCents: b.floor_cents });
  }
  const counts = lines.reduce<Record<string, number>>((a, l) => { a[l.status] = (a[l.status] ?? 0) + 1; return a; }, {});
  return { lines, counts, tied: lines.length > 0 && lines.every((l) => l.status === 'ok') };
}

export interface WipPreview {
  jobs: number;
  contractCents: number;
  costToDateCents: number;
  billedCents: number;
  earnedCents: number;
  underBillingCents: number;
  overBillingCents: number;
  retainageReceivableCents: number;
  retainagePayableCents: number;
  jobsWithoutEac: number;
}

export function wipPreview(rows: StagedRow[]): WipPreview {
  const out: WipPreview = { jobs: 0, contractCents: 0, costToDateCents: 0, billedCents: 0, earnedCents: 0, underBillingCents: 0, overBillingCents: 0, retainageReceivableCents: 0, retainagePayableCents: 0, jobsWithoutEac: 0 };
  for (const r of rows.filter(ok)) {
    const d = r.data;
    const w = computeWipLine({ contract: num(d, 'contract_cents') ?? 0, eac: num(d, 'estimated_cost_cents') ?? 0, costToDate: num(d, 'cost_to_date_cents') ?? 0, billed: num(d, 'billed_to_date_cents') ?? 0, pctOverride: num(d, 'pct_complete') });
    out.jobs += 1;
    out.contractCents += w.contractValueCents;
    out.costToDateCents += w.costsToDateCents;
    out.billedCents += w.billedToDateCents;
    out.earnedCents += w.earnedRevenueCents;
    out.underBillingCents += w.underBillingCents;
    out.overBillingCents += w.overBillingCents;
    out.retainageReceivableCents += num(d, 'retainage_receivable_cents') ?? 0;
    out.retainagePayableCents += num(d, 'retainage_payable_cents') ?? 0;
    if (!num(d, 'estimated_cost_cents')) out.jobsWithoutEac += 1;
  }
  return out;
}

export function openArPreview(rows: StagedRow[]) {
  const live = rows.filter(ok);
  const by = new Map<string, number>();
  for (const r of live) {
    const k = str(r.data, 'customer_name') ?? str(r.data, 'customer_ref') ?? '?';
    by.set(k, (by.get(k) ?? 0) + (num(r.data, 'balance_cents') ?? 0));
  }
  return {
    invoices: live.length,
    customers: by.size,
    openCents: [...by.values()].reduce((a, b) => a + b, 0),
    top: [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, cents]) => ({ name, cents })),
  };
}

/** The entity-specific report the preview card shows (null when the entity has none). */
export function previewReport(entity: string, rows: StagedRow[], today: string) {
  switch (entity) {
    case 'agreement': return { kind: 'agreements' as const, ...agreementReconciliation(rows, today) };
    case 'unit':
    case 'rental_unit': return { kind: 'units' as const, ...unitSummary(rows) };
    case 'job': return { kind: 'wip' as const, ...wipPreview(rows) };
    case 'open_ar': return { kind: 'open_ar' as const, ...openArPreview(rows) };
    default: return null;
  }
}
