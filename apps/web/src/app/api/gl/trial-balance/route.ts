export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { trialBalanceQuerySchema, type TrialBalanceQuery } from '@/lib/validations/gl';

export const GET = apiQueryHandler(
  trialBalanceQuerySchema,
  async (params: TrialBalanceQuery, ctx) => {
    let query = ctx.supabase.from('v_trial_balance').select('*');

    const locIds = (params as Record<string, string>).location_ids;
    const locFilter = locIds ? locIds.split(',').filter(Boolean) : (params.location_id && params.location_id !== 'all' ? [params.location_id] : []);
    if (locFilter.length === 1) {
      query = query.eq('location_id', locFilter[0]);
    } else if (locFilter.length > 1) {
      query = query.in('location_id', locFilter);
    }

    const { data, error } = await query
      .order('type_order')
      .order('sub_type_order')
      .order('group_order')
      .order('account_order');

    if (error) {
      return NextResponse.json(
        { error: error.message, code: 'QUERY_ERROR' },
        { status: 500 }
      );
    }

    return NextResponse.json({ data });
  }
);
