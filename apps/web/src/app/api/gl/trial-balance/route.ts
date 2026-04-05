import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { trialBalanceQuerySchema, type TrialBalanceQuery } from '@/lib/validations/gl';

export const GET = apiQueryHandler(
  trialBalanceQuerySchema,
  async (params: TrialBalanceQuery, ctx) => {
    let query = ctx.supabase.from('v_trial_balance').select('*');

    if (params.location_id && params.location_id !== 'all') {
      query = query.eq('location_id', params.location_id);
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
