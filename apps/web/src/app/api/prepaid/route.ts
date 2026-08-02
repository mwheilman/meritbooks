export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext, apiHandler, type ApiContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { listPrepaidSchedules, createPrepaidSchedule, PrepaidError } from '@/lib/prepaid/amortize';
import { resolvePrepaidAssetAccount } from '@/lib/prepaid/prepaid-asset';
import { derivePeriods } from '@/lib/prepaid/schedule';
import { createPrepaidSchema, type CreatePrepaidBody } from '@/lib/prepaid/schema';

/**
 * /api/prepaid
 *
 * GET  — list every prepaid amortization schedule with remaining balance + the
 *        next amortization (period, amount, post date). Read-only; RLS-scoped.
 * POST — set up a prepaid schedule (DR expense / CR prepaid asset, straight-line).
 *        Gated on `journal_entries:create` (a prepaid persists a recurring GL post
 *        template). The prepaid-asset credit leg is resolved by role/name when the
 *        client doesn't pass one; if it still can't be resolved, we fail with a
 *        clear message so the human picks it (canon §3 — never post a guess).
 */

export async function GET(): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;

  try {
    const schedules = await listPrepaidSchedules(ctx.supabase);
    const summary = {
      total: schedules.length,
      active: schedules.filter((s) => s.status === 'ACTIVE').length,
      completed: schedules.filter((s) => s.status === 'COMPLETED').length,
      remaining_cents: schedules.reduce((s, r) => s + (r.status === 'ACTIVE' ? r.remaining_cents : 0), 0),
    };
    return NextResponse.json({ data: schedules, summary });
  } catch (e) {
    console.error('[prepaid] list failed:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Failed to load prepaid schedules', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

export const POST = apiHandler(
  createPrepaidSchema,
  async (body: CreatePrepaidBody, ctx: ApiContext): Promise<NextResponse> => {
    if (!ctx.orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

    const guard = await requirePermission(ctx.userId, 'journal_entries', 'create');
    if (!guard.ok) return guard.response;

    // Resolve the term: explicit months, or derive from the coverage end date.
    let months = body.months;
    if (months == null && body.end_date) {
      try {
        months = derivePeriods(body.start_date, body.end_date);
      } catch {
        return NextResponse.json({ error: 'Invalid coverage dates', code: 'BAD_DATES' }, { status: 400 });
      }
    }
    if (!months || months < 1) {
      return NextResponse.json({ error: 'A term (months) or coverage end date is required', code: 'NO_TERM' }, { status: 400 });
    }

    // Resolve the prepaid-asset credit leg (explicit → role/name → fail-closed).
    let prepaidAssetId = body.prepaid_account_id ?? null;
    if (!prepaidAssetId) {
      const resolved = await resolvePrepaidAssetAccount(ctx.supabase, body.location_id);
      prepaidAssetId = resolved?.id ?? null;
    }
    if (!prepaidAssetId) {
      return NextResponse.json(
        {
          error:
            'No prepaid-expenses asset account is set up for this tenant. Create/mark a "Prepaid Expenses" asset account (or map the PREPAID_ASSET role) and pick it explicitly.',
          code: 'NO_PREPAID_ASSET',
        },
        { status: 422 },
      );
    }

    try {
      const { id } = await createPrepaidSchedule(ctx.supabase, {
        orgId: ctx.orgId,
        locationId: body.location_id,
        expenseAccountId: body.expense_account_id,
        prepaidAssetId,
        totalCents: body.total_cents,
        months,
        startDate: body.start_date,
        departmentId: body.department_id ?? null,
        sourceType: body.source_type ?? 'MANUAL',
        sourceId: body.source_id ?? null,
        memo: body.memo ?? null,
      });
      return NextResponse.json({ id, prepaid_account_id: prepaidAssetId }, { status: 201 });
    } catch (e) {
      const msg = e instanceof PrepaidError ? e.message : 'Failed to create prepaid schedule';
      console.error('[prepaid] create failed:', e instanceof Error ? e.message : e);
      return NextResponse.json({ error: msg, code: 'CREATE_FAILED' }, { status: 400 });
    }
  },
);
