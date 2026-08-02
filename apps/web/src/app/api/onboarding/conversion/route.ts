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
import { loadTargetAccounts, listSessions } from '@/lib/onboarding/session';

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
}

const MAX_ROWS = 20000;

export async function POST(req: NextRequest) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.companyId) return NextResponse.json({ error: 'Select a company to convert into' }, { status: 400 });
  if (!body.asOfDate) return NextResponse.json({ error: 'Select the opening-balance as-of date' }, { status: 400 });
  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    return NextResponse.json({ error: 'No rows to convert' }, { status: 400 });
  }
  if (body.rows.length > MAX_ROWS) {
    return NextResponse.json({ error: `Conversion is limited to ${MAX_ROWS} rows per file` }, { status: 400 });
  }

  // Resolve the target company (location).
  const { data: loc } = await supabase
    .schema('core').from('locations')
    .select('id, short_code, name')
    .eq('id', body.companyId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (!loc) return NextResponse.json({ error: 'Selected company not found' }, { status: 400 });
  const company = loc as { id: string; short_code: string; name: string };

  // Coerce uploaded rows to SourceLine (balances come straight from the file).
  const sourceLines: SourceLine[] = [];
  const rowErrors: { row: number; message: string }[] = [];
  body.rows.forEach((raw, i) => {
    const rowNum = i + 2;
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
    const debit = Number(rec.debit_cents ?? 0);
    const credit = Number(rec.credit_cents ?? 0);
    if (debit < 0 || credit < 0) { rowErrors.push({ row: rowNum, message: 'Amounts cannot be negative' }); return; }
    sourceLines.push({
      sourceAccount: String(rec.source_account ?? '').trim(),
      sourceName: rec.source_name ? String(rec.source_name) : null,
      debitCents: debit,
      creditCents: credit,
    });
  });

  if (rowErrors.length > 0) {
    return NextResponse.json({ error: 'The file has invalid rows', errors: rowErrors.slice(0, 200) }, { status: 422 });
  }
  if (sourceLines.length === 0) {
    return NextResponse.json({ error: 'No usable rows in the file' }, { status: 422 });
  }

  // Load COA targets and propose the mapping (AI never sees a balance).
  const targets = await loadTargetAccounts(supabase, orgId);
  if (targets.length === 0) {
    return NextResponse.json({ error: 'This company has no chart of accounts yet — seed the COA before converting.' }, { status: 400 });
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
    unmapped: assembled.unmapped,
    unknownTargets: assembled.unknownTargets,
    sourceTotals: assembled.sourceTotals,
    tiedOut: false,
    tiedOutBy: null,
    tiedOutAt: null,
  };

  const { data: inserted, error: insErr } = await supabase
    .from('ai_decisions')
    .insert({
      org_id: orgId,
      location_id: company.id,
      feature: CONVERSION_FEATURE,
      model_requested: aiUsed ? 'claude-sonnet-4-20250514' : null,
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
    return NextResponse.json({ error: `Could not stage the conversion: ${insErr?.message ?? 'unknown'}` }, { status: 500 });
  }

  return NextResponse.json({
    id: (inserted as { id: string }).id,
    company: { id: company.id, shortCode: company.short_code, name: company.name },
    asOfDate: body.asOfDate,
    sourceCount: sources.length,
    aiUsed,
    aiError,
    ...assembled,
  });
}

export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const sessions = await listSessions(supabase, orgId);
  return NextResponse.json({ sessions });
}
