import { describe, it, expect } from 'vitest';
import {
  applyEliminations,
  eliminatingResidualCents,
  consolidatedNetIncomeCents,
  type ConsolAccountInput,
} from './eliminations';

/**
 * GATE 11a correctness: consolidated statements must NET is_eliminating accounts
 * to zero at the group roll-up, leaving revenue / expense / NI unaffected by
 * internal (interdepartmental / intercompany) activity, while genuine third-party
 * costs remain. (CANON-ANCHOR §5; Master Doc II.4; FPB AC5.1 / AC-M2.)
 */
describe('consolidation eliminations', () => {
  // Two entities. $1,000 external revenue and $600 external OPEX are real
  // third-party activity. A $250 interdepartmental service is booked as Services
  // Revenue on entity A and Services Cost on entity B — both is_eliminating.
  const accounts: ConsolAccountInput[] = [
    { accountNumber: '4000', accountName: 'Sales', accountType: 'REVENUE', isEliminating: false, byLocation: { A: 60000, B: 40000 } },
    { accountNumber: '6000', accountName: 'Operating Expense', accountType: 'OPEX', isEliminating: false, byLocation: { A: 35000, B: 25000 } },
    { accountNumber: '4990', accountName: 'Interdepartmental Services Revenue', accountType: 'REVENUE', isEliminating: true, byLocation: { A: 25000 } },
    { accountNumber: '5990', accountName: 'Interdepartmental Services Cost', accountType: 'OPEX', isEliminating: true, byLocation: { B: 25000 } },
  ];

  it('nets every eliminating account to zero at the group roll-up (AC5.1)', () => {
    const result = applyEliminations(accounts, true);
    // Each eliminating account is individually zeroed in the consolidated column.
    for (const a of result.accounts.filter((x) => x.isEliminating)) {
      expect(a.consolidatedCents).toBe(0);
    }
    // And their aggregate residual is exactly zero.
    expect(eliminatingResidualCents(result)).toBe(0);
  });

  it('removes exactly the internal activity via the eliminations column', () => {
    const result = applyEliminations(accounts, true);
    // Services Revenue (25000) + Services Cost (25000) removed.
    expect(result.totalEliminationCents).toBe(-50000);
  });

  it('leaves genuine third-party revenue / expense untouched', () => {
    const result = applyEliminations(accounts, true);
    const sales = result.accounts.find((a) => a.accountNumber === '4000')!;
    const opex = result.accounts.find((a) => a.accountNumber === '6000')!;
    expect(sales.consolidatedCents).toBe(100000);
    expect(opex.consolidatedCents).toBe(60000);
  });

  it('statement ties: consolidated revenue / expense / NI reflect external activity only', () => {
    const eliminated = applyEliminations(accounts, true);
    const passthrough = applyEliminations(accounts, false);

    const totalRevenue = (r: typeof eliminated) =>
      r.accounts.filter((a) => a.accountType === 'REVENUE').reduce((s, a) => s + a.consolidatedCents, 0);
    const totalExpense = (r: typeof eliminated) =>
      r.accounts.filter((a) => a.accountType !== 'REVENUE').reduce((s, a) => s + a.consolidatedCents, 0);

    // Netted: revenue and expense are external-only (the internal $250 is gone
    // from BOTH). The pass-through view over-states each by the internal activity.
    expect(totalRevenue(eliminated)).toBe(100000);
    expect(totalExpense(eliminated)).toBe(60000);
    expect(totalRevenue(passthrough)).toBe(125000);
    expect(totalExpense(passthrough)).toBe(85000);

    // NI is unaffected by internal activity in either view (equal internal legs),
    // and equals the external net income — the statement ties.
    const externalNetIncome = 100000 - 60000; // $1,000 rev − $600 opex = $400
    expect(consolidatedNetIncomeCents(eliminated)).toBe(externalNetIncome);
    expect(consolidatedNetIncomeCents(passthrough)).toBe(externalNetIncome);
  });

  it('pass-through mode reports zero eliminations', () => {
    const result = applyEliminations(accounts, false);
    expect(result.totalEliminationCents).toBe(0);
    for (const a of result.accounts) {
      expect(a.eliminationCents).toBe(0);
      expect(a.consolidatedCents).toBe(a.grossCents);
    }
  });
});
