/**
 * AR collections workflow — locks the deterministic policy: cadence-stage
 * selection, whether a reminder is due, the worklist ranking + recommended
 * action, and promise-to-pay classification (incl. broken-promise detection).
 *
 * Pure logic only — fixed ISO dates, no Date.now, no Supabase.
 */

import { describe, it, expect } from 'vitest';
import {
  cadenceStageForDays,
  decideReminder,
  stageOrder,
} from './cadence';
import {
  computeAccountPriority,
  recommendAction,
  buildWorklist,
  type WorklistAccountInput,
} from './worklist';
import {
  classifyPromise,
  classifyPromises,
  brokenPromises,
  type PromiseToPay,
} from './promises';
import { deterministicDunningDraft, parseDunningReply } from './dunning-copy';

/** Alias used across the tests below. */
const stageFor = cadenceStageForDays;

// ── Cadence stage selection ──────────────────────────────────────────────────

describe('cadenceStageForDays', () => {
  it('returns null inside the grace window (< 7 days)', () => {
    expect(cadenceStageForDays(0)).toBeNull();
    expect(cadenceStageForDays(6)).toBeNull();
  });
  it('picks the highest qualifying stage at each threshold', () => {
    expect(cadenceStageForDays(7)?.key).toBe('FIRST_NOTICE');
    expect(cadenceStageForDays(29)?.key).toBe('FIRST_NOTICE');
    expect(cadenceStageForDays(30)?.key).toBe('SECOND_NOTICE');
    expect(cadenceStageForDays(60)?.key).toBe('THIRD_NOTICE');
    expect(cadenceStageForDays(89)?.key).toBe('THIRD_NOTICE');
    expect(cadenceStageForDays(90)?.key).toBe('FINAL_NOTICE');
    expect(cadenceStageForDays(400)?.key).toBe('FINAL_NOTICE');
  });
  it('escalates tone with age', () => {
    expect(stageFor(7)?.tone).toBe('friendly');
    expect(stageFor(30)?.tone).toBe('firm');
    expect(stageFor(60)?.tone).toBe('urgent');
    expect(stageFor(90)?.tone).toBe('final');
  });
});

describe('decideReminder', () => {
  const asOf = '2026-08-01';
  it('is not due within terms', () => {
    const d = decideReminder({ daysOverdue: 3, lastStageSent: null, lastReminderAt: null, asOf });
    expect(d.isDue).toBe(false);
    expect(d.stage).toBeNull();
  });
  it('is due (escalation) when qualifying stage exceeds last sent', () => {
    const d = decideReminder({ daysOverdue: 35, lastStageSent: 'FIRST_NOTICE', lastReminderAt: '2026-07-20', asOf });
    expect(d.isDue).toBe(true);
    expect(d.isEscalation).toBe(true);
    expect(d.stage?.key).toBe('SECOND_NOTICE');
  });
  it('holds a same-stage re-nudge until the quiet gap elapses', () => {
    const recent = decideReminder({ daysOverdue: 10, lastStageSent: 'FIRST_NOTICE', lastReminderAt: '2026-07-29', asOf });
    expect(recent.isDue).toBe(false); // only 3 days since last reminder
    const stale = decideReminder({ daysOverdue: 10, lastStageSent: 'FIRST_NOTICE', lastReminderAt: '2026-07-20', asOf });
    expect(stale.isDue).toBe(true); // 12 days elapsed >= 7-day gap
    expect(stale.isEscalation).toBe(false);
  });
  it('stageOrder compares severity', () => {
    expect(stageOrder(null)).toBe(0);
    expect(stageOrder('FIRST_NOTICE')).toBeLessThan(stageOrder('FINAL_NOTICE'));
  });
});

// ── Priority ranking ─────────────────────────────────────────────────────────

describe('computeAccountPriority', () => {
  it('weights dollars by age', () => {
    const young = computeAccountPriority({ overdueBalanceCents: 100_000, maxDaysOverdue: 10, riskLevel: 'low', hasBrokenPromise: false });
    const old = computeAccountPriority({ overdueBalanceCents: 100_000, maxDaysOverdue: 120, riskLevel: 'low', hasBrokenPromise: false });
    expect(old).toBeGreaterThan(young);
  });
  it('a broken promise and higher risk raise the score', () => {
    const base = computeAccountPriority({ overdueBalanceCents: 100_000, maxDaysOverdue: 40, riskLevel: 'low', hasBrokenPromise: false });
    const risky = computeAccountPriority({ overdueBalanceCents: 100_000, maxDaysOverdue: 40, riskLevel: 'high', hasBrokenPromise: false });
    const broken = computeAccountPriority({ overdueBalanceCents: 100_000, maxDaysOverdue: 40, riskLevel: 'low', hasBrokenPromise: true });
    expect(risky).toBeGreaterThan(base);
    expect(broken).toBeGreaterThan(base);
  });
  it('caps the age factor at 180 days', () => {
    const at180 = computeAccountPriority({ overdueBalanceCents: 100_000, maxDaysOverdue: 180, riskLevel: 'low', hasBrokenPromise: false });
    const at400 = computeAccountPriority({ overdueBalanceCents: 100_000, maxDaysOverdue: 400, riskLevel: 'low', hasBrokenPromise: false });
    expect(at400).toBe(at180);
  });
});

// ── Recommended action ───────────────────────────────────────────────────────

describe('recommendAction', () => {
  const pending = { status: 'PENDING', promiseDate: '2026-08-10' } as never;
  it('waits when a pending promise exists', () => {
    const a = recommendAction({ maxDaysOverdue: 40, riskLevel: 'high', hasPendingPromise: true, pendingPromise: pending, hasBrokenPromise: false, currentStage: stageFor(40), reminderDue: true });
    expect(a.kind).toBe('AWAIT_PROMISE');
  });
  it('calls on a broken promise (non-severe)', () => {
    const a = recommendAction({ maxDaysOverdue: 20, riskLevel: 'low', hasPendingPromise: false, pendingPromise: null, hasBrokenPromise: true, currentStage: stageFor(20), reminderDue: true });
    expect(a.kind).toBe('CALL_BROKEN_PROMISE');
  });
  it('escalates a broken promise on a severe account', () => {
    const a = recommendAction({ maxDaysOverdue: 95, riskLevel: 'high', hasPendingPromise: false, pendingPromise: null, hasBrokenPromise: true, currentStage: stageFor(95), reminderDue: true });
    expect(a.kind).toBe('ESCALATE');
  });
  it('maps cadence stage to the notice to send', () => {
    const a = recommendAction({ maxDaysOverdue: 35, riskLevel: 'low', hasPendingPromise: false, pendingPromise: null, hasBrokenPromise: false, currentStage: stageFor(35), reminderDue: true });
    expect(a.kind).toBe('SEND_SECOND_NOTICE');
    expect(a.stage).toBe('SECOND_NOTICE');
  });
  it('escalates a final-stage high-risk account', () => {
    const a = recommendAction({ maxDaysOverdue: 100, riskLevel: 'high', hasPendingPromise: false, pendingPromise: null, hasBrokenPromise: false, currentStage: stageFor(100), reminderDue: true });
    expect(a.kind).toBe('ESCALATE');
  });
  it('monitors inside the grace window', () => {
    const a = recommendAction({ maxDaysOverdue: 4, riskLevel: 'low', hasPendingPromise: false, pendingPromise: null, hasBrokenPromise: false, currentStage: null, reminderDue: false });
    expect(a.kind).toBe('MONITOR');
  });
});

// ── buildWorklist integration ────────────────────────────────────────────────

describe('buildWorklist', () => {
  const asOf = '2026-08-01';
  const base = (over: Partial<WorklistAccountInput>): WorklistAccountInput => ({
    customerId: 'c1',
    customerName: 'Acme',
    customerEmail: 'ap@acme.test',
    riskLevel: 'low',
    riskFlags: [],
    riskSummary: '',
    avgDaysBeyondTerms: null,
    openBalanceCents: 0,
    overdueBalanceCents: 0,
    invoices: [],
    promises: [],
    ...over,
  });

  it('ranks the worse account first and computes stage + action', () => {
    const small = base({
      customerId: 'small',
      customerName: 'Small Co',
      overdueBalanceCents: 50_000,
      openBalanceCents: 50_000,
      invoices: [{ id: 'i1', invoiceNumber: 'INV-1', dueDate: '2026-07-20', balanceCents: 50_000, daysOverdue: 12, lastStageSent: null, lastReminderAt: null, reminderCount: 0 }],
    });
    const big = base({
      customerId: 'big',
      customerName: 'Big Co',
      riskLevel: 'high',
      overdueBalanceCents: 900_000,
      openBalanceCents: 900_000,
      invoices: [{ id: 'i2', invoiceNumber: 'INV-2', dueDate: '2026-05-01', balanceCents: 900_000, daysOverdue: 92, lastStageSent: 'THIRD_NOTICE', lastReminderAt: '2026-07-01', reminderCount: 3 }],
    });
    const list = buildWorklist([small, big], asOf);
    expect(list[0].customerName).toBe('Big Co');
    expect(list[0].currentStage).toBe('FINAL_NOTICE');
    expect(list[0].recommendedAction.kind).toBe('ESCALATE'); // final + high risk
    expect(list[1].customerName).toBe('Small Co');
    expect(list[1].currentStage).toBe('FIRST_NOTICE');
    expect(list[1].focusInvoiceId).toBe('i1');
  });

  it('flags a broken promise and boosts its rank', () => {
    const acct = base({
      overdueBalanceCents: 100_000,
      openBalanceCents: 100_000,
      invoices: [{ id: 'i1', invoiceNumber: 'INV-1', dueDate: '2026-07-01', balanceCents: 100_000, daysOverdue: 31, lastStageSent: 'FIRST_NOTICE', lastReminderAt: '2026-07-10', reminderCount: 1 }],
      promises: [{ id: 'p1', customerId: 'c1', invoiceId: 'i1', amountCents: 100_000, promiseDate: '2026-07-25', note: null, createdAt: '2026-07-15T00:00:00Z', status: 'BROKEN', daysPastPromise: 7 }],
    });
    const [row] = buildWorklist([acct], asOf);
    expect(row.hasBrokenPromise).toBe(true);
    expect(row.recommendedAction.kind).toBe('CALL_BROKEN_PROMISE');
  });
});

// ── Promise classification ───────────────────────────────────────────────────

describe('classifyPromise', () => {
  const asOf = '2026-08-01';
  it('PENDING when the promise date is in the future and still owed', () => {
    expect(classifyPromise({ amountCents: 100_000, promiseDate: '2026-08-10' }, { paidSinceCents: 0, openBalanceCents: 100_000, settled: false }, asOf)).toBe('PENDING');
  });
  it('BROKEN when the promise date has passed and money is still owed', () => {
    expect(classifyPromise({ amountCents: 100_000, promiseDate: '2026-07-20' }, { paidSinceCents: 0, openBalanceCents: 100_000, settled: false }, asOf)).toBe('BROKEN');
  });
  it('KEPT when settled or the promised amount was paid since', () => {
    expect(classifyPromise({ amountCents: 100_000, promiseDate: '2026-07-20' }, { paidSinceCents: 0, openBalanceCents: 0, settled: true }, asOf)).toBe('KEPT');
    expect(classifyPromise({ amountCents: 100_000, promiseDate: '2026-07-20' }, { paidSinceCents: 100_000, openBalanceCents: 0, settled: false }, asOf)).toBe('KEPT');
  });
});

describe('classifyPromises + brokenPromises', () => {
  const asOf = '2026-08-01';
  const promises: PromiseToPay[] = [
    { id: 'old', customerId: 'c1', invoiceId: 'i1', amountCents: 50_000, promiseDate: '2026-07-01', note: null, createdAt: '2026-06-20T00:00:00Z' },
    { id: 'new', customerId: 'c1', invoiceId: 'i1', amountCents: 50_000, promiseDate: '2026-08-15', note: 'rescheduled', createdAt: '2026-07-25T00:00:00Z' },
  ];
  it('latestOnly keeps the newest promise per target (an old broken one is superseded)', () => {
    const classified = classifyPromises(
      promises,
      () => ({ paidSinceCents: 0, openBalanceCents: 50_000, settled: false }),
      asOf,
      { latestOnly: true },
    );
    expect(classified).toHaveLength(1);
    expect(classified[0].id).toBe('new');
    expect(classified[0].status).toBe('PENDING');
    expect(brokenPromises(classified)).toHaveLength(0);
  });
  it('without latestOnly, the lapsed promise reads BROKEN', () => {
    const classified = classifyPromises(
      promises,
      () => ({ paidSinceCents: 0, openBalanceCents: 50_000, settled: false }),
      asOf,
    );
    expect(classified).toHaveLength(2);
    expect(brokenPromises(classified).map((p) => p.id)).toContain('old');
  });
});

// ── Dunning copy fallback ────────────────────────────────────────────────────

describe('deterministicDunningDraft', () => {
  const facts = {
    customerName: 'Acme', supplierName: 'Merit', invoiceNumber: 'INV-9',
    invoiceDate: '2026-06-01', dueDate: '2026-07-01', balanceCents: 250_000,
    daysOverdue: 45, payUrl: 'https://pay.test/x',
  };
  it('produces subject + body carrying the exact amount and escalates tone', () => {
    const first = deterministicDunningDraft('FIRST_NOTICE', facts);
    expect(first.tone).toBe('friendly');
    expect(first.body).toContain('$2,500.00');
    expect(first.body).toContain('Acme');
    expect(first.body).toContain('https://pay.test/x');
    const final = deterministicDunningDraft('FINAL_NOTICE', facts);
    expect(final.tone).toBe('final');
    expect(final.subject.toLowerCase()).toContain('final');
  });
});

describe('parseDunningReply', () => {
  it('parses well-formed JSON', () => {
    const d = parseDunningReply('{"subject":"Hi","body":"Please pay."}', 'FIRST_NOTICE', 'friendly');
    expect(d?.subject).toBe('Hi');
    expect(d?.body).toBe('Please pay.');
  });
  it('tolerates markdown fences', () => {
    const d = parseDunningReply('```json\n{"subject":"S","body":"B"}\n```', 'FIRST_NOTICE', 'friendly');
    expect(d?.subject).toBe('S');
  });
  it('returns null on malformed or empty output', () => {
    expect(parseDunningReply('not json', 'FIRST_NOTICE', 'friendly')).toBeNull();
    expect(parseDunningReply('{"subject":"","body":""}', 'FIRST_NOTICE', 'friendly')).toBeNull();
  });
});
