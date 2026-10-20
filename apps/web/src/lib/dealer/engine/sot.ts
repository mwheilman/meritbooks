/**
 * Sold-out-of-trust detection (FPB §0.1, V3, DL-1) — pure.
 *
 * The lesson from the first client: the lender knew which floored units were sold
 * before the books did (it dated SOT from manufacturer warranty registrations). So a
 * unit counts as SOLD from the EARLIEST of four signals:
 *   BOOKS_SALE    a posted dealer_unit_sales row (note is SOLD_UNPAID)
 *   DMS_DEAL      a DMS deal import row for the unit not yet posted in Books
 *   WARRANTY_REG  the manufacturer's retail warranty-registration date on the unit
 *   LENDER_AUDIT  the lender's floor check coded the unit sold-and-unpaid
 * and a finding is raised for every LIVE note (OPEN / SOLD_UNPAID / IN_DEFAULT) on a
 * sold unit. Paying the note off (PAID_OFF) clears it.
 *
 * Severity:
 *   CRITICAL  past payoff due + grace days (Books sale), or ANY sale signal Books has
 *             not recorded (the books are wrong and the lender's clock is running)
 *   HIGH      Books sale recorded, payoff not yet due + grace (the payoff is pending)
 */

import { addDays, dayNumber, diffDays, minDate } from '../dates';
import type { NoteStatus, SoldDetectedBy } from '../types';

export interface SotNote {
  id: string;
  unit_id: string | null;
  line_id: string;
  status: NoteStatus;
  principal_balance_cents: number;
  sold_date: string | null;
  payoff_due_date: string | null;
}

export interface SotUnit {
  id: string;
  serial_number: string;
  status: string;
  warranty_registered_date: string | null;
}

export interface SotSignal {
  unitId: string;
  source: Exclude<SoldDetectedBy, 'BOOKS_SALE'>;
  date: string;
  ref?: string | null;
}

export type SotSeverity = 'CRITICAL' | 'HIGH';

export interface SotEvidence {
  source: SoldDetectedBy;
  date: string;
  ref: string | null;
}

export interface SotFinding {
  noteId: string;
  unitId: string;
  lineId: string;
  serialNumber: string;
  severity: SotSeverity;
  /** BOOKS_SALE when the sale is in Books; otherwise the earliest outside signal. */
  detectedBy: SoldDetectedBy;
  /** True when no Books sale exists yet — the sale must be recorded. */
  saleMissingInBooks: boolean;
  earliestSaleDate: string;
  daysSinceSale: number;
  payoffDueDate: string;
  daysPastDue: number;
  principalCents: number;
  evidence: SotEvidence[];
  /** Stable subject key for de-duplicated exceptions (DL-1). */
  dedupKey: string;
}

export interface SotInput {
  asOf: string;
  graceDays: number;
  notes: SotNote[];
  units: SotUnit[];
  signals: SotSignal[];
}

const LIVE: readonly NoteStatus[] = ['OPEN', 'SOLD_UNPAID', 'IN_DEFAULT'];

export function detectSoldOutOfTrust(input: SotInput): SotFinding[] {
  const unitById = new Map(input.units.map((u) => [u.id, u]));
  const signalsByUnit = new Map<string, SotSignal[]>();
  for (const s of input.signals) {
    const list = signalsByUnit.get(s.unitId) ?? [];
    list.push(s);
    signalsByUnit.set(s.unitId, list);
  }

  const findings: SotFinding[] = [];
  for (const note of input.notes) {
    if (!note.unit_id || !LIVE.includes(note.status) || note.principal_balance_cents <= 0) continue;
    const unit = unitById.get(note.unit_id);
    if (!unit) continue;

    const evidence: SotEvidence[] = [];
    const booksSale = note.status === 'SOLD_UNPAID' && note.sold_date ? note.sold_date : null;
    if (booksSale) evidence.push({ source: 'BOOKS_SALE', date: booksSale, ref: null });
    if (unit.warranty_registered_date) {
      evidence.push({ source: 'WARRANTY_REG', date: unit.warranty_registered_date, ref: null });
    }
    for (const s of signalsByUnit.get(unit.id) ?? []) evidence.push({ source: s.source, date: s.date, ref: s.ref ?? null });
    if (evidence.length === 0) continue;

    // Signals dated in the future (bad import data) are ignored, never trusted.
    const asOfN = dayNumber(input.asOf);
    const valid = evidence.filter((e) => dayNumber(e.date) <= asOfN);
    if (valid.length === 0) continue;
    valid.sort((a, b) => dayNumber(a.date) - dayNumber(b.date));
    const earliest = valid.reduce((d, e) => minDate(d, e.date), valid[0].date);

    const saleMissing = booksSale == null;
    const payoffDue = booksSale ? (note.payoff_due_date ?? booksSale) : earliest;
    const pastGraceDay = addDays(payoffDue, input.graceDays);
    const pastGrace = dayNumber(input.asOf) > dayNumber(pastGraceDay);
    const severity: SotSeverity = saleMissing || pastGrace ? 'CRITICAL' : 'HIGH';

    findings.push({
      noteId: note.id,
      unitId: unit.id,
      lineId: note.line_id,
      serialNumber: unit.serial_number,
      severity,
      detectedBy: saleMissing ? valid[0].source : 'BOOKS_SALE',
      saleMissingInBooks: saleMissing,
      earliestSaleDate: earliest,
      daysSinceSale: diffDays(earliest, input.asOf),
      payoffDueDate: payoffDue,
      daysPastDue: Math.max(0, diffDays(payoffDue, input.asOf)),
      principalCents: note.principal_balance_cents,
      evidence: valid,
      dedupKey: `DL-1:${note.id}`,
    });
  }
  return findings.sort(
    (a, b) => (a.severity === b.severity ? b.daysSinceSale - a.daysSinceSale : a.severity === 'CRITICAL' ? -1 : 1),
  );
}
