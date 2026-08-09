export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler, type ApiContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { runInsuranceAmortizations, InsuranceAmortizationError } from '@/lib/insurance/amortize';
import { runAmortizationSchema, type RunAmortizationInput } from '@/lib/insurance/schema';

/**
 * POST /api/insurance/schedules/run — record insurance amortization for the period.
 *
 * Posts DR Insurance Expense / CR Prepaid Insurance for every due, not-yet-run period
 * up to `as_of` (default: today). Pass `schedule_id` to record a single schedule (the
 * per-row "record this period" action) or omit it to run every active schedule. Gated
 * on `journal_entries:post` — this WRITES balanced GL entries through the deterministic
 * posting engine; the `insurance_amortization_runs` unique index guards a double post.
 */
export const POST = apiHandler(
  runAmortizationSchema,
  async (body: RunAmortizationInput, ctx: ApiContext): Promise<NextResponse> => {
    if (!ctx.orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

    const guard = await requirePermission(ctx.userId, 'journal_entries', 'post');
    if (!guard.ok) return guard.response;

    const asOf = body.as_of ?? new Date().toISOString().slice(0, 10);

    try {
      const result = await runInsuranceAmortizations(ctx.supabase, ctx.orgId, {
        asOf,
        scheduleId: body.schedule_id,
      });
      return NextResponse.json({ result });
    } catch (e) {
      const msg = e instanceof InsuranceAmortizationError ? e.message : 'Failed to run insurance amortizations';
      console.error('[insurance/schedules/run] failed:', e instanceof Error ? e.message : e);
      return NextResponse.json({ error: msg, code: 'RUN_FAILED' }, { status: 500 });
    }
  },
);
