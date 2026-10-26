/**
 * Invoice delivery facts — derived from ONE source (the
 * stored invoice status + invoice_events), so the header and the Delivery section can't
 * disagree (live check Wave 1, fix 1G-9: header "Sent" while Delivery said "Not sent yet").
 *
 * The stored status SENT means "issued" (posted, collectible) — an invoice reaches it on
 * creation, before anyone emails it. Whether it was actually SENT to the customer is a
 * fact in invoice_events (a SENT row is written only after the email provider accepted the
 * message). Older invoices sent before events existed carry only invoices.sent_at, which
 * counts as a send too.
 */

export interface DeliveryEvent {
  event_type: string;
  created_at: string;
  meta?: Record<string, unknown> | null;
}

export interface InvoiceDelivery {
  sentAt: string | null;
  sentTo: string | null;
  sentCount: number;
  deliveredAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
  lastReminderAt: string | null;
}

const last = (xs: string[]) => (xs.length ? [...xs].sort().at(-1) ?? null : null);

export function summarizeDelivery(events: ReadonlyArray<DeliveryEvent>, sentAtColumn: string | null = null): InvoiceDelivery {
  const at = (type: string) => events.filter((e) => e.event_type === type).map((e) => e.created_at);
  const sent = events.filter((e) => e.event_type === 'SENT').sort((a, b) => a.created_at.localeCompare(b.created_at));
  const lastSent = sent.at(-1) ?? null;
  const views = at('VIEWED');
  const to = lastSent?.meta && typeof lastSent.meta.to === 'string' ? lastSent.meta.to : null;
  return {
    sentAt: lastSent?.created_at ?? sentAtColumn ?? null,
    sentTo: to,
    sentCount: sent.length > 0 ? sent.length : sentAtColumn ? 1 : 0,
    deliveredAt: last(at('DELIVERED')),
    viewCount: views.length,
    lastViewedAt: last(views),
    lastReminderAt: last(at('REMINDER_SENT')),
  };
}

// The status WORD is derived in ./display-status.ts (`deriveInvoiceStatus`) — the one
// derivation shared by the list, drawer and peek; delivery facts feed its `sentToCustomer`.
