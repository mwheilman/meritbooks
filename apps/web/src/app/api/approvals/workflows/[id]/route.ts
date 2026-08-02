export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { setWorkflowActive } from '@/lib/approvals/service';

/**
 * PATCH /api/approvals/workflows/:id — activate or deactivate a workflow. Activating
 * one deactivates any other active workflow for the same doc_type (one-active-per-type
 * invariant). Behind settings_system:edit (a financial-control action).
 */
const schema = z.object({ active: z.boolean() });

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(ctx.userId, 'settings_system', 'edit');
  if (!guard.ok) return guard.response;

  const raw = await request.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR' }, { status: 422 });
  }

  await setWorkflowActive(createAdminSupabase(), ctx.orgId, params.id, parsed.data.active);
  return NextResponse.json({ ok: true });
}
