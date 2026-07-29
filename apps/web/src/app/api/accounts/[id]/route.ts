export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';

/**
 * GET /api/accounts/[id] — account record for the detail drawer/peek:
 * identity + current GL balance (posted) + recent posted activity.
 * accounts and gl_entry_lines/gl_entries are all in `public`.
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { data: a, error } = await supabase
    .from('accounts')
    .select('id, account_number, name, account_type, account_sub_type, is_control_account, is_bank_account, is_credit_card, is_active, description')
    .eq('org_id', orgId).eq('id', params.id).single();
  if (error || !a) return NextResponse.json({ error: 'Account not found' }, { status: 404 });

  // Lines for this account with their (public) entry — filter POSTED in JS.
  const { data: lineRows } = await supabase
    .from('gl_entry_lines')
    .select(`
      debit_cents, credit_cents, memo,
      entry:gl_entries!gl_entry_lines_gl_entry_id_fkey(id, entry_number, entry_date, status, memo)
    `)
    .eq('account_id', params.id)
    .limit(2000);

  const lines = (lineRows ?? []) as Array<Record<string, any>>;
  let balanceCents = 0;
  const posted: Array<{ id: string; entryNumber: string; entryDate: string; debitCents: number; creditCents: number; memo: string | null }> = [];
  for (const l of lines) {
    const e = Array.isArray(l.entry) ? l.entry[0] : l.entry;
    if (!e || e.status !== 'POSTED') continue;
    const dr = Number(l.debit_cents ?? 0), cr = Number(l.credit_cents ?? 0);
    balanceCents += dr - cr;
    posted.push({ id: e.id, entryNumber: e.entry_number, entryDate: e.entry_date, debitCents: dr, creditCents: cr, memo: l.memo ?? e.memo ?? null });
  }
  posted.sort((x, y) => (x.entryDate < y.entryDate ? 1 : -1));

  // For asset/expense (DEBIT-normal) a positive balance is a debit; for
  // liability/equity/revenue (CREDIT-normal) present the natural sign.
  const creditNormal = ['LIABILITY', 'EQUITY', 'REVENUE'].includes(a.account_type);
  const naturalBalanceCents = creditNormal ? -balanceCents : balanceCents;

  return NextResponse.json({
    id: a.id,
    accountNumber: a.account_number,
    name: a.name,
    accountType: a.account_type,
    accountSubType: a.account_sub_type ?? null,
    isControl: !!a.is_control_account,
    isBank: !!a.is_bank_account,
    isCreditCard: !!a.is_credit_card,
    isActive: a.is_active !== false,
    description: a.description ?? null,
    naturalBalanceCents,
    normalBalance: creditNormal ? 'CR' : 'DR',
    activityCount: posted.length,
    recentActivity: posted.slice(0, 10),
  });
}
