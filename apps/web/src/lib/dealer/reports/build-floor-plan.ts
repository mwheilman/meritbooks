/**
 * R1 Floor-plan position and R2 Floor-plan interest (carrying cost) — pure builders.
 */

import { dealerLinks } from '@/lib/dealer/ui/links';
import { DEPT_ROLE } from '@/lib/dealer/ui/labels';
import { diffDays } from '@/lib/dealer/dates';
import type { DeptRole } from '@/lib/dealer/types';
import { dealerReportDef, type DealerReport, type DealerReportColumn, type DealerReportKey, type DealerReportRow } from './catalog';
import { monthLabel, periodLabelFor, ratioBps, row, spacer } from './model';

export function makeReport(
  key: DealerReportKey,
  entityLabel: string,
  window: DealerReport['window'],
  columns: DealerReportColumn[],
  rows: DealerReportRow[],
  notes: string[] = [],
  kpis: DealerReport['kpis'] = [],
  generatedAt = new Date().toISOString(),
): DealerReport {
  return { key, title: dealerReportDef(key).label, entityLabel, periodLabel: periodLabelFor(window), window, columns, rows, notes, kpis, generatedAt };
}

// ── R1 ────────────────────────────────────────────────────────────────────────

export interface PositionLineIn {
  lineId: string;
  lineName: string;
  lenderVendorId: string;
  lineStatus: string;
  creditLimitCents: number;
  accruedInterestCents: number;
}

export interface PositionNoteIn {
  id: string;
  line_id: string;
  program_id: string | null;
  principal_balance_cents: number;
  maturity_date: string | null;
}

export interface PositionInput {
  asOf: string;
  entityLabel: string;
  lines: PositionLineIn[];
  /** LIVE notes (OPEN / SOLD_UNPAID / IN_DEFAULT). */
  notes: PositionNoteIn[];
  programNames: Map<string, string>;
  lenderNames: Map<string, string>;
  /** DUE / MISSED curtailments due on or before as-of + 30 days. */
  curtailments: Array<{ note_id: string; amount_cents: number }>;
  /** Sold-out-of-trust findings (D1 engine) as of the date. */
  sot: Array<{ noteId: string; principalCents: number }>;
}

export const POSITION_COLUMNS: DealerReportColumn[] = [
  { key: 'principal', label: 'Principal', kind: 'money' },
  { key: 'accrued', label: 'Accrued interest', kind: 'money' },
  { key: 'curt30', label: 'Curtailments due 30 days', kind: 'money' },
  { key: 'sotCount', label: 'Sold not paid off', kind: 'count' },
  { key: 'sotCents', label: 'Sold not paid off $', kind: 'money' },
  { key: 'limit', label: 'Credit limit', kind: 'money' },
  { key: 'util', label: 'Utilization', kind: 'percent' },
  { key: 'maturity', label: 'Days to next maturity', kind: 'days' },
];

interface Agg {
  principal: number;
  curt30: number;
  sotCount: number;
  sotCents: number;
  maturity: number | null;
  notes: number;
}

const emptyAgg = (): Agg => ({ principal: 0, curt30: 0, sotCount: 0, sotCents: 0, maturity: null, notes: 0 });
const minNull = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : Math.min(a, b));

export function buildFloorPlanPosition(input: PositionInput): DealerReport {
  const cols = POSITION_COLUMNS;
  const curtByNote = new Map<string, number>();
  for (const c of input.curtailments) curtByNote.set(c.note_id, (curtByNote.get(c.note_id) ?? 0) + c.amount_cents);
  const sotByNote = new Map(input.sot.map((s) => [s.noteId, s.principalCents]));

  // line → program → aggregate
  const byLine = new Map<string, Map<string, Agg>>();
  for (const n of input.notes) {
    const progKey = n.program_id ?? '';
    const progs = byLine.get(n.line_id) ?? new Map<string, Agg>();
    const a = progs.get(progKey) ?? emptyAgg();
    a.principal += n.principal_balance_cents;
    a.curt30 += curtByNote.get(n.id) ?? 0;
    if (sotByNote.has(n.id)) {
      a.sotCount += 1;
      a.sotCents += sotByNote.get(n.id) ?? 0;
    }
    a.maturity = minNull(a.maturity, n.maturity_date ? diffDays(input.asOf, n.maturity_date) : null);
    a.notes += 1;
    progs.set(progKey, a);
    byLine.set(n.line_id, progs);
  }

  const lenders = new Map<string, PositionLineIn[]>();
  for (const l of input.lines) lenders.set(l.lenderVendorId, [...(lenders.get(l.lenderVendorId) ?? []), l]);

  const rows: DealerReportRow[] = [];
  const grand = { ...emptyAgg(), accrued: 0, limit: 0 };
  const sortedLenders = [...lenders.entries()].sort((a, b) =>
    (input.lenderNames.get(a[0]) ?? '').localeCompare(input.lenderNames.get(b[0]) ?? ''),
  );
  for (const [lenderId, lines] of sortedLenders) {
    const lenderName = input.lenderNames.get(lenderId) ?? 'Lender';
    rows.push(row('section', lenderName, cols, {}));
    const lenderTot = { ...emptyAgg(), accrued: 0, limit: 0 };
    for (const l of [...lines].sort((a, b) => a.lineName.localeCompare(b.lineName))) {
      const progs = byLine.get(l.lineId) ?? new Map<string, Agg>();
      const status = l.lineStatus === 'ACTIVE' ? '' : l.lineStatus === 'CREDIT_HOLD' ? ' (credit hold)' : l.lineStatus === 'SUSPENDED' ? ' (suspended)' : l.lineStatus === 'CLOSED' ? ' (closed)' : '';
      rows.push(row('section', `${l.lineName}${status}`, cols, {}, { indent: 1, href: dealerLinks.floorPlan('positions', { lineId: l.lineId }) }));
      const lineTot = emptyAgg();
      const progEntries = [...progs.entries()].sort((a, b) =>
        (a[0] ? input.programNames.get(a[0]) ?? '' : '~').localeCompare(b[0] ? input.programNames.get(b[0]) ?? '' : '~'),
      );
      for (const [pid, a] of progEntries) {
        rows.push(
          row('account', pid ? input.programNames.get(pid) ?? 'Program' : 'No program', cols, {
            principal: a.principal,
            curt30: a.curt30,
            sotCount: a.sotCount,
            sotCents: a.sotCents,
            maturity: a.maturity,
          }, { indent: 2, href: dealerLinks.floorPlan('notes', { lineId: l.lineId, ...(pid ? { programId: pid } : {}) }) }),
        );
        lineTot.principal += a.principal;
        lineTot.curt30 += a.curt30;
        lineTot.sotCount += a.sotCount;
        lineTot.sotCents += a.sotCents;
        lineTot.maturity = minNull(lineTot.maturity, a.maturity);
      }
      rows.push(
        row('subtotal', `${l.lineName} total`, cols, {
          principal: lineTot.principal,
          accrued: l.accruedInterestCents,
          curt30: lineTot.curt30,
          sotCount: lineTot.sotCount,
          sotCents: lineTot.sotCents,
          limit: l.creditLimitCents,
          util: l.creditLimitCents > 0 ? ratioBps(lineTot.principal, l.creditLimitCents) : null,
          maturity: lineTot.maturity,
        }, { indent: 1, href: dealerLinks.floorPlan('positions', { lineId: l.lineId }) }),
      );
      lenderTot.principal += lineTot.principal;
      lenderTot.accrued += l.accruedInterestCents;
      lenderTot.curt30 += lineTot.curt30;
      lenderTot.sotCount += lineTot.sotCount;
      lenderTot.sotCents += lineTot.sotCents;
      lenderTot.limit += l.creditLimitCents;
      lenderTot.maturity = minNull(lenderTot.maturity, lineTot.maturity);
    }
    if (lines.length > 1) {
      rows.push(
        row('subtotal', `${lenderName} total`, cols, {
          principal: lenderTot.principal,
          accrued: lenderTot.accrued,
          curt30: lenderTot.curt30,
          sotCount: lenderTot.sotCount,
          sotCents: lenderTot.sotCents,
          limit: lenderTot.limit,
          util: lenderTot.limit > 0 ? ratioBps(lenderTot.principal, lenderTot.limit) : null,
          maturity: lenderTot.maturity,
        }),
      );
    }
    grand.principal += lenderTot.principal;
    grand.accrued += lenderTot.accrued;
    grand.curt30 += lenderTot.curt30;
    grand.sotCount += lenderTot.sotCount;
    grand.sotCents += lenderTot.sotCents;
    grand.limit += lenderTot.limit;
    grand.maturity = minNull(grand.maturity, lenderTot.maturity);
  }
  if (rows.length) {
    rows.push(spacer(cols));
    rows.push(
      row('total', 'Total floor plan', cols, {
        principal: grand.principal,
        accrued: grand.accrued,
        curt30: grand.curt30,
        sotCount: grand.sotCount,
        sotCents: grand.sotCents,
        limit: grand.limit,
        util: grand.limit > 0 ? ratioBps(grand.principal, grand.limit) : null,
        maturity: grand.maturity,
      }, { href: dealerLinks.floorPlan('sot') }),
    );
  }
  const notes = [
    'Principal is the current balance of every open, sold-not-paid-off and defaulted note. Accrued interest is the posted accrual not yet cleared by a lender interest bill (tracked per line).',
    'Sold not paid off counts every note on a unit that is sold by any signal — a Books sale, a dealer-system deal, a manufacturer warranty registration or a lender floor check.',
    'Curtailments include any that are already missed. Balances are as of today; the as-of date sets the sold-not-paid-off, curtailment and maturity windows.',
  ];
  return makeReport('dealer_fp_position', input.entityLabel, { asOf: input.asOf }, cols, rows, notes);
}

// ── R2 ────────────────────────────────────────────────────────────────────────

export interface InterestNoteIn {
  id: string;
  unit_id: string | null;
  line_id: string;
  floored_date: string;
  free_floor_end_date: string | null;
}

export interface InterestUnitIn {
  id: string;
  serial_number: string;
  department_role: DeptRole;
  make_vendor_id: string | null;
}

export interface InterestInput {
  start: string;
  end: string;
  entityLabel: string;
  /** POSTED INTEREST_ACCRUAL rows dated in the period (per note). */
  accruals: Array<{ note_id: string | null; txn_date: string; interest_cents: number }>;
  /** POSTED INTEREST_BILLED rows dated in the period (line level). */
  billings: Array<{ line_id: string; txn_date: string; interest_cents: number; accrual_cleared_cents: number }>;
  notes: Map<string, InterestNoteIn>;
  units: Map<string, InterestUnitIn>;
  makeNames: Map<string, string>;
  /** Posted sales dated in the period with every note on the unit and its lifetime posted accrual. */
  sold: Array<{ saleId: string; unitId: string; saleDate: string; lifetimeInterestCents: number; noteIds: string[] }>;
}

export const INTEREST_COLUMNS: DealerReportColumn[] = [
  { key: 'accrued', label: 'Interest accrued', kind: 'money' },
  { key: 'trueUp', label: 'Lender true-ups', kind: 'money' },
  { key: 'total', label: 'Total interest', kind: 'money' },
  { key: 'units', label: 'Notes', kind: 'count' },
  { key: 'freeDays', label: 'Free-floor days used', kind: 'days' },
];

export function freeFloorDaysUsed(n: Pick<InterestNoteIn, 'floored_date' | 'free_floor_end_date'>, through: string): number {
  if (!n.free_floor_end_date) return 0;
  const end = through < n.free_floor_end_date ? through : n.free_floor_end_date;
  return Math.max(0, diffDays(n.floored_date, end));
}

export function buildFloorPlanInterest(input: InterestInput): DealerReport {
  const cols = INTEREST_COLUMNS;
  const rows: DealerReportRow[] = [];
  const totalAccrued = input.accruals.reduce((s, a) => s + a.interest_cents, 0);
  const totalTrueUp = input.billings.reduce((s, b) => s + (b.interest_cents - b.accrual_cleared_cents), 0);
  const total = totalAccrued + totalTrueUp;

  // By month
  const months = new Map<string, { accrued: number; trueUp: number; notes: Set<string> }>();
  const m = (ym: string) => {
    const x = months.get(ym) ?? { accrued: 0, trueUp: 0, notes: new Set<string>() };
    months.set(ym, x);
    return x;
  };
  for (const a of input.accruals) {
    const x = m(a.txn_date.slice(0, 7));
    x.accrued += a.interest_cents;
    if (a.note_id) x.notes.add(a.note_id);
  }
  for (const b of input.billings) m(b.txn_date.slice(0, 7)).trueUp += b.interest_cents - b.accrual_cleared_cents;
  rows.push(row('section', 'By month', cols, {}));
  for (const [ym, x] of [...months.entries()].sort()) {
    rows.push(row('account', monthLabel(ym), cols, { accrued: x.accrued, trueUp: x.trueUp, total: x.accrued + x.trueUp, units: x.notes.size }, { indent: 1 }));
  }
  rows.push(row('subtotal', 'Total by month', cols, { accrued: totalAccrued, trueUp: totalTrueUp, total }));

  // Per-note accruals feed the department / manufacturer / unit views.
  const byNote = new Map<string, number>();
  let unattributed = 0;
  for (const a of input.accruals) {
    if (a.note_id) byNote.set(a.note_id, (byNote.get(a.note_id) ?? 0) + a.interest_cents);
    else unattributed += a.interest_cents;
  }
  const groupBy = (keyOf: (u: InterestUnitIn | null) => string) => {
    const g = new Map<string, { accrued: number; notes: number }>();
    for (const [noteId, cents] of byNote) {
      const note = input.notes.get(noteId);
      const unit = note?.unit_id ? input.units.get(note.unit_id) ?? null : null;
      const k = keyOf(unit);
      const x = g.get(k) ?? { accrued: 0, notes: 0 };
      x.accrued += cents;
      x.notes += 1;
      g.set(k, x);
    }
    return g;
  };
  const trueUpRows = () => {
    if (totalTrueUp !== 0) rows.push(row('account', 'Lender true-ups (billed vs accrued, not by unit)', cols, { trueUp: totalTrueUp, total: totalTrueUp }, { indent: 1 }));
    if (unattributed !== 0) rows.push(row('account', 'Accruals not tied to a note', cols, { accrued: unattributed, total: unattributed }, { indent: 1 }));
  };

  rows.push(spacer(cols));
  rows.push(row('section', 'By department', cols, {}));
  const NO_UNIT = '~none';
  const depts = groupBy((u) => (u ? u.department_role : NO_UNIT));
  for (const [k, x] of [...depts.entries()].sort()) {
    const label = k === NO_UNIT ? 'Not tied to a unit (parts and other collateral)' : DEPT_ROLE[k as DeptRole]?.label ?? 'Department';
    rows.push(row('account', label, cols, { accrued: x.accrued, total: x.accrued, units: x.notes }, { indent: 1 }));
  }
  trueUpRows();
  rows.push(row('subtotal', 'Total by department', cols, { accrued: totalAccrued, trueUp: totalTrueUp, total }));

  rows.push(spacer(cols));
  rows.push(row('section', 'By manufacturer', cols, {}));
  const makes = groupBy((u) => (u ? u.make_vendor_id ?? NO_UNIT + 'make' : NO_UNIT));
  const makeLabel = (k: string) => (k === NO_UNIT ? 'Not tied to a unit' : k === NO_UNIT + 'make' ? 'Manufacturer not recorded' : input.makeNames.get(k) ?? 'Manufacturer');
  for (const [k, x] of [...makes.entries()].sort((a, b) => makeLabel(a[0]).localeCompare(makeLabel(b[0])))) {
    rows.push(row('account', makeLabel(k), cols, { accrued: x.accrued, total: x.accrued, units: x.notes }, { indent: 1 }));
  }
  trueUpRows();
  rows.push(row('subtotal', 'Total by manufacturer', cols, { accrued: totalAccrued, trueUp: totalTrueUp, total }));

  rows.push(spacer(cols));
  rows.push(row('section', 'By unit', cols, {}));
  const unitRows = [...byNote.entries()]
    .map(([noteId, cents]) => {
      const note = input.notes.get(noteId);
      const unit = note?.unit_id ? input.units.get(note.unit_id) : undefined;
      return { noteId, cents, note, unit };
    })
    .sort((a, b) => b.cents - a.cents);
  for (const r of unitRows) {
    rows.push(
      row('account', r.unit ? `Serial ${r.unit.serial_number}` : 'Open-account note', cols, {
        accrued: r.cents,
        total: r.cents,
        freeDays: r.note ? freeFloorDaysUsed(r.note, input.end) : null,
      }, { indent: 1, href: r.unit ? dealerLinks.unit(r.unit.id) : dealerLinks.note(r.noteId) }),
    );
  }
  trueUpRows();
  rows.push(row('subtotal', 'Total by unit', cols, { accrued: totalAccrued, trueUp: totalTrueUp, total }));

  if (input.sold.length) {
    rows.push(spacer(cols));
    rows.push(row('section', 'Units sold in the period (lifetime floor-plan interest)', cols, {}));
    let soldTotal = 0;
    for (const s of [...input.sold].sort((a, b) => a.saleDate.localeCompare(b.saleDate))) {
      const unit = input.units.get(s.unitId);
      const note = s.noteIds.map((id) => input.notes.get(id)).find((x) => !!x);
      soldTotal += s.lifetimeInterestCents;
      rows.push(
        row('note', unit ? `Serial ${unit.serial_number}` : 'Unit', cols, {
          total: s.lifetimeInterestCents,
          freeDays: note ? freeFloorDaysUsed(note, s.saleDate) : null,
        }, { indent: 1, href: dealerLinks.deal(s.saleId) }),
      );
    }
    rows.push(row('note', 'Interest on units sold', cols, { total: soldTotal }, { indent: 1 }));
  }

  rows.push(spacer(cols));
  rows.push(row('total', 'Total floor-plan interest', cols, { accrued: totalAccrued, trueUp: totalTrueUp, total }));

  const soldLifetime = input.sold.reduce((s, x) => s + x.lifetimeInterestCents, 0);
  const kpis = input.sold.length
    ? [{ label: 'Interest per unit sold', value: centsLabel(Math.round(soldLifetime / input.sold.length)), hint: `${input.sold.length} unit${input.sold.length === 1 ? '' : 's'} sold in the period, lifetime floor-plan interest on each` }]
    : [];
  const notes = [
    'Interest accrued is the posted monthly accrual per note. Lender true-ups are the difference between what the lender billed and the accrual that bill cleared; they are tracked per line, not per unit.',
    'Free-floor days used counts the interest-free days from flooring to the end of the free period (or the period end / sale date, if sooner).',
  ];
  return makeReport('dealer_fp_interest', input.entityLabel, { start: input.start, end: input.end }, cols, rows, notes, kpis);
}

/** "$1,234.56" without importing a client formatter into this pure module twice. */
export function centsLabel(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  return `${neg ? '-' : ''}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}
