'use client';

import { useCallback, useMemo, useState } from 'react';
import { Button, Figure, InlineNotice, Select, toast, useQuery, type UseQueryResult } from '@meritbooks/merit-ui';
import {
  BarChart,
  ChartCard,
  TimeSeriesChart,
  WaterfallChart,
  bridgeTable,
  categoryTable,
  seriesLegend,
  summarizeBridge,
  summarizeTimeSeries,
  timeSeriesTable,
  type CategorySeries,
  type TimeSeriesData,
} from '@/components/charts';
import { CATEGORY_LABEL, INFLOW_CATEGORIES, OUTFLOW_CATEGORIES } from '@/lib/cash/forecast/types';
import { ACCURACY_GROUP_LABEL, groupOfCategory, type AccuracyGroup } from '@/lib/cash/forecast/accuracy';
import { dayLabel, downloadCsv, pctLabel, usd, weekdayLabel, type Category, type ForecastItem, type ForecastResponse, type ScopeForecast } from './cash-types';
import { ForecastDrill, type DrillSelection } from './forecast-drill';
import s from './cash.module.css';

const GROUPS: AccuracyGroup[] = ['COLLECTIONS', 'OTHER_RECEIPTS', 'VENDOR_PAYMENTS', 'PAYROLL', 'DEBT', 'OTHER_DISBURSEMENTS'];
const ALL_CATS: Category[] = [...INFLOW_CATEGORIES, ...OUTFLOW_CATEGORIES];

function weekLabel(i: number, start: string): string {
  return `Wk ${i + 1} · ${dayLabel(start)}`;
}

export function ForecastTab({ locationId, scenarioId, refreshKey, forecast: q }: { locationId: string | null; scenarioId: string; refreshKey: number; forecast: UseQueryResult<ForecastResponse> }) {
  const scope = locationId ?? 'all';
  const base = useQuery<ForecastResponse>('/api/cash/forecast', { location_id: scope, scenario_id: 'base' }, { key: `fcb:${refreshKey}`, scope: false, enabled: scenarioId !== 'base' });
  const [view, setView] = useState<string>('combined');
  const [drill, setDrill] = useState<DrillSelection | null>(null);
  const [selectedWeek, setSelectedWeek] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);

  const data = q.data;
  const sc: ScopeForecast | null = useMemo(() => {
    if (!data) return null;
    if (view === 'combined') return data.forecast.combined;
    return data.forecast.companies.find((c) => c.scopeId === view) ?? data.forecast.combined;
  }, [data, view]);
  const baseScope: ScopeForecast | null = useMemo(() => {
    if (!base.data || scenarioId === 'base') return null;
    return view === 'combined' ? base.data.forecast.combined : (base.data.forecast.companies.find((c) => c.scopeId === view) ?? null);
  }, [base.data, view, scenarioId]);

  const items: ForecastItem[] = useMemo(() => {
    if (!data || !sc) return [];
    const ex = new Set(data.forecast.combinedExcludedKeys);
    return data.forecast.items.filter((i) => (sc.scopeId === 'combined' ? !ex.has(i.key) : i.companyId === sc.scopeId));
  }, [data, sc]);
  const names = useMemo(() => new Map((data?.positions ?? []).map((p) => [p.id, p.name])), [data]);
  const companyName = useCallback((id: string | null) => (id ? (names.get(id) ?? '') : 'Organization'), [names]);

  const exportCsv = async (v: 'weeks' | 'items') => {
    setBusy(v);
    try {
      const qs = new URLSearchParams({ location_id: scope, scenario_id: scenarioId, view: v });
      await downloadCsv(`/api/cash/forecast/export?${qs.toString()}`, `cash-forecast-${v}.csv`);
    } catch (e) {
      toast.error(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  if (q.isLoading && !data) {
    return (
      <div className={s.state} role="status" style={{ marginTop: 16 }}>
        <p className="t-cap">Building the 13-week forecast from every bill, invoice, payroll, loan, lease, subscription and tax on file…</p>
      </div>
    );
  }
  if (q.error || !data || !sc) {
    return (
      <div className={s.state} role="alert" style={{ marginTop: 16 }}>
        <p className="t-head">Couldn’t build the forecast.</p>
        <p className="t-cap">{q.error ?? 'No data came back.'}</p>
        <Button onClick={() => void q.refetch()}>Try again</Button>
      </div>
    );
  }

  const f = data.forecast;
  const periods = sc.weeks.map((w) => ({ key: String(w.index), label: `Wk ${w.weekNumber}`, longLabel: `Week ${w.weekNumber} (${dayLabel(w.start)} – ${dayLabel(w.end)})`, status: 'forecast' as const }));
  const balance: TimeSeriesData = {
    periods,
    actual: sc.weeks.map((w) => w.closingCents),
    priorYear: baseScope ? baseScope.weeks.map((w) => w.closingCents) : undefined,
    budget: sc.minimumCents > 0 ? sc.weeks.map(() => sc.minimumCents) : undefined,
    band: { lo: sc.weeks.map((w) => w.loCents), hi: sc.weeks.map((w) => w.hiCents) },
  };
  const flowSeries: CategorySeries[] = GROUPS.map((g) => ({
    key: g,
    label: ACCURACY_GROUP_LABEL[g],
    values: sc.weeks.map((w) => {
      let v = 0;
      for (const [c, cents] of Object.entries(w.byCategory) as Array<[Category, number]>) {
        if (groupOfCategory(c) !== g) continue;
        v += (INFLOW_CATEGORIES as readonly string[]).includes(c) ? cents : -cents;
      }
      return v === 0 ? null : v;
    }),
  })).filter((x) => x.values.some((v) => v !== null));
  const flowCats = sc.weeks.map((w) => ({ key: String(w.index), label: `Wk ${w.weekNumber}`, sub: dayLabel(w.start) }));
  const bridgeSteps = (sc.scopeId === data.forecast.combined.scopeId ? data.bridge : bridgeOf(sc)).map((b) => ({ ...b }));
  const catsInScope = ALL_CATS.filter((c) => sc.weeks.some((w) => (w.byCategory[c] ?? 0) !== 0));
  const week = sc.weeks[selectedWeek] ?? sc.weeks[0];
  const weekDays = sc.days.filter((d) => d.date >= week.start && d.date <= week.end);
  const recs = data.recommendations.filter((r) => sc.scopeId === 'combined' || r.companyId === sc.scopeId);
  const topIn = [...items].filter((i) => i.direction === 'IN').sort((a, b) => b.amountCents - a.amountCents).slice(0, 10);
  const topOut = [...items].filter((i) => i.direction === 'OUT').sort((a, b) => b.amountCents - a.amountCents).slice(0, 10);
  const available = sc.scopeId === 'combined' ? data.liquidity.totalAvailableCents : (data.liquidity.availableByCompany[sc.scopeId] ?? 0);
  const atRisk = sc.scopeId === 'combined' ? data.atRisk.totalCents : (data.atRisk.byCompany[sc.scopeId] ?? 0);
  const openDrill = (sel: DrillSelection) => {
    if (!sel.allWeeks) setSelectedWeek(sel.weekIndex);
    setDrill(sel);
  };

  return (
    <div style={{ marginTop: 16 }}>
      <div className={s.toolbar}>
        {!locationId && f.companies.length > 1 && (
          <label className="row" style={{ gap: 8 }}>
            <span className="t-cap">View</span>
            <Select aria-label="Forecast view" value={view} onChange={(e) => setView(e.target.value)}>
              <option value="combined">All companies (combined)</option>
              {f.companies.map((c) => (
                <option key={c.scopeId} value={c.scopeId}>
                  {c.name}
                  {c.firstBreach ? ' — below minimum' : ''}
                </option>
              ))}
            </Select>
          </label>
        )}
        <span className="t-cap">
          {data.scenario.name}
          {data.scenario.adjustmentCount ? ` · ${data.scenario.adjustmentCount} lever${data.scenario.adjustmentCount === 1 ? '' : 's'}` : ''} · from {weekdayLabel(f.today)} to {dayLabel(f.horizonEnd)}
        </span>
        <span className={s.grow} />
        <Button variant="quiet" icon="file-text" disabled={busy !== null} onClick={() => void exportCsv('weeks')}>
          {busy === 'weeks' ? 'Exporting…' : 'Export weeks (CSV)'}
        </Button>
        <Button variant="quiet" icon="file-text" disabled={busy !== null} onClick={() => void exportCsv('items')}>
          {busy === 'items' ? 'Exporting…' : 'Export items (CSV)'}
        </Button>
      </div>

      {data.governance?.banner && <InlineNotice tone="warn" title={data.governance.banner.text} className={s.notes} />}

      <div className={s.figs}>
        <Figure dense label={data.positions[0]?.openingBasis === 'BANK_FEED' ? 'Cash today (bank feed)' : 'Cash today'} href="/cash?tab=position" linkLabel="Position" value={usd(sc.openingCents)} vs={[sc.minimumCents > 0 ? `Minimum ${usd(sc.minimumCents)}` : 'No minimum set']} />
        <Figure dense label="13 weeks in" href="/collections" linkLabel="Collections" value={usd(sc.totals.inflowsCents)} vs={[`${usd(atRisk)} of receivables at risk, not counted`]} />
        <Figure dense label="13 weeks out" href="/bills" linkLabel="Bills" value={usd(sc.totals.outflowsCents)} vs={[`Net ${usd(sc.totals.netCents)}`]} />
        <Figure dense label="Week 13 closing" href="/cash?tab=scenarios" linkLabel="Scenarios" value={usd(sc.closingCents)} vs={[baseScope ? `Base ${usd(baseScope.closingCents)} · ${usd(sc.closingCents - baseScope.closingCents)}` : `80% range ${usd(sc.weeks[sc.weeks.length - 1]?.loCents)} – ${usd(sc.weeks[sc.weeks.length - 1]?.hiCents)}`]} />
        <Figure dense label="Low point" href="/cash?tab=settings" linkLabel="Minimum cash" value={usd(sc.lowPoint.cents)} vs={[sc.firstBreach ? `Below minimum from week ${sc.firstBreach.weekIndex + 1}` : sc.lowPoint.weekIndex >= 0 ? `Week ${sc.lowPoint.weekIndex + 1}` : 'Today']} />
        <Figure dense label="Liquidity headroom" href="/cash?tab=settings" linkLabel="Credit lines" value={usd(sc.lowPoint.cents + available)} vs={[`Low point + ${usd(available)} available on lines`]} />
      </div>

      {(recs.length > 0 || data.notes.length > 0) && (
        <div className={s.notes}>
          {recs.map((r) => (
            <InlineNotice key={r.companyId} tone={r.uncoveredCents > 0 ? 'neg' : 'warn'} title={`${r.companyName}: ${usd(r.shortfallCents)} below minimum by week ${r.firstBreachWeek}`}>
              {r.summary} These are suggestions — nothing moves money.
            </InlineNotice>
          ))}
          {data.notes.map((n) => (
            <InlineNotice key={n} tone="info">
              {n}
            </InlineNotice>
          ))}
        </div>
      )}

      <div className={s.full}>
        <ChartCard
          primary
          index={1}
          eyebrow="Forecast"
          title="Weekly closing cash"
          basis={`Closing balance each week with its 80% range${sc.minimumCents > 0 ? ' and the minimum-cash line' : ''}${baseScope ? ', against the base forecast (dashed)' : ''}`}
          period={`${dayLabel(sc.weeks[0].start)} – ${dayLabel(sc.weeks[sc.weeks.length - 1].end)}`}
          value={{ value: sc.closingCents, unit: 'money', label: 'Week 13' }}
          change={{ current: sc.closingCents, base: sc.openingCents, unit: 'money', direction: 'higher_is_better', baseLabel: 'today' }}
          definition={{ text: 'Cash today plus every dated receipt and payment the books know about, week by week. Receipts are weighted by how likely and when each customer usually pays.', formula: 'Closing = opening + receipts − payments', source: 'Posted GL cash + open AR / AP + schedules' }}
          summary={summarizeTimeSeries({ metric: 'Closing cash', unit: 'money', direction: 'higher_is_better', data: balance })}
          legend={[
            { key: 'actual', label: data.scenario.id ? data.scenario.name : 'Forecast', swatch: 'dotted' },
            { key: 'band', label: '80% range', swatch: 'band' },
            ...(baseScope ? [{ key: 'priorYear', label: 'Base forecast', swatch: 'dashed' as const }] : []),
            ...(sc.minimumCents > 0 ? [{ key: 'budget', label: 'Minimum cash', swatch: 'tick' as const }] : []),
          ]}
          table={timeSeriesTable(balance, { caption: 'Weekly closing cash', unit: 'money', actualLabel: 'Closing' })}
          drillHint="Click a week to see its items"
          onRowDrill={(k) => openDrill({ weekIndex: Number(k) })}
          footnotes={[
            data.accuracy.mape !== null ? `Range widened by the recent forecast error (${pctLabel(data.accuracy.mape)}).` : 'Range from receipt probabilities and estimate uncertainty; it widens with measured error once four weeks are scored.',
            ...(f.beyondHorizon.count ? [`${f.beyondHorizon.count} item(s) fall after week 13 and are not shown.`] : []),
          ]}
          height={320}
        >
          <TimeSeriesChart data={balance} unit="money" direction="higher_is_better" variant="fan" labels={{ actual: 'Closing', priorYear: 'Base forecast', budget: 'Minimum cash' }} onDrill={(k) => openDrill({ weekIndex: Number(k) })} />
        </ChartCard>
      </div>

      <div className={s.grid2}>
        <ChartCard
          index={2}
          eyebrow="Flows"
          title="Cash in and out by week"
          basis="Receipts above the line, payments below, by kind"
          summary={`${usd(sc.totals.inflowsCents)} in and ${usd(sc.totals.outflowsCents)} out over 13 weeks.`}
          legend={seriesLegend(flowSeries)}
          table={categoryTable(flowCats, flowSeries, { caption: 'Cash in and out by week', unit: 'money', categoryLabel: 'Week', total: true })}
          onRowDrill={(k) => openDrill({ weekIndex: Number(k) })}
          drillHint="Click a bar to see its items"
          state={flowSeries.length === 0 ? { kind: 'empty', title: 'Nothing scheduled', body: 'No receipts or payments are on file for the next 13 weeks.' } : undefined}
          height={300}
        >
          <BarChart categories={flowCats} series={flowSeries} unit="money" mode="stacked" direction="higher_is_better" onDrill={(cat) => openDrill({ weekIndex: Number(cat) })} />
        </ChartCard>
        <ChartCard
          index={3}
          eyebrow="Bridge"
          title="From cash today to week 13"
          basis="Every category’s 13-week total, in order of size"
          summary={summarizeBridge('Cash', bridgeSteps)}
          table={bridgeTable(bridgeSteps, { caption: 'Cash bridge', unit: 'money' })}
          drillHint="Click a step to see its items across the 13 weeks"
          onRowDrill={(k) => (ALL_CATS as string[]).includes(k) && openDrill({ weekIndex: 0, category: k as Category, allWeeks: true })}
          height={300}
        >
          <WaterfallChart steps={bridgeSteps} unit="money" onDrill={(k) => (ALL_CATS as string[]).includes(k) && openDrill({ weekIndex: 0, category: k as Category, allWeeks: true })} />
        </ChartCard>
      </div>

      <h2 className={`t-section ${s.section}`}>01 // Week by week</h2>
      <div className={s.tableWrap}>
        <table className={`tbl ${s.grid}`}>
          <thead>
            <tr>
              <th className={s.sticky}>Category</th>
              {sc.weeks.map((w) => (
                <th key={w.index} className={`n ${s.cell} ${w.index === selectedWeek ? s.selected : ''} ${w.belowMinimum ? s.breach : ''}`}>
                  <button type="button" className={s.weekHead} onClick={() => setSelectedWeek(w.index)} aria-pressed={w.index === selectedWeek}>
                    {weekLabel(w.index, w.start)}
                  </button>
                </th>
              ))}
              <th className="n">13 weeks</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className={s.sticky}>Opening</td>
              {sc.weeks.map((w) => (
                <td key={w.index} className={`n tnum ${s.cell}`}>{usd(w.openingCents)}</td>
              ))}
              <td className="n tnum">{usd(sc.openingCents)}</td>
            </tr>
            {catsInScope.map((c) => {
              const isIn = (INFLOW_CATEGORIES as readonly string[]).includes(c);
              const total = sc.byCategory[c] ?? 0;
              return (
                <tr key={c}>
                  <td className={s.sticky}>
                    <span className="l1">{CATEGORY_LABEL[c]}</span>
                    <span className="l2">{isIn ? 'In' : 'Out'}</span>
                  </td>
                  {sc.weeks.map((w) => {
                    const v = w.byCategory[c] ?? 0;
                    return (
                      <td key={w.index} className={`n ${s.cell} ${w.index === selectedWeek ? s.selected : ''}`}>
                        {v ? (
                          <button type="button" className={s.cellBtn} onClick={() => openDrill({ weekIndex: w.index, category: c })} aria-label={`${CATEGORY_LABEL[c]}, week ${w.weekNumber}: ${usd(v)}`}>
                            {isIn ? '' : '('}
                            {usd(v)}
                            {isIn ? '' : ')'}
                          </button>
                        ) : (
                          <span className={s.muted}>—</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="n tnum">{isIn ? usd(total) : `(${usd(total)})`}</td>
                </tr>
              );
            })}
            <tr>
              <td className={s.sticky}>
                <strong>Net</strong>
              </td>
              {sc.weeks.map((w) => (
                <td key={w.index} className={`n tnum ${s.cell} ${w.netCents < 0 ? s.neg : ''}`}>{usd(w.netCents)}</td>
              ))}
              <td className="n tnum">{usd(sc.totals.netCents)}</td>
            </tr>
            <tr>
              <td className={s.sticky}>
                <strong>Closing</strong>
              </td>
              {sc.weeks.map((w) => (
                <td key={w.index} className={`n ${s.cell} ${w.belowMinimum ? s.breach : ''}`}>
                  <button type="button" className={s.cellBtn} onClick={() => openDrill({ weekIndex: w.index })} aria-label={`Week ${w.weekNumber} closing ${usd(w.closingCents)}`}>
                    <strong className={w.closingCents < 0 ? s.neg : ''}>{usd(w.closingCents)}</strong>
                  </button>
                </td>
              ))}
              <td className="n tnum">
                <strong>{usd(sc.closingCents)}</strong>
              </td>
            </tr>
            <tr>
              <td className={`${s.sticky} t-cap`}>80% range</td>
              {sc.weeks.map((w) => (
                <td key={w.index} className={`n tnum t-cap ${s.cell}`}>
                  {w.loCents === w.hiCents ? '—' : `${usd(w.loCents)} – ${usd(w.hiCents)}`}
                </td>
              ))}
              <td />
            </tr>
          </tbody>
        </table>
      </div>

      <h2 className={`t-section ${s.section}`}>02 // Week {week.weekNumber} by day</h2>
      <div className={s.days} role="group" aria-label={`Week ${week.weekNumber} by day`}>
        {Array.from({ length: 7 }, (_, i) => {
          const date = new Date(Date.parse(week.start) + i * 86_400_000).toISOString().slice(0, 10);
          const d = weekDays.find((x) => x.date === date);
          const past = !d;
          const net = d ? d.inflowsCents - d.outflowsCents : 0;
          return (
            <button
              key={date}
              type="button"
              className={`${s.day} ${past ? s.dayPast : ''} ${drill?.date === date ? s.dayOn : ''}`}
              disabled={past}
              onClick={() => openDrill({ weekIndex: week.index, date })}
              aria-label={past ? `${weekdayLabel(date)}: already happened` : `${weekdayLabel(date)}: net ${usd(net)}, closing ${usd(d?.closingCents)}`}
            >
              <span className="l2">{weekdayLabel(date)}</span>
              <span className="l1">{past ? 'Actual' : usd(d?.closingCents)}</span>
              <span className={`l2 ${net < 0 ? s.neg : ''}`}>{past ? '' : `${net >= 0 ? '+' : ''}${usd(net)} · ${d?.itemCount ?? 0} item${d?.itemCount === 1 ? '' : 's'}`}</span>
            </button>
          );
        })}
      </div>

      <div className={s.grid2}>
        <TopList title="03 // Top 10 receipts" items={topIn} companyName={companyName} onOpen={(it) => openDrill({ weekIndex: weekOf(sc, it.date) })} />
        <TopList title="04 // Top 10 disbursements" items={topOut} companyName={companyName} onOpen={(it) => openDrill({ weekIndex: weekOf(sc, it.date) })} />
      </div>

      <ForecastDrill scope={sc} items={items} selection={drill} onChange={openDrill} onClose={() => setDrill(null)} companyName={companyName} />
    </div>
  );
}

function weekOf(sc: ScopeForecast, date: string): number {
  const i = sc.weeks.findIndex((w) => date >= w.start && date <= w.end);
  return i < 0 ? 0 : i;
}

function bridgeOf(sc: ScopeForecast): Array<{ key: string; label: string; kind: 'start' | 'delta' | 'end'; value: number }> {
  const steps: Array<{ key: string; label: string; kind: 'start' | 'delta' | 'end'; value: number }> = [{ key: 'opening', label: 'Cash today', kind: 'start', value: sc.openingCents }];
  const deltas = (Object.entries(sc.byCategory) as Array<[Category, number]>)
    .map(([c, v]) => ({ c, v: (INFLOW_CATEGORIES as readonly string[]).includes(c) ? v : -v }))
    .filter((x) => x.v !== 0)
    .sort((a, b) => (a.v >= 0 && b.v < 0 ? -1 : a.v < 0 && b.v >= 0 ? 1 : Math.abs(b.v) - Math.abs(a.v)));
  for (const d of deltas) steps.push({ key: d.c, label: CATEGORY_LABEL[d.c], kind: 'delta', value: d.v });
  steps.push({ key: 'closing', label: `Week ${sc.weeks.length} closing`, kind: 'end', value: sc.closingCents });
  return steps;
}

function TopList({ title, items, companyName, onOpen }: { title: string; items: ForecastItem[]; companyName: (id: string | null) => string; onOpen: (it: ForecastItem) => void }) {
  return (
    <div>
      <h2 className={`t-section ${s.section}`}>{title}</h2>
      {items.length === 0 ? (
        <p className="t-cap">Nothing on file for the next 13 weeks.</p>
      ) : (
        <div className={s.tableWrap}>
          <table className="tbl">
            <tbody>
              {items.map((it) => (
                <tr key={it.key}>
                  <td>
                    <button type="button" className="link" onClick={() => onOpen(it)}>
                      {it.label}
                    </button>
                    <span className="l2">{[it.party, companyName(it.companyId), CATEGORY_LABEL[it.category]].filter(Boolean).join(' · ')}</span>
                  </td>
                  <td className="t-cap">{dayLabel(it.date)}</td>
                  <td className="n tnum">{usd(it.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
