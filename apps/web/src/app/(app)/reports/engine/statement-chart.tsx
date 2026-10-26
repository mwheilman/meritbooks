'use client';

import { useMemo, useState } from 'react';
import { Seg } from '@meritbooks/merit-ui';
import { ChartCard, TimeSeriesChart, summarizeTimeSeries, timeSeriesTable, type TimeSeriesData } from '@/components/charts';
import type { ReportResult } from '@/lib/reports/engine/types';

/** "Total revenue" → "Revenue" (a tab names the series; sentence case, never a lowercase start). */
export function seriesTabLabel(label: string): string {
  const t = label.replace(/^Total\s+/i, '').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : label;
}

/**
 * Chart slot for time-split statements (3C ChartCard contract: summary sentence, view as
 * table, CSV / XLSX). Draws one key row (revenue, gross profit, net income …) across the
 * statement's month / quarter / year columns. Preliminary periods are marked as such.
 */
export function StatementChart({ result }: { result: ReportResult }) {
  const series = result.chartSeries.filter((x) => x.points.length >= 2);
  const [rowId, setRowId] = useState(series[0]?.rowId ?? '');
  const active = series.find((x) => x.rowId === rowId) ?? series[0];
  const data: TimeSeriesData | null = useMemo(() => {
    if (!active) return null;
    return {
      periods: active.points.map((p) => {
        const col = result.columns.find((c) => c.id === p.columnId);
        return { key: p.columnId, label: p.label.split(' ')[0], longLabel: p.label, status: col?.status === 'final' ? 'closed' : 'preliminary' };
      }),
      actual: active.points.map((p) => p.cents),
    };
  }, [active, result.columns]);
  if (!active || !data) return null;
  const direction = /cost|expense/i.test(active.label) ? 'lower_is_better' : 'higher_is_better';
  const summary = summarizeTimeSeries({ metric: active.label.toLowerCase(), unit: 'money', direction, data });
  return (
    <ChartCard
      title={`${active.label} by period`}
      eyebrow="Trend"
      basis={result.basisLabel}
      period={result.subtitle.split(' · ')[1]}
      summary={summary}
      table={timeSeriesTable(data, { caption: `${active.label} — ${result.subtitle}`, unit: 'money', actualLabel: active.label })}
      height={220}
      actions={
        series.length > 1 ? (
          <Seg<string> aria-label="Series" value={active.rowId} onChange={setRowId} items={series.map((x) => ({ value: x.rowId, label: seriesTabLabel(x.label) }))} />
        ) : undefined
      }
    >
      <TimeSeriesChart data={data} unit="money" direction={direction} height={220} />
    </ChartCard>
  );
}
