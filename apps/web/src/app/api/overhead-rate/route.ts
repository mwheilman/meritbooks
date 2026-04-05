import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiQueryHandler } from '@/lib/api-handler';
import { calculateOverheadRate } from '@/lib/services/overhead-rate';

const querySchema = z.object({
  year: z.string().regex(/^\d{4}$/).transform(Number),
  month: z.string().regex(/^\d{1,2}$/).transform(Number),
});

export const GET = apiQueryHandler(
  querySchema,
  async (params, ctx) => {
    const result = await calculateOverheadRate(
      ctx.supabase,
      ctx.orgId ?? '',
      params.year,
      params.month,
    );

    return NextResponse.json(result);
  }
);
