/**
 * FP&A workspace — server pieces without a database: the view cache (AC-W5), the PDF export
 * renders from a computed view (AC-W11), pack items are parsed defensively (AC-W11), and every
 * new route checks a permission and computes through the governed loader (AC-W7, static).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToBuffer } from '@react-pdf/renderer';
import { company, dataset, flat } from '@/lib/metrics/__fixtures__/dataset';
import { ViewCache, viewKey } from './server/cache';
import { WorkspacePdf, scopeLabelOf } from './server/pdf';
import { addToPackSchema, itemDashboard, parsePackItems } from './pack-items';
import { viewQuerySchema } from './query';
import type { EvalCtx } from './series';
import type { BlocksViewResponse, DashboardViewResponse, WsEnvelope } from './types';
import { performanceBlocks } from './views/performance';
import { dashboardCards } from './views/dashboard';

(globalThis as unknown as { React: typeof React }).React = React;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = path.resolve(HERE, '../../../app/api/fpna/workspace');

function ctx(): EvalCtx {
  const a = company({ id: 'a', name: 'Alder', closedThrough: '2026-08', flows: { revenue: flat('2023-01', '2026-09', 1_000_000), cogs: flat('2023-01', '2026-09', 600_000), opex: flat('2023-01', '2026-09', 200_000), cash: flat('2023-01', '2026-09', 10_000) }, opening: { cash: 500_000 } });
  return { ds: dataset([a], { rangeStart: '2023-01', latestMonth: '2026-09' }), scope: { companyIds: ['a'], weighting: 'full' }, names: new Map([['a', 'Alder']]), memo: new Map() };
}

const env = (preview: boolean): Omit<WsEnvelope, 'tab'> => ({
  period: { end: '2026-09', basis: 'ytd', comparison: 'prior_year', from: '2026-01', to: '2026-09', label: 'YTD Sep 2026', comparisonLabel: 'the same period last year', fyStartMonth: 1 },
  scope: { companies: [{ id: 'a', name: 'Alder', ownershipPct: null, closedThrough: '2026-08' }], weighting: 'full', requested: [] },
  governance: { audience: 'finance', closedThrough: '2026-08', releasedThrough: null, preview, footnote: 'Books closed through Aug 2026' },
  generatedAt: '2026-10-15T12:00:00Z',
  cached: false,
  epoch: 'e1',
});

describe('AC-W5 view cache', () => {
  it('expires after the TTL, evicts least-recently-used beyond the cap, keys are order-independent', () => {
    let now = 0;
    const c = new ViewCache<number>(1000, 2, () => now);
    c.set('a', 1);
    c.set('b', 2);
    expect(c.get('a')).toBe(1); // touch a
    c.set('c', 3); // evicts b (least recently used)
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe(1);
    now = 1500;
    expect(c.get('a')).toBeUndefined();
    expect(viewKey({ b: 1, a: 'x' })).toBe(viewKey({ a: 'x', b: 1 }));
    expect(viewKey({ epoch: 'e1' })).not.toBe(viewKey({ epoch: 'e2' }));
  });
});

describe('AC-W11 export and packs', () => {
  it('renders a dashboard and a tab to PDF from the computed view (preview watermark when unclosed)', async () => {
    const c = ctx();
    const dash: DashboardViewResponse = {
      ...env(true),
      tab: 'dashboard',
      dashboard: { ...itemDashboard({ id: '00000000-0000-4000-8000-000000000001', name: 'Board', packKey: 'cfo', cards: [{ metric: 'revenue', size: 'm' }, { metric: 'gross_margin', size: 's' }], settings: { basis: 'ytd', comparison: 'prior_year', sparkline: 12 }, companies: [], weighting: 'full', sourceRef: 'pack:cfo', addedBy: 'u', addedAt: '' }) },
      cards: dashboardCards(c, [{ metric: 'revenue', size: 'm' }, { metric: 'gross_margin', size: 's' }, { metric: 'backlog', size: 's' }], '2026-09', { basis: 'ytd', comparison: 'prior_year', sparkline: 12 }),
    };
    const buf = await renderToBuffer(React.createElement(WorkspacePdf, { view: dash, scopeLabel: scopeLabelOf(dash) }) as Parameters<typeof renderToBuffer>[0]);
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    const tab: BlocksViewResponse = { ...env(false), tab: 'performance', blocks: performanceBlocks(c, '2026-09', 12), notices: [{ tone: 'info', title: 'Note', body: 'x' }] };
    const buf2 = await renderToBuffer(React.createElement(WorkspacePdf, { view: tab, scopeLabel: 'Alder' }) as Parameters<typeof renderToBuffer>[0]);
    expect(buf2.length).toBeGreaterThan(2000);
  }, 60_000);

  it('pack items: the request needs exactly one target; stored items drop anything malformed or unknown', () => {
    const base = { dashboardRef: 'pack:cfo', name: 'Board', packKey: 'cfo', cards: [{ metric: 'revenue', size: 'm' }], settings: { basis: 'ytd', comparison: 'prior_year', sparkline: 12 }, companies: [], weighting: 'full' };
    expect(addToPackSchema.safeParse(base).success).toBe(false);
    expect(addToPackSchema.safeParse({ ...base, newPackName: 'Monthly' }).success).toBe(true);
    expect(addToPackSchema.safeParse({ ...base, newPackName: 'Monthly', packId: '00000000-0000-4000-8000-000000000001' }).success).toBe(false);
    expect(addToPackSchema.safeParse({ ...base, cards: [{ metric: 'not_a_metric', size: 'm' }], newPackName: 'x' }).success).toBe(false);
    const good = { id: '00000000-0000-4000-8000-000000000002', name: 'Board', packKey: 'cfo', cards: [{ metric: 'revenue', size: 'm' }, { metric: 'nope', size: 's' }], settings: { basis: 'ytd', comparison: 'prior_year', sparkline: 12 }, companies: [], weighting: 'full', sourceRef: 'pack:cfo', addedBy: 'u', addedAt: 't' };
    const parsed = parsePackItems([good, { id: 'x' }, 'junk', null]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].cards).toEqual([{ metric: 'revenue', size: 'm' }]);
    expect(parsePackItems('not an array')).toEqual([]);
  });

  it('the view query refuses unknown metrics, bad company ids and custom ranges', () => {
    expect(viewQuerySchema.safeParse({ tab: 'dashboard', cards: 'revenue:m,nope:s' }).success).toBe(false);
    expect(viewQuerySchema.safeParse({ tab: 'dashboard', cards: 'revenue:m,revenue:s' }).success).toBe(false);
    expect(viewQuerySchema.safeParse({ companies: 'not-a-uuid' }).success).toBe(false);
    expect(viewQuerySchema.safeParse({ basis: 'range' }).success).toBe(false);
    const ok = viewQuerySchema.parse({ tab: 'group', companies: '11111111-1111-4111-8111-111111111111', range: '24' });
    expect(ok).toMatchObject({ tab: 'group', companies: ['11111111-1111-4111-8111-111111111111'], range: 24, weighting: 'full' });
  });
});

describe('AC-W7 every new route is guarded and governed (static)', () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^route\.tsx?$/.test(e.name)) files.push(p);
    }
  };
  walk(API);

  it('finds the eight routes', () => {
    expect(files.map((f) => path.relative(API, f)).sort()).toEqual([
      'add-to-pack/route.ts', 'catalog/route.ts', 'dashboards/[id]/route.ts', 'dashboards/publish/route.ts', 'dashboards/route.ts', 'export/route.tsx', 'summarize/route.ts', 'view/route.ts',
    ]);
  });

  for (const rel of ['view/route.ts', 'summarize/route.ts', 'export/route.tsx', 'catalog/route.ts', 'dashboards/route.ts', 'dashboards/[id]/route.ts', 'dashboards/publish/route.ts', 'add-to-pack/route.ts']) {
    it(`${rel}: authenticated wrapper + requirePermission; no admin client; figures only through the governed loader`, () => {
      const src = fs.readFileSync(path.join(API, rel), 'utf8');
      expect(src).toMatch(/apiHandler|apiQueryHandler|requireAuthedContext/);
      expect(src).toMatch(/requirePermission\(ctx\.userId, '(reports|settings_acct)', '(view|export|edit)'/);
      expect(src).not.toMatch(/createAdminSupabase/);
      if (/view|summarize|export/.test(rel)) expect(src).toMatch(/prepare\(serverCtx/);
    });
  }

  it('publishing a role default needs settings_acct:edit; export and add-to-pack need reports:export', () => {
    expect(fs.readFileSync(path.join(API, 'dashboards/publish/route.ts'), 'utf8')).toMatch(/'settings_acct', 'edit'/);
    expect(fs.readFileSync(path.join(API, 'export/route.tsx'), 'utf8')).toMatch(/'reports', 'export'/);
    expect(fs.readFileSync(path.join(API, 'add-to-pack/route.ts'), 'utf8')).toMatch(/'reports', 'export'/);
  });
});
