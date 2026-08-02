export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext, apiHandler, type ApiContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { listTemplates, createTemplate, RecurringJeStoreError } from '@/lib/recurring-je/store';
import { createTemplateSchema, type CreateTemplateBody } from '@/lib/recurring-je/schema';

/**
 * /api/recurring-journal-entries
 *
 * GET  — list recurring JE templates with per-period total, next run, and the
 *        count of proposed entries awaiting approval. RLS-scoped.
 * POST — create a recurring JE template. Gated on `journal_entries:create` — a
 *        template is a saved posting instruction; generating/approving it (which
 *        actually WRITES the GL) is gated separately on `journal_entries:post`.
 *        The balanced-line set is validated by Zod, the pure engine, and finally
 *        the DB balance trigger at post time.
 */
export async function GET(): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;

  try {
    const templates = await listTemplates(ctx.supabase);
    const summary = {
      total: templates.length,
      active: templates.filter((t) => t.status === 'ACTIVE').length,
      pending: templates.reduce((s, t) => s + t.pending_count, 0),
    };
    return NextResponse.json({ data: templates, summary });
  } catch (e) {
    console.error('[recurring-je] list failed:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Failed to load recurring entries', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

export const POST = apiHandler(
  createTemplateSchema,
  async (body: CreateTemplateBody, ctx: ApiContext): Promise<NextResponse> => {
    if (!ctx.orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

    const guard = await requirePermission(ctx.userId, 'journal_entries', 'create');
    if (!guard.ok) return guard.response;

    try {
      const { id } = await createTemplate(ctx.supabase, {
        orgId: ctx.orgId,
        locationId: body.location_id,
        name: body.name,
        cadence: body.cadence,
        startDate: body.start_date,
        endDate: body.end_date ?? null,
        entryType: body.entry_type,
        memo: body.memo ?? null,
        lines: body.lines,
        createdBy: ctx.userId,
      });
      return NextResponse.json({ id }, { status: 201 });
    } catch (e) {
      const msg = e instanceof RecurringJeStoreError ? e.message : 'Failed to create template';
      console.error('[recurring-je] create failed:', e instanceof Error ? e.message : e);
      return NextResponse.json({ error: msg, code: 'CREATE_FAILED' }, { status: 400 });
    }
  },
);
