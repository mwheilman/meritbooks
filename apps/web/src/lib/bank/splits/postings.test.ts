import { describe, it, expect } from 'vitest';
import { planSplitEntries, splitSourceRef, SplitPlanError, type PlannedEntry } from './postings';

const A = 'loc-a';
const B = 'loc-b';
const C = 'loc-c';
const CASH = 'cash';
const IC_AR = 'ic-ar';
const IC_AP = 'ic-ap';

const dr = (e: PlannedEntry) => e.lines.reduce((s, l) => s + l.debit_cents, 0);
const cr = (e: PlannedEntry) => e.lines.reduce((s, l) => s + l.credit_cents, 0);
const lineFor = (e: PlannedEntry, acct: string) => e.lines.filter((l) => l.account_id === acct);

describe('planSplitEntries', () => {
  it('AC-2: a 3-line same-company outflow is ONE balanced JE (3 DR + CR cash) with per-line dims', () => {
    const plan = planSplitEntries({
      bankLocationId: A, cashAccountId: CASH, signedAmountCents: -18_640,
      lines: [
        { lineNo: 1, amountCents: 10_000, accountId: 'phone', locationId: A, departmentId: 'hvac' },
        { lineNo: 2, amountCents: 6_000, accountId: 'phone', locationId: A, departmentId: 'plumb', classId: 'k1' },
        { lineNo: 3, amountCents: 2_640, accountId: 'supplies', locationId: A, jobId: 'job-1', memo: 'tape' },
      ],
    });
    expect(plan).toHaveLength(1);
    const [e] = plan;
    expect(e.lines).toHaveLength(4);
    expect(dr(e)).toBe(18_640);
    expect(cr(e)).toBe(18_640);
    expect(lineFor(e, CASH)[0]).toMatchObject({ credit_cents: 18_640, debit_cents: 0 });
    expect(e.lines[1]).toMatchObject({ department_id: 'plumb', class_id: 'k1', debit_cents: 6_000 });
    expect(e.lines[2]).toMatchObject({ job_id: 'job-1', memo: 'tape' });
    expect(e.splitLineIndex).toEqual([{ lineNo: 1, index: 0 }, { lineNo: 2, index: 1 }, { lineNo: 3, index: 2 }]);
  });

  it('AC-3: a cross-company outflow books IC Receivable in A and IC Payable in B, each balanced', () => {
    const plan = planSplitEntries({
      bankLocationId: A, cashAccountId: CASH, signedAmountCents: -10_000,
      icReceivableAccountId: IC_AR, icPayableAccountId: IC_AP,
      lines: [
        { lineNo: 1, amountCents: 6_000, accountId: 'phone', locationId: A },
        { lineNo: 2, amountCents: 3_000, accountId: 'phone-b', locationId: B },
        { lineNo: 3, amountCents: 1_000, accountId: 'meals-b', locationId: B },
      ],
    });
    expect(plan.map((p) => p.locationId)).toEqual([A, B]);
    const [a, b] = plan;
    expect(dr(a)).toBe(cr(a));
    expect(dr(b)).toBe(cr(b));
    expect(lineFor(a, IC_AR)[0]).toMatchObject({ debit_cents: 4_000, counterparty_location_id: B, location_id: A });
    expect(lineFor(a, CASH)[0]).toMatchObject({ credit_cents: 10_000 });
    expect(lineFor(b, IC_AP)[0]).toMatchObject({ credit_cents: 4_000, counterparty_location_id: A, location_id: B });
    expect(b.lines.every((l) => l.location_id === B)).toBe(true);
    expect(b.splitLineIndex).toEqual([{ lineNo: 2, index: 0 }, { lineNo: 3, index: 1 }]);
  });

  it('AC-4: a cross-company inflow mirrors it (A owes B the cash it collected for B)', () => {
    const plan = planSplitEntries({
      bankLocationId: A, cashAccountId: CASH, signedAmountCents: 5_000,
      icReceivableAccountId: IC_AR, icPayableAccountId: IC_AP,
      lines: [
        { lineNo: 1, amountCents: 2_000, accountId: 'rev-a', locationId: A },
        { lineNo: 2, amountCents: 3_000, accountId: 'rev-b', locationId: B },
      ],
    });
    const [a, b] = plan;
    expect(lineFor(a, CASH)[0]).toMatchObject({ debit_cents: 5_000 });
    expect(lineFor(a, 'rev-a')[0]).toMatchObject({ credit_cents: 2_000 });
    expect(lineFor(a, IC_AP)[0]).toMatchObject({ credit_cents: 3_000, counterparty_location_id: B });
    expect(lineFor(b, IC_AR)[0]).toMatchObject({ debit_cents: 3_000, counterparty_location_id: A });
    expect(lineFor(b, 'rev-b')[0]).toMatchObject({ credit_cents: 3_000 });
    expect(dr(a)).toBe(cr(a));
    expect(dr(b)).toBe(cr(b));
  });

  it('splits to three companies, including none left in the bank company', () => {
    const plan = planSplitEntries({
      bankLocationId: A, cashAccountId: CASH, signedAmountCents: -900,
      icReceivableAccountId: IC_AR, icPayableAccountId: IC_AP,
      lines: [
        { lineNo: 1, amountCents: 300, accountId: 'x', locationId: B },
        { lineNo: 2, amountCents: 600, accountId: 'y', locationId: C },
      ],
    });
    expect(plan).toHaveLength(3);
    expect(plan[0].lines.filter((l) => l.account_id === IC_AR).map((l) => [l.counterparty_location_id, l.debit_cents])).toEqual([[B, 300], [C, 600]]);
    for (const e of plan) expect(dr(e)).toBe(cr(e));
  });

  it('refuses an unbalanced split, a cross-company split without IC accounts, and duplicate line numbers', () => {
    expect(() => planSplitEntries({ bankLocationId: A, cashAccountId: CASH, signedAmountCents: -100, lines: [{ lineNo: 1, amountCents: 90, accountId: 'x', locationId: A }] })).toThrow(SplitPlanError);
    expect(() => planSplitEntries({ bankLocationId: A, cashAccountId: CASH, signedAmountCents: -100, lines: [{ lineNo: 1, amountCents: 100, accountId: 'x', locationId: B }] })).toThrow(/Intercompany/);
    expect(() => planSplitEntries({
      bankLocationId: A, cashAccountId: CASH, signedAmountCents: -100,
      lines: [{ lineNo: 1, amountCents: 50, accountId: 'x', locationId: A }, { lineNo: 1, amountCents: 50, accountId: 'y', locationId: A }],
    })).toThrow(/Duplicate/);
  });

  it('source refs are per posting version and per company', () => {
    expect(splitSourceRef('t1', 1, A, A)).toBe('bankfeed:t1:v1');
    expect(splitSourceRef('t1', 2, B, A)).toBe('bankfeed:t1:v2:loc-b');
  });
});
