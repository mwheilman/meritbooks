export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAuthedContext } from '@/lib/api-handler';
import { parseCsv } from '@/lib/import/csv';
import { readXlsx } from '@/lib/payroll/xlsx-read';
import { resolveUploadedFile, SPREADSHEET_TYPES } from '@/lib/uploads/resolve-upload';
import { isOrgIntakePath } from '@/lib/uploads/paths';
import {
  parseBudgetGrid,
  foldToPeriods,
  gridToParsedCsv,
  type BudgetLayout,
} from '@/lib/budgets/import';

/**
 * POST /api/budgets/import — DETERMINISTIC (no-AI) budget file loader.
 *
 * Accepts a budget as CSV / XLSX — multipart `file`, OR JSON `{ storagePath, … }` for
 * a file already uploaded once via uploadForParse (the Smart Intake handoff: the user
 * never re-uploads) — plus the target company (`companyId` = location id),
 * `fiscalYear`, and optional `departmentId` / `layout` / `dryRun`.
 * The file is parsed in-request (never persisted): CSV via the shared RFC-4180
 * parser, XLSX via the dependency-free byte reader. Columns are auto-mapped to an
 * account + monthly/annual amounts, accounts are matched to the org's chart of
 * accounts by number (then name), and the amounts are folded to the twelve monthly
 * budget cells the Budget Entry grid reads.
 *
 * `dryRun=true` returns a full preview (matched/unmatched accounts, footing, errors)
 * and writes NOTHING. Otherwise the cells are UPSERTED into `public.budgets` with the
 * exact same row shape and conflict target the app's own POST /api/budgets uses
 * (`org_id,location_id,account_id,department_id,fiscal_year,period_number`), so a
 * re-import overwrites rather than duplicates.
 *
 * Fail-closed: 400 with no org on the session; org-scoped on every query.
 */

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 20_000;

function isXlsx(name: string, type: string): boolean {
  return (
    type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    type === 'application/vnd.ms-excel' ||
    /\.xlsx$/i.test(name)
  );
}

interface AccountRow { id: string; account_number: string; name: string }

/** Resolve an account identifier (number first, then case-insensitive name). */
function makeAccountResolver(accounts: AccountRow[]): (ref: string) => AccountRow | null {
  const byNumber = new Map<string, AccountRow>();
  const byName = new Map<string, AccountRow>();
  for (const a of accounts) {
    byNumber.set(String(a.account_number).trim().toLowerCase(), a);
    byName.set(String(a.name).trim().toLowerCase(), a);
  }
  return (ref: string) => {
    const key = ref.trim().toLowerCase();
    return byNumber.get(key) ?? byName.get(key) ?? null;
  };
}

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization on session', code: 'NO_ORG' }, { status: 400 });

  // ── Read the payload: JSON { storagePath, … } (intake handoff) or multipart ──
  let fileName: string;
  let buffer: Buffer;
  const isJson = (request.headers.get('content-type') ?? '').includes('application/json');
  let fields: { companyId: unknown; fiscalYear: unknown; departmentId: unknown; layout: unknown; dryRun: unknown };
  if (isJson) {
    let body: Record<string, unknown>;
    try {
      body = (await request.clone().json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: 'Invalid request body', code: 'BAD_BODY' }, { status: 400 });
    }
    const storagePath = typeof body.storagePath === 'string' ? body.storagePath : '';
    if (!isOrgIntakePath(storagePath, orgId)) {
      return NextResponse.json({ error: 'Invalid file path', code: 'BAD_PATH' }, { status: 403 });
    }
    const resolved = await resolveUploadedFile(request, orgId, { allowedTypes: SPREADSHEET_TYPES });
    if (resolved instanceof NextResponse) return resolved;
    if (resolved.sizeBytes > MAX_BYTES) {
      return NextResponse.json({ error: 'File too large. Maximum 10MB.', code: 'FILE_TOO_LARGE' }, { status: 400 });
    }
    fileName = resolved.fileName.replace(/^[0-9a-f-]{36}-/i, '') || 'budget';
    buffer = Buffer.from(resolved.base64Data, 'base64');
    fields = {
      companyId: body.companyId,
      fiscalYear: body.fiscalYear,
      departmentId: body.departmentId,
      layout: body.layout,
      dryRun: body.dryRun === true ? 'true' : body.dryRun,
    };
  } else {
    try {
      const form = await request.formData();
      const file = form.get('file');
      if (!(file instanceof File)) {
        return NextResponse.json({ error: 'No file provided', code: 'NO_FILE' }, { status: 400 });
      }
      if (file.size > MAX_BYTES) {
        return NextResponse.json({ error: 'File too large. Maximum 10MB.', code: 'FILE_TOO_LARGE' }, { status: 400 });
      }
      fileName = file.name || 'budget';
      buffer = Buffer.from(await file.arrayBuffer());
      fields = {
        companyId: form.get('companyId'),
        fiscalYear: form.get('fiscalYear'),
        departmentId: form.get('departmentId'),
        layout: form.get('layout'),
        dryRun: form.get('dryRun'),
      };
    } catch {
      return NextResponse.json({ error: 'Failed to read the uploaded file', code: 'UPLOAD_ERROR' }, { status: 400 });
    }
  }

  const companyId = String(fields.companyId ?? '').trim();
  if (!companyId) return NextResponse.json({ error: 'Select a company for this budget import', code: 'NO_COMPANY' }, { status: 400 });

  const fiscalYear = parseInt(String(fields.fiscalYear ?? ''), 10);
  if (!Number.isInteger(fiscalYear) || fiscalYear < 2020 || fiscalYear > 2040) {
    return NextResponse.json({ error: 'A valid fiscal year (2020–2040) is required', code: 'BAD_FISCAL_YEAR' }, { status: 400 });
  }

  const deptRaw = String(fields.departmentId ?? '').trim();
  const departmentId: string | null = deptRaw === '' || deptRaw === 'null' ? null : deptRaw;

  const layoutRaw = String(fields.layout ?? '').trim();
  const forcedLayout: BudgetLayout | undefined = layoutRaw === 'monthly' || layoutRaw === 'annual' ? layoutRaw : undefined;

  const dryRun = String(fields.dryRun ?? '') === 'true';

  // ── Parse the file into a grid ──────────────────────────────────────────
  let parsed;
  if (isXlsx(fileName, '')) {
    const grid = readXlsx(buffer);
    if (grid.headers.length === 0) {
      return NextResponse.json({ error: 'Could not read this spreadsheet. Re-save it as .xlsx or export a CSV and try again.', code: 'XLSX_UNREADABLE' }, { status: 422 });
    }
    parsed = gridToParsedCsv(grid);
  } else {
    parsed = parseCsv(buffer.toString('utf8'));
    if (parsed.headers.length === 0) {
      return NextResponse.json({ error: 'The file has no header row. The first row should name the columns.', code: 'NO_HEADERS' }, { status: 422 });
    }
  }
  if (parsed.rows.length === 0) {
    return NextResponse.json({ error: 'No data rows found below the header.', code: 'NO_ROWS' }, { status: 422 });
  }
  if (parsed.rows.length > MAX_ROWS) {
    return NextResponse.json({ error: `Import is limited to ${MAX_ROWS.toLocaleString()} rows per file`, code: 'TOO_MANY_ROWS' }, { status: 400 });
  }

  const result = parseBudgetGrid(parsed, { layout: forcedLayout });
  const errors = [...result.errors];

  // ── Verify the company belongs to the org ───────────────────────────────
  const { data: loc } = await supabase
    .schema('core').from('locations')
    .select('id, short_code, name')
    .eq('id', companyId)
    .eq('org_id', orgId)
    .single();
  if (!loc) return NextResponse.json({ error: 'Selected company not found', code: 'COMPANY_NOT_FOUND' }, { status: 400 });

  if (departmentId) {
    const { data: dept } = await supabase
      .schema('core').from('departments')
      .select('id')
      .eq('id', departmentId)
      .eq('org_id', orgId)
      .single();
    if (!dept) return NextResponse.json({ error: 'Selected department not found', code: 'DEPT_NOT_FOUND' }, { status: 400 });
  }

  // ── Resolve accounts (org-scoped) ───────────────────────────────────────
  const { data: accountsData, error: acctErr } = await supabase
    .from('accounts')
    .select('id, account_number, name')
    .eq('org_id', orgId);
  if (acctErr) return NextResponse.json({ error: acctErr.message }, { status: 500 });
  const resolve = makeAccountResolver((accountsData ?? []) as AccountRow[]);

  // ── Fold to monthly cells + match accounts ──────────────────────────────
  const periodsByRef = foldToPeriods(result.rows);
  interface Matched { accountId: string; accountNumber: string; accountName: string; periods: Record<number, number>; annualCents: number }
  const matched: Matched[] = [];
  const unmatched: string[] = [];

  for (const ref of result.accountRefs) {
    const periods = periodsByRef.get(ref);
    if (!periods) continue; // account row carried no amounts
    const acct = resolve(ref);
    if (!acct) { unmatched.push(ref); continue; }
    const annualCents = Object.values(periods).reduce((s, c) => s + c, 0);
    matched.push({ accountId: acct.id, accountNumber: acct.account_number, accountName: acct.name, periods, annualCents });
  }

  const cellsToWrite = matched.reduce((n, m) => n + Object.keys(m.periods).length, 0);
  const matchedTotalCents = matched.reduce((s, m) => s + m.annualCents, 0);

  const preview = {
    layout: result.layout,
    fileName,
    company: { id: loc.id as string, shortCode: loc.short_code as string, name: loc.name as string },
    fiscalYear,
    departmentId,
    columns: result.mapping,
    parsedTotalCents: result.totalCents,
    matchedTotalCents,
    rowCount: result.rowCount,
    accountCount: result.accountRefs.length,
    matched: matched.map((m) => ({ accountNumber: m.accountNumber, accountName: m.accountName, annualCents: m.annualCents })),
    unmatched,
    cellsToWrite,
    errors: errors.slice(0, 200),
  };

  // ── Dry run: preview only, write nothing ────────────────────────────────
  if (dryRun) {
    return NextResponse.json({ ok: errors.length === 0, dryRun: true, ...preview });
  }

  // Hard errors (e.g. non-numeric cells) block the write so nothing partial lands.
  if (errors.length > 0) {
    return NextResponse.json({ ok: false, saved: 0, ...preview }, { status: 422 });
  }
  if (matched.length === 0) {
    return NextResponse.json({ ok: false, saved: 0, error: 'No account in the file matched this company’s chart of accounts', ...preview }, { status: 422 });
  }

  // ── Upsert — identical row shape + conflict target to POST /api/budgets ──
  const inserts: Record<string, string | number | null>[] = [];
  for (const m of matched) {
    for (const [periodStr, cents] of Object.entries(m.periods)) {
      inserts.push({
        org_id: orgId,
        location_id: companyId,
        account_id: m.accountId,
        department_id: departmentId,
        fiscal_year: fiscalYear,
        period_number: Number(periodStr),
        amount_cents: cents,
        created_by: userId,
      });
    }
  }

  const { error: upsertErr } = await supabase
    .from('budgets')
    .upsert(inserts, { onConflict: 'org_id,location_id,account_id,department_id,fiscal_year,period_number' });
  if (upsertErr) return NextResponse.json({ ok: false, saved: 0, error: upsertErr.message, ...preview }, { status: 500 });

  return NextResponse.json({
    ok: true,
    saved: inserts.length,
    accountsSaved: matched.length,
    unmatched,
    layout: result.layout,
    fiscalYear,
    matchedTotalCents,
  }, { status: 201 });
}
