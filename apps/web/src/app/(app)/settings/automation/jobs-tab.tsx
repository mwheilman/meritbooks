'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  Bands,
  Button,
  ConfirmDialog,
  Eyebrow,
  InlineNotice,
  Pip,
  QueueTable,
  Switch,
  Tag,
  api,
  toast,
  useQuery,
  type QueueAction,
  type QueueColumn,
} from '@meritbooks/merit-ui';
import { RUN_LOOK, STATE_LOOK, countChips, describeCron, emptyHistoryText, relative, stamp, type JobView, type RunsResponse } from './automation-types';
import s from './automation.module.css';

type Band = 'all' | 'attention' | 'off' | 'not_built';

/** Runs shown in a job's panel. */
const JOB_HISTORY_LIMIT = 20;

interface RunNowResponse {
  ok: boolean;
  runId: string;
  status: 'ok' | 'partial' | 'failed' | 'skipped' | 'running';
  summary: string | null;
  error: string | null;
}

/**
 * Jobs: every scheduled job, whether it is on for this tenant, when it last ran and what it
 * did, when it runs next, and a confirmed "Run now". Reads /api/scheduler/runs.
 */
export function JobsTab() {
  const [band, setBand] = useState<Band>('all');
  const [cursor, setCursor] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [confirmRun, setConfirmRun] = useState<JobView | null>(null);
  const [confirmToggle, setConfirmToggle] = useState<{ job: JobView; enabled: boolean } | null>(null);
  const [running, setRunning] = useState<string | null>(null);

  const { data, error, isLoading, refetch } = useQuery<RunsResponse>('/api/scheduler/runs', { limit: '1' }, { key: String(refreshKey), scope: false }); // job health + last run; per-job history below
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const jobs = useMemo(() => data?.jobs ?? [], [data]);
  const counts = useMemo(
    () => ({
      all: jobs.filter((j) => j.implemented).length,
      attention: jobs.filter((j) => j.state === 'failing' || j.lastStatus === 'partial').length,
      off: jobs.filter((j) => j.implemented && !j.enabled).length,
      notBuilt: jobs.filter((j) => !j.implemented).length,
    }),
    [jobs],
  );
  const shown = useMemo(() => {
    if (band === 'attention') return jobs.filter((j) => j.state === 'failing' || j.lastStatus === 'partial');
    if (band === 'off') return jobs.filter((j) => j.implemented && !j.enabled);
    if (band === 'not_built') return jobs.filter((j) => !j.implemented);
    return jobs.filter((j) => j.implemented);
  }, [jobs, band]);

  const selected = jobs.find((j) => j.key === cursor) ?? shown[0] ?? null;
  // The panel's history is fetched PER JOB (?job_key=…&limit=20): the page-level run log is
  // dominated by the 15-minute jobs, so filtering it client-side left rarely-run jobs with
  // "No runs yet" while their row said "Failing · 3×".
  const jobRuns = useQuery<RunsResponse>(
    '/api/scheduler/runs',
    { limit: String(JOB_HISTORY_LIMIT), job_key: selected?.key ?? '' },
    { key: `${selected?.key ?? ''}:${refreshKey}`, scope: false, enabled: !!selected },
  );
  const history = useMemo(
    () => (jobRuns.data?.runs ?? []).filter((r) => !!selected && r.job_key === selected.key).slice(0, JOB_HISTORY_LIMIT),
    [jobRuns.data, selected],
  );

  const runNow = useCallback(
    async (job: JobView) => {
      setRunning(job.key);
      const res = await api.post<RunNowResponse>('/api/scheduler/run-now', { job_key: job.key });
      setRunning(null);
      if (res.error) {
        toast.error(res.error.error);
        return;
      }
      const r = res.data;
      if (r) {
        if (r.status === 'failed') toast.error(`${job.label} failed: ${r.error ?? 'see the run log'}`);
        else toast(`${job.label}: ${r.summary ?? RUN_LOOK[r.status === 'running' ? 'running' : r.status].word}`);
      }
      refresh();
    },
    [refresh],
  );

  const toggle = useCallback(
    async (job: JobView, enabled: boolean) => {
      const res = await api.put<{ ok: boolean }>('/api/scheduler/jobs', { job_key: job.key, enabled: enabled === job.defaultEnabled ? null : enabled });
      if (res.error) {
        toast.error(res.error.error);
        return;
      }
      toast(`${job.label} is ${enabled ? 'on' : 'off'} for this organization.`);
      refresh();
    },
    [refresh],
  );

  const columns = useMemo<QueueColumn<JobView>[]>(
    () => [
      {
        id: 'state',
        header: 'Status',
        width: 168,
        cell: (j) => {
          const look = STATE_LOOK[j.state];
          return (
            <span className="mb-sev">
              <Pip kind={look.pip} />
              {look.word}
              {j.consecutiveFailures > 1 ? <span className="ink-3"> · {j.consecutiveFailures}×</span> : null}
            </span>
          );
        },
      },
      {
        id: 'job',
        header: 'Job',
        cell: (j) => (
          <>
            <span className="l1">
              {j.label}
              {j.postsToGl ? <> <Tag tone="ai">can post · dial-gated</Tag></> : null}
            </span>
            <span className="l2">{describeCron(j.effectiveCron)}{j.scope === 'platform' ? ' · whole platform' : ''}</span>
          </>
        ),
      },
      {
        id: 'last',
        header: 'Last run',
        width: 190,
        cell: (j) =>
          j.lastRun ? (
            <>
              <span className="l1">
                <Tag tone={RUN_LOOK[j.lastRun.status].tone}>{RUN_LOOK[j.lastRun.status].word}</Tag>{' '}
                <span className="ink-2">{relative(j.lastRun.started_at)}</span>
              </span>
              <span className="l2">{j.lastRun.items_processed.toLocaleString()} item{j.lastRun.items_processed === 1 ? '' : 's'}{j.lastRun.trigger === 'manual' ? ' · run by hand' : ''}</span>
            </>
          ) : (
            <span className="ink-3">Not yet</span>
          ),
      },
      {
        id: 'next',
        header: 'Next run',
        width: 120,
        cell: (j) => <span className="ink-2">{j.enabled ? relative(j.nextRunAt) : 'Off'}</span>,
      },
      {
        id: 'on',
        header: 'On',
        width: 72,
        cell: (j) =>
          j.implemented && j.scope === 'org' ? (
            <Switch
              aria-label={`${j.label} on for this organization`}
              checked={j.enabled}
              onChange={(e) => setConfirmToggle({ job: j, enabled: e.target.checked })}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="ink-3">—</span>
          ),
      },
    ],
    [],
  );

  const actions = useMemo<QueueAction<JobView>[]>(
    () => [{ key: 'r', label: 'Run now', run: (rows) => rows[0] && rows[0].implemented && rows[0].scope === 'org' && setConfirmRun(rows[0]) }],
    [],
  );

  if (error) {
    return (
      <div className={s.state} role="alert">
        <p className="t-head">Couldn’t load the job log.</p>
        <p className="ink-2">{error}</p>
        <Button onClick={() => void refetch()}>Try again</Button>
      </div>
    );
  }
  if (isLoading && !data) {
    return (
      <div className={s.state} role="status">
        <span className="bar-l" style={{ width: '60%' }} aria-hidden="true" />
        <span className="bar-l" style={{ width: '40%' }} aria-hidden="true" />
        <p className="t-cap">Loading scheduled jobs…</p>
      </div>
    );
  }

  return (
    <div>
      {jobs.length > 0 && jobs.every((j) => !j.lastRunAt) && (
        <InlineNotice tone="info" title="Nothing has run yet." className="mb-inline-field">
          Jobs start once the scheduler is switched on for the platform (docs/SCHEDULER.md). Until then you can run any job by hand.
        </InlineNotice>
      )}
      <Bands<Band>
        aria-label="Jobs by state"
        value={band}
        onChange={setBand}
        items={[
          { value: 'all', label: 'Scheduled', count: counts.all.toLocaleString(), caption: 'Built and on the timetable' },
          { value: 'attention', label: 'Needs a look', count: counts.attention.toLocaleString(), caption: 'Failed or partly done' },
          { value: 'off', label: 'Switched off', count: counts.off.toLocaleString(), caption: 'Off for this organization' },
          { value: 'not_built', label: 'Coming later', count: counts.notBuilt.toLocaleString(), caption: 'Registered, not built' },
        ]}
      />

      {shown.length === 0 ? (
        <div className={s.state}>
          <p className="t-head">{band === 'attention' ? 'Every job’s last run went fine.' : 'Nothing here.'}</p>
          <p className="ink-2">Pick another band to see the rest.</p>
        </div>
      ) : (
        <QueueTable
          aria-label="Scheduled jobs"
          columns={columns}
          rows={shown}
          getRowId={(j) => j.key}
          rowState={(j) => ({ attn: j.state === 'failing', done: !j.enabled })}
          cursorId={selected?.key ?? null}
          onCursorChange={(id) => setCursor(id)}
          onOpen={(j) => setCursor(j.key)}
          openOnClick
          actions={actions}
        />
      )}

      {selected && (
        <section className={s.history} aria-label={`${selected.label} — what it does and its runs`}>
          <div className={s.toolbar}>
            <div className={s.grow}>
              <Eyebrow>{['01', selected.label]}</Eyebrow>
              <p className="ink-2" style={{ maxWidth: 820 }}>{selected.description}</p>
              <p className="t-cap">
                Owner: {selected.owner}
                {selected.autonomyFeature ? ` · gated by the autonomy dial ${selected.autonomyFeature} (Settings → Autonomy)` : ''}
                {!selected.defaultEnabled ? ' · off unless switched on' : ''}
              </p>
            </div>
            {selected.implemented && selected.scope === 'org' && (
              <Button variant="primary" icon="clock" disabled={running === selected.key} onClick={() => setConfirmRun(selected)}>
                {running === selected.key ? 'Running…' : 'Run now'}
              </Button>
            )}
          </div>
          {jobRuns.isLoading && !jobRuns.data ? (
            <div className="wg-loading" style={{ height: 96 }} aria-busy="true"><span className="bar-l" style={{ width: '50%' }} /></div>
          ) : jobRuns.error ? (
            <InlineNotice tone="neg" title={`Couldn't load the runs for ${selected.label}.`}>
              {jobRuns.error} <Button variant="quiet" onClick={() => void jobRuns.refetch()}>Try again</Button>
            </InlineNotice>
          ) : history.length === 0 ? (
            <p className="ink-3">{emptyHistoryText(selected)}</p>
          ) : (
            <ul className={s.runList}>
              {history.map((r) => (
                <li key={r.id}>
                  <span className="ink-2 tnum">{stamp(r.started_at)}</span>
                  <span>
                    <Tag tone={RUN_LOOK[r.status].tone}>{RUN_LOOK[r.status].word}</Tag>
                    {r.trigger === 'manual' ? <span className="t-cap"> by hand</span> : null}
                  </span>
                  <span>
                    <span>{r.summary ?? (r.status === 'running' ? 'Still running…' : '—')}</span>
                    {countChips(r.counts).length > 0 && (
                      <span className={s.chips}>
                        {countChips(r.counts).map((c) => (
                          <Tag key={c.k}>{c.k}: {c.v}</Tag>
                        ))}
                      </span>
                    )}
                    {r.error ? <span className={s.err}>{r.error}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <ConfirmDialog
        open={!!confirmRun}
        onClose={() => setConfirmRun(null)}
        title={`Run “${confirmRun?.label ?? ''}” now?`}
        confirmLabel="Run it now"
        tone="primary"
        onConfirm={async () => {
          const j = confirmRun;
          setConfirmRun(null);
          if (j) await runNow(j);
        }}
      >
        It runs once for this organization, exactly as it would on schedule — same autonomy dial, same period locks, and it won’t redo work that’s already done. The scheduled run still happens as planned.
      </ConfirmDialog>
      <ConfirmDialog
        open={!!confirmToggle}
        onClose={() => setConfirmToggle(null)}
        title={confirmToggle?.enabled ? `Turn on “${confirmToggle.job.label}”?` : `Turn off “${confirmToggle?.job.label ?? ''}”?`}
        confirmLabel={confirmToggle?.enabled ? 'Turn it on' : 'Turn it off'}
        tone={confirmToggle?.enabled ? 'primary' : 'danger'}
        onConfirm={async () => {
          const t = confirmToggle;
          setConfirmToggle(null);
          if (t) await toggle(t.job, t.enabled);
        }}
      >
        {confirmToggle?.enabled
          ? 'It runs on its schedule for this organization from the next slot.'
          : 'It stops running for this organization until you turn it back on. Nothing it already did is undone.'}
      </ConfirmDialog>
    </div>
  );
}

