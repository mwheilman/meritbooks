export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';

export async function GET(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('start_date') ?? new Date().toISOString().slice(0, 8) + '01';
  const endDate = searchParams.get('end_date') ?? new Date().toISOString().slice(0, 10);
  const eliminateIc = searchParams.get('eliminate_ic') !== 'false'; // default true

  // Get all locations
  const { data: locations } = await supabase
    .from('locations')
    .select('id, name, short_code')
    .eq('is_active', true)
    .order('name');

  // Get posted entries in period
  const { data: entries } = await supabase
    .from('gl_entries')
    .select('id, location_id, source_module')
    .eq('status', 'POSTED')
    .gte('entry_date', startDate)
    .lte('entry_date', endDate);

  if (!entries || entries.length === 0) {
    return NextResponse.json({
      period: { startDate, endDate },
      locations: (locations ?? []).map((l) => ({ id: l.id, name: l.name, shortCode: l.short_code })),
      accounts: [],
      eliminatedCents: 0,
    });
  }

  // Filter out intercompany if eliminating
  const filteredEntries = eliminateIc
    ? entries.filter((e) => e.source_module !== 'INTERCOMPANY')
    : entries;

  const eliminatedEntries = entries.filter((e) => e.source_module === 'INTERCOMPANY');

  // Get lines for filtered entries
  const { data: lines } = await supabase
    .from('gl_entry_lines')
    .select(`
      account_id, debit_cents, credit_cents, location_id,
      accounts!inner(account_number, name, account_type)
    `)
    .in('gl_entry_id', filteredEntries.map((e) => e.id))
    .in('accounts.account_type', ['REVENUE', 'COGS', 'OPEX', 'OTHER']);

  // Calculate eliminated amount
  let eliminatedCents = 0;
  if (eliminateIc && eliminatedEntries.length > 0) {
    const { data: elimLines } = await supabase
      .from('gl_entry_lines')
      .select('debit_cents, credit_cents')
      .in('gl_entry_id', eliminatedEntries.map((e) => e.id));
    eliminatedCents = (elimLines ?? []).reduce((s, l) => s + Math.abs(Number(l.debit_cents ?? 0)), 0);
  }

  // Aggregate by account × location
  const accountMap = new Map<string, {
    accountNumber: string;
    accountName: string;
    accountType: string;
    byLocation: Record<string, number>;
    consolidatedCents: number;
  }>();

  for (const line of lines ?? []) {
    const acct = line.accounts as any;
    const key = acct.account_number;
    const isCredit = acct.account_type === 'REVENUE';
    const net = isCredit
      ? Number(line.credit_cents ?? 0) - Number(line.debit_cents ?? 0)
      : Number(line.debit_cents ?? 0) - Number(line.credit_cents ?? 0);

    const existing = accountMap.get(key);
    if (existing) {
      existing.byLocation[line.location_id] = (existing.byLocation[line.location_id] ?? 0) + net;
      existing.consolidatedCents += net;
    } else {
      accountMap.set(key, {
        accountNumber: acct.account_number,
        accountName: acct.name,
        accountType: acct.account_type,
        byLocation: { [line.location_id]: net },
        consolidatedCents: net,
      });
    }
  }

  const accounts = Array.from(accountMap.values()).sort((a, b) => a.accountNumber.localeCompare(b.accountNumber));

  return NextResponse.json({
    period: { startDate, endDate },
    locations: (locations ?? []).map((l) => ({ id: l.id, name: l.name, shortCode: l.short_code })),
    accounts,
    eliminatedCents,
    eliminationsApplied: eliminateIc,
  });
}
