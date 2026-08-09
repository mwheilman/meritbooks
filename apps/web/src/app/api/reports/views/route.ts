export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler, apiQueryHandler, type ApiContext } from '@/lib/api-handler';

/**
 * Saved report VIEWS — list + create. A report view is a named, one-click snapshot
 * of the interactive /reports screen: which report, over what period, for which
 * companies/industries, on what basis, summary/detail, and comparative mode. It is
 * re-applied to the live selectors and re-run against today's ledger — the scope is
 * always re-validated by the consolidation gate + RLS, never trusted from the blob.
 *
 * Distinct from report_packs (104), which are multi-report NL-compiler specs with
 * PDF/Excel export + scheduled email delivery.
 *
 * RLS-scoped (ctx.supabase); public.report_views isolates by get_org_id(). DEGRADES
 * SAFE: if the table has not been created yet (migration 138 pending) both verbs
 * report `available: false` so the UI hides the feature and ad-hoc reporting is
 * unaffected.
 */

function isMissingRelation(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === '42P01' || /relation .* does not exist/i.test(error.message ?? '');
}

const VIEW_COLUMNS = 'id, name, report_key, config, created_by, created_at, updated_at';

// The persisted selector snapshot. Kept permissive (passthrough) so the viewer can
// evolve its config without a schema migration, but the known keys are typed.
const configSchema = z
  .object({
    periodKey: z.string().max(40).optional(),
    customS: z.string().max(20).optional(),
    customE: z.string().max(20).optional(),
    selectedLocs: z.array(z.string()).max(200).optional(),
    selectedIndustries: z.array(z.string()).max(100).optional(),
    basis: z.enum(['accrual', 'cash']).optional(),
    viewMode: z.enum(['summary', 'detail']).optional(),
    compareMode: z.enum(['none', 'prior_period', 'prior_year', 'budget']).optional(),
  })
  .passthrough();

const createViewSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  report_key: z.string().trim().min(1).max(60),
  config: configSchema,
});

export const GET = apiQueryHandler(null, async (_params, ctx: ApiContext) => {
  if (!ctx.orgId) {
    return NextResponse.json({ error: 'No organization in session', code: 'NO_ORG' }, { status: 400 });
  }

  const { data, error } = await ctx.supabase
    .from('report_views')
    .select(VIEW_COLUMNS)
    .order('created_at', { ascending: false });

  if (error) {
    if (isMissingRelation(error)) {
      return NextResponse.json({ available: false, views: [] });
    }
    return NextResponse.json({ error: error.message, code: 'DB_ERROR' }, { status: 500 });
  }

  return NextResponse.json({ available: true, views: data ?? [] });
});

export const POST = apiHandler(createViewSchema, async (body, ctx: ApiContext) => {
  if (!ctx.orgId) {
    return NextResponse.json({ error: 'No organization in session', code: 'NO_ORG' }, { status: 400 });
  }

  const { data, error } = await ctx.supabase
    .from('report_views')
    .insert({
      org_id: ctx.orgId,
      name: body.name,
      report_key: body.report_key,
      config: body.config,
      created_by: ctx.userId,
    })
    .select(VIEW_COLUMNS)
    .single();

  if (error) {
    if (isMissingRelation(error)) {
      return NextResponse.json(
        {
          error: 'Saved views are not available yet (database migration pending).',
          code: 'VIEWS_UNAVAILABLE',
        },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: error.message, code: 'DB_ERROR' }, { status: 500 });
  }

  return NextResponse.json({ view: data }, { status: 201 });
});
