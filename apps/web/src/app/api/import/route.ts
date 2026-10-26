export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAuthedContext } from '@/lib/api-handler';
import { getImportType, type ImportFieldDef } from '@/lib/import/definitions';
import { coerceValue } from '@/lib/import/csv';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { createCompany } from '@/lib/companies/create-company';
import { seedChartOfAccounts } from '@/lib/services/coa-seed';
import { addressText, exactMatchOrNull, type PartyMatch } from '@/lib/parties/match';

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
  /** Customers / vendors: import rows even when they are "Already in Merit" (exact match). */
  createAnyway?: boolean;
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

    // Authorization (security HIGH): a dry-run preview only reads, so it needs
    // import:view; a COMMIT writes master data / sub-ledgers / the GL, so it needs
    // import:run. Ledger imports (trial balance, GL history) write POSTED journal
    // entries straight to the book of record, so they additionally require the
    // same journal_entries:post grant as manual JE posting — import must not be a
    // side door around the posting permission.
    const importGuard = await requirePermission(ctx.userId, 'import', dryRun ? 'view' : 'run');
    if (!importGuard.ok) return importGuard.response;
    if (!dryRun && (def.key === 'trial_balance' || def.key === 'gl_history')) {
      const postGuard = await requirePermission(ctx.userId, 'journal_entries', 'post');
      if (!postGuard.ok) return postGuard.response;
    }

    // ── MASTER DATA → CORE ───────────────────────────────────────────────
    if (def.target === 'core') {
      // Creating companies mutates accounting configuration — same gate as
      // Settings → Entities (POST /api/settings/entities).
      if (def.key === 'entities') {
        const guard = await requirePermission(ctx.userId, 'settings_acct', 'edit');
        if (!guard.ok) return guard.response;
      }
      // Customers are written with the service role (core.customers is not member-
      // writable — migration 167, M4), so the customer-create grant is checked here.
      if (def.key === 'customers' && !dryRun) {
        const guard = await requirePermission(ctx.userId, 'customers', 'create');
        if (!guard.ok) return guard.response;
      }
      // Same for vendors (core.vendors is not member-writable — migration 168).
      if (def.key === 'vendors' && !dryRun) {
        const guard = await requirePermission(ctx.userId, 'vendors', 'create');
        if (!guard.ok) return guard.response;
      }
      return await importMasterData(supabase, def.key, def.fields, body, orgId, errors, dryRun);
    }

    // ── LEDGER → BOOKS ───────────────────────────────────────────────────
    if (def.key === 'open_ar' || def.key === 'open_ap') {
      // public.bills is SELECT-only for members (migration 171): the open-AP commit writes
      // it with the service role, so the bill-create grant is checked here.
      if (def.key === 'open_ap' && !dryRun) {
        const guard = await requirePermission(ctx.userId, 'bills', 'create');
        if (!guard.ok) return guard.response;
      }
      // Same for invoices (moved to the service role with the migration-172 sweep).
      if (def.key === 'open_ar' && !dryRun) {
        const guard = await requirePermission(ctx.userId, 'invoices', 'create');
        if (!guard.ok) return guard.response;
      }
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

  // "Already in Merit" (Projects 1111 matcher, suite-level): rows that EXACTLY match an existing
  // customer / vendor (same tax id / email / phone, or name + address) are shown in the preview and
  // skipped on import unless the person chose createAnyway — so a CSV never re-creates a client
  // someone already entered in Books or Projects. Checked for the first 200 rows (the matcher is
  // per row); the insert safety net files any later strong match for review.
  const alreadyInMerit: Array<{ row: number; name: string; match: PartyMatch }> = [];
  if ((key === 'customers' || key === 'vendors') && toInsert.length > 0) {
    const checkable = toInsert.slice(0, 200);
    const keep: Record<string, Cell>[] = [];
    for (let i = 0; i < toInsert.length; i++) {
      const r = toInsert[i];
      if (i < checkable.length) {
        const m = await exactMatchOrNull(supabase, {
          kind: key === 'vendors' ? 'vendor' : 'customer', name: String(r.name ?? ''),
          email: (r.email as string | null) ?? null, phone: (r.phone as string | null) ?? null,
          address: addressText({ address_line1: r.address_line1 as string | null, city: r.city as string | null, state: r.state as string | null, zip: r.zip as string | null }),
        });
        if (m) {
          alreadyInMerit.push({ row: i + 2, name: String(r.name ?? ''), match: m });
          if (!body.createAnyway) continue;
        }
      }
      keep.push(r);
    }
    if (!body.createAnyway) {
      skipped += toInsert.length - keep.length;
      toInsert.splice(0, toInsert.length, ...keep);
    }
  }

  if (dryRun) {
    return NextResponse.json({
      ok: errors.length === 0, dryRun: true, willInsert: toInsert.length, skipped, errors: errors.slice(0, 200), destination: `core.${table}`,
      alreadyInMerit: alreadyInMerit.map((a) => ({ row: a.row, name: a.name, existing: { id: a.match.id, name: a.match.name, usage: a.match.usage, matched: a.match.matched } })),
    });
  }
  if (errors.length > 0) {
    return NextResponse.json({ ok: false, inserted: 0, skipped, errors: errors.slice(0, 200) }, { status: 422 });
  }
  if (toInsert.length === 0) {
    return NextResponse.json({ ok: true, inserted: 0, skipped, errors: [], destination: `core.${table}`, alreadyInMerit: alreadyInMerit.length });
  }

  // Companies go through the single company-creation path so each one is born
  // with its fiscal periods (a bare locations insert left imported companies with
  // NO periods, so every later post to them failed). One at a time — a failure is
  // reported per company and never strands the rest.
  if (key === 'entities') {
    return await importCompanies(supabase, toInsert, orgId, skipped);
  }

  // core.customers (migration 167, M4), core.vendors (168) and core.items (171) are
  // service-role-write only (the remaining master-data target, locations, returned
  // above through createCompany): authorized above (import:run + customers:create /
  // vendors:create) and every row carries org_id = the session org.
  const writer = createAdminSupabase();
  const { error } = await writer.schema('core').from(table).insert(toInsert.map((r) => ({ ...r, org_id: orgId })));
  if (error) return NextResponse.json({ ok: false, inserted: 0, skipped, errors: [{ row: 0, message: error.message }] }, { status: 500 });

  return NextResponse.json({ ok: true, inserted: toInsert.length, skipped, errors: [], destination: `core.${table}`, alreadyInMerit: alreadyInMerit.length });
}

/** Create imported companies via createCompany (location + fiscal periods), then seed the org COA once. */
async function importCompanies(
  supabase: SupabaseClient,
  rows: Record<string, Cell>[],
  orgId: string,
  skippedSoFar: number
) {
  let inserted = 0;
  let skipped = skippedSoFar;
  const failures: RowError[] = [];
  for (const r of rows) {
    const res = await createCompany(supabase, {
      orgId,
      name: String(r.name ?? ''),
      shortCode: r.short_code != null ? String(r.short_code) : null,
      industry: r.industry != null ? String(r.industry) : null,
      fiscalYearStartMonth: Number(r.fiscal_year_start_month ?? 1),
    }, { writer: createAdminSupabase() }); // core.locations: service role after settings_acct:edit (mig 167)
    if (res.ok) inserted++;
    else if (res.status === 409) skipped++; // already exists (same name or code) — dedupe, as before
    else failures.push({ row: 0, message: `${String(r.name ?? '')}: ${res.error}` });
  }
  if (inserted > 0) {
    try {
      await seedChartOfAccounts(supabase, orgId); // org-scoped + idempotent
    } catch (e) {
      console.error('[import] COA seed error:', e instanceof Error ? e.message : e);
    }
  }
  const ok = failures.length === 0;
  return NextResponse.json(
    { ok, inserted, skipped, errors: failures.slice(0, 200), destination: 'core.locations' },
    { status: ok ? 200 : inserted > 0 ? 207 : 500 }
  );
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

  // public.bills is SELECT-only for members (migration 171) and public.invoices moves to the
  // service role with the 172 sweep: the import writes both with the service role
  // (import:run + bills:create / invoices:create checked; the company was read through the
  // caller's RLS client, so org + client scope are verified; every row carries the session
  // org_id / location_id, and counterparties were resolved from this org's own rows).
  const { error } = isAr
    ? await createAdminSupabase().from('invoices').insert(toInsert)
    : await createAdminSupabase().from('bills').insert(toInsert);
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
  let zeroSkipped = 0;

  body.rows.forEach((raw, i) => {
    const rowNum = i + 2;
    const rec = buildRecord(raw, fields, body.mapping, rowNum, errors);
    if (!rec) return;
    const acctNum = String(rec.account_number ?? '');
    const acctId = accountMap.get(acctNum);
    if (!acctId) { errors.push({ row: rowNum, message: `Account "${acctNum}" not found in the chart of accounts` }); return; }
    const { debit, credit, error: normErr } = normalizeDrCr(Number(rec.debit_cents ?? 0), Number(rec.credit_cents ?? 0), acctNum);
    if (normErr) { errors.push({ row: rowNum, message: normErr }); return; }
    if (debit === 0 && credit === 0) { zeroSkipped++; return; } // skip zero lines (noted, not silent)
    lines.push({ account_id: acctId, debit_cents: debit, credit_cents: credit });
    totalDebit += debit;
    totalCredit += credit;
  });

  if (totalDebit !== totalCredit) {
    errors.push({ row: 0, message: `Trial balance is out of balance: debits ${(totalDebit / 100).toFixed(2)} vs credits ${(totalCredit / 100).toFixed(2)}` });
  }

  // Period lock (canon Rule F): OPEN / SOFT_CLOSE accept postings, HARD_CLOSE
  // refuses. Checked before the dry-run return so the preview surfaces it too.
  const period = await resolveFiscalPeriod(supabase, orgId, location.id, asOf);
  if (period?.status === 'HARD_CLOSE') {
    errors.push({ row: 0, message: hardClosedMessage(asOf) });
  }

  const dest = 'public.gl_entries (opening balance)';
  if (dryRun || errors.length > 0) {
    return NextResponse.json({
      ok: errors.length === 0,
      dryRun: dryRun || undefined,
      willInsert: errors.length === 0 ? lines.length : 0,
      skipped: zeroSkipped,
      errors: errors.slice(0, 200),
      destination: dest,
      balanced: totalDebit === totalCredit,
    }, { status: errors.length > 0 && !dryRun ? 422 : 200 });
  }
  if (lines.length === 0) {
    return NextResponse.json({ ok: true, inserted: 0, skipped: 0, errors: [], destination: dest });
  }

  if (!period) {
    return NextResponse.json({ ok: false, inserted: 0, skipped: 0, errors: [{ row: 0, message: `No fiscal period exists for ${asOf} on this company` }] }, { status: 422 });
  }
  const fiscalPeriodId = period.id;

  const entryNumber = `OB-${location.short_code}-${asOf.replace(/-/g, '')}`;
  // gl_entries / gl_entry_lines are SELECT-only for members (migration 171): service role,
  // after import:run + journal_entries:post; company verified through the caller's client.
  const glWriter = createAdminSupabase();
  const { data: entry, error: entryErr } = await glWriter.from('gl_entries').insert({
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
    // The DB period lock (migration 152) is the backstop if the period was
    // hard-closed between the check above and this insert.
    const closed = /hard-closed/i.test(entryErr?.message ?? '');
    return NextResponse.json({ ok: false, inserted: 0, skipped: 0, errors: [{ row: 0, message: closed ? hardClosedMessage(asOf) : (entryErr?.message ?? 'Failed to create entry') }] }, { status: closed ? 422 : 500 });
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

  const { error: lineErr } = await glWriter.from('gl_entry_lines').insert(lineRows);
  if (lineErr) {
    await glWriter.from('gl_entries').delete().eq('id', entry.id).eq('org_id', orgId); // roll back the header
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
    const { debit, credit, error: normErr } = normalizeDrCr(Number(rec.debit_cents ?? 0), Number(rec.credit_cents ?? 0), acctNum);
    if (normErr) { errors.push({ row: rowNum, message: normErr }); return; }
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

  // Period lock (canon Rule F): resolve each entry's period once (cached per
  // month) and refuse the whole import if any entry lands in a HARD_CLOSE
  // period — all-or-nothing, surfaced in the dry-run preview too.
  const periodByMonth = new Map<string, FiscalPeriodRef | null>();
  const periodOf = async (isoDate: string): Promise<FiscalPeriodRef | null> => {
    const key = isoDate.slice(0, 7);
    if (!periodByMonth.has(key)) periodByMonth.set(key, await resolveFiscalPeriod(supabase, orgId, location.id, isoDate));
    return periodByMonth.get(key) ?? null;
  };
  for (const g of groups.values()) {
    const p = await periodOf(g.date);
    if (p?.status === 'HARD_CLOSE') {
      errors.push({ row: 0, message: `Entry "${g.ref}": ${hardClosedMessage(g.date)}` });
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
  // gl_entries / gl_entry_lines are SELECT-only for members (migration 171).
  const glWriter = createAdminSupabase();
  for (const g of groups.values()) {
    const period = await periodOf(g.date);
    if (!period) { failures.push({ row: 0, message: `No fiscal period for ${g.date} (entry ${g.ref})` }); continue; }
    const fiscalPeriodId = period.id;

    const { data: entry, error: entryErr } = await glWriter.from('gl_entries').insert({
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
    const { error: lineErr } = await glWriter.from('gl_entry_lines').insert(lineRows);
    if (lineErr) {
      await glWriter.from('gl_entries').delete().eq('id', entry.id).eq('org_id', orgId);
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

/**
 * Normalize a debit/credit pair for a ledger line, tolerating the SIGNED-amount
 * convention common in QuickBooks / Sage / Xero exports (a credit shown as a
 * negative debit, or vice versa). A negative in one column folds into the other as
 * a positive. A row still carrying BOTH a positive debit and a positive credit is a
 * subtotal/total row and is rejected with a clear message (no silent corruption).
 */
function normalizeDrCr(
  rawDebit: number,
  rawCredit: number,
  acctNum: string,
): { debit: number; credit: number; error?: string } {
  let debit = rawDebit;
  let credit = rawCredit;
  if (debit < 0) { credit += -debit; debit = 0; }
  if (credit < 0) { debit += -credit; credit = 0; }
  if (debit > 0 && credit > 0) {
    return { debit: 0, credit: 0, error: `Account "${acctNum}" has both a debit and a credit — a line must be one or the other (this looks like a subtotal/total row).` };
  }
  return { debit, credit };
}

async function buildAccountMap(supabase: SupabaseClient, orgId: string) {
  const { data } = await supabase.from('accounts').select('id, account_number').eq('org_id', orgId);
  return new Map((data ?? []).map((a) => [String((a as { account_number: string }).account_number), (a as { id: string }).id]));
}

interface FiscalPeriodRef { id: string; status: 'OPEN' | 'SOFT_CLOSE' | 'HARD_CLOSE' }

/** User-facing refusal for an import dated into a hard-closed period. */
function hardClosedMessage(isoDate: string): string {
  return `The fiscal period for ${isoDate} is hard-closed, so nothing can be posted to it. Reopen the period (with a reason) to import into it, then close it again.`;
}

async function resolveFiscalPeriod(
  supabase: SupabaseClient,
  orgId: string,
  locationId: string,
  isoDate: string
): Promise<FiscalPeriodRef | null> {
  const [y, m] = isoDate.split('-').map(Number);
  const { data } = await supabase
    .from('fiscal_periods')
    .select('id, status')
    .eq('org_id', orgId)
    .eq('location_id', locationId)
    .eq('period_year', y)
    .eq('period_month', m)
    .limit(1)
    .single();
  return (data as FiscalPeriodRef | null) ?? null;
}
