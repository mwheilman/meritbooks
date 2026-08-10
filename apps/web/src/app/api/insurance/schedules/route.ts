export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext, apiHandler, type ApiContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import {
  listInsuranceSchedules,
  createInsuranceSchedule,
  getInsuranceTieOut,
  InsuranceAmortizationError,
} from '@/lib/insurance/amortize';
import {
  resolveInsuranceExpenseAccount,
  resolvePrepaidInsuranceAccount,
} from '@/lib/insurance/insurance-accounts';
import { derivePeriods } from '@/lib/prepaid/schedule';
import { createAmortizationSchema, type CreateAmortizationInput } from '@/lib/insurance/schema';

/**
 * /api/insurance/schedules
 *
 * GET  — list every insurance premium-amortization schedule with remaining prepaid
 *        balance + the next period (period, amount, post date). Read-only; RLS-scoped.
 * POST — set up amortization for a policy's up-front premium (DR insurance expense /
 *        CR prepaid insurance, straight-line). Gated on `journal_entries:create`.
 *        Account legs resolve by ROLE (INSURANCE_EXPENSE / PREPAID_INSURANCE),
 *        coverage-type aware; if a leg can't be resolved we fail with a clear message
 *        so the human picks it (canon §3 — never post a guess).
 */

export async function GET(): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;

  try {
    const schedules = await listInsuranceSchedules(ctx.supabase);
    // Subledger⇄GL tie-out: schedules' remaining premium vs the prepaid-insurance GL
    // control account(s). Soft — a missing account / view error must not 500 the list.
    let tieOut = null;
    if (ctx.orgId) {
      try {
        tieOut = await getInsuranceTieOut(ctx.supabase, ctx.orgId, { schedules });
      } catch (e) {
        console.error('[insurance/schedules] tie-out failed:', e instanceof Error ? e.message : e);
      }
    }
    const summary = {
      total: schedules.length,
      active: schedules.filter((s) => s.status === 'ACTIVE').length,
      completed: schedules.filter((s) => s.status === 'COMPLETED').length,
      remaining_cents: schedules.reduce((s, r) => s + (r.status === 'ACTIVE' ? r.remaining_cents : 0), 0),
      tie_out: tieOut,
    };
    return NextResponse.json({ data: schedules, summary });
  } catch (e) {
    console.error('[insurance/schedules] list failed:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Failed to load amortization schedules', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

interface PolicyRow {
  id: string;
  location_id: string | null;
  coverage_type: string | null;
}

/** Resolve a concrete posting location: explicit → policy → the org's first location. */
async function resolveLocationId(ctx: ApiContext, explicit: string | null | undefined, policyLocation: string | null): Promise<string | null> {
  if (explicit) return explicit;
  if (policyLocation) return policyLocation;
  const { data } = await ctx.supabase.schema('core').from('locations').select('id').limit(1).maybeSingle<{ id: string }>();
  return data?.id ?? null;
}

export const POST = apiHandler(
  createAmortizationSchema,
  async (body: CreateAmortizationInput, ctx: ApiContext): Promise<NextResponse> => {
    if (!ctx.orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

    const guard = await requirePermission(ctx.userId, 'journal_entries', 'create');
    if (!guard.ok) return guard.response;

    // Load the policy (RLS-scoped) for coverage type + fallback location.
    const { data: policy, error: policyErr } = await ctx.supabase
      .from('insurance_policies')
      .select('id, location_id, coverage_type')
      .eq('id', body.policy_id)
      .maybeSingle<PolicyRow>();
    if (policyErr) return NextResponse.json({ error: policyErr.message, code: 'POLICY_LOOKUP_FAILED' }, { status: 500 });
    if (!policy) return NextResponse.json({ error: 'Policy not found', code: 'NO_POLICY' }, { status: 404 });

    // Term: explicit months, or derive from the coverage end date.
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

    const locationId = await resolveLocationId(ctx, body.location_id, policy.location_id);
    if (!locationId) {
      return NextResponse.json(
        { error: 'No posting location could be resolved for this policy. Set the policy company/location first.', code: 'NO_LOCATION' },
        { status: 422 },
      );
    }

    // Resolve the two legs (explicit override → role → coverage default → fail-closed).
    let expenseAccountId = body.expense_account_id ?? null;
    if (!expenseAccountId) {
      const acct = await resolveInsuranceExpenseAccount(ctx.supabase, policy.coverage_type, locationId);
      expenseAccountId = acct?.id ?? null;
    }
    if (!expenseAccountId) {
      return NextResponse.json(
        {
          error:
            'No insurance-expense account is set up for this tenant. Map the INSURANCE_EXPENSE role (or create an insurance expense account) and pick it explicitly.',
          code: 'NO_EXPENSE_ACCOUNT',
        },
        { status: 422 },
      );
    }

    let prepaidAccountId = body.prepaid_account_id ?? null;
    if (!prepaidAccountId) {
      const acct = await resolvePrepaidInsuranceAccount(ctx.supabase, locationId);
      prepaidAccountId = acct?.id ?? null;
    }
    if (!prepaidAccountId) {
      return NextResponse.json(
        {
          error:
            'No prepaid-insurance asset account is set up for this tenant. Create/mark a "Prepaid Insurance" asset account (or map the PREPAID_INSURANCE role) and pick it explicitly.',
          code: 'NO_PREPAID_ACCOUNT',
        },
        { status: 422 },
      );
    }

    try {
      const { id } = await createInsuranceSchedule(ctx.supabase, {
        orgId: ctx.orgId,
        policyId: body.policy_id,
        locationId,
        expenseAccountId,
        prepaidAccountId,
        totalCents: body.total_cents,
        months,
        startDate: body.start_date,
        departmentId: body.department_id ?? null,
        memo: body.memo ?? null,
        createdByUser: ctx.userId,
      });
      return NextResponse.json(
        { id, expense_account_id: expenseAccountId, prepaid_account_id: prepaidAccountId },
        { status: 201 },
      );
    } catch (e) {
      const msg = e instanceof InsuranceAmortizationError ? e.message : 'Failed to create amortization schedule';
      console.error('[insurance/schedules] create failed:', e instanceof Error ? e.message : e);
      return NextResponse.json({ error: msg, code: 'CREATE_FAILED' }, { status: 400 });
    }
  },
);
