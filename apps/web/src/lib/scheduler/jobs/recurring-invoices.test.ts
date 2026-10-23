/** Security review M10 — the recurring auto-post cap is PER RUN (a running total). */
import { describe, it, expect } from 'vitest';
import { cumulativeDecider } from './recurring-invoices';
import type { RecurringDueTemplate } from '@/lib/invoices/recurring-invoices';

const CAP = 10_000;
const gate = async (amountCents: number) => (amountCents <= CAP ? { allowed: true, disposition: 'AUTO' as const } : { allowed: false, disposition: 'REVIEW' as const });
const t = (id: string, amountCents: number, mode: RecurringDueTemplate['mode'] = 'POST'): RecurringDueTemplate => ({
  id: `${id}-0000-0000`, name: id, location_id: 'L', customer_id: 'C', mode, runs: 1, amountCents,
});

describe('cumulativeDecider', () => {
  it('templates each under the cap stop auto-posting once the RUN total would exceed it', async () => {
    const d = cumulativeDecider(gate);
    expect(await d.decideMode(t('a', 4_000))).toBe('POST');
    expect(await d.decideMode(t('b', 4_000))).toBe('POST');
    expect(await d.decideMode(t('c', 4_000))).toBe('DRAFT'); // 12k > 10k
    expect(await d.decideMode(t('d', 4_000, 'POST_AND_SEND'))).toBe('DRAFT');
    expect(d.postedCents()).toBe(8_000);
    expect(d.draftedByDial()).toBe(2);
  });
  it('a smaller later template can still fit under what is left', async () => {
    const d = cumulativeDecider(gate);
    await d.decideMode(t('a', 9_000));
    expect(await d.decideMode(t('b', 5_000))).toBe('DRAFT');
    expect(await d.decideMode(t('c', 1_000))).toBe('POST');
    expect(d.postedCents()).toBe(10_000);
  });
  it('DRAFT templates never consult the gate or count', async () => {
    let asked = 0;
    const d = cumulativeDecider(async (a) => { asked++; return gate(a); });
    expect(await d.decideMode(t('a', 50_000, 'DRAFT'))).toBe('DRAFT');
    expect(asked).toBe(0);
    expect(d.postedCents()).toBe(0);
  });
});
