/**
 * EC-3 intercompany / interdepartmental balance math — locks the three balance
 * assertions and their tiering. These are the guardrail: the whole control is
 * arithmetic, so if a sign or a tolerance flips, every queued exception (and its
 * $-at-risk and tier) shifts. The assertions pin the documented behavior.
 *
 * Pure logic only — no Supabase, no Date.now.
 */

import { describe, it, expect } from 'vitest';
import {
  assessInterdeptBalance,
  assessIntercompanyBalance,
  assessInternalInvoiceCoverage,
  resolveBalanceTier,
  toConfidence,
  periodKeyOf,
  periodLabelOf,
  IC_THRESHOLDS,
  type InterdeptPeriodInput,
  type IntercompanyPeriodInput,
  type InvoiceCoverageInput,
} from './intercompany-balance';
import type { TierPolicy } from '@/lib/trust/score-tier';

const POLICY: TierPolicy = { autoThreshold: 0.85, reviewThreshold: 0.7, autoMaxCents: 1_000_000 };

function interdept(over: Partial<InterdeptPeriodInput> = {}): InterdeptPeriodInput {
  return {
    locationId: 'loc1',
    companyName: 'Acme Co',
    periodKey: '2026-03',
    elimRevenueCents: 500_000,
    elimCostCents: 500_000,
    ...over,
  };
}

function intercompany(over: Partial<IntercompanyPeriodInput> = {}): IntercompanyPeriodInput {
  return {
    periodKey: '2026-03',
    dueFromCents: 1_000_000,
    dueToCents: 1_000_000,
    ...over,
  };
}

function coverage(over: Partial<InvoiceCoverageInput> = {}): InvoiceCoverageInput {
  return {
    locationId: 'loc1',
    companyName: 'Acme Co',
    periodKey: '2026-03',
    bookedInvoiceRevenueCents: 500_000,
    postedInterdeptRevenueCents: 500_000,
    unbookedInvoices: [],
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) Interdepartment eliminating revenue == cost
// ─────────────────────────────────────────────────────────────────────────────
describe('assessInterdeptBalance — interdept revenue must equal interdept cost', () => {
  it('returns null when revenue == cost (in balance)', () => {
    expect(assessInterdeptBalance(interdept())).toBeNull();
  });

  it('returns null for a fully cost-transfer period (both sides zero)', () => {
    expect(assessInterdeptBalance(interdept({ elimRevenueCents: 0, elimCostCents: 0 }))).toBeNull();
  });

  it('flags a positive delta when revenue exceeds cost (missing cost leg)', () => {
    const sig = assessInterdeptBalance(interdept({ elimRevenueCents: 500_000, elimCostCents: 300_000 }));
    expect(sig).not.toBeNull();
    expect(sig!.deltaCents).toBe(200_000);
    expect(sig!.confidence).toBe(IC_THRESHOLDS.interdeptConfidence);
    expect(sig!.reason).toContain('revenue exceeds cost');
  });

  it('flags a negative delta when cost exceeds revenue (missing revenue leg)', () => {
    const sig = assessInterdeptBalance(interdept({ elimRevenueCents: 300_000, elimCostCents: 500_000 }));
    expect(sig).not.toBeNull();
    expect(sig!.deltaCents).toBe(-200_000);
    expect(sig!.reason).toContain('cost exceeds revenue');
  });

  it('treats a sub-tolerance delta as noise (not surfaced)', () => {
    // toleranceCents = 1, so a 0-cent delta is in balance by construction; assert
    // the boundary: exactly at tolerance surfaces, just under does not.
    expect(assessInterdeptBalance(interdept({ elimRevenueCents: 500_000, elimCostCents: 500_000 }))).toBeNull();
    const atBoundary = assessInterdeptBalance(interdept({ elimRevenueCents: 500_001, elimCostCents: 500_000 }));
    expect(atBoundary).not.toBeNull();
    expect(atBoundary!.deltaCents).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) Intercompany due-from == due-to
// ─────────────────────────────────────────────────────────────────────────────
describe('assessIntercompanyBalance — due-from (AR) must equal due-to (AP)', () => {
  it('returns null when the pair nets to zero', () => {
    expect(assessIntercompanyBalance(intercompany())).toBeNull();
  });

  it('flags a residual when due-from exceeds due-to (missing payable mirror)', () => {
    const sig = assessIntercompanyBalance(intercompany({ dueFromCents: 1_000_000, dueToCents: 700_000 }));
    expect(sig).not.toBeNull();
    expect(sig!.deltaCents).toBe(300_000);
    expect(sig!.confidence).toBe(IC_THRESHOLDS.intercompanyConfidence);
    expect(sig!.reason).toContain('due-from exceeds due-to');
  });

  it('flags a residual when due-to exceeds due-from (missing receivable mirror)', () => {
    const sig = assessIntercompanyBalance(intercompany({ dueFromCents: 700_000, dueToCents: 1_000_000 }));
    expect(sig).not.toBeNull();
    expect(sig!.deltaCents).toBe(-300_000);
    expect(sig!.reason).toContain('due-to exceeds due-from');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) One-sided internal invoice / subledger-to-GL coverage
// ─────────────────────────────────────────────────────────────────────────────
describe('assessInternalInvoiceCoverage — subledger must tie to the GL', () => {
  it('returns null when subledger ties and every invoice is GL-linked', () => {
    expect(assessInternalInvoiceCoverage(coverage())).toBeNull();
  });

  it('flags a booked invoice with no GL entry (definitively one-sided)', () => {
    const sig = assessInternalInvoiceCoverage(
      coverage({
        unbookedInvoices: [{ id: 'i1', invoiceNumber: 'II-000042', totalCents: 120_000 }],
      }),
    );
    expect(sig).not.toBeNull();
    expect(sig!.confidence).toBe(IC_THRESHOLDS.unbookedInvoiceConfidence);
    expect(sig!.deltaCents).toBeGreaterThanOrEqual(120_000);
    expect(sig!.reason).toContain('II-000042');
    expect(sig!.reason).toContain('no posted GL entry');
  });

  it('flags coverage drift when subledger total does not match posted revenue', () => {
    const sig = assessInternalInvoiceCoverage(
      coverage({ bookedInvoiceRevenueCents: 500_000, postedInterdeptRevenueCents: 450_000 }),
    );
    expect(sig).not.toBeNull();
    expect(sig!.confidence).toBe(IC_THRESHOLDS.coverageDriftConfidence);
    expect(sig!.deltaCents).toBe(50_000);
    expect(sig!.reason).toContain('more invoiced than posted');
  });

  it('takes the larger of unbooked value and coverage drift as $-at-risk', () => {
    const sig = assessInternalInvoiceCoverage(
      coverage({
        bookedInvoiceRevenueCents: 500_000,
        postedInterdeptRevenueCents: 490_000, // drift 10k
        unbookedInvoices: [{ id: 'i1', invoiceNumber: 'II-1', totalCents: 80_000 }], // 80k
      }),
    );
    expect(sig!.deltaCents).toBe(80_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tiering — a control exception always reaches a human; close = escalate
// ─────────────────────────────────────────────────────────────────────────────
describe('resolveBalanceTier', () => {
  it('escalates any imbalance in a closed period (blocks consolidation)', () => {
    expect(resolveBalanceTier(0.97, 200_000, POLICY, true)).toBe('escalate');
  });

  it('never returns auto — a low-$ open-period imbalance floors to review', () => {
    // high confidence + tiny amount would be `auto` under scoreToTier; floored up.
    expect(resolveBalanceTier(0.99, 100, POLICY, false)).toBe('review');
  });

  it('escalates a low-confidence open-period imbalance (below review threshold)', () => {
    expect(resolveBalanceTier(0.5, 200_000, POLICY, false)).toBe('escalate');
  });

  it('reviews a large open-period imbalance over the auto cap', () => {
    expect(resolveBalanceTier(0.97, 5_000_000, POLICY, false)).toBe('review');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Small pure helpers
// ─────────────────────────────────────────────────────────────────────────────
describe('helpers', () => {
  it('toConfidence clamps into numeric(5,4)', () => {
    expect(toConfidence(1)).toBe(0.9999);
    expect(toConfidence(-1)).toBe(0);
    expect(toConfidence(0.97)).toBe(0.97);
    expect(toConfidence(NaN)).toBe(0);
  });

  it('periodKeyOf extracts YYYY-MM', () => {
    expect(periodKeyOf('2026-03-15')).toBe('2026-03');
    expect(periodKeyOf('')).toBe('');
  });

  it('periodLabelOf renders a human month', () => {
    expect(periodLabelOf('2026-03')).toBe('Mar 2026');
  });
});
