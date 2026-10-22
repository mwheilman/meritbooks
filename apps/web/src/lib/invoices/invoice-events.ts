import { SupabaseClient } from '@supabase/supabase-js';
import { assertOrgRefs, isMemberClient, writerFor } from '@/lib/db/scoped-writer';

/**
 * Invoice lifecycle events (FPB §5). Append-only — every transition writes a row
 * to public.invoice_events so the drawer can show a real timeline
 * ("Issued 6/2 · Sent 6/2 · Opened 3× · last 6/9") instead of a bare status.
 *
 * Best-effort: a failed event write must never break the underlying action
 * (posting an invoice, serving the hosted page). We log and move on.
 */
export type InvoiceEventType =
  | 'CREATED' | 'POSTED' | 'EDITED' | 'SENT' | 'DELIVERED' | 'VIEWED'
  | 'PAY_INITIATED' | 'PAY_PROCESSING' | 'PAY_SUCCEEDED' | 'PAY_FAILED' | 'FUNDS_SETTLED'
  | 'PAYMENT_APPLIED' | 'REMINDER_SENT' | 'MARKED_PAID' | 'REFUNDED'
  | 'VOIDED' | 'CREDITED' | 'WRITTEN_OFF';

export async function recordInvoiceEvent(
  supabase: SupabaseClient,
  args: {
    orgId: string;
    invoiceId: string;
    type: InvoiceEventType;
    actor?: string | null;       // Clerk user id, 'customer', or 'system'
    meta?: Record<string, unknown>;
  }
): Promise<void> {
  try {
    // invoice_events is SELECT-only for members (migration 172) and append-only audit evidence:
    // a member caller (whose route already authorized the action) is escalated to the service
    // role, with the invoice verified in the org (FKs never check the tenant); a service-role
    // caller (webhooks, drains) writes as itself. org_id is the caller's session org.
    if (isMemberClient(supabase)) {
      await assertOrgRefs(args.orgId, [{ table: 'invoices', ids: [args.invoiceId], label: 'invoice' }], { caller: supabase });
    }
    await writerFor(supabase).from('invoice_events').insert({
      org_id: args.orgId,
      invoice_id: args.invoiceId,
      event_type: args.type,
      actor: args.actor ?? 'system',
      meta: args.meta ?? {},
    });
  } catch (e) {
    console.error('[invoice_events] failed to record', args.type, e);
  }
}

/** Summarize raw events into the timeline + view-count the drawer renders. */
export function summarizeInvoiceEvents(
  events: { event_type: string; created_at: string; meta?: Record<string, unknown> }[]
) {
  const viewEvents = events.filter((e) => e.event_type === 'VIEWED');
  const last = (type: string) =>
    events.filter((e) => e.event_type === type).map((e) => e.created_at).sort().at(-1) ?? null;

  return {
    createdAt: last('CREATED'),
    postedAt: last('POSTED'),
    sentAt: last('SENT'),
    viewCount: viewEvents.length,
    lastViewedAt: viewEvents.map((e) => e.created_at).sort().at(-1) ?? null,
    lastReminderAt: last('REMINDER_SENT'),
    paidAt: last('MARKED_PAID'),
  };
}
