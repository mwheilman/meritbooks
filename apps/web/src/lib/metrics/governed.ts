/**
 * Number governance for metric datasets (FPB §18 — 3B metrics). SERVER ONLY (the async
 * wrapper reads facts); `withholdDataset` is PURE.
 *
 * A metric value is derived from balances and flows, so each company is cut off at its
 * latest month that is shown under the CUMULATIVE rule (every month through it released):
 * later GL flows, operational inputs and concentration data are DROPPED, months that are not
 * shown are dropped individually, and `latestMonth` is pulled back to the earliest cut-off so
 * the evaluator answers "not on file" for anything later — it never computes from a withheld
 * month. A company with nothing shown contributes nothing (opening balances zeroed, every
 * month dropped). Finance passes through.
 */

import { addMonths, compareMonths, monthRange, type MonthKey } from '@/lib/analytics/months';
import { governRouteMonths, type RouteGuardContext } from '@/lib/reports/governance/route-guard';
import type { DataSourceRequest } from './data-source';
import type { CompanyDataset, MetricDataset } from './types';

type MonthMap<T> = Partial<Record<MonthKey, T>>;

function keep<T>(months: MonthMap<T> | undefined, ok: (m: MonthKey) => boolean): MonthMap<T> {
  const out: MonthMap<T> = {};
  for (const [m, v] of Object.entries(months ?? {})) if (ok(m) && v !== undefined) out[m] = v as T;
  return out;
}

/**
 * Drop everything a non-finance reader may not see (PURE). `shown(month, companyId)` is the
 * cumulative-rule decision; `from` is the dataset's first requested month.
 */
export function withholdDataset(ds: MetricDataset, months: readonly MonthKey[], shown: (month: MonthKey, companyId: string) => boolean): MetricDataset {
  let latest = ds.latestMonth;
  const first = months[0] ?? ds.rangeStart;
  const companies: CompanyDataset[] = ds.companies.map((c) => {
    const visible = months.filter((m) => shown(m, c.id));
    const cutoff = visible.length ? visible[visible.length - 1] : null;
    const ok = (m: MonthKey) => cutoff !== null && compareMonths(m, cutoff) <= 0 && (!months.includes(m) || visible.includes(m));
    const nextLatest = cutoff ?? addMonths(first, -1);
    if (compareMonths(nextLatest, latest) < 0) latest = nextLatest;
    const gl: CompanyDataset['gl'] = {};
    for (const [k, s] of Object.entries(c.gl) as Array<[keyof CompanyDataset['gl'], NonNullable<CompanyDataset['gl'][keyof CompanyDataset['gl']]>]>) {
      gl[k] = { opening: cutoff === null ? 0 : s.opening, months: keep(s.months, ok) };
    }
    const operational: CompanyDataset['operational'] = {};
    for (const [k, v] of Object.entries(c.operational) as Array<[keyof CompanyDataset['operational'], MonthMap<number>]>) operational[k] = keep(v, ok);
    return {
      ...c,
      gl,
      operational,
      customerRevenue: c.customerRevenue ? keep(c.customerRevenue, ok) : undefined,
      vendorSpend: c.vendorSpend ? keep(c.vendorSpend, ok) : undefined,
    };
  });
  return { ...ds, latestMonth: latest, companies };
}

/** Govern a loaded dataset for the reader (no user → non-finance). */
export async function governDataset(ctx: RouteGuardContext, req: Pick<DataSourceRequest, 'companyIds' | 'from' | 'to'>, ds: MetricDataset): Promise<MetricDataset> {
  const months = compareMonths(req.from, req.to) <= 0 ? monthRange(req.from, req.to) : [];
  const g = await governRouteMonths(ctx, { months, locationIds: req.companyIds, cumulative: true });
  if (g.finance) return ds;
  return withholdDataset(ds, months, (m, id) => g.isShown(m, id));
}
