'use client';

/**
 * The global Schedule page: every job stacked (summary bars, expand to tasks), the 3-week
 * look-ahead with constraint reasons, and the crew board (crews × days). Filters by PM,
 * company and stage apply to all three.
 */
import { useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Field, InlineNotice, Search, Select, Tabs } from '@meritbooks/merit-ui';
import type { CrewOption, LoadCell, LookaheadRow, ScheduleJobRow } from '@/lib/pm/schedule/types';
import { JobStack } from './JobStack';
import { LookAhead } from './LookAhead';
import { CrewBoard } from './CrewBoard';
import './gantt.css';

export type GlobalView = 'jobs' | 'lookahead' | 'crews';

export interface GlobalJob {
  id: string;
  label: string;
  companyId: string;
  company: string | null;
  pmId: string | null;
  pm: string | null;
  stage: string;
  plannedStart: string | null;
  plannedFinish: string | null;
}

export interface GlobalScheduleProps {
  view: GlobalView;
  jobs: ReadonlyArray<GlobalJob>;
  summaries: ReadonlyArray<ScheduleJobRow>;
  lookahead: ReadonlyArray<LookaheadRow>;
  crews: ReadonlyArray<CrewOption>;
  load: ReadonlyArray<LoadCell>;
  engine: boolean;
  from: string;
  today: string;
  multi: boolean;
  initialCrew: string | null;
}

export interface JobFilter {
  pm: string;
  company: string;
  stage: string;
  q: string;
}

export function filterJobs(jobs: ReadonlyArray<GlobalJob>, f: JobFilter): GlobalJob[] {
  const q = f.q.trim().toLowerCase();
  return jobs.filter(
    (j) =>
      (!f.pm || (f.pm === '-' ? !j.pmId : j.pmId === f.pm)) &&
      (!f.company || j.companyId === f.company) &&
      (!f.stage || j.stage === f.stage) &&
      (!q || j.label.toLowerCase().includes(q)),
  );
}

const TAB_ITEMS: ReadonlyArray<{ value: GlobalView; label: string }> = [
  { value: 'jobs', label: 'All jobs' },
  { value: 'lookahead', label: '3-week look-ahead' },
  { value: 'crews', label: 'Crew board' },
];

export function GlobalSchedule(p: GlobalScheduleProps) {
  const router = useRouter();
  const sp = useSearchParams();
  const [f, setF] = useState<JobFilter>({ pm: '', company: '', stage: '', q: '' });
  const shown = useMemo(() => filterJobs(p.jobs, f), [p.jobs, f]);
  const shownIds = useMemo(() => new Set(shown.map((j) => j.id)), [shown]);
  const pms = useMemo(() => [...new Map(p.jobs.filter((j) => j.pmId).map((j) => [j.pmId as string, j.pm ?? 'Team member'])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [p.jobs]);
  const companies = useMemo(() => [...new Map(p.jobs.map((j) => [j.companyId, j.company ?? 'Company'])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [p.jobs]);
  const stages = useMemo(() => [...new Set(p.jobs.map((j) => j.stage))].sort(), [p.jobs]);
  const go = (view: GlobalView) => {
    const q = new URLSearchParams(sp?.toString() ?? '');
    q.set('view', view);
    if (view !== 'lookahead') q.delete('crew');
    router.push(`/schedule?${q.toString()}`);
  };
  const filtered = f.pm || f.company || f.stage || f.q;

  return (
    <div className="stack">
      <Tabs<GlobalView> aria-label="Schedule views" items={TAB_ITEMS} value={p.view} onChange={go} />
      <div className="gs-filters" role="search" aria-label="Filter jobs">
        <Field label="Find a job">
          <Search value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="Job number or name" aria-label="Find a job" />
        </Field>
        <Field label="Project manager">
          <Select value={f.pm} onChange={(e) => setF({ ...f, pm: e.target.value })}>
            <option value="">Everyone</option>
            {pms.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
            <option value="-">No PM yet</option>
          </Select>
        </Field>
        {p.multi && (
          <Field label="Company">
            <Select value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })}>
              <option value="">All companies</option>
              {companies.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Stage">
          <Select value={f.stage} onChange={(e) => setF({ ...f, stage: e.target.value })}>
            <option value="">Every stage</option>
            {stages.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
        {filtered && (
          <button type="button" className="btn btn--quiet" onClick={() => setF({ pm: '', company: '', stage: '', q: '' })}>
            Clear filters
          </button>
        )}
      </div>
      {!p.engine && (
        <InlineNotice tone="info" title="Scheduling isn’t switched on yet.">
          {p.view === 'jobs'
            ? 'Bars come from each job’s open task dates; the critical path and float appear when your administrator applies the schedule update.'
            : p.view === 'lookahead'
              ? 'Tasks come from their dates; constraint checks (submittals, material, predecessors) appear when your administrator applies the schedule update.'
              : 'The crew board reads crew assignments and hours from the schedule engine, which your administrator switches on with the schedule update.'}
        </InlineNotice>
      )}
      {p.view === 'jobs' && <JobStack jobs={shown} summaries={p.summaries} today={p.today} filtered={!!filtered} engine={p.engine} />}
      {p.view === 'lookahead' && <LookAhead rows={p.lookahead.filter((r) => shownIds.has(r.job_id))} jobs={p.jobs} crews={p.crews} from={p.from} today={p.today} engine={p.engine} initialCrew={p.initialCrew} filtered={!!filtered} />}
      {p.view === 'crews' && <CrewBoard crews={p.crews} load={p.load} from={p.from} today={p.today} engine={p.engine} />}
    </div>
  );
}
