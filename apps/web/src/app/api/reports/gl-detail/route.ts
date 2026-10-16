export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { fetchCoreMap } from '@/lib/stitch-core';
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
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase } = ctx;

  const { searchParams } = new URL(request.url);
  const params = querySchema.parse(Object.fromEntries(searchParams.entries()));
  const locFilter = params.location_ids ? params.location_ids.split(",").filter(Boolean) : (params.location_id && params.location_id !== "all" ? [params.location_id] : []);

  const page = parseInt(params.page ?? '1', 10);
  const perPage = parseInt(params.per_page ?? '100', 10);
  const from = (page - 1) * perPage;
  const to = from + perPage - 1;

  // When a date range is given, the parent entry is filtered via an INNER embed
  // (POSTED + date window + entry location) instead of a pre-fetched entry-id
  // list: that list was an unpaged read capped at 1,000 rows by PostgREST, so
  // busy periods silently lost lines and under-reported `total`.
  const dateFiltered = Boolean(params.start_date || params.end_date);
  const entryEmbed = dateFiltered
    ? 'gl_entry:gl_entries!gl_entry_lines_gl_entry_id_fkey!inner'
    : 'gl_entry:gl_entries!gl_entry_lines_gl_entry_id_fkey';

  let query = supabase
    .from('gl_entry_lines')
    .select(`
      id, line_number, debit_cents, credit_cents, memo, created_at,
      account:accounts!gl_entry_lines_account_id_fkey(id, account_number, name),
      ${entryEmbed}(
        id, entry_number, entry_date, entry_type, memo, source_module, status, location_id
      )
    `, { count: 'exact' })
    .order('created_at', { ascending: false })
    // Unique tie-breaker: lines of one entry share created_at, so without it
    // consecutive pages could overlap or skip lines.
    .order('id', { ascending: false })
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

  // Filter by date range (on the parent gl_entry's entry_date) — same filters the
  // old entry-id pre-query applied (POSTED, date window, entry location), now on
  // the inner-joined parent. An empty match yields the same empty response shape.
  if (dateFiltered) {
    query = query.eq('gl_entry.status', 'POSTED');
    if (params.start_date) query = query.gte('gl_entry.entry_date', params.start_date);
    if (params.end_date) query = query.lte('gl_entry.entry_date', params.end_date);
    if (locFilter.length === 1) query = query.eq('gl_entry.location_id', locFilter[0]);
    else if (locFilter.length > 1) query = query.in('gl_entry.location_id', locFilter);
  }

  const { data, count, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Stitch entry locations (core) — cross-schema embeds don't work.
  const rows = (data ?? []) as Array<Record<string, any>>;
  const entryLocIds = rows.map((line) => {
    const e = Array.isArray(line.gl_entry) ? line.gl_entry[0] : line.gl_entry;
    return (e as { location_id?: string } | null)?.location_id;
  });
  const locMap = await fetchCoreMap<{ id: string; name: string; short_code: string }>(
    supabase, 'locations', 'id, name, short_code', entryLocIds);

  // Calculate summary
  let totalDebitCents = 0;
  let totalCreditCents = 0;

  const transactions = rows.map((line) => {
    const account = Array.isArray(line.account) ? line.account[0] : line.account;
    const entry = Array.isArray(line.gl_entry) ? line.gl_entry[0] : line.gl_entry;
    const location = (entry as { location_id?: string } | null)?.location_id
      ? locMap.get((entry as { location_id: string }).location_id) ?? null
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
