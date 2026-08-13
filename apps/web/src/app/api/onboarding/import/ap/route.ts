export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { getImportType } from '@/lib/import/definitions';
import { coerceValue } from '@/lib/import/csv';
import {
  getMigrationProvider,
  isMigrationProviderId,
} from '@/lib/integrations/erp/providers';
import {
  buildApProposal,
  vendorNameKey,
  billKey,
  apPartyFromProvider,
  apOpenItemFromProvider,
  type RawApParty,
  type RawApOpenItem,
  type ApImportProposal,
} from '@/lib/onboarding/import/ap';
import { attachSubledgerDetail } from '@/lib/onboarding/import/subledger-session';

/**
 * POST /api/onboarding/import/ap — Vendors & Open A/P section (mirror of the AR route).
 *
 * action:'preview' — pull (ERP fetchVendors+fetchOpenAP) OR coerce CSV OR accept a
 *   manual payload, normalize to an ApImportProposal, return it for review.
 * action:'commit' — upsert vendors into core.vendors, create the open bills as real
 *   opening A/P (APPROVED, no GL post — the 2000 control is carried by the opening
 *   trial-balance entry), then write Σ open A/P into the conversion session's
 *   subledgerDetail.apOpenByVendorCents so the extended tie-out gate fires.
 *
 * Degrade-safe; RLS-scoped; guarded by vendors:create.
 */

type Row = Record<string, string>;

interface Body {
  action?: 'preview' | 'commit';
  companyId?: string;
  source?: 'erp' | 'csv' | 'manual';
  erpId?: string;
  useFixture?: boolean;
  vendorRows?: Row[];
  vendorMapping?: Record<string, string>;
  billRows?: Row[];
  billMapping?: Record<string, string>;
  parties?: RawApParty[];
  openItems?: RawApOpenItem[];
}

const MAX_ROWS = 20000;

export async function POST(req: NextRequest) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'vendors', 'create');
  if (!guard.ok) return guard.response;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const action = body.action ?? 'preview';
  const source = body.source ?? 'manual';
  if (!body.companyId) return NextResponse.json({ error: 'Select a company for this import' }, { status: 400 });

  const { data: loc } = await supabase
    .schema('core').from('locations')
    .select('id, short_code, name')
    .eq('id', body.companyId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (!loc) return NextResponse.json({ error: 'Selected company not found' }, { status: 400 });
  const company = loc as { id: string; short_code: string; name: string };

  let parties: RawApParty[] = [];
  let openItems: RawApOpenItem[] = [];

  if (source === 'erp') {
    if (!body.erpId || !isMigrationProviderId(body.erpId)) {
      return NextResponse.json({ error: 'Unknown migration provider' }, { status: 400 });
    }
    const provider = getMigrationProvider(body.erpId, { mock: !!body.useFixture });
    const [venRes, apRes] = await Promise.all([provider.fetchVendors(), provider.fetchOpenAP()]);
    if (!venRes.connected || !apRes.connected) {
      const reason = !venRes.connected ? venRes.reason : (apRes as { reason: string }).reason;
      return NextResponse.json({ ok: true, connected: false, source: body.useFixture ? 'mock' : 'live', reason });
    }
    parties = venRes.records.map(apPartyFromProvider);
    openItems = apRes.records.map(apOpenItemFromProvider);
  } else if (source === 'csv') {
    const venErr = coerceRows(body.vendorRows ?? [], body.vendorMapping ?? {}, 'vendors', (rec) => {
      parties.push({
        name: String(rec.name ?? '').trim(),
        email: (rec.email as string) ?? null,
        phone: (rec.phone as string) ?? null,
        addressLine1: (rec.address_line1 as string) ?? null,
        addressLine2: (rec.address_line2 as string) ?? null,
        city: (rec.city as string) ?? null,
        state: (rec.state as string) ?? null,
        zip: (rec.zip as string) ?? null,
        paymentTermsDays: rec.payment_terms_days == null ? null : Number(rec.payment_terms_days),
        is1099Eligible: rec.is_1099_eligible === true,
      });
    });
    const apErr = coerceRows(body.billRows ?? [], body.billMapping ?? {}, 'open_ap', (rec) => {
      openItems.push({
        partyName: String(rec.vendor_name ?? '').trim(),
        docNumber: String(rec.bill_number ?? '').trim(),
        date: String(rec.bill_date ?? ''),
        dueDate: String(rec.due_date ?? ''),
        totalCents: Number(rec.total_cents ?? 0),
        amountPaidCents: Number(rec.amount_paid_cents ?? 0),
      });
    });
    const rowErrors = [...venErr, ...apErr];
    if (rowErrors.length > 0) {
      return NextResponse.json({ error: 'The file has invalid rows', errors: rowErrors.slice(0, 200) }, { status: 422 });
    }
  } else {
    parties = Array.isArray(body.parties) ? body.parties : [];
    openItems = Array.isArray(body.openItems) ? body.openItems : [];
  }

  if (parties.length + openItems.length > MAX_ROWS) {
    return NextResponse.json({ error: `Import is limited to ${MAX_ROWS} rows` }, { status: 400 });
  }

  const existingVendorKeys = await loadVendorKeys(supabase, orgId);
  const existingBillKeys = await loadBillKeys(supabase, orgId);

  const proposal = buildApProposal({
    source,
    parties,
    openItems,
    existingVendorKeys,
    existingBillKeys,
  });

  if (action === 'preview') {
    return NextResponse.json({ ok: true, connected: true, company: publicCompany(company), proposal });
  }

  return commitAp(supabase, orgId, company, proposal);
}

// ─────────────────────────────────────────────────────────────────────────────
// Commit
// ─────────────────────────────────────────────────────────────────────────────

async function commitAp(
  supabase: SupabaseClient,
  orgId: string,
  company: { id: string; short_code: string; name: string },
  proposal: ApImportProposal,
) {
  const newVendors = proposal.vendors.filter((v) => !v.existing);
  let insertedVendors = 0;
  if (newVendors.length > 0) {
    const rows = newVendors.map((v) => ({
      org_id: orgId,
      name: v.name,
      email: v.email,
      phone: v.phone,
      address_line1: v.addressLine1,
      address_line2: v.addressLine2,
      city: v.city,
      state: v.state,
      zip: v.zip,
      payment_terms_days: v.paymentTermsDays,
      is_1099_eligible: v.is1099Eligible,
    }));
    const { error } = await supabase.schema('core').from('vendors').insert(rows);
    if (error) return NextResponse.json({ error: `Could not save vendors: ${error.message}` }, { status: 500 });
    insertedVendors = rows.length;
  }

  const idByKey = await loadVendorIdByKey(supabase, orgId);

  const billRows: Record<string, unknown>[] = [];
  let skippedBills = 0;
  const orphaned: string[] = [];
  for (const bill of proposal.bills) {
    if (bill.duplicate) { skippedBills += 1; continue; }
    const vendorId = idByKey.get(vendorNameKey(bill.vendorName));
    if (!vendorId) { orphaned.push(bill.billNumber || `(${bill.vendorName})`); continue; }
    const status = bill.balanceCents <= 0 ? 'PAID' : bill.amountPaidCents > 0 ? 'PARTIALLY_PAID' : 'APPROVED';
    billRows.push({
      org_id: orgId,
      location_id: company.id,
      vendor_id: vendorId,
      bill_number: bill.billNumber || null,
      bill_date: bill.billDate,
      due_date: bill.dueDate,
      subtotal_cents: bill.totalCents,
      total_cents: bill.totalCents,
      amount_paid_cents: bill.amountPaidCents,
      status,
    });
  }
  let insertedBills = 0;
  if (billRows.length > 0) {
    const { error } = await supabase.from('bills').insert(billRows);
    if (error) return NextResponse.json({ error: `Could not save opening bills: ${error.message}` }, { status: 500 });
    insertedBills = billRows.length;
  }

  const openApCents = await sumApAging(supabase, company.id);
  let attached: { attached: boolean; sessionId: string | null } = { attached: false, sessionId: null };
  if (openApCents > 0) {
    attached = await attachSubledgerDetail(supabase, orgId, company.id, { apOpenByVendorCents: openApCents });
  }

  return NextResponse.json({
    ok: true,
    insertedVendors,
    insertedBills,
    skippedBills,
    orphanedBills: orphaned.slice(0, 50),
    openApCents,
    subledgerAttached: attached.attached,
    conversionSessionId: attached.sessionId,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function publicCompany(c: { id: string; short_code: string; name: string }) {
  return { id: c.id, shortCode: c.short_code, name: c.name };
}

type Cell = string | number | boolean | null;

function coerceRows(
  rows: Row[],
  mapping: Record<string, string>,
  typeKey: 'vendors' | 'open_ap',
  sink: (rec: Record<string, Cell>) => void,
): { row: number; message: string }[] {
  const def = getImportType(typeKey);
  const errors: { row: number; message: string }[] = [];
  if (!def) return errors;
  rows.forEach((raw, i) => {
    const rowNum = i + 2;
    const rec: Record<string, Cell> = {};
    let ok = true;
    for (const field of def.fields) {
      const header = mapping[field.key];
      const cell = header ? (raw[header] ?? '') : '';
      const res = coerceValue(cell, field);
      if (!res.ok) { errors.push({ row: rowNum, message: res.error ?? `${field.label} invalid` }); ok = false; continue; }
      rec[field.key] = res.value;
    }
    if (ok) sink(rec);
  });
  return errors;
}

async function loadVendorKeys(supabase: SupabaseClient, orgId: string): Promise<Set<string>> {
  const { data } = await supabase.schema('core').from('vendors').select('name').eq('org_id', orgId);
  return new Set((data ?? []).map((r) => vendorNameKey(String((r as { name: string }).name))));
}

async function loadVendorIdByKey(supabase: SupabaseClient, orgId: string): Promise<Map<string, string>> {
  const { data } = await supabase.schema('core').from('vendors').select('id, name').eq('org_id', orgId);
  const map = new Map<string, string>();
  for (const r of (data ?? []) as Array<{ id: string; name: string }>) {
    map.set(vendorNameKey(r.name), r.id);
  }
  return map;
}

/** Existing bill keys (vendorNameKey|#num or vendorNameKey|~amt@date) for dedupe. */
async function loadBillKeys(supabase: SupabaseClient, orgId: string): Promise<Set<string>> {
  const nameById = new Map<string, string>();
  const { data: vendors } = await supabase.schema('core').from('vendors').select('id, name').eq('org_id', orgId);
  for (const v of (vendors ?? []) as Array<{ id: string; name: string }>) nameById.set(v.id, v.name);

  const { data: bills } = await supabase
    .from('bills')
    .select('vendor_id, bill_number, total_cents, bill_date')
    .eq('org_id', orgId);
  const keys = new Set<string>();
  for (const b of (bills ?? []) as Array<{ vendor_id: string; bill_number: string | null; total_cents: number; bill_date: string }>) {
    const name = nameById.get(b.vendor_id) ?? '';
    keys.add(billKey(vendorNameKey(name), b.bill_number ?? '', Number(b.total_cents ?? 0), b.bill_date));
  }
  return keys;
}

async function sumApAging(supabase: SupabaseClient, locationId: string): Promise<number> {
  const { data } = await supabase.from('v_ap_aging').select('balance_cents').eq('location_id', locationId).gt('balance_cents', 0);
  let total = 0;
  for (const r of (data ?? []) as Array<{ balance_cents: number | string | null }>) total += Number(r.balance_cents ?? 0);
  return total;
}
