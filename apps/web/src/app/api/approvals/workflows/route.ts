export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import {
  listWorkflows,
  createWorkflow,
  WorkflowValidationError,
} from '@/lib/approvals/service';
import { WORKFLOW_DOC_TYPES } from '@/lib/approvals/workflow';
import { ALL_ROLES } from '@/lib/rbac/permissions';

/**
 * GET  /api/approvals/workflows  — list this org's configured approval chains.
 * POST /api/approvals/workflows  — create a chain (steps + tiers + approver roles).
 *
 * Defining an approval workflow is a financial-CONTROL action (it governs how money
 * documents route for approval), so both verbs sit behind settings_system:edit. Reads
 * and writes use the RLS-scoped client (ctx.supabase); the migration-092 workflow tables
 * are org-isolated by `org_id = get_org_id()`, so the database enforces tenancy (the
 * service also keeps an explicit org_id filter). NEEDS CENTRAL: a dedicated
 * `approvals`/`workflows` permission + a nav entry (reserved spine) — see report.
 */

export const GET = apiQueryHandler(null, async (_params, ctx) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const guard = await requirePermission(ctx.userId, 'settings_system', 'edit');
  if (!guard.ok) return guard.response;
  const workflows = await listWorkflows(ctx.supabase, ctx.orgId);
  return NextResponse.json({ workflows });
});

const stepSchema = z.object({
  stepOrder: z.number().int().min(1),
  minAmountCents: z.number().int().min(0).default(0),
  maxAmountCents: z.number().int().min(0).nullable().default(null),
  approverRole: z.enum(ALL_ROLES as [string, ...string[]]),
  requireDistinct: z.boolean().default(true),
});

const createSchema = z.object({
  name: z.string().min(1).max(120),
  docType: z.enum(WORKFLOW_DOC_TYPES as unknown as [string, ...string[]]),
  description: z.string().max(500).nullable().optional(),
  active: z.boolean().optional(),
  steps: z.array(stepSchema).min(1).max(20),
});

export const POST = apiHandler(createSchema, async (body, ctx) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const guard = await requirePermission(ctx.userId, 'settings_system', 'edit');
  if (!guard.ok) return guard.response;

  try {
    const workflow = await createWorkflow(ctx.supabase, ctx.orgId, {
      name: body.name,
      docType: body.docType as (typeof WORKFLOW_DOC_TYPES)[number],
      description: body.description ?? null,
      active: body.active,
      steps: body.steps.map((s) => ({
        stepOrder: s.stepOrder,
        // Zod fills these via `.default()` at parse time; the `??` only satisfies the
        // types (apiHandler infers the schema's optional-in shape) and never fires.
        minAmountCents: s.minAmountCents ?? 0,
        maxAmountCents: s.maxAmountCents ?? null,
        approverRole: s.approverRole as (typeof ALL_ROLES)[number],
        requireDistinct: s.requireDistinct ?? true,
      })),
      createdByUser: ctx.userId,
    });
    return NextResponse.json({ workflow }, { status: 201 });
  } catch (e) {
    if (e instanceof WorkflowValidationError) {
      return NextResponse.json({ error: 'Invalid workflow', details: e.errors }, { status: 422 });
    }
    throw e;
  }
});
