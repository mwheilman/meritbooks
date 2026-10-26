/**
 * AC-W8 chart = table: every block's View-as-table / CSV / XLSX is built from the same arrays
 * its chart draws. Builds every tab's blocks from a fixture dataset and checks the table cells
 * against the block's own series.
 */
import { describe, expect, it } from 'vitest';
import { monthRange } from '@/lib/analytics/months';
import { company, dataset, flat } from '@/lib/metrics/__fixtures__/dataset';
import type { EvalCtx } from '@/lib/fpna/workspace/series';
import type { WsBlock } from '@/lib/fpna/workspace/types';
import { performanceBlocks } from '@/lib/fpna/workspace/views/performance';
import { bridgeBlocks } from '@/lib/fpna/workspace/views/bridges';
import { groupBlocks } from '@/lib/fpna/workspace/views/group';
import { workingCapitalBlocks } from '@/lib/fpna/workspace/views/working-capital';
import { leverageBlocks } from '@/lib/fpna/workspace/views/leverage';
import { budgetBlocks } from '@/lib/fpna/workspace/views/budget';
import { printTable } from '@/lib/fpna/workspace/print-table';
import { chartTableToCsv } from '@/components/charts';
import { chartTableOf } from './tables';

const FROM = '2021-01';
const TO = '2026-09';

function ctx(): EvalCtx {
  const a = company({
    id: 'a', name: 'Alder', closedThrough: '2026-08', ownershipPct: 80,
    flows: { revenue: flat(FROM, TO, 900_000), cogs: flat(FROM, TO, 500_000), opex: flat(FROM, TO, 200_000), cash: flat(FROM, TO, 10_000), ar: flat(FROM, TO, 1_000), current_assets: flat(FROM, TO, 12_000), ap: flat(FROM, TO, 500), current_liabilities: flat(FROM, TO, 900) },
    opening: { cash: 100_000, ar: 50_000, current_assets: 200_000, ap: 20_000, current_liabilities: 30_000 },
    budget: { revenue: flat('2026-01', '2026-12', 950_000) },
    budgetApprovedFy: [2026],
    customerRevenue: Object.fromEntries(monthRange('2026-01', TO).map((m) => [m, { c1: 600_000, c2: 300_000 }])),
  });
  const b = company({ id: 'b', name: 'Birch', closedThrough: '2026-09', flows: { revenue: flat(FROM, TO, 400_000), cogs: flat(FROM, TO, 100_000), opex: flat(FROM, TO, 250_000) } });
  const d = dataset([a, b], { rangeStart: FROM, latestMonth: TO });
  return { ds: d, scope: { companyIds: ['a', 'b'], weighting: 'full' }, names: new Map([['a', 'Alder'], ['b', 'Birch']]), memo: new Map() };
}

function allBlocks(): WsBlock[] {
  const c = ctx();
  return [
    ...performanceBlocks(c, TO, 24),
    ...bridgeBlocks(c, { from: '2025-09', to: TO, basis: 'ytd', mode: 'periods' }),
    ...groupBlocks(c, TO, 'ytd', null, 'YTD'),
    ...workingCapitalBlocks(c, TO, 12, monthRange('2026-01', TO), new Map(), 'YTD'),
    ...leverageBlocks(c, TO, 12, null, null),
    ...budgetBlocks(c, TO, null, {}, 'YTD'),
  ];
}

describe('AC-W8 chart = table', () => {
  const blocks = allBlocks();

  it('every block yields a table (screen) and a print table (PDF) without throwing', () => {
    for (const b of blocks) {
      const t = chartTableOf(b);
      expect(t.caption, b.id).toBe(b.title);
      expect(chartTableToCsv(t).length, b.id).toBeGreaterThan(0);
      if (!b.state) expect(printTable(b), b.id).not.toBeNull();
    }
  });

  it('series tables carry exactly the plotted values, in order', () => {
    for (const b of blocks) {
      if (b.kind !== 'series') continue;
      const t = chartTableOf(b);
      expect(t.rows.map((r) => r.key), b.id).toEqual(b.data.periods.map((p) => p.key));
      const ai = t.columns.findIndex((c) => c.key === 'actual');
      expect(t.rows.map((r) => r.cells[ai]), b.id).toEqual(b.data.actual);
      if (b.data.priorYear) {
        const pi = t.columns.findIndex((c) => c.key === 'priorYear');
        expect(t.rows.map((r) => r.cells[pi]), b.id).toEqual(b.data.priorYear);
      }
    }
  });

  it('multi-line, league, bridge and share tables match their arrays', () => {
    for (const b of blocks) {
      const t = chartTableOf(b);
      if (b.kind === 'multi_line') {
        b.lines.forEach((l, k) => expect(t.rows.map((r) => r.cells[k + 1]), `${b.id}:${l.key}`).toEqual(l.values));
      }
      if (b.kind === 'league') {
        expect(t.rows.map((r) => r.cells.slice(1)), b.id).toEqual(b.rows.map((r) => r.values));
      }
      if (b.kind === 'bridge' && !b.state) {
        const deltas = b.steps.filter((s) => s.kind === 'delta').map((s) => s.value);
        const flat = t.rows.flatMap((r) => r.cells.filter((c): c is number => typeof c === 'number'));
        for (const d of deltas) expect(flat, b.id).toContain(d);
      }
    }
  });
});
