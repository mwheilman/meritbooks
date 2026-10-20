/**
 * The "Signals" home widget: a company's pack KPIs (pm.kpi_defs) read from pm.v_kpis, each one
 * with a comparison and somewhere to act on it. Pure (unit-tested).
 *
 * v_kpis keeps no history, so the comparison is what the view can honestly say: the basis
 * (sample and window), the other companies' readings in a workspace, or the job at the bad end
 * of the spread. A metric the pack names but the 1104–1107 views do not compute is left out.
 */
import { count } from '@meritbooks/merit-ui';
import { getMetric } from '@meritbooks/industry-packs/src/metrics';
import { VIEW_METRICS, basisLine, formatKpi, kpiAttention, kpiHref, unitOf } from './kpi';
import type { KpiDefRow, KpiRow } from './types';

export interface Signal {
  metric: string;
  label: string;
  value: string;
  /** At least one line; a number is never alone. */
  vs: string[];
  href: string;
  linkLabel: string;
  attention: boolean;
  /** Whether the views counted anything for it yet. */
  measured: boolean;
}

interface Reading {
  value: number | null;
  sample: number;
  /** The job at the bad end, when the reading is a roll-up of job rows. */
  worst: { jobId: string; value: number } | null;
  jobs: number;
}

/** Roll job rows up when the view emits no company row (draw-schedule metrics are per job). */
function rollUp(metric: string, rows: ReadonlyArray<KpiRow>, goodUp: boolean): Reading {
  const vals = rows.filter((r) => r.value != null) as Array<KpiRow & { value: number }>;
  const sample = rows.reduce((s, r) => s + r.sample_n, 0);
  if (!vals.length) return { value: null, sample, worst: null, jobs: rows.length };
  const worstRow = [...vals].sort((a, b) => (goodUp ? a.value - b.value : b.value - a.value))[0]!;
  const worst = worstRow.job_id ? { jobId: worstRow.job_id, value: worstRow.value } : null;
  const unit = unitOf(metric);
  let value: number;
  // A surplus on one loan does not cover a gap on another: only out-of-balance amounts add up.
  if (metric === 'in_balance_gap_cents') value = vals.reduce((s, r) => s + Math.max(r.value, 0), 0);
  else if (unit === 'cents' || unit === 'count') value = vals.reduce((s, r) => s + r.value, 0);
  else if (unit === 'ratio' || unit === 'months') value = worstRow.value;
  else {
    const w = vals.reduce((s, r) => s + Math.max(1, r.sample_n), 0);
    value = vals.reduce((s, r) => s + r.value * Math.max(1, r.sample_n), 0) / w;
  }
  return { value, sample, worst, jobs: vals.length };
}

function readingFor(metric: string, companyId: string, kpis: ReadonlyArray<KpiRow>, goodUp: boolean): Reading | null {
  const mine = kpis.filter((k) => k.metric === metric && k.location_id === companyId);
  if (!mine.length) return null;
  const company = mine.find((k) => k.job_id == null);
  const jobRows = mine.filter((k) => k.job_id != null);
  if (company) {
    const spread = jobRows.length >= 2 ? rollUp(metric, jobRows, goodUp) : null;
    return { value: company.value, sample: company.sample_n, worst: spread?.worst ?? null, jobs: jobRows.length };
  }
  return rollUp(metric, jobRows, goodUp);
}

export interface SignalInput {
  defs: ReadonlyArray<KpiDefRow>;
  kpis: ReadonlyArray<KpiRow>;
  companyIds: ReadonlyArray<string>;
  companyNames: Readonly<Record<string, string>>;
  jobLabels: Readonly<Record<string, string>>;
}

/** One signal per metric the companies' packs name and the views compute; attention first. */
export function buildSignals(p: SignalInput): Signal[] {
  const multi = p.companyIds.length > 1;
  const byMetric = new Map<string, KpiDefRow>();
  for (const d of [...p.defs].sort((a, b) => a.sort - b.sort)) {
    if (!VIEW_METRICS.has(d.metric) || !p.companyIds.includes(d.location_id)) continue;
    if (!byMetric.has(d.metric)) byMetric.set(d.metric, d);
  }
  const out: Array<Signal & { order: number }> = [];
  let order = 0;
  for (const [metric, def] of byMetric) {
    const goodUp = (getMetric(metric)?.goodDirection ?? def.good_direction) === 'up';
    const companies = p.companyIds.filter((c) => p.defs.some((d) => d.location_id === c && d.metric === metric));
    const readings = companies.map((c) => ({ c, r: readingFor(metric, c, p.kpis, goodUp) }));
    const measured = readings.filter((x): x is { c: string; r: Reading } => !!x.r && x.r.value != null);
    const { href, label: linkLabel } = kpiHref(metric);
    let value: string;
    const vs: string[] = [];
    let attention = false;
    if (!measured.length) {
      value = '—';
      const sample = readings.reduce((s, x) => s + (x.r?.sample ?? 0), 0);
      vs.push(sample ? basisLine(metric, sample) : 'Nothing counted yet; it fills in as the work closes out.');
    } else if (!multi || measured.length === 1) {
      const { c, r } = measured[0]!;
      value = formatKpi(metric, r.value);
      attention = kpiAttention(metric, r.value);
      vs.push(basisLine(metric, r.sample));
      if (multi) vs.push(p.companyNames[c] ?? 'One company');
      if (r.worst && r.jobs >= 2) vs.push(`${goodUp ? 'Lowest' : 'Highest'}: ${p.jobLabels[r.worst.jobId] ?? 'one job'} at ${formatKpi(metric, r.worst.value)}`);
      else if (!multi) vs.push(goodUp ? 'Higher is better' : 'Lower is better');
    } else {
      const sorted = [...measured].sort((a, b) => (goodUp ? a.r.value! - b.r.value! : b.r.value! - a.r.value!));
      const worst = sorted[0]!;
      value = formatKpi(metric, worst.r.value);
      attention = measured.some((x) => kpiAttention(metric, x.r.value));
      vs.push(`${p.companyNames[worst.c] ?? 'One company'}, the ${goodUp ? 'lowest' : 'highest'} of ${count(measured.length)}`);
      vs.push(sorted.slice(1, 4).map((x) => `${p.companyNames[x.c] ?? 'Company'} ${formatKpi(metric, x.r.value)}`).join(' · ') + (sorted.length > 4 ? ` · ${count(sorted.length - 4)} more` : ''));
    }
    out.push({ metric, label: def.label, value, vs, href, linkLabel, attention, measured: measured.length > 0, order: order++ });
  }
  return out
    .sort((a, b) => Number(b.attention) - Number(a.attention) || Number(b.measured) - Number(a.measured) || a.order - b.order)
    .map(({ order: _o, ...s }) => s);
}
