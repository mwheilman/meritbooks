'use client';

import Link from 'next/link';
import { ButtonLink, Figure, Widget, count, money, pct, ratio, shortDate } from '@meritbooks/merit-ui';
import type { JobOverviewRow, ProjectListRow, TaskRow, ActivityRow } from '@/lib/pm/types';
import { dollars } from '@/lib/pm/money';
import { addDays } from '@/lib/time';
import { useMoneyVis, useVocab } from '@/components/shell/ShellContext';
import { seesMargin, when } from '@/components/money/visibility';
import { lower } from '@/lib/pm/vocab';
import type { AttentionItem } from './job-attention';
import type { JobPhoto } from './overview-data';
import { JobActivity } from './JobActivity';
import './job.css';

export interface OpenItem {
  key: string;
  label: string;
  count: number;
  href: string;
}

export interface OverviewTabProps {
  job: ProjectListRow;
  overview: JobOverviewRow | null;
  tasks: TaskRow[];
  activity: ActivityRow[];
  today: string;
  hasSchedule: boolean;
  attention: AttentionItem[];
  openItems: OpenItem[];
  /** null = photos could not be read; [] = none yet. */
  photos: JobPhoto[] | null;
  photosHref: string;
  customer: { id: string | null; name: string; primaryContact: string | null } | null;
  /** Hrefs for tabs this job has (figures and strips never link to a tab the caller can't open). */
  links: { contract: string; budget: string; changes: string; schedule: string; activity: string };
}

const STRIP_DAYS = 14;

function dayIndex(from: string, d: string): number {
  return Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Overview (UX seat §3d), in order: needs attention · key numbers (by money level) · the next 14
 * days · open items by type · latest photos · customer · recent activity.
 */
export function OverviewTab(p: OverviewTabProps) {
  const v = useVocab();
  const mv = useMoneyVis();
  const { job, overview: o } = p;
  const base = `/jobs/${job.job_id}`;
  const contract = o?.revised_contract_cents ?? job.contract_revised_cents;
  const est = o?.cost_estimate_cents ?? job.cost_estimate_cents;
  const margin = o?.projected_margin_cents ?? contract - est;
  const mf = ratio(margin, contract);
  const openTasks = p.tasks.filter((t) => t.status !== 'DONE' && t.status !== 'CANCELLED');

  const figures = [
    ...when(mv.contract,
      <Figure key="c" dense label="Revised contract" value={dollars(contract)} vs={[`${dollars(o?.original_contract_cents ?? job.original_contract_cents)} original`, `${money(o?.approved_co_cents ?? job.approved_co_cents, { decimals: 0, sign: 'delta' })} approved changes`]} href={p.links.contract} linkLabel="Contract" />),
    ...when(mv.cost,
      <Figure key="e" dense label="Cost estimate" value={dollars(est)} vs={[o?.budget_revised_cents != null ? `${dollars(o.budget_original_cents)} original budget` : o?.budget_original_cents != null ? 'From the original budget' : 'No budget yet']} href={p.links.budget} linkLabel="Budget" />),
    ...when(seesMargin(mv),
      <Figure key="m" dense label="Projected margin" value={Number.isFinite(mf) ? pct(mf) : '—'} vs={[`${dollars(margin)} on contract`, contract > 0 ? (margin < 0 ? 'Cost is over contract' : 'Before indirect cost') : 'Set a contract to see margin']} href={p.links.budget} linkLabel="Budget by cost code" />),
    mv.contract
      ? <Figure key="p" dense label={`Pending ${lower(v.change_orders)}`} value={dollars(o?.pending_co_cents ?? job.pending_co_cents)} vs={[`${count(o?.pending_co_count ?? 0)} open`, 'Not in contract until approved']} href={p.links.changes} linkLabel={v.change_orders} />
      : <Figure key="p" dense label={`Pending ${lower(v.change_orders)}`} value={count(o?.pending_co_count ?? 0)} vs={['Open', 'Not in contract until approved']} href={p.links.changes} linkLabel={v.change_orders} />,
    ...when(!mv.cost && !mv.contract,
      <Figure key="t" dense label="Open tasks" value={count(openTasks.length)} vs={[`${count(o?.tasks_overdue ?? 0)} overdue`, p.hasSchedule ? 'On the schedule' : 'No schedule on this job']} href={p.links.schedule} linkLabel="Schedule" />,
      <Figure key="s" dense label="Stage" value={job.stage_label ?? job.stage_key} vs={[job.job_type_label]} href={p.links.activity} linkLabel="Activity" />),
  ];

  // ---- the next 14 days
  const end = addDays(p.today, STRIP_DAYS - 1);
  const inWindow = openTasks
    .filter((t) => {
      const s = t.start_on ?? t.due_on;
      const f = t.due_on ?? t.start_on;
      return !!s && !!f && s <= end && f >= p.today;
    })
    .sort((a, b) => (a.start_on ?? a.due_on ?? '').localeCompare(b.start_on ?? b.due_on ?? ''))
    .slice(0, 8);
  const lateCount = openTasks.filter((t) => t.due_on && t.due_on < p.today).length;

  return (
    <div className="dash job-ov" style={{ gridAutoFlow: 'row' }}>
      <Widget
        primary
        w={12}
        h={2}
        title="Needs attention"
        count={p.attention.length || undefined}
        meta="Checks, not AI"
        state={p.attention.length === 0 ? { kind: 'done', title: 'Nothing needs attention', body: 'Every check on this job is clear.' } : undefined}
      >
        <ul className="job-attn">
          {p.attention.map((a) => (
            <li key={a.id} className={`is-${a.tone}`}>
              <span className="txt">
                <span className="l1">{a.title}</span>
                <span className="l2">{a.evidence}</span>
              </span>
              <ButtonLink href={a.action.href}>{a.action.label}</ButtonLink>
            </li>
          ))}
        </ul>
      </Widget>

      <Widget w={12} h={2} title="Key numbers" meta={mv.cost || mv.contract ? 'In US dollars' : 'Hours and counts'} pad>
        <div className="job-ov-figs">
          {figures.map((f, i) => <div key={i}>{f}</div>)}
        </div>
      </Widget>

      {p.hasSchedule && (
        <Widget
          w={7}
          h={3}
          title="Next 14 days"
          meta={lateCount ? `${count(lateCount)} overdue` : `${shortDate(p.today)} to ${shortDate(end)}`}
          foot={<Link className="link" href={p.links.schedule}>Open the schedule</Link>}
          state={inWindow.length === 0 ? { kind: 'empty', title: 'Nothing scheduled in the next two weeks', body: lateCount ? 'Some tasks are overdue; open the schedule to re-plan them.' : 'Add dates to tasks to see them here.' } : undefined}
        >
          <div className="job-strip" role="list" aria-label="Tasks in the next 14 days">
            {inWindow.map((t) => {
              const s = Math.max(0, dayIndex(p.today, t.start_on ?? t.due_on!));
              const f = Math.min(STRIP_DAYS - 1, dayIndex(p.today, t.due_on ?? t.start_on!));
              const late = !!t.due_on && t.due_on < p.today;
              return (
                <Link key={t.id} role="listitem" href={p.links.schedule} className="job-strip-row">
                  <span className="nm">{t.is_milestone ? '◆ ' : ''}{t.title}</span>
                  <span className="tl" aria-label={`${t.start_on ? shortDate(t.start_on) : ''} to ${t.due_on ? shortDate(t.due_on) : ''}`}>
                    {t.is_milestone
                      ? <b style={{ left: `${((f + 0.5) / STRIP_DAYS) * 100}%` }} />
                      : <i className={late ? 'late' : undefined} style={{ left: `${(s / STRIP_DAYS) * 100}%`, width: `${(Math.max(1, f - s + 1) / STRIP_DAYS) * 100}%` }} />}
                  </span>
                </Link>
              );
            })}
          </div>
        </Widget>
      )}

      <Widget w={p.hasSchedule ? 5 : 12} h={p.hasSchedule ? 3 : 2} title="Open items" state={p.openItems.length === 0 ? { kind: 'done', title: 'No open items', body: 'Nothing is waiting on this job.' } : undefined}>
        <ul className="job-open">
          {p.openItems.map((i) => (
            <li key={i.key}>
              <Link href={i.href}>
                <span>{i.label}</span>
                <span className="tnum">{count(i.count)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </Widget>

      <Widget
        w={7}
        h={2}
        title="Latest photos"
        foot={<Link className="link" href={p.photosHref}>All documents and photos</Link>}
        state={
          p.photos === null
            ? { kind: 'empty', title: 'Photos did not load', body: 'Open Documents to see this job’s files.' }
            : p.photos.length === 0
              ? { kind: 'empty', title: 'No photos yet', body: 'Photos taken in the field app or added to Documents show here.' }
              : undefined
        }
      >
        <ul className="job-photos">
          {(p.photos ?? []).map((ph) => (
            <li key={ph.id}>
              <a href={ph.url ?? p.photosHref} target={ph.url ? '_blank' : undefined} rel="noreferrer" title={ph.name}>
                {ph.url ? <img src={ph.url} alt={ph.name} loading="lazy" /> : <span className="t-cap ink-3">{ph.name}</span>}
              </a>
            </li>
          ))}
        </ul>
      </Widget>

      <Widget w={5} h={2} title={v.customer} pad state={!p.customer ? { kind: 'empty', title: `No ${lower(v.customer)} yet`, body: 'Choose one in Details on the right.' } : undefined}>
        {p.customer && (
          <div className="job-cust">
            {p.customer.id ? <Link className="link t-head" href={`/customers/${p.customer.id}`}>{p.customer.name}</Link> : <span className="t-head">{p.customer.name}</span>}
            <span className="t-cap ink-3">{p.customer.primaryContact ? `Primary contact: ${p.customer.primaryContact}` : 'No primary contact on file'}</span>
          </div>
        )}
      </Widget>

      <Widget w={12} h={4} title="Recent activity" foot={p.activity.length > 10 ? <Link className="link" href={p.links.activity}>All activity</Link> : undefined}>
        <JobActivity rows={p.activity} showMoney={mv.contract} limit={10} />
      </Widget>
    </div>
  );
}
