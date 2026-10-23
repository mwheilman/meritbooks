export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { loadWritableRow, isWriteScopeError, serviceWriter, writerFor } from '@/lib/db/scoped-writer';
import { cancelDunningForInvoice } from '@/lib/collections/dunning-requests';
import { logHumanAction } from '@/lib/trust/action-log';

const schema = z
  .object({
    invoice_id: z.string().uuid(),
    disputed: z.boolean(),
    note: z.string().trim().max(1000).optional(),
  })
  .strict()
  .refine((v) => !v.disputed || (v.note ?? '').length >= 3, { message: 'Note what the customer disputes.', path: ['note'] });

/**
 * POST /api/collections/dispute { invoice_id, disputed, note } — mark an invoice disputed
 * (or resolved). While disputed, the dunning ladder holds its reminders (policy
 * stop_on_dispute), any reminder ALREADY queued for it is cancelled, and no late fee is
 * assessed or approved (migration 184 invoices.disputed_at).
 *
 * AUTHZ: invoices:create (AR authority). The invoice is loaded org-pinned and its company
 * checked against the caller's client scope before the service-role write (invoices are
 * SELECT-only for members, migration 176). Audited.
 */
export const POST = apiHandler(schema, async (body, ctx) => {
  const guard = await requirePermission(ctx.userId, 'invoices', 'create');
  if (!guard.ok) return guard.response;
  const orgId = guard.orgId;
  try {
    const inv = await loadWritableRow<{ id: string; invoice_number: string; location_id: string; disputed_at: string | null }>(ctx.supabase, orgId, {
      table: 'invoices',
      id: body.invoice_id,
      select: 'id, invoice_number, location_id, disputed_at',
    });
    if (!inv) return NextResponse.json({ error: 'Invoice not found', code: 'NOT_FOUND' }, { status: 404 });
    const now = new Date().toISOString();
    const { error } = await writerFor(ctx.supabase)
      .from('invoices')
      .update(
        body.disputed
          ? { disputed_at: inv.disputed_at ?? now, dispute_note: body.note ?? null, disputed_by: ctx.userId, updated_at: now }
          : { disputed_at: null, dispute_note: null, disputed_by: null, updated_at: now },
      )
      .eq('id', inv.id)
      .eq('org_id', orgId);
    if (error) return NextResponse.json({ error: error.message, code: 'DB_ERROR' }, { status: 500 });
    // Reminders already queued in the request engine must not go out while disputed.
    let remindersCancelled = 0;
    if (body.disputed) {
      remindersCancelled = await cancelDunningForInvoice(
        serviceWriter(),
        orgId,
        inv.id,
        ctx.userId,
        `Invoice ${inv.invoice_number} marked disputed — reminder cancelled.`,
      );
    }
    await logHumanAction(ctx.supabase, ctx.userId, orgId, {
      action: body.disputed ? 'collections.invoice.dispute' : 'collections.invoice.dispute_resolved',
      subjectTable: 'invoices',
      subjectId: inv.id,
      locationId: inv.location_id,
      summary: body.disputed
        ? `Marked invoice ${inv.invoice_number} disputed — reminders and late fees on hold${remindersCancelled ? ` (${remindersCancelled} queued reminder(s) cancelled)` : ''}: ${body.note ?? ''}`.slice(0, 500)
        : `Cleared the dispute on invoice ${inv.invoice_number} — reminders resume`,
    });
    return NextResponse.json({ ok: true, invoice_id: inv.id, disputed: body.disputed, reminders_cancelled: remindersCancelled });
  } catch (e) {
    if (isWriteScopeError(e)) return NextResponse.json({ error: e.message, code: 'FORBIDDEN' }, { status: 403 });
    throw e;
  }
});
