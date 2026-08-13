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
  buildArProposal,
  customerNameKey,
  arPartyFromProvider,
  arOpenItemFromProvider,
  type RawArParty,
  type RawArOpenItem,
  type ArImportProposal,
} from '@/lib/onboarding/import/ar';
import { attachSubledgerDetail } from '@/lib/onboarding/import/subledger-session';

/**
 * POST /api/onboarding/import/ar — Customers & Open A/R section.
 *
 * action:'preview' — pull (ERP fetchCustomers+fetchOpenAR) OR coerce CSV OR accept a
 *   manual payload, normalize to an ArImportProposal, and return it for review. Writes
 *   nothing.
 * action:'commit' — upsert customers into core.customers, create the open invoices as
 *   real opening AR (SENT, no GL post — the 1100 control is carried by the opening
 *   trial-balance entry), then write Σ open A/R into the conversion session's
 *   subledgerDetail.arOpenByCustomerCents so the extended tie-out gate + Conversion
 *   Reconciliation fire.
 *
 * Degrade-safe: with AI off, ERP fixtures / CSV / manual all work deterministically.
 * RLS-scoped; guarded by customers:create.
 */

type Row = Record<string, string>;

interface Body {
  action?: 'preview' | 'commit';
  companyId?: string;
  source?: 'erp' | 'csv' | 'manual';
  // erp
  erpId?: string;
  useFixture?: boolean;
  // csv
  customerRows?: Row[];
  customerMapping?: Record<string, string>;
  invoiceRows?: Row[];
  invoiceMapping?: Record<string, string>;
  // manual
  parties?: RawArParty[];
  openItems?: RawArOpenItem[];
}

const MAX_ROWS = 20000;

export async function POST(req: NextRequest) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'customers', 'create');
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

  // Verify the target company belongs to the org (RLS-scoped read).
  const { data: loc } = await supabase
    .schema('core').from('locations')
    .select('id, short_code, name')
    .eq('id', body.companyId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (!loc) return NextResponse.json({ error: 'Selected company not found' }, { status: 400 });
  const company = loc as { id: string; short_code: string; name: string };

  // ── Gather raw parties + open items by source ────────────────────────────────
  let parties: RawArParty[] = [];
  let openItems: RawArOpenItem[] = [];

  if (source === 'erp') {
    if (!body.erpId || !isMigrationProviderId(body.erpId)) {
      return NextResponse.json({ error: 'Unknown migration provider' }, { status: 400 });
    }
    const provider = getMigrationProvider(body.erpId, { mock: !!body.useFixture });
    const [custRes, arRes] = await Promise.all([provider.fetchCustomers(), provider.fetchOpenAR()]);
    if (!custRes.connected || !arRes.connected) {
      const reason = !custRes.connected ? custRes.reason : (arRes as { reason: string }).reason;
      // Degrade-safe: not connected is not an error — the UI offers sample data / CSV.
      return NextResponse.json({ ok: true, connected: false, source: body.useFixture ? 'mock' : 'live', reason });
    }
    parties = custRes.records.map(arPartyFromProvider);
    openItems = arRes.records.map(arOpenItemFromProvider);
  } else if (source === 'csv') {
    const custErr = coerceRows(body.customerRows ?? [], body.customerMapping ?? {}, 'customers', (rec) => {
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
        creditLimitCents: rec.credit_limit_cents == null ? null : Number(rec.credit_limit_cents),
      });
    });
    const arErr = coerceRows(body.invoiceRows ?? [], body.invoiceMapping ?? {}, 'open_ar', (rec) => {
      openItems.push({
        partyName: String(rec.customer_name ?? '').trim(),
        docNumber: String(rec.invoice_number ?? '').trim(),
        date: String(rec.invoice_date ?? ''),
        dueDate: String(rec.due_date ?? ''),
        totalCents: Number(rec.total_cents ?? 0),
        amountPaidCents: Number(rec.amount_paid_cents ?? 0),
        memo: (rec.memo as string) ?? null,
      });
    });
    const rowErrors = [...custErr, ...arErr];
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

  // ── Existing keys for dedupe ─────────────────────────────────────────────────
  const existingCustomerKeys = await loadCustomerKeys(supabase, orgId);
  const existingInvoiceNumbers = await loadInvoiceNumbers(supabase, orgId);

  const proposal = buildArProposal({
    source,
    parties,
    openItems,
    existingCustomerKeys,
    existingInvoiceNumbers,
  });

  if (action === 'preview') {
    return NextResponse.json({ ok: true, connected: true, company: publicCompany(company), proposal });
  }

  // ── COMMIT ───────────────────────────────────────────────────────────────────
  return commitAr(supabase, orgId, company, proposal);
}

// ─────────────────────────────────────────────────────────────────────────────
// Commit
// ─────────────────────────────────────────────────────────────────────────────

async function commitAr(
  supabase: SupabaseClient,
  orgId: string,
  company: { id: string; short_code: string; name: string },
  proposal: ArImportProposal,
) {
  // 1) Insert NEW customer masters.
  const newCustomers = proposal.customers.filter((c) => !c.existing);
  let insertedCustomers = 0;
  if (newCustomers.length > 0) {
    const rows = newCustomers.map((c) => ({
      org_id: orgId,
      name: c.name,
      email: c.email,
      phone: c.phone,
      address_line1: c.addressLine1,
      address_line2: c.addressLine2,
      city: c.city,
      state: c.state,
      zip: c.zip,
      payment_terms_days: c.paymentTermsDays,
      credit_limit_cents: c.creditLimitCents,
    }));
    const { error } = await supabase.schema('core').from('customers').insert(rows);
    if (error) return NextResponse.json({ error: `Could not save customers: ${error.message}` }, { status: 500 });
    insertedCustomers = rows.length;
  }

  // 2) Resolve customer name → id across existing + newly inserted.
  const idByKey = await loadCustomerIdByKey(supabase, orgId);

  // 3) Insert the open invoices as opening AR (SENT, no GL post). Skip duplicates.
  const invoiceRows: Record<string, unknown>[] = [];
  let skippedInvoices = 0;
  const orphaned: string[] = [];
  for (const inv of proposal.invoices) {
    if (inv.duplicate) { skippedInvoices += 1; continue; }
    const custId = idByKey.get(customerNameKey(inv.customerName));
    if (!custId) { orphaned.push(inv.invoiceNumber); continue; }
    const status = inv.balanceCents <= 0 ? 'PAID' : inv.amountPaidCents > 0 ? 'PARTIALLY_PAID' : 'SENT';
    invoiceRows.push({
      org_id: orgId,
      location_id: company.id,
      customer_id: custId,
      invoice_number: inv.invoiceNumber,
      invoice_date: inv.invoiceDate,
      due_date: inv.dueDate,
      subtotal_cents: inv.totalCents,
      total_cents: inv.totalCents,
      amount_paid_cents: inv.amountPaidCents,
      status,
      memo: inv.memo,
    });
  }
  let insertedInvoices = 0;
  if (invoiceRows.length > 0) {
    const { error } = await supabase.from('invoices').insert(invoiceRows);
    if (error) return NextResponse.json({ error: `Could not save opening invoices: ${error.message}` }, { status: 500 });
    insertedInvoices = invoiceRows.length;
  }

  // 4) Authoritative Σ open A/R from the live subledger (v_ar_aging) for this company —
  //    the same total the Conversion Reconciliation report reads, so the AR→control tie
  //    is exact. Write it onto the open conversion session's subledgerDetail.
  const openArCents = await sumArAging(supabase, company.id);
  let attached: { attached: boolean; sessionId: string | null } = { attached: false, sessionId: null };
  if (openArCents > 0) {
    attached = await attachSubledgerDetail(supabase, orgId, company.id, { arOpenByCustomerCents: openArCents });
  }

  return NextResponse.json({
    ok: true,
    insertedCustomers,
    insertedInvoices,
    skippedInvoices,
    orphanedInvoices: orphaned.slice(0, 50),
    openArCents,
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

/** Coerce CSV rows for a known import type, invoking `sink` per valid record. */
function coerceRows(
  rows: Row[],
  mapping: Record<string, string>,
  typeKey: 'customers' | 'open_ar',
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

async function loadCustomerKeys(supabase: SupabaseClient, orgId: string): Promise<Set<string>> {
  const { data } = await supabase.schema('core').from('customers').select('name').eq('org_id', orgId);
  return new Set((data ?? []).map((r) => customerNameKey(String((r as { name: string }).name))));
}

async function loadCustomerIdByKey(supabase: SupabaseClient, orgId: string): Promise<Map<string, string>> {
  const { data } = await supabase.schema('core').from('customers').select('id, name').eq('org_id', orgId);
  const map = new Map<string, string>();
  for (const r of (data ?? []) as Array<{ id: string; name: string }>) {
    map.set(customerNameKey(r.name), r.id);
  }
  return map;
}

async function loadInvoiceNumbers(supabase: SupabaseClient, orgId: string): Promise<Set<string>> {
  const { data } = await supabase.from('invoices').select('invoice_number').eq('org_id', orgId);
  return new Set((data ?? []).map((r) => String((r as { invoice_number: string }).invoice_number).toLowerCase()));
}

async function sumArAging(supabase: SupabaseClient, locationId: string): Promise<number> {
  const { data } = await supabase.from('v_ar_aging').select('balance_cents').eq('location_id', locationId).gt('balance_cents', 0);
  let total = 0;
  for (const r of (data ?? []) as Array<{ balance_cents: number | string | null }>) total += Number(r.balance_cents ?? 0);
  return total;
}
