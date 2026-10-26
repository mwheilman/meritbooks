/**
 * /cash screens — server-render smoke tests over a realistic engine fixture (AC-CF11): the
 * forecast tab renders its figures, the three chart cards, the week × category grid with
 * clickable cells, the day strip and the top lists; the position tab renders the company table;
 * empty and error states render their copy. Catches runtime render errors tsc can't.
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { UseQueryResult } from '@meritbooks/merit-ui';
import { buildCashForecast, forecastBridge, horizonEndOf, topItems } from '@/lib/cash/forecast/engine';
import { recommend } from '@/lib/cash/forecast/liquidity';
import type { ForecastItem } from '@/lib/cash/forecast/types';
import type { ForecastResponse } from './cash-types';
import { ForecastTab } from './forecast-tab';
import { PositionTab } from './position-tab';

// vitest's esbuild uses the classic JSX runtime for .tsx; Next uses the automatic one.
Object.assign(globalThis, { React });

const TODAY = '2026-10-21';

function it_(p: Partial<ForecastItem> & Pick<ForecastItem, 'key' | 'direction' | 'category' | 'date' | 'amountCents'>): ForecastItem {
  return { companyId: 'A', grossCents: p.amountCents, probability: 1, certainty: 'EXPECTED', label: p.key, party: 'Acme', partyId: 'c1', source: { kind: 'INVOICE', id: 'x' }, ...p };
}

function fixture(): ForecastResponse {
  const items: ForecastItem[] = [
    it_({ key: 'ar:1', direction: 'IN', category: 'AR', date: '2026-10-23', amountCents: 1_250_000, grossCents: 1_300_000, probability: 0.96, flags: ['OVERDUE'], note: '96% likely · pays 10 days late' }),
    it_({ key: 'ap:1', direction: 'OUT', category: 'AP', date: '2026-10-28', amountCents: 400_000, source: { kind: 'BILL', id: 'b' }, party: 'Ferguson' }),
    it_({ key: 'payroll:1', direction: 'OUT', category: 'PAYROLL', date: '2026-10-30', amountCents: 900_000, certainty: 'ESTIMATED', projected: true, source: { kind: 'PAY_SCHEDULE', id: 's' } }),
    it_({ key: 'runrate:1', companyId: 'B', direction: 'OUT', category: 'OPEX_RUNRATE', date: '2026-11-02', amountCents: 300_000, certainty: 'ESTIMATED', breakdown: [{ label: 'Utilities', cents: 300_000 }] }),
    it_({ key: 'ic:1', direction: 'IN', category: 'AR', date: '2026-11-04', amountCents: 50_000, counterpartyCompanyId: 'B' }),
  ];
  const f = buildCashForecast({
    today: TODAY,
    companies: [
      { id: 'A', name: 'Heritage', openingCents: 2_000_000, minimumCents: 1_000_000 },
      { id: 'B', name: 'Clive', openingCents: 200_000, minimumCents: 250_000 },
    ],
    items,
  });
  const recs = recommend(f.companies, new Map([['B', 100_000]]));
  return {
    today: TODAY,
    forecast: f,
    scenario: { id: null, name: 'Base forecast', kind: 'BASE', adjustmentCount: 0, touched: {} },
    scenarios: [],
    positions: f.companies.map((c) => ({
      id: c.scopeId,
      name: c.name,
      bookCents: c.openingCents,
      bankCents: c.openingCents - 10_000,
      unreconciledCents: 10_000,
      openingCents: c.openingCents,
      openingBasis: 'BOOK' as const,
      minimumCents: c.minimumCents,
      alertsEnabled: true,
      accounts: [{ id: `k-${c.scopeId}`, companyId: c.scopeId, name: 'Operating', institution: 'Bank', mask: '1234', type: 'CHECKING', currentCents: c.openingCents - 10_000, availableCents: c.openingCents - 10_000, updatedAt: '2026-10-21T08:00:00Z', stale: false }],
      staleCount: 0,
      lastFeedAt: '2026-10-21T08:00:00Z',
    })),
    liquidity: { lines: [], availableByCompany: { B: 100_000 }, totalAvailableCents: 100_000 },
    recommendations: recs,
    atRisk: { totalCents: 50_000, byCompany: { A: 50_000 } },
    runRate: [],
    bridge: forecastBridge(f.combined),
    top: { receipts: topItems(f, 'combined', 'IN'), disbursements: topItems(f, 'combined', 'OUT') },
    accuracy: { mape: null, accuracy: 0.84, snapshotsOnFile: 6 },
    notes: ['1 intercompany item(s) are left out of the all-companies view (they net to zero for the group).'],
    scope: { locationId: null, companyIds: ['A', 'B'], companies: [{ id: 'A', name: 'Heritage' }, { id: 'B', name: 'Clive' }] },
    governance: null,
  };
}

function q(data: ForecastResponse | null, over: Partial<UseQueryResult<ForecastResponse>> = {}): UseQueryResult<ForecastResponse> {
  return { data, error: null, isLoading: false, refetch: async () => undefined, ...over };
}

describe('/cash forecast tab', () => {
  it('renders figures, charts, the week grid, the day strip and the top lists', () => {
    const html = renderToStaticMarkup(h(ForecastTab, { locationId: null, scenarioId: 'base', refreshKey: 0, forecast: q(fixture()) }));
    expect(html).toContain('Weekly closing cash');
    expect(html).toContain('Cash in and out by week');
    expect(html).toContain('From cash today to week 13');
    expect(html).toContain('Week by week');
    expect(html).toContain('Customer collections');
    expect(html).toContain('Top 10 receipts');
    expect(html).toContain('Export weeks (CSV)');
    // Clickable cells carry an accessible name with the amount.
    expect(html).toMatch(/aria-label="Customer collections, week 1: \$12,500"/);
    // Clive drops below its minimum → a recommendation is shown.
    expect(html).toContain('Clive:');
    expect(html).toContain('nothing moves money');
    // The combined/company view switcher (All companies).
    expect(html).toContain('All companies (combined)');
  });

  it('loading and error states', () => {
    expect(renderToStaticMarkup(h(ForecastTab, { locationId: null, scenarioId: 'base', refreshKey: 0, forecast: q(null, { isLoading: true }) }))).toContain('Building the 13-week forecast');
    const err = renderToStaticMarkup(h(ForecastTab, { locationId: null, scenarioId: 'base', refreshKey: 0, forecast: q(null, { error: 'boom' }) }));
    expect(err).toContain('Couldn’t build the forecast.');
    expect(err).toContain('boom');
  });
});

describe('/cash position tab', () => {
  it('renders the company table and figure strip', () => {
    const html = renderToStaticMarkup(h(PositionTab, { locationId: null, refreshKey: 0, forecast: fixture(), onOpenForecast: () => undefined }));
    expect(html).toContain('By company and bank');
    expect(html).toContain('Heritage');
    expect(html).toContain('Clive');
    expect(html).toContain('Cash today (books)');
    expect(html).toContain('Below minimum');
  });

  it('loading state without a forecast', () => {
    expect(renderToStaticMarkup(h(PositionTab, { locationId: null, refreshKey: 0, forecast: null, onOpenForecast: () => undefined }))).toContain('Loading the cash position');
  });

  it('horizon ends on the 13th Sunday', () => {
    expect(horizonEndOf(TODAY)).toBe('2027-01-17');
  });
});
