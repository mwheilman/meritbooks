export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { locationQuerySchema } from '@/lib/validations/transactions';

/**
 * GET /api/locations
 * Returns active locations (companies/entities) for the org.
 */
export const GET = apiQueryHandler(
  locationQuerySchema,
  async (_params, ctx) => {
    const { data, error } = await ctx.supabase
      .schema('core').from('locations')
      .select('id, name, short_code, industry, require_department, require_class, require_item')
      .eq('is_active', true)
      .order('name');

    if (error) {
      return NextResponse.json(
        { error: error.message, code: 'QUERY_ERROR' },
        { status: 500 }
      );
    }

    return NextResponse.json(data ?? []);
  }
);
