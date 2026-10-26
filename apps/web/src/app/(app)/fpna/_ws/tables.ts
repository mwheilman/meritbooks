/**
 * Block → the chart kit's ChartTable (View as table · CSV · XLSX · print). Built from the SAME
 * arrays the chart draws (AC-W8) — never a second query. PURE (no React).
 */
import { agingTable, bridgeTable, categoryTable, formatValue, heatTable, pointTable, shareTable, timeSeriesTable, varianceTable } from '@/components/charts';
import type { ChartTable } from '@/components/charts';
import type { WsBlock } from '@/lib/fpna/workspace/types';

export function chartTableOf(b: WsBlock): ChartTable {
  const caption = b.title;
  switch (b.kind) {
    case 'series':
      return timeSeriesTable(b.data, { caption, unit: b.unit, actualLabel: b.eyebrow });
    case 'multi_line':
      return categoryTable(
        b.periods.map((p) => ({ key: p.key, label: p.longLabel })),
        b.lines.map((l) => ({ key: l.key, label: l.label, values: l.values })),
        { caption, unit: b.unit, categoryLabel: 'Month' },
      );
    case 'variance':
      return varianceTable(b.rows.map((r) => ({ key: r.key, label: r.label, actual: r.actual, plan: r.plan, direction: r.direction })), { caption, unit: b.unit });
    case 'bridge':
      return bridgeTable(b.steps, { caption, unit: 'money' });
    case 'aging':
      return agingTable(b.buckets, b.rows, caption);
    case 'share':
      return shareTable(b.items, { caption, unit: b.unit, itemLabel: b.itemLabel, topN: 12 });
    case 'scatter':
      return pointTable(b.points, { caption, xLabel: b.xLabel, yLabel: b.yLabel, xUnit: b.xUnit, yUnit: b.yUnit, sizeLabel: 'Revenue', sizeUnit: 'money', itemLabel: 'Company' });
    case 'heat':
      return heatTable(b.columns, b.rows, caption);
    case 'league':
      return {
        caption,
        columns: [{ key: 'label', label: b.rowHeading }, ...b.columns.map((c) => ({ key: c.key, label: c.label, unit: c.unit }))],
        rows: b.rows.map((r) => ({ key: r.key, cells: [r.label, ...r.values] })),
      };
    case 'yoy':
      return {
        caption,
        columns: [
          { key: 'line', label: 'Line' },
          { key: 'm', label: b.headings.month }, { key: 'mp', label: 'Year earlier' },
          { key: 'f', label: 'FYTD' }, { key: 'fp', label: 'Year earlier' },
          { key: 't', label: 'TTM' }, { key: 'tp', label: 'Year earlier' },
        ].map((c, i) => (i === 0 ? c : { ...c, unit: 'money' as const })),
        rows: b.rows.map((r) => ({
          key: r.key,
          cells: [r.label, r.month.current, r.month.prior, r.fytd.current, r.fytd.prior, r.ttm.current, r.ttm.prior].map((v, i) => (i === 0 ? v : r.unit === 'percent' && typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : v)),
        })),
      };
    case 'cagr':
      return {
        caption,
        columns: [{ key: 'line', label: 'Line' }, { key: 'y1', label: '1 year', unit: 'percent' }, { key: 'y3', label: '3 years', unit: 'percent' }, { key: 'y5', label: '5 years', unit: 'percent' }],
        rows: b.rows.map((r) => ({ key: r.key, cells: [r.label, ...r.rungs.map((g) => g.value)] })),
      };
    case 'seasonality':
      return {
        caption,
        columns: [{ key: 'm', label: 'Month' }, { key: 'i', label: 'Index (1.00 = average)', unit: 'ratio' }, { key: 'c', label: 'This fiscal year', unit: 'ratio' }],
        rows: b.months.map((m) => ({ key: m.key, cells: [m.label, m.index, m.current] })),
      };
    case 'tiles':
      return { caption, columns: [{ key: 'l', label: 'Measure' }, { key: 'v', label: 'Value' }, { key: 's', label: 'Basis' }], rows: b.tiles.map((t) => ({ key: t.key, cells: [t.label, formatValue(t.value, t.unit), t.sub] })) };
    case 'gauges':
      return {
        caption,
        columns: [{ key: 'c', label: 'Covenant' }, { key: 'v', label: 'Measured' }, { key: 't', label: 'Threshold' }, { key: 'h', label: 'Headroom', unit: 'percent' }, { key: 'b', label: 'Status' }],
        rows: b.gauges.map((g) => ({ key: g.key, cells: [g.label, formatValue(g.value, g.unit), formatValue(g.threshold, g.unit), g.headroomPct, g.band] })),
      };
    default: {
      const never: never = b;
      return never;
    }
  }
}
