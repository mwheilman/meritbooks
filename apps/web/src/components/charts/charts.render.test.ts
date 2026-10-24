/**
 * Server-render the kit and assert the accessibility + data contract on the
 * markup: labelled groups, one tab stop per chart (roving), point labels that
 * carry the values, legend toggles, the live region, the printed table, the
 * four states, and gaps that are never drawn as zero.
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AgingBars,
  BarChart,
  ChartCard,
  ChartStateView,
  ChartTableView,
  HeatGrid,
  KpiTile,
  MonthlyCombo,
  ScatterChart,
  Sparkline,
  ThresholdGauge,
  TimeSeriesChart,
  WaterfallChart,
  timeSeriesTable,
  type TimeSeriesData,
} from '.';
import { SAMPLE_AGING, SAMPLE_AGING_BUCKETS, SAMPLE_BRIDGE } from './gallery/samples';

const data: TimeSeriesData = {
  periods: [
    { key: '2026-05', label: 'May', longLabel: 'May 2026' },
    { key: '2026-06', label: 'Jun', longLabel: 'Jun 2026' },
    { key: '2026-07', label: 'Jul', longLabel: 'Jul 2026' },
    { key: '2026-08', label: 'Aug', longLabel: 'Aug 2026', status: 'preliminary' },
  ],
  actual: [1_000_000_00, null, 1_150_000_00, 1_240_000_00],
  priorYear: [900_000_00, 950_000_00, 1_000_000_00, 1_096_000_00],
  budget: [1_050_000_00, 1_100_000_00, 1_120_000_00, 1_200_000_00],
};

// vitest's esbuild uses the classic JSX runtime (React.createElement) for .tsx;
// Next uses the automatic one. Expose React for the classic transform here.
Object.assign(globalThis, { React });

const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

function card(child: ReturnType<typeof h>) {
  return renderToStaticMarkup(
    h(
      ChartCard,
      {
        title: 'Revenue by month',
        summary: 'Revenue was $1.2M in Aug 2026.',
        period: 'May – Aug 2026',
        legend: [
          { key: 'actual', label: 'Actual', swatch: 'solid' as const },
          { key: 'priorYear', label: 'Prior year', swatch: 'dashed' as const },
          { key: 'prelim', label: 'Preliminary', swatch: 'prelim' as const, toggle: false },
        ],
        table: timeSeriesTable(data, { caption: 'Revenue by month', unit: 'money' }),
        closedThrough: 'Jul 2026',
        footnotes: ['Jun 2026 not on file (gap, not zero)'],
        definition: { text: 'Revenue recognised in the period.' },
        children: child,
      },
    ),
  );
}

describe('ChartCard frame', () => {
  const html = card(h(MonthlyCombo, { data, unit: 'money', direction: 'higher_is_better', onDrill: () => undefined }));

  it('the SVG is a group named by the title AND the summary sentence', () => {
    const m = /<section class="mc-card[^"]*" aria-labelledby="([^"]+)"/.exec(html);
    expect(m).not.toBeNull();
    const titleId = m?.[1] ?? '';
    expect(html).toContain(`id="${titleId}">Revenue by month</h3>`);
    expect(html).toMatch(new RegExp(`<svg[^>]*role="group"[^>]*aria-labelledby="${titleId} [^"]+-s"`));
    expect(html).toMatch(/<p class="mc-sum" id="[^"]+-s">Revenue was \$1\.2M in Aug 2026\.<\/p>/);
  });

  it('controls: definition (i), View as table, Export — all labelled', () => {
    expect(html).toContain('aria-label="What Revenue by month means"');
    expect(html).toMatch(/<button[^>]*class="mc-tbtn"[^>]*aria-pressed="false"[^>]*>View as table<\/button>/);
    expect(html).toMatch(/aria-haspopup="menu"[^>]*>Export/);
  });

  it('legend: series are toggle buttons (aria-pressed); encodings are not', () => {
    expect(count(html, /class="mc-lgd-b" aria-pressed="true"/g)).toBe(2);
    expect(html).toContain('<li class="mc-lgd-s">');
  });

  it('a polite live region exists for announcements', () => {
    expect(html).toContain('aria-live="polite"');
  });

  it('the same table is in the DOM for print, with its caption', () => {
    expect(html).toContain('mc-print-only');
    expect(html).toContain('<caption class="sr">Revenue by month</caption>');
  });

  it('footer: books closed through + footnotes', () => {
    expect(html).toContain('Books closed through Jul 2026');
    expect(html).toContain('Jun 2026 not on file (gap, not zero)');
  });

  it('roving focus: exactly ONE tab stop among the points, on the latest period', () => {
    expect(count(html, /class="mc-pt"[^>]*tabindex="0"/g)).toBe(1);
    expect(count(html, /class="mc-pt"[^>]*tabindex="-1"/g)).toBe(data.periods.length - 1);
    expect(html).toMatch(/aria-label="Aug 2026, preliminary: actual \$1,240,000[^"]*"[^>]*tabindex="0"/);
  });

  it('point labels carry exact values, YoY and F/U variance', () => {
    expect(html).toContain('aria-label="Jul 2026: actual $1,150,000; prior year $1,000,000; vs prior year +15.0%; budget $1,120,000; variance +$30,000 · +2.7% F"');
  });

  it('drillable points are buttons', () => {
    expect(count(html, /class="mc-pt" role="button"/g)).toBe(4);
  });

  it('a missing month is a gap: no bar, an n/a mark, and "not on file" in its label', () => {
    expect(count(html, /<rect class="mc-bar[^"]*"/g)).toBe(3);
    expect(html).toContain('>n/a</text>');
    expect(html).toContain('aria-label="Jun 2026: actual Not on file;');
  });

  it('preliminary bars use the hatch pattern', () => {
    expect(html).toMatch(/class="mc-bar mc-bar--prelim[^"]*"[^>]*style="fill:url\(#mc[a-zA-Z0-9]+-prelim\)"/);
  });
});

describe('charts outside a card are still named', () => {
  it('TimeSeriesChart uses ariaLabel and draws the PY dashed path', () => {
    const html = renderToStaticMarkup(h(TimeSeriesChart, { data, unit: 'money', direction: 'higher_is_better', ariaLabel: 'Revenue trend' }));
    expect(html).toMatch(/<svg[^>]*role="group"[^>]*aria-label="Revenue trend"/);
    expect(html).toContain('class="mc-py"');
    expect(count(html, /class="mc-line"/g)).toBe(2); // split by the Jun gap
    expect(count(html, /class="mc-pt" role="img"/g)).toBe(4);
  });

  it('Waterfall points name movement, F/U and running total', () => {
    const html = renderToStaticMarkup(h(WaterfallChart, { steps: SAMPLE_BRIDGE, ariaLabel: 'EBITDA bridge' }));
    expect(html).toContain('aria-label="Payroll: −$305,000, unfavourable; running total $2,120,000"');
    expect(html).toContain('aria-label="FY 2026 EBITDA: $2,109,000"');
  });

  it('BarChart / Aging / Scatter expose one tab stop each', () => {
    const bars = renderToStaticMarkup(h(BarChart, { categories: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], series: [{ key: 's', label: 'Sales', values: [100_00, null] }], unit: 'money', ariaLabel: 'x' }));
    expect(count(bars, /tabindex="0"/g)).toBe(1);
    expect(bars).toContain('aria-label="B: not available"');
    const ag = renderToStaticMarkup(h(AgingBars, { buckets: SAMPLE_AGING_BUCKETS, rows: SAMPLE_AGING, ariaLabel: 'aging' }));
    expect(count(ag, /tabindex="0"/g)).toBe(1);
    expect(ag).toMatch(/aria-label="Acme Builders, Over 90: \$41,250, [0-9.]+% of \$306K"/);
    const sc = renderToStaticMarkup(h(ScatterChart, { points: [{ key: 'a', label: 'Alpha', x: 0.3, y: 0.2 }, { key: 'b', label: 'Beta', x: 0.05, y: 0.1 }], xLabel: 'Growth', yLabel: 'Margin', ariaLabel: 'r40' }));
    expect(sc).toContain('score 50, passes');
    expect(sc).toContain('score 15, below the line');
  });
});

describe('small components', () => {
  it('Sparkline is an image with a sentence, and names missing periods', () => {
    const html = renderToStaticMarkup(h(Sparkline, { values: [1_000_00, null, 3_000_00], unit: 'money', metric: 'Revenue' }));
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Revenue: from $1K to $3K; high $3K; 1 period missing."');
  });

  it('KpiTile: status is a word + shape; unavailable shows the reason, not a number', () => {
    const ok = renderToStaticMarkup(h(KpiTile, { label: 'DSO', value: 41, unit: 'days', direction: 'lower_is_better', status: 'off_target', change: { base: 39, baseLabel: 'Jul 2026' } }));
    expect(ok).toContain('pip--overdue');
    expect(ok).toContain('Off target');
    expect(ok).toContain('aria-label="Up 5.1%, erosion, versus Jul 2026"');
    const na = renderToStaticMarkup(h(KpiTile, { label: 'CAGR', value: null, unit: 'percent', direction: 'higher_is_better', unavailable: 'not_enough_history' }));
    expect(na).toContain('Not enough history');
    expect(na).not.toContain('mc-kpi-v');
  });

  it('ThresholdGauge names state and headroom', () => {
    const html = renderToStaticMarkup(h(ThresholdGauge, { label: 'DSCR', value: 1.1, threshold: 1.25, kind: 'min', unit: 'multiple' }));
    expect(html).toContain('Breach');
    expect(html).toContain('in breach by 12.0%');
  });

  it('HeatGrid is a grid with labelled cells and n/m for missing values', () => {
    const html = renderToStaticMarkup(
      h(HeatGrid, {
        caption: 'League',
        columns: [{ key: 'm', label: 'Margin', unit: 'percent' as const, direction: 'higher_is_better' as const }],
        rows: [
          { key: 'a', label: 'Alpha', values: [0.2] },
          { key: 'b', label: 'Beta', values: [null] },
          { key: 'c', label: 'Cove', values: [0.1] },
        ],
      }),
    );
    expect(html).toContain('role="grid"');
    expect(html).toContain('aria-label="Alpha, Margin: 20.0%, top fifth"');
    expect(html).toContain('aria-label="Beta, Margin: not meaningful"');
    expect(count(html, /tabindex="0"/g)).toBe(1);
  });

  it('table view prints gaps as em dashes and marks preliminary rows', () => {
    const html = renderToStaticMarkup(h(ChartTableView, { table: timeSeriesTable(data, { caption: 'Revenue', unit: 'money' }) }));
    expect(html).toContain('<td class="n">—</td>');
    expect(html).toContain('title="Preliminary — the period is not closed">P</abbr>');
    expect(html).toContain('<th scope="col" class="n">Actual</th>');
  });

  it('states: loading is busy status; error is an alert; unavailable names the reason', () => {
    expect(renderToStaticMarkup(h(ChartStateView, { state: { kind: 'loading' }, height: 200 }))).toMatch(/aria-busy="true" role="status"/);
    expect(renderToStaticMarkup(h(ChartStateView, { state: { kind: 'error', onRetry: () => undefined }, height: 200 }))).toContain('role="alert"');
    const na = renderToStaticMarkup(h(ChartStateView, { state: { kind: 'unavailable', reason: 'no_approved_budget' }, height: 200 }));
    expect(na).toContain('No approved budget');
    // banned copy
    for (const s of [na]) expect(s).not.toMatch(/no data|nothing to show/i);
  });
});

describe('sample data never ships', () => {
  it('only the gallery (and its route / tests) import gallery/samples', () => {
    const root = join(__dirname, '..', '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) {
          if (f === 'node_modules' || f === 'gallery') continue;
          walk(p);
        } else if (/\.(ts|tsx)$/.test(f) && !/\.test\.ts$/.test(f)) {
          if (/gallery\/samples/.test(readFileSync(p, 'utf8'))) offenders.push(p);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
