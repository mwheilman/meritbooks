import { describe, it, expect } from 'vitest';
import { deriveCashAdjustments, type CashPnlAccount } from './derive-cash';
import { basisPresentationLabel } from './apply-adjustments';
import { applyOverlayToExportPayload } from '@/app/(app)/reports/export-overlay';
import type { BasisOverlay } from '@/app/(app)/reports/use-basis-overlay';

// ── Fixture: one revenue account (partly uncollected → AR) and one expense account
// (partly unpaid → AP). Cash basis must recognize only the cash that actually moved. ──
const REV = 'rev-id';
const EXP = 'exp-id';
const RE = 're-id';

const accrual: CashPnlAccount[] = [
  { accountId: REV, accountNumber: '4000', normalBalance: 'CREDIT', naturalCents: 100_000 }, // billed
  { accountId: EXP, accountNumber: '6000', normalBalance: 'DEBIT', naturalCents: 40_000 },  // incurred
];
const cash: CashPnlAccount[] = [
  { accountId: REV, accountNumber: '4000', normalBalance: 'CREDIT', naturalCents: 60_000 },  // collected (40k AR)
  { accountId: EXP, accountNumber: '6000', normalBalance: 'DEBIT', naturalCents: 30_000 },  // paid (10k AP)
];

describe('deriveCashAdjustments — automatic accrual→cash presentation', () => {
  it('removes the AR/AP timing so each account moves to its cash figure', () => {
    const d = deriveCashAdjustments(accrual, cash, RE);
    const byAccount = new Map(d.adjustments.map((a) => [a.accountId, a.amountCents]));
    // Revenue drops by the uncollected 40k; expense drops by the unpaid 10k.
    expect(byAccount.get(REV)).toBe(-40_000);
    expect(byAccount.get(EXP)).toBe(-10_000);
    expect(d.pnlAdjustmentCount).toBe(2);
    // The derived set balances (adjusted trial balance still ties) via one equity offset.
    expect(d.netDebitPositiveCents).toBe(0);
    // Equity offset carries the net income difference as the reconciling plug.
    expect(byAccount.get(RE)).toBe(d.equityOffsetCents);
    expect(d.equityOffsetCents).toBe(30_000); // 40k rev − 10k exp, debit-positive
  });

  it('reproduces the compiler cash figures exactly when the deltas are applied to accrual', () => {
    const d = deriveCashAdjustments(accrual, cash, RE);
    const delta = new Map(d.adjustments.map((a) => [a.accountId, a.amountCents]));
    // accrual + delta === cash, account for account (the accrual figures cancel).
    for (const c of cash) {
      const applied = c.naturalCents; // target
      const base = accrual.find((a) => a.accountId === c.accountId)!.naturalCents;
      expect(base + (delta.get(c.accountId) ?? 0)).toBe(applied);
    }
  });

  it('produces NO adjustments (and balances) when accrual and cash are identical — GAAP untouched', () => {
    const same = accrual.map((a) => ({ ...a }));
    const d = deriveCashAdjustments(accrual, same, RE);
    expect(d.adjustments).toHaveLength(0);
    expect(d.pnlAdjustmentCount).toBe(0);
    expect(d.equityOffsetCents).toBe(0);
    expect(d.netDebitPositiveCents).toBe(0);
  });

  it('still flips the P&L exactly when no equity account exists (offset skipped, imbalance surfaced not hidden)', () => {
    const d = deriveCashAdjustments(accrual, cash, null);
    // P&L deltas present…
    expect(d.pnlAdjustmentCount).toBe(2);
    expect(d.adjustments.every((a) => a.accountId !== RE)).toBe(true);
    // …but with no plug the trial balance is off by the net-income change — reported, not hidden.
    expect(d.netDebitPositiveCents).toBe(30_000);
  });
});

describe('cash basis flows into exports (label + numbers)', () => {
  it('labels the cash basis for the export header', () => {
    expect(basisPresentationLabel('CASH')).toBe('Cash basis');
  });

  it('applies the cash deltas to the exported P&L payload so figures match the on-screen cash statement', () => {
    const d = deriveCashAdjustments(accrual, cash, RE);
    // Build the overlay the way useBasisOverlay does (per-account natural map).
    const byAccountMap = new Map<string, { naturalCents: number; items: never[] }>();
    for (const a of d.adjustments) {
      const acc = byAccountMap.get(a.accountId) ?? { naturalCents: 0, items: [] };
      acc.naturalCents += a.amountCents;
      byAccountMap.set(a.accountId, acc);
    }
    const overlay = {
      enabled: true,
      loading: false,
      error: null,
      basis: 'CASH',
      basisLabel: 'Cash basis',
      byAccount: byAccountMap,
      count: d.adjustments.length,
      netDebitPositiveCents: d.netDebitPositiveCents,
      balances: d.netDebitPositiveCents === 0,
      customLabel: null,
    } as unknown as BasisOverlay;

    const accrualExportPayload = {
      sections: [
        { type: 'REVENUE', label: 'Revenue', groups: [{ name: 'Sales', accounts: [{ accountId: REV, accountNumber: '4000', accountName: 'Service Revenue', amountCents: 100_000 }], totalCents: 100_000 }], totalCents: 100_000 },
        { type: 'OPEX', label: 'Operating Expenses', groups: [{ name: 'G&A', accounts: [{ accountId: EXP, accountNumber: '6000', accountName: 'Rent', amountCents: 40_000 }], totalCents: 40_000 }], totalCents: 40_000 },
      ],
      summary: {
        revenueCents: 100_000, cogsCents: 0, grossProfitCents: 100_000, opexCents: 40_000,
        ebitdaCents: 60_000, otherCents: 0, netIncomeCents: 60_000, grossMarginPct: 100, netMarginPct: 60,
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = applyOverlayToExportPayload('pnl', accrualExportPayload, overlay) as any;
    expect(out.summary.revenueCents).toBe(60_000); // cash revenue
    expect(out.summary.opexCents).toBe(30_000);    // cash opex
    expect(out.summary.netIncomeCents).toBe(30_000); // cash net income
    expect(out.sections[0].groups[0].accounts[0].amountCents).toBe(60_000);
  });
});
