export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ensureFiscalPeriods } from '@/lib/companies/create-company';
import { requirePortfolioContext } from '@/lib/companies/portfolio/guard';
import { serviceWriter } from '@/lib/db/scoped-writer';

/**
 * POST /api/onboarding/portfolio/periods — add missing fiscal periods to a company.
 *
 * Repairs companies created before every creation path went through createCompany
 * (e.g. the old "Companies / Entities" CSV import inserted bare locations with no
 * periods, so every later post to them failed). Inserts only the months that don't
 * exist yet (prior/current/next calendar year; earlier months SOFT_CLOSE, current and
 * later OPEN) — existing periods keep their status untouched.
 *
 * Body: { locationId }. Gate: authenticated + settings_acct:edit + resolved org.
 */

const bodySchema = z.object({ locationId: z.string().uuid() });

export async function POST(req: Request) {
  const ctx = await requirePortfolioContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'A valid company is required', code: 'VALIDATION_ERROR' }, { status: 422 });

  const { data: loc } = await supabase
    .schema('core').from('locations')
    .select('id, name')
    .eq('org_id', orgId)
    .eq('id', parsed.data.locationId)
    .maybeSingle();
  if (!loc) return NextResponse.json({ error: 'Company not found', code: 'NOT_FOUND' }, { status: 404 });

  // fiscal_periods is SELECT-only for members (migration 171): the company was read
  // through the caller's RLS client above (org + client scope); write with the service role.
  const res = await ensureFiscalPeriods(serviceWriter(), orgId, parsed.data.locationId);
  if (!res.ok) return NextResponse.json({ error: `Could not add fiscal periods: ${res.error}` }, { status: 500 });
  return NextResponse.json({ created: res.created });
}
