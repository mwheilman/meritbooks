export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { jobSearchSchema, type JobSearchQuery } from '@/lib/validations/transactions';

/**
 * GET /api/jobs/search?location_id=...&q=...
 * Search active jobs for a given location. Used by the bank feed edit panel
 * when assigning a transaction to a job (required for COGS accounts).
 */
export const GET = apiQueryHandler(
  jobSearchSchema,
  async (params: JobSearchQuery, ctx) => {
    let query = ctx.supabase
      .from('jobs')
      .select('id, job_number, name, customer_name, job_type, status')
      .eq('location_id', params.location_id)
      .in('status', ['ACTIVE', 'BID'])
      .order('job_number')
      .limit(20);

    if (params.q && params.q.trim().length > 0) {
      const term = params.q.trim();
      // Search on job_number prefix or name ilike
      query = query.or(`job_number.ilike.${term}%,name.ilike.%${term}%`);
    }

    const { data, error } = await query;

    if (error) {
      return NextResponse.json(
        { error: error.message, code: 'QUERY_ERROR' },
        { status: 500 }
      );
    }

    return NextResponse.json(data ?? []);
  }
);
