/**
 * Extended tie-out + Conversion Reconciliation — pure-function correctness.
 *
 * Proves the accuracy backbone: each subledger/WIP stream must foot to its control
 * account (variance zero) or go-live blocks; and the MeritBooks-vs-Source report
 * computes variances and the overall zero-variance verdict correctly. All cents.
 */

import { describe, it, expect } from 'vitest';
import {
  tieSubledgerToControl,
  subledgerControlBlockers,
  allSubledgersTie,
} from './tie-out';
import {
  reconLine,
  buildSection,
  buildReconciliation,
  reconciliationBlockers,
} from './report';

describe('subledger → control ties (extended tie-out gate)', () => {
  it('ties when the subledger detail foots exactly to its control account', () => {
    const t = tieSubledgerToControl('AR', 'Accounts Receivable', 'AR_CONTROL', 1_250_00, 1_250_00);
    expect(t.ties).toBe(true);
    expect(t.varianceCents).toBe(0);
    expect(subledgerControlBlockers([t])).toEqual([]);
  });

  it('detects a variance when AR detail disagrees with the 1100 control', () => {
    // Σ open AR by customer = 1,250.00; control opening balance = 1,240.00 → off by 10.00.
    const t = tieSubledgerToControl('AR', 'Accounts Receivable', 'AR_CONTROL', 1_250_00, 1_240_00);
    expect(t.ties).toBe(false);
    expect(t.varianceCents).toBe(1_000); // 10.00 in cents
    const blockers = subledgerControlBlockers([t]);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('AR_CONTROL');
    expect(blockers[0]).toContain('1000'); // 1000 cents off
  });

  it('detects a variance for AP and for WIP contract accounts (1180 / 2410)', () => {
    const ap = tieSubledgerToControl('AP', 'Accounts Payable', 'AP_CONTROL', 800_00, 799_00);
    const unbilled = tieSubledgerToControl('UNBILLED', 'Unbilled receivable', 'UNBILLED_RECEIVABLE', 50_000_00, 50_000_00);
    const billings = tieSubledgerToControl('BILLINGS_EXCESS', 'Billings in excess', 'DEFERRED_REVENUE', 12_000_00, 11_000_00);
    expect(ap.ties).toBe(false);
    expect(unbilled.ties).toBe(true);
    expect(billings.ties).toBe(false);
    // Only the two non-tying streams produce blockers.
    expect(subledgerControlBlockers([ap, unbilled, billings])).toHaveLength(2);
    expect(allSubledgersTie([unbilled])).toBe(true);
    expect(allSubledgersTie([ap, unbilled])).toBe(false);
  });

  it('an empty tie list produces no blockers (backward-compatible: no subledger imported)', () => {
    expect(subledgerControlBlockers([])).toEqual([]);
    expect(allSubledgersTie([])).toBe(true);
  });
});

describe('Conversion Reconciliation — MeritBooks vs Source variance', () => {
  it('a perfectly-converted section ties to the penny', () => {
    const lines = [
      reconLine('1000', '1000 — Operating Cash', 500_000_00, 500_000_00),
      reconLine('1100', '1100 — Accounts Receivable', 250_000_00, 250_000_00),
      reconLine('2000', '2000 — Accounts Payable', -180_000_00, -180_000_00),
    ];
    const section = buildSection('OPENING_BS', 'Opening Balance Sheet', lines, { applicable: true });
    expect(section.ties).toBe(true);
    expect(section.varianceCents).toBe(0);
    const report = buildReconciliation([section], '2026-01-01T00:00:00.000Z');
    expect(report.ties).toBe(true);
    expect(report.totalAbsVarianceCents).toBe(0);
    expect(reconciliationBlockers(report)).toEqual([]);
  });

  it('surfaces the specific offending line and blocks the overall verdict on a variance', () => {
    const lines = [
      reconLine('1000', '1000 — Operating Cash', 500_000_00, 500_000_00),
      reconLine('1100', '1100 — Accounts Receivable', 250_000_00, 249_900_00), // off by 100.00
    ];
    const section = buildSection('OPENING_BS', 'Opening Balance Sheet', lines, { applicable: true });
    expect(section.ties).toBe(false);
    expect(section.varianceCents).toBe(10_000); // 100.00 in cents
    const report = buildReconciliation([section], '2026-01-01T00:00:00.000Z');
    expect(report.ties).toBe(false);
    expect(report.totalAbsVarianceCents).toBe(10_000);
    const blockers = reconciliationBlockers(report);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('Accounts Receivable');
  });

  it('a non-applicable section is neutral — never a false green, never blocks', () => {
    const wip = buildSection('WIP', 'WIP Schedule', [], { applicable: false, note: 'Not a job business.' });
    expect(wip.applicable).toBe(false);
    expect(wip.ties).toBe(true); // reported as tying so it renders neutral
    const okBs = buildSection('OPENING_BS', 'Opening BS', [reconLine('1000', 'Cash', 1_00, 1_00)], { applicable: true });
    const report = buildReconciliation([okBs, wip], '2026-01-01T00:00:00.000Z');
    expect(report.ties).toBe(true); // WIP being n/a does not gate go-live
    expect(reconciliationBlockers(report)).toEqual([]);
  });
});
