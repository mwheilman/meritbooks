'use client';

import { Fragment, useState } from 'react';
import { Button, Figure, InlineNotice, Seg, toast, useMutation, useQuery } from '@meritbooks/merit-ui';
import { ChartCard, TimeSeriesChart, summarizeTimeSeries, type ChartTable, type TimeSeriesData } from '@/components/charts';
import { dayLabel, pctLabel, usd, type AccuracyResponse, type AccuracyGroup } from './cash-types';
import s from './cash.module.css';

/**
 * Forecast accuracy (B9, AC-CF7): each completed week's actual cash in / out (posted GL cash,
 * cash-to-cash transfers removed) against the snapshot taken at the start of that week (lead 1)
 * or four weeks before (lead 4); MAPE and the rolling accuracy trend that builds trust.
 */
export function AccuracyTab({ locationId, refreshKey, onChanged }: { locationId: string | null; refreshKey: number; onChanged: () => void }) {
  const [lead, setLead] = useState<'1' | '4'>('1');
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery<AccuracyResponse>('/api/cash/accuracy', { location_id: locationId ?? 'all', lead, weeks: '12' }, { key: `acc:${refreshKey}:${lead}`, scope: false });
  const snap = useMutation<{ location_id: string | null }, { written: number; skipped: number; anchorDate: string }>('/api/cash/snapshot', 'post');

  const takeNow = async () => {
    const r = await snap.mutate({ location_id: locationId });
    if (r) {
      toast(r.written ? `Saved ${r.written} snapshot${r.written === 1 ? '' : 's'} for the week of ${dayLabel(r.anchorDate)}.` : `This week (${dayLabel(r.anchorDate)}) is already snapshotted.`);
      onChanged();
    } else if (snap.error) toast.error(snap.error);
  };

  const d = q.data;
  const scored = d?.weeks.filter((w) => w.forecastInflows !== null) ?? [];
  const trend: TimeSeriesData | null = d && d.trend.length ? { periods: d.trend.map((t) => ({ key: t.start, label: dayLabel(t.start) })), actual: d.trend.map((t) => t.accuracy) } : null;
  const table: ChartTable | null = d
    ? {
        caption: 'Forecast vs actual by week',
        columns: [
          { key: 'w', label: 'Week of' },
          { key: 'fi', label: 'Forecast in', unit: 'money' },
          { key: 'ai', label: 'Actual in', unit: 'money' },
          { key: 'fo', label: 'Forecast out', unit: 'money' },
          { key: 'ao', label: 'Actual out', unit: 'money' },
          { key: 'acc', label: 'Rolling accuracy', unit: 'percent' },
        ],
        rows: d.weeks.map((w, i) => ({ key: w.start, cells: [w.start, w.forecastInflows, w.actualInflows, w.forecastOutflows, w.actualOutflows, d.trend[i]?.accuracy ?? null] })),
      }
    : null;

  return (
    <div style={{ marginTop: 16 }}>
      <div className={s.toolbar}>
        <Seg<'1' | '4'>
          aria-label="Forecast lead time"
          value={lead}
          onChange={setLead}
          items={[
            { value: '1', label: 'Forecast made that week' },
            { value: '4', label: 'Forecast made 4 weeks before' },
          ]}
        />
        <span className={s.grow} />
        <Button icon="history" disabled={snap.isLoading} onClick={() => void takeNow()}>
          {snap.isLoading ? 'Saving…' : 'Snapshot this week now'}
        </Button>
      </div>
      {d?.governance?.banner && <InlineNotice tone="warn" title={d.governance.banner.text} className={s.notes} />}

      {q.isLoading ? (
        <div className={s.state} role="status">
          <p className="t-cap">Comparing past forecasts with what actually happened…</p>
        </div>
      ) : q.error || !d ? (
        <div className={s.state} role="alert">
          <p className="t-head">Couldn’t score the forecast.</p>
          <p className="t-cap">{q.error}</p>
          <Button onClick={() => void q.refetch()}>Try again</Button>
        </div>
      ) : (
        <>
          <div className={s.figs}>
            <Figure dense label="Forecast accuracy" href="/cash?tab=forecast" linkLabel="Current forecast" value={pctLabel(d.accuracy)} vs={[scored.length ? `${scored.length} week${scored.length === 1 ? '' : 's'} scored` : 'No weeks scored yet']} />
            <Figure dense label="Receipts error (MAPE)" href="/collections" linkLabel="Collections" value={pctLabel(d.inflowMape, 1)} vs={['Mean absolute % miss on cash in']} />
            <Figure dense label="Payments error (MAPE)" href="/bills" linkLabel="Bills" value={pctLabel(d.outflowMape, 1)} vs={['Mean absolute % miss on cash out']} />
            <Figure dense label="Snapshots on file" href="/settings/automation" linkLabel="Scheduled jobs" value={String(d.snapshots.length)} vs={[d.snapshots.length ? `Latest ${dayLabel(d.snapshots[d.snapshots.length - 1].anchorDate)}` : 'Taken every Monday automatically']} />
          </div>
          {scored.length === 0 && (
            <InlineNotice tone="info" title="Accuracy builds week by week.">
              Every Monday the forecast is saved as it stands; once a week has passed, it is compared with the cash that actually moved. Take a snapshot now to start this week.
            </InlineNotice>
          )}

          <div className={s.full} style={{ marginTop: 16 }}>
            <ChartCard
              primary
              index={1}
              eyebrow="Trust"
              title="Forecast accuracy over time"
              basis="Rolling four-week accuracy: 1 − mean absolute % error on cash in and cash out"
              value={{ value: d.accuracy, unit: 'percent', label: 'Last 12 weeks' }}
              summary={trend ? summarizeTimeSeries({ metric: 'Forecast accuracy', unit: 'percent', direction: 'higher_is_better', data: trend }) : 'Forecast accuracy'}
              table={table ?? { caption: 'Accuracy', columns: [], rows: [] }}
              state={!trend || scored.length === 0 ? { kind: 'unavailable', reason: 'not_enough_history', detail: 'Needs at least one completed week with a snapshot.' } : undefined}
              height={260}
            >
              {trend && <TimeSeriesChart data={trend} unit="percent" direction="higher_is_better" />}
            </ChartCard>
          </div>

          <h2 className={`t-section ${s.section}`}>01 // Forecast vs actual by week</h2>
          <div className={s.tableWrap}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Week of</th>
                  <th className="n">Forecast in</th>
                  <th className="n">Actual in</th>
                  <th className="n">Accuracy</th>
                  <th className="n">Forecast out</th>
                  <th className="n">Actual out</th>
                  <th className="n">Accuracy</th>
                  <th className="n">Actual net</th>
                </tr>
              </thead>
              <tbody>
                {[...d.weeks].reverse().map((w) => (
                  <Fragment key={w.start}>
                    <tr>
                      <td>
                        <button type="button" className="link" aria-expanded={open === w.start} onClick={() => setOpen(open === w.start ? null : w.start)} disabled={w.forecastInflows === null}>
                          {dayLabel(w.start)}
                        </button>
                        {w.forecastInflows === null && <span className="l2">No snapshot</span>}
                      </td>
                      <td className="n tnum">{usd(w.forecastInflows)}</td>
                      <td className="n tnum">{usd(w.actualInflows)}</td>
                      <td className="n tnum">{pctLabel(w.inflowAccuracy)}</td>
                      <td className="n tnum">{usd(w.forecastOutflows)}</td>
                      <td className="n tnum">{usd(w.actualOutflows)}</td>
                      <td className="n tnum">{pctLabel(w.outflowAccuracy)}</td>
                      <td className={`n tnum ${w.actualNet < 0 ? s.neg : ''}`}>{usd(w.actualNet)}</td>
                    </tr>
                    {open === w.start &&
                      w.byGroup
                        .filter((g) => (g.forecast ?? 0) !== 0 || g.actual !== 0)
                        .map((g) => (
                          <tr key={`${w.start}:${g.group}`} className={s.selected}>
                            <td className="t-cap">{d.groups[g.group as AccuracyGroup]}</td>
                            <td colSpan={2} className="n tnum t-cap">
                              forecast {usd(g.forecast)} · actual {usd(g.actual)}
                            </td>
                            <td className="n tnum t-cap">{pctLabel(g.accuracy)}</td>
                            <td colSpan={4} />
                          </tr>
                        ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <p className="t-cap" style={{ marginTop: 8 }}>
            A week with no actual cash movement can&rsquo;t be scored as a percentage and is left out. Transfers between your own bank accounts are not counted as cash in or out.
          </p>
        </>
      )}
    </div>
  );
}
