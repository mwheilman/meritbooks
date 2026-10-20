export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { logHumanAction } from '@/lib/trust/action-log';
import {
  ConflictRuleError,
  coreUserIdFor,
  createTenantRule,
  loadConflictRulesView,
  updateRule,
} from '@/lib/rbac/sod-admin';

/**
 * Conflict rules (05 §6.10 A10 — the UI name for the SoD policy, migration 165).
 *
 * GET   — platform safeguards (locked) + tenant rules + open allowed conflicts + settings.
 * POST  — add a tenant rule: "nobody should both <permission A> and <permission B>".
 * PATCH — { ruleId, status? } enable / disable a TENANT rule; { ruleId, blocks } make a
 *         soft rule block (platform soft rules can be promoted, never disabled or demoted
 *         below the platform default — the DB enforces this too).
 *
 * Gate: settings_system:edit (same as the approval-workflow builder) until the wave-2
 * flip, when this becomes authorize('core.access.sod_policy', 'configure'). Reads use the
 * service-role client because the rule catalog + identity live in `core`; every query is
 * pinned to the session org.
 */

async function gate(userId: string) {
  return requirePermission(userId, 'settings_system', 'edit');
}

function errorResponse(e: unknown): NextResponse {
  if (e instanceof ConflictRuleError) {
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  throw e;
}

export const GET = apiQueryHandler(null, async (_params, ctx) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const guard = await gate(ctx.userId);
  if (!guard.ok) return guard.response;
  const view = await loadConflictRulesView(createAdminSupabase(), ctx.orgId);
  return NextResponse.json(view);
});

const capRef = z
  .string()
  .regex(/^[a-z0-9_]+(\.[a-z0-9_]+)+:(view|create|edit|delete|approve|post|release|export|configure)$/, 'Pick a permission');

const createSchema = z.object({
  first: capRef,
  second: capRef,
  enforcement: z.enum(['soft', 'hard']).default('soft'),
  suggestedFix: z.string().max(240).nullable().optional(),
});

export const POST = apiHandler(createSchema, async (body, ctx) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const guard = await gate(ctx.userId);
  if (!guard.ok) return guard.response;
  const admin = createAdminSupabase();
  try {
    const id = await createTenantRule(admin, ctx.orgId, {
      first: body.first,
      second: body.second,
      enforcement: body.enforcement ?? 'soft',
      suggestedFix: body.suggestedFix ?? null,
      createdBy: await coreUserIdFor(admin, ctx.userId),
    });
    await logHumanAction(ctx.supabase, ctx.userId, ctx.orgId, {
      action: 'sod.rule.create',
      subjectTable: 'sod_rules',
      subjectId: id,
      summary: `Added a conflict rule: ${body.first} with ${body.second}`,
      metadata: { first: body.first, second: body.second, enforcement: body.enforcement ?? 'soft' },
    });
    return NextResponse.json({ id }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
});

const patchSchema = z
  .object({
    ruleId: z.string().uuid(),
    status: z.enum(['active', 'disabled']).optional(),
    blocks: z.boolean().optional(),
  })
  .refine((v) => v.status !== undefined || v.blocks !== undefined, { message: 'Nothing to change' });

export const PATCH = apiHandler(patchSchema, async (body, ctx) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const guard = await gate(ctx.userId);
  if (!guard.ok) return guard.response;
  const admin = createAdminSupabase();
  try {
    await updateRule(admin, ctx.orgId, body.ruleId, { status: body.status, blocks: body.blocks }, await coreUserIdFor(admin, ctx.userId));
    await logHumanAction(ctx.supabase, ctx.userId, ctx.orgId, {
      action: 'sod.rule.update',
      subjectTable: 'sod_rules',
      subjectId: body.ruleId,
      summary: body.status
        ? `${body.status === 'disabled' ? 'Turned off' : 'Turned on'} a conflict rule`
        : `${body.blocks ? 'Made a conflict rule block' : 'Made a conflict rule warn'}`,
      metadata: { status: body.status ?? null, blocks: body.blocks ?? null },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
});
