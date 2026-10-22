export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/server';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { coerceValue } from '@/lib/import/csv';
import {
  CONVERSION_SOURCE_FIELDS,
  CONVERSION_FEATURE,
  CONVERSION_KIND,
  applyMapping,
  distinctSourceAccounts,
  type SourceLine,
  type ConversionSessionData,
} from '@/lib/onboarding/conversion';
import { proposeMapping } from '@/lib/onboarding/mapping-ai';
import { loadTargetAccounts, listSessions, buildSessionView } from '@/lib/onboarding/session';
import { isIsoDate } from '@/lib/onboarding/conversion';
import { requirePermission } from '@/lib/rbac/require-permission';
import { serviceWriter, assertWriteScope, isWriteScopeError } from '@/lib/db/scoped-writer';

/**
 * POST /api/onboarding/conversion — start a historical-books conversion.
 *
 * Body: { companyId, asOfDate, mapping: { fieldKey -> csvHeader }, rows: [...] }.
 * The uploaded rows are coerced to SourceLine here (balances = the uploaded
 * numbers, untouched). The AI proposes only the source-account -> COA mapping
 * (feature CONVERSION_MAP); this route assembles the opening TB in code and stages
 * the session as an ai_decisions row.
 *
 * GET /api/onboarding/conversion — list this org's conversion sessions.
 */

interface CreateBody {
  companyId: string;
  asOfDate: string;
  mapping: Record<string, string>;
  rows: Record<string, string>[];
  /**
   * Optional original file row number for each entry in `rows` (spreadsheet imports
   * skip title rows, so "row i + 2" would point at the wrong line). Same length as rows.
   */
  rowNumbers?: number[];
  /** Optional original file name, shown back on the review screen. */
  fileName?: string;
}

const MAX_ROWS = 20000;

export async function POST(req: NextRequest) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  // Staging an opening entry is journal-entry preparation work (posting needs 'post').
  const guard = await requirePermission(userId, 'journal_entries', 'create');
  if (!guard.ok) return guard.response;

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.companyId) return NextResponse.json({ error: 'Choose which company these balances belong to.' }, { status: 400 });
  if (!isIsoDate(body.asOfDate)) return NextResponse.json({ error: 'Choose the date your balances are as of (for example, the last day of last month).' }, { status: 400 });
  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    return NextResponse.json({ error: 'Your file has no account rows to bring in.' }, { status: 400 });
  }
  if (body.rows.length > MAX_ROWS) {
    return NextResponse.json({ error: `That file has more than ${MAX_ROWS.toLocaleString()} rows — split it into smaller files.` }, { status: 400 });
  }
  const rowNumbers = Array.isArray(body.rowNumbers) && body.rowNumbers.length === body.rows.length ? body.rowNumbers : null;

  // Resolve the target company (location).
  const { data: loc } = await supabase
    .schema('core').from('locations')
    .select('id, short_code, name')
    .eq('id', body.companyId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (!loc) return NextResponse.json({ error: 'We couldn\'t find that company. Pick it again from the list.' }, { status: 400 });
  const company = loc as { id: string; short_code: string; name: string };

  // Coerce uploaded rows to SourceLine (balances come straight from the file).
  //
  // Messy-CSV robustness (no silent drops): blank lines are already dropped by the
  // parser. Here we additionally (a) support a single SIGNED balance column when the
  // file has no separate debit/credit columns, and (b) EXCLUDE — and report, never
  // silently — subtotal/total rows (a line carrying BOTH a debit and a credit is not a
  // real account balance) and rows with no account code. Zero-balance rows are noted.
  const sourceLines: SourceLine[] = [];
  const rowErrors: { row: number; message: string }[] = [];
  const excluded: { row: number; reason: string }[] = [];
  let zeroRows = 0;
  const hasAmountColumn = !!body.mapping?.amount_cents;

  body.rows.forEach((raw, i) => {
    const rowNum = rowNumbers ? Number(rowNumbers[i]) || i + 2 : i + 2;
    const rec: Record<string, string | number | boolean | null> = {};
    let ok = true;
    for (const field of CONVERSION_SOURCE_FIELDS) {
      const header = body.mapping?.[field.key];
      const cell = header ? (raw[header] ?? '') : '';
      const res = coerceValue(cell, field);
      if (!res.ok) { rowErrors.push({ row: rowNum, message: res.error ?? `${field.label} invalid` }); ok = false; continue; }
      rec[field.key] = res.value;
    }
    if (!ok) return;

    const account = String(rec.source_account ?? '').trim();
    if (!account) { excluded.push({ row: rowNum, reason: 'No account on this row — skipped (looks like a blank or section heading).' }); return; }

    let debit = Number(rec.debit_cents ?? 0);
    let credit = Number(rec.credit_cents ?? 0);
    const amount = Number(rec.amount_cents ?? 0);

    // Single signed-balance column → split by sign (positive = debit, negative = credit).
    if (hasAmountColumn && debit === 0 && credit === 0 && amount !== 0) {
      if (amount > 0) debit = amount; else credit = -amount;
    }

    // Tolerate the signed-amount convention (a credit shown as a negative debit, or
    // vice versa) that QuickBooks/Sage/Xero exports commonly use — fold it, never error.
    if (debit < 0) { credit += -debit; debit = 0; }
    if (credit < 0) { debit += -credit; credit = 0; }

    if (debit > 0 && credit > 0) {
      // A real trial-balance line is a debit XOR a credit; both filled ⇒ a totals row.
      excluded.push({ row: rowNum, reason: `Has both a debit and a credit (${account}) — skipped as a subtotal or total row.` });
      return;
    }
    if (debit === 0 && credit === 0) { zeroRows++; return; } // zero balance — nothing to post

    sourceLines.push({
      sourceAccount: account,
      sourceName: rec.source_name ? String(rec.source_name) : null,
      debitCents: debit,
      creditCents: credit,
    });
  });

  if (rowErrors.length > 0) {
    const first = rowErrors.slice(0, 3).map((e) => `row ${e.row}: ${e.message}`).join('; ');
    return NextResponse.json({ error: `Some rows couldn't be read (${first}${rowErrors.length > 3 ? `, and ${rowErrors.length - 3} more` : ''}).`, errors: rowErrors.slice(0, 200), excluded: excluded.slice(0, 200) }, { status: 422 });
  }
  if (sourceLines.length === 0) {
    return NextResponse.json({
      error: excluded.length > 0
        ? 'We couldn\'t find any account balances — every row looked like a total or a blank line. Check that the Debit and Credit (or Balance) columns are matched.'
        : 'Every account in your file has a zero balance, so there is nothing to bring in.',
      excluded: excluded.slice(0, 200),
    }, { status: 422 });
  }

  // Load COA targets and propose the mapping (AI never sees a balance).
  const targets = await loadTargetAccounts(supabase, orgId);
  if (targets.length === 0) {
    return NextResponse.json({ error: 'Your MeritBooks chart of accounts is empty. Set up your accounts first (Accounting → Chart of Accounts), then come back.' }, { status: 400 });
  }

  const sources = distinctSourceAccounts(sourceLines);
  const { mapping, aiUsed, aiError, correlationId } = await proposeMapping(createAdminSupabase(), {
    orgId,
    userId,
    apiKey: getAnthropicApiKey(),
    sourceAccounts: sources,
    targets,
  });

  const assembled = applyMapping(sourceLines, mapping, targets);

  const data: ConversionSessionData = {
    kind: CONVERSION_KIND,
    companyId: company.id,
    companyShortCode: company.short_code,
    asOfDate: body.asOfDate,
    sourceLines,
    mapping,
    openingBalances: assembled.openingBalances,
    balance: assembled.balance,
    balanceSheet: assembled.balanceSheet,
    unmapped: assembled.unmapped,
    unknownTargets: assembled.unknownTargets,
    sourceTotals: assembled.sourceTotals,
    plAcknowledged: false,
    intake: {
      fileName: typeof body.fileName === 'string' ? body.fileName.slice(0, 200) : null,
      aiUsed,
      aiError,
      excluded: excluded.slice(0, 200),
      excludedCount: excluded.length,
      zeroRows,
    },
    tiedOut: false,
    tiedOutBy: null,
    tiedOutAt: null,
  };

  // ai_decisions is SELECT-only for members (migration 172): service-role insert after the
  // permission check, org pinned, the company asserted in the caller's client scope.
  try {
    await assertWriteScope(supabase, orgId, [company.id]);
  } catch (e) {
    if (isWriteScopeError(e)) return NextResponse.json({ error: e.message }, { status: 403 });
    throw e;
  }
  const { data: inserted, error: insErr } = await serviceWriter()
    .from('ai_decisions')
    .insert({
      org_id: orgId,
      location_id: company.id,
      feature: CONVERSION_FEATURE,
      model_requested: aiUsed ? 'claude-sonnet-4-6' : null,
      correlation_id: correlationId,
      input_summary: `Historical conversion — ${company.name} (${company.short_code}) opening balances as of ${body.asOfDate}: ${sources.length} source accounts, ${sourceLines.length} rows`.slice(0, 2000),
      proposed_output: data,
      reasoning: 'AI proposes source→COA mapping only; every balance is aggregated in code from the uploaded numbers. Opening entry is blocked until a human ties out the trial balance.',
      status: 'PROPOSED',
      created_by_user: userId,
    })
    .select('id')
    .single();

  if (insErr || !inserted) {
    return NextResponse.json({ error: `We couldn't save your upload: ${insErr?.message ?? 'unknown error'}. Please try again.` }, { status: 500 });
  }

  // Return the SAME view the review screen loads via GET — including every go-live
  // blocker (FPB B8) — so the first render is never more optimistic than the gate.
  const id = (inserted as { id: string }).id;
  try {
    const view = await buildSessionView(supabase, orgId, { id, status: 'PROPOSED', postedGlEntryId: null }, data);
    return NextResponse.json({ ...view, sourceCount: sources.length });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Saved, but could not load the review' , id }, { status: 500 });
  }
}

export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const sessions = await listSessions(supabase, orgId);
  return NextResponse.json({ sessions });
}
