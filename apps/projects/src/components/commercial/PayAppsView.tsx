'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Check, Field, Figure, Input, Seg, Tag, money } from '@meritbooks/merit-ui';
import { PAY_APP_STAGE } from '@/lib/commercial/labels';
import type { PayAppListRow } from '@/lib/commercial/screen-types';
import type { JobOption } from '@/lib/pm/ops/scope';
import { useShell } from '@/components/shell/ShellContext';
import { JobSelect } from '@/components/ops/common/bits';
import { useOps } from '@/components/ops/common/useOps';
import { Failure, Mk, cm, day } from './common';
import { CmTable, TableKeys, words, type Col } from './kit';

type Tab = 'working' | 'final' | 'all';
const WORKING = new Set(['PENCIL', 'PENCIL_SENT', 'REVISE', 'CERTIFIED']);

/** Month-end on or after the 25th cutoff, as the default period end of a new application. Pure. */
export function defaultPeriodEnd(today: string): string {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const monthEnd = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10);
  return d > 25 ? monthEnd(y, m + 1) : monthEnd(y, m);
}

/**
 * Owner pay applications across jobs (CGC-41): every SOV application with its stage — pencil,
 * pencil with the owner, returned for revision, certified, final — the G702 figures, and where it
 * stands in the owner's portal. Opening one goes to its workspace.
 */
export function PayAppsView({ rows, jobs, draftable, today }: { rows: PayAppListRow[]; jobs: JobOption[]; draftable: string[]; today: string }) {
  const router = useRouter();
  const { readOnly } = useShell();
  const { act, busy, error } = useOps();
  const [tab, setTab] = useState<Tab>('working');
  const [jobId, setJobId] = useState('');
  const [adding, setAdding] = useState(false);
  const byJob = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);
  const inJob = rows.filter((r) => r.stage !== 'VOID' && (!jobId || r.job_id === jobId));
  const shown = inJob.filter((r) => tab === 'all' || (tab === 'working' ? WORKING.has(r.stage ?? '') : r.stage === 'FINAL'));
  const working = inJob.filter((r) => WORKING.has(r.stage ?? ''));
  const dueNow = working.reduce((s, r) => s + Number(r.current_payment_due_cents ?? 0), 0);
  const latestByJob = new Map<string, PayAppListRow>();
  for (const r of inJob) if (!latestByJob.has(r.job_id)) latestByJob.set(r.job_id, r);
  const retainage = [...latestByJob.values()].reduce((s, r) => s + Number(r.retainage_total_cents ?? 0), 0);

  const cols: Col<PayAppListRow>[] = [
    { key: 'job', head: 'Job', cell: (r) => <><span className="b">{byJob.get(r.job_id)?.label ?? 'Job'}</span>{byJob.get(r.job_id)?.customer && <span className="ops-sub" style={{ display: 'block' }}>{byJob.get(r.job_id)!.customer}</span>}</> },
    { key: 'no', head: 'Application', width: 120, cell: (r) => <>#{r.application_no}{r.revision > 1 && <span className="ops-sub"> rev {r.revision}</span>}</> },
    { key: 'period', head: 'Period ending', width: 120, cell: (r) => day(r.period_end, today) },
    { key: 'stage', head: 'Stage', width: 140, cell: (r) => <Mk map={PAY_APP_STAGE} status={r.stage} /> },
    { key: 'portal', head: 'Portal', width: 150, cell: (r) => (r.portal ? <>{words(r.portal)}<span className="ops-sub" style={{ display: 'block' }}>{words(r.portal_status ?? 'NOT_SUBMITTED')}</span></> : '—') },
    { key: 'sum', head: 'Contract to date', n: true, width: 140, cell: (r) => cm(r.contract_sum_to_date_cents, 0) },
    { key: 'done', head: 'Completed and stored', n: true, width: 150, cell: (r) => cm(r.total_completed_stored_cents, 0) },
    { key: 'ret', head: 'Retainage', n: true, width: 120, cell: (r) => cm(r.retainage_total_cents, 0) },
    { key: 'due', head: 'Due this application', n: true, width: 150, cell: (r) => cm(r.current_payment_due_cents) },
  ];

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="cm-figs">
        <Figure dense label="Due on applications in progress" value={money(dueNow, { decimals: 0 })} vs={[`${working.length} in progress`, `${working.filter((r) => r.stage === 'REVISE').length} returned for revision`]} href="/billing-calendar" linkLabel="Billing calendar" />
        <Figure dense label="Retainage held to date" value={money(retainage, { decimals: 0 })} vs={[`${latestByJob.size} jobs billing on a schedule of values`]} href="/retainage-ledger" linkLabel="Retainage ledger" />
      </div>
      <div className="ops-toolbar">
        <Field label="Job"><JobSelect jobs={jobs.filter((j) => j.open || rows.some((r) => r.job_id === j.id))} value={jobId} onChange={setJobId} placeholder="Every job" /></Field>
        <Seg aria-label="Which applications" value={tab} onChange={setTab} items={[
          { value: 'working', label: 'In progress', count: working.length },
          { value: 'final', label: 'Final' },
          { value: 'all', label: 'All' },
        ]} />
        <span className="sp" />
        {!readOnly && <Button variant="primary" icon="plus" chord="n" bindChord onClick={() => setAdding((v) => !v)}>New pay application</Button>}
      </div>
      <Failure text={error} />
      {adding && !readOnly && (
        <NewPayApp jobs={jobs.filter((j) => draftable.includes(j.id))} defaultJobId={jobId} today={today} busy={busy}
          onDraft={async (b) => { const r = await act<{ id: string }>('draft', 'post', '/api/commercial/pay-apps', { op: 'draft', ...b, lines: [] }, 'Drafted the pencil'); if (r) router.push(`/pay-apps/${r.id}`); }}
          onSync={(id) => void act<{ added: number }>('sync', 'post', '/api/commercial/pay-apps', { op: 'sync_sov', jobId: id }, (d) => (d.added ? `Added ${d.added} approved change ${d.added === 1 ? 'order' : 'orders'} to the schedule of values` : 'The schedule of values already has every approved change order'))} />
      )}
      <CmTable label="Pay applications" keys rows={shown} cols={cols} rowKey={(r) => r.billing_request_id} onOpen={(r) => router.push(`/pay-apps/${r.billing_request_id}`)}
        rowTone={(r) => (r.stage === 'REVISE' ? 'neg' : null)}
        empty={{ title: tab === 'working' ? 'No pay applications in progress' : 'No pay applications yet', body: 'Draft the pencil from the job’s schedule of values: approved change orders are added first, retainage step-downs and stored materials applied, then send it to the owner to review before it is final.' }} />
      <TableKeys extra={[{ chord: 'n', label: 'New pay application' }]} />
      {draftable.length === 0 && <p className="t-cap">A pay application is drafted from an active schedule of values. Set one up on the job’s billing tab first.</p>}
    </div>
  );
}

function NewPayApp({ jobs, defaultJobId, today, busy, onDraft, onSync }: {
  jobs: JobOption[]; defaultJobId: string; today: string; busy: string | null;
  onDraft: (b: { jobId: string; periodEnd: string; syncCos: boolean }) => Promise<void>; onSync: (jobId: string) => void;
}) {
  const [jobId, setJobId] = useState(jobs.some((j) => j.id === defaultJobId) ? defaultJobId : '');
  const [period, setPeriod] = useState(defaultPeriodEnd(today));
  const [sync, setSync] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  return (
    <form className="mp-table mp-add" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 12 }} onSubmit={(e) => {
      e.preventDefault();
      if (!jobId) return setErr('Pick a job with an active schedule of values.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(period)) return setErr('Use a date like 2026-10-31.');
      setErr(null);
      void onDraft({ jobId, periodEnd: period, syncCos: sync });
    }}>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Job" error={err ?? undefined}><JobSelect jobs={jobs} value={jobId} onChange={setJobId} /></Field>
        <Field label="Period ending" help="Defaults to the month the 25th cutoff falls in."><Input type="date" value={period} onChange={(e) => setPeriod(e.target.value)} /></Field>
        <Check label="Add approved change orders to the schedule of values first" checked={sync} onChange={(e) => setSync(e.target.checked)} />
      </div>
      <div className="row" style={{ gap: 8 }}>
        <Button type="submit" variant="primary" disabled={busy !== null}>{busy === 'draft' ? 'Drafting…' : 'Draft the pencil'}</Button>
        <Button disabled={!jobId || busy !== null} onClick={() => onSync(jobId)}>{busy === 'sync' ? 'Adding…' : 'Only add approved change orders'}</Button>
        {jobs.length === 0 && <Tag tone="warn">No job has an active schedule of values</Tag>}
      </div>
    </form>
  );
}
