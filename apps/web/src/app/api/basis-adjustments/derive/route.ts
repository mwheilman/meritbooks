export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  resolveAccountDifferenceCents,
  findMLine,
  type DifferenceType,
  type TaxableEffect,
} from '@/lib/tax/book-tax';
import { deriveTaxAdjustmentsFromM1, type PerAccountTaxDifference } from '@/lib/reports/basis/derive-tax';
import type { NormalBalance } from '@/lib/reports/basis/apply-adjustments';

/**
 * DERIVE reporting-basis adjustments from the book-to-tax M-1 tags.
 *
 * POST /api/basis-adjustments/derive  { basis:'TAX', period_year, period_month?, location_ids?, replace? }
 *
 * Reuses the SAME per-account difference resolution the M-1 report uses (each tagged P&L
 * account's natural activity × the line's disallowance %, via `resolveAccountDifferenceCents`)
 * and turns it into balanced, net-zero presentation adjustments (a leg per difference + one
 * equity offset). Idempotent per period: when `replace` is true (default) it clears prior
 * DERIVED rows for the same basis/period first, so re-running reflects the latest tags.
 *
 * Only TAX derivation is supported today — CASH/CUSTOM are entered manually (the cash-basis
 * P&L toggle already offers an entry-level cash view). These rows never post to the GL.
 */

const bodySchema = z.object({
  basis: z.literal('TAX'),
  period_year: z.number().int().min(1900).max(2200),
  period_month: z.number().int().min(1).max(12).nullable().optional(),
  location_ids: z.string().optional(),
  replace: z.boolean().optional().default(true),
});

interface TagRow {
  account_id: string;
  m_line_code: string;
  difference_type: DifferenceType;
  taxable_effect: TaxableEffect;
  disallowance_pct: number | null;
}

interface AcctAccum {
  normalBalance: NormalBalance;
  totalDebits: number;
  totalCredits: number;
}

async function resolveEquityAccountId(supabase: SupabaseClient): Promise<string | null> {
  // 1. explicit role mapping (org-wide row) → 2. standard retained-earnings number →
  // 3. any EQUITY account. Fail-soft: a null means we can't offset and report why.
  const { data: role } = await supabase
    .from('account_roles')
    .select('account_id')
    .eq('role_key', 'RETAINED_EARNINGS')
    .is('location_id', null)
    .maybeSingle();
  if (role?.account_id) return role.account_id as string;

  const { data: byNum } = await supabase
    .from('accounts')
    .select('id')
    .eq('account_number', '3020')
    .maybeSingle();
  if (byNum?.id) return byNum.id as string;

  const { data: anyEq } = await supabase
    .from('accounts')
    .select('id')
    .eq('account_type', 'EQUITY')
    .order('account_number')
    .limit(1)
    .maybeSingle();
  return (anyEq?.id as string) ?? null;
}

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization found', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'journal_entries', 'create');
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, { status: 422 });
  }
  const { period_year, period_month, location_ids, replace } = parsed.data;
  const locationIds = (location_ids ?? '').split(',').filter(Boolean);

  const startDate = period_month
    ? `${period_year}-${String(period_month).padStart(2, '0')}-01`
    : `${period_year}-01-01`;
  const endDate = period_month
    ? new Date(period_year, period_month, 0).toISOString().slice(0, 10)
    : `${period_year}-12-31`;

  // ── 1. P&L lines for the period (same scope as the income statement / M-1 report) ──
  let query = supabase
    .from('gl_entry_lines')
    .select(`
      account_id,
      debit_cents,
      credit_cents,
      location_id,
      accounts!inner(
        account_type,
        account_groups!inner(
          account_sub_types!inner(
            account_types!inner( normal_balance )
          )
        )
      ),
      gl_entries!inner( entry_date, status )
    `)
    .eq('gl_entries.status', 'POSTED')
    .gte('gl_entries.entry_date', startDate)
    .lte('gl_entries.entry_date', endDate)
    .in('accounts.account_type', ['REVENUE', 'COGS', 'OPEX', 'OTHER']);
  if (locationIds.length === 1) query = query.eq('location_id', locationIds[0]);
  else if (locationIds.length > 1) query = query.in('location_id', locationIds);

  const { data: lines, error } = await query;
  if (error) return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });

  // ── 2. Tags ──
  const { data: tagRows } = await supabase
    .from('book_tax_account_tags')
    .select('account_id, m_line_code, difference_type, taxable_effect, disallowance_pct');
  const tags = (tagRows ?? []) as TagRow[];
  const tagByAccount = new Map(tags.map((t) => [t.account_id, t]));
  if (tagByAccount.size === 0) {
    return NextResponse.json({ error: 'No book-to-tax tags found. Tag P&L accounts on the Book-to-Tax page first.', code: 'NO_TAGS' }, { status: 422 });
  }

  // ── 3. Accumulate per tagged account ──
  const accts = new Map<string, AcctAccum>();
  for (const line of (lines ?? []) as unknown as Array<Record<string, unknown>>) {
    const accountId = line.account_id as string;
    if (!tagByAccount.has(accountId)) continue;
    const acct = line.accounts as Record<string, unknown>;
    const groups = acct.account_groups as Record<string, unknown>;
    const subTypes = groups.account_sub_types as Record<string, unknown>;
    const types = subTypes.account_types as Record<string, unknown>;
    const nb: NormalBalance = (types.normal_balance as string) === 'CREDIT' ? 'CREDIT' : 'DEBIT';
    let a = accts.get(accountId);
    if (!a) { a = { normalBalance: nb, totalDebits: 0, totalCredits: 0 }; accts.set(accountId, a); }
    a.totalDebits += Number(line.debit_cents ?? 0);
    a.totalCredits += Number(line.credit_cents ?? 0);
  }

  // ── 4. Resolve per-account differences (reuse book-tax.ts arithmetic) ──
  const diffs: PerAccountTaxDifference[] = [];
  for (const [accountId, a] of accts.entries()) {
    const tag = tagByAccount.get(accountId)!;
    const activity = a.normalBalance === 'CREDIT'
      ? a.totalCredits - a.totalDebits
      : a.totalDebits - a.totalCredits;
    const amountCents = resolveAccountDifferenceCents(activity, tag.m_line_code, tag.disallowance_pct);
    if (amountCents === 0) continue;
    diffs.push({
      accountId,
      normalBalance: a.normalBalance,
      taxableEffect: tag.taxable_effect,
      differenceType: tag.difference_type,
      amountCents,
      code: tag.m_line_code,
      label: findMLine(tag.m_line_code)?.label ?? tag.m_line_code,
    });
  }

  if (diffs.length === 0) {
    return NextResponse.json({ error: 'Tags exist but no book-tax differences resolved for this period (no eligible activity).', code: 'NO_DIFFERENCES' }, { status: 422 });
  }

  const equityAccountId = await resolveEquityAccountId(supabase);
  if (!equityAccountId) {
    return NextResponse.json({ error: 'No equity account found to book the balancing offset. Add a Retained Earnings account.', code: 'NO_EQUITY_ACCOUNT' }, { status: 422 });
  }

  const derived = deriveTaxAdjustmentsFromM1(diffs, equityAccountId);

  // ── 5. Replace prior DERIVED rows for this period, then insert ──
  if (replace) {
    let del = supabase
      .from('reporting_basis_adjustments')
      .delete()
      .eq('basis', 'TAX')
      .eq('source', 'DERIVED')
      .eq('period_year', period_year);
    del = period_month != null ? del.eq('period_month', period_month) : del.is('period_month', null);
    const { error: delErr } = await del;
    if (delErr) return NextResponse.json({ error: delErr.message, code: 'DELETE_ERROR' }, { status: 500 });
  }

  const insertRows = derived.adjustments.map((adj) => ({
    org_id: orgId,
    basis: 'TAX' as const,
    custom_label: null,
    period_year,
    period_month: period_month ?? null,
    location_id: locationIds.length === 1 ? locationIds[0] : null,
    account_id: adj.accountId,
    description: adj.description ?? null,
    amount_cents: adj.amountCents,
    adjustment_type: adj.adjustmentType ?? null,
    source: 'DERIVED',
    created_by: userId,
  }));

  const { error: insErr } = await supabase.from('reporting_basis_adjustments').insert(insertRows);
  if (insErr) return NextResponse.json({ error: insErr.message, code: 'INSERT_ERROR' }, { status: 500 });

  return NextResponse.json({
    data: {
      ok: true,
      created: insertRows.length,
      differenceCount: diffs.length,
      equityOffsetCents: derived.equityOffsetCents,
      balances: derived.netDebitPositiveCents === 0,
    },
  });
}
