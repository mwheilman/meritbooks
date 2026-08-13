/**
 * Onboarding section registry — the pure pieces the shell + checklist share:
 *   • each section's deriveStatus (live-count `done` wins over stale stored state)
 *   • the "ready to operate" criteria + goLiveReady predicate
 */

import { describe, it, expect } from 'vitest';
import type { OnboardingStatus, SectionStatusMap } from '@/lib/onboarding/status';
import {
  ONBOARDING_SECTIONS,
  WIZARD_FLOW_SECTIONS,
  getSection,
  readyToOperateCriteria,
  goLiveReady,
} from './registry';

function makeStatus(overrides: {
  counts?: Partial<OnboardingStatus['counts']>;
  hasOpeningEntry?: boolean;
  sections?: SectionStatusMap;
}): OnboardingStatus {
  return {
    firstRun: true,
    complete: false,
    currentStep: 'welcome',
    counts: {
      entities: 0,
      accounts: 0,
      teamMembers: 0,
      glEntries: 0,
      bankAccounts: 0,
      categorizedTransactions: 0,
      customers: 0,
      openArInvoices: 0,
      vendors: 0,
      openApBills: 0,
      debts: 0,
      leases: 0,
      fixedAssets: 0,
      equityHolders: 0,
      ...(overrides.counts ?? {}),
    },
    hasOpeningEntry: overrides.hasOpeningEntry ?? false,
    setupComplete: false,
    statePersisted: true,
    flag: null,
    sections: overrides.sections ?? {},
  };
}

describe('section deriveStatus', () => {
  it('welcome/coa/opening/bank/team report done from live counts', () => {
    const s = makeStatus({
      counts: { entities: 1, accounts: 251, teamMembers: 3, bankAccounts: 2 },
      hasOpeningEntry: true,
    });
    expect(getSection('welcome')!.deriveStatus(s)).toBe('done');
    expect(getSection('coa')!.deriveStatus(s)).toBe('done');
    expect(getSection('opening')!.deriveStatus(s)).toBe('done');
    expect(getSection('bank')!.deriveStatus(s)).toBe('done');
    expect(getSection('team')!.deriveStatus(s)).toBe('done');
  });

  it('a live-count done WINS over a stale stored status', () => {
    const s = makeStatus({
      counts: { entities: 1 },
      sections: { welcome: { status: 'not_started', updatedAt: '2020-01-01T00:00:00Z' } },
    });
    expect(getSection('welcome')!.deriveStatus(s)).toBe('done'); // derived beats stale stored
  });

  it('falls back to the stored hint when there is no live signal', () => {
    const s = makeStatus({
      sections: { erp: { status: 'skipped', updatedAt: '2026-01-01T00:00:00Z' } },
    });
    // erp has no count signal → the persisted hint governs.
    expect(getSection('erp')!.deriveStatus(s)).toBe('skipped');
  });

  it('defaults to not_started with neither a live signal nor a stored hint', () => {
    const s = makeStatus({});
    expect(getSection('erp')!.deriveStatus(s)).toBe('not_started');
    expect(getSection('welcome')!.deriveStatus(s)).toBe('not_started');
  });

  it('team is only done with MORE than the founding user', () => {
    expect(getSection('team')!.deriveStatus(makeStatus({ counts: { teamMembers: 1 } }))).toBe('not_started');
    expect(getSection('team')!.deriveStatus(makeStatus({ counts: { teamMembers: 2 } }))).toBe('done');
  });

  it('the WIZARD FLOW sections are exactly the six inaugural steps, in order', () => {
    expect(WIZARD_FLOW_SECTIONS.map((s) => s.key)).toEqual(['welcome', 'coa', 'opening', 'bank', 'erp', 'team']);
  });

  it('the full registry ALSO carries the seven long-tail Setup-Home domains', () => {
    expect(ONBOARDING_SECTIONS.map((s) => s.key)).toEqual([
      'welcome', 'coa', 'opening', 'bank', 'erp', 'team',
      'customers_ar', 'vendors_ap', 'jobs_wip', 'debt', 'leases', 'fixed_assets', 'equity',
    ]);
  });

  it('every registered long-tail domain resolves via getSection', () => {
    for (const key of ['customers_ar', 'vendors_ap', 'jobs_wip', 'debt', 'leases', 'fixed_assets', 'equity'] as const) {
      expect(getSection(key)?.key).toBe(key);
    }
  });
});

describe('readyToOperateCriteria + goLiveReady', () => {
  it('is NOT ready with no company', () => {
    const s = makeStatus({});
    expect(goLiveReady(s)).toBe(false);
    const opening = readyToOperateCriteria(s).find((c) => c.key === 'opening')!;
    expect(opening.done).toBe(false);
  });

  it('rev-rec derives done from a company existing (chosen at creation)', () => {
    const s = makeStatus({ counts: { entities: 1 } });
    const revrec = readyToOperateCriteria(s).find((c) => c.key === 'revrec')!;
    expect(revrec.done).toBe(true);
  });

  it('is ready once a company exists AND opening balances are posted', () => {
    const s = makeStatus({ counts: { entities: 1 }, hasOpeningEntry: true });
    expect(goLiveReady(s)).toBe(true);
  });

  it('a clean-start business (opening skipped) is ready without a posted opening entry', () => {
    const s = makeStatus({
      counts: { entities: 1 },
      hasOpeningEntry: false,
      sections: { opening: { status: 'skipped', updatedAt: '2026-01-01T00:00:00Z' } },
    });
    expect(goLiveReady(s)).toBe(true);
  });

  it('an n_a opening also satisfies the opening gate', () => {
    const s = makeStatus({
      counts: { entities: 1 },
      sections: { opening: { status: 'n_a', updatedAt: '2026-01-01T00:00:00Z' } },
    });
    expect(goLiveReady(s)).toBe(true);
  });

  it('is NOT ready with a company but no opening (and not skipped)', () => {
    const s = makeStatus({ counts: { entities: 1 }, hasOpeningEntry: false });
    expect(goLiveReady(s)).toBe(false);
  });
});
