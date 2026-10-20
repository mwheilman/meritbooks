/**
 * Loaders for R1 Floor-plan position and R2 Floor-plan interest (RLS reads only).
 */

import { addDays } from '@/lib/dealer/dates';
import { loadSotFindings } from '@/lib/dealer/service/insights';
import type { DeptRole } from '@/lib/dealer/types';
import type { DealerReport } from './catalog';
import { buildFloorPlanInterest, buildFloorPlanPosition, type InterestNoteIn, type InterestUnitIn } from './build-floor-plan';
import { all, allIn, ids, num, str, vendorNames, type ReportCtx } from './load-shared';

export async function loadFloorPlanPosition(d: ReportCtx, asOf: string, entityLabel: string): Promise<DealerReport> {
  const [posRows, noteRows, curtRows, sot] = await Promise.all([
    all('Floor-plan positions', () => d.db.from('v_floor_plan_position').select('line_id, line_name, lender_vendor_id, line_status, credit_limit_cents, accrued_interest_cents').eq('org_id', d.orgId).eq('location_id', d.locationId), 'line_id'),
    all('Floor-plan notes', () => d.db.from('floor_plan_notes').select('id, line_id, program_id, principal_balance_cents, maturity_date').eq('org_id', d.orgId).eq('location_id', d.locationId).in('status', ['OPEN', 'SOLD_UNPAID', 'IN_DEFAULT'])),
    all('Curtailments', () => d.db.from('floor_plan_curtailments').select('id, note_id, amount_cents').eq('org_id', d.orgId).eq('location_id', d.locationId).in('status', ['DUE', 'MISSED']).lte('due_date', addDays(asOf, 30))),
    loadSotFindings(d, asOf),
  ]);
  const programIds = ids(noteRows, 'program_id');
  const programs = await allIn('Programs', programIds, (chunk) => d.db.from('floor_plan_programs').select('id, name').eq('org_id', d.orgId).in('id', chunk));
  const lenderNames = await vendorNames(d, ids(posRows, 'lender_vendor_id'));
  return buildFloorPlanPosition({
    asOf,
    entityLabel,
    lines: posRows.map((r) => ({
      lineId: r.line_id as string,
      lineName: String(r.line_name ?? 'Floor-plan line'),
      lenderVendorId: r.lender_vendor_id as string,
      lineStatus: String(r.line_status ?? 'ACTIVE'),
      creditLimitCents: num(r.credit_limit_cents),
      accruedInterestCents: num(r.accrued_interest_cents),
    })),
    notes: noteRows.map((n) => ({
      id: n.id as string,
      line_id: n.line_id as string,
      program_id: str(n.program_id),
      principal_balance_cents: num(n.principal_balance_cents),
      maturity_date: str(n.maturity_date),
    })),
    programNames: new Map(programs.map((p) => [p.id as string, String(p.name ?? 'Program')])),
    lenderNames,
    curtailments: curtRows.map((c) => ({ note_id: c.note_id as string, amount_cents: num(c.amount_cents) })),
    sot: sot.map((s) => ({ noteId: s.noteId, principalCents: s.principalCents })),
  });
}

export async function loadFloorPlanInterest(d: ReportCtx, start: string, end: string, entityLabel: string): Promise<DealerReport> {
  const [accrualRows, billingRows, saleRows] = await Promise.all([
    all('Interest accruals', () => d.db.from('floor_plan_transactions').select('id, note_id, txn_date, interest_cents').eq('org_id', d.orgId).eq('location_id', d.locationId).eq('status', 'POSTED').eq('txn_type', 'INTEREST_ACCRUAL').gte('txn_date', start).lte('txn_date', end)),
    all('Interest bills', () => d.db.from('floor_plan_transactions').select('id, line_id, txn_date, interest_cents, accrual_cleared_cents').eq('org_id', d.orgId).eq('location_id', d.locationId).eq('status', 'POSTED').eq('txn_type', 'INTEREST_BILLED').gte('txn_date', start).lte('txn_date', end)),
    all('Unit sales', () => d.db.from('dealer_unit_sales').select('id, unit_id, sale_date').eq('org_id', d.orgId).eq('location_id', d.locationId).eq('status', 'POSTED').gte('sale_date', start).lte('sale_date', end)),
  ]);
  const soldUnitIds = ids(saleRows, 'unit_id');
  const soldNoteRows = await allIn('Sold-unit notes', soldUnitIds, (chunk) => d.db.from('floor_plan_notes').select('id, unit_id, line_id, floored_date, free_floor_end_date').eq('org_id', d.orgId).in('unit_id', chunk).neq('status', 'VOID'));
  const noteIds = [...new Set([...ids(accrualRows, 'note_id'), ...ids(soldNoteRows, 'id')])];
  const noteRows = await allIn('Notes', noteIds, (chunk) => d.db.from('floor_plan_notes').select('id, unit_id, line_id, floored_date, free_floor_end_date').eq('org_id', d.orgId).in('id', chunk));
  const unitRows = await allIn('Units', [...ids(noteRows, 'unit_id'), ...soldUnitIds], (chunk) => d.db.from('dealer_units').select('id, serial_number, department_role, make_vendor_id').eq('org_id', d.orgId).in('id', chunk));
  const soldNoteIds = ids(soldNoteRows, 'id');
  const lifetime = await allIn('Lifetime interest', soldNoteIds, (chunk) => d.db.from('floor_plan_transactions').select('id, note_id, interest_cents').eq('org_id', d.orgId).eq('status', 'POSTED').eq('txn_type', 'INTEREST_ACCRUAL').in('note_id', chunk));
  const lifeByNote = new Map<string, number>();
  for (const t of lifetime) lifeByNote.set(t.note_id as string, (lifeByNote.get(t.note_id as string) ?? 0) + num(t.interest_cents));
  const notesByUnit = new Map<string, string[]>();
  for (const n of soldNoteRows) notesByUnit.set(n.unit_id as string, [...(notesByUnit.get(n.unit_id as string) ?? []), n.id as string]);

  const units = new Map<string, InterestUnitIn>(
    unitRows.map((u) => [u.id as string, { id: u.id as string, serial_number: String(u.serial_number ?? ''), department_role: (u.department_role as DeptRole) ?? 'WG_NEW', make_vendor_id: str(u.make_vendor_id) }]),
  );
  const makeNames = await vendorNames(d, [...units.values()].map((u) => u.make_vendor_id).filter((x): x is string => !!x));
  return buildFloorPlanInterest({
    start,
    end,
    entityLabel,
    accruals: accrualRows.map((a) => ({ note_id: str(a.note_id), txn_date: String(a.txn_date), interest_cents: num(a.interest_cents) })),
    billings: billingRows.map((b) => ({ line_id: b.line_id as string, txn_date: String(b.txn_date), interest_cents: num(b.interest_cents), accrual_cleared_cents: num(b.accrual_cleared_cents) })),
    notes: new Map<string, InterestNoteIn>(
      noteRows.map((n) => [n.id as string, { id: n.id as string, unit_id: str(n.unit_id), line_id: n.line_id as string, floored_date: String(n.floored_date), free_floor_end_date: str(n.free_floor_end_date) }]),
    ),
    units,
    makeNames,
    sold: saleRows.map((s) => {
      const noteIdsForUnit = notesByUnit.get(s.unit_id as string) ?? [];
      return {
        saleId: s.id as string,
        unitId: s.unit_id as string,
        saleDate: String(s.sale_date),
        noteIds: noteIdsForUnit,
        lifetimeInterestCents: noteIdsForUnit.reduce((sum, id) => sum + (lifeByNote.get(id) ?? 0), 0),
      };
    }),
  });
}
