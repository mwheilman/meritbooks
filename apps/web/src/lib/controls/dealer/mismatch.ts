/**
 * DL-3 — Floor plan ↔ inventory ↔ GL mismatch (FPB §6, AC 12). HIGH, tolerance 0.
 *
 *   a. A carried unit that was floored (it has a flooring cost row, or the lender is
 *      its source) but has NO floor-plan note at all (a paid-off note means the dealer
 *      owns it outright — that is fine).          key DL-3:unit-no-note:<unit>
 *   b. A LIVE note on a unit that is no longer inventory (returned to the
 *      manufacturer, written off, voided). A live note on a SOLD / DELIVERED unit is
 *      sold-out-of-trust and is left to DL-1.         key DL-3:note-off-inventory:<note>
 *   c. Every v_dealer_subledger_tieout bucket with a difference ≠ 0 or no account
 *      mapped (D1's `evaluateTieout` rule).          key DL-3:tieout:<bucket>:<account>:<YYYY-MM>
 */

import { evaluateTieout, type TieoutRow } from '@/lib/dealer/engine/summary';
import { loadTieout } from '@/lib/dealer/service/settings';
import { CARRIED_UNIT_STATUSES, LIVE_NOTE_STATUSES, type NoteStatus, type UnitStatus } from '@/lib/dealer/types';
import { UNIT_STATUS } from '@/lib/dealer/ui/labels';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { fetchAll } from '@/lib/supabase/fetch-all';
import { DEALER_FEATURES, money, monthKey, readFail, type ClientScan, type DealerDetectorDef, type DealerFinding } from './shared';

export const TIEOUT_BUCKET_LABEL: Record<string, string> = {
  FLOOR_PLAN_PAYABLE: 'Floor plan payable',
  FLOOR_PLAN_INTEREST_ACCRUED: 'Accrued floor-plan interest',
  UNIT_INVENTORY: 'Unit inventory',
  WARRANTY_RECEIVABLE: 'Warranty claims receivable',
  OEM_INCENTIVE_RECEIVABLE: 'Manufacturer incentives receivable',
  TRADE_LIEN_PAYOFF: 'Trade-in lien payoffs owed',
};

const OFF_INVENTORY: readonly UnitStatus[] = ['RETURNED', 'WRITTEN_OFF', 'VOID'];

export interface MismatchUnit {
  id: string;
  serial_number: string;
  status: UnitStatus;
  source: string;
  cost_cents: number;
}

export interface MismatchNote {
  id: string;
  unit_id: string | null;
  status: NoteStatus;
  principal_balance_cents: number;
  lender_invoice_number: string;
}

export function floorMismatchFindings(input: {
  asOf: string;
  units: MismatchUnit[];
  /** Every non-VOID note of the client (live and paid off / returned). */
  notes: MismatchNote[];
  /** Units with a non-void flooring cost row (source_type FLOOR_PLAN_NOTE). */
  flooredCostUnitIds: ReadonlySet<string>;
  tieout: TieoutRow[];
}): DealerFinding[] {
  const out: DealerFinding[] = [];
  const unitById = new Map(input.units.map((u) => [u.id, u]));
  const notesByUnit = new Map<string, MismatchNote[]>();
  for (const n of input.notes) {
    if (!n.unit_id || n.status === 'VOID') continue;
    notesByUnit.set(n.unit_id, [...(notesByUnit.get(n.unit_id) ?? []), n]);
  }

  for (const u of input.units) {
    if (!CARRIED_UNIT_STATUSES.includes(u.status)) continue;
    const flooredExpected = u.source === 'LENDER' || input.flooredCostUnitIds.has(u.id);
    if (!flooredExpected || (notesByUnit.get(u.id)?.length ?? 0) > 0) continue;
    out.push({
      control: 'DL-3',
      kind: 'unit_without_note',
      dedupKey: `DL-3:unit-no-note:${u.id}`,
      severity: 'HIGH',
      amountAtRiskCents: Math.abs(u.cost_cents),
      title: `Floored unit has no floor-plan note: serial ${u.serial_number} · ${money(u.cost_cents)} in inventory`,
      reason: `Serial ${u.serial_number} came in through the floor plan, but no floor-plan note exists for it. The floor-plan payable and the unit inventory will not tie until the note is recorded (or the flooring is corrected).`,
      question: 'Record the floor-plan note for this unit from the lender’s flooring notice, or correct how the unit was received.',
      href: dealerLinks.unit(u.id),
      subjects: { unit_id: u.id },
      subjectTable: 'dealer_units',
      subjectId: u.id,
      facts: { serial_number: u.serial_number, unit_status: u.status },
    });
  }

  for (const n of input.notes) {
    if (!n.unit_id || !LIVE_NOTE_STATUSES.includes(n.status)) continue;
    const u = unitById.get(n.unit_id);
    if (!u || !OFF_INVENTORY.includes(u.status)) continue;
    const statusLabel = UNIT_STATUS[u.status]?.label.toLowerCase() ?? 'no longer in inventory';
    out.push({
      control: 'DL-3',
      kind: 'note_off_inventory',
      dedupKey: `DL-3:note-off-inventory:${n.id}`,
      severity: 'HIGH',
      amountAtRiskCents: n.principal_balance_cents,
      title: `Open floor-plan note on a unit not in inventory: serial ${u.serial_number} (${statusLabel}) · ${money(n.principal_balance_cents)}`,
      reason: `The floor-plan note (lender invoice ${n.lender_invoice_number}) still shows ${money(n.principal_balance_cents)} owed, but serial ${u.serial_number} is ${statusLabel}. Either the lender credit was not recorded or the unit status is wrong.`,
      question: 'Record the lender credit or payoff for this note, or correct the unit’s status.',
      href: dealerLinks.note(n.id),
      subjects: { note_id: n.id, unit_id: u.id },
      subjectTable: 'floor_plan_notes',
      subjectId: n.id,
      facts: { serial_number: u.serial_number, unit_status: u.status, lender_invoice_number: n.lender_invoice_number },
    });
  }

  const month = monthKey(input.asOf);
  if (!evaluateTieout(input.tieout).ok) {
    for (const r of input.tieout) {
      const unmapped = !r.account_id;
      const diff = Number(r.difference_cents);
      if (!unmapped && diff === 0) continue;
      const label = TIEOUT_BUCKET_LABEL[r.bucket] ?? 'Dealer subledger';
      out.push({
        control: 'DL-3',
        kind: unmapped ? 'tieout_unmapped' : 'tieout_difference',
        dedupKey: `DL-3:tieout:${r.bucket}:${r.account_id ?? 'unmapped'}:${month}`,
        severity: 'HIGH',
        amountAtRiskCents: unmapped ? Math.abs(Number(r.subledger_cents)) : Math.abs(diff),
        title: unmapped
          ? `Dealer subledger has no GL account: ${label} · ${money(r.subledger_cents)}`
          : `Dealer subledger doesn't tie to the GL: ${label} · difference ${money(diff)}`,
        reason: unmapped
          ? `${label} carries ${money(r.subledger_cents)} in the dealer subledger, but no GL account is mapped for it, so it can't be tied out.`
          : `${label}: the dealer subledger shows ${money(r.subledger_cents)} but the general ledger shows ${money(r.gl_cents)} — a ${money(diff)} difference. The month-end close item "Dealer subledgers tie to GL" stays open until this is zero.`,
        question: unmapped
          ? 'Map the account for this balance in the dealer settings.'
          : 'Find the entry that hit the account outside the dealer pack (or the dealer event that did not post) and correct it.',
        href: dealerLinks.home(),
        subjects: { bucket: r.bucket, account_id: r.account_id },
        subjectTable: 'v_dealer_subledger_tieout',
        subjectId: r.account_id,
        facts: { bucket: r.bucket, subledger_cents: Number(r.subledger_cents), gl_cents: Number(r.gl_cents), difference_cents: diff },
      });
    }
  }
  return out;
}

async function collect(c: ClientScan): Promise<DealerFinding[]> {
  const unitsRes = await fetchAll<Record<string, unknown>>(
    () =>
      c.db
        .from('dealer_units')
        .select('id, serial_number, status, source, cost_cents')
        .eq('org_id', c.orgId)
        .eq('location_id', c.locationId)
        .in('status', [...CARRIED_UNIT_STATUSES, ...OFF_INVENTORY]),
    { label: 'DL-3 units' },
  );
  if (unitsRes.error) readFail('Units lookup failed', unitsRes.error);
  const notesRes = await fetchAll<Record<string, unknown>>(
    () =>
      c.db
        .from('floor_plan_notes')
        .select('id, unit_id, status, principal_balance_cents, lender_invoice_number')
        .eq('org_id', c.orgId)
        .eq('location_id', c.locationId)
        .in('status', ['OPEN', 'SOLD_UNPAID', 'IN_DEFAULT', 'PAID_OFF', 'RETURNED']),
    { label: 'DL-3 notes' },
  );
  if (notesRes.error) readFail('Notes lookup failed', notesRes.error);
  const costRes = await fetchAll<Record<string, unknown>>(
    () =>
      c.db
        .from('dealer_unit_costs')
        .select('id, unit_id')
        .eq('org_id', c.orgId)
        .eq('location_id', c.locationId)
        .eq('source_type', 'FLOOR_PLAN_NOTE')
        .in('status', ['PROPOSED', 'POSTED']),
    { label: 'DL-3 flooring costs' },
  );
  if (costRes.error) readFail('Unit cost lookup failed', costRes.error);
  const tieout = await loadTieout({ db: c.db, orgId: c.orgId, locationId: c.locationId });
  return floorMismatchFindings({
    asOf: c.asOf,
    units: (unitsRes.data ?? []).map((u) => ({
      id: u.id as string,
      serial_number: String(u.serial_number ?? ''),
      status: u.status as UnitStatus,
      source: String(u.source ?? ''),
      cost_cents: Number(u.cost_cents ?? 0),
    })),
    notes: (notesRes.data ?? []).map((n) => ({
      id: n.id as string,
      unit_id: (n.unit_id as string | null) ?? null,
      status: n.status as NoteStatus,
      principal_balance_cents: Number(n.principal_balance_cents ?? 0),
      lender_invoice_number: String(n.lender_invoice_number ?? ''),
    })),
    flooredCostUnitIds: new Set((costRes.data ?? []).map((r) => r.unit_id as string)),
    tieout,
  });
}

export const FLOOR_MISMATCH_DETECTOR: DealerDetectorDef = {
  key: 'dealer_floor_mismatch',
  feature: DEALER_FEATURES.FLOOR_MISMATCH,
  control: 'DL-3',
  label: 'Floor plan, inventory and GL mismatch',
  collect,
};
