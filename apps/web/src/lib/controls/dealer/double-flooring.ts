/**
 * DL-13 — Double-recorded flooring (FPB §6, AC 13). HIGH, DETECT-ONLY.
 *
 * When the lender pays the manufacturer, the unit is already on the books through
 * the floor plan (DR unit inventory / CR floor plan payable). If the same
 * manufacturer invoice is ALSO keyed as an AP bill, the unit is counted twice. This
 * detector flags any non-void AP bill line at the same client whose description or
 * bill number carries:
 *   - the lender invoice # of a live floor-plan note (any vendor), or
 *   - the serial of a live floored unit, when the bill's vendor is that unit's
 *     manufacturer, the program's manufacturer or the floor-plan lender (a carrier's
 *     freight bill naming the serial is legitimate and is NOT flagged).
 * Bill lines already linked to the unit as a cost (dealer_unit_costs BILL_LINE) are
 * legitimate unit costs and are skipped. Tokens shorter than 5 characters are never
 * matched (false-positive guard). It never blocks, edits or voids a bill: blocking
 * approval belongs to the AP intake write path (lead / AP-owner integration).
 */

import { dealerLinks } from '@/lib/dealer/ui/links';
import { fetchAll, fetchAllIn } from '@/lib/supabase/fetch-all';
import { addDays } from '@/lib/dealer/dates';
import { DEALER_FEATURES, money, normalizeToken, readFail, type ClientScan, type DealerDetectorDef, type DealerFinding } from './shared';

export const MIN_MATCH_TOKEN = 5;

export interface FlooredNote {
  id: string;
  unit_id: string | null;
  lender_invoice_number: string;
  serial_number: string | null;
  original_principal_cents: number;
  /** Vendors whose bill naming this serial is suspicious. */
  relatedVendorIds: string[];
}

export interface BillIn {
  id: string;
  vendor_id: string;
  bill_number: string | null;
  status: string;
}

export interface BillLineIn {
  id: string;
  bill_id: string;
  description: string | null;
  amount_cents: number;
}

export function doubleFlooringFindings(input: {
  notes: FlooredNote[];
  bills: BillIn[];
  lines: BillLineIn[];
  linkedBillLineIds: ReadonlySet<string>;
}): DealerFinding[] {
  const billById = new Map(input.bills.map((b) => [b.id, b]));
  const prepared = input.notes.map((n) => ({
    n,
    inv: normalizeToken(n.lender_invoice_number),
    serial: normalizeToken(n.serial_number),
    vendors: new Set(n.relatedVendorIds),
  }));
  const out: DealerFinding[] = [];
  for (const l of input.lines) {
    if (input.linkedBillLineIds.has(l.id)) continue;
    const bill = billById.get(l.bill_id);
    if (!bill || bill.status === 'VOIDED') continue;
    const text = `${normalizeToken(l.description)}|${normalizeToken(bill.bill_number)}`;
    for (const p of prepared) {
      let via: 'invoice' | 'serial' | null = null;
      if (p.inv.length >= MIN_MATCH_TOKEN && text.includes(p.inv)) via = 'invoice';
      else if (p.serial.length >= MIN_MATCH_TOKEN && text.includes(p.serial) && p.vendors.has(bill.vendor_id)) via = 'serial';
      if (!via) continue;
      const billLabel = bill.bill_number ? `bill ${bill.bill_number}` : 'an AP bill';
      const unitLabel = p.n.serial_number ? `serial ${p.n.serial_number}` : `lender invoice ${p.n.lender_invoice_number}`;
      const posted = !['PENDING', 'ON_HOLD'].includes(bill.status);
      out.push({
        control: 'DL-13',
        kind: via,
        dedupKey: `DL-13:${l.id}:${p.n.id}`,
        severity: 'HIGH',
        amountAtRiskCents: Math.abs(l.amount_cents),
        title: `Possible double-recorded flooring: ${billLabel} · ${unitLabel} is already floored (${money(l.amount_cents)})`,
        reason: `A line on ${billLabel} mentions ${via === 'invoice' ? `the lender invoice number ${p.n.lender_invoice_number}` : `serial ${p.n.serial_number}, and the bill is from the unit's manufacturer or lender`}. That unit is already on the books through the floor plan (${money(p.n.original_principal_cents)} floored), so recording the manufacturer invoice as a bill would count it twice.${posted ? ' The bill has already been approved or posted.' : ''}`,
        question: 'Check whether this bill is the manufacturer invoice the floor-plan lender already paid. If it is, don’t approve it (or void it) — the floor plan already recorded the unit.',
        href: `/bills?id=${encodeURIComponent(bill.id)}`,
        subjects: { bill_id: bill.id, bill_line_id: l.id, note_id: p.n.id, unit_id: p.n.unit_id },
        subjectTable: 'bill_lines',
        subjectId: l.id,
        facts: { matched_by: via, bill_status: bill.status, note_href: dealerLinks.note(p.n.id) },
      });
    }
  }
  return out;
}

async function collect(c: ClientScan): Promise<DealerFinding[]> {
  const notesRes = await fetchAll<Record<string, unknown>>(
    () =>
      c.db
        .from('floor_plan_notes')
        .select('id, unit_id, line_id, program_id, lender_invoice_number, original_principal_cents, floored_date')
        .eq('org_id', c.orgId)
        .eq('location_id', c.locationId)
        .in('status', ['OPEN', 'SOLD_UNPAID', 'IN_DEFAULT']),
    { label: 'DL-13 notes' },
  );
  if (notesRes.error) readFail('Notes lookup failed', notesRes.error);
  const notes = notesRes.data ?? [];
  if (notes.length === 0) return [];

  const unitIds = [...new Set(notes.map((n) => n.unit_id as string | null).filter((x): x is string => !!x))];
  const lineIds = [...new Set(notes.map((n) => n.line_id as string))];
  const programIds = [...new Set(notes.map((n) => n.program_id as string | null).filter((x): x is string => !!x))];
  const [unitsRes, linesRes, programsRes] = await Promise.all([
    fetchAllIn<Record<string, unknown>>(unitIds, (chunk) => c.db.from('dealer_units').select('id, serial_number, make_vendor_id').eq('org_id', c.orgId).in('id', chunk), { label: 'DL-13 units' }),
    c.db.from('floor_plan_lines').select('id, lender_vendor_id').eq('org_id', c.orgId).in('id', lineIds),
    programIds.length
      ? c.db.from('floor_plan_programs').select('id, oem_vendor_id').eq('org_id', c.orgId).in('id', programIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[], error: null }),
  ]);
  for (const r of [unitsRes, linesRes, programsRes]) if (r.error) readFail('Flooring lookup failed', r.error);
  const units = new Map((unitsRes.data ?? []).map((u) => [u.id as string, u]));
  const lender = new Map(((linesRes.data ?? []) as Record<string, unknown>[]).map((l) => [l.id as string, l.lender_vendor_id as string]));
  const oem = new Map(((programsRes.data ?? []) as Record<string, unknown>[]).map((p) => [p.id as string, (p.oem_vendor_id as string | null) ?? null]));

  const floored: FlooredNote[] = notes.map((n) => {
    const u = n.unit_id ? units.get(n.unit_id as string) : undefined;
    const related = [
      lender.get(n.line_id as string) ?? null,
      (u?.make_vendor_id as string | null | undefined) ?? null,
      n.program_id ? oem.get(n.program_id as string) ?? null : null,
    ].filter((x): x is string => !!x);
    return {
      id: n.id as string,
      unit_id: (n.unit_id as string | null) ?? null,
      lender_invoice_number: String(n.lender_invoice_number ?? ''),
      serial_number: (u?.serial_number as string | undefined) ?? null,
      original_principal_cents: Number(n.original_principal_cents ?? 0),
      relatedVendorIds: related,
    };
  });

  // Bills from a little before the oldest live flooring onward.
  const oldest = notes.map((n) => n.floored_date as string).sort()[0];
  const since = addDays(oldest, -120);
  const billsRes = await fetchAll<Record<string, unknown>>(
    () =>
      c.db
        .from('bills')
        .select('id, vendor_id, bill_number, status')
        .eq('org_id', c.orgId)
        .eq('location_id', c.locationId)
        .neq('status', 'VOIDED')
        .gte('bill_date', since),
    { label: 'DL-13 bills' },
  );
  if (billsRes.error) readFail('Bills lookup failed', billsRes.error);
  const bills: BillIn[] = (billsRes.data ?? []).map((b) => ({
    id: b.id as string,
    vendor_id: b.vendor_id as string,
    bill_number: (b.bill_number as string | null) ?? null,
    status: String(b.status),
  }));
  if (bills.length === 0) return [];
  const linesRes2 = await fetchAllIn<Record<string, unknown>>(
    bills.map((b) => b.id),
    (chunk) => c.db.from('bill_lines').select('id, bill_id, description, amount_cents').eq('org_id', c.orgId).in('bill_id', chunk),
    { label: 'DL-13 bill lines' },
  );
  if (linesRes2.error) readFail('Bill lines lookup failed', linesRes2.error);
  const linkedRes = await fetchAll<Record<string, unknown>>(
    () =>
      c.db
        .from('dealer_unit_costs')
        .select('id, source_id')
        .eq('org_id', c.orgId)
        .eq('location_id', c.locationId)
        .eq('source_type', 'BILL_LINE')
        .in('status', ['PROPOSED', 'POSTED']),
    { label: 'DL-13 linked bill lines' },
  );
  if (linkedRes.error) readFail('Unit cost lookup failed', linkedRes.error);
  return doubleFlooringFindings({
    notes: floored,
    bills,
    lines: (linesRes2.data ?? []).map((l) => ({
      id: l.id as string,
      bill_id: l.bill_id as string,
      description: (l.description as string | null) ?? null,
      amount_cents: Number(l.amount_cents ?? 0),
    })),
    linkedBillLineIds: new Set((linkedRes.data ?? []).map((r) => r.source_id as string).filter(Boolean)),
  });
}

export const DOUBLE_FLOORING_DETECTOR: DealerDetectorDef = {
  key: 'dealer_double_flooring',
  feature: DEALER_FEATURES.DOUBLE_FLOORING,
  control: 'DL-13',
  label: 'Double-recorded flooring',
  collect,
};
