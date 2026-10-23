import { describe, it, expect } from 'vitest';
import { displayInvoiceStatus, summarizeDelivery } from './delivery-state';

const ev = (event_type: string, day: string, meta: Record<string, unknown> = {}) => ({ event_type, created_at: `2026-10-${day}T10:00:00Z`, meta });

describe('invoice delivery — header and Delivery from one source (1G-9)', () => {
  it('issued but never emailed: header says Issued, Delivery says not sent', () => {
    const d = summarizeDelivery([ev('CREATED', '01'), ev('POSTED', '01')]);
    expect(d.sentAt).toBeNull();
    expect(d.sentCount).toBe(0);
    expect(displayInvoiceStatus('SENT', d).status).toBe('ISSUED');
  });
  it('a SENT event makes both say Sent, with the last recipient and the count', () => {
    const d = summarizeDelivery([ev('SENT', '02', { to: 'a@x.test' }), ev('VIEWED', '03'), ev('SENT', '04', { to: 'b@x.test' }), ev('VIEWED', '05')]);
    expect(d).toMatchObject({ sentAt: '2026-10-04T10:00:00Z', sentTo: 'b@x.test', sentCount: 2, viewCount: 2, lastViewedAt: '2026-10-05T10:00:00Z' });
    expect(displayInvoiceStatus('SENT', d).status).toBe('SENT');
  });
  it('legacy sends (sent_at only, no event) still count as sent', () => {
    const d = summarizeDelivery([], '2026-09-01T00:00:00Z');
    expect(d).toMatchObject({ sentAt: '2026-09-01T00:00:00Z', sentCount: 1 });
    expect(displayInvoiceStatus('SENT', d).status).toBe('SENT');
  });
  it('other statuses pass through', () => {
    const none = summarizeDelivery([]);
    for (const s of ['DRAFT', 'PAID', 'PARTIALLY_PAID', 'VOIDED', 'OVERDUE']) expect(displayInvoiceStatus(s, none).status).toBe(s);
  });
});
