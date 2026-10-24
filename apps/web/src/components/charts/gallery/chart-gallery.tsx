'use client';

/**
 * Chart-kit gallery — internal QA surface for every component in every state.
 * EVERY card carries a "Sample" tag; the figures come from ./samples.ts and are
 * invented. Density switch (report / cockpit) and a drill log prove the
 * contract end to end. Not linked from navigation; the route is admin-guarded.
 */
import { useMemo, useState } from 'react';
import './gallery.css';
import { PeriodPicker, usePeriodParam } from '@/components/period';
import type { PeriodComparison } from '@/lib/period/resolve';
import {
  AgingBars,
  agingLegend,
  agingTable,
  BarChart,
  BulletChart,
  bulletTable,
  categoryTable,
  ChartCard,
  ComboChart,
  Donut,
  HeatGrid,
  heatTable,
  KpiTile,
  MonthlyCombo,
  pointTable,
  ScatterChart,
  shareTable,
  ShareBars,
  SparklineTable,
  sparkTableData,
  summarizeAging,
  summarizeBridge,
  summarizeCategories,
  summarizeRuleOf40,
  summarizeShares,
  summarizeTimeSeries,
  summarizeVariance,
  ThresholdGauge,
  timeSeriesFootnotes,
  timeSeriesTable,
  TimeSeriesChart,
  VarianceBars,
  varianceTable,
  WaterfallChart,
  bridgeTable,
  seriesLegend,
  type LegendItem,
} from '..';
import {
  SAMPLE_AGING,
  SAMPLE_AGING_BUCKETS,
  SAMPLE_BADGE,
  SAMPLE_BRIDGE,
  SAMPLE_CASH,
  SAMPLE_COMPANIES,
  SAMPLE_COMPANY_EBITDA,
  SAMPLE_COMPANY_GROWTH,
  SAMPLE_COMPANY_REVENUE,
  SAMPLE_CUSTOMERS,
  SAMPLE_DSO,
  SAMPLE_EBITDA,
  SAMPLE_MARGIN,
  SAMPLE_REVENUE,
  SAMPLE_VARIANCE,
} from './samples';

const Sample = () => <span className="tag tag--warn mc-gal-sample">{SAMPLE_BADGE}</span>;

const COMBO_LEGEND: LegendItem[] = [
  { key: 'actual', label: 'Actual', swatch: 'solid' },
  { key: 'priorYear', label: 'Same month a year earlier', swatch: 'dashed' },
  { key: 'budget', label: 'Approved budget', swatch: 'tick' },
  { key: 'ttm', label: 'Trailing twelve months', swatch: 'line' },
  { key: 'prelim', label: 'Preliminary (not closed)', swatch: 'prelim', toggle: false },
  { key: 'loss', label: 'Loss month', swatch: 'neg', toggle: false },
];

const GALLERY_COMPARISONS: readonly PeriodComparison[] = ['prior_period', 'prior_year', 'budget'];

export function ChartGallery() {
  const [density, setDensity] = useState<'report' | 'cockpit'>('report');
  // The shared period picker in both sizes (QA). Sample cards keep their own sample periods;
  // the picker's resolved window is printed beside it to prove the resolver end to end.
  const pp = usePeriodParam({ pageKey: 'chart-kit', defaultPreset: 'last_month', comparisons: GALLERY_COMPARISONS, defaultCompare: 'prior_year' });
  const [log, setLog] = useState<string[]>([]);
  const drill = (what: string) => setLog((l) => [`${new Date().toLocaleTimeString('en-US')} · onDrill(${what})`, ...l].slice(0, 6));

  const last = SAMPLE_REVENUE.actual.length - 1;
  const revSummary = summarizeTimeSeries({ metric: 'Revenue', unit: 'money', direction: 'higher_is_better', data: SAMPLE_REVENUE });
  const companies = SAMPLE_COMPANIES.map((c) => ({ key: c.key, label: c.label, sub: c.sub }));
  const margins = SAMPLE_COMPANY_EBITDA.map((e, i) => e / SAMPLE_COMPANY_REVENUE[i]);
  const scatter = companies.map((c, i) => ({ key: c.key, label: c.label, x: SAMPLE_COMPANY_GROWTH[i], y: margins[i], size: SAMPLE_COMPANY_REVENUE[i] }));
  const heatCols = useMemo(
    () => [
      { key: 'rev', label: 'Revenue', unit: 'money' as const, direction: 'higher_is_better' as const },
      { key: 'gr', label: 'Growth', unit: 'percent' as const, direction: 'higher_is_better' as const },
      { key: 'em', label: 'EBITDA margin', unit: 'percent' as const, direction: 'higher_is_better' as const },
      { key: 'dso', label: 'DSO', unit: 'days' as const, direction: 'lower_is_better' as const },
      { key: 'r40', label: 'Rule of 40', unit: 'count' as const, direction: 'higher_is_better' as const },
    ],
    [],
  );
  const heatRows = companies.map((c, i) => ({
    key: c.key,
    label: c.label,
    sub: c.sub,
    values: [SAMPLE_COMPANY_REVENUE[i], SAMPLE_COMPANY_GROWTH[i], margins[i], [38, 44, 52, 61, 47, 73, 35, 41][i], SAMPLE_COMPANY_GROWTH[i] === null ? null : Math.round(((SAMPLE_COMPANY_GROWTH[i] as number) + margins[i]) * 100)],
  }));
  const twelve = SAMPLE_REVENUE.periods.slice(12).map((p) => p.longLabel ?? p.label);

  return (
    <div className={`mc-gal density-${density}`}>
      <header className="mc-gal-head">
        <div>
          <p className="eyebrow">
            Internal <span className="sl">//</span> Chart kit
          </p>
          <h1 className="t-title">Chart kit gallery</h1>
          <p className="mc-gal-lede">
            Every chart in Books sits in one frame: title, basis, a plain-English sentence, definition, View as table, CSV / Excel / PNG / SVG, footnotes and drill. All
            figures on this page are <b>samples</b>, invented to exercise each encoding.
          </p>
        </div>
        <div className="mc-gal-ctl">
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 12, marginBottom: 12 }}>
          <PeriodPicker {...pp.pickerProps} label="Gallery period" placement="bottom-end" />
          <PeriodPicker {...pp.pickerProps} size="compact" label="Gallery period (compact)" placement="bottom-end" />
          <span className="t-cap ink-3 tnum" aria-live="polite">
            {pp.period.startDate} → {pp.period.endDate}
            {pp.period.comparison ? ` · ${pp.period.comparison.vsLabel} (${pp.period.comparison.startDate} → ${pp.period.comparison.endDate})` : ''}
          </span>
          </div>
          <div className="seg" role="group" aria-label="Density">
            <button type="button" aria-pressed={density === 'report'} onClick={() => setDensity('report')}>
              Report
            </button>
            <button type="button" aria-pressed={density === 'cockpit'} onClick={() => setDensity('cockpit')}>
              Cockpit
            </button>
          </div>
        </div>
      </header>

      <section className="mc-gal-log" aria-live="polite">
        <span className="eyebrow">Drill log</span>
        {log.length ? log.map((l, i) => <code key={i}>{l}</code>) : <span className="ink-3">Click or press Enter on any bar, point, row or tile.</span>}
      </section>

      <h2 className="mc-gal-h">
        <span className="tnum">01</span>
        <span className="sl">//</span>KPI tiles
      </h2>
      <div className="mc-gal-kpis">
        <KpiTile label="Revenue" value={SAMPLE_REVENUE.actual[last]} unit="money" direction="higher_is_better" period="Aug 2026" preliminary status="on_target" change={{ base: SAMPLE_REVENUE.priorYear?.[last] ?? 0, baseLabel: 'Aug 2025' }} target={SAMPLE_REVENUE.budget?.[last]} targetLabel="Budget" series={SAMPLE_REVENUE.actual.slice(12)} seriesLabels={twelve} seriesStatuses={SAMPLE_REVENUE.periods.slice(12).map((p) => p.status)} onDrill={() => drill('kpi:revenue')} />
        <KpiTile label="EBITDA margin" value={0.146} unit="percent" direction="higher_is_better" period="YTD Aug 2026" status="watch" change={{ base: 0.158, baseLabel: 'YTD 2025' }} target={0.16} series={[0.15, 0.149, 0.152, 0.141, 0.139, 0.144, 0.147, 0.143, 0.146, 0.148, 0.145, 0.146]} onDrill={() => drill('kpi:ebitda_margin')} />
        <KpiTile label="DSO" value={41} unit="days" direction="lower_is_better" period="Aug 2026" status="off_target" change={{ base: 39, baseLabel: 'Jul 2026' }} target={35} series={SAMPLE_DSO} onDrill={() => drill('kpi:dso')} />
        <KpiTile label="Revenue CAGR (3y)" value={null} unit="percent" direction="higher_is_better" period="TTM" unavailable="not_enough_history" unavailableDetail="Needs 48 closed months; 29 are on file." />
      </div>

      <h2 className="mc-gal-h">
        <span className="tnum">02</span>
        <span className="sl">//</span>Time series
      </h2>
      <div className="mc-gal-grid">
        <ChartCard
          primary
          className="mc-gal-wide"
          index={1}
          eyebrow="Revenue"
          title="Revenue by month"
          basis="By month, Sep ’24 – Aug ’26, with the same month a year earlier, the approved budget and the trailing twelve months"
          period="Sep ’24 – Aug ’26"
          value={{ value: SAMPLE_REVENUE.actual[last], unit: 'money', label: 'Aug 2026' }}
          change={{ current: SAMPLE_REVENUE.actual[last] ?? 0, base: SAMPLE_REVENUE.priorYear?.[last] ?? 0, unit: 'money', direction: 'higher_is_better', baseLabel: 'Aug 2025' }}
          definition={{ text: 'Revenue recognised in the period from posted invoices and revenue-recognition schedules, net of credits.', formula: 'Σ REVENUE-type accounts (credit − debit)', source: 'Posted GL · accrual basis', onEdit: () => drill('edit-definition:revenue') }}
          summary={revSummary}
          legend={COMBO_LEGEND.filter((l) => l.key !== 'loss')}
          table={timeSeriesTable(SAMPLE_REVENUE, { caption: 'Revenue by month', unit: 'money' })}
          closedThrough="Jul 2026"
          footnotes={[...timeSeriesFootnotes(SAMPLE_REVENUE), 'TTM is blank where its window includes the missing month']}
          drillHint="Click a month to open its revenue entries"
          onRowDrill={(k) => drill(`revenue:${k}`)}
          height={336}
          actions={<Sample />}
        >
          <MonthlyCombo data={SAMPLE_REVENUE} unit="money" direction="higher_is_better" onDrill={(k) => drill(`revenue:${k}`)} />
        </ChartCard>

        <ChartCard
          index={2}
          eyebrow="Profit"
          title="EBITDA by month"
          basis="By month, with the same month a year earlier and the approved budget"
          period="Sep ’24 – Aug ’26"
          summary={summarizeTimeSeries({ metric: 'EBITDA', unit: 'money', direction: 'higher_is_better', data: SAMPLE_EBITDA })}
          legend={COMBO_LEGEND.filter((l) => l.key !== 'ttm' && l.key !== 'prelim')}
          table={timeSeriesTable(SAMPLE_EBITDA, { caption: 'EBITDA by month', unit: 'money' })}
          footnotes={['Jan 2026 is a loss month (hatched below zero)']}
          actions={<Sample />}
        >
          <MonthlyCombo data={SAMPLE_EBITDA} unit="money" direction="higher_is_better" onDrill={(k) => drill(`ebitda:${k}`)} />
        </ChartCard>

        <ChartCard
          index={3}
          eyebrow="Margin"
          title="Gross margin"
          basis="By month, with the same month a year earlier (points, not percent)"
          period="Sep ’24 – Aug ’26"
          summary={summarizeTimeSeries({ metric: 'Gross margin', unit: 'percent', direction: 'higher_is_better', data: SAMPLE_MARGIN })}
          legend={[
            { key: 'actual', label: 'Gross margin', swatch: 'line' },
            { key: 'priorYear', label: 'A year earlier', swatch: 'dashed' },
          ]}
          table={timeSeriesTable(SAMPLE_MARGIN, { caption: 'Gross margin by month', unit: 'percent' })}
          footnotes={timeSeriesFootnotes(SAMPLE_MARGIN)}
          actions={<Sample />}
        >
          <TimeSeriesChart data={SAMPLE_MARGIN} unit="percent" direction="higher_is_better" onDrill={(k) => drill(`margin:${k}`)} />
        </ChartCard>

        <ChartCard
          index={4}
          eyebrow="Cash"
          title="Cash balance and forecast"
          basis="Month-end cash; Sep ’26 – Feb ’27 forecast with its range"
          period="Sep ’25 – Feb ’27"
          summary={summarizeTimeSeries({ metric: 'Cash', unit: 'money', direction: 'higher_is_better', data: { ...SAMPLE_CASH, actual: SAMPLE_CASH.actual.slice(0, 12), periods: SAMPLE_CASH.periods.slice(0, 12) } })}
          legend={[
            { key: 'actual', label: 'Cash', swatch: 'line' },
            { key: 'fc', label: 'Forecast', swatch: 'dotted', toggle: false },
            { key: 'band', label: 'Forecast range', swatch: 'band' },
          ]}
          table={timeSeriesTable(SAMPLE_CASH, { caption: 'Cash balance and forecast', unit: 'money', actualLabel: 'Cash' })}
          footnotes={timeSeriesFootnotes(SAMPLE_CASH)}
          actions={<Sample />}
        >
          <TimeSeriesChart data={SAMPLE_CASH} unit="money" direction="higher_is_better" variant="fan" onDrill={(k) => drill(`cash:${k}`)} />
        </ChartCard>

        <ChartCard
          index={5}
          eyebrow="Revenue and margin"
          title="Revenue with gross margin"
          basis="Revenue (bars, left axis) and gross margin (line, right axis) — two units, so two axes"
          period="Sep ’25 – Aug ’26"
          summary={summarizeTimeSeries({ metric: 'Gross margin', unit: 'percent', direction: 'higher_is_better', data: SAMPLE_MARGIN })}
          legend={[
            { key: 'rev', label: 'Revenue', swatch: 'solid-4' },
            { key: 'gm', label: 'Gross margin', swatch: 'solid-1' },
          ]}
          table={categoryTable(
            SAMPLE_REVENUE.periods.slice(12).map((p) => ({ key: p.key, label: p.longLabel ?? p.label })),
            [
              { key: 'rev', label: 'Revenue', values: SAMPLE_REVENUE.actual.slice(12) },
              { key: 'gm', label: 'Gross margin', values: SAMPLE_MARGIN.actual.slice(12) },
            ],
            { caption: 'Revenue with gross margin', unit: 'money', categoryLabel: 'Month', units: ['money', 'percent'] },
          )}
          actions={<Sample />}
        >
          <ComboChart
            periods={SAMPLE_REVENUE.periods.slice(12)}
            bars={{ key: 'rev', label: 'Revenue', values: SAMPLE_REVENUE.actual.slice(12), unit: 'money' }}
            line={{ key: 'gm', label: 'Gross margin', values: SAMPLE_MARGIN.actual.slice(12), unit: 'percent' }}
            onDrill={(k) => drill(`combo:${k}`)}
          />
        </ChartCard>
      </div>

      <h2 className="mc-gal-h">
        <span className="tnum">03</span>
        <span className="sl">//</span>Bridges and variance
      </h2>
      <div className="mc-gal-grid">
        <ChartCard
          className="mc-gal-wide"
          index={6}
          eyebrow="Bridge"
          title="EBITDA bridge, FY 2025 to FY 2026"
          basis="Fiscal year to date through Aug; each step from the GL by account role"
          period="FY 2026 YTD"
          summary={summarizeBridge('EBITDA', SAMPLE_BRIDGE)}
          legend={[
            { key: 'anchor', label: 'Total', swatch: 'anchor', toggle: false },
            { key: 'fav', label: 'Favourable', swatch: 'solid', toggle: false },
            { key: 'unf', label: 'Unfavourable', swatch: 'neg', toggle: false },
          ]}
          table={bridgeTable(SAMPLE_BRIDGE, { caption: 'EBITDA bridge', unit: 'money' })}
          drillHint="Click a step to see the accounts behind it"
          height={280}
          actions={<Sample />}
        >
          <WaterfallChart steps={SAMPLE_BRIDGE} onDrill={(k) => drill(`bridge:${k}`)} />
        </ChartCard>

        <ChartCard
          index={7}
          eyebrow="Plan"
          title="Actual vs budget, YTD"
          basis="Approved budget v3 · favourable to the right"
          period="YTD Aug 2026"
          summary={summarizeVariance('The plan', SAMPLE_VARIANCE)}
          legend={[
            { key: 'f', label: 'Favourable', swatch: 'solid', toggle: false },
            { key: 'u', label: 'Unfavourable', swatch: 'neg', toggle: false },
          ]}
          table={varianceTable(SAMPLE_VARIANCE, { caption: 'Actual vs budget', unit: 'money' })}
          footnotes={['Insurance has no approved budget line']}
          actions={<Sample />}
        >
          <VarianceBars rows={SAMPLE_VARIANCE} unit="money" onDrill={(k) => drill(`variance:${k}`)} />
        </ChartCard>

        <ChartCard
          index={8}
          eyebrow="Plan"
          title="Targets"
          basis="Actual against target, with the qualitative bands"
          period="YTD Aug 2026"
          summary="Revenue is behind target at 96.4%; gross margin and DSO are ahead."
          table={bulletTable(
            [
              { key: 'rev', label: 'Revenue', actual: 8_100_000_00, target: 8_400_000_00, unit: 'money', direction: 'higher_is_better' },
              { key: 'gm', label: 'Gross margin', actual: 0.324, target: 0.31, unit: 'percent', direction: 'higher_is_better' },
              { key: 'dso', label: 'DSO', actual: 41, target: 45, unit: 'days', direction: 'lower_is_better' },
            ],
            'Targets',
          )}
          exportFormats={['csv', 'xlsx']}
          actions={<Sample />}
        >
          <BulletChart
            items={[
              { key: 'rev', label: 'Revenue', sub: 'Budget v3', actual: 8_100_000_00, target: 8_400_000_00, budget: 8_250_000_00, bands: [6_800_000_00, 7_900_000_00], unit: 'money', direction: 'higher_is_better' },
              { key: 'gm', label: 'Gross margin', actual: 0.324, target: 0.31, bands: [0.26, 0.3], unit: 'percent', direction: 'higher_is_better' },
              { key: 'dso', label: 'DSO', actual: 41, target: 45, bands: [40, 50], unit: 'days', direction: 'lower_is_better' },
            ]}
            onDrill={(k) => drill(`target:${k}`)}
          />
        </ChartCard>
      </div>

      <h2 className="mc-gal-h">
        <span className="tnum">04</span>
        <span className="sl">//</span>Companies compared
      </h2>
      <div className="mc-gal-grid">
        <ChartCard
          index={9}
          eyebrow="Growth"
          title="Rule of 40"
          basis="Revenue growth (TTM vs prior TTM) plus EBITDA margin; square size is revenue"
          period="TTM Aug 2026"
          summary={summarizeRuleOf40(scatter)}
          legend={[
            { key: 'pass', label: 'Clears the line', swatch: 'solid', toggle: false },
            { key: 'fail', label: 'Below', swatch: 'outline', toggle: false },
          ]}
          table={pointTable(scatter, { caption: 'Rule of 40', xLabel: 'Growth', yLabel: 'EBITDA margin', xUnit: 'percent', yUnit: 'percent', sizeLabel: 'Revenue' })}
          footnotes={['Oakline Plumbing has under 24 months of history and is not plotted']}
          actions={<Sample />}
        >
          <ScatterChart points={scatter} xLabel="Revenue growth" yLabel="EBITDA margin" highlight="cd" onDrill={(k) => drill(`company:${k}`)} />
        </ChartCard>

        <ChartCard
          index={10}
          eyebrow="Scale"
          title="Revenue and EBITDA by company"
          basis="TTM through Aug 2026 · combined, not consolidated"
          period="TTM Aug 2026"
          summary={summarizeCategories('EBITDA', companies.map((c) => c.label), SAMPLE_COMPANY_EBITDA, 'money')}
          legend={[
            ...seriesLegend([
              { key: 'rev', label: 'Revenue' },
              { key: 'ebitda', label: 'EBITDA' },
            ]),
            { key: 'loss', label: 'Loss', swatch: 'neg', toggle: false },
          ]}
          table={categoryTable(companies, [
            { key: 'rev', label: 'Revenue', values: SAMPLE_COMPANY_REVENUE },
            { key: 'ebitda', label: 'EBITDA', values: SAMPLE_COMPANY_EBITDA },
          ], { caption: 'Revenue and EBITDA by company', unit: 'money', categoryLabel: 'Company' })}
          actions={<Sample />}
        >
          <BarChart
            orientation="horizontal"
            categories={companies}
            series={[
              { key: 'rev', label: 'Revenue', values: SAMPLE_COMPANY_REVENUE },
              { key: 'ebitda', label: 'EBITDA', values: SAMPLE_COMPANY_EBITDA },
            ]}
            unit="money"
            direction="higher_is_better"
            onDrill={(c, s) => drill(`company:${c}:${s}`)}
          />
        </ChartCard>

        <ChartCard
          className="mc-gal-wide"
          index={11}
          eyebrow="League"
          title="Companies × KPIs"
          basis="Each column ranked within itself; ↑ higher is better, ↓ lower is better"
          period="TTM Aug 2026"
          summary="Northwind Interiors ranks in the top fifth on revenue and margin; Meridian Homes is in the bottom fifth on four of five measures."
          table={heatTable(heatCols, heatRows, 'Companies × KPIs')}
          exportFormats={['csv', 'xlsx']}
          actions={<Sample />}
        >
          <HeatGrid columns={heatCols} rows={heatRows} caption="Companies by KPI" onDrill={(r, c) => drill(`heat:${r}:${c}`)} />
        </ChartCard>

        <ChartCard
          index={12}
          eyebrow="Concentration"
          title="Where the revenue comes from"
          basis="Top 8 customers, TTM; any customer over 10% is flagged"
          period="TTM Aug 2026"
          summary={summarizeShares('Revenue', SAMPLE_CUSTOMERS)}
          table={shareTable(SAMPLE_CUSTOMERS, { caption: 'Revenue by customer', unit: 'money', itemLabel: 'Customer' })}
          exportFormats={['csv', 'xlsx']}
          actions={<Sample />}
        >
          <ShareBars items={SAMPLE_CUSTOMERS} onDrill={(k) => drill(`customer:${k}`)} />
        </ChartCard>

        <ChartCard
          index={13}
          eyebrow="Mix"
          title="Share of EBITDA"
          basis="TTM; a loss-maker is excluded from the shares"
          period="TTM Aug 2026"
          summary={summarizeShares('EBITDA', companies.map((c, i) => ({ key: c.key, label: c.label, value: SAMPLE_COMPANY_EBITDA[i] })), { noun: 'companies', threshold: 0.25 })}
          table={shareTable(companies.map((c, i) => ({ key: c.key, label: c.label, value: SAMPLE_COMPANY_EBITDA[i] })), { caption: 'Share of EBITDA', unit: 'money', itemLabel: 'Company', topN: 5 })}
          actions={<Sample />}
        >
          <Donut items={companies.map((c, i) => ({ key: c.key, label: c.label, value: SAMPLE_COMPANY_EBITDA[i] }))} centerLabel="EBITDA, TTM" onDrill={(k) => drill(`company:${k}`)} />
        </ChartCard>
      </div>

      <h2 className="mc-gal-h">
        <span className="tnum">05</span>
        <span className="sl">//</span>Working capital and lenders
      </h2>
      <div className="mc-gal-grid">
        <ChartCard
          className="mc-gal-wide"
          index={14}
          eyebrow="Receivables"
          title="AR aging by customer"
          basis="Open invoices at Aug 31, 2026, by days past due · the top bar is the mix of all receivables"
          period="At Aug 31, 2026"
          summary={summarizeAging(SAMPLE_AGING_BUCKETS, SAMPLE_AGING)}
          legend={agingLegend(SAMPLE_AGING_BUCKETS)}
          table={agingTable(SAMPLE_AGING_BUCKETS, SAMPLE_AGING, 'AR aging by customer')}
          drillHint="Click a segment to open those invoices"
          actions={<Sample />}
        >
          <AgingBars buckets={SAMPLE_AGING_BUCKETS} rows={SAMPLE_AGING} onDrill={(r, b) => drill(`aging:${r}:${b}`)} />
        </ChartCard>

        <ChartCard
          index={15}
          eyebrow="Covenants"
          title="Covenant headroom"
          basis="Measured at the last closed quarter; projected to the next test date"
          period="Q2 2026 · next test Sep 30"
          summary="Leverage has 31.4% headroom; the fixed-charge cover is on watch and projected to breach at the next test."
          table={{
            caption: 'Covenant headroom',
            columns: [
              { key: 'c', label: 'Covenant' },
              { key: 'v', label: 'Measured', unit: 'multiple' },
              { key: 't', label: 'Threshold', unit: 'multiple' },
              { key: 'p', label: 'Projected', unit: 'multiple' },
            ],
            rows: [
              { key: 'lev', cells: ['Debt / EBITDA (max)', 2.4, 3.5, 2.7] },
              { key: 'fcc', cells: ['Fixed-charge cover (min)', 1.32, 1.25, 1.18] },
              { key: 'dscr', cells: ['DSCR (min)', 1.9, 1.2, 1.85] },
            ],
          }}
          exportFormats={['csv', 'xlsx']}
          actions={<Sample />}
        >
          <ThresholdGauge label="Debt / EBITDA" value={2.4} threshold={3.5} kind="max" unit="multiple" projected={2.7} period="Q2 2026" />
          <ThresholdGauge label="Fixed-charge cover" value={1.32} threshold={1.25} kind="min" unit="multiple" projected={1.18} period="Q2 2026" />
          <ThresholdGauge label="DSCR" value={1.9} threshold={1.2} kind="min" unit="multiple" projected={1.85} period="Q2 2026" />
        </ChartCard>

        <ChartCard
          index={16}
          eyebrow="Debt"
          title="Maturity ladder"
          basis="Principal due by year, by facility"
          period="At Aug 31, 2026"
          summary="$3.1M falls due in 2028, the largest year, mostly the term loan."
          legend={seriesLegend([
            { key: 'term', label: 'Term loan' },
            { key: 'equip', label: 'Equipment notes' },
            { key: 'loc', label: 'Line of credit' },
          ])}
          table={categoryTable(
            ['2026', '2027', '2028', '2029', '2030+'].map((y) => ({ key: y, label: y })),
            [
              { key: 'term', label: 'Term loan', values: [400_000_00, 800_000_00, 2_400_000_00, 600_000_00, 0] },
              { key: 'equip', label: 'Equipment notes', values: [180_000_00, 320_000_00, 260_000_00, 140_000_00, 90_000_00] },
              { key: 'loc', label: 'Line of credit', values: [0, 1_100_000_00, 450_000_00, 0, 0] },
            ],
            { caption: 'Maturity ladder', unit: 'money', categoryLabel: 'Year', total: true },
          )}
          actions={<Sample />}
        >
          <BarChart
            mode="stacked"
            categories={['2026', '2027', '2028', '2029', '2030+'].map((y) => ({ key: y, label: y }))}
            series={[
              { key: 'term', label: 'Term loan', values: [400_000_00, 800_000_00, 2_400_000_00, 600_000_00, 0] },
              { key: 'equip', label: 'Equipment notes', values: [180_000_00, 320_000_00, 260_000_00, 140_000_00, 90_000_00] },
              { key: 'loc', label: 'Line of credit', values: [0, 1_100_000_00, 450_000_00, 0, 0] },
            ]}
            unit="money"
            valueLabels
            onDrill={(c, s) => drill(`maturity:${c}:${s}`)}
          />
        </ChartCard>
      </div>

      <h2 className="mc-gal-h">
        <span className="tnum">06</span>
        <span className="sl">//</span>Table with sparklines
      </h2>
      <ChartCard
        eyebrow="Scorecard"
        title="Key measures, last 12 months"
        basis="Monthly, Sep ’25 – Aug ’26; change against the same month a year earlier"
        period="Aug 2026"
        summary="Revenue and gross margin improved on a year earlier; DSO eroded by two days."
        table={sparkTableData(
          [
            { key: 'rev', label: 'Revenue', unit: 'money', direction: 'higher_is_better', series: SAMPLE_REVENUE.actual.slice(12), base: SAMPLE_REVENUE.priorYear?.[last] },
            { key: 'gm', label: 'Gross margin', unit: 'percent', direction: 'higher_is_better', series: SAMPLE_MARGIN.actual.slice(12), base: SAMPLE_MARGIN.priorYear?.[last] },
            { key: 'dso', label: 'DSO', unit: 'days', direction: 'lower_is_better', series: SAMPLE_DSO, base: 39 },
          ],
          { caption: 'Key measures', periodLabels: twelve, baseLabel: 'A year earlier' },
        )}
        exportFormats={['csv', 'xlsx']}
        actions={<Sample />}
      >
        <SparklineTable
          caption="Key measures, last 12 months"
          periodLabels={twelve}
          baseLabel="Aug 2025"
          onDrill={(k) => drill(`measure:${k}`)}
          rows={[
            { key: 'rev', label: 'Revenue', sub: 'All companies, combined', unit: 'money', direction: 'higher_is_better', series: SAMPLE_REVENUE.actual.slice(12), statuses: SAMPLE_REVENUE.periods.slice(12).map((p) => p.status), base: SAMPLE_REVENUE.priorYear?.[last] },
            { key: 'gm', label: 'Gross margin', unit: 'percent', direction: 'higher_is_better', series: SAMPLE_MARGIN.actual.slice(12), base: SAMPLE_MARGIN.priorYear?.[last] },
            { key: 'ebitda', label: 'EBITDA', unit: 'money', direction: 'higher_is_better', series: SAMPLE_EBITDA.actual.slice(12), base: SAMPLE_EBITDA.priorYear?.[last] },
            { key: 'dso', label: 'DSO', unit: 'days', direction: 'lower_is_better', series: SAMPLE_DSO, base: 39 },
            { key: 'cash', label: 'Cash', unit: 'money', direction: 'higher_is_better', series: SAMPLE_CASH.actual.slice(0, 12), base: 2_310_000_00 },
          ]}
        />
      </ChartCard>

      <h2 className="mc-gal-h">
        <span className="tnum">07</span>
        <span className="sl">//</span>States
      </h2>
      <div className="mc-gal-grid mc-gal-grid--4">
        <ChartCard title="Loading" summary="Loading revenue by month." table={timeSeriesTable(SAMPLE_REVENUE, { caption: 'x', unit: 'money' })} state={{ kind: 'loading' }} height={180} actions={<Sample />}>
          <span />
        </ChartCard>
        <ChartCard
          title="Empty"
          summary="No invoices are open for this scope."
          table={{ caption: 'x', columns: [], rows: [] }}
          state={{ kind: 'empty', title: 'Nothing is outstanding', body: 'Every invoice for Northwind Interiors is paid. New invoices appear here when they are sent.', action: <button type="button" className="btn">Create an invoice</button> }}
          height={180}
          actions={<Sample />}
        >
          <span />
        </ChartCard>
        <ChartCard
          title="Cannot compute"
          summary="Revenue CAGR needs 48 closed months; 29 are on file."
          table={{ caption: 'x', columns: [], rows: [] }}
          state={{ kind: 'unavailable', reason: 'not_enough_history', detail: 'Revenue CAGR (3 years) compares TTM to TTM three years earlier. It needs 48 closed months; 29 are on file.' }}
          height={180}
          actions={<Sample />}
        >
          <span />
        </ChartCard>
        <ChartCard title="Error" summary="The chart could not load." table={{ caption: 'x', columns: [], rows: [] }} state={{ kind: 'error', onRetry: () => drill('retry') }} height={180} actions={<Sample />}>
          <span />
        </ChartCard>
      </div>
    </div>
  );
}
