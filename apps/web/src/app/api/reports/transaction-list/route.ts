export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';

export async function GET(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get('location_id');
  const accountId = searchParams.get('account_id');
  const startDate = searchParams.get('start_date') ?? new Date().toISOString().slice(0, 8) + '01';
  const endDate = searchParams.get('end_date') ?? new Date().toISOString().slice(0, 10);
  const mode = searchParams.get('mode') ?? 'detail';

  // Get posted GL entries in range
  let entriesQ = supabase.from('gl_entries').select('id, entry_number, entry_date, memo, source_module').eq('status', 'POSTED').gte('entry_date', startDate).lte('entry_date', endDate);
  if (locationId) entriesQ = entriesQ.eq('location_id', locationId);
  const { data: entries } = await entriesQ;

  if (!entries || entries.length === 0) {
    return NextResponse.json({ period: { startDate, endDate }, mode, data: [], summary: { totalDebits: 0, totalCredits: 0, entryCount: 0 } });
  }

  let linesQ = supabase
    .from('gl_entry_lines')
    .select(`
      id, gl_entry_id, debit_cents, credit_cents, memo,
      account:accounts!gl_entry_lines_account_id_fkey(account_number, name, account_type)
    `)
    .in('gl_entry_id', entries.map((e) => e.id));
  if (accountId) linesQ = linesQ.eq('account_id', accountId);
  const { data: lines } = await linesQ;

  const entryLookup = new Map(entries.map((e) => [e.id, e]));

  const transactions = (lines ?? []).map((l) => {
    const entry = entryLookup.get(l.gl_entry_id);
    const acct = Array.isArray(l.account) ? l.account[0] : l.account;
    return {
      id: l.id,
      date: entry?.entry_date ?? '',
      entryNumber: entry?.entry_number ?? '',
      sourceModule: entry?.source_module ?? '',
      entryMemo: entry?.memo ?? null,
      lineMemo: l.memo,
      accountNumber: (acct as { account_number: string } | null)?.account_number ?? '',
      accountName: (acct as { name: string } | null)?.name ?? '',
      accountType: (acct as { account_type: string } | null)?.account_type ?? '',
      debitCents: Number(l.debit_cents ?? 0),
      creditCents: Number(l.credit_cents ?? 0),
    };
  }).sort((a, b) => a.date.localeCompare(b.date) || a.entryNumber.localeCompare(b.entryNumber));

  // Summary mode: group by date
  if (mode === 'summary') {
    const dayMap = new Map<string, { date: string; entryCount: number; debitCents: number; creditCents: number }>();
    for (const t of transactions) {
      const existing = dayMap.get(t.date);
      if (existing) { existing.entryCount++; existing.debitCents += t.debitCents; existing.creditCents += t.creditCents; }
      else { dayMap.set(t.date, { date: t.date, entryCount: 1, debitCents: t.debitCents, creditCents: t.creditCents }); }
    }
    return NextResponse.json({
      period: { startDate, endDate }, mode,
      data: Array.from(dayMap.values()),
      summary: { totalDebits: transactions.reduce((s, t) => s + t.debitCents, 0), totalCredits: transactions.reduce((s, t) => s + t.creditCents, 0), entryCount: transactions.length },
    });
  }

  return NextResponse.json({
    period: { startDate, endDate }, mode,
    data: transactions,
    summary: { totalDebits: transactions.reduce((s, t) => s + t.debitCents, 0), totalCredits: transactions.reduce((s, t) => s + t.creditCents, 0), entryCount: transactions.length },
  });
}
