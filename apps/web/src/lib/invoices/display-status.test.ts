import { describe, expect, it } from 'vitest';
import { deriveInvoiceStatus, hasReachedCustomer, INVOICE_STATUS_LABELS } from './display-status';

const TODAY = '2026-10-26';
const ev = (event_type: string) => ({ event_type });

describe('invoice display status — one derivation for list, drawer and peek', () => {
  it('INV-NWC-202606-0001: open, past due, reminded + viewed, never emailed → Overdue · 103d late everywhere', () => {
    const sent = hasReachedCustomer([ev('VIEWED'), ev('PAY_INITIATED'), ev('REMINDER_SENT')], null);
    expect(sent).toBe(true);
    const d = deriveInvoiceStatus({ status: 'SENT', dueDate: '2026-07-15', balanceCents: 15_000_000, amountPaidCents: 0, sentToCustomer: sent }, TODAY);
    expect(d).toMatchObject({ key: 'OVERDUE', label: 'Overdue', daysOverdue: 103, detail: 'Overdue · 103d late', storedStatus: 'SENT' });
  });

  it('overdue wins over "never sent"; the never-sent fact rides in the hint', () => {
    const d = deriveInvoiceStatus({ status: 'SENT', dueDate: '2026-10-01', balanceCents: 500, sentToCustomer: false }, TODAY);
    expect(d.key).toBe('OVERDUE');
    expect(d.sentToCustomer).toBe(false);
    expect(d.hint).toMatch(/never emailed/);
  });

  it('open, not yet due, never delivered → Issued', () => {
    const d = deriveInvoiceStatus({ status: 'SENT', dueDate: '2026-11-30', balanceCents: 500, sentToCustomer: hasReachedCustomer([ev('CREATED'), ev('POSTED')], null) }, TODAY);
    expect(d).toMatchObject({ key: 'ISSUED', label: 'Issued', daysOverdue: 0 });
  });

  it('delivered (email, legacy sent_at, or a customer view) → Sent', () => {
    expect(hasReachedCustomer([ev('SENT')], null)).toBe(true);
    expect(hasReachedCustomer([], '2026-09-01T00:00:00Z')).toBe(true);
    expect(hasReachedCustomer([ev('VIEWED')], null)).toBe(true);
    expect(hasReachedCustomer([ev('CREATED'), ev('POSTED')], null)).toBe(false);
    expect(deriveInvoiceStatus({ status: 'SENT', dueDate: '2026-11-30', balanceCents: 500, sentToCustomer: true }, TODAY).key).toBe('SENT');
  });

  it('due today is not overdue; paid / zero balance never overdue', () => {
    expect(deriveInvoiceStatus({ status: 'SENT', dueDate: TODAY, balanceCents: 500 }, TODAY).key).toBe('SENT');
    expect(deriveInvoiceStatus({ status: 'PAID', dueDate: '2026-01-01', balanceCents: 0 }, TODAY).key).toBe('PAID');
    expect(deriveInvoiceStatus({ status: 'PARTIALLY_PAID', dueDate: '2026-01-01', balanceCents: 0 }, TODAY).key).toBe('PARTIALLY_PAID');
  });

  it('partly paid and past due → Overdue; stale stored OVERDUE no longer due reverts', () => {
    expect(deriveInvoiceStatus({ status: 'PARTIALLY_PAID', dueDate: '2026-10-20', balanceCents: 10, amountPaidCents: 5 }, TODAY).detail).toBe('Overdue · 6d late');
    expect(deriveInvoiceStatus({ status: 'OVERDUE', dueDate: '2026-12-01', balanceCents: 10, amountPaidCents: 5 }, TODAY).key).toBe('PARTIALLY_PAID');
  });

  it('terminal statuses pass through with their plain-English word', () => {
    for (const s of ['DRAFT', 'VOIDED', 'WRITTEN_OFF'] as const) {
      const d = deriveInvoiceStatus({ status: s, dueDate: '2026-01-01', balanceCents: 100 }, TODAY);
      expect(d.key).toBe(s);
      expect(d.label).toBe(INVOICE_STATUS_LABELS[s]);
    }
  });
});
