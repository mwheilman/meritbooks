export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler, type ApiContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { generateDue, RecurringJeStoreError } from '@/lib/recurring-je/store';
import { generateSchema, type GenerateBody } from '@/lib/recurring-je/schema';

/**
 * POST /api/recurring-journal-entries/generate — build every due period for the
 * active templates (or one `template_id`) up to `as_of` (default today) and stage
 * each as a PROPOSED entry for human review. This does NOT post to the GL — it
 * only proposes. Gated on `journal_entries:create` (proposing, not posting); the
 * approve step is gated on `journal_entries:post`. The run unique index guards
 * against a duplicate proposal for a period.
 */
export const POST = apiHandler(
  generateSchema,
  async (body: GenerateBody, ctx: ApiContext): Promise<NextResponse> => {
    if (!ctx.orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

    const guard = await requirePermission(ctx.userId, 'journal_entries', 'create');
    if (!guard.ok) return guard.response;

    const asOf = body.as_of ?? new Date().toISOString().slice(0, 10);

    try {
      const result = await generateDue(ctx.supabase, ctx.orgId, { asOf, templateId: body.template_id });
      return NextResponse.json({ result });
    } catch (e) {
      const msg = e instanceof RecurringJeStoreError ? e.message : 'Failed to generate recurring entries';
      console.error('[recurring-je/generate] failed:', e instanceof Error ? e.message : e);
      return NextResponse.json({ error: msg, code: 'GENERATE_FAILED' }, { status: 500 });
    }
  },
);
