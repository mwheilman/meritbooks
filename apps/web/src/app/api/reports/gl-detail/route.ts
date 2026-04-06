export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { z } from 'zod';

const querySchema = z.object({
  account_id: z.string().uuid().optional(),
  account_number: z.string().optional(),
  location_id: z.string().optional(),
  location_ids: z.string().optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.string().regex(/^\d+$/).optional(),
  per_page: z.string().regex(/^\d+$/).optional(),
});

export async function GET(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();

  const { searchParams } = new URL(request.url);
  const params = querySchema.parse(Object.fromEntries(searchParams.entries()));
  const locFilter = params.location_ids ? params.location_ids.split(",").filter(Boolean) : (params.location_id && params.location_id !== "all" ? [params.location_id] : []);

  const page = parseInt(params.page ?? '1', 10);
  const perPage = parseInt(params.per_page ?? '100', 10);
  const from = (page - 1) * perPage;
  const to = from + perPage - 1;

  let query = supabase
    .from('gl_entry_lines')
    .select(`
      id, line_number, debit_cents, credit_cents, memo, created_at,
      account:accounts!gl_entry_lines_account_id_fkey(id, account_number, name),
      gl_entry:gl_entries!gl_entry_lines_gl_entry_id_fkey(
        id, entry_number, entry_date, entry_type, memo, source_module, status,
        location:locations!gl_entries_location_id_fkey(id, name, short_code)
      )
    `, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  // Filter by account
  if (params.account_id) {
    query = query.eq('account_id', params.account_id);
  }

  // Filter by location
  if (locFilter.length === 1) {
    query = query.eq('location_id', locFilter[0]);
  } else if (locFilter.length > 1) {
    query = query.in('location_id', locFilter);
  }

  // Filter by date range (on the parent gl_entry's entry_date)
  // Since we can't filter on joined table fields easily in Supabase,
  // we'll use a subquery approach via the gl_entries table
  if (params.start_date || params.end_date) {
    // Get entry IDs in the date range first
    let entriesQ = supabase
      .from('gl_entries')
      .select('id')
      .eq('status', 'POSTED');
    
    if (params.start_date) entriesQ = entriesQ.gte('entry_date', params.start_date);
    if (params.end_date) entriesQ = entriesQ.lte('entry_date', params.end_date);
    if (locFilter.length === 1) entriesQ = entriesQ.eq('location_id', locFilter[0]); else if (locFilter.length > 1) entriesQ = entriesQ.in('location_id', locFilter);

    const { data: entryIds } = await entriesQ;
    if (entryIds && entryIds.length > 0) {
      query = query.in('gl_entry_id', entryIds.map((e) => e.id));
    } else {
      // No entries in range — return empty
      return NextResponse.json({
        data: [],
        summary: { totalDebitCents: 0, totalCreditCents: 0, netCents: 0 },
        pagination: { page, per_page: perPage, total: 0, total_pages: 0 },
      });
    }
  }

  const { data, count, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Calculate summary
  let totalDebitCents = 0;
  let totalCreditCents = 0;

  const transactions = (data ?? []).map((line) => {
    const account = Array.isArray(line.account) ? line.account[0] : line.account;
    const entry = Array.isArray(line.gl_entry) ? line.gl_entry[0] : line.gl_entry;
    const location = entry && typeof entry === 'object' && 'location' in entry
      ? (Array.isArray(entry.location) ? entry.location[0] : entry.location)
      : null;

    const debit = Number(line.debit_cents ?? 0);
    const credit = Number(line.credit_cents ?? 0);
    totalDebitCents += debit;
    totalCreditCents += credit;

    return {
      id: line.id,
      entryNumber: entry?.entry_number ?? '',
      entryDate: entry?.entry_date ?? '',
      entryType: entry?.entry_type ?? '',
      sourceModule: entry?.source_module ?? '',
      entryMemo: entry?.memo ?? null,
      lineMemo: line.memo,
      accountNumber: account?.account_number ?? '',
      accountName: account?.name ?? '',
      debitCents: debit,
      creditCents: credit,
      locationName: location?.name ?? '',
      locationCode: location?.short_code ?? '',
    };
  });

  return NextResponse.json({
    data: transactions,
    summary: {
      totalDebitCents,
      totalCreditCents,
      netCents: totalDebitCents - totalCreditCents,
    },
    pagination: {
      page,
      per_page: perPage,
      total: count ?? 0,
      total_pages: Math.ceil((count ?? 0) / perPage),
    },
  });
}
