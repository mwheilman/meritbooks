export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import { loadAccounts, loadPolicyRows } from '@/lib/close/flux/load';
import { DEFAULT_FLUX_POLICY, pickPolicy, policyFromRow } from '@/lib/close/flux/materiality';
import { resetCompanyPolicy, saveFluxPolicy } from '@/lib/close/flux/service';
import { COMPARISON_BASES, FLUX_DIMENSIONS, THRESHOLD_MODES } from '@/lib/close/flux/types';
import { fluxErrorResponse, noOrg } from '@/lib/close/flux/route-support';

/**
 * Flux materiality policy (FPB-financial-reports §5 A-3E.1).
 *   GET    ?location_id  — tenant default, the company's own row (if any), the effective
 *                          policy, and the accounts / groups an override can target.
 *   PUT                  — save the tenant default (location_id null) or a company policy.
 *   DELETE ?location_id  — drop the company's row so it inherits the tenant default.
 * Reading needs close_mgmt:view; changing needs close_mgmt:manage.
 */

const getSchema = z.object({ location_id: z.string().uuid().optional() });

export const GET = apiQueryHandler(getSchema, async (q, ctx) => {
  if (!ctx.orgId) return noOrg();
  const guard = await requirePermission(ctx.userId, 'close_mgmt', 'view');
  if (!guard.ok) return guard.response;
  try {
    const [rows, { accounts }] = await Promise.all([loadPolicyRows(ctx.supabase, ctx.orgId), loadAccounts(ctx.supabase)]);
    const tenantRow = rows.find((r) => r.location_id === null) ?? null;
    const companyRow = q.location_id ? rows.find((r) => r.location_id === q.location_id) ?? null : null;
    const groups = new Map<string, string>();
    for (const a of accounts) if (a.groupId) groups.set(a.groupId, a.groupName ?? 'Group');
    return NextResponse.json({
      tenant: tenantRow ? policyFromRow(tenantRow, 'TENANT') : DEFAULT_FLUX_POLICY,
      company: companyRow ? policyFromRow(companyRow, 'COMPANY') : null,
      effective: q.location_id ? pickPolicy(rows, q.location_id) : tenantRow ? policyFromRow(tenantRow, 'TENANT') : DEFAULT_FLUX_POLICY,
      accounts: accounts
        .map((a) => ({ id: a.id, number: a.number, name: a.name, type: a.type, groupId: a.groupId, groupName: a.groupName }))
        .sort((x, y) => x.number.localeCompare(y.number)),
      groups: [...groups.entries()].map(([id, name]) => ({ id, name })).sort((x, y) => x.name.localeCompare(y.name)),
    });
  } catch (e) {
    return fluxErrorResponse(e, 'close/flux/policy GET');
  }
});

const overrideSchema = z.object({
  scope: z.enum(['TYPE', 'GROUP', 'ACCOUNT']),
  key: z.string().min(1).max(64),
  absThresholdCents: z.number().int().min(0).max(1e13).nullable().optional(),
  pctThresholdBps: z.number().int().min(0).max(1_000_000).nullable().optional(),
  mode: z.enum(THRESHOLD_MODES as unknown as [string, ...string[]]).nullable().optional(),
  excluded: z.boolean().nullable().optional(),
});

const putSchema = z.object({
  location_id: z.string().uuid().nullable(),
  review_required: z.boolean(),
  threshold_mode: z.enum(THRESHOLD_MODES as unknown as [string, ...string[]]),
  abs_threshold_cents: z.number().int().min(0).max(1e13),
  pct_threshold_bps: z.number().int().min(0).max(1_000_000),
  comparison_basis: z.enum(COMPARISON_BASES as unknown as [string, ...string[]]),
  dimension: z.enum(FLUX_DIMENSIONS as unknown as [string, ...string[]]),
  include_pnl: z.boolean(),
  include_balance_sheet: z.boolean(),
  overrides: z.array(overrideSchema).max(100),
  excluded_account_ids: z.array(z.string().uuid()).max(1000),
});

export const PUT = apiHandler(putSchema, async (b, ctx) => {
  if (!ctx.orgId) return noOrg();
  const guard = await requirePermission(ctx.userId, 'close_mgmt', 'manage', { locationId: b.location_id });
  if (!guard.ok) return guard.response;
  try {
    await saveFluxPolicy(ctx.supabase, ctx.orgId, ctx.userId, {
      locationId: b.location_id,
      reviewRequired: b.review_required,
      thresholdMode: b.threshold_mode as (typeof THRESHOLD_MODES)[number],
      absThresholdCents: b.abs_threshold_cents,
      pctThresholdBps: b.pct_threshold_bps,
      comparisonBasis: b.comparison_basis as (typeof COMPARISON_BASES)[number],
      dimension: b.dimension as (typeof FLUX_DIMENSIONS)[number],
      includePnl: b.include_pnl,
      includeBalanceSheet: b.include_balance_sheet,
      overrides: b.overrides.map((o) => ({ ...o, mode: (o.mode ?? null) as (typeof THRESHOLD_MODES)[number] | null })),
      excludedAccountIds: b.excluded_account_ids,
    });
    await logHumanAction(ctx.supabase, ctx.userId, ctx.orgId, {
      action: 'close.flux.policy',
      subjectTable: 'flux_materiality_policies',
      subjectId: null,
      summary: `Updated the ${b.location_id ? 'company' : 'default'} flux materiality policy`,
      locationId: b.location_id,
      metadata: { threshold_mode: b.threshold_mode, abs_threshold_cents: b.abs_threshold_cents, pct_threshold_bps: b.pct_threshold_bps, comparison_basis: b.comparison_basis, review_required: b.review_required },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fluxErrorResponse(e, 'close/flux/policy PUT');
  }
});

const deleteSchema = z.object({ location_id: z.string().uuid() });

export async function DELETE(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const handler = apiHandler(null, async (_b, ctx) => {
    if (!ctx.orgId) return noOrg();
    const parsed = deleteSchema.safeParse({ location_id: url.searchParams.get('location_id') });
    if (!parsed.success) return NextResponse.json({ error: 'location_id is required', code: 'VALIDATION_ERROR' }, { status: 422 });
    const guard = await requirePermission(ctx.userId, 'close_mgmt', 'manage', { locationId: parsed.data.location_id });
    if (!guard.ok) return guard.response;
    try {
      await resetCompanyPolicy(ctx.supabase, ctx.orgId, parsed.data.location_id);
      await logHumanAction(ctx.supabase, ctx.userId, ctx.orgId, {
        action: 'close.flux.policy.reset',
        subjectTable: 'flux_materiality_policies',
        subjectId: null,
        summary: 'Reset a company flux policy to the default',
        locationId: parsed.data.location_id,
      });
      return NextResponse.json({ ok: true });
    } catch (e) {
      return fluxErrorResponse(e, 'close/flux/policy DELETE');
    }
  });
  return handler(request);
}
