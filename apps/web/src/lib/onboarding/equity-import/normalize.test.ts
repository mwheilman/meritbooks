/**
 * Equity cap-table normalizer + deterministic checks (PURE).
 *
 * These gate the "review, don't enter" invariants for the equity section: the model
 * (or CSV/manual) proposes owners; the deterministic checks foot ownership to 100%,
 * reconcile capital to the opening TB, and block a commit that isn't a real cap
 * table. No gateway, no Supabase — pure fixtures.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeEquityExtraction,
  normalizeOwner,
  csvRowsToOwners,
  ownershipSumCheck,
  reconcileOpeningCapital,
  capTableBlockers,
  deriveConsolidationMethod,
} from './normalize';

describe('normalizeEquityExtraction', () => {
  it('maps a loose model payload into validated owners (dollars → cents, enums, blanks)', () => {
    const raw = {
      cap_table: {
        entity_form: 'llc',
        owners: [
          {
            name: 'Alice Holdings LLC',
            ownership_pct: 60,
            capital: 600000, // whole dollars
            class: 'membership units',
            is_preferred: false,
            confidence: { name: 0.95, ownership_pct: 0.9, capital: 0.8 },
          },
          {
            name: 'Bob Vega',
            ownership_pct: 40,
            capital: null, // not stated — must stay null, never guessed
            class: 'preferred',
            is_preferred: true,
            preferred_terms: { liquidation_preference: 1, dividend_rate: 8 },
            confidence: { name: 0.9, ownership_pct: 0.9 },
          },
        ],
        snippet: 'Members hold 60% and 40% respectively',
      },
    };

    const ct = normalizeEquityExtraction(raw);
    expect(ct.entityForm).toBe('LLC');
    expect(ct.ownershipBasis).toBe('PERCENT');
    expect(ct.owners).toHaveLength(2);

    const [a, b] = ct.owners;
    expect(a.name).toBe('Alice Holdings LLC');
    expect(a.ownership_pct).toBe(60);
    expect(a.capital_contributed_cents).toBe(60_000_000); // 600,000 dollars → cents
    expect(a.equity_class).toBe('LLC_UNIT');
    expect(a.is_preferred).toBe(false);
    expect(a.owner_entity_id).toBeNull(); // linked only during human review

    expect(b.capital_contributed_cents).toBeNull(); // blank stays blank
    expect(b.equity_class).toBe('PREFERRED');
    expect(b.is_preferred).toBe(true);
    expect(b.preferred_terms?.dividend_rate).toBe(8);
  });

  it('detects a UNITS basis and flags an owner missing both percent and units', () => {
    const ct = normalizeEquityExtraction({
      cap_table: {
        owners: [
          { name: 'Founder A', units: 700_000 },
          { name: 'Founder B', units: 300_000 },
          { name: 'Mystery Owner' }, // no pct, no units
        ],
      },
    });
    expect(ct.ownershipBasis).toBe('UNITS');
    const mystery = ct.owners.find((o) => o.name === 'Mystery Owner');
    expect(mystery?.lowConfidenceFields).toContain('ownership_pct');
  });
});

describe('csvRowsToOwners (degrade-safe, AI off)', () => {
  it('produces the same ProposedOwner shape from a CSV, human-confidence', () => {
    const owners = csvRowsToOwners(
      [
        { Member: 'Alice', Pct: '55', Capital: '55000', Class: 'common' },
        { Member: 'Bob', Pct: '45', Capital: '45000', Class: 'common' },
        { Member: '', Pct: '', Capital: '' }, // blank line dropped
      ],
      { name: 'Member', ownership_pct: 'Pct', capital: 'Capital', equity_class: 'Class' },
    );
    expect(owners).toHaveLength(2);
    expect(owners[0].ownership_pct).toBe(55);
    expect(owners[0].capital_contributed_cents).toBe(5_500_000);
    expect(owners[0].confidence.name).toBe(1); // human-entered = full confidence
  });
});

describe('ownershipSumCheck', () => {
  it('flags a total that does not foot to 100%', () => {
    const check = ownershipSumCheck(
      [{ ownership_pct: 60, units: null }, { ownership_pct: 30, units: null }],
      'PERCENT',
    );
    expect(check.totalPct).toBe(90);
    expect(check.varianceFromHundred).toBe(-10);
    expect(check.withinTolerance).toBe(false);
  });

  it('derives percents from units and ties out to 100%', () => {
    const check = ownershipSumCheck(
      [{ ownership_pct: null, units: 700 }, { ownership_pct: null, units: 300 }],
      'UNITS',
    );
    expect(check.unitsTotal).toBe(1000);
    expect(check.effectivePercents).toEqual([70, 30]);
    expect(check.totalPct).toBe(100);
    expect(check.withinTolerance).toBe(true);
  });
});

describe('reconcileOpeningCapital', () => {
  it('reports a variance to the opening equity without forcing it', () => {
    const r = reconcileOpeningCapital(
      [{ capital_contributed_cents: 60_000_000 }, { capital_contributed_cents: 40_000_000 }],
      95_000_000, // opening TB equity is short by $50,000
    );
    expect(r.holderCapitalCents).toBe(100_000_000);
    expect(r.varianceCents).toBe(-5_000_000);
    expect(r.tied).toBe(false);
    expect(r.noCapitalStated).toBe(false);
  });

  it('ties (nothing to reconcile) when no capital is stated or opening is unknown', () => {
    expect(reconcileOpeningCapital([{ capital_contributed_cents: null }], 100).tied).toBe(true);
    expect(reconcileOpeningCapital([{ capital_contributed_cents: 100 }], null).tied).toBe(true);
    expect(reconcileOpeningCapital([{ capital_contributed_cents: 100 }], null).varianceCents).toBeNull();
  });
});

describe('capTableBlockers (commit gate) + consolidation method', () => {
  it('blocks an under-allocated cap table and a nameless owner', () => {
    const blockers = capTableBlockers({
      owners: [
        normalizeOwner({ name: 'Alice', ownership_pct: 60, confidence: { name: 1, ownership_pct: 1 } }),
        normalizeOwner({ name: '', ownership_pct: 30, confidence: { ownership_pct: 1 } }),
      ],
      ownershipBasis: 'PERCENT',
    });
    expect(blockers.some((b) => b.includes('name'))).toBe(true);
    expect(blockers.some((b) => b.includes('100%'))).toBe(true);
  });

  it('passes a clean 100% two-owner cap table', () => {
    const blockers = capTableBlockers({
      owners: [
        normalizeOwner({ name: 'Alice', ownership_pct: 60, confidence: { name: 1, ownership_pct: 1 } }),
        normalizeOwner({ name: 'Bob', ownership_pct: 40, confidence: { name: 1, ownership_pct: 1 } }),
      ],
      ownershipBasis: 'PERCENT',
    });
    expect(blockers).toEqual([]);
  });

  it('derives consolidation method from ownership %', () => {
    expect(deriveConsolidationMethod(100)).toBe('FULL');
    expect(deriveConsolidationMethod(51)).toBe('FULL');
    expect(deriveConsolidationMethod(30)).toBe('EQUITY');
    expect(deriveConsolidationMethod(10)).toBe('NONE');
  });
});
