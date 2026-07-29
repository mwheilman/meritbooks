export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAuthedContext } from '@/lib/api-handler';
import { getImportType, type ImportFieldDef } from '@/lib/import/definitions';
import { coerceValue } from '@/lib/import/csv';

type Cell = string | number | boolean | null;
type Row = Record<string, string>;
interface RowError { row: number; message: string }

interface ImportRequest {
  type: string;
  mapping: Record<string, string>; // fieldKey -> csvHeader
  rows: Row[];
  companyId?: string; // location id for ledger imports
  asOfDate?: string; // trial balance
  dryRun?: boolean;
}

/** Map + coerce a CSV row to a field-keyed record; collect per-cell errors. */
function buildRecord(
  raw: Row,
  fields: ImportFieldDef[],
  mapping: Record<string, string>,
  rowNum: number,
  errors: RowError[]
): Record<string, Cell> | null {
  const out: Record<string, Cell> = {};
  let rowOk = true;
  for (const field of fields) {
    const header = mapping[field.key];
    const cell = header ? (raw[header] ?? '') : '';
    const res = coerceValue(cell, field);
    if (!res.ok) {
      errors.push({ row: rowNum, message: res.error ?? `${field.label} invalid` });
      rowOk = false;
      continue;
    }
    out[field.key] = res.value;
  }
  return rowOk ? out : null;
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireAuthedContext();
    if (ctx instanceof NextResponse) return ctx;
    const { supabase, orgId } = ctx;
    if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

    const body = (await req.json()) as ImportRequest;
    const def = getImportType(body.type);
    if (!def) return NextResponse.json({ error: `Unknown import type: ${body.type}` }, { status: 400 });
    if (!Array.isArray(body.rows) || body.rows.length === 0) {
      return NextResponse.json({ error: 'No rows to import' }, { status: 400 });
    }
    if (body.rows.length > 10000) {
      return NextResponse.json({ error: 'Import is limited to 10,000 rows per file' }, { status: 400 });
    }

    // Resolve required company (location) for ledger imports.
    let location: { id: string; short_code: string } | null = null;
    if (def.requiresCompany) {
      if (!body.companyId) return NextResponse.json({ error: 'Select a company for this import' }, { status: 400 });
      const { data: loc } = await supabase
        .schema('core').from('locations')
        .select('id, short_code')
        .eq('id', body.companyId)
        .eq('org_id', orgId)
        .single();
      if (!loc) return NextResponse.json({ error: 'Selected company not found' }, { status: 400 });
      location = loc as { id: string; short_code: string };
    }

    const errors: RowError[] = [];
    const dryRun = body.dryRun === true;

    // ── MASTER DATA → CORE ───────────────────────────────────────────────
    if (def.target === 'core') {
      return await importMasterData(supabase, def.key, def.fields, body, orgId, errors, dryRun);
    }

    // ── LEDGER → BOOKS ───────────────────────────────────────────────────
    if (def.key === 'open_ar' || def.key === 'open_ap') {
      return await importSubledger(supabase, def.key, def.fields, body, orgId, location!, errors, dryRun);
    }
    if (def.key === 'trial_balance') {
      return await importTrialBalance(supabase, def.fields, body, orgId, location!, errors, dryRun);
    }
    if (def.key === 'gl_history') {
      return await importGlHistory(supabase, def.fields, body, orgId, location!, errors, dryRun);
    }

    return NextResponse.json({ error: 'Unhandled import type' }, { status: 400 });
  } catch (e) {
    console.error('[import] error:', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Import failed' }, { status: 500 });
  }
}

// =============================================================
// MASTER DATA (core): entities, customers, vendors, items
// =============================================================
async function importMasterData(
  supabase: SupabaseClient,
  key: string,
  fields: ImportFieldDef[],
  body: ImportRequest,
  orgId: string,
  errors: RowError[],
  dryRun: boolean
) {
  const table = { entities: 'locations', customers: 'customers', vendors: 'vendors', items: 'items' }[key]!;
  const dedupeField = { entities: 'short_code', customers: 'name', vendors: 'name', items: 'sku' }[key]!;

  // Existing keys for dedupe.
  const { data: existing } = await supabase.schema('core').from(table).select(dedupeField).eq('org_id', orgId);
  const seen = new Set((existing ?? []).map((r) => String((r as unknown as Record<string, unknown>)[dedupeField] ?? '').toLowerCase()));

  const toInsert: Record<string, Cell>[] = [];
  let skipped = 0;

  body.rows.forEach((raw, i) => {
    const rowNum = i + 2; // +1 header, +1 to 1-index
    const rec = buildRecord(raw, fields, body.mapping, rowNum, errors);
    if (!rec) return;

    if (key === 'entities') {
      rec.short_code = String(rec.short_code ?? '').toUpperCase();
      if (!/^[A-Z0-9]{1,10}$/.test(rec.short_code as string)) {
        errors.push({ row: rowNum, message: `Short code "${rec.short_code}" must be 1–10 chars, A–Z/0–9` });
        return;
      }
      const m = Number(rec.fiscal_year_start_month ?? 1);
      if (m < 1 || m > 12) { errors.push({ row: rowNum, message: 'Fiscal year start month must be 1–12' }); return; }
    }

    const dkey = String(rec[dedupeField] ?? '').toLowerCase();
    if (seen.has(dkey)) { skipped++; return; }
    seen.add(dkey);

    toInsert.push(buildCoreRow(key, rec, orgId));
  });

  if (dryRun) {
    return NextResponse.json({ ok: errors.length === 0, dryRun: true, willInsert: toInsert.length, skipped, errors: errors.slice(0, 200), destination: `core.${table}` });
  }
  if (errors.length > 0) {
    return NextResponse.json({ ok: false, inserted: 0, skipped, errors: errors.slice(0, 200) }, { status: 422 });
  }
  if (toInsert.length === 0) {
    return NextResponse.json({ ok: true, inserted: 0, skipped, errors: [], destination: `core.${table}` });
  }

  const { error } = await supabase.schema('core').from(table).insert(toInsert);
  if (error) return NextResponse.json({ ok: false, inserted: 0, skipped, errors: [{ row: 0, message: error.message }] }, { status: 500 });

  return NextResponse.json({ ok: true, inserted: toInsert.length, skipped, errors: [], destination: `core.${table}` });
}

function buildCoreRow(key: string, rec: Record<string, Cell>, orgId: string): Record<string, Cell> {
  if (key === 'entities') {
    return {
      org_id: orgId,
      name: rec.name,
      short_code: rec.short_code,
      industry: rec.industry ?? null,
      fiscal_year_start_month: rec.fiscal_year_start_month ?? 1,
    };
  }
  if (key === 'customers') {
    return {
      org_id: orgId,
      name: rec.name,
      email: rec.email ?? null,
      phone: rec.phone ?? null,
      address_line1: rec.address_line1 ?? null,
      address_line2: rec.address_line2 ?? null,
      city: rec.city ?? null,
      state: rec.state ?? null,
      zip: rec.zip ?? null,
      payment_terms_days: rec.payment_terms_days ?? 30,
      credit_limit_cents: rec.credit_limit_cents ?? null,
    };
  }
  if (key === 'vendors') {
    return {
      org_id: orgId,
      name: rec.name,
      email: rec.email ?? null,
      phone: rec.phone ?? null,
      address_line1: rec.address_line1 ?? null,
      address_line2: rec.address_line2 ?? null,
      city: rec.city ?? null,
      state: rec.state ?? null,
      zip: rec.zip ?? null,
      payment_terms_days: rec.payment_terms_days ?? 30,
      is_1099_eligible: rec.is_1099_eligible ?? false,
    };
  }
  // items
  return {
    org_id: orgId,
    sku: rec.sku,
    name: rec.name,
    item_type: rec.item_type ?? 'INVENTORY',
    unit_of_measure: rec.unit_of_measure ?? null,
    default_unit_cost_cents: rec.default_unit_cost_cents ?? null,
  };
}

// =============================================================
// SUB-LEDGER (Books): open AR → invoices, open AP → bills
// =============================================================
async function importSubledger(
  supabase: SupabaseClient,
  key: 'open_ar' | 'open_ap',
  fields: ImportFieldDef[],
  body: ImportRequest,
  orgId: string,
  location: { id: string; short_code: string },
  errors: RowError[],
  dryRun: boolean
) {
  const isAr = key === 'open_ar';
  const partyTable = isAr ? 'customers' : 'vendors';

  // Build name → id lookup from core.
  const { data: parties } = await supabase.schema('core').from(partyTable).select('id, name').eq('org_id', orgId);
  const byName = new Map((parties ?? []).map((p) => [String((p as { name: string }).name).toLowerCase(), (p as { id: string }).id]));

  const toInsert: Record<string, Cell>[] = [];
  let skipped = 0;

  // Dedupe AR by invoice_number (unique per org).
  const existingNumbers = new Set<string>();
  if (isAr) {
    const { data: inv } = await supabase.from('invoices').select('invoice_number').eq('org_id', orgId);
    (inv ?? []).forEach((r) => existingNumbers.add(String((r as { invoice_number: string }).invoice_number).toLowerCase()));
  }

  body.rows.forEach((raw, i) => {
    const rowNum = i + 2;
    const rec = buildRecord(raw, fields, body.mapping, rowNum, errors);
    if (!rec) return;

    const partyName = String((isAr ? rec.customer_name : rec.vendor_name) ?? '');
    const partyId = byName.get(partyName.toLowerCase());
    if (!partyId) {
      errors.push({ row: rowNum, message: `${isAr ? 'Customer' : 'Vendor'} "${partyName}" not found in core — import ${partyTable} first` });
      return;
    }

    const total = Number(rec.total_cents ?? 0);
    const paid = Number(rec.amount_paid_cents ?? 0);
    if (total <= 0) { errors.push({ row: rowNum, message: 'Total must be greater than zero' }); return; }
    if (paid > total) { errors.push({ row: rowNum, message: 'Amount paid exceeds total' }); return; }

    if (isAr) {
      const num = String(rec.invoice_number ?? '');
      if (existingNumbers.has(num.toLowerCase())) { skipped++; return; }
      existingNumbers.add(num.toLowerCase());
      toInsert.push({
        org_id: orgId,
        location_id: location.id,
        customer_id: partyId,
        invoice_number: num,
        invoice_date: rec.invoice_date,
        due_date: rec.due_date,
        subtotal_cents: total,
        total_cents: total,
        amount_paid_cents: paid,
        status: paid >= total ? 'PAID' : paid > 0 ? 'PARTIALLY_PAID' : 'SENT',
        memo: rec.memo ?? null,
      });
    } else {
      toInsert.push({
        org_id: orgId,
        location_id: location.id,
        vendor_id: partyId,
        bill_number: rec.bill_number ?? null,
        bill_date: rec.bill_date,
        due_date: rec.due_date,
        subtotal_cents: total,
        total_cents: total,
        amount_paid_cents: paid,
        status: paid >= total ? 'PAID' : paid > 0 ? 'PARTIALLY_PAID' : 'APPROVED',
      });
    }
  });

  const dest = isAr ? 'public.invoices' : 'public.bills';
  if (dryRun) {
    return NextResponse.json({ ok: errors.length === 0, dryRun: true, willInsert: toInsert.length, skipped, errors: errors.slice(0, 200), destination: dest });
  }
  if (errors.length > 0) {
    return NextResponse.json({ ok: false, inserted: 0, skipped, errors: errors.slice(0, 200) }, { status: 422 });
  }
  if (toInsert.length === 0) {
    return NextResponse.json({ ok: true, inserted: 0, skipped, errors: [], destination: dest });
  }

  const { error } = await supabase.from(isAr ? 'invoices' : 'bills').insert(toInsert);
  if (error) return NextResponse.json({ ok: false, inserted: 0, skipped, errors: [{ row: 0, message: error.message }] }, { status: 500 });

  return NextResponse.json({ ok: true, inserted: toInsert.length, skipped, errors: [], destination: dest });
}

// =============================================================
// TRIAL BALANCE (Books): one balanced opening-balance entry
// =============================================================
async function importTrialBalance(
  supabase: SupabaseClient,
  fields: ImportFieldDef[],
  body: ImportRequest,
  orgId: string,
  location: { id: string; short_code: string },
  errors: RowError[],
  dryRun: boolean
) {
  const asOf = body.asOfDate;
  if (!asOf) return NextResponse.json({ error: 'Select an as-of date for the trial balance' }, { status: 400 });

  const accountMap = await buildAccountMap(supabase, orgId);
  const lines: { account_id: string; debit_cents: number; credit_cents: number }[] = [];
  let totalDebit = 0;
  let totalCredit = 0;

  body.rows.forEach((raw, i) => {
    const rowNum = i + 2;
    const rec = buildRecord(raw, fields, body.mapping, rowNum, errors);
    if (!rec) return;
    const acctNum = String(rec.account_number ?? '');
    const acctId = accountMap.get(acctNum);
    if (!acctId) { errors.push({ row: rowNum, message: `Account "${acctNum}" not found in the chart of accounts` }); return; }
    const debit = Number(rec.debit_cents ?? 0);
    const credit = Number(rec.credit_cents ?? 0);
    if (debit < 0 || credit < 0) { errors.push({ row: rowNum, message: 'Amounts cannot be negative' }); return; }
    if (debit > 0 && credit > 0) { errors.push({ row: rowNum, message: 'A line cannot have both a debit and a credit' }); return; }
    if (debit === 0 && credit === 0) return; // skip zero lines
    lines.push({ account_id: acctId, debit_cents: debit, credit_cents: credit });
    totalDebit += debit;
    totalCredit += credit;
  });

  if (totalDebit !== totalCredit) {
    errors.push({ row: 0, message: `Trial balance is out of balance: debits ${(totalDebit / 100).toFixed(2)} vs credits ${(totalCredit / 100).toFixed(2)}` });
  }

  const dest = 'public.gl_entries (opening balance)';
  if (dryRun || errors.length > 0) {
    return NextResponse.json({
      ok: errors.length === 0,
      dryRun: dryRun || undefined,
      willInsert: errors.length === 0 ? lines.length : 0,
      skipped: 0,
      errors: errors.slice(0, 200),
      destination: dest,
      balanced: totalDebit === totalCredit,
    }, { status: errors.length > 0 && !dryRun ? 422 : 200 });
  }
  if (lines.length === 0) {
    return NextResponse.json({ ok: true, inserted: 0, skipped: 0, errors: [], destination: dest });
  }

  const fiscalPeriodId = await resolveFiscalPeriod(supabase, orgId, location.id, asOf);
  if (!fiscalPeriodId) {
    return NextResponse.json({ ok: false, inserted: 0, skipped: 0, errors: [{ row: 0, message: `No fiscal period exists for ${asOf} on this company` }] }, { status: 422 });
  }

  const entryNumber = `OB-${location.short_code}-${asOf.replace(/-/g, '')}`;
  const { data: entry, error: entryErr } = await supabase.from('gl_entries').insert({
    org_id: orgId,
    location_id: location.id,
    entry_number: entryNumber,
    entry_date: asOf,
    entry_type: 'STANDARD',
    fiscal_period_id: fiscalPeriodId,
    memo: 'Opening balance (imported)',
    source_module: 'OPENING_BALANCE',
    status: 'POSTED',
    posted_at: new Date().toISOString(),
    created_by: null,
  }).select('id').single();

  if (entryErr || !entry) {
    return NextResponse.json({ ok: false, inserted: 0, skipped: 0, errors: [{ row: 0, message: entryErr?.message ?? 'Failed to create entry' }] }, { status: 500 });
  }

  const lineRows = lines.map((l, idx) => ({
    org_id: orgId,
    gl_entry_id: entry.id,
    line_number: idx + 1,
    account_id: l.account_id,
    debit_cents: l.debit_cents,
    credit_cents: l.credit_cents,
    location_id: location.id,
    memo: 'Opening balance',
  }));

  const { error: lineErr } = await supabase.from('gl_entry_lines').insert(lineRows);
  if (lineErr) {
    await supabase.from('gl_entries').delete().eq('id', entry.id); // roll back the header
    return NextResponse.json({ ok: false, inserted: 0, skipped: 0, errors: [{ row: 0, message: lineErr.message }] }, { status: 500 });
  }

  return NextResponse.json({ ok: true, inserted: 1, lines: lineRows.length, skipped: 0, errors: [], destination: dest, entryNumber });
}

// =============================================================
// GL HISTORY (Books): grouped balanced entries
// =============================================================
async function importGlHistory(
  supabase: SupabaseClient,
  fields: ImportFieldDef[],
  body: ImportRequest,
  orgId: string,
  location: { id: string; short_code: string },
  errors: RowError[],
  dryRun: boolean
) {
  const accountMap = await buildAccountMap(supabase, orgId);

  interface Grp { ref: string; date: string; memo: string | null; lines: { account_id: string; debit_cents: number; credit_cents: number }[]; debit: number; credit: number }
  const groups = new Map<string, Grp>();

  body.rows.forEach((raw, i) => {
    const rowNum = i + 2;
    const rec = buildRecord(raw, fields, body.mapping, rowNum, errors);
    if (!rec) return;
    const ref = String(rec.entry_ref ?? '');
    const acctNum = String(rec.account_number ?? '');
    const acctId = accountMap.get(acctNum);
    if (!acctId) { errors.push({ row: rowNum, message: `Account "${acctNum}" not found` }); return; }
    const debit = Number(rec.debit_cents ?? 0);
    const credit = Number(rec.credit_cents ?? 0);
    if (debit > 0 && credit > 0) { errors.push({ row: rowNum, message: 'A line cannot have both a debit and a credit' }); return; }
    if (debit === 0 && credit === 0) return;

    let g = groups.get(ref);
    if (!g) { g = { ref, date: String(rec.entry_date), memo: (rec.memo as string) ?? null, lines: [], debit: 0, credit: 0 }; groups.set(ref, g); }
    g.lines.push({ account_id: acctId, debit_cents: debit, credit_cents: credit });
    g.debit += debit; g.credit += credit;
  });

  // Validate balance per group.
  for (const g of groups.values()) {
    if (g.debit !== g.credit) {
      errors.push({ row: 0, message: `Entry "${g.ref}" is out of balance: ${(g.debit / 100).toFixed(2)} vs ${(g.credit / 100).toFixed(2)}` });
    }
  }

  const dest = 'public.gl_entries';
  if (dryRun || errors.length > 0) {
    return NextResponse.json({
      ok: errors.length === 0,
      dryRun: dryRun || undefined,
      willInsert: errors.length === 0 ? groups.size : 0,
      lines: [...groups.values()].reduce((n, g) => n + g.lines.length, 0),
      skipped: 0,
      errors: errors.slice(0, 200),
      destination: dest,
    }, { status: errors.length > 0 && !dryRun ? 422 : 200 });
  }
  if (groups.size === 0) {
    return NextResponse.json({ ok: true, inserted: 0, skipped: 0, errors: [], destination: dest });
  }

  let inserted = 0;
  const failures: RowError[] = [];
  for (const g of groups.values()) {
    const fiscalPeriodId = await resolveFiscalPeriod(supabase, orgId, location.id, g.date);
    if (!fiscalPeriodId) { failures.push({ row: 0, message: `No fiscal period for ${g.date} (entry ${g.ref})` }); continue; }

    const { data: entry, error: entryErr } = await supabase.from('gl_entries').insert({
      org_id: orgId,
      location_id: location.id,
      entry_number: `IMP-${g.ref}`,
      entry_date: g.date,
      entry_type: 'STANDARD',
      fiscal_period_id: fiscalPeriodId,
      memo: g.memo ?? `Imported entry ${g.ref}`,
      source_module: 'GL_HISTORY',
      status: 'POSTED',
      posted_at: new Date().toISOString(),
      created_by: null,
    }).select('id').single();

    if (entryErr || !entry) { failures.push({ row: 0, message: `Entry ${g.ref}: ${entryErr?.message ?? 'insert failed'}` }); continue; }

    const lineRows = g.lines.map((l, idx) => ({
      org_id: orgId, gl_entry_id: entry.id, line_number: idx + 1,
      account_id: l.account_id, debit_cents: l.debit_cents, credit_cents: l.credit_cents,
      location_id: location.id,
    }));
    const { error: lineErr } = await supabase.from('gl_entry_lines').insert(lineRows);
    if (lineErr) {
      await supabase.from('gl_entries').delete().eq('id', entry.id);
      failures.push({ row: 0, message: `Entry ${g.ref}: ${lineErr.message}` });
      continue;
    }
    inserted++;
  }

  return NextResponse.json({
    ok: failures.length === 0,
    inserted,
    skipped: 0,
    errors: failures.slice(0, 200),
    destination: dest,
  }, { status: failures.length > 0 ? 207 : 200 });
}

// ── shared helpers ──────────────────────────────────────────────────────
async function buildAccountMap(supabase: SupabaseClient, orgId: string) {
  const { data } = await supabase.from('accounts').select('id, account_number').eq('org_id', orgId);
  return new Map((data ?? []).map((a) => [String((a as { account_number: string }).account_number), (a as { id: string }).id]));
}

async function resolveFiscalPeriod(
  supabase: SupabaseClient,
  orgId: string,
  locationId: string,
  isoDate: string
): Promise<string | null> {
  const [y, m] = isoDate.split('-').map(Number);
  const { data } = await supabase
    .from('fiscal_periods')
    .select('id')
    .eq('org_id', orgId)
    .eq('location_id', locationId)
    .eq('period_year', y)
    .eq('period_month', m)
    .limit(1)
    .single();
  return (data as { id: string } | null)?.id ?? null;
}
