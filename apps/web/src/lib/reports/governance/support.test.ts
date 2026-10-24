import { describe, expect, it } from 'vitest';
import { diffSnapshots, statementHash, summarizeActivity, summarizeBalanceSheet, type AccountMeta } from './snapshot';
import { deadlineTiles, isPeriodEnd, latestEndedPeriod, STANDARD_DEADLINES } from './deadlines';
import { freshnessStatus } from './freshness';
import { buildCalendar } from './calendar';
import { addDays, addMonths, monthEnd, monthRange } from './periods';
import { parseDeadlines, settingsFromRow } from './load';
import { DEFAULT_RELEASE_SETTINGS, type CompanyFacts, type GovernanceFacts } from './types';

const accts = new Map<string, AccountMeta>([
  ['rev', { id: 'rev', number: '4000', name: 'Sales', type: 'REVENUE' }],
  ['cogs', { id: 'cogs', number: '5000', name: 'Materials', type: 'COGS' }],
  ['opex', { id: 'opex', number: '6000', name: 'Rent', type: 'OPEX' }],
  ['oth', { id: 'oth', number: '8000', name: 'Interest income', type: 'OTHER' }],
  ['cash', { id: 'cash', number: '1000', name: 'Cash', type: 'ASSET' }],
  ['ap', { id: 'ap', number: '2000', name: 'AP', type: 'LIABILITY' }],
  ['re', { id: 're', number: '3000', name: 'Retained earnings', type: 'EQUITY' }],
]);

describe('snapshots', () => {
  const lines = [
    { accountId: 'cash', debitCents: 10_000_00, creditCents: 0 },
    { accountId: 'rev', debitCents: 0, creditCents: 10_000_00 },
    { accountId: 'cogs', debitCents: 4_000_00, creditCents: 0 },
    { accountId: 'opex', debitCents: 1_500_00, creditCents: 0 },
    { accountId: 'ap', debitCents: 0, creditCents: 5_500_00 },
    { accountId: 'oth', debitCents: 0, creditCents: 25_00 },
    { accountId: 'cash', debitCents: 25_00, creditCents: 0 },
  ];

  it('summarizes the month in natural signs (bigint cents)', () => {
    const s = summarizeActivity(lines, accts);
    expect(s).toMatchObject({ revenueCents: 10_000_00, cogsCents: 4_000_00, opexCents: 1_500_00, otherNetCents: 25_00, netIncomeCents: 4_525_00, lineCount: 7 });
    expect(s.accountBalances.cash).toBe(10_025_00);
    expect(summarizeBalanceSheet(lines, accts)).toEqual({ assetsCents: 10_025_00, liabilitiesCents: 5_500_00, equityCents: 0 });
  });

  it('the hash is order-independent and changes when any account changes', () => {
    const a = summarizeActivity(lines, accts);
    const b = summarizeActivity([...lines].reverse(), accts);
    expect(a.statementHash).toBe(b.statementHash);
    expect(a.statementHash).toHaveLength(64);
    const c = summarizeActivity([...lines, { accountId: 'opex', debitCents: 1_00, creditCents: 0 }, { accountId: 'ap', debitCents: 0, creditCents: 1_00 }], accts);
    expect(c.statementHash).not.toBe(a.statementHash);
    expect(statementHash({})).toBe(statementHash({}));
  });

  it('a reclass inside the month (same net income) is still a change, with the accounts named', () => {
    const base = summarizeActivity(lines, accts);
    const reclassed = summarizeActivity([...lines, { accountId: 'cogs', debitCents: 500_00, creditCents: 0 }, { accountId: 'opex', debitCents: 0, creditCents: 500_00 }], accts);
    const snap = (s: typeof base) => ({ ...s, assetsCents: null, liabilitiesCents: null, equityCents: null });
    const d = diffSnapshots(snap(base), snap(reclassed), accts);
    expect(d.changed).toBe(true);
    expect(d.netIncomeDeltaCents).toBe(0);
    expect(d.cogsDeltaCents).toBe(500_00);
    expect(d.changedAccounts.map((x) => x.account_number).sort()).toEqual(['5000', '6000']);
    expect(d.assetsDeltaCents).toBeNull();
  });

  it('an identical re-read is not a change', () => {
    const s = summarizeActivity(lines, accts);
    const snap = { ...s, assetsCents: 1, liabilitiesCents: 2, equityCents: 3 };
    const d = diffSnapshots(snap, snap, accts);
    expect(d.changed).toBe(false);
    expect(d.changedAccounts).toEqual([]);
  });
});

describe('periods', () => {
  it('month arithmetic is calendar-exact', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-11', 3)).toBe('2027-02');
    expect(monthEnd('2028-02')).toBe('2028-02-29');
    expect(addDays('2026-08-31', 20)).toBe('2026-09-20');
    expect(monthRange('2026-11', '2027-02')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
  });
});

describe('deadline tiles', () => {
  it('quarter / year ends follow the fiscal year start', () => {
    expect(isPeriodEnd(12, 'quarterly', 1)).toBe(true);
    expect(isPeriodEnd(11, 'quarterly', 1)).toBe(false);
    expect(isPeriodEnd(6, 'annual', 7)).toBe(true);
    expect(latestEndedPeriod('2026-10-24', 'quarterly', 1)).toBe('2026-09');
    expect(latestEndedPeriod('2026-10-24', 'annual', 1)).toBe('2025-12');
  });

  it('computes due dates, due-in / overdue / met', () => {
    const tiles = deadlineTiles(STANDARD_DEADLINES, { today: '2026-10-24', fyStartMonth: 1, releasedOn: () => null, exists: () => false });
    const monthly = tiles.find((t) => t.key === 'monthly-package')!;
    expect(monthly).toMatchObject({ periodKey: '2026-09', dueDate: '2026-11-14', state: 'due', daysLeft: 21 });
    expect(monthly.text).toBe('Sep 2026 due in 21 days.');
    const q = tiles.find((t) => t.key === 'quarterly-statements')!;
    expect(q).toMatchObject({ periodKey: '2026-09', dueDate: '2026-11-29' });
    const met = deadlineTiles([STANDARD_DEADLINES[0]], { today: '2026-10-24', fyStartMonth: 1, releasedOn: (pk) => (pk === '2026-09' ? '2026-10-20' : '2026-09-20') })[0];
    expect(met).toMatchObject({ state: 'met', releasedOn: '2026-10-20' });
  });

  it('an earlier unreleased overdue package stays on the tile', () => {
    const t = deadlineTiles([{ key: 'm', label: 'Monthly', cadence: 'monthly', daysAfterPeriodEnd: 15 }], {
      today: '2026-10-24',
      fyStartMonth: 1,
      releasedOn: () => null,
    })[0];
    // Jul (due Aug 15) and Aug (due Sep 15) are both unreleased: the OLDEST overdue shows.
    expect(t).toMatchObject({ periodKey: '2026-07', state: 'overdue', daysLeft: -70 });
    expect(t.text).toBe('Jul 2026 is 70 days overdue.');
  });
});

describe('freshness status', () => {
  const base = { today: '2026-10-24', hasBooks: true, hasBankFeed: true, lastBankSyncAt: '2026-10-23T05:00:00Z', bankHealth: 'active' as const, closedThrough: '2026-09' };
  it('current / attention / behind / nothing', () => {
    expect(freshnessStatus(base).status).toBe('current');
    expect(freshnessStatus({ ...base, lastBankSyncAt: '2026-10-10T00:00:00Z' })).toMatchObject({ status: 'attention', reasons: ['The bank feed last synced 14 days ago.'] });
    expect(freshnessStatus({ ...base, bankHealth: 'login_required' }).status).toBe('attention');
    expect(freshnessStatus({ ...base, closedThrough: '2026-07' })).toMatchObject({ status: 'behind', reasons: ['Books are closed only through Jul 2026.'] });
    expect(freshnessStatus({ ...base, closedThrough: '2026-08' }).status).toBe('current');
    expect(freshnessStatus({ ...base, hasBooks: false }).status).toBe('nothing');
    expect(freshnessStatus({ ...base, hasBankFeed: false, lastBankSyncAt: null, bankHealth: null }).status).toBe('current');
  });
});

describe('settings parsing', () => {
  it('drops malformed deadlines and falls back to the tenant rule', () => {
    expect(parseDeadlines([{ cadence: 'monthly', days_after_period_end: 45, label: 'Pack' }, { cadence: 'weekly', days_after_period_end: 3 }, 'x', { cadence: 'annual', days_after_period_end: -1 }])).toEqual([
      { key: 'monthly-45', label: 'Pack', cadence: 'monthly', daysAfterPeriodEnd: 45, recipient: null },
    ]);
    const tenant = { ...DEFAULT_RELEASE_SETTINGS, autoReleaseEnabled: true };
    expect(settingsFromRow(null, tenant)).toBe(tenant);
    expect(settingsFromRow({ location_id: 'x', auto_release_enabled: false, auto_release_days: 10, auto_release_min_status: 'SOFT_CLOSE', deadlines: [] }, tenant)).toMatchObject({ autoReleaseEnabled: false, autoReleaseDays: 10, autoReleaseMinStatus: 'SOFT_CLOSE' });
  });
});

describe('reporting calendar grid', () => {
  const co = (over: Partial<CompanyFacts> = {}): CompanyFacts => ({
    locationId: 'loc-a',
    name: 'Alpha',
    fiscalYearStartMonth: 1,
    periods: [
      { year: 2026, month: 7, status: 'HARD_CLOSE', endDate: '2026-07-31', closedAt: null, reopenReason: null },
      { year: 2026, month: 8, status: 'HARD_CLOSE', endDate: '2026-08-31', closedAt: null, reopenReason: null },
      { year: 2026, month: 9, status: 'SOFT_CLOSE', endDate: '2026-09-30', closedAt: null, reopenReason: null },
      { year: 2026, month: 10, status: 'OPEN', endDate: '2026-10-31', closedAt: null, reopenReason: null },
    ],
    releases: [{ id: 'r7', year: 2026, month: 7, status: 'RELEASED', mode: 'MANUAL', releasedAt: '2026-08-20T00:00:00Z', releasedBy: 'u', withdrawnAt: null, withdrawReason: null, baselineSnapshotId: 's' }],
    restatements: [{ id: 'x', year: 2026, month: 7, detectedAt: '2026-10-02T00:00:00Z', netIncomeDeltaCents: 5, acknowledged: false }],
    coverage: null,
    settings: DEFAULT_RELEASE_SETTINGS,
    ...over,
  });

  it('labels each month: released / ready / soft close / not ended / no period / restated', () => {
    const facts: GovernanceFacts = { companies: { 'loc-a': co() }, tenantSettings: { ...DEFAULT_RELEASE_SETTINGS, deadlines: [STANDARD_DEADLINES[0]] } };
    const cal = buildCalendar(facts, { today: '2026-10-24', months: 5 });
    expect(cal.months).toEqual(['2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    const states = cal.rows[0].cells.map((c) => c.state);
    expect(states).toEqual(['no_period', 'released', 'ready', 'soft_close', 'not_ended']);
    const jul = cal.rows[0].cells[1];
    expect(jul).toMatchObject({ restatedOn: '2026-10-02', unacknowledgedRestatements: 1, canWithdraw: true, canRelease: false });
    expect(cal.rows[0].cells[2]).toMatchObject({ canRelease: true, canWithdraw: false });
    expect(cal.rows[0].cells[3].canRelease).toBe(true);
    expect(cal.rows[0].cells[4].canRelease).toBe(false);
    expect(cal.closedThrough).toBe('2026-08');
    expect(cal.releasedThrough).toBe('2026-07');
    // Jul is released; Aug (due Oct 15) is not → overdue 9 days, ahead of Sep.
    expect(cal.tenantDeadlines[0]).toMatchObject({ periodKey: '2026-08', state: 'overdue', daysLeft: -9 });
  });

  it('auto-released months read released_auto; outside-group months are marked', () => {
    const facts: GovernanceFacts = {
      companies: { 'loc-a': co({ releases: [], settings: { ...DEFAULT_RELEASE_SETTINGS, autoReleaseEnabled: true }, coverage: { inGroupFrom: '2026-08-01', inGroupUntil: null } }) },
      tenantSettings: DEFAULT_RELEASE_SETTINGS,
    };
    const cells = buildCalendar(facts, { today: '2026-10-24', months: 3 }).rows[0].cells;
    expect(cells.map((c) => c.state)).toEqual(['released_auto', 'soft_close', 'not_ended']);
    const jul = buildCalendar(facts, { today: '2026-10-24', months: 4 }).rows[0].cells[0];
    expect(jul.state).toBe('outside_group');
  });
});
