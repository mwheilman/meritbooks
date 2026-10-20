export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createCompany, REV_REC_METHODS } from '@/lib/companies/create-company';
import { requirePortfolioContext } from '@/lib/companies/portfolio/guard';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { seedChartOfAccounts } from '@/lib/services/coa-seed';
import type { BulkCreateResponse, BulkCreateRowResult } from '@/lib/companies/portfolio/types';

/**
 * POST /api/onboarding/portfolio/companies — bulk-create companies.
 *
 * Body: { companies: [{ name, shortCode?, industry?, fiscalYearStartMonth?, revRecMethod? }] }
 * Each row goes through the single company-creation path (`createCompany`): location +
 * prior/current/next-year fiscal periods (prior months SOFT_CLOSE). Rows are created one
 * at a time and reported individually — one bad row never blocks the rest. The org's
 * chart of accounts is seeded once (idempotent) if anything was created.
 *
 * Gate: authenticated + settings_acct:edit + resolved org (fail closed). RLS client.
 */

const MAX_COMPANIES = 250;

const rowSchema = z.object({
  name: z.string().trim().min(1, 'Company name is required').max(200),
  shortCode: z.string().trim().max(10).optional().nullable(),
  industry: z.string().trim().max(100).optional().nullable(),
  fiscalYearStartMonth: z.coerce.number().int().min(1).max(12).optional().nullable(),
  revRecMethod: z.enum(REV_REC_METHODS).optional().nullable(),
});

const bodySchema = z.object({
  companies: z.array(rowSchema).min(1, 'Add at least one company').max(MAX_COMPANIES, `Up to ${MAX_COMPANIES} companies at a time`),
});

export async function POST(req: Request) {
  const ctx = await requirePortfolioContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;

  const raw = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.issues },
      { status: 422 },
    );
  }

  // core.locations write: service role after settings_acct:edit (requirePortfolioContext), mig 167.
  const admin = createAdminSupabase();
  const results: BulkCreateRowResult[] = [];
  for (const [index, c] of parsed.data.companies.entries()) {
    const res = await createCompany(supabase, {
      orgId,
      name: c.name,
      shortCode: c.shortCode || null,
      industry: c.industry || null,
      fiscalYearStartMonth: c.fiscalYearStartMonth ?? 1,
      revRecMethod: c.revRecMethod ?? null,
    }, { writer: admin });
    results.push(
      res.ok
        ? { index, name: c.name, ok: true, locationId: res.locationId, shortCode: res.shortCode, periodsCreated: res.periodsCreated }
        : { index, name: c.name, ok: false, error: res.error, status: res.status },
    );
  }

  const created = results.filter((r) => r.ok).length;
  let accountCount: number | null = null;
  if (created > 0) {
    try {
      accountCount = (await seedChartOfAccounts(supabase, orgId)).totalAccounts;
    } catch (e) {
      console.error('[portfolio/companies] COA seed error:', e instanceof Error ? e.message : e);
    }
  }

  const body: BulkCreateResponse = { results, created, failed: results.length - created, accountCount };
  return NextResponse.json(body, { status: created > 0 ? 201 : 200 });
}
