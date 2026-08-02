export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { updateTemplate, RecurringJeStoreError } from '@/lib/recurring-je/store';
import { updateTemplateSchema } from '@/lib/recurring-je/schema';

/**
 * PATCH /api/recurring-journal-entries/[id] — edit a template, or pause / resume /
 * cancel it (status). DELETE cancels it (soft — a template is never truly deleted
 * so its posted-run history stays intact). Both gated on `journal_entries:create`.
 * A cancelled/paused template is skipped by generate-due; posted periods are
 * untouched. RLS scopes the row to the tenant.
 */
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;

  const guard = await requirePermission(ctx.userId, 'journal_entries', 'create');
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = updateTemplateSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
      { status: 422 },
    );
  }
  const b = parsed.data;

  try {
    await updateTemplate(ctx.supabase, params.id, {
      name: b.name,
      cadence: b.cadence,
      startDate: b.start_date,
      endDate: b.end_date,
      entryType: b.entry_type,
      memo: b.memo,
      status: b.status,
      lines: b.lines,
    });
    return NextResponse.json({ success: true });
  } catch (e) {
    const msg = e instanceof RecurringJeStoreError ? e.message : 'Failed to update template';
    console.error('[recurring-je] update failed:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: msg, code: 'UPDATE_FAILED' }, { status: 400 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;

  const guard = await requirePermission(ctx.userId, 'journal_entries', 'create');
  if (!guard.ok) return guard.response;

  try {
    await updateTemplate(ctx.supabase, params.id, { status: 'CANCELLED' });
    return NextResponse.json({ success: true });
  } catch (e) {
    const msg = e instanceof RecurringJeStoreError ? e.message : 'Failed to cancel template';
    console.error('[recurring-je] cancel failed:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: msg, code: 'CANCEL_FAILED' }, { status: 400 });
  }
}
