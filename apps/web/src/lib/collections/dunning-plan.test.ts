import { describe, it, expect } from 'vitest';
import { daysPastDue, decideDunning, holdMinutes, type DunningInvoiceFacts } from './dunning-plan';
import {
  DEFAULT_DUNNING_POLICY,
  DEFAULT_DUNNING_STEPS,
  dunningPolicyInputSchema,
  renderDunningStep,
  renderTemplate,
  resolveDunningPolicy,
  type DunningPolicy,
  type DunningPolicyRow,
} from './dunning-policy';

const ON: DunningPolicy = { ...DEFAULT_DUNNING_POLICY, enabled: true, steps: [...DEFAULT_DUNNING_STEPS] };

function facts(over: Partial<DunningInvoiceFacts> = {}): DunningInvoiceFacts {
  return {
    invoiceId: 'inv-1',
    customerId: 'cust-1',
    balanceCents: 125_000,
    status: 'SENT',
    daysPastDue: 10,
    disputed: false,
    hasEmail: true,
    promisePending: false,
    doneStages: new Set(),
    live: null,
    ...over,
  };
}

describe('decideDunning — the ladder', () => {
  it('picks the highest step the invoice has reached', () => {
    expect(decideDunning(facts({ daysPastDue: -3 }), ON, false)).toMatchObject({ action: 'create', step: { stage: 'COURTESY' } });
    expect(decideDunning(facts({ daysPastDue: 7 }), ON, false)).toMatchObject({ action: 'create', step: { stage: 'FIRST_NOTICE' } });
    expect(decideDunning(facts({ daysPastDue: 45 }), ON, false)).toMatchObject({ action: 'create', step: { stage: 'SECOND_NOTICE' }, nextStep: { stage: 'THIRD_NOTICE' } });
    expect(decideDunning(facts({ daysPastDue: 120 }), ON, false)).toMatchObject({ action: 'create', step: { stage: 'FINAL_NOTICE' }, nextStep: null });
  });

  it('does nothing before the first step', () => {
    expect(decideDunning(facts({ daysPastDue: -10 }), ON, false)).toEqual({ action: 'none', reason: 'not_due' });
  });

  it('never repeats a step or goes back down the ladder', () => {
    expect(decideDunning(facts({ daysPastDue: 10, doneStages: new Set(['FIRST_NOTICE']) }), ON, false)).toEqual({ action: 'none', reason: 'already_sent' });
    // A later step was already sent by hand from Collections → nothing lower is sent.
    expect(decideDunning(facts({ daysPastDue: 40, doneStages: new Set(['THIRD_NOTICE']) }), ON, false)).toEqual({ action: 'none', reason: 'already_sent' });
    // A sent live reminder counts as done too.
    expect(decideDunning(facts({ daysPastDue: 10, live: { id: 'r1', stage: 'FIRST_NOTICE', sent: true } }), ON, false)).toEqual({ action: 'none', reason: 'already_sent' });
  });

  it('leaves a step already waiting in Requests alone, and supersedes a stale earlier one', () => {
    expect(decideDunning(facts({ daysPastDue: 10, live: { id: 'r1', stage: 'FIRST_NOTICE', sent: false } }), ON, false)).toEqual({ action: 'none', reason: 'already_waiting' });
    expect(decideDunning(facts({ daysPastDue: 31, live: { id: 'r1', stage: 'FIRST_NOTICE', sent: false } }), ON, false)).toMatchObject({
      action: 'create', step: { stage: 'SECOND_NOTICE' }, supersedeId: 'r1',
    });
  });

  it('needs an email address', () => {
    expect(decideDunning(facts({ hasEmail: false }), ON, false)).toEqual({ action: 'none', reason: 'no_email' });
  });
});

describe('decideDunning — stop conditions', () => {
  const live = { id: 'r9', stage: 'FIRST_NOTICE' as const, sent: true };
  it('stops (and cancels the live reminder) when paid or closed', () => {
    expect(decideDunning(facts({ balanceCents: 0, live }), ON, false)).toEqual({ action: 'stop', reason: 'settled', cancelId: 'r9' });
    expect(decideDunning(facts({ status: 'VOIDED', live }), ON, false)).toMatchObject({ action: 'stop', reason: 'settled' });
  });
  it('stops for an excluded customer', () => {
    expect(decideDunning(facts({ live }), ON, true)).toMatchObject({ action: 'stop', reason: 'excluded' });
  });
  it('holds a disputed invoice only when the policy says so', () => {
    expect(decideDunning(facts({ disputed: true, live }), ON, false)).toMatchObject({ action: 'stop', reason: 'disputed' });
    expect(decideDunning(facts({ disputed: true }), { ...ON, stopOnDispute: false }, false)).toMatchObject({ action: 'create' });
  });
  it('holds while a promise to pay is pending', () => {
    expect(decideDunning(facts({ promisePending: true, live }), ON, false)).toMatchObject({ action: 'stop', reason: 'promise' });
    expect(decideDunning(facts({ promisePending: true }), { ...ON, stopOnPromise: false }, false)).toMatchObject({ action: 'create' });
  });
  it('skips balances under the minimum', () => {
    expect(decideDunning(facts({ balanceCents: 4_999, live }), { ...ON, minBalanceCents: 5_000 }, false)).toMatchObject({ action: 'stop', reason: 'below_minimum' });
  });
  it('switched off: only an unsent draft is withdrawn', () => {
    const off = { ...ON, enabled: false };
    expect(decideDunning(facts({ live: { id: 'd1', stage: 'FIRST_NOTICE', sent: false } }), off, false)).toMatchObject({ action: 'stop', reason: 'disabled' });
    expect(decideDunning(facts({ live }), off, false)).toEqual({ action: 'none', reason: 'not_due' });
    expect(decideDunning(facts(), off, false)).toEqual({ action: 'none', reason: 'not_due' });
  });
  it('a stop with nothing live is a no-op', () => {
    expect(decideDunning(facts({ promisePending: true }), ON, false)).toEqual({ action: 'none', reason: 'not_due' });
  });
});

describe('dunning helpers', () => {
  it('holdMinutes keeps a reminder open until the next step (min 1 day), 14 days after the last', () => {
    expect(holdMinutes({ stage: 'FIRST_NOTICE', days: 7, subject: '', body: '' }, { stage: 'SECOND_NOTICE', days: 30, subject: '', body: '' })).toBe(24 * 1440);
    expect(holdMinutes({ stage: 'FINAL_NOTICE', days: 90, subject: '', body: '' }, null)).toBe(14 * 1440);
  });
  it('daysPastDue', () => {
    expect(daysPastDue('2026-10-01', '2026-10-23')).toBe(22);
    expect(daysPastDue('2026-10-26', '2026-10-23')).toBe(-3);
  });
  it('company policy overrides the tenant default; default is off', () => {
    const rows: DunningPolicyRow[] = [
      { location_id: null, enabled: true, send_mode: 'DRAFT', steps: DEFAULT_DUNNING_STEPS, stop_on_promise: true, stop_on_dispute: true, excluded_customer_ids: [], min_balance_cents: 0 },
      { location_id: 'loc-b', enabled: true, send_mode: 'AUTO', steps: [{ stage: 'FIRST_NOTICE', days: 15, subject: '', body: '' }], stop_on_promise: false, stop_on_dispute: true, excluded_customer_ids: [], min_balance_cents: '2500' },
    ];
    expect(resolveDunningPolicy(rows, 'loc-a')).toMatchObject({ source: 'tenant', sendMode: 'DRAFT' });
    expect(resolveDunningPolicy(rows, 'loc-b')).toMatchObject({ source: 'company', sendMode: 'AUTO', minBalanceCents: 2500, stopOnPromise: false });
    expect(resolveDunningPolicy([], 'loc-a')).toMatchObject({ source: 'default', enabled: false });
  });
  it('validation: unique stages, firmer as it ages', () => {
    const base = { enabled: true, send_mode: 'DRAFT' as const, location_id: null };
    expect(dunningPolicyInputSchema.safeParse({ ...base, steps: DEFAULT_DUNNING_STEPS }).success).toBe(true);
    expect(dunningPolicyInputSchema.safeParse({ ...base, steps: [{ stage: 'FIRST_NOTICE', days: 7 }, { stage: 'FIRST_NOTICE', days: 30 }] }).success).toBe(false);
    expect(dunningPolicyInputSchema.safeParse({ ...base, steps: [{ stage: 'FINAL_NOTICE', days: 7 }, { stage: 'FIRST_NOTICE', days: 30 }] }).success).toBe(false);
  });
  it('renders templates with the invoice facts and falls back to built-in copy', () => {
    const f = { customerName: 'Owner LLC', supplierName: 'Heritage', invoiceNumber: 'INV-7', invoiceDate: '2026-09-01', dueDate: '2026-10-01', balanceCents: 123_456, daysOverdue: 22, payUrl: 'https://x/pay/t', viewUrl: 'https://x/pay/t' };
    expect(renderTemplate('Hi {{customer}}, {{invoice_number}} for {{amount}} is {{days_overdue}} days late: {{pay_link}} {{unknown}}', f)).toBe(
      'Hi Owner LLC, INV-7 for $1,234.56 is 22 days late: https://x/pay/t {{unknown}}',
    );
    const builtIn = renderDunningStep({ stage: 'FIRST_NOTICE', days: 7, subject: '', body: '' }, f);
    expect(builtIn.subject).toContain('INV-7');
    expect(builtIn.body).toContain('$1,234.56');
    expect(builtIn.body).toContain('https://x/pay/t');
    const courtesy = renderDunningStep({ stage: 'COURTESY', days: -3, subject: '', body: '' }, { ...f, daysOverdue: 0 });
    expect(courtesy.subject).toMatch(/Coming due/);
  });
});
