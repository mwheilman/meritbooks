'use client';

import { useMemo, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { ButtonLink, ContextLine, Eyebrow, InlineNotice, Search, Seg, Tag, money, pct, useDebounce } from '@meritbooks/merit-ui';
import { PageHeader } from '@/components/ui';
import { useQuery } from '@/hooks';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import type { WipLineView, WipScheduleView } from '@/lib/rev-rec/wip-view';
import type { TieOutSide } from '@/lib/rev-rec/wip-engine';
import { METHOD_COPY } from '@/lib/rev-rec/policy';
import { wipColumnTotals } from '@/lib/rev-rec/wip-totals';
import { periodLabel } from '@/components/rev-rec/period-picker';
import { PeriodPicker, usePeriodParam } from '@/components/period';
import type { PeriodBasis } from '@/lib/period/resolve';
import { WipProposalPanel, WipRunHistory } from '@/components/rev-rec/wip-proposal-panel';

/**
 * WIP schedule (/jobs/wip) — FPB-rev-rec-wip §6. The contractor's work-in-progress schedule
 * for ONE company and month, tied to GL 1180 / 2410 (difference shown), with last month's
 * comparison, fade / gain, the month-end proposal (approve / dismiss), export, and drill to
 * each job. Every figure comes from /api/rev-rec/wip (the canonical engine).
 */

type Filter = 'all' | 'under' | 'over' | 'loss' | 'fade';
type SortKey = 'job' | 'under' | 'over' | 'fade' | 'pct';

const usd = (c: number) => money(c, { symbol: '$' });
/** The job column stays put while the money columns scroll horizontally (1G-8). */
const STICKY: CSSProperties = { position: 'sticky', left: 0, zIndex: 1, background: 'var(--white, #FDFCFA)', boxShadow: '1px 0 0 var(--line, #E3E1DC)' };
const usd0 = (c: number) => money(c, { symbol: '$', decimals: 0 });
/** Whole dollars in the table; nothing yet reads "—", never a bare 0 (Wave 2 live check). */
const amt = (c: number) => money(c, { decimals: 0, zeroAsDash: true });
/** The schedule is as of one month-end. */
const MONTH_ONLY: readonly PeriodBasis[] = ['month'];

function TieTile({ title, account, side }: { title: string; account: string | null; side: TieOutSide }) {
  const tied = side.differenceCents === 0;
  return (
    <div className="surface" style={{ padding: 16 }}>
      <Eyebrow>{[account ?? '—', title]}</Eyebrow>
      <div className="row row--between" style={{ marginTop: 8 }}>
        <span className="t-cap ink-2">Schedule</span>
        <span className="tnum b">{usd(side.scheduleCents)}</span>
      </div>
      <div className="row row--between">
        <span className="t-cap ink-2">General ledger (jobs)</span>
        <span className="tnum">{usd(side.glJobsCents)}</span>
      </div>
      <div className="row row--between hairline" style={{ marginTop: 6, paddingTop: 6 }}>
        <span className="t-cap ink-2">Difference</span>
        <span className={`tnum b ${tied ? 'pos' : 'neg'}`}>{tied ? 'Ties' : usd(side.differenceCents)}</span>
      </div>
      {side.glOtherCents !== 0 && (
        <p className="t-cap ink-3" style={{ marginTop: 6 }}>Plus {usd(side.glOtherCents)} on this account not tagged to a job (not part of WIP).</p>
      )}
    </div>
  );
}

function rowNote(l: WipLineView): string | null {
  if (l.excluded) return 'Excluded from WIP';
  if (l.belowMateriality) return 'Below threshold';
  if (l.underCents > 0 && !l.accrueUnderbillings) return 'Underbillings off';
  if (l.overCents > 0 && !l.deferOverbillings) return 'Overbillings off';
  return null;
}

export function WipScheduleClient() {
  const { activeCompanyId } = useActiveCompany();
  const pp = usePeriodParam({ pageKey: 'jobs.wip', defaultPreset: 'last_month', bases: MONTH_ONLY });
  const period = pp.selection.end;
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<SortKey>('job');
  const [q, setQ] = useState('');
  const dq = useDebounce(q, 200);
  const [refresh, setRefresh] = useState(0);

  const { data, isLoading, error, refetch } = useQuery<WipScheduleView>(
    pp.ready ? '/api/rev-rec/wip' : null,
    { location_id: activeCompanyId, period },
    { key: `${activeCompanyId}:${period}:${refresh}` },
  );

  const lines = useMemo(() => {
    let ls = data?.lines ?? [];
    if (filter === 'under') ls = ls.filter((l) => l.underCents > 0);
    if (filter === 'over') ls = ls.filter((l) => l.overCents > 0);
    if (filter === 'loss') ls = ls.filter((l) => l.lossProvisionCents > 0 || l.estGrossProfitCents < 0);
    if (filter === 'fade') ls = ls.filter((l) => (l.fadeGainCents ?? 0) < 0);
    const needle = dq.trim().toLowerCase();
    if (needle) ls = ls.filter((l) => `${l.jobNumber ?? ''} ${l.jobName ?? ''}`.toLowerCase().includes(needle));
    const by: Record<SortKey, (a: WipLineView, b: WipLineView) => number> = {
      job: (a, b) => (a.jobNumber ?? '').localeCompare(b.jobNumber ?? ''),
      under: (a, b) => b.underCents - a.underCents,
      over: (a, b) => b.overCents - a.overCents,
      fade: (a, b) => (a.fadeGainCents ?? 0) - (b.fadeGainCents ?? 0),
      pct: (a, b) => b.pctComplete - a.pctComplete,
    };
    return [...ls].sort(by[sort]);
  }, [data, filter, sort, dq]);

  const t = data?.totals;
  // Table totals: every money column, from the rows shown (1G-8).
  const ct = useMemo(() => wipColumnTotals(lines), [lines]);
  const filtered = !!data && lines.length !== data.lines.length;
  const prior = data?.priorRun ?? null;
  const exportHref = `/api/rev-rec/wip/export?location_id=${encodeURIComponent(activeCompanyId)}&period=${period}`;

  const sortHeader = (key: SortKey, label: string, numeric = true, style?: CSSProperties) => (
    <th className={numeric ? 'n' : undefined} aria-sort={sort === key ? 'descending' : 'none'} style={style}>
      <button type="button" className="mb-th-btn" onClick={() => setSort(key)}>{label}{sort === key ? ' ↓' : ''}</button>
    </th>
  );

  return (
    <div className="stack" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <PageHeader
        eyebrow={['Jobs', 'WIP schedule']}
        title="WIP schedule"
        description="Earned vs billed on every job, tied to your Unbilled AR (1180) and Deferred revenue (2410) accounts. Approve the month-end entry here."
        actions={
          <>
            <PeriodPicker {...pp.pickerProps} label="Month" />
            {/* A plain anchor: the CSV is a file download from an API route, not an app page. */}
            <a className="btn" href={exportHref} download>Export CSV</a>
            <ButtonLink href="/rev-rec?tab=policy" variant="quiet">Revenue policy</ButtonLink>
          </>
        }
      />

      {(isLoading || !pp.ready) && !data ? (
        <div className="surface wg-loading mb-state-block" aria-busy="true">
          <span className="bar-l" style={{ width: '70%' }} aria-hidden="true" />
          <span className="bar-l" style={{ width: '55%' }} aria-hidden="true" />
          <span className="bar-l" style={{ width: '62%' }} aria-hidden="true" />
          <span className="t-cap" role="status">Building the WIP schedule…</span>
        </div>
      ) : error || !data ? (
        <div className="surface wg-state mb-state-block" role="alert">
          <span className="tag tag--neg">Not loaded</span>
          <span className="t-head">The WIP schedule didn’t load</span>
          <span className="t-cap ink-2">{error ?? 'Unknown error'}</span>
          <button type="button" className="btn" onClick={() => void refetch()}>Try again</button>
        </div>
      ) : (
        <>
          <ContextLine
            items={[
              data.company?.name ?? 'Company',
              periodLabel(period),
              `as of ${data.asOf}`,
              { label: `${t!.jobs} job${t!.jobs === 1 ? '' : 's'}`, strong: true, tnum: true },
              { label: `net ${usd0(t!.underCents - t!.overCents)} ${t!.underCents >= t!.overCents ? 'underbilled' : 'overbilled'}`, tnum: true },
            ]}
          />

          {data.tieOut ? (
            <section aria-label="Tie-out to the general ledger" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
              <TieTile title="Unbilled receivable" account={data.accounts.unbilled} side={data.tieOut.unbilled} />
              <TieTile title="Deferred revenue" account={data.accounts.deferred} side={data.tieOut.deferred} />
              {data.policy.lossProvision && <TieTile title="Loss provision" account={data.accounts.lossProvision} side={data.tieOut.lossProvision} />}
              <div className="surface" style={{ padding: 16 }}>
                <Eyebrow>{['vs', prior ? periodLabel(prior.period_key) : 'last month']}</Eyebrow>
                {prior ? (
                  <>
                    <div className="row row--between" style={{ marginTop: 8 }}>
                      <span className="t-cap ink-2">Underbilled</span>
                      <span className="tnum">{usd0(t!.targetUnderCents)} <span className="ink-3">vs {usd0(Number(prior.underbilled_cents))}</span></span>
                    </div>
                    <div className="row row--between">
                      <span className="t-cap ink-2">Overbilled</span>
                      <span className="tnum">{usd0(t!.targetOverCents)} <span className="ink-3">vs {usd0(Number(prior.overbilled_cents))}</span></span>
                    </div>
                    <div className="row row--between hairline" style={{ marginTop: 6, paddingTop: 6 }}>
                      <span className="t-cap ink-2">Fade / gain ({t!.fadeJobs} fading)</span>
                      <span className={`tnum b ${t!.fadeGainCents < 0 ? 'neg' : 'pos'}`}>{money(t!.fadeGainCents, { symbol: '$', sign: 'delta', decimals: 0 })}</span>
                    </div>
                  </>
                ) : (
                  <p className="t-cap ink-3" style={{ marginTop: 8 }}>No run for the prior month yet — fade / gain starts after the first posted month.</p>
                )}
              </div>
            </section>
          ) : (
            <InlineNotice tone="warn" title="Tie-out unavailable">{data.setupIssues[0] ?? 'The contract-asset accounts are not set up.'}</InlineNotice>
          )}

          <WipProposalPanel view={data} onChanged={async () => { setRefresh((n) => n + 1); }} />

          <section aria-labelledby="wip-sched-h" className="stack">
            <div className="row row--between" style={{ flexWrap: 'wrap', gap: 12 }}>
              <h2 id="wip-sched-h" className="t-section">Schedule</h2>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <Seg<Filter>
                  aria-label="Show"
                  value={filter}
                  onChange={setFilter}
                  items={[
                    { value: 'all', label: 'All', count: data.lines.length },
                    { value: 'under', label: 'Underbilled', count: t!.underbilledJobs },
                    { value: 'over', label: 'Overbilled', count: t!.overbilledJobs },
                    { value: 'loss', label: 'Losses', count: t!.lossJobs },
                    { value: 'fade', label: 'Fading', count: t!.fadeJobs },
                  ]}
                />
                <Search value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a job" aria-label="Find a job" style={{ width: 200 }} />
              </div>
            </div>

            {data.lines.length === 0 ? (
              <div className="surface wg-state mb-state-block">
                <span className="t-head">No jobs on the WIP schedule</span>
                <span className="t-cap ink-2">Active, on-hold and completed jobs for this company appear here. <Link className="link" href="/jobs">Go to jobs</Link></span>
              </div>
            ) : lines.length === 0 ? (
              <div className="surface wg-state mb-state-block"><span className="t-head">No jobs match this filter</span></div>
            ) : (
              <div className="surface mb-scroll-x">
                <table className="tbl tbl-q" aria-label={`WIP schedule ${periodLabel(period)}`} style={{ minWidth: 1320 }}>
                  <thead>
                    <tr>
                      {sortHeader('job', 'Job', false, { ...STICKY, zIndex: 2 })}
                      <th className="n">Contract</th>
                      <th className="n">EAC</th>
                      <th className="n">Cost to date</th>
                      {sortHeader('pct', '% done')}
                      <th className="n">Earned</th>
                      <th className="n">Billed</th>
                      {data.policy.retainagePresentation === 'SEPARATE' && <th className="n">Retainage</th>}
                      {sortHeader('under', 'Underbilled')}
                      {sortHeader('over', 'Overbilled')}
                      <th className="n">Loss prov.</th>
                      <th className="n">Est. GP</th>
                      {sortHeader('fade', 'Fade / gain')}
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => {
                      const note = rowNote(l);
                      return (
                        <tr key={l.jobId} className={`q-row${l.estGrossProfitCents < 0 ? ' is-attn' : ''}`}>
                          <td style={{ width: 260, ...STICKY }}>
                            <Link className="l1 mb-row-link" href={`/jobs/${l.jobId}`}>{l.jobNumber ?? '—'} · {l.jobName ?? 'Job'}</Link>
                            <span className="l2">{l.methodLabel}{note ? ` · ${note}` : ''}</span>
                          </td>
                          <td className="n tnum">{money(l.contractCents, { decimals: 0 })}</td>
                          <td className="n tnum">{money(l.eacCents, { decimals: 0 })}</td>
                          <td className="n tnum">{amt(l.costToDateCents)}</td>
                          <td className="n tnum" title={l.contractCents > 0 ? `Earned ${usd0(l.earnedCents)} of the ${usd0(l.contractCents)} contract` : undefined}>{pct(l.pctComplete)}</td>
                          <td className="n tnum">{amt(l.earnedCents)}</td>
                          <td className="n tnum">{amt(l.billedCents)}</td>
                          {data.policy.retainagePresentation === 'SEPARATE' && <td className="n tnum">{money(l.retainageCents, { decimals: 0, zeroAsDash: true })}</td>}
                          <td className="n tnum">{money(l.underCents, { decimals: 0, zeroAsDash: true })}</td>
                          <td className="n tnum">{money(l.overCents, { decimals: 0, zeroAsDash: true })}</td>
                          <td className="n tnum">{amt(l.lossProvisionCents)}</td>
                          <td className={`n tnum${l.estGrossProfitCents < 0 ? ' neg' : ''}`}>{money(l.estGrossProfitCents, { decimals: 0 })}</td>
                          <td className={`n tnum${(l.fadeGainCents ?? 0) < 0 ? ' neg' : ''}`}>
                            {l.fadeGainCents == null ? <span className="ink-3">—</span> : money(l.fadeGainCents, { decimals: 0, sign: 'delta' })}
                          </td>
                        </tr>
                      );
                    })}
                    <tr className="q-group">
                      <td style={{ ...STICKY, background: 'var(--canvas, #F5F3EF)' }}>
                        <b>Total · {ct.jobs} {ct.jobs === 1 ? 'job' : 'jobs'}</b>
                        {filtered && <span className="l2">Shown rows only · {data.lines.length} on the schedule</span>}
                      </td>
                      <td className="n tnum b">{amt(ct.contractCents)}</td>
                      <td className="n tnum b">{amt(ct.eacCents)}</td>
                      <td className="n tnum b">{amt(ct.costToDateCents)}</td>
                      <td
                        className="n tnum b"
                        title={
                          ct.pctComplete == null
                            ? 'No contract value on these jobs'
                            : `Total earned ${usd0(ct.earnedCents)} ÷ total contract ${usd0(ct.contractCents)} — the contract-weighted average of the rows`
                        }
                      >
                        {ct.pctComplete == null ? <span className="ink-3">—</span> : pct(ct.pctComplete)}
                      </td>
                      <td className="n tnum b">{amt(ct.earnedCents)}</td>
                      <td className="n tnum b">{amt(ct.billedCents)}</td>
                      {data.policy.retainagePresentation === 'SEPARATE' && <td className="n tnum b">{amt(ct.retainageCents)}</td>}
                      <td className="n tnum b">{amt(ct.underCents)}</td>
                      <td className="n tnum b">{amt(ct.overCents)}</td>
                      <td className="n tnum b">{amt(ct.lossProvisionCents)}</td>
                      <td className={`n tnum b${ct.estGrossProfitCents < 0 ? ' neg' : ''}`}>{money(ct.estGrossProfitCents, { decimals: 0 })}</td>
                      <td
                        className={`n tnum b${(ct.fadeGainCents ?? 0) < 0 ? ' neg' : ''}`}
                        title={ct.fadeGainCents == null ? 'No prior month to compare with yet' : `${ct.fadeComparedJobs} job${ct.fadeComparedJobs === 1 ? '' : 's'} compared with last month`}
                      >
                        {ct.fadeGainCents == null ? <span className="ink-3">—</span> : money(ct.fadeGainCents, { decimals: 0, sign: 'delta' })}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
            <p className="t-cap ink-3">
              In US dollars. Earned follows each job’s method{data.company ? ` (company default: ${METHOD_COPY[data.company.defaultMethod].label})` : ''}.
              Billed is gross of retainage. <Tag>EAC</Tag> = the larger of the estimate and cost to date.
            </p>
          </section>

          <section aria-labelledby="wip-hist-h" className="stack">
            <h2 id="wip-hist-h" className="t-section">Run history</h2>
            <WipRunHistory runs={data.history} />
          </section>
        </>
      )}
    </div>
  );
}
