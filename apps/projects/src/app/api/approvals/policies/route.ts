export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, must, route } from '@/lib/api';
import { loadPolicy, saveCompanySettings } from '@/lib/approvals/server';
import { ObjectType } from '../schemas';

const Q = z.object({ companyId: z.string().uuid().optional() });

/** GET /api/approvals/policies?companyId — the company's approval settings and rules. */
export const GET = route({ access: { cap: 'projects.settings', action: 'view' }, mask: false, query: Q }, async ({ db, query, tenant }) => {
  const companyId = query.companyId ?? tenant.activeCompanyId;
  if (!companyId) throw new HttpError(422, 'Pick a company to see its approval rules.', 'NO_COMPANY');
  assertCompany(tenant, companyId);
  return loadPolicy(db, companyId);
});

const ROLE_KEYS = ['projects_owner', 'projects_gm', 'projects_office_manager', 'projects_project_accountant', 'projects_dispatcher',
  'projects_purchasing', 'projects_pm', 'projects_supervisor', 'projects_labor', 'projects_sales', 'projects_payroll_admin'] as const;
const Cents = z.number().int().min(0).max(100_000_000_000);
const RuleFields = z.object({
  minAmountCents: Cents.default(0),
  maxAmountCents: Cents.nullable().default(null),
  stepOrder: z.number().int().min(1).max(9).default(1),
  approverRoles: z.array(z.enum(ROLE_KEYS)).max(11).default([]),
  approverCapability: z.string().regex(/^projects\.[a-z_]+:(view|create|edit|delete|approve|post|release|export|configure)$/).nullable().default(null),
  requireDistinct: z.boolean().default(true),
  dueDays: z.number().int().min(1).max(60).default(2),
  condition: z.enum(['over_budget', 'below_margin_floor', 'overtime']).nullable().default(null),
  label: z.string().trim().min(1).max(80),
  isActive: z.boolean().default(true),
});

const Body = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('settings'), companyId: z.string().uuid(),
    size: z.enum(['xs', 's', 'm', 'l']).nullish(), solo: z.boolean().nullish(),
    marginFloorPct: z.number().min(0).max(0.99).nullish(), escalationRoles: z.array(z.enum(ROLE_KEYS)).max(11).nullish(),
    reseed: z.boolean().default(false),
  }),
  z.object({ op: z.literal('add_rule'), companyId: z.string().uuid(), objectType: ObjectType.exclude(['stage_transition']), rule: RuleFields }),
  z.object({ op: z.literal('update_rule'), companyId: z.string().uuid(), ruleId: z.string().uuid(), rule: RuleFields.partial() }),
  z.object({ op: z.literal('delete_rule'), companyId: z.string().uuid(), ruleId: z.string().uuid() }),
]);

type RuleInput = z.infer<typeof RuleFields>;
function ruleRow(r: Partial<RuleInput>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (r.minAmountCents !== undefined) out.min_amount_cents = r.minAmountCents;
  if (r.maxAmountCents !== undefined) out.max_amount_cents = r.maxAmountCents;
  if (r.stepOrder !== undefined) out.step_order = r.stepOrder;
  if (r.approverRoles !== undefined) out.approver_roles = r.approverRoles;
  if (r.approverCapability !== undefined) out.approver_capability = r.approverCapability;
  if (r.requireDistinct !== undefined) out.require_distinct = r.requireDistinct;
  if (r.dueDays !== undefined) out.due_days = r.dueDays;
  if (r.condition !== undefined) out.condition = r.condition;
  if (r.label !== undefined) out.label = r.label;
  if (r.isActive !== undefined) out.is_active = r.isActive;
  return out;
}

/**
 * POST /api/approvals/policies — settings:configure at the company. Size changes reseed the
 * default tiers (custom rules stay); rule edits write through RLS and become custom.
 */
export const POST = route({ access: { cap: 'projects.settings', action: 'configure' }, mask: false, body: Body }, async ({ db, body, tenant }) => {
  assertCompany(tenant, body.companyId);
  if (body.op === 'settings') {
    return saveCompanySettings(db, body.companyId, {
      size: body.size ?? null, solo: body.solo ?? null, marginFloor: body.marginFloorPct ?? null,
      escalationRoles: body.escalationRoles ?? null, reseed: body.reseed,
    });
  }
  const t = db.schema('pm').from('approval_rules');
  if (body.op === 'add_rule') {
    const row = ruleRow(body.rule);
    if (row.approver_capability === null && (row.approver_roles as string[]).length === 0) {
      throw new HttpError(422, 'Pick who approves: at least one role, or a capability.', 'VALIDATION');
    }
    must(await t.insert({ ...row, org_id: tenant.orgId, location_id: body.companyId, object_type: body.objectType }).select('id'), 'add rule');
  } else if (body.op === 'update_rule') {
    const res = must(await t.update(ruleRow(body.rule)).eq('id', body.ruleId).eq('location_id', body.companyId).select('id'), 'update rule') as unknown[];
    if (!res.length) throw new HttpError(404, 'That rule was not found for this company.', 'NOT_FOUND');
  } else {
    const res = must(await t.delete().eq('id', body.ruleId).eq('location_id', body.companyId).select('id'), 'delete rule') as unknown[];
    if (!res.length) throw new HttpError(404, 'That rule was not found for this company.', 'NOT_FOUND');
  }
  return loadPolicy(db, body.companyId);
});
