export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { z } from 'zod';
import {
  computeBookVsTaxDepreciation,
  proposeDepreciationDifference,
  confirmDepreciationDifference,
  BOOK_TAX_DEPR_FEATURE,
} from '@/lib/tax/book-tax-depr-feed';

/**
 * Tax depreciation (MACRS) + book-vs-tax feed to Schedule M-1.
 *
 * GET  /api/tax/depreciation?tax_year=YYYY — read-only. The per-asset MACRS/§179/bonus tax
 *      schedule and the book-vs-tax reconciliation for the year (posted BOOK depreciation vs
 *      the deterministic tax schedule), plus any open M-1 proposal and whether the year's
 *      override already exists. Nothing posts or moves money. RLS-scoped.
 * POST /api/tax/depreciation — { action: 'propose' | 'confirm', ... }. `propose` writes a
 *      PROPOSED ai_decisions row carrying the year's temporary difference; `confirm` writes
 *      the pinned book_tax_line_overrides row the M-1 engine reads. Canon §3: the M-1 number
 *      is never written as fact without a human confirming. Writes gated on
 *      journal_entries:create (the control-family guard; a dedicated `tax` permission is the
 *      follow-up, mirroring the tagging surface).
 */

function currentYear(): number {
  return new Date().getUTCFullYear();
}

export async function GET(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization found', code: 'NO_ORG' }, { status: 400 });

  const yearParam = new URL(request.url).searchParams.get('tax_year');
  const taxYear = yearParam && /^\d{4}$/.test(yearParam) ? Number(yearParam) : currentYear();

  let recon;
  try {
    recon = await computeBookVsTaxDepreciation(supabase, taxYear);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'compute error', code: 'QUERY_ERROR' }, { status: 500 });
  }

  // Any open proposal for this year + whether its override already landed.
  const { data: proposals } = await supabase
    .from('ai_decisions')
    .select('id, status, proposed_output')
    .eq('feature', BOOK_TAX_DEPR_FEATURE)
    .eq('status', 'PROPOSED');
  const openProposal = ((proposals ?? []) as Array<{ id: string; proposed_output?: { dedup_key?: string; code?: string; amount_cents?: number; target_gl_entry_line_id?: string | null } }>)
    .find((r) => r.proposed_output?.dedup_key === `booktaxdepr:${taxYear}`);

  let overrideExists = false;
  if (recon.difference) {
    const { data: existingOverride } = await supabase
      .from('book_tax_line_overrides')
      .select('id')
      .in('m_line_code', ['BOOK_DEPR_EXCESS', 'TAX_DEPR_EXCESS'])
      .limit(1);
    overrideExists = ((existingOverride ?? []) as unknown[]).length > 0;
  }

  // NOTE: return the payload BARE (not wrapped in { data }). The client page reads
  // `data.assets` / `data.difference` directly via useQuery, and the app-wide
  // convention for these feature endpoints (see /api/consolidation/statements) is a
  // bare body. Wrapping it double-nested the payload and crashed the page on
  // `data.assets.length`.
  return NextResponse.json({
    ...recon,
    openProposal: openProposal
      ? {
          id: openProposal.id,
          code: openProposal.proposed_output?.code ?? null,
          amountCents: Number(openProposal.proposed_output?.amount_cents ?? 0),
          targetLineFound: Boolean(openProposal.proposed_output?.target_gl_entry_line_id),
        }
      : null,
    overrideExists,
  });
}

const postSchema = z.object({
  action: z.enum(['propose', 'confirm']),
  tax_year: z.number().int().min(1990).max(2100).optional(),
  decision_id: z.string().uuid().optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization found', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'journal_entries', 'create');
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, { status: 422 });
  }

  try {
    if (parsed.data.action === 'propose') {
      const taxYear = parsed.data.tax_year ?? currentYear();
      const summary = await proposeDepreciationDifference(supabase, { orgId, userId, taxYear });
      return NextResponse.json(summary);
    }
    // confirm
    if (!parsed.data.decision_id) {
      return NextResponse.json({ error: 'decision_id is required to confirm', code: 'MISSING_PARAM' }, { status: 400 });
    }
    const result = await confirmDepreciationDifference(supabase, { orgId, userId, decisionId: parsed.data.decision_id });
    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? 'Confirm failed', code: 'CONFIRM_ERROR' }, { status: 422 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error', code: 'SERVER_ERROR' }, { status: 500 });
  }
}
