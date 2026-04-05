export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiQueryHandler } from '@/lib/api-handler';
import { calculateOverheadRate } from '@/lib/services/overhead-rate';

// Use string params (from query string) and transform manually in handler
const querySchema = z.object({
  year: z.string().regex(/^\d{4}$/),
  month: z.string().regex(/^\d{1,2}$/),
});

export const GET = apiQueryHandler(
  querySchema,
  async (params, ctx) => {
    const result = await calculateOverheadRate(
      ctx.supabase,
      ctx.orgId ?? '',
      parseInt(params.year, 10),
      parseInt(params.month, 10),
    );

    return NextResponse.json(result);
  }
);
