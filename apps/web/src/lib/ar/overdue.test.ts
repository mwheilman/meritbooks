import { describe, it, expect } from 'vitest';
import {
  agingBucketFor,
  agingBucketForDays,
  daysPastDue,
  effectiveInvoiceStatus,
  invoiceTabOrFilter,
  isInvoiceOverdue,
} from './overdue';

// Live case (audit L4): INV-NWC-202606-0001, stored SENT, due 2026-07-15,
// balance $150,000.00 — Invoices said "Sent / Overdue $0", Collections said 90+.
const NWC = { status: 'SENT', dueDate: '2026-07-15', balanceCents: 15_000_000, amountPaidCents: 0 };
const TODAY = '2026-10-19'; // org calendar date (America/Chicago)

describe('derived overdue — one definition for invoices, AR KPIs and collections', () => {
  it('the 97-day-late SENT invoice is OVERDUE and lands in 90+', () => {
    expect(isInvoiceOverdue(NWC, TODAY)).toBe(true);
    expect(effectiveInvoiceStatus(NWC, TODAY)).toBe('OVERDUE');
    expect(daysPastDue(NWC.dueDate, TODAY)).toBe(96);
    expect(daysPastDue(NWC.dueDate, '2026-10-20')).toBe(97);
    expect(agingBucketFor(NWC.dueDate, TODAY)).toBe('90+');
  });

  it('due today is not overdue; due yesterday is', () => {
    expect(isInvoiceOverdue({ ...NWC, dueDate: TODAY }, TODAY)).toBe(false);
    expect(isInvoiceOverdue({ ...NWC, dueDate: '2026-10-18' }, TODAY)).toBe(true);
  });

  it('closed or fully-paid invoices are never overdue', () => {
    for (const status of ['PAID', 'VOIDED', 'DRAFT', 'WRITTEN_OFF']) {
      expect(isInvoiceOverdue({ ...NWC, status }, TODAY)).toBe(false);
    }
    expect(isInvoiceOverdue({ ...NWC, balanceCents: 0 }, TODAY)).toBe(false);
    expect(isInvoiceOverdue({ ...NWC, dueDate: null }, TODAY)).toBe(false);
  });

  it('a partially-paid past-due invoice is OVERDUE; a stale stored OVERDUE reverts once current', () => {
    expect(effectiveInvoiceStatus({ ...NWC, status: 'PARTIALLY_PAID', amountPaidCents: 5_000 }, TODAY)).toBe('OVERDUE');
    expect(effectiveInvoiceStatus({ ...NWC, status: 'OVERDUE', dueDate: '2026-11-30' }, TODAY)).toBe('SENT');
    expect(
      effectiveInvoiceStatus({ ...NWC, status: 'OVERDUE', dueDate: '2026-11-30', amountPaidCents: 100 }, TODAY),
    ).toBe('PARTIALLY_PAID');
  });

  it('timezone matters: the UTC date would have aged the same invoice one extra day', () => {
    // The org-tz date is the anchor; callers pass it in (lib/dates/org-today).
    expect(daysPastDue('2026-10-19', '2026-10-19')).toBe(0);
    expect(daysPastDue('2026-10-19', '2026-10-20')).toBe(1);
  });

  it('bucket edges match v_ar_aging', () => {
    expect(agingBucketForDays(0)).toBe('CURRENT');
    expect(agingBucketForDays(1)).toBe('1-30');
    expect(agingBucketForDays(30)).toBe('1-30');
    expect(agingBucketForDays(31)).toBe('31-60');
    expect(agingBucketForDays(60)).toBe('31-60');
    expect(agingBucketForDays(61)).toBe('61-90');
    expect(agingBucketForDays(90)).toBe('61-90');
    expect(agingBucketForDays(91)).toBe('90+');
  });

  it('list-tab filters encode the same predicate for PostgREST', () => {
    expect(invoiceTabOrFilter('OVERDUE', TODAY)).toBe(
      'and(status.not.in.(DRAFT,PAID,VOIDED,WRITTEN_OFF),balance_cents.gt.0,due_date.lt.2026-10-19)',
    );
    expect(invoiceTabOrFilter('SENT', TODAY)).toContain('due_date.gte.2026-10-19');
    expect(invoiceTabOrFilter('PAID', TODAY)).toBeNull();
  });
});
