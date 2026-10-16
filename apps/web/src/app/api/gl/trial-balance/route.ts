export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { trialBalanceQuerySchema, type TrialBalanceQuery } from '@/lib/validations/gl';
import { fetchAll } from '@/lib/supabase/fetch-all';

export const GET = apiQueryHandler(
  trialBalanceQuerySchema,
  async (params: TrialBalanceQuery, ctx) => {
    const locIds = (params as Record<string, string>).location_ids;
    const locFilter = locIds ? locIds.split(',').filter(Boolean) : (params.location_id && params.location_id !== 'all' ? [params.location_id] : []);

    // Paged: PostgREST caps responses at 1,000 rows. v_trial_balance is one row per
    // (org, location, account), so a multi-entity TB passes 1,000 rows quickly.
    // Display order is preserved; the view's unique key is appended as tie-breaker.
    const buildQuery = () => {
      let query = ctx.supabase.from('v_trial_balance').select('*');
      if (locFilter.length === 1) {
        query = query.eq('location_id', locFilter[0]);
      } else if (locFilter.length > 1) {
        query = query.in('location_id', locFilter);
      }
      return query
        .order('type_order')
        .order('sub_type_order')
        .order('group_order')
        .order('account_order');
    };

    const { data, error } = await fetchAll(buildQuery, {
      orderBy: ['org_id', 'location_id', 'account_id'],
      label: 'trial-balance v_trial_balance',
    });

    if (error) {
      return NextResponse.json(
        { error: error.message, code: 'QUERY_ERROR' },
        { status: 500 }
      );
    }

    return NextResponse.json({ data });
  }
);
