/**
 * Merit Books chart kit (Slice 3C) — the ChartCard frame and every chart type.
 * Built here so Books can ship now; promotion to packages/merit-ui is described
 * in docs/chart-kit-proposal.md.
 *
 *   import { ChartCard, MonthlyCombo, timeSeriesTable, summarizeTimeSeries } from '@/components/charts';
 */
import './charts.css';

// frame
export { ChartCard, type ChartCardProps, type ChartCardDefinition, type ExportFormat } from './chart-card';
export { ChartStateView, UNAVAILABLE_COPY, type ChartState } from './chart-state';
export { ChartTableView, type ChartTableViewProps } from './chart-table';
export { ChangeChip, type ChangeChipProps } from './change-chip';
export { Legend, type LegendItem, type LegendProps } from './legend';

// charts
export { TimeSeriesChart, type TimeSeriesChartProps } from './time-series-chart';
export { MonthlyCombo, type MonthlyComboProps } from './monthly-combo';
export { BarChart, seriesLegend, type BarChartProps } from './bar-chart';
export { VarianceBars, varianceTable, computeVariances, type VarianceBarsProps, type VarianceRow } from './variance-bars';
export { WaterfallChart, type WaterfallChartProps } from './waterfall-chart';
export { ComboChart, type ComboChartProps, type ComboSeries } from './combo-chart';
export { Sparkline, type SparklineProps } from './sparkline';
export { ShareBars, Donut, type ShareBarsProps, type DonutProps, type ShareInput } from './share-bars';
export { HeatGrid, heatTable, heatBand, type HeatGridProps, type HeatColumn, type HeatRow } from './heat-grid';
export { ScatterChart, type ScatterChartProps, type ScatterPoint } from './scatter-chart';
export { BulletChart, bulletTable, type BulletChartProps, type BulletItem } from './bullet-chart';
export { ThresholdGauge, covenantState, type ThresholdGaugeProps, type CovenantState } from './threshold-gauge';
export { AgingBars, agingTable, agingLegend, bucketClass, type AgingBarsProps, type AgingBucket, type AgingRow } from './aging-bars';
export { SparklineTable, SparkRow, sparkTableData, type SparklineTableProps, type SparkTableRow } from './sparkline-table';
export { KpiTile, type KpiTileProps, type KpiStatus } from './kpi-tile';

// data contract + pure helpers
export * from './core/types';
export { niceTicks, niceStep, ticksForUnit, linearScale, bandScale, pointScale, extent, labelEvery, type Ticks } from './core/scale';
export { formatValue, axisLabels, formatDelta, compare, changePhrase, fuLabel, type Change, type ChangeTone } from './core/format';
export { segments, gapIndexes, lastIndex, trailingSum, computeBridge, largestStep, stack, variance, shares, percentileRanks, type BridgeStep, type BridgeBar, type Bridge } from './core/series';
export { timeSeriesTable, categoryTable, bridgeTable, shareTable, pointTable, chartTableToCsv, cellText, type ChartTable, type ChartTableColumn, type ChartTableRow } from './core/table';
export { chartTableToXlsx, XLSX_MIME } from './core/xlsx';
export {
  summarizeTimeSeries,
  summarizeBridge,
  summarizeShares,
  summarizeAging,
  summarizeVariance,
  summarizeThreshold,
  summarizeBullet,
  summarizeRuleOf40,
  summarizeCategories,
  describeSparkline,
  timeSeriesFootnotes,
} from './core/summary';
export { Swatch, type SwatchKind } from './core/parts';
