export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { z } from 'zod';

const jeLineSchema = z.object({
  account_id: z.string().uuid(),
  debit_cents: z.number().int().min(0),
  credit_cents: z.number().int().min(0),
  location_id: z.string().uuid(),
  department_id: z.string().uuid().nullable().optional(),
  class_id: z.string().uuid().nullable().optional(),
  item_id: z.string().uuid().nullable().optional(),
  memo: z.string().max(500).nullable().optional(),
});

const jeCreateSchema = z.object({
  location_id: z.string().uuid(),
  entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  entry_type: z.enum(['STANDARD', 'ADJUSTING', 'CLOSING', 'REVERSING']).default('STANDARD'),
  memo: z.string().max(1000).optional(),
  post_immediately: z.boolean().default(true),
  lines: z.array(jeLineSchema).min(2),
});

// GET — query journal entries (already exists, re-export for combined route)
export async function GET(request: Request) {
  const authResult = await auth().catch(() => ({ userId: null as string | null, orgId: null as string | null }));
  const userId = authResult.userId ?? 'dev-user';
  const supabase = createAdminSupabase();

  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status');
  const entryType = searchParams.get('entry_type');
  const search = searchParams.get('search');
  const locationId = searchParams.get('location_id');
  const page = parseInt(searchParams.get('page') ?? '1', 10);
  const perPage = Math.min(parseInt(searchParams.get('per_page') ?? '50', 10), 100);
  const offset = (page - 1) * perPage;

  let query = supabase
    .from('gl_entries')
    .select(`
      id,
      entry_number,
      entry_date,
      entry_type,
      memo,
      source_module,
      status,
      posted_at,
      created_by,
      created_at,
      location:locations!gl_entries_location_id_fkey(id, name, short_code),
      gl_entry_lines(debit_cents, credit_cents)
    `, { count: 'exact' });

  if (locationId) query = query.eq('location_id', locationId);
  if (status && status !== 'all') query = query.eq('status', status);
  if (entryType && entryType !== 'all') query = query.eq('entry_type', entryType);
  if (search && search.trim().length > 0) {
    const term = search.trim();
    query = query.or(`entry_number.ilike.%${term}%,memo.ilike.%${term}%`);
  }

  query = query
    .order('entry_date', { ascending: false })
    .order('created_at', { ascending: false })
    .range(offset, offset + perPage - 1);

  const { data, error, count } = await query;

  if (error) {
    return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
  }

  const rows = (data ?? []).map((je: Record<string, unknown>) => {
    const lines = (je.gl_entry_lines as Array<{ debit_cents: number; credit_cents: number }>) ?? [];
    const totalDebitCents = lines.reduce((sum: number, l) => sum + Number(l.debit_cents ?? 0), 0);
    return {
      id: je.id,
      entryNumber: je.entry_number,
      entryDate: je.entry_date,
      entryType: je.entry_type,
      memo: je.memo,
      sourceModule: je.source_module,
      status: je.status,
      postedAt: je.posted_at,
      createdBy: je.created_by,
      createdAt: je.created_at,
      location: je.location,
      totalDebitCents,
      lineCount: lines.length,
    };
  });

  // Status counts
  const countStatuses = ['DRAFT', 'PENDING', 'POSTED', 'VOIDED'] as const;
  const statusCounts: Record<string, number> = {};
  for (const s of countStatuses) {
    let q = supabase.from('gl_entries').select('id', { count: 'exact', head: true }).eq('status', s);
    if (locationId) q = q.eq('location_id', locationId);
    const { count: c } = await q;
    statusCounts[s] = c ?? 0;
  }
  statusCounts['all'] = Object.values(statusCounts).reduce((a, b) => a + b, 0);

  return NextResponse.json({
    data: rows,
    counts: statusCounts,
    pagination: { page, per_page: perPage, total: count ?? 0, total_pages: Math.ceil((count ?? 0) / perPage) },
  });
}

// POST — create a new journal entry
export async function POST(request: Request) {
  const authResult = await auth().catch(() => ({ userId: null as string | null, orgId: null as string | null }));
  const userId = authResult.userId ?? 'dev-user';
  const supabase = createAdminSupabase();

  let body: z.infer<typeof jeCreateSchema>;
  try {
    const raw = await request.json();
    const result = jeCreateSchema.safeParse(raw);
    if (!result.success) {
      return NextResponse.json({
        error: 'Validation failed',
        code: 'VALIDATION_ERROR',
        details: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      }, { status: 422 });
    }
    body = result.data;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }

  // Validate balanced entry
  const totalDebits = body.lines.reduce((s, l) => s + l.debit_cents, 0);
  const totalCredits = body.lines.reduce((s, l) => s + l.credit_cents, 0);

  if (totalDebits !== totalCredits) {
    return NextResponse.json({
      error: `Unbalanced entry: debits (${totalDebits}) ≠ credits (${totalCredits})`,
      code: 'UNBALANCED',
    }, { status: 422 });
  }

  if (totalDebits === 0) {
    return NextResponse.json({ error: 'Entry has no amounts', code: 'ZERO_AMOUNT' }, { status: 422 });
  }

  // Validate each line has either debit or credit (not both)
  for (let i = 0; i < body.lines.length; i++) {
    const line = body.lines[i];
    if (line.debit_cents > 0 && line.credit_cents > 0) {
      return NextResponse.json({
        error: `Line ${i + 1}: cannot have both debit and credit`,
        code: 'INVALID_LINE',
      }, { status: 422 });
    }
    if (line.debit_cents === 0 && line.credit_cents === 0) {
      return NextResponse.json({
        error: `Line ${i + 1}: must have a debit or credit amount`,
        code: 'EMPTY_LINE',
      }, { status: 422 });
    }
  }

  // Get org_id from location
  const { data: loc } = await supabase
    .from('locations')
    .select('org_id')
    .eq('id', body.location_id)
    .single();

  if (!loc) {
    return NextResponse.json({ error: 'Location not found', code: 'NOT_FOUND' }, { status: 404 });
  }

  const orgId = loc.org_id as string;

  // Find fiscal period
  const { data: period } = await supabase
    .from('fiscal_periods')
    .select('id, status')
    .eq('org_id', orgId)
    .eq('location_id', body.location_id)
    .lte('start_date', body.entry_date)
    .gte('end_date', body.entry_date)
    .single();

  if (!period) {
    return NextResponse.json({
      error: `No fiscal period found for date ${body.entry_date}. Create a fiscal period first.`,
      code: 'NO_PERIOD',
    }, { status: 422 });
  }

  if ((period.status as string) === 'HARD_CLOSE') {
    return NextResponse.json({
      error: 'Cannot post to a hard-closed period',
      code: 'PERIOD_CLOSED',
    }, { status: 422 });
  }

  const status = body.post_immediately ? 'POSTED' : 'DRAFT';

  // Insert header
  const { data: entry, error: entryError } = await supabase
    .from('gl_entries')
    .insert({
      org_id: orgId,
      location_id: body.location_id,
      entry_date: body.entry_date,
      entry_type: body.entry_type,
      fiscal_period_id: period.id,
      memo: body.memo ?? null,
      source_module: 'MANUAL',
      status,
      posted_at: status === 'POSTED' ? new Date().toISOString() : null,
      posted_by: status === 'POSTED' ? userId : null,
      created_by: userId,
    })
    .select('id, entry_number')
    .single();

  if (entryError || !entry) {
    console.error('[journal-entries POST] Insert error:', entryError);
    return NextResponse.json({
      error: `Failed to create entry: ${entryError?.message ?? 'unknown'}`,
      code: 'INSERT_ERROR',
    }, { status: 500 });
  }

  // Insert lines
  const lineInserts = body.lines.map((line, index) => ({
    org_id: orgId,
    gl_entry_id: entry.id,
    line_number: index + 1,
    account_id: line.account_id,
    debit_cents: line.debit_cents,
    credit_cents: line.credit_cents,
    location_id: line.location_id,
    department_id: line.department_id ?? null,
    class_id: line.class_id ?? null,
    item_id: line.item_id ?? null,
    memo: line.memo ?? null,
  }));

  const { error: linesError } = await supabase
    .from('gl_entry_lines')
    .insert(lineInserts);

  if (linesError) {
    // Rollback the header
    await supabase.from('gl_entries').delete().eq('id', entry.id);
    console.error('[journal-entries POST] Lines error:', linesError);
    return NextResponse.json({
      error: `Failed to post lines: ${linesError.message}`,
      code: 'LINES_ERROR',
    }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    entry: {
      id: entry.id,
      entryNumber: entry.entry_number,
      status,
      totalDebitCents: totalDebits,
      lineCount: body.lines.length,
    },
  }, { status: 201 });
}
