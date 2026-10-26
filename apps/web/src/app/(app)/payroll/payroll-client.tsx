'use client';

import { useMemo, useState } from 'react';
import { Button, Icon, Keyhints, Tabs, Tag, cx, useListKeynav } from '@meritbooks/merit-ui';
import { PageHeader, EmptyState, TableSkeleton } from '@/components/ui';
import { BuildStatusBadge } from '@/components/brand';
import { useShellLine } from '@/components/layout/shell-context';
import { useQuery } from '@/hooks';
import { useMe } from '@/lib/hooks/use-me';
import { formatMoney } from '@meritbooks/shared';
import { fmtDate, type RunListItem, type RunsResponse, type RunStatus } from './types';
import { RUN_STEPS, RunPipeline, RunStatusBadge, runStage, type PipeStep } from './run-status';
import { RunWizard } from './run-wizard';
import { RunDetailDrawer } from './run-detail-drawer';
import { ImportRegister } from './register-import';
import { ImportRegisterCsv } from './register-csv-import';
import s from './payroll.module.css';

type SortKey = 'periodEnd' | 'payDate' | 'status' | 'grossCents' | 'netCents' | 'employeeCount';
type SortDir = 'asc' | 'desc';
type Filter = 'all' | 'flight' | 'done' | 'problem';

const TERMINAL: RunStatus[] = ['PAID', 'POSTED', 'RECONCILED', 'REJECTED', 'VOID', 'RETURNED'];
const AWAITING: RunStatus[] = ['PREVIEWED', 'PENDING_APPROVAL'];
const PROBLEM: RunStatus[] = ['FAILED', 'RETURNED', 'REJECTED'];
const COMPLETE: RunStatus[] = ['PAID', 'POSTED', 'RECONCILED', 'VOID'];

const FILTERS: ReadonlyArray<{ value: Filter; label: string; test: (st: RunStatus) => boolean }> = [
  { value: 'all', label: 'All runs', test: () => true },
  { value: 'flight', label: 'In flight', test: (st) => !TERMINAL.includes(st) && !PROBLEM.includes(st) },
  { value: 'done', label: 'Complete', test: (st) => COMPLETE.includes(st) },
  { value: 'problem', label: 'Needs a look', test: (st) => PROBLEM.includes(st) },
];

function providerLabel(p: string | null): string {
  if (!p) return '—';
  if (p === 'mock') return 'Estimate';
  return p.charAt(0).toUpperCase() + p.slice(1);
}

export function PayrollClient() {
  const me = useMe();
  const canCreate = me.can('payroll', 'create');
  const grouped = me.user?.payrollVisibility === 'grouped' || me.user?.payrollVisibility === 'none';

  const { data, isLoading, error, refetch } = useQuery<RunsResponse>('/api/payroll/runs');
  const runs = useMemo(() => data?.runs ?? [], [data]);

  // Is a licensed payroll provider actually connected for this tenant? Until one
  // is, running payroll end-to-end inside MeritBooks produces a NON-BINDING
  // ESTIMATE (flat placeholder rates) — not a tax calculation, and no money moves
  // or is filed. We surface that truth everywhere the run path shows.
  const { data: capData } = useQuery<{ capabilities?: Array<{ capability: string; ready: boolean }> }>(
    '/api/integrations/connections',
    undefined,
    { scope: false },
  );
  const providerReady =
    capData?.capabilities?.some((c) => c.capability === 'PAYROLL' && c.ready) ?? false;

  const [wizardOpen, setWizardOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [csvImportOpen, setCsvImportOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'payDate', dir: 'desc' });
  const [filter, setFilter] = useState<Filter>('all');

  const sorted = useMemo(() => {
    const copy = [...runs];
    const { key, dir } = sort;
    const mult = dir === 'asc' ? 1 : -1;
    copy.sort((a, b) => {
      let av: string | number = a[key];
      let bv: string | number = b[key];
      if (typeof av === 'string' && typeof bv === 'string') {
        return av.localeCompare(bv) * mult;
      }
      av = av as number;
      bv = bv as number;
      return (av - bv) * mult;
    });
    return copy;
  }, [runs, sort]);

  const activeFilter = FILTERS.find((f) => f.value === filter) ?? FILTERS[0]!;
  const visible = useMemo(() => sorted.filter((r) => activeFilter.test(r.status)), [sorted, activeFilter]);

  function toggleSort(key: SortKey) {
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' },
    );
  }

  // ── Summary stats ──────────────────────────────────────────────────────────
  const awaitingCount = runs.filter((r) => AWAITING.includes(r.status)).length;
  const inFlightGross = runs
    .filter((r) => !TERMINAL.includes(r.status))
    .reduce((s, r) => s + (r.grossCents ?? 0), 0);
  const nextPayDate = runs
    .filter((r) => !TERMINAL.includes(r.status))
    .map((r) => r.payDate)
    .filter(Boolean)
    .sort()[0];

  // The 32px context line carries the run-level facts (S20 grammar — no KPI strip).
  useShellLine(
    isLoading || error || !data
      ? null
      : [
          { label: `Next pay date ${fmtDate(nextPayDate)}`, strong: !!nextPayDate },
          { label: `${awaitingCount} awaiting approval`, strong: awaitingCount > 0 },
          grouped ? 'Gross in flight hidden for your role' : `${formatMoney(inFlightGross)} gross in flight`,
          `${runs.length} run${runs.length === 1 ? '' : 's'}`,
        ],
    `${isLoading}:${!!error}:${!!data}:${nextPayDate ?? ''}:${awaitingCount}:${grouped ? 'g' : inFlightGross}:${runs.length}`,
  );

  // Where the in-flight runs sit in the five-step pipeline.
  const pipeSteps = useMemo<PipeStep[]>(() => {
    const counts = RUN_STEPS.map(() => ({ n: 0, failed: 0 }));
    for (const r of runs) {
      if (TERMINAL.includes(r.status) && !PROBLEM.includes(r.status)) continue;
      const st = runStage(r.status, false);
      if (st.current === null) continue;
      const c = counts[st.current];
      if (!c) continue;
      c.n += 1;
      if (st.failed) c.failed += 1;
    }
    return RUN_STEPS.map((label, i) => {
      const c = counts[i] ?? { n: 0, failed: 0 };
      return {
        label,
        who: c.n === 0 ? 'None waiting' : c.failed > 0 ? `${c.n} run${c.n === 1 ? '' : 's'} · ${c.failed} stopped` : `${c.n} run${c.n === 1 ? '' : 's'}`,
        state: c.failed > 0 ? 'attn' : c.n > 0 ? 'cur' : 'todo',
      };
    });
  }, [runs]);

  // J/K move the cursor, Enter opens the run (paused while any overlay is open).
  const overlayOpen = wizardOpen || importOpen || csvImportOpen || !!detailId;
  const showTable = !isLoading && !error && visible.length > 0;
  const { setActiveIndex, rowProps } = useListKeynav({
    count: showTable ? visible.length : 0,
    onOpen: (i) => {
      const r = visible[i];
      if (r) setDetailId(r.id);
    },
    enabled: !overlayOpen,
    owner: 'Payroll runs',
  });

  const totalGross = visible.reduce((t, r) => t + (r.grossCents ?? 0), 0);
  const totalNet = visible.reduce((t, r) => t + (r.netCents ?? 0), 0);

  const sortHead = (label: string, key: SortKey, numeric = false) => {
    const on = sort.key === key;
    return (
      <th
        scope="col"
        className={numeric ? 'n' : undefined}
        aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
      >
        <button type="button" className={on ? 'th-sort' : 'mb-th-btn'} onClick={() => toggleSort(key)} aria-label={`Sort by ${label.toLowerCase()}`}>
          {label}
          {on ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
        </button>
      </th>
    );
  };

  return (
    <div className={s.stack}>
      <PageHeader
        eyebrow={['Payables', 'Payroll']}
        title="Payroll"
        description="Run payroll at your processor, then import the register. We read the period totals and post the balanced, job-costed payroll entry to the ledger."
        actions={
          canCreate ? (
            // ONE primary — the production path — and two secondaries. The long
            // explanations live in each button's tooltip and in the two paths below.
            <>
              <Button
                onClick={() => setCsvImportOpen(true)}
                icon="file-text"
                title="Import a CSV or Excel payroll register — no AI. Map the columns, save the mapping, and post a balanced payroll entry."
              >
                From spreadsheet
              </Button>
              <Button
                variant="quiet"
                icon={providerReady ? 'right' : 'clipboard'}
                onClick={() => setWizardOpen(true)}
                title={
                  providerReady
                    ? 'Run payroll end-to-end through your connected provider'
                    : 'No payroll provider connected — the run wizard produces a non-binding estimate only (not a tax calculation, no filing, no money movement)'
                }
              >
                {providerReady ? 'Run payroll' : 'Estimate a run'}
              </Button>
              <Button
                variant="primary"
                icon="upload"
                onClick={() => setImportOpen(true)}
                title="Drop the processor's payroll register (PDF or image) and post a balanced payroll entry to the ledger"
              >
                Import register
              </Button>
            </>
          ) : undefined
        }
      />

      {/* Honest framing: which path is real, and what the run wizard is when no
          provider is connected. Always shown so no one mistakes the estimate for
          filed payroll. */}
      <div className={s.paths}>
        <section className={cx(s.path, s.pathLive)} aria-labelledby="pr-path-import">
          <div className="eyebrow">
            01<span className="sl">//</span>Production path
          </div>
          <h2 className="t-head" id="pr-path-import">Import a payroll register</h2>
          <p>
            Run payroll at your processor or in a spreadsheet, then drop the register here. We extract the period totals
            and post a balanced payroll entry you review first.
          </p>
          <div className={s.pathFoot}>
            <BuildStatusBadge status="live" label="Posts real entries to the ledger" />
          </div>
        </section>
        <section className={s.path} aria-labelledby="pr-path-run">
          <div className="eyebrow">
            02<span className="sl">//</span>In the app
          </div>
          <h2 className="t-head" id="pr-path-run">Run payroll here</h2>
          {providerReady ? (
            <p>
              A payroll provider is connected. The wizard computes gross-to-net through the provider, holds a
              separation-of-duties approval, and only moves money when you explicitly release.
            </p>
          ) : (
            <p>
              No payroll provider is connected yet. The wizard runs as a <b className="ink">non-binding estimate</b> using
              flat placeholder rates. It does not calculate real taxes, withhold, file or move any money. Use it to
              preview the workflow only.
            </p>
          )}
          <div className={s.pathFoot}>
            {providerReady ? (
              <Tag tone="ai">Provider connected</Tag>
            ) : (
              <BuildStatusBadge
                status="sandbox"
                label="Sandbox — estimate only"
                title="No payroll provider is connected — the in-app run wizard produces a non-binding estimate, not filed payroll and no money movement."
              />
            )}
          </div>
        </section>
      </div>

      {data && runs.length > 0 && (
        <RunPipeline aggregate steps={pipeSteps} label="Payroll runs by step" />
      )}

      {grouped && runs.length > 0 && (
        <p className={s.note}>
          <Icon name="eye" />
          Your role has grouped payroll visibility. Individual pay amounts are hidden; you see run status and dates only.
        </p>
      )}

      {isLoading ? (
        <TableSkeleton rows={5} cols={7} />
      ) : error ? (
        <div className={s.state} role="alert">
          <Tag tone="neg">Not loaded</Tag>
          <p className="t-head">Couldn&apos;t load payroll runs.</p>
          <p className="ink-2">{error}</p>
          <Button onClick={() => void refetch()}>Try again</Button>
        </div>
      ) : runs.length === 0 ? (
        <EmptyState
          title="No payroll runs yet"
          description={
            canCreate
              ? 'Import a payroll register from your processor and we post the balanced, job-costed entry to the ledger. Runs and imports appear here once started.'
              : 'No payroll runs have been created yet. Runs will appear here once a preparer starts one.'
          }
          action={canCreate ? { label: 'Import payroll register', onClick: () => setImportOpen(true) } : undefined}
        />
      ) : (
        <div className={s.stack}>
          <div className={s.toolbar}>
            <Tabs<Filter>
              aria-label="Run status"
              value={filter}
              onChange={setFilter}
              items={FILTERS.map((f) => ({
                value: f.value,
                label: f.label,
                count: runs.filter((r) => f.test(r.status)).length,
              }))}
            />
            <div className={s.grow} />
            <span className="t-cap tnum">
              {visible.length} of {runs.length} run{runs.length === 1 ? '' : 's'}
            </span>
          </div>

          {visible.length === 0 ? (
            <EmptyState
              title="No runs match"
              description={`No payroll runs are ${activeFilter.label.toLowerCase()} right now.`}
              action={{ label: 'Show all runs', onClick: () => setFilter('all') }}
            />
          ) : (
            <div>
              <div className={s.tableWrap}>
                <table className="tbl tbl-q" aria-label="Payroll runs">
                  <colgroup>
                    <col />
                    <col style={{ width: 128 }} />
                    <col style={{ width: 176 }} />
                    <col style={{ width: 120 }} />
                    <col style={{ width: 112 }} />
                    <col style={{ width: 144 }} />
                    <col style={{ width: 144 }} />
                    <col style={{ width: 40 }} />
                  </colgroup>
                  <thead>
                    <tr>
                      {sortHead('Pay period', 'periodEnd')}
                      {sortHead('Pay date', 'payDate')}
                      {sortHead('Status', 'status')}
                      <th scope="col">Provider</th>
                      {sortHead('Employees', 'employeeCount', true)}
                      {sortHead('Gross', 'grossCents', true)}
                      {sortHead('Net', 'netCents', true)}
                      <th scope="col"><span className="sr">Open</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((row, i) => {
                      const { ref, 'data-active': active } = rowProps(i);
                      return (
                        <RunRow
                          key={row.id}
                          rowRef={ref}
                          active={active}
                          row={row}
                          grouped={grouped}
                          onClick={() => {
                            setActiveIndex(i);
                            setDetailId(row.id);
                          }}
                        />
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={4}>
                        Total · <span className="tnum">{visible.length}</span> run{visible.length === 1 ? '' : 's'}
                      </td>
                      <td className="n" />
                      <td className="n">{grouped ? '••••' : formatMoney(totalGross)}</td>
                      <td className="n">{grouped ? '••••' : formatMoney(totalNet)}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
              <Keyhints
                className={s.hints}
                hints={[
                  { chord: 'j k', label: 'Move' },
                  { chord: 'enter', label: 'Open run' },
                ]}
              />
            </div>
          )}
        </div>
      )}

      {wizardOpen && (
        <RunWizard
          providerReady={providerReady}
          onClose={() => setWizardOpen(false)}
          onCreated={() => refetch()}
          onReview={(id) => {
            setWizardOpen(false);
            setDetailId(id);
          }}
        />
      )}

      {importOpen && (
        <ImportRegister
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onPosted={() => refetch()}
        />
      )}

      {csvImportOpen && (
        <ImportRegisterCsv
          open={csvImportOpen}
          onClose={() => setCsvImportOpen(false)}
          onPosted={() => refetch()}
        />
      )}

      {detailId && (
        <RunDetailDrawer
          runId={detailId}
          providerReady={providerReady}
          onClose={() => setDetailId(null)}
          onChanged={() => refetch()}
        />
      )}
    </div>
  );
}

function RunRow({
  row,
  grouped,
  active,
  rowRef,
  onClick,
}: {
  row: RunListItem;
  grouped: boolean;
  active: boolean;
  rowRef: (el: HTMLElement | null) => void;
  onClick: () => void;
}) {
  const attn = row.status === 'FAILED' || row.status === 'RETURNED' || row.status === 'REJECTED';
  return (
    <tr
      ref={rowRef}
      className={cx('q-row', active && 'is-cursor', attn && 'is-attn')}
      aria-current={active ? 'true' : undefined}
      style={{ cursor: 'pointer' }}
      onClick={onClick}
    >
      <td>
        <span className="l1 tnum">
          {fmtDate(row.periodStart)} <span className="ink-3">→</span> {fmtDate(row.periodEnd)}
        </span>
      </td>
      <td className="tnum">{fmtDate(row.payDate)}</td>
      <td>
        <RunStatusBadge status={row.status} />
      </td>
      <td className="ink-2">{providerLabel(row.provider)}</td>
      <td className="n">{row.employeeCount}</td>
      <td className="n">{grouped ? '••••' : formatMoney(row.grossCents ?? 0)}</td>
      <td className="n">{grouped ? '••••' : formatMoney(row.netCents ?? 0)}</td>
      <td className="n ink-3" aria-hidden="true">
        <Icon name="right" />
      </td>
    </tr>
  );
}
