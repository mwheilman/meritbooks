export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { fetchCoreMap } from '@/lib/stitch-core';

/**
 * GET /api/journal-entries/[id]
 * Full journal entry for the detail drawer: header + balanced lines with account
 * numbers/names and dimension labels. accounts is in `public` (embed OK);
 * locations/departments/classes are in `core` and stitched in JS.
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();

  const { data: org } = await supabase.schema('core').from('organizations').select('id').limit(1).single();
  const orgId = (org as { id: string } | null)?.id;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { data: entry, error } = await supabase
    .from('gl_entries')
    .select(`
      id, entry_number, entry_date, entry_type, memo, source_module, source_id,
      status, posted_at, posted_by, created_by, created_at, is_reversing,
      reversal_of_id, reversed_by_id, void_reason, location_id, fiscal_period_id
    `)
    .eq('org_id', orgId)
    .eq('id', params.id)
    .single();

  if (error || !entry) return NextResponse.json({ error: 'Journal entry not found' }, { status: 404 });

  const { data: lineRows } = await supabase
    .from('gl_entry_lines')
    .select(`
      id, line_number, debit_cents, credit_cents, memo,
      department_id, class_id,
      account:accounts!gl_entry_lines_account_id_fkey(id, account_number, name, account_type)
    `)
    .eq('gl_entry_id', params.id)
    .order('line_number', { ascending: true });

  const lines = (lineRows ?? []) as Array<Record<string, any>>;

  // Stitch core dimensions (location on header; departments/classes on lines).
  const locMap = await fetchCoreMap<{ id: string; name: string; short_code: string }>(
    supabase, 'locations', 'id, name, short_code', [entry.location_id]);
  const deptMap = await fetchCoreMap<{ id: string; name: string; code: string }>(
    supabase, 'departments', 'id, name, code', lines.map((l) => l.department_id));
  const classMap = await fetchCoreMap<{ id: string; name: string; code: string }>(
    supabase, 'classes', 'id, name, code', lines.map((l) => l.class_id));

  // Period label.
  let periodLabel: string | null = null;
  if (entry.fiscal_period_id) {
    const { data: fp } = await supabase
      .from('fiscal_periods')
      .select('period_year, period_month, status')
      .eq('id', entry.fiscal_period_id)
      .single();
    if (fp) periodLabel = `${fp.period_year}-${String(fp.period_month).padStart(2, '0')} (${fp.status})`;
  }

  let totalDebits = 0;
  let totalCredits = 0;
  const detailLines = lines.map((l) => {
    const acct = Array.isArray(l.account) ? l.account[0] : l.account;
    totalDebits += Number(l.debit_cents ?? 0);
    totalCredits += Number(l.credit_cents ?? 0);
    const dept = l.department_id ? deptMap.get(l.department_id) ?? null : null;
    const cls = l.class_id ? classMap.get(l.class_id) ?? null : null;
    return {
      id: l.id,
      lineNumber: l.line_number,
      accountNumber: (acct as { account_number?: string } | null)?.account_number ?? '',
      accountName: (acct as { name?: string } | null)?.name ?? '',
      debitCents: Number(l.debit_cents ?? 0),
      creditCents: Number(l.credit_cents ?? 0),
      memo: l.memo ?? null,
      departmentLabel: dept ? `${dept.code} · ${dept.name}` : null,
      classLabel: cls ? `${cls.code} · ${cls.name}` : null,
    };
  });

  const loc = entry.location_id ? locMap.get(entry.location_id) ?? null : null;

  return NextResponse.json({
    id: entry.id,
    entryNumber: entry.entry_number,
    entryDate: entry.entry_date,
    entryType: entry.entry_type,
    memo: entry.memo,
    sourceModule: entry.source_module,
    status: entry.status,
    postedAt: entry.posted_at,
    createdAt: entry.created_at,
    isReversing: entry.is_reversing,
    voidReason: entry.void_reason,
    locationName: loc?.name ?? '',
    locationCode: loc?.short_code ?? '',
    periodLabel,
    totalDebitsCents: totalDebits,
    totalCreditsCents: totalCredits,
    balanced: totalDebits === totalCredits,
    lines: detailLines,
  });
}
