export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { scopedWriter, assertOrgRefs, isWriteScopeError } from '@/lib/db/scoped-writer';
import {
  DEFAULT_DUNNING_POLICY,
  dunningPolicyInputSchema,
  policyFromRow,
  type DunningPolicyRow,
} from '@/lib/collections/dunning-policy';
import {
  DEFAULT_LATE_FEE_POLICY,
  lateFeePolicyFromRow,
  lateFeePolicyInputSchema,
  type LateFeePolicyRow,
} from '@/lib/collections/late-fees';
import { logHumanAction } from '@/lib/trust/action-log';

const DUNNING_COLS = 'location_id, enabled, send_mode, steps, stop_on_promise, stop_on_dispute, excluded_customer_ids, min_balance_cents, updated_at, updated_by';
const LATE_COLS = 'location_id, enabled, method, flat_fee_cents, rate_bps, grace_days, frequency, min_fee_cents, max_fee_cents, max_total_per_invoice_cents, min_balance_cents, apply_to, customer_ids, income_account_id, updated_at, updated_by';

/**
 * GET /api/automation/policies — the tenant's dunning ladder + late-fee policies (the tenant
 * default row and any company overrides), with defaults filled in, for Settings → Automation.
 * AUTHZ: settings_system:view. RLS-scoped read of the caller's org.
 */
export const GET = apiQueryHandler(null, async (_q, ctx) => {
  const guard = await requirePermission(ctx.userId, 'settings_system', 'view');
  if (!guard.ok) return guard.response;
  const [d, l, locs, accts, custs] = await Promise.all([
    ctx.supabase.from('dunning_policies').select(DUNNING_COLS).eq('org_id', guard.orgId),
    ctx.supabase.from('late_fee_policies').select(LATE_COLS).eq('org_id', guard.orgId),
    ctx.supabase.schema('core').from('locations').select('id, name, short_code').eq('is_active', true).order('name'),
    ctx.supabase.from('accounts').select('id, account_number, name, account_type').eq('org_id', guard.orgId).eq('is_active', true).in('account_type', ['REVENUE', 'OTHER']).order('account_number').limit(500),
    ctx.supabase.schema('core').from('customers').select('id, name, display_name').eq('org_id', guard.orgId).order('name').limit(1000),
  ]);
  if (d.error || l.error) {
    return NextResponse.json({ error: d.error?.message ?? l.error?.message, code: 'DB_ERROR' }, { status: 500 });
  }
  const dRows = (d.data ?? []) as Array<DunningPolicyRow & { updated_at: string; updated_by: string | null }>;
  const lRows = (l.data ?? []) as Array<LateFeePolicyRow & { updated_at: string; updated_by: string | null }>;
  return NextResponse.json({
    companies: ((locs.data ?? []) as Array<{ id: string; name: string; short_code: string | null }>).map((c) => ({ id: c.id, name: c.name, shortCode: c.short_code })),
    incomeAccounts: ((accts.data ?? []) as Array<{ id: string; account_number: string; name: string; account_type: string }>).map((a) => ({ id: a.id, label: `${a.account_number} · ${a.name}`, type: a.account_type })),
    customers: ((custs.data ?? []) as Array<{ id: string; name: string; display_name: string | null }>).map((c) => ({ id: c.id, name: c.display_name || c.name })),
    dunning: {
      tenant: dRows.find((r) => r.location_id === null) ? policyFromRow(dRows.find((r) => r.location_id === null) as DunningPolicyRow) : DEFAULT_DUNNING_POLICY,
      tenantSaved: dRows.some((r) => r.location_id === null),
      companies: dRows.filter((r) => r.location_id !== null).map((r) => ({ locationId: r.location_id, updatedAt: r.updated_at, policy: policyFromRow(r) })),
    },
    lateFees: {
      tenant: lRows.find((r) => r.location_id === null) ? lateFeePolicyFromRow(lRows.find((r) => r.location_id === null) as LateFeePolicyRow) : DEFAULT_LATE_FEE_POLICY,
      tenantSaved: lRows.some((r) => r.location_id === null),
      companies: lRows.filter((r) => r.location_id !== null).map((r) => ({ locationId: r.location_id, updatedAt: r.updated_at, policy: lateFeePolicyFromRow(r) })),
    },
  });
});

/**
 * Save one (org, location) policy row: update it when it exists, else insert. (Read-then-
 * write rather than ON CONFLICT so the tenant row — location_id NULL — matches reliably.)
 */
async function savePolicyRow(
  w: SupabaseClient,
  table: 'dunning_policies' | 'late_fee_policies',
  orgId: string,
  locationId: string | null,
  values: Record<string, unknown>,
): Promise<string | null> {
  let q = w.from(table).select('id').eq('org_id', orgId);
  q = locationId ? q.eq('location_id', locationId) : q.is('location_id', null);
  const { data: existing, error: readErr } = await q.maybeSingle();
  if (readErr) return readErr.message;
  if (existing) {
    const { error } = await w.from(table).update(values).eq('id', (existing as { id: string }).id).eq('org_id', orgId);
    return error ? error.message : null;
  }
  const { error } = await w.from(table).insert({ ...values, org_id: orgId, location_id: locationId });
  return error ? error.message : null;
}

const putSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dunning'), policy: z.unknown() }),
  z.object({ kind: z.literal('late_fee'), policy: z.unknown() }),
  z.object({ kind: z.literal('remove_company'), policy_kind: z.enum(['dunning', 'late_fee']), location_id: z.string().uuid() }),
]);

/**
 * PUT /api/automation/policies { kind: 'dunning' | 'late_fee', policy } — save the tenant
 * default (location_id null) or one company's override. { kind: 'remove_company' } drops a
 * company override (it falls back to the tenant default).
 *
 * AUTHZ: settings_system:edit. The tables are SELECT-only for members (migration 184): the
 * company (if any) and the referenced income account / customers are verified to belong to
 * the org, then the scoped service writer upserts, org pinned. Audited.
 */
export const PUT = apiHandler(putSchema, async (body, ctx) => {
  const guard = await requirePermission(ctx.userId, 'settings_system', 'edit');
  if (!guard.ok) return guard.response;
  const orgId = guard.orgId;
  const now = new Date().toISOString();

  try {
    if (body.kind === 'remove_company') {
      const table = body.policy_kind === 'dunning' ? 'dunning_policies' : 'late_fee_policies';
      const w = await scopedWriter(ctx.supabase, orgId, [body.location_id]);
      const { error } = await w.from(table).delete().eq('org_id', orgId).eq('location_id', body.location_id);
      if (error) return NextResponse.json({ error: error.message, code: 'DB_ERROR' }, { status: 500 });
      await logHumanAction(ctx.supabase, ctx.userId, orgId, {
        action: `automation.${body.policy_kind}_policy.remove_company`,
        subjectTable: table,
        locationId: body.location_id,
        summary: `Removed a company's ${body.policy_kind === 'dunning' ? 'dunning ladder' : 'late-fee'} override (back to the tenant default)`,
      });
      return NextResponse.json({ ok: true });
    }

    if (body.kind === 'dunning') {
      const parsed = dunningPolicyInputSchema.safeParse(body.policy);
      if (!parsed.success) return NextResponse.json({ error: 'Check the highlighted fields.', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, { status: 422 });
      const p = parsed.data;
      await assertOrgRefs(orgId, [{ schema: 'core', table: 'customers', ids: p.excluded_customer_ids, label: 'customer' }], { caller: ctx.supabase });
      const w = await scopedWriter(ctx.supabase, orgId, [p.location_id]);
      const error = await savePolicyRow(w, 'dunning_policies', orgId, p.location_id, {
          enabled: p.enabled,
          send_mode: p.send_mode,
          steps: [...p.steps].sort((a, b) => a.days - b.days),
          stop_on_promise: p.stop_on_promise,
          stop_on_dispute: p.stop_on_dispute,
          excluded_customer_ids: p.excluded_customer_ids,
          min_balance_cents: p.min_balance_cents,
          updated_by: ctx.userId,
          updated_at: now,
      });
      if (error) return NextResponse.json({ error, code: 'DB_ERROR' }, { status: 500 });
      await logHumanAction(ctx.supabase, ctx.userId, orgId, {
        action: 'automation.dunning_policy.save',
        subjectTable: 'dunning_policies',
        locationId: p.location_id,
        summary: `${p.enabled ? 'Saved' : 'Saved (off)'} the ${p.location_id ? 'company' : 'tenant'} dunning ladder: ${p.steps.length} step(s), ${p.send_mode === 'AUTO' ? 'send automatically' : 'drafts for review'}`,
        metadata: { send_mode: p.send_mode, steps: p.steps.map((s) => ({ stage: s.stage, days: s.days })), enabled: p.enabled },
      });
      return NextResponse.json({ ok: true });
    }

    const parsed = lateFeePolicyInputSchema.safeParse(body.policy);
    if (!parsed.success) return NextResponse.json({ error: 'Check the highlighted fields.', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, { status: 422 });
    const p = parsed.data;
    await assertOrgRefs(
      orgId,
      [
        { table: 'accounts', ids: [p.income_account_id], label: 'income account' },
        { schema: 'core', table: 'customers', ids: p.customer_ids, label: 'customer' },
      ],
      { caller: ctx.supabase },
    );
    if (p.income_account_id) {
      const { data: acct } = await ctx.supabase.from('accounts').select('id, account_type').eq('id', p.income_account_id).maybeSingle();
      const type = (acct as { account_type?: string } | null)?.account_type;
      if (type && type !== 'REVENUE' && type !== 'OTHER') {
        return NextResponse.json({ error: 'Late fees must credit an income (revenue or other income) account.', code: 'VALIDATION_ERROR' }, { status: 422 });
      }
    }
    const w = await scopedWriter(ctx.supabase, orgId, [p.location_id]);
    const error = await savePolicyRow(w, 'late_fee_policies', orgId, p.location_id, {
        enabled: p.enabled,
        method: p.method,
        flat_fee_cents: p.flat_fee_cents,
        rate_bps: p.rate_bps,
        grace_days: p.grace_days,
        frequency: p.frequency,
        min_fee_cents: p.min_fee_cents,
        max_fee_cents: p.max_fee_cents,
        max_total_per_invoice_cents: p.max_total_per_invoice_cents,
        min_balance_cents: p.min_balance_cents,
        apply_to: p.apply_to,
        customer_ids: p.customer_ids,
        income_account_id: p.income_account_id,
        updated_by: ctx.userId,
        updated_at: now,
    });
    if (error) return NextResponse.json({ error, code: 'DB_ERROR' }, { status: 500 });
    await logHumanAction(ctx.supabase, ctx.userId, orgId, {
      action: 'automation.late_fee_policy.save',
      subjectTable: 'late_fee_policies',
      locationId: p.location_id,
      summary: `${p.enabled ? 'Saved' : 'Saved (off)'} the ${p.location_id ? 'company' : 'tenant'} late-fee policy: ${p.method === 'FLAT' ? `$${(p.flat_fee_cents / 100).toFixed(2)} flat` : `${(p.rate_bps / 100).toFixed(2)}% a month`}, ${p.grace_days}-day grace, ${p.frequency === 'ONCE' ? 'once' : 'monthly'}`,
      metadata: { method: p.method, rate_bps: p.rate_bps, flat_fee_cents: p.flat_fee_cents, grace_days: p.grace_days, frequency: p.frequency, enabled: p.enabled },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (isWriteScopeError(e)) return NextResponse.json({ error: e.message, code: 'FORBIDDEN' }, { status: 403 });
    throw e;
  }
});
