/**
 * Deterministic plain-English summaries — one or two sentences per chart that
 * double as its text alternative (FEATURE-GAP-AUDIT §4 principle 3). No AI: the
 * same data always produces the same sentence, so it can be tested and printed.
 * AI commentary layers on top later, with citations.
 *
 * Voice: Merit house style — figures first, no hedging, "improvement / erosion"
 * only where the metric has a direction, never "portfolio".
 */
import { pts } from '@meritbooks/merit-ui';
import { changePhrase, compare, formatValue } from './format';
import { computeBridge, largestStep, lastIndex, shares, type BridgeStep } from './series';
import { longLabel, periodStatus, type ChartUnit, type MetricDirection, type TimeSeriesData, type Value } from './types';

/** Lower-case for mid-sentence use, keeping acronyms (EBITDA, DSO, AR) intact. */
function lc(s: string): string {
  return s
    .split(' ')
    .map((w) => (/^[A-Z0-9&/]{2,}$/.test(w) ? w : w.toLowerCase()))
    .join(' ');
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function isNum(v: Value | undefined): v is number {
  return v !== null && v !== undefined && Number.isFinite(v);
}

export interface TimeSeriesSummaryInput {
  /** Metric name as a noun ("Revenue", "Gross margin", "DSO"). */
  metric: string;
  unit: ChartUnit;
  direction: MetricDirection;
  data: TimeSeriesData;
}

/**
 * "Revenue was $1.24M in Aug 2026, up 13.1% on Aug 2025 (an improvement). The
 * trailing twelve months total $13.4M." — or names the gap / the preliminary month.
 */
export function summarizeTimeSeries({ metric, unit, direction, data }: TimeSeriesSummaryInput): string {
  const i = lastIndex(data.actual);
  if (i < 0) return `${cap(metric)} has no figures for this period yet.`;
  const p = data.periods[i];
  const v = data.actual[i] as number;
  const st = periodStatus(p);
  const verb = st === 'forecast' ? 'is forecast at' : 'was';
  const prelim = st === 'preliminary' ? ' (preliminary — the month is not closed)' : '';
  const parts: string[] = [`${cap(metric)} ${verb} ${formatValue(v, unit, { compact: unit === 'money' })} in ${longLabel(p)}${prelim}`];
  const py = data.priorYear?.[i];
  if (isNum(py)) {
    const c = compare(v, py, direction, unit);
    const pyLabel = 'a year earlier';
    if (c.move === 'flat') parts[0] += `, flat on ${pyLabel}`;
    else if (unit !== 'percent' && c.rel === null)
      parts[0] += `, compared with ${formatValue(py, unit, { compact: true })} ${pyLabel}`;
    else parts[0] += `, ${changePhrase(c, unit)} on ${pyLabel}${c.tone === 'improvement' ? ' (an improvement)' : c.tone === 'erosion' ? ' (an erosion)' : ''}`;
  }
  let s = `${parts[0]}.`;
  const b = data.budget?.[i];
  if (isNum(b) && st !== 'forecast') {
    const c = compare(v, b, direction, unit);
    if (c.move !== 'flat' && c.favourable !== null) {
      const gap = unit === 'percent' ? pts(Math.abs(c.delta) * 100) : formatValue(Math.abs(c.delta), unit, { compact: true });
      s += ` That is ${gap} ${c.favourable ? 'better' : 'worse'} than budget.`;
    }
  }
  const t = data.ttm?.[i];
  if (isNum(t)) s += ` The trailing twelve months total ${formatValue(t, unit, { compact: true })}.`;
  if (i < data.actual.length - 1 && data.periods[data.actual.length - 1] && periodStatus(data.periods[data.actual.length - 1]) !== 'forecast') {
    s += ` ${longLabel(data.periods[data.actual.length - 1])} is not on file yet.`;
  }
  return s;
}

/** "EBITDA rose $420K from $1.8M (FY 2025) to $2.2M (FY 2026). The largest step is gross margin (+$610K)." */
export function summarizeBridge(metric: string, steps: ReadonlyArray<BridgeStep>, unit: ChartUnit = 'money'): string {
  const b = computeBridge(steps);
  const start = b.bars.find((x) => x.kind === 'start');
  const end = [...b.bars].reverse().find((x) => x.kind === 'end') ?? b.bars[b.bars.length - 1];
  if (!start || !end) return `${cap(metric)} bridge has no anchors.`;
  const delta = end.value - start.value;
  const verb = delta > 0 ? 'rose' : delta < 0 ? 'fell' : 'was unchanged';
  let s =
    delta === 0
      ? `${cap(metric)} was unchanged at ${formatValue(end.value, unit, { compact: true })} from ${start.label} to ${end.label}.`
      : `${cap(metric)} ${verb} ${formatValue(Math.abs(delta), unit, { compact: true })} from ${formatValue(start.value, unit, { compact: true })} (${start.label}) to ${formatValue(end.value, unit, { compact: true })} (${end.label}).`;
  const big = largestStep(b);
  if (big) s += ` The largest step is ${lc(big.label)} (${formatValue(big.value, unit, { compact: true, delta: true })}).`;
  if (!b.ties) s += ` The steps do not tie to the end figure by ${formatValue(Math.abs(b.difference), unit)}.`;
  return s;
}

/** "Acme Builders is 24.1% of revenue; 2 customers are over 10% each." */
export function summarizeShares(
  metric: string,
  items: ReadonlyArray<{ key: string; label: string; value: Value }>,
  opts: { unit?: ChartUnit; noun?: string; threshold?: number } = {},
): string {
  const { unit = 'money', noun = 'customers', threshold = 0.1 } = opts;
  const s = shares(items, 1000);
  const ranked = s.items.filter((i) => !i.loss);
  if (!ranked.length) return `No ${noun} contribute to ${lc(metric)} in this period.`;
  const top = ranked[0];
  const over = ranked.filter((i) => i.share > threshold).length;
  let out = `${top.label} is ${formatValue(top.share, 'percent')} of ${lc(metric)} (${formatValue(top.value, unit, { compact: true })})`;
  out += over > 1 ? `; ${over} ${noun} are over ${formatValue(threshold, 'percent', { decimals: 0 })} each.` : over === 1 ? `, the only one over ${formatValue(threshold, 'percent', { decimals: 0 })}.` : `; none is over ${formatValue(threshold, 'percent', { decimals: 0 })}.`;
  const losses = s.items.filter((i) => i.loss);
  if (losses.length) out += ` ${losses.length === 1 ? `${losses[0].label} made a loss` : `${losses.length} made a loss`} of ${formatValue(Math.abs(s.lossTotal), unit, { compact: true })}.`;
  return out;
}

/** "$842K is outstanding; $96K (11.4%) is over 90 days, most of it Acme Builders." */
export function summarizeAging(
  buckets: ReadonlyArray<{ key: string; label: string }>,
  rows: ReadonlyArray<{ key: string; label: string; values: Value[] }>,
  opts: { overdueFrom?: number; noun?: string } = {},
): string {
  const { overdueFrom = buckets.length - 1 } = opts;
  let total = 0;
  let late = 0;
  let worst: { label: string; v: number } | null = null;
  for (const r of rows) {
    let rowLate = 0;
    r.values.forEach((v, j) => {
      if (!isNum(v)) return;
      total += v;
      if (j >= overdueFrom) {
        late += v;
        rowLate += v;
      }
    });
    if (rowLate > 0 && (!worst || rowLate > worst.v)) worst = { label: r.label, v: rowLate };
  }
  if (total <= 0) return 'Nothing is outstanding.';
  const lateLabel = buckets[overdueFrom]?.label ?? 'the oldest bucket';
  let s = `${formatValue(total, 'money', { compact: true })} is outstanding`;
  if (late > 0) {
    s += `; ${formatValue(late, 'money', { compact: true })} (${formatValue(late / total, 'percent')}) is ${lc(lateLabel).startsWith('over') ? lc(lateLabel) : `in ${lc(lateLabel)}`}`;
    if (worst) s += `, most of it ${worst.label}`;
    s += '.';
  } else s += `; none is ${lc(lateLabel)}.`;
  return s;
}

/** "Opex is $84K worse than budget; the largest gap is payroll ($52K worse)." */
export function summarizeVariance(
  metric: string,
  rows: ReadonlyArray<{ label: string; actual: Value; plan: Value; direction: MetricDirection }>,
  unit: ChartUnit = 'money',
): string {
  let fav = 0;
  let unf = 0;
  let worst: { label: string; d: number } | null = null;
  let net = 0;
  for (const r of rows) {
    if (!isNum(r.actual) || !isNum(r.plan)) continue;
    const c = compare(r.actual, r.plan, r.direction, unit);
    if (c.favourable === true) fav += Math.abs(c.delta);
    if (c.favourable === false) {
      unf += Math.abs(c.delta);
      if (!worst || Math.abs(c.delta) > worst.d) worst = { label: r.label, d: Math.abs(c.delta) };
    }
    net += c.favourable === null ? 0 : c.favourable ? Math.abs(c.delta) : -Math.abs(c.delta);
  }
  if (fav === 0 && unf === 0) return `${cap(metric)} is on budget.`;
  let s = `${cap(metric)} is ${formatValue(Math.abs(net), unit, { compact: true })} ${net >= 0 ? 'better' : 'worse'} than budget overall`;
  s += worst ? `; the largest gap is ${lc(worst.label)} (${formatValue(worst.d, unit, { compact: true })} worse).` : '.';
  return s;
}

/** "Debt / EBITDA is 2.4x against a 3.5x maximum: 31.4% headroom." */
export function summarizeThreshold(
  metric: string,
  value: Value,
  threshold: number,
  kind: 'max' | 'min',
  unit: ChartUnit,
): string {
  if (!isNum(value)) return `${cap(metric)} cannot be measured for this period.`;
  const room = kind === 'max' ? (threshold - value) / Math.abs(threshold) : (value - threshold) / Math.abs(threshold);
  const vs = `${formatValue(value, unit)} against a ${formatValue(threshold, unit)} ${kind === 'max' ? 'maximum' : 'minimum'}`;
  if (room < 0) return `${cap(metric)} is ${vs}: in breach by ${formatValue(Math.abs(room), 'percent')}.`;
  return `${cap(metric)} is ${vs}: ${formatValue(room, 'percent')} headroom.`;
}

/** "Revenue is $8.1M, 96.2% of the $8.4M budget (behind)." */
export function summarizeBullet(metric: string, actual: Value, target: number, unit: ChartUnit, direction: MetricDirection): string {
  if (!isNum(actual)) return `${cap(metric)} has no figure for this period.`;
  const c = compare(actual, target, direction, unit);
  const att = target !== 0 ? actual / target : null;
  const word = c.favourable === null ? '' : c.favourable ? ' (ahead)' : ' (behind)';
  if (unit === 'percent') return `${cap(metric)} is ${formatValue(actual, unit)} against a ${formatValue(target, unit)} target, ${changePhrase(c, unit)}${word}.`;
  return `${cap(metric)} is ${formatValue(actual, unit, { compact: true })}${att !== null && att > 0 ? `, ${formatValue(att, 'percent')} of the ${formatValue(target, unit, { compact: true })} target` : ''}${word}.`;
}

/** "3 of 8 companies clear the Rule of 40; Heritage Interiors leads at 52." */
export function summarizeRuleOf40(points: ReadonlyArray<{ label: string; x: Value; y: Value }>, line = 0.4): string {
  const valid = points.filter((p): p is { label: string; x: number; y: number } => isNum(p.x) && isNum(p.y));
  if (!valid.length) return 'No company has enough history for the Rule of 40.';
  const scored = valid.map((p) => ({ ...p, s: p.x + p.y })).sort((a, b) => b.s - a.s);
  const clear = scored.filter((p) => p.s >= line).length;
  const lead = scored[0];
  const missing = points.length - valid.length;
  return `${clear} of ${valid.length} companies clear the Rule of ${Math.round(line * 100)}; ${lead.label} leads at ${Math.round(lead.s * 100)}.${missing ? ` ${missing} ${missing === 1 ? 'company has' : 'companies have'} too little history to score.` : ''}`;
}

/** Generic category chart: "Heritage Interiors is highest at $2.1M; Swan Creek lowest at $310K." */
export function summarizeCategories(metric: string, labels: ReadonlyArray<string>, values: ReadonlyArray<Value>, unit: ChartUnit): string {
  const pts = values.map((v, i) => ({ v, l: labels[i] })).filter((p): p is { v: number; l: string } => isNum(p.v));
  if (!pts.length) return `${cap(metric)} has no figures for this period.`;
  const hi = pts.reduce((a, b) => (b.v > a.v ? b : a));
  const lo = pts.reduce((a, b) => (b.v < a.v ? b : a));
  if (pts.length === 1) return `${cap(metric)}: ${hi.l} at ${formatValue(hi.v, unit, { compact: true })}.`;
  return `${hi.l} has the highest ${lc(metric)} at ${formatValue(hi.v, unit, { compact: true })}; ${lo.l} the lowest at ${formatValue(lo.v, unit, { compact: true })}.`;
}

/** Sparkline alt text: "Revenue, Sep 2025 – Aug 2026: from $1.0M to $1.2M; high $1.3M (Jul 2026)." */
export function describeSparkline(metric: string, values: ReadonlyArray<Value>, unit: ChartUnit, labels?: ReadonlyArray<string>): string {
  const pts = values.map((v, i) => ({ v, i })).filter((p): p is { v: number; i: number } => isNum(p.v));
  if (pts.length < 2) return `${cap(metric)}: not enough history for a trend.`;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const hi = pts.reduce((a, b) => (b.v > a.v ? b : a));
  const span = labels ? `, ${labels[first.i]} – ${labels[last.i]}` : '';
  const gaps = values.length - pts.length;
  return `${cap(metric)}${span}: from ${formatValue(first.v, unit, { compact: true })} to ${formatValue(last.v, unit, { compact: true })}; high ${formatValue(hi.v, unit, { compact: true })}${labels ? ` (${labels[hi.i]})` : ''}${gaps ? `; ${gaps} ${gaps === 1 ? 'period' : 'periods'} missing` : ''}.`;
}

/** Footnote lines for a time series: preliminary, forecast and missing months. */
export function timeSeriesFootnotes(data: TimeSeriesData): string[] {
  const prelim = data.periods.filter((p) => periodStatus(p) === 'preliminary').map(longLabel);
  const fc = data.periods.filter((p) => periodStatus(p) === 'forecast').map(longLabel);
  const gaps = data.periods.filter((p, i) => !isNum(data.actual[i]) && periodStatus(p) !== 'forecast').map(longLabel);
  const out: string[] = [];
  if (prelim.length) out.push(`${listJoin(prelim)} ${prelim.length === 1 ? 'is' : 'are'} preliminary (hatched)`);
  if (fc.length) out.push(`${listJoin(fc, 'range')} forecast (dotted)`);
  if (gaps.length) out.push(`${listJoin(gaps)} not on file (gap, not zero)`);
  return out;
}

function listJoin(items: string[], mode: 'list' | 'range' = 'list'): string {
  if (items.length <= 1) return items[0] ?? '';
  if (mode === 'range' || items.length > 3) return `${items[0]} – ${items[items.length - 1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
