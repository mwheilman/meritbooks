import { describe, expect, it } from 'vitest';
import { money } from '@meritbooks/merit-ui';
import { cents, dollars, isOverBudget, marginCents, marginPctText, sumBy } from '@/lib/pm/money';
import { parsePercent } from '@/components/job/ContractTab';
import { barGeometry } from '@/components/job/ScheduleTab';
import { activitySentence } from '@/lib/pm/activity-copy';

const job = (contract: number, est: number, budget: number | null = est) => ({ contract_revised_cents: contract, cost_estimate_cents: est, budget_total_cents: budget });

describe('money through merit-ui', () => {
  it('formats integer cents with grouping and parentheses', () => {
    expect(cents(318462)).toBe('3,184.62');
    expect(cents(-445442)).toBe('(4,454.42)');
    expect(cents(null)).toBe('—');
    expect(dollars(41200050)).toBe('412,001');
    expect(money(-9650000, { decimals: 0, sign: 'delta' })).toBe('−96,500');
  });

  it('projected margin = revised contract − cost estimate, as a fraction of contract', () => {
    expect(marginCents(job(100_000_00, 82_000_00))).toBe(18_000_00);
    expect(marginPctText(job(100_000_00, 82_000_00))).toBe('18.0%');
    expect(marginPctText(job(100_000_00, 112_500_00))).toBe('(12.5%)');
    expect(marginPctText(job(0, 5_000_00))).toBe('—');
  });

  it('a job is at risk when cost or budget exceeds a real contract', () => {
    expect(isOverBudget(job(100, 120))).toBe(true);
    expect(isOverBudget(job(100, 90, 130))).toBe(true);
    expect(isOverBudget(job(100, 90))).toBe(false);
    expect(isOverBudget(job(0, 90))).toBe(false);
  });

  it('sums cents without floats and skips nulls', () => {
    expect(sumBy([{ v: 10 }, { v: null }, { v: 5 }], (r) => r.v)).toBe(15);
  });

  it('activity never shows raw cents', () => {
    expect(activitySentence({ verb: 'contract.set', summary: 'Contract set to 4120000 cents', meta: { original_cents: 4120000 } })).toBe('Set the contract to 41,200.00');
    expect(activitySentence({ verb: 'change_order.approved', summary: 'Approved CO-2026-0004 (125000 cents)', meta: { amount_cents: 125000 } })).toBe('Approved CO-2026-0004 for 1,250.00');
    expect(activitySentence({ verb: 'change_order.void', summary: 'CO-2026-0004 moved PCO → VOID', meta: {} })).toBe('Moved CO-2026-0004 from Potential to Void');
  });
});

describe('inputs', () => {
  it('parses percent text without floats leaking', () => {
    expect(parsePercent('12.5')).toBe(0.125);
    expect(parsePercent('100%')).toBe(1);
    expect(parsePercent('101')).toBeNull();
    expect(parsePercent('abc')).toBeNull();
  });

  it('places a task bar on the job span', () => {
    const from = Date.parse('2026-10-01T00:00:00Z') / 86_400_000;
    const to = from + 9;
    expect(barGeometry({ start_on: '2026-10-01', due_on: '2026-10-05' }, from, to)).toEqual({ left: 0, width: 50 });
    expect(barGeometry({ start_on: null, due_on: null }, from, to)).toBeNull();
  });
});
