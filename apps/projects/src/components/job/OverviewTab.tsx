'use client';

import Link from 'next/link';
import { Figure, Pip, Widget, count, money, pct, ratio, shortDate } from '@meritbooks/merit-ui';
import type { JobOverviewRow, ProjectListRow, TaskRow, ActivityRow } from '@/lib/pm/types';
import { dollars } from '@/lib/pm/money';
import { taskStatus } from '@/lib/pm/stage';
import { ActivityFeed } from '@/components/common/ActivityFeed';
import { useVocab } from '@/components/shell/ShellContext';
import { lower } from '@/lib/pm/vocab';
import { JobDetails, type JobDetailsProps } from './JobDetails';

export interface OverviewTabProps {
  job: ProjectListRow;
  overview: JobOverviewRow | null;
  tasks: TaskRow[];
  activity: ActivityRow[];
  today: string;
  details: JobDetailsProps;
  hasSchedule: boolean;
}

export function OverviewTab({ job, overview: o, tasks, activity, today, details, hasSchedule }: OverviewTabProps) {
  const v = useVocab();
  const base = `/jobs/${job.job_id}`;
  const contract = o?.revised_contract_cents ?? job.contract_revised_cents;
  const est = o?.cost_estimate_cents ?? job.cost_estimate_cents;
  const margin = o?.projected_margin_cents ?? contract - est;
  const mf = ratio(margin, contract);
  const upcoming = tasks.filter((t) => t.status !== 'DONE' && t.status !== 'CANCELLED').sort((a, b) => (a.due_on ?? '9999').localeCompare(b.due_on ?? '9999')).slice(0, 4);

  return (
    <div className="dash" style={{ gridAutoFlow: 'row' }}>
      <Widget primary w={8} h={2} x={1} y={1} title="Key figures" meta="In US dollars" pad>
        <div className="grid-12" style={{ rowGap: 16 }}>
          <div style={{ gridColumn: 'span 3' }}>
            <Figure dense label="Revised contract" value={dollars(contract)} vs={[`${dollars(o?.original_contract_cents ?? job.original_contract_cents)} original`, `${money(o?.approved_co_cents ?? job.approved_co_cents, { decimals: 0, sign: 'delta' })} approved changes`]} href={`${base}?tab=contract`} linkLabel="Contract" />
          </div>
          <div style={{ gridColumn: 'span 3' }}>
            <Figure dense label="Cost estimate" value={dollars(est)} vs={[o?.budget_revised_cents != null ? `${dollars(o.budget_original_cents)} original budget` : o?.budget_original_cents != null ? 'From the original budget' : 'No budget yet']} href={`${base}?tab=budget`} linkLabel="Budget" />
          </div>
          <div style={{ gridColumn: 'span 3' }}>
            <Figure dense label="Projected margin" value={Number.isFinite(mf) ? pct(mf) : '—'} vs={[`${dollars(margin)} on contract`, contract > 0 ? (margin < 0 ? 'Cost is over contract' : 'Before indirect cost') : 'Set a contract to see margin']} href={`${base}?tab=budget`} linkLabel="Budget by cost code" />
          </div>
          <div style={{ gridColumn: 'span 3' }}>
            <Figure dense label={`Pending ${lower(v.change_orders)}`} value={dollars(o?.pending_co_cents ?? job.pending_co_cents)} vs={[`${count(o?.pending_co_count ?? 0)} open`, 'Not in contract until approved']} href={`${base}?tab=change-orders`} linkLabel={v.change_orders} />
          </div>
        </div>
      </Widget>

      <Widget w={4} h={4} x={9} y={1} title="Details" pad>
        <JobDetails {...details} />
      </Widget>

      {hasSchedule && (
        <Widget
          w={8}
          h={2}
          x={1}
          y={3}
          title="Schedule"
          count={o ? `${count(o.tasks_open)} open` : undefined}
          meta={o?.tasks_overdue ? `${count(o.tasks_overdue)} overdue` : o ? `${count(o.tasks_total)} tasks` : undefined}
          foot={<Link className="link" href={`${base}?tab=schedule`}>Open the schedule</Link>}
          state={
            tasks.length === 0
              ? { kind: 'empty', title: 'No tasks yet', body: 'Add the first few tasks with start and due dates.', action: <Link className="btn" href={`${base}?tab=schedule`}>Add tasks</Link> }
              : upcoming.length === 0
                ? { kind: 'done', title: 'Every task is done', body: 'Move the job to its next stage when you are ready.' }
                : undefined
          }
        >
          <ul className="agenda">
            {upcoming.map((t) => {
              const late = !!t.due_on && t.due_on < today;
              const st = taskStatus(t.status, late);
              return (
                <li key={t.id}>
                  <Link href={`${base}?tab=schedule`}>
                    <span className={late ? 'd neg' : 'd'}>{t.due_on ? shortDate(t.due_on) : '—'}</span>
                    <span className="txt">
                      <span className="l1">{t.title}</span>
                      <span className="l2">{st.word}{t.start_on ? ` · started ${shortDate(t.start_on)}` : ''}</span>
                    </span>
                    <Pip kind={st.pip} />
                  </Link>
                </li>
              );
            })}
          </ul>
        </Widget>
      )}

      <Widget
        w={8}
        h={2}
        x={1}
        y={hasSchedule ? 5 : 3}
        title="Recent activity"
        foot={activity.length ? <Link className="link" href={`${base}?tab=activity`}>All activity</Link> : undefined}
        state={activity.length === 0 ? { kind: 'empty', title: 'Nothing has happened on this job yet' } : undefined}
      >
        <ActivityFeed rows={activity.slice(0, 5)} />
      </Widget>
    </div>
  );
}
