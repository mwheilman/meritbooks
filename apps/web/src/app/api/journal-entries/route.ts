import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { z } from 'zod';

const jeQuerySchema = z.object({
  status: z.enum(['all', 'DRAFT', 'PENDING', 'POSTED', 'VOIDED']).optional(),
  entry_type: z.enum(['all', 'STANDARD', 'ADJUSTING', 'CLOSING', 'REVERSING', 'RECURRING', 'SYSTEM']).optional(),
  search: z.string().max(200).optional(),
  location_id: z.string().uuid().optional(),
  page: z.string().regex(/^\d+$/).optional(),
  per_page: z.string().regex(/^\d+$/).optional(),
});

export const GET = apiQueryHandler(
  jeQuerySchema,
  async (params, ctx) => {
    const page = parseInt(params.page ?? '1', 10);
    const perPage = Math.min(parseInt(params.per_page ?? '50', 10), 100);
    const offset = (page - 1) * perPage;

    let query = ctx.supabase
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

    if (params.location_id) query = query.eq('location_id', params.location_id);

    if (params.status && params.status !== 'all') {
      query = query.eq('status', params.status);
    }

    if (params.entry_type && params.entry_type !== 'all') {
      query = query.eq('entry_type', params.entry_type);
    }

    if (params.search && params.search.trim().length > 0) {
      const term = params.search.trim();
      query = query.or(`entry_number.ilike.%${term}%,memo.ilike.%${term}%`);
    }

    query = query
      .order('entry_date', { ascending: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + perPage - 1);

    const { data, error, count } = await query;

    if (error) {
      console.error('[journal-entries] Query error:', error);
      return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
    }

    // Aggregate line data
    const rows = (data ?? []).map((je: any) => {
      const lines = je.gl_entry_lines ?? [];
      const totalDebitCents = lines.reduce((sum: number, l: { debit_cents: number }) => sum + Number(l.debit_cents ?? 0), 0);
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
      let q = ctx.supabase.from('gl_entries').select('id', { count: 'exact', head: true }).eq('status', s);
      if (params.location_id) q = q.eq('location_id', params.location_id);
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
);
