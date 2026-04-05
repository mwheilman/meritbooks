export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { z } from 'zod';

const searchSchema = z.object({
  q: z.string().max(100).optional(),
  vendor_id: z.string().uuid().optional(),
});

/**
 * GET /api/accounts/search
 * Search GL accounts. If vendor_id is provided, returns that vendor's
 * top 5 most-used accounts first (from vendor_patterns), then remaining matches.
 */
export const GET = apiQueryHandler(
  searchSchema,
  async (params, ctx) => {
    const q = params.q?.trim() ?? '';
    const vendorId = params.vendor_id;

    // Get vendor's recent accounts from patterns
    let recentAccountIds: string[] = [];
    if (vendorId) {
      const { data: patterns } = await ctx.supabase
        .from('vendor_patterns')
        .select('account_id')
        .eq('vendor_id', vendorId)
        .order('match_count', { ascending: false })
        .limit(5);

      recentAccountIds = (patterns ?? []).map((p: { account_id: string }) => p.account_id);
    }

    // Search accounts
    let query = ctx.supabase
      .from('accounts')
      .select('id, account_number, name, account_type, account_sub_type')
      .eq('is_active', true)
      .eq('approval_status', 'APPROVED')
      .order('account_number', { ascending: true })
      .limit(30);

    if (q.length > 0) {
      // Search by number prefix or name
      query = query.or(`account_number.ilike.${q}%,name.ilike.%${q}%`);
    }

    const { data: accounts, error } = await query;

    if (error) {
      return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
    }

    // Split into recent (vendor-specific) and other
    const recent = (accounts ?? []).filter((a: { id: string }) => recentAccountIds.includes(a.id));
    const other = (accounts ?? []).filter((a: { id: string }) => !recentAccountIds.includes(a.id));

    // Sort recent by vendor usage order
    recent.sort((a: { id: string }, b: { id: string }) =>
      recentAccountIds.indexOf(a.id) - recentAccountIds.indexOf(b.id)
    );

    return NextResponse.json({
      recent,
      accounts: other,
    });
  }
);
