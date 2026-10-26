'use client';

import { Fragment, useMemo, useState } from 'react';
import { Button, Figure, InlineNotice, Seg, Status, Tag, useQuery } from '@meritbooks/merit-ui';
import { ChartCard, TimeSeriesChart, summarizeTimeSeries, type ChartTable, type TimeSeriesData } from '@/components/charts';
import { ago, dayLabel, monthLabel, pctLabel, usd, type ForecastResponse, type HistoryResponse, type MetricsResponse } from './cash-types';
import s from './cash.module.css';

type Grain = 'day' | 'week' | 'month';

function statusOf(cash: number, min: number): { kind: 'ready' | 'track' | 'risk' | 'overdue'; word: string } {
  if (min <= 0) return { kind: 'track', word: 'No minimum set' };
  if (cash >= min * 2) return { kind: 'ready', word: 'Healthy' };
  if (cash >= min) return { kind: 'track', word: 'Above minimum' };
  if (cash >= min * 0.5) return { kind: 'risk', word: 'Below minimum' };
  return { kind: 'overdue', word: 'Critical' };
}

function runwayText(months: number | null, state: string): string {
  if (state === 'GENERATING') return 'Cash-generative';
  if (state === 'NOT_ENOUGH_HISTORY') return 'Not enough history';
  return months === null ? '—' : `${months.toFixed(1)} months`;
}

export function PositionTab({ locationId, refreshKey, forecast, onOpenForecast }: { locationId: string | null; refreshKey: number; forecast: ForecastResponse | null; onOpenForecast: () => void }) {
  const [grain, setGrain] = useState<Grain>('week');
  const [open, setOpen] = useState<string | null>(null);
  const scope = locationId ?? 'all';
  const metrics = useQuery<MetricsResponse>('/api/cash/metrics', { location_id: scope }, { key: `m:${refreshKey}`, scope: false });
  const history = useQuery<HistoryResponse>('/api/cash/history', { location_id: scope, grain }, { key: `h:${refreshKey}:${grain}`, scope: false });

  const positions = forecast?.positions ?? [];
  const totals = useMemo(() => {
    const book = positions.reduce((a, p) => a + p.bookCents, 0);
    const bankKnown = positions.filter((p) => p.bankCents !== null);
    const bank = bankKnown.length ? bankKnown.reduce((a, p) => a + (p.bankCents ?? 0), 0) : null;
    const stale = positions.reduce((a, p) => a + p.staleCount, 0);
    const last = positions.reduce<string | null>((m, p) => (p.lastFeedAt && (!m || p.lastFeedAt > m) ? p.lastFeedAt : m), null);
    return { book, bank, stale, last, accounts: positions.reduce((a, p) => a + p.accounts.length, 0) };
  }, [positions]);

  // History chart: book cash (line) with the bank-feed balance (dashed) at the same dates.
  const hist: TimeSeriesData | null = useMemo(() => {
    const pts = history.data?.points;
    if (!pts?.length) return null;
    return {
      periods: pts.map((p, i) => ({ key: p.date, label: grain === 'month' ? monthLabel(p.date.slice(0, 7)) : dayLabel(p.date), longLabel: p.date, status: i === pts.length - 1 ? 'preliminary' : 'closed' })),
      actual: pts.map((p) => p.bookCents),
      priorYear: pts.some((p) => p.bankCents !== null) ? pts.map((p) => p.bankCents) : undefined,
    };
  }, [history.data, grain]);
  const histTable: ChartTable | null = history.data
    ? {
        caption: 'Book cash vs bank-feed balance',
        columns: [
          { key: 'date', label: 'Date' },
          { key: 'book', label: 'Book cash', unit: 'money' },
          { key: 'bank', label: 'Bank feed', unit: 'money' },
          { key: 'diff', label: 'Difference (book − bank)', unit: 'money' },
        ],
        rows: history.data.points.map((p) => ({ key: p.date, cells: [p.date, p.bookCents, p.bankCents, p.diffCents] })),
        notes: ['Book cash = posted GL balance of the bank and cash-role accounts. The difference is outstanding checks, deposits in transit, unposted feed lines or a stale feed.'],
      }
    : null;

  const ccc = metrics.data?.ccc?.cash_conversion_cycle ?? null;
  const cccData: TimeSeriesData | null = ccc && ccc.points.length ? { periods: ccc.points.map((p) => ({ key: p.month, label: monthLabel(p.month), status: p.preliminary ? 'preliminary' : 'closed' })), actual: ccc.points.map((p) => p.value) } : null;
  const comp = metrics.data?.ccc;
  const cccTable: ChartTable | null = cccData && comp
    ? {
        caption: 'Cash conversion cycle (days)',
        columns: [{ key: 'm', label: 'Month' }, { key: 'dso', label: 'DSO', unit: 'days' }, { key: 'dio', label: 'DIO', unit: 'days' }, { key: 'dpo', label: 'DPO', unit: 'days' }, { key: 'ccc', label: 'CCC', unit: 'days' }],
        rows: ccc!.points.map((p, i) => ({ key: p.month, cells: [monthLabel(p.month), comp.dso?.points[i]?.value ?? null, comp.dio?.points[i]?.value ?? null, comp.dpo?.points[i]?.value ?? null, p.value] })),
      }
    : null;

  const rw = metrics.data?.runway;
  const recs = forecast?.recommendations ?? [];

  if (!forecast) {
    return (
      <div className={s.state} role="status" style={{ marginTop: 16 }}>
        <p className="t-cap">Loading the cash position…</p>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 16 }}>
      {forecast.governance?.banner && <InlineNotice tone="warn" title={forecast.governance.banner.text} className={s.notes} />}
      {positions.length === 0 ? (
        <div className={s.state}>
          <p className="t-head">No companies in your scope yet.</p>
          <p className="t-cap">Add a company in onboarding, or ask an administrator for access to one.</p>
        </div>
      ) : (
        <>
          <div className={s.figs}>
            <Figure dense label="Cash today (books)" href="/reports?report=balance-sheet" linkLabel="Balance sheet" value={usd(totals.book)} vs={[totals.bank === null ? 'No bank feed connected' : `Bank feed ${usd(totals.bank)} · difference ${usd(totals.book - totals.bank)}`]} />
            <Figure dense label="Liquidity" href="/cash?tab=settings" linkLabel="Credit lines" value={usd(rw ? rw.liquidityCents : null)} vs={[rw ? `Cash + ${usd(rw.availableLinesCents)} available on lines` : 'Loading…']} />
            <Figure dense label="Runway · trailing burn" href="/cash?tab=position" linkLabel="Cash history" value={rw ? runwayText(rw.trailingRunwayMonths, rw.trailingState) : '—'} vs={[rw?.trailingBurnCents !== null && rw?.trailingBurnCents !== undefined ? `Burn ${usd(rw.trailingBurnCents)} / month (last 3 months)` : 'Needs three closed months of cash']} />
            <Figure dense label="Runway · forecast burn" href="/cash?tab=forecast" linkLabel="13-week forecast" value={rw ? runwayText(rw.forecastRunwayMonths, rw.forecastState) : '—'} vs={[rw ? `13-week net ${usd(-rw.forecastBurnCents * 3)}${rw.zeroCashDate ? ` · zero cash ${dayLabel(rw.zeroCashDate)}` : ''}` : 'Loading…']} />
            <Figure dense label="13-week low point" href="/cash?tab=forecast" linkLabel="13-week forecast" value={usd(forecast.forecast.combined.lowPoint.cents)} vs={[forecast.forecast.combined.lowPoint.weekIndex >= 0 ? `Week ${forecast.forecast.combined.lowPoint.weekIndex + 1} (${dayLabel(forecast.forecast.combined.lowPoint.date)})` : 'Today is the low point']} />
            <Figure dense label="Bank feeds" href="/bank-feed" linkLabel="Bank feed" value={`${totals.accounts} account${totals.accounts === 1 ? '' : 's'}`} vs={[totals.stale ? `${totals.stale} not refreshed in 4+ days` : `Last refresh ${ago(totals.last)}`]} />
          </div>

          {recs.length > 0 && (
            <div className={s.recs} style={{ marginBottom: 16 }}>
              {recs.map((r) => (
                <InlineNotice key={r.companyId} tone={r.uncoveredCents > 0 ? 'neg' : 'warn'} title={`${r.companyName} goes below its minimum in week ${r.firstBreachWeek}`}>
                  {r.summary}{' '}
                  <Button variant="quiet" onClick={onOpenForecast}>
                    Open the forecast
                  </Button>
                </InlineNotice>
              ))}
            </div>
          )}

          <h2 className={`t-section ${s.section}`}>01 // By company and bank</h2>
          <div className={s.tableWrap}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Company</th>
                  <th className="n">Book cash</th>
                  <th className="n">Bank feed</th>
                  <th className="n">Difference</th>
                  <th className="n">Minimum</th>
                  <th>Status</th>
                  <th>Feed</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => {
                  const st = statusOf(p.bookCents, p.minimumCents);
                  const isOpen = open === p.id;
                  return (
                    <Fragment key={p.id}>
                      <tr>
                        <td>
                          <button type="button" className="link" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : p.id)}>
                            {p.name}
                          </button>
                          <span className="l2">{p.accounts.length} account{p.accounts.length === 1 ? '' : 's'}</span>
                        </td>
                        <td className="n tnum">{usd(p.bookCents)}</td>
                        <td className="n tnum">{usd(p.bankCents)}</td>
                        <td className={`n tnum ${p.unreconciledCents ? s.muted : ''}`}>{usd(p.unreconciledCents)}</td>
                        <td className="n tnum">{p.minimumCents > 0 ? usd(p.minimumCents) : '—'}</td>
                        <td>
                          <Status kind={st.kind}>{st.word}</Status>
                        </td>
                        <td>{p.accounts.length === 0 ? <span className="t-cap">No feed</span> : p.staleCount ? <Tag tone="warn">{p.staleCount} stale</Tag> : <span className="t-cap">{ago(p.lastFeedAt)}</span>}</td>
                      </tr>
                      {isOpen &&
                        p.accounts.map((a) => (
                          <tr key={a.id} className={s.selected}>
                            <td>
                              <span className="l1">{a.name}{a.mask ? ` ··${a.mask}` : ''}</span>
                              <span className="l2">{a.institution ?? ''} · {a.type.replace('_', ' ').toLowerCase()}</span>
                            </td>
                            <td className="n" />
                            <td className="n tnum">{usd(a.currentCents)}</td>
                            <td className="n tnum">{a.type === 'LINE_OF_CREDIT' || a.type === 'CREDIT_CARD' ? `avail. ${usd(a.availableCents)}` : ''}</td>
                            <td />
                            <td>{a.stale ? <Tag tone="warn">Stale</Tag> : <Tag tone="pos">Fresh</Tag>}</td>
                            <td className="t-cap">{ago(a.updatedAt)}</td>
                          </tr>
                        ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="t-cap" style={{ marginTop: 8 }}>
            Book cash is the posted balance of your bank and cash accounts; the bank feed is the bank&rsquo;s own figure. Credit cards and lines of credit are not cash.
          </p>
        </>
      )}

      <h2 className={`t-section ${s.section}`}>02 // History</h2>
      <div className={s.toolbar}>
        <Seg<Grain>
          aria-label="History grain"
          value={grain}
          onChange={setGrain}
          items={[
            { value: 'day', label: 'Daily · 90 days' },
            { value: 'week', label: 'Weekly · 26 weeks' },
            { value: 'month', label: 'Monthly · 13 months' },
          ]}
        />
      </div>
      <div className={s.grid2}>
        <ChartCard
          primary
          index={1}
          eyebrow="Cash"
          title="Cash balance — books vs bank"
          basis={`Posted book cash at each ${grain === 'day' ? 'day' : grain === 'week' ? 'week-end' : 'month-end'}, with the bank-feed balance at the same dates`}
          value={{ value: history.data?.summary.endCents ?? null, unit: 'money', label: 'Today' }}
          summary={hist ? summarizeTimeSeries({ metric: 'Book cash', unit: 'money', direction: 'higher_is_better', data: hist }) : 'Cash history'}
          legend={[
            { key: 'actual', label: 'Book cash', swatch: 'line' },
            { key: 'priorYear', label: 'Bank feed', swatch: 'dashed' },
          ]}
          table={histTable ?? { caption: 'Cash history', columns: [], rows: [] }}
          state={
            history.isLoading
              ? { kind: 'loading' }
              : history.error
                ? { kind: 'error', body: history.error, onRetry: () => void history.refetch() }
                : !hist
                  ? { kind: 'empty', title: 'No posted cash yet', body: 'Cash history appears once bank activity is posted to the ledger.' }
                  : undefined
          }
          footnotes={[
            ...(history.data?.withheld ? [`${history.data.withheld} point${history.data.withheld === 1 ? '' : 's'} withheld until those months are released.`] : []),
            ...(history.data?.summary.lastDiffCents ? [`Latest difference book − bank: ${usd(history.data.summary.lastDiffCents)}.`] : []),
          ]}
          height={280}
        >
          {hist && <TimeSeriesChart data={hist} unit="money" direction="higher_is_better" labels={{ actual: 'Book cash', priorYear: 'Bank feed' }} />}
        </ChartCard>

        <ChartCard
          index={2}
          eyebrow="Working capital"
          title="Cash conversion cycle"
          basis="DSO + DIO − DPO at each month-end (days); lower frees cash"
          value={{ value: ccc?.current ?? null, unit: 'days', label: 'Last month' }}
          summary={cccData ? summarizeTimeSeries({ metric: 'Cash conversion cycle', unit: 'days', direction: 'lower_is_better', data: cccData }) : 'Cash conversion cycle'}
          table={cccTable ?? { caption: 'Cash conversion cycle', columns: [], rows: [] }}
          state={
            metrics.isLoading
              ? { kind: 'loading' }
              : metrics.error
                ? { kind: 'error', body: metrics.error, onRetry: () => void metrics.refetch() }
                : !cccData
                  ? { kind: 'unavailable', reason: 'not_enough_history', detail: metrics.data?.cccError ?? ccc?.reason ?? undefined }
                  : undefined
          }
          footnotes={comp ? [`DSO ${comp.dso?.current?.toFixed(0) ?? '—'} · DIO ${comp.dio?.current?.toFixed(0) ?? '—'} · DPO ${comp.dpo?.current?.toFixed(0) ?? '—'} days`] : []}
          height={280}
        >
          {cccData && <TimeSeriesChart data={cccData} unit="days" direction="lower_is_better" />}
        </ChartCard>
      </div>
      {rw && rw.trailingState === 'BURNING' && rw.trailingRunwayMonths !== null && rw.trailingRunwayMonths < 6 && (
        <InlineNotice tone="warn" title={`About ${rw.trailingRunwayMonths.toFixed(1)} months of cash at the recent burn rate.`}>
          Liquidity including available lines is {usd(rw.liquidityCents)}. Accuracy of the forecast so far: {pctLabel(forecast.accuracy.accuracy)}.
        </InlineNotice>
      )}
    </div>
  );
}
