import { describe, it, expect } from 'vitest';
import {
  normalizeContractExtraction,
  normalizeCustomerName,
  mapCadence,
  suggestRevRecMethod,
  recognizesAtBilling,
} from './contract-parse';

describe('normalizeCustomerName — match-key normalization', () => {
  it('strips punctuation, case, and common legal suffixes', () => {
    expect(normalizeCustomerName('Acme, Inc.')).toBe('acme');
    expect(normalizeCustomerName('ACME LLC')).toBe('acme');
    expect(normalizeCustomerName('Acme Corporation')).toBe('acme');
    expect(normalizeCustomerName('The Heritage Group, Ltd.')).toBe('heritage group');
  });

  it('collapses & into "and" and normalizes whitespace', () => {
    expect(normalizeCustomerName('Crystal Kitchen  &  Bath')).toBe('crystal kitchen and bath');
  });

  it('two spellings of the same company produce the same key', () => {
    expect(normalizeCustomerName('Acme, Inc.')).toBe(normalizeCustomerName('ACME LLC'));
  });

  it('returns empty string for empty/garbage', () => {
    expect(normalizeCustomerName('')).toBe('');
    expect(normalizeCustomerName(null)).toBe('');
    expect(normalizeCustomerName(42)).toBe('');
  });

  it('does not strip a suffix that is the only token', () => {
    expect(normalizeCustomerName('Ltd')).toBe('ltd');
  });
});

describe('mapCadence — free text → RecurringFrequency', () => {
  it('maps common cadence phrasing', () => {
    expect(mapCadence('monthly')).toBe('MONTHLY');
    expect(mapCadence('per month')).toBe('MONTHLY');
    expect(mapCadence('every quarter')).toBe('QUARTERLY');
    expect(mapCadence('annually')).toBe('ANNUAL');
    expect(mapCadence('per year')).toBe('ANNUAL');
    expect(mapCadence('bi-weekly')).toBe('BIWEEKLY');
    expect(mapCadence('every other week')).toBe('BIWEEKLY');
    expect(mapCadence('semi-annual')).toBe('SEMIANNUAL');
    expect(mapCadence('twice a year')).toBe('SEMIANNUAL');
    expect(mapCadence('weekly')).toBe('WEEKLY');
  });

  it('prefers the longer-period phrasing (biweekly over weekly, quarterly over month)', () => {
    expect(mapCadence('every other week')).toBe('BIWEEKLY');
    expect(mapCadence('every three months')).toBe('QUARTERLY');
  });

  it('returns null for unknown/garbage', () => {
    expect(mapCadence('whenever')).toBeNull();
    expect(mapCadence('')).toBeNull();
    expect(mapCadence(null)).toBeNull();
  });
});

describe('suggestRevRecMethod — 9-method inference', () => {
  it('maps the pattern directly when known', () => {
    expect(suggestRevRecMethod({ pattern: 'PCT_COMPLETE', timing: 'OVER_TIME', billingKind: 'MILESTONE' })).toBe('PCT_COMPLETE');
    expect(suggestRevRecMethod({ pattern: 'PCT_COSTS_INCURRED', timing: 'OVER_TIME', billingKind: 'ONE_TIME' })).toBe('PCT_COSTS_INCURRED');
    expect(suggestRevRecMethod({ pattern: 'MILESTONE', timing: 'OVER_TIME', billingKind: 'MILESTONE' })).toBe('MILESTONE');
    expect(suggestRevRecMethod({ pattern: 'COMPLETED_CONTRACT', timing: 'POINT_IN_TIME', billingKind: 'ONE_TIME' })).toBe('COMPLETED_CONTRACT');
    expect(suggestRevRecMethod({ pattern: 'AS_BILLED', timing: 'OVER_TIME', billingKind: 'ONE_TIME' })).toBe('AS_BILLED');
    expect(suggestRevRecMethod({ pattern: 'POINT_IN_TIME', timing: 'POINT_IN_TIME', billingKind: 'ONE_TIME' })).toBe('POINT_OF_SALE');
    expect(suggestRevRecMethod({ pattern: 'CASH', timing: 'UNKNOWN', billingKind: 'ONE_TIME' })).toBe('CASH');
  });

  it('straight-line becomes SUBSCRIPTION for recurring billing, RATABLY otherwise', () => {
    expect(suggestRevRecMethod({ pattern: 'STRAIGHT_LINE', timing: 'OVER_TIME', billingKind: 'RECURRING' })).toBe('SUBSCRIPTION');
    expect(suggestRevRecMethod({ pattern: 'STRAIGHT_LINE', timing: 'OVER_TIME', billingKind: 'ONE_TIME' })).toBe('RATABLY');
  });

  it('falls back to billing kind, then timing, then AS_BILLED when the pattern is unknown', () => {
    expect(suggestRevRecMethod({ pattern: 'UNKNOWN', timing: 'UNKNOWN', billingKind: 'MILESTONE' })).toBe('MILESTONE');
    expect(suggestRevRecMethod({ pattern: 'UNKNOWN', timing: 'UNKNOWN', billingKind: 'RECURRING' })).toBe('SUBSCRIPTION');
    expect(suggestRevRecMethod({ pattern: 'UNKNOWN', timing: 'POINT_IN_TIME', billingKind: 'ONE_TIME' })).toBe('POINT_OF_SALE');
    expect(suggestRevRecMethod({ pattern: 'UNKNOWN', timing: 'OVER_TIME', billingKind: 'ONE_TIME' })).toBe('RATABLY');
    expect(suggestRevRecMethod({ pattern: 'UNKNOWN', timing: 'UNKNOWN', billingKind: 'ONE_TIME' })).toBe('AS_BILLED');
  });
});

describe('recognizesAtBilling', () => {
  it('is true only for POINT_OF_SALE and AS_BILLED', () => {
    expect(recognizesAtBilling('POINT_OF_SALE')).toBe(true);
    expect(recognizesAtBilling('AS_BILLED')).toBe(true);
    expect(recognizesAtBilling('SUBSCRIPTION')).toBe(false);
    expect(recognizesAtBilling('MILESTONE')).toBe(false);
    expect(recognizesAtBilling('PCT_COMPLETE')).toBe(false);
  });
});

describe('normalizeContractExtraction — recurring retainer', () => {
  const sample = {
    customer: { name: 'Heartland Heating & Cooling, LLC', email: 'ap@heartland.example' },
    contract_title: 'Managed IT Services Agreement',
    total_contract_value: 36000,
    currency: 'USD',
    start_date: '2026-01-01',
    end_date: '2026-12-31',
    billing_kind: 'recurring',
    recurring: { cadence: 'monthly', interval_count: 1, amount: 3000, start_date: '2026-01-01', end_date: '2026-12-31', occurrences: 12 },
    rev_rec: { timing: 'over time', pattern: 'straight-line', reasoning: 'Service delivered continuously over the 12-month term.' },
    confidence: { customer: 0.95, total_contract_value: 0.9, dates: 0.9, billing_kind: 0.95, schedule: 0.9, rev_rec: 0.9 },
    document_note: null,
  };

  it('maps money to cents, infers RECURRING, and suggests SUBSCRIPTION', () => {
    const c = normalizeContractExtraction(sample);
    expect(c.billing_kind).toBe('RECURRING');
    expect(c.total_contract_value_cents).toBe(3_600_000);
    expect(c.recurring).not.toBeNull();
    expect(c.recurring?.cadence).toBe('MONTHLY');
    expect(c.recurring?.amount_cents).toBe(300_000);
    expect(c.recurring?.occurrences).toBe(12);
    expect(c.rev_rec.method).toBe('SUBSCRIPTION');
    expect(c.rev_rec.recognizesAtBilling).toBe(false);
    expect(c.customer.matchKey).toBe('heartland heating and cooling');
  });

  it('derives the per-period amount from total / occurrences when not stated', () => {
    const c = normalizeContractExtraction({ ...sample, recurring: { ...sample.recurring, amount: null } });
    expect(c.recurring?.amount_cents).toBe(300_000); // 3,600,000 / 12
  });
});

describe('normalizeContractExtraction — milestone SOW', () => {
  const sample = {
    customer: { name: 'Artistry Homes Inc.' },
    contract_title: 'SOW #7 — Kitchen Remodel',
    total_contract_value: null,
    billing_kind: 'milestone',
    milestones: [
      { name: 'Deposit', due_date: '2026-02-01', amount: 10000 },
      { name: 'Rough-in complete', due_date: '2026-03-15', amount: 15000 },
      { name: 'Final', due_date: 'invalid-date', amount: 5000 },
    ],
    rev_rec: { timing: 'over time', pattern: 'milestone' },
    confidence: { customer: 0.9, rev_rec: 0.85 },
  };

  it('normalizes milestones, sums total from parts, and suggests MILESTONE', () => {
    const c = normalizeContractExtraction(sample);
    expect(c.billing_kind).toBe('MILESTONE');
    expect(c.milestones).toHaveLength(3);
    expect(c.milestones[0].amount_cents).toBe(1_000_000);
    expect(c.milestones[2].due_date).toBeNull(); // malformed date rejected
    expect(c.total_contract_value_cents).toBe(3_000_000); // summed
    expect(c.rev_rec.method).toBe('MILESTONE');
  });
});

describe('normalizeContractExtraction — one-time fixed fee', () => {
  const sample = {
    customer: { name: 'Clive Power Equipment' },
    total_contract_value: 8000,
    billing_kind: 'one_time',
    line_items: [
      { description: 'Website rebuild', quantity: 1, unit_amount: 8000, amount: 8000 },
    ],
    rev_rec: { timing: 'point in time', pattern: 'on completion' },
    confidence: { customer: 0.9, total_contract_value: 0.9, rev_rec: 0.7 },
  };

  it('normalizes a one-time invoice and maps completion => COMPLETED_CONTRACT', () => {
    const c = normalizeContractExtraction(sample);
    expect(c.billing_kind).toBe('ONE_TIME');
    expect(c.line_items).toHaveLength(1);
    expect(c.line_items[0].amount_cents).toBe(800_000);
    expect(c.milestones).toHaveLength(0);
    expect(c.recurring).toBeNull();
    expect(c.rev_rec.method).toBe('COMPLETED_CONTRACT');
  });

  it('derives a line total from quantity * unit when the total is omitted', () => {
    const c = normalizeContractExtraction({
      ...sample,
      line_items: [{ description: 'Hours', quantity: 10, unit_amount: 150, amount: null }],
    });
    expect(c.line_items[0].amount_cents).toBe(150_000); // 10 * $150
    expect(c.line_items[0].unit_price_cents).toBe(15_000);
  });
});

describe('normalizeContractExtraction — blanks & robustness', () => {
  it('flags blank-but-needed fields and never throws on garbage', () => {
    const c = normalizeContractExtraction({ customer: {}, billing_kind: 'one_time' });
    expect(c.customer.name).toBeNull();
    expect(c.total_contract_value_cents).toBeNull();
    expect(c.lowConfidenceFields).toContain('customer');
    expect(c.lowConfidenceFields).toContain('total_contract_value');
    expect(c.lowConfidenceFields).toContain('line_items');
    expect(c.rev_rec.method).toBe('AS_BILLED'); // safe default
  });

  it('returns a safe ONE_TIME skeleton for null/empty input', () => {
    const c = normalizeContractExtraction(null);
    expect(c.billing_kind).toBe('ONE_TIME');
    expect(c.line_items).toEqual([]);
    expect(c.milestones).toEqual([]);
    expect(c.recurring).toBeNull();
    expect(c.customer.name).toBeNull();
  });

  it('rejects malformed contract dates rather than persisting them', () => {
    const c = normalizeContractExtraction({
      customer: { name: 'X' },
      start_date: 'Jan 2026',
      end_date: '2026-13-40',
      billing_kind: 'one_time',
      line_items: [{ description: 'a', amount: 100 }],
    });
    expect(c.start_date).toBeNull();
    expect(c.end_date).toBeNull();
  });
});
