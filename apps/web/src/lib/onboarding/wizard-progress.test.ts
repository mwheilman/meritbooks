import { describe, it, expect } from 'vitest';
import {
  stepDisplayState,
  pickActiveCompanyId,
  canFinish,
  opensOnBoard,
  launchSummary,
} from './wizard-progress';
import type { CompanyOnboarding, OnboardingStatus } from './status';

function co(over: Partial<CompanyOnboarding> = {}): CompanyOnboarding {
  return {
    id: 'c1', name: 'Heritage', shortCode: 'HER', createdAt: '2026-10-01T00:00:00Z',
    opening: 'not_started', hasActivity: false, live: false, ...over,
  };
}

function status(over: Partial<OnboardingStatus> = {}): OnboardingStatus {
  return {
    firstRun: true, complete: false, currentStep: 'welcome',
    counts: {
      entities: 1, accounts: 137, teamMembers: 1, glEntries: 0, bankAccounts: 0, categorizedTransactions: 0,
      customers: 0, openArInvoices: 0, vendors: 0, openApBills: 0, debts: 0, leases: 0, fixedAssets: 0, equityHolders: 0,
    },
    hasOpeningEntry: false, setupComplete: false, statePersisted: true, flag: null, sections: {},
    companies: [co()],
    ...over,
  };
}

describe('stepDisplayState — skipped is never shown as done', () => {
  it('a step clicked past without completion reads skipped', () => {
    expect(stepDisplayState({ isCurrent: false, status: 'not_started', passed: true })).toBe('skipped');
  });
  it('a really-done step reads done', () => {
    expect(stepDisplayState({ isCurrent: false, status: 'done', passed: true })).toBe('done');
  });
  it('an explicitly skipped step ahead of the user reads skipped', () => {
    expect(stepDisplayState({ isCurrent: false, status: 'skipped', passed: false })).toBe('skipped');
  });
  it('an untouched step ahead reads upcoming; the active one reads current', () => {
    expect(stepDisplayState({ isCurrent: false, status: 'not_started', passed: false })).toBe('upcoming');
    expect(stepDisplayState({ isCurrent: true, status: 'done', passed: true })).toBe('current');
  });
});

describe('pickActiveCompanyId', () => {
  const cos = [co({ id: 'a', live: true }), co({ id: 'b', live: false }), co({ id: 'c', live: false })];
  it('prefers an explicit, existing choice', () => {
    expect(pickActiveCompanyId(cos, 'c')).toBe('c');
  });
  it('else the first company not yet live', () => {
    expect(pickActiveCompanyId(cos, null)).toBe('b');
    expect(pickActiveCompanyId(cos, 'gone')).toBe('b');
  });
  it('else the first company, else null', () => {
    expect(pickActiveCompanyId([co({ id: 'a', live: true })], null)).toBe('a');
    expect(pickActiveCompanyId([], null)).toBeNull();
  });
});

describe('canFinish — requires posted balances or an explicit fresh start', () => {
  it('blocks a company that has done neither', () => {
    expect(canFinish(co({ opening: 'not_started' }))).toBe(false);
    expect(canFinish(null)).toBe(false);
  });
  it('allows posted or started fresh', () => {
    expect(canFinish(co({ opening: 'posted' }))).toBe(true);
    expect(canFinish(co({ opening: 'started_fresh' }))).toBe(true);
  });
});

describe('opensOnBoard — a return visit after go-live opens the setup board', () => {
  it('opens the board when every company is live', () => {
    expect(opensOnBoard(status({ complete: true, companies: [co({ live: true })] }))).toBe(true);
  });
  it('stays in the flow during first run or with no companies', () => {
    expect(opensOnBoard(status())).toBe(false);
    expect(opensOnBoard(status({ complete: true, companies: [] }))).toBe(false);
    expect(opensOnBoard(null)).toBe(false);
  });
});

describe('launchSummary — reflects real state', () => {
  it('reports opening balances as Not started (never "clean start") when nothing happened', () => {
    const s = status();
    const rows = launchSummary(s, s.companies![0], { accountCount: 137, skippedSteps: new Set() });
    const opening = rows.find((r) => r.key === 'opening')!;
    expect(opening.value).toBe('Not started');
    expect(opening.state).toBe('not_started');
  });
  it('distinguishes started fresh from posted', () => {
    const fresh = launchSummary(status(), co({ opening: 'started_fresh', live: true }), { accountCount: 1, skippedSteps: new Set() });
    expect(fresh.find((r) => r.key === 'opening')!.value).toMatch(/Started fresh/);
    const posted = launchSummary(status(), co({ opening: 'posted', live: true }), { accountCount: 1, skippedSteps: new Set() });
    expect(posted.find((r) => r.key === 'opening')!.value).toMatch(/Posted/);
  });
  it('shows a skipped bank/team as Skipped, not done', () => {
    const rows = launchSummary(status(), co(), { accountCount: 1, skippedSteps: new Set(['bank', 'team'] as const) });
    expect(rows.find((r) => r.key === 'bank')!.state).toBe('skipped');
    expect(rows.find((r) => r.key === 'team')!.state).toBe('skipped');
  });
  it('counts live companies honestly', () => {
    const s = status({ companies: [co({ id: 'a', live: true }), co({ id: 'b' })] });
    expect(launchSummary(s, null, { accountCount: 0, skippedSteps: new Set() })[0].value).toBe('2 total · 1 live');
  });
});
