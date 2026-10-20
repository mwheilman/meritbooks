/**
 * Unit register + cost build-up + status moves (FPB §3.6, §3.7, V4).
 */

import { initialUnitRoles } from '../roles';
import {
  costAdditionPlan,
  rentalMovePlan,
  returnToOemPlan,
  setupCostPlan,
  writeDownPlan,
  assertCostSign,
  type CostOffset,
} from '../engine/unit-cost';
import { applyPrincipalPayment } from '../engine/notes';
import { CARRIED_UNIT_STATUSES, LIVE_NOTE_STATUSES, type CostSourceType, type CostType, type UnitCondition, type UnitSource } from '../types';
import { normalizeRef } from '../engine/statement-match';
import type { DealerCtx } from './context';
import { DealerError, dbFail } from './errors';
import { loadRoleMap, postPlan } from './posting';
import { byKey, getRow, insertRow, updateRow, type CostRow, type NoteRow, type UnitRow, type LineRow } from './rows';
import { loadSettings, requireEnabled } from './settings';
import { audit } from './audit';

export interface NewUnitInput {
  serialNumber: string;
  vinHin?: string | null;
  stockNumber?: string | null;
  makeVendorId?: string | null;
  model?: string | null;
  modelYear?: number | null;
  itemId?: string | null;
  description?: string | null;
  condition: UnitCondition;
  isConsignment?: boolean;
  consignorVendorId?: string | null;
  status?: 'ON_ORDER' | 'IN_TRANSIT' | 'IN_STOCK';
  receivedDate?: string | null;
  listPriceCents?: number | null;
  warrantyRegisteredDate?: string | null;
  source: UnitSource;
  externalRef?: string | null;
  importBatchId?: string | null;
  notes?: string | null;
}

export async function insertUnit(d: DealerCtx, u: NewUnitInput): Promise<UnitRow> {
  const roles = initialUnitRoles(u.condition);
  return insertRow<UnitRow>(
    d,
    'dealer_units',
    {
      serial_number: u.serialNumber.trim(),
      vin_hin: u.vinHin ?? null,
      stock_number: u.stockNumber ?? null,
      make_vendor_id: u.makeVendorId ?? null,
      model: u.model ?? null,
      model_year: u.modelYear ?? null,
      item_id: u.itemId ?? null,
      description: u.description ?? null,
      condition: u.condition,
      is_consignment: u.isConsignment ?? false,
      consignor_vendor_id: u.consignorVendorId ?? null,
      status: u.status ?? 'IN_STOCK',
      inventory_role: roles.inventoryRole,
      department_role: roles.departmentRole,
      received_date: u.receivedDate ?? null,
      list_price_cents: u.listPriceCents ?? null,
      warranty_registered_date: u.warrantyRegisteredDate ?? null,
      source: u.source,
      external_ref: u.externalRef ?? null,
      import_batch_id: u.importBatchId ?? null,
      notes: u.notes ?? null,
      created_by: d.userId,
    },
    `Unit ${u.serialNumber}`,
  );
}

/** Find a live (non-void) unit by make + serial (normalized). */
export async function findUnitBySerial(d: DealerCtx, serial: string, makeVendorId: string | null): Promise<UnitRow | null> {
  let q = d.admin
    .from('dealer_units')
    .select('*')
    .eq('org_id', d.orgId)
    .eq('location_id', d.locationId)
    .neq('status', 'VOID')
    .ilike('serial_number', serial.trim());
  q = makeVendorId ? q.eq('make_vendor_id', makeVendorId) : q.is('make_vendor_id', null);
  const { data, error } = await q.limit(5);
  if (error) dbFail('Unit lookup failed', error);
  const hit = ((data ?? []) as UnitRow[]).find((u) => normalizeRef(u.serial_number) === normalizeRef(serial));
  return hit ? { ...hit, cost_cents: Number(hit.cost_cents) } : null;
}

export type UnitPatch = Partial<
  Pick<NewUnitInput, 'vinHin' | 'stockNumber' | 'model' | 'modelYear' | 'itemId' | 'description' | 'receivedDate' | 'listPriceCents' | 'notes'>
> & { serialNumber?: string; makeVendorId?: string | null };

export async function updateUnit(d: DealerCtx, unitId: string, p: UnitPatch): Promise<UnitRow> {
  const unit = await getRow<UnitRow>(d, 'dealer_units', unitId, 'Unit');
  if ((p.serialNumber !== undefined || p.makeVendorId !== undefined) && Number(unit.cost_cents) !== 0) {
    throw new DealerError('CONFLICT', 'Serial / make cannot change once costs are posted to the unit');
  }
  const values: Record<string, unknown> = {};
  if (p.serialNumber !== undefined) values.serial_number = p.serialNumber.trim();
  if (p.makeVendorId !== undefined) values.make_vendor_id = p.makeVendorId;
  if (p.vinHin !== undefined) values.vin_hin = p.vinHin;
  if (p.stockNumber !== undefined) values.stock_number = p.stockNumber;
  if (p.model !== undefined) values.model = p.model;
  if (p.modelYear !== undefined) values.model_year = p.modelYear;
  if (p.itemId !== undefined) values.item_id = p.itemId;
  if (p.description !== undefined) values.description = p.description;
  if (p.receivedDate !== undefined) values.received_date = p.receivedDate;
  if (p.listPriceCents !== undefined) values.list_price_cents = p.listPriceCents;
  if (p.notes !== undefined) values.notes = p.notes;
  const row = await updateRow<UnitRow>(d, 'dealer_units', unitId, values, 'Unit');
  return row ?? unit;
}

export interface UnitDetail {
  unit: UnitRow;
  costs: CostRow[];
  notes: NoteRow[];
  sale: Record<string, unknown> | null;
}

export async function getUnitDetail(d: DealerCtx, unitId: string): Promise<UnitDetail> {
  const [u, c, n, s] = await Promise.all([
    d.db.from('dealer_units').select('*').eq('org_id', d.orgId).eq('location_id', d.locationId).eq('id', unitId).maybeSingle(),
    d.db.from('dealer_unit_costs').select('*').eq('org_id', d.orgId).eq('unit_id', unitId).order('created_at'),
    d.db.from('floor_plan_notes').select('*').eq('org_id', d.orgId).eq('unit_id', unitId).order('floored_date'),
    d.db.from('dealer_unit_sales').select('*').eq('org_id', d.orgId).eq('unit_id', unitId).neq('status', 'VOID').maybeSingle(),
  ]);
  for (const r of [u, c, n, s]) if (r.error) dbFail('Unit detail lookup failed', r.error);
  if (!u.data) throw new DealerError('NOT_FOUND', 'Unit not found for this client');
  return {
    unit: { ...(u.data as UnitRow), cost_cents: Number((u.data as UnitRow).cost_cents) },
    costs: ((c.data ?? []) as CostRow[]).map((x) => ({ ...x, amount_cents: Number(x.amount_cents) })),
    notes: ((n.data ?? []) as NoteRow[]).map((x) => ({ ...x, principal_balance_cents: Number(x.principal_balance_cents), original_principal_cents: Number(x.original_principal_cents) })),
    sale: (s.data as Record<string, unknown> | null) ?? null,
  };
}

export interface AddCostInput {
  unitId: string;
  costType: Exclude<CostType, 'REBATE_REDUCTION' | 'WRITE_DOWN' | 'BASE_INVOICE'> | 'BASE_INVOICE';
  sourceType: Extract<CostSourceType, 'BILL_LINE' | 'INTERNAL_RO' | 'JE'>;
  /** BILL_LINE: the bill_lines.id already posted to the unit's inventory account. */
  billLineId?: string | null;
  /** INTERNAL_RO: actual labor + parts from the DMS internal repair order. */
  laborCents?: number;
  partsCents?: number;
  /** JE: the offset of a direct cost addition. */
  offset?: CostOffset;
  amountCents?: number;
  sourceRef?: string | null;
  costDate: string;
  memo?: string | null;
  post: boolean;
}

/** Add a cost row to a unit; posts its JE now (post) or leaves it PROPOSED. */
export async function addUnitCost(d: DealerCtx, input: AddCostInput): Promise<{ cost: CostRow; warnings: string[] }> {
  const unit = await getRow<UnitRow>(d, 'dealer_units', input.unitId, 'Unit');
  if (!CARRIED_UNIT_STATUSES.includes(unit.status)) throw new DealerError('CONFLICT', `Costs cannot be added to a ${unit.status} unit`);
  if (unit.is_consignment) throw new DealerError('CONFLICT', 'Consignment units carry no cost on the balance sheet');
  const warnings: string[] = [];

  if (input.sourceType === 'BILL_LINE') {
    // The AP bill already posted DR <account> / CR AP. Link it — no second JE — and
    // only when the bill line hit this unit's inventory account (else the unit would
    // carry cost the GL doesn't).
    if (!input.billLineId) throw new DealerError('VALIDATION', 'billLineId is required for a bill-line cost');
    const { data: bl, error } = await d.admin
      .from('bill_lines')
      .select('id, bill_id, account_id, amount_cents')
      .eq('org_id', d.orgId)
      .eq('id', input.billLineId)
      .maybeSingle();
    if (error) dbFail('Bill line lookup failed', error);
    if (!bl) throw new DealerError('NOT_FOUND', 'Bill line not found');
    const { data: bill, error: bErr } = await d.admin
      .from('bills')
      .select('id, location_id, gl_entry_id, status')
      .eq('org_id', d.orgId)
      .eq('id', (bl as { bill_id: string }).bill_id)
      .maybeSingle();
    if (bErr) dbFail('Bill lookup failed', bErr);
    const b = bill as { id: string; location_id: string; gl_entry_id: string | null } | null;
    if (!b || b.location_id !== d.locationId) throw new DealerError('VALIDATION', 'The bill belongs to another client');
    if (!b.gl_entry_id) throw new DealerError('CONFLICT', 'Post the bill before assigning its line to a unit');
    const roleMap = await loadRoleMap(d);
    const invAccount = roleMap.get(unit.inventory_role)?.account_id ?? null;
    const lineAccount = (bl as { account_id: string }).account_id;
    if (!invAccount || invAccount !== lineAccount) {
      throw new DealerError('VALIDATION', "Code the bill line to the unit's inventory account before assigning it to the unit");
    }
    const key = `cost:bill:${input.billLineId}`;
    const existing = await byKey<CostRow>(d, 'dealer_unit_costs', key);
    if (existing) return { cost: existing, warnings };
    const amount = Number((bl as { amount_cents: number }).amount_cents);
    assertCostSign(input.costType, amount);
    const cost = await insertRow<CostRow>(d, 'dealer_unit_costs', {
      unit_id: unit.id, cost_type: input.costType, amount_cents: amount, source_type: 'BILL_LINE',
      source_id: input.billLineId, source_ref: b.id, status: 'POSTED', gl_entry_id: b.gl_entry_id,
      idempotency_key: key, proposed_by: d.userId, posted_by: d.userId, posted_at: new Date().toISOString(), memo: input.memo ?? null,
    }, 'Unit cost');
    return { cost, warnings };
  }

  const key = `cost:${input.sourceType.toLowerCase()}:${unit.id}:${input.sourceRef ?? `${input.costType}:${input.costDate}:${input.amountCents ?? (input.laborCents ?? 0) + (input.partsCents ?? 0)}`}`;
  const existing = await byKey<CostRow>(d, 'dealer_unit_costs', key);
  if (existing) return { cost: existing, warnings };

  let amount: number;
  let labor = 0;
  let parts = 0;
  if (input.sourceType === 'INTERNAL_RO') {
    const settings = await loadSettings(d);
    const roleMap = await loadRoleMap(d);
    const capitalize = settings.capitalize_setup_labor && !!roleMap.get('SETUP_LABOR_CAPITALIZED')?.account_id;
    const r = setupCostPlan({
      inventoryRole: unit.inventory_role, laborCents: input.laborCents ?? 0, partsCents: input.partsCents ?? 0,
      capitalizeLabor: capitalize, memo: 'setup',
    });
    warnings.push(...r.warnings);
    if (r.capitalizedCents === 0) throw new DealerError('VALIDATION', 'Nothing to capitalize on this repair order');
    amount = r.capitalizedCents;
    labor = capitalize ? (input.laborCents ?? 0) : 0;
    parts = input.partsCents ?? 0;
  } else {
    if (!input.offset) throw new DealerError('VALIDATION', 'offset is required for a direct cost addition');
    amount = input.amountCents ?? 0;
  }
  assertCostSign(input.costType, amount);
  let cost = await insertRow<CostRow>(d, 'dealer_unit_costs', {
    unit_id: unit.id, cost_type: input.costType, amount_cents: amount, labor_cents: labor, parts_cents: parts,
    source_type: input.sourceType, source_ref: input.sourceRef ?? null, offset_role: input.offset ?? null,
    status: 'PROPOSED', idempotency_key: key, proposed_by: d.userId, memo: input.memo ?? null,
  }, 'Unit cost');
  if (input.post) cost = await postUnitCost(d, cost.id, input.costDate);
  return { cost, warnings };
}

/** Post a PROPOSED cost row (INTERNAL_RO or JE). */
export async function postUnitCost(d: DealerCtx, costId: string, entryDate: string): Promise<CostRow> {
  await requireEnabled(d);
  const cost = await getRow<CostRow>(d, 'dealer_unit_costs', costId, 'Unit cost');
  if (cost.status === 'POSTED') return cost;
  if (cost.status !== 'PROPOSED') throw new DealerError('CONFLICT', `A ${cost.status} cost row cannot be posted`);
  const unit = await getRow<UnitRow>(d, 'dealer_units', cost.unit_id, 'Unit');
  const memo = `Unit ${unit.serial_number}: ${cost.cost_type}${cost.memo ? ` — ${cost.memo}` : ''}`;
  let plan;
  if (cost.source_type === 'INTERNAL_RO') {
    const r = setupCostPlan({ inventoryRole: unit.inventory_role, laborCents: Number(cost.labor_cents), partsCents: Number(cost.parts_cents), capitalizeLabor: Number(cost.labor_cents) > 0, memo });
    plan = r.plan;
  } else if (cost.source_type === 'JE' && cost.offset_role) {
    plan = costAdditionPlan({ inventoryRole: unit.inventory_role, amountCents: cost.amount_cents, offset: cost.offset_role as CostOffset, deptRole: unit.department_role, memo });
  } else {
    throw new DealerError('CONFLICT', 'This cost row cannot be posted from the unit register');
  }
  if (!plan) throw new DealerError('VALIDATION', 'Nothing to post');
  const posted = await postPlan(d, plan, { entryDate, key: `cost:${cost.id}`, sourceId: unit.id });
  const row = await updateRow<CostRow>(
    d, 'dealer_unit_costs', cost.id,
    { status: 'POSTED', gl_entry_id: posted.glEntryId, posted_by: d.userId, posted_at: new Date().toISOString() },
    'Unit cost', { status: 'PROPOSED' },
  );
  return row ?? (await getRow<CostRow>(d, 'dealer_unit_costs', cost.id, 'Unit cost'));
}

export async function voidUnitCost(d: DealerCtx, costId: string): Promise<CostRow> {
  const cost = await getRow<CostRow>(d, 'dealer_unit_costs', costId, 'Unit cost');
  if (cost.status !== 'PROPOSED') throw new DealerError('CONFLICT', 'Only a proposed cost row can be voided — post an offsetting row instead');
  return (await updateRow<CostRow>(d, 'dealer_unit_costs', costId, { status: 'VOID' }, 'Unit cost', { status: 'PROPOSED' })) ?? cost;
}

export type UnitAction =
  | { action: 'MARK_DEMO' }
  | { action: 'UNMARK_DEMO' }
  | { action: 'MOVE_TO_RENTAL'; date: string }
  | { action: 'WRITE_DOWN'; date: string; amountCents: number; reason: string }
  | { action: 'RETURN_TO_OEM'; date: string; lenderCreditCents: number; reason: string }
  | { action: 'RECORD_WARRANTY_REGISTRATION'; date: string }
  | { action: 'MARK_DELIVERED' }
  | { action: 'VOID'; reason: string };

/** Actions that change GL or remove a unit from the books need controller approval. */
export function unitActionNeedsApproval(a: UnitAction['action']): boolean {
  return a === 'MOVE_TO_RENTAL' || a === 'WRITE_DOWN' || a === 'RETURN_TO_OEM' || a === 'VOID';
}

async function liveNoteFor(d: DealerCtx, unitId: string): Promise<NoteRow | null> {
  const { data, error } = await d.admin
    .from('floor_plan_notes')
    .select('*')
    .eq('org_id', d.orgId)
    .eq('unit_id', unitId)
    .in('status', LIVE_NOTE_STATUSES as unknown as string[])
    .maybeSingle();
  if (error) dbFail('Note lookup failed', error);
  return data ? ({ ...(data as NoteRow), principal_balance_cents: Number((data as NoteRow).principal_balance_cents) }) : null;
}

export async function applyUnitAction(d: DealerCtx, unitId: string, a: UnitAction): Promise<UnitRow> {
  const unit = await getRow<UnitRow>(d, 'dealer_units', unitId, 'Unit');
  const carried = CARRIED_UNIT_STATUSES.includes(unit.status);
  const cost = Number(unit.cost_cents);
  switch (a.action) {
    case 'MARK_DEMO':
    case 'UNMARK_DEMO': {
      if (!carried || unit.condition === 'USED' || unit.condition === 'RENTAL') throw new DealerError('CONFLICT', 'Only a new unit in stock can be a demo');
      return (await updateRow<UnitRow>(d, 'dealer_units', unitId, { condition: a.action === 'MARK_DEMO' ? 'DEMO' : 'NEW' }, 'Unit')) ?? unit;
    }
    case 'RECORD_WARRANTY_REGISTRATION':
      return (await updateRow<UnitRow>(d, 'dealer_units', unitId, { warranty_registered_date: a.date }, 'Unit')) ?? unit;
    case 'MARK_DELIVERED':
      if (unit.status !== 'SOLD') throw new DealerError('CONFLICT', 'Only a sold unit can be delivered');
      return (await updateRow<UnitRow>(d, 'dealer_units', unitId, { status: 'DELIVERED' }, 'Unit')) ?? unit;
    case 'VOID': {
      if (cost !== 0) throw new DealerError('CONFLICT', 'A unit with posted cost cannot be voided — write it down or return it');
      if (await liveNoteFor(d, unitId)) throw new DealerError('CONFLICT', 'A unit on a live floor-plan note cannot be voided');
      const row = await updateRow<UnitRow>(d, 'dealer_units', unitId, { status: 'VOID', notes: a.reason }, 'Unit');
      await audit(d, 'unit.void', 'dealer_units', unitId, `Voided unit ${unit.serial_number}: ${a.reason}`);
      return row ?? unit;
    }
    case 'MOVE_TO_RENTAL': {
      await requireEnabled(d);
      if (!carried || unit.status === 'RENTAL') throw new DealerError('CONFLICT', `A ${unit.status} unit cannot move to rental`);
      const plan = rentalMovePlan({ fromRole: unit.inventory_role, costCents: cost, memo: `Unit ${unit.serial_number} moved to rental` });
      await postPlan(d, plan, { entryDate: a.date, key: `unit:rental:${unit.id}`, sourceId: unit.id });
      const row = await updateRow<UnitRow>(d, 'dealer_units', unitId, { status: 'RENTAL', inventory_role: 'RENTAL_INVENTORY', department_role: 'RENTAL' }, 'Unit');
      await audit(d, 'unit.rental', 'dealer_units', unitId, `Moved unit ${unit.serial_number} to rental at cost ${cost}`);
      return row ?? unit;
    }
    case 'WRITE_DOWN': {
      await requireEnabled(d);
      if (!carried) throw new DealerError('CONFLICT', `A ${unit.status} unit cannot be written down`);
      if (a.amountCents > cost) throw new DealerError('VALIDATION', 'Write-down exceeds the unit cost');
      const key = `cost:writedown:${unit.id}:${a.date}:${a.amountCents}`;
      if (await byKey<CostRow>(d, 'dealer_unit_costs', key)) return unit;
      const plan = writeDownPlan({ inventoryRole: unit.inventory_role, amountCents: a.amountCents, deptRole: unit.department_role, memo: `Unit ${unit.serial_number} write-down: ${a.reason}` });
      const posted = await postPlan(d, plan, { entryDate: a.date, key, sourceId: unit.id });
      await insertRow<CostRow>(d, 'dealer_unit_costs', {
        unit_id: unit.id, cost_type: 'WRITE_DOWN', amount_cents: -a.amountCents, source_type: 'JE', status: 'POSTED',
        gl_entry_id: posted.glEntryId, idempotency_key: key, proposed_by: d.userId, posted_by: d.userId,
        posted_at: new Date().toISOString(), memo: a.reason,
      }, 'Write-down');
      await audit(d, 'unit.write_down', 'dealer_units', unitId, `Wrote down unit ${unit.serial_number} by ${a.amountCents}`, { reason: a.reason });
      return getRow<UnitRow>(d, 'dealer_units', unitId, 'Unit');
    }
    case 'RETURN_TO_OEM': {
      await requireEnabled(d);
      if (!carried) throw new DealerError('CONFLICT', `A ${unit.status} unit cannot be returned`);
      const note = await liveNoteFor(d, unitId);
      if (note && a.lenderCreditCents !== note.principal_balance_cents) {
        throw new DealerError('VALIDATION', `The lender credit must clear the note (${note.principal_balance_cents}); record any difference as a curtailment first`);
      }
      if (!note && a.lenderCreditCents !== 0) throw new DealerError('VALIDATION', 'This unit is not floored — the lender credit must be 0');
      const line = note ? await getRow<LineRow>(d, 'floor_plan_lines', note.line_id, 'Floor-plan line') : null;
      const plan = returnToOemPlan({
        inventoryRole: unit.inventory_role, costCents: cost, lenderCreditCents: a.lenderCreditCents, deptRole: unit.department_role,
        lineLiabilityAccountId: line?.liability_account_id ?? null, memo: `Unit ${unit.serial_number} returned to manufacturer: ${a.reason}`,
      });
      const posted = await postPlan(d, plan, { entryDate: a.date, key: `unit:return:${unit.id}`, sourceId: unit.id });
      if (note) {
        applyPrincipalPayment(note, a.lenderCreditCents);
        await insertRow(d, 'floor_plan_transactions', {
          line_id: note.line_id, note_id: note.id, txn_type: 'ADJUSTMENT', txn_date: a.date, principal_cents: a.lenderCreditCents,
          status: 'POSTED', gl_entry_id: posted.glEntryId, memo: 'Lender credit on return', proposed_by: d.userId,
          approved_by: d.userId, posted_at: new Date().toISOString(), idempotency_key: `fpt:return:${note.id}`,
        }, 'Return adjustment');
        await updateRow(d, 'floor_plan_notes', note.id, { status: 'RETURNED', principal_balance_cents: 0 }, 'Note');
      }
      const row = await updateRow<UnitRow>(d, 'dealer_units', unitId, { status: 'RETURNED' }, 'Unit');
      await audit(d, 'unit.return', 'dealer_units', unitId, `Returned unit ${unit.serial_number} to the manufacturer`, { reason: a.reason });
      return row ?? unit;
    }
    default: {
      const never: never = a;
      throw new DealerError('VALIDATION', `Unknown action ${(never as { action: string }).action}`);
    }
  }
}
