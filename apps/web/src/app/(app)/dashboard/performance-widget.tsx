'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { Evidence, Widget, money, pct, pts } from '@meritbooks/merit-ui';
import { useQuery } from '@/hooks';
import { PeriodPicker, usePeriodParam } from '@/components/period';
import { monthShort, type PeriodComparison } from '@/lib/period/resolve';
import s from './performance-widget.module.css';

interface Figures {
  revenueCents: number;
  cogsCents: number;
  grossProfitCents: number;
  opexCents: number;
  operatingIncomeCents: number;
  otherCents: number;
  netIncomeCents: number;
  grossMarginPct: number | null;
  netMarginPct: number | null;
}

interface PerformanceResponse {
  data: {
    window: { start: string; end: string; months: number; basis: string };
    current: Figures;
    hasActivity: boolean;
    comparison: { kind: string; label: string; vsLabel: string; start: string; end: string; figures: Figures | null } | null;
    byMonth: Array<{ month: string; netIncomeCents: number; revenueCents: number }>;
  };
}

const COMPARISONS: readonly PeriodComparison[] = ['prior_period', 'prior_year', 'budget'];
const usd0 = (c: number) => money(Math.round(c), { symbol: '$', decimals: 0 });

function Change({ cur, base }: { cur: number; base: number }) {
  const d = cur - base;
  if (d === 0) return <span className="ink-3">flat</span>;
  const p = base === 0 ? null : d / Math.abs(base);
  return (
    <span className={d > 0 ? 'pos' : 'neg'}>
      {money(Math.round(d), { symbol: '$', decimals: 0, sign: 'delta' })}
      {p !== null && <span className="ink-3"> · {pct(p, { sign: 'delta' })}</span>}
    </span>
  );
}

/**
 * HOME · Performance — profit and loss for the period the user picks with the shared PeriodPicker
 * (this month, last month, YTD, TTM, last year, a quarter, any range), against prior period /
 * prior year / budget. The ledger sums to net income; every figure is posted GL
 * (/api/period/performance — same account-type math as the income statement). The choice is in
 * the URL and remembered for the home page.
 */
export function PerformanceWidget({ scopeLabel }: { scopeLabel: string }) {
  const pp = usePeriodParam({ pageKey: 'home', defaultPreset: 'ytd', comparisons: COMPARISONS, defaultCompare: 'prior_year' });
  const p = pp.period;
  const params = useMemo(
    () => ({
      period_end: p.end,
      basis: p.basis,
      ...(p.basis === 'range' ? { period_start: p.start } : {}),
      compare: p.compare,
    }),
    [p.end, p.basis, p.start, p.compare],
  );
  const { data, isLoading, error, refetch } = useQuery<PerformanceResponse>(pp.ready ? '/api/period/performance' : null, params);
  const d = data?.data;
  const cmp = d?.comparison ?? null;
  const reportHref = `/reports?start_date=${p.startDate}&end_date=${p.endDate}`;
  const maxAbs = useMemo(() => Math.max(1, ...(d?.byMonth ?? []).map((m) => Math.abs(m.netIncomeCents))), [d]);

  const state =
    !pp.ready || (isLoading && !d)
      ? ({ kind: 'loading', label: 'Adding up the period…', lines: 4 } as const)
      : error
        ? ({ kind: 'error', title: 'Performance didn’t load', body: error, onRetry: () => void refetch() } as const)
        : d && !d.hasActivity
          ? ({ kind: 'empty', title: `Nothing posted in ${p.label}`, body: 'Pick another period, or post activity to see revenue and profit here.' } as const)
          : undefined;

  return (
    <Widget
      title="Performance"
      meta={`${scopeLabel} · Posted GL · ${p.spanLabel}`}
      w={12}
      h={2}
      pad
      actions={<PeriodPicker {...pp.pickerProps} size="compact" label="Performance period" placement="bottom-end" />}
      state={state}
      foot={
        <Link className="btn btn--quiet" href={reportHref}>
          Income statement for {p.label}
        </Link>
      }
    >
      {d && (
        <div className={s.grid}>
          <div className={s.ledger}>
            <Evidence
              rows={[
                { label: 'Revenue', value: Math.round(d.current.revenueCents) },
                { label: 'Less cost of sales', value: -Math.round(d.current.cogsCents) },
                { label: 'Less operating expenses', value: -Math.round(d.current.opexCents) },
                { label: 'Less other expense, net', value: -Math.round(d.current.otherCents) },
              ]}
              total={{ label: `Net income · ${p.label}` }}
              format={{ decimals: 0 }}
            />
          </div>

          <table className={`tbl ${s.cmp}`} aria-label={`${p.label} ${cmp ? cmp.vsLabel : ''}`}>
            <thead>
              <tr>
                <th scope="col"><span className="sr">Measure</span></th>
                <th scope="col" className="n">{p.label}</th>
                {cmp && <th scope="col" className="n">{cmp.kind === 'budget' ? 'Budget' : cmp.label}</th>}
                {cmp && <th scope="col" className="n">Change</th>}
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ['Revenue', 'revenueCents'],
                  ['Gross profit', 'grossProfitCents'],
                  ['Operating income', 'operatingIncomeCents'],
                  ['Net income', 'netIncomeCents'],
                ] as const
              ).map(([label, key]) => (
                <tr key={key}>
                  <th scope="row">{label}</th>
                  <td className="n tnum">{usd0(d.current[key])}</td>
                  {cmp && <td className="n tnum">{cmp.figures ? usd0(cmp.figures[key]) : <span className="ink-3">—</span>}</td>}
                  {cmp && <td className="n tnum">{cmp.figures ? <Change cur={d.current[key]} base={cmp.figures[key]} /> : <span className="ink-3">{cmp.kind === 'budget' ? 'No budget' : '—'}</span>}</td>}
                </tr>
              ))}
              <tr>
                <th scope="row">Net margin</th>
                <td className="n tnum">{d.current.netMarginPct == null ? '—' : `${d.current.netMarginPct.toFixed(1)}%`}</td>
                {cmp && <td className="n tnum">{cmp.figures?.netMarginPct == null ? '—' : `${cmp.figures.netMarginPct.toFixed(1)}%`}</td>}
                {cmp && <td className="n tnum ink-3">{cmp.figures?.netMarginPct != null && d.current.netMarginPct != null ? pts(d.current.netMarginPct - cmp.figures.netMarginPct) : '—'}</td>}
              </tr>
            </tbody>
          </table>

          {d.byMonth.length > 1 && (
            <figure className={s.bars} aria-label={`Net income by month, ${p.spanLabel}`}>
              <figcaption className="t-cap ink-3">Net income by month</figcaption>
              <ol>
                {d.byMonth.map((m) => {
                  const h = Math.round((Math.abs(m.netIncomeCents) / maxAbs) * 100);
                  return (
                    <li key={m.month} title={`${m.month}: ${usd0(m.netIncomeCents)}`}>
                      <span className={`${s.bar} ${m.netIncomeCents < 0 ? s.barNeg : ''}`} style={{ height: `${Math.max(2, h)}%` }} />
                      <span className={s.barL}>{d.byMonth.length <= 12 ? monthShort(m.month) : ''}</span>
                      <span className="sr">{`${m.month} ${usd0(m.netIncomeCents)}`}</span>
                    </li>
                  );
                })}
              </ol>
            </figure>
          )}
        </div>
      )}
    </Widget>
  );
}
