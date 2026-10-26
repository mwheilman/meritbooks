'use client';

/**
 * One analysis block in the ChartCard frame (portal M7): title, basis line, period chip,
 * the deterministic summary sentence (alt text), definition, legend, View as table / CSV /
 * XLSX / PNG / SVG, footnotes and "Books closed through …", drill. The table comes from the
 * same arrays the chart draws (tables.ts).
 */
import { useState, type ReactNode } from 'react';
import { ButtonLink, Seg } from '@meritbooks/merit-ui';
import {
  AgingBars,
  agingLegend,
  ChartCard,
  HeatGrid,
  MonthlyCombo,
  ScatterChart,
  ShareBars,
  ThresholdGauge,
  TimeSeriesChart,
  VarianceBars,
  WaterfallChart,
  type ChartState,
  type LegendItem,
} from '@/components/charts';
import type { WsBlock, WsBlockState } from '@/lib/fpna/workspace/types';
import { CagrLadder, LeagueTable, SeasonalityChart, Tiles, YoyTable } from './panels';
import { MultiLineChart, MultiLineLegend } from './multi-line-chart';
import { chartTableOf } from './tables';

const COMBO_LEGEND: LegendItem[] = [
  { key: 'actual', label: 'Actual', swatch: 'solid' },
  { key: 'priorYear', label: 'Same month a year earlier', swatch: 'dashed' },
  { key: 'budget', label: 'Approved budget', swatch: 'tick' },
  { key: 'ttm', label: 'Trailing twelve months', swatch: 'line' },
  { key: 'prelim', label: 'Preliminary (not closed)', swatch: 'prelim', toggle: false },
];

function toState(st: WsBlockState | undefined): ChartState | undefined {
  if (!st) return undefined;
  if (st.kind === 'unavailable') return { kind: 'unavailable', reason: st.reason, detail: st.detail };
  return { kind: 'empty', title: st.title, body: st.body, action: st.actionHref ? <ButtonLink href={st.actionHref}>{st.actionLabel ?? 'Open'}</ButtonLink> : undefined };
}

export interface BlockProps {
  block: WsBlock;
  index: number;
  closedThrough?: string;
  /** A month or a row was clicked (drill). */
  onDrill?: (block: WsBlock, key: string) => void;
  className?: string;
  exportMeta?: string[];
}

function heightOf(b: WsBlock): number {
  switch (b.kind) {
    case 'series':
      return b.chart === 'combo' ? 320 : 240;
    case 'bridge':
      return 300;
    case 'league':
    case 'heat':
    case 'yoy':
      return Math.min(560, 96 + 34 * ('rows' in b ? b.rows.length : 6));
    case 'tiles':
      return 140;
    case 'gauges':
      return Math.max(160, 70 * Math.max(1, b.gauges.length));
    default:
      return 260;
  }
}

function MultiLineBody({ block, onDrill }: { block: Extract<WsBlock, { kind: 'multi_line' }>; onDrill?: (k: string) => void }) {
  const [basis, setBasis] = useState<'month' | 'ttm'>('month');
  const alt = block.alternates?.ttm;
  const lines = basis === 'ttm' && alt ? block.lines.map((l) => ({ ...l, values: alt.find((a) => a.key === l.key)?.values ?? l.values })) : block.lines;
  return (
    <>
      {alt && (
        <div style={{ marginBottom: 8 }}>
          <Seg<'month' | 'ttm'> aria-label="Basis" value={basis} onChange={setBasis} items={[{ value: 'month', label: 'Each month' }, { value: 'ttm', label: 'Trailing 12 months' }]} />
        </div>
      )}
      <MultiLineLegend lines={lines} />
      <MultiLineChart periods={block.periods} unit={block.unit} lines={lines} onDrill={onDrill} />
    </>
  );
}

export function Block({ block: b, index, closedThrough, onDrill, className, exportMeta }: BlockProps) {
  const drill = onDrill ? (k: string) => onDrill(b, k) : undefined;
  let body: ReactNode;
  let legend: LegendItem[] | undefined;
  let value: { value: number | null; unit: 'money' | 'percent' | 'count' | 'ratio' | 'multiple' | 'days' | 'months'; label?: string } | undefined;
  let change: { current: number; base: number; unit: 'money' | 'percent' | 'count' | 'ratio' | 'multiple' | 'days' | 'months'; direction: 'higher_is_better' | 'lower_is_better' | 'neutral'; baseLabel: string } | undefined;
  switch (b.kind) {
    case 'series':
      legend = b.chart === 'combo' ? COMBO_LEGEND.filter((l) => (l.key === 'budget' ? !!b.data.budget : l.key === 'ttm' ? !!b.data.ttm : l.key === 'priorYear' ? !!b.data.priorYear : true)) : undefined;
      body = b.chart === 'combo' ? <MonthlyCombo data={b.data} unit={b.unit} direction={b.direction} onDrill={drill} /> : <TimeSeriesChart data={b.data} unit={b.unit} direction={b.direction} onDrill={drill} />;
      if (b.headline) {
        value = { value: b.headline.value, unit: b.unit, label: b.headline.label };
        if (b.headline.value !== null && b.headline.base !== null) change = { current: b.headline.value, base: b.headline.base, unit: b.unit, direction: b.direction, baseLabel: b.headline.baseLabel };
      }
      break;
    case 'multi_line':
      body = <MultiLineBody block={b} onDrill={drill} />;
      break;
    case 'variance':
      legend = [
        { key: 'f', label: 'Favourable', swatch: 'solid', toggle: false },
        { key: 'u', label: 'Unfavourable', swatch: 'neg', toggle: false },
      ];
      body = <VarianceBars rows={b.rows.slice(0, 14).map((r) => ({ key: r.key, label: r.material ? `${r.label} *` : r.label, actual: r.actual, plan: r.plan, direction: r.direction }))} unit={b.unit} planLabel={b.planLabel} onDrill={drill} />;
      break;
    case 'bridge':
      legend = [
        { key: 'anchor', label: 'Total', swatch: 'anchor', toggle: false },
        { key: 'fav', label: 'Favourable', swatch: 'solid', toggle: false },
        { key: 'unf', label: 'Unfavourable', swatch: 'neg', toggle: false },
      ];
      body = <WaterfallChart steps={b.steps} unit="money" onDrill={drill} />;
      break;
    case 'aging':
      legend = agingLegend(b.buckets);
      body = <AgingBars buckets={b.buckets} rows={b.rows} onDrill={drill ? (r) => drill(r) : undefined} />;
      break;
    case 'share':
      body = <ShareBars items={b.items} unit={b.unit} topN={10} threshold={b.threshold} onDrill={drill} />;
      break;
    case 'scatter':
      legend = [
        { key: 'pass', label: 'Clears the line', swatch: 'solid', toggle: false },
        { key: 'fail', label: 'Below', swatch: 'outline', toggle: false },
      ];
      body = <ScatterChart points={b.points} xLabel={b.xLabel} yLabel={b.yLabel} xUnit={b.xUnit} yUnit={b.yUnit} sumLine={b.sumLine} onDrill={drill} />;
      break;
    case 'heat':
      body = <HeatGrid columns={b.columns} rows={b.rows} rowHeading={b.rowHeading} caption={b.title} onDrill={drill ? (r) => drill(r) : undefined} />;
      break;
    case 'league':
      body = <LeagueTable block={b} onRow={drill} />;
      break;
    case 'yoy':
      body = <YoyTable block={b} />;
      break;
    case 'cagr':
      body = <CagrLadder block={b} />;
      break;
    case 'seasonality':
      body = <SeasonalityChart block={b} />;
      break;
    case 'tiles':
      body = <Tiles block={b} />;
      break;
    case 'gauges':
      body = (
        <>
          {b.gauges.map((g) => (
            <ThresholdGauge key={g.key} label={`${g.label} — ${g.sub}`} value={g.value} threshold={g.threshold} kind={g.thresholdKind} unit={g.unit} watch={g.watch} period={g.breachDate ? `Projected breach ${g.breachDate}` : g.band === 'BREACH' ? 'In breach' : undefined} />
          ))}
        </>
      );
      break;
    default: {
      const never: never = b;
      return never;
    }
  }
  return (
    <ChartCard
      className={className}
      index={index}
      eyebrow={b.eyebrow}
      title={b.title}
      basis={b.basis}
      period={b.period}
      value={value}
      change={change}
      definition={b.definition ? { text: b.definition.text, formula: b.definition.formula, source: b.definition.source } : undefined}
      summary={b.summary}
      legend={legend}
      table={chartTableOf(b)}
      exportMeta={exportMeta}
      state={toState(b.state)}
      closedThrough={closedThrough}
      footnotes={b.footnotes}
      drillHint={drill && (b.kind === 'series' || b.kind === 'multi_line') ? 'Click a month to see its entries' : drill && b.kind === 'variance' ? 'Click a line to see its entries' : undefined}
      height={heightOf(b)}
      onRowDrill={drill}
      primary={index === 1}
    >
      {body}
    </ChartCard>
  );
}
