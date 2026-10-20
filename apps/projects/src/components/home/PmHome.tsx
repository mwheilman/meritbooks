'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ButtonLink, Dash, Figure, Keys, Pip, QueueTable, Widget, count, money, shortDate,
  type QueueColumn, type QueueGroup,
} from '@meritbooks/merit-ui';
import type { HomeData, NeedsItem } from '@/lib/pm/home';
import { dollars, sumBy } from '@/lib/pm/money';
import { ActivityFeed } from '@/components/common/ActivityFeed';
import { useVocab } from '@/components/shell/ShellContext';
import { lower } from '@/lib/pm/vocab';
import { SeamHealthWidget } from './SeamHealthWidget';
import { DrawsInFlightWidget, SelectionsDueWidget, ShopLoadWidget, SignalsWidget, TodaysVisitsWidget } from '@/components/ops/widgets';
import type { ModuleKey } from '@/lib/packs';

const OPS_SIGNAL_MODULES: ReadonlyArray<ModuleKey> = ['dispatch', 'service_agreements', 'production', 'selections', 'procurement_markup', 'lender_draws'];

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dayWord(iso: string, today: string): string {
  if (iso === today) return 'Today';
  const d = new Date(`${iso}T12:00:00Z`);
  return DAY[d.getUTCDay()] ?? shortDate(iso);
}

export function PmHome({ data, readOnly, modules = [] }: { data: HomeData; readOnly: boolean; modules?: ReadonlyArray<ModuleKey> }) {
  const has = (m: ModuleKey) => modules.includes(m);
  const router = useRouter();
  const v = useVocab();
  const jobs = lower(v.jobs);
  const groupsDef: Array<{ id: NeedsItem['group']; title: string; caption: string }> = [
    { id: 'blocked', title: 'Blocked moves', caption: 'The next stage is waiting on a check' },
    { id: 'co', title: `${v.change_orders} to approve`, caption: 'Potential and requested' },
    { id: 'overdue', title: 'Overdue tasks', caption: 'Past their due date' },
    { id: 'nobudget', title: 'No budget yet', caption: `Open ${jobs} without a budget` },
  ];
  const groups: QueueGroup<NeedsItem>[] = groupsDef
    .map((g) => ({ id: g.id, title: g.title, caption: g.caption, rows: data.needs.filter((n) => n.group === g.id) }))
    .filter((g) => g.rows.length > 0);

  const columns: QueueColumn<NeedsItem>[] = [
    {
      id: 'item',
      header: 'What needs you',
      cell: (n) => (
        <Link href={n.href} className="nlink" style={{ display: 'block', minWidth: 0 }}>
          <span className="l1">{n.title}</span>
          <span className="l2">{n.sub}</span>
        </Link>
      ),
    },
    ...(data.multiCompany ? [{ id: 'co', header: 'Company', width: 160, cell: (n: NeedsItem) => <span className="l2">{n.company}</span> }] : []),
    {
      id: 'fig',
      header: 'Amount',
      numeric: true,
      width: 120,
      cell: (n) => (n.amountCents != null ? money(n.amountCents) : n.days != null ? <span className="neg b">{count(n.days)}d late</span> : '—'),
    },
    { id: 'fix', header: <span className="sr">Action</span>, width: 152, cell: (n) => <ButtonLink variant="quiet" href={n.href}>{n.fix}</ButtonLink> },
  ];

  const empty = data.projects.length === 0;
  const pendingCo = sumBy(data.openCos, (c) => c.amount_cents);
  const open = data.projects.filter((p) => !p.stage_is_terminal);
  const openContract = sumBy(open, (p) => p.contract_revised_cents);
  const openOriginal = sumBy(open, (p) => p.original_contract_cents);
  const jobLabels = Object.fromEntries(data.projects.map((p) => [p.job_id, [p.job_number, p.name].filter(Boolean).join(' · ')]));

  return (
    <Dash flow="row">
      <Widget
        primary
        w={8}
        h={4}
        x={1}
        y={1}
        title="Needs you"
        count={data.needs.length || undefined}
        meta={data.needs.length ? groupsDef.map((g) => ({ g, n: data.needs.filter((x) => x.group === g.id).length })).filter((x) => x.n > 0).map((x) => `${x.n} ${x.g.title.toLowerCase()}`).join(' · ') : undefined}
        foot={
          data.needs.length ? (
            <>
              <span>
                Checked the next stage move on {count(data.checkedJobs)} of {count(data.openJobCount)} open {jobs}
              </span>
              <Keys chord="j k">move</Keys>
              <Keys chord="enter">open</Keys>
            </>
          ) : undefined
        }
        state={
          empty
            ? {
                kind: 'empty',
                title: `Create your first ${lower(v.job)}`,
                body: 'Stages, budget and schedule follow from its job type. It takes about a minute.',
                action: readOnly ? undefined : <ButtonLink variant="primary" href="/jobs?new=1">New {lower(v.job)}</ButtonLink>,
              }
            : data.needs.length === 0
              ? {
                  kind: 'done',
                  title: 'Nothing needs you',
                  body: data.nextDue
                    ? `Next due: ${data.nextDue.task.title} on ${data.nextDue.job.job_number ?? 'a job'}, ${shortDate(data.nextDue.task.due_on!)}.`
                    : `No stage moves are blocked, no ${lower(v.change_orders)} are open and no tasks are late.`,
                  action: <ButtonLink href="/jobs">Open {jobs}</ButtonLink>,
                }
              : undefined
        }
      >
        <QueueTable
          aria-label="Work that needs you, by kind"
          columns={columns}
          groups={groups}
          getRowId={(n) => n.id}
          rowState={(n) => ({ attn: n.group === 'blocked' || n.group === 'overdue' })}
          onOpen={(n) => router.push(n.href)}
          flush
          compact
        />
      </Widget>

      <Widget
        w={4}
        h={2}
        x={9}
        y={1}
        title={`${v.jobs} at risk`}
        count={data.risk.length || undefined}
        meta="Over contract or late"
        state={
          empty
            ? { kind: 'empty', title: `Risk shows once ${jobs} have a contract and a budget` }
            : data.risk.length === 0
              ? { kind: 'done', title: `No open ${lower(v.job)} is over contract or late`, body: `${count(open.length)} open ${jobs} checked.` }
              : undefined
        }
        foot={data.risk.length > 3 ? <Link className="link" href="/insights/margin">All {count(data.risk.length)} by margin</Link> : undefined}
      >
        <ul className="agenda">
          {data.risk.slice(0, 3).map((r) => (
            <li key={r.job.job_id}>
              <Link href={`/jobs/${r.job.job_id}`}>
                <span className={r.marginCents < 0 ? 'd neg tnum' : 'd tnum'}>{dollars(r.marginCents)}</span>
                <span className="txt">
                  <span className="l1">{[r.job.job_number, r.job.name].filter(Boolean).join(' · ')}</span>
                  <span className="l2">{r.reason}{r.company ? ` · ${r.company}` : ''}</span>
                </span>
                <Pip kind={r.marginCents < 0 ? 'overdue' : 'risk'} />
              </Link>
            </li>
          ))}
        </ul>
      </Widget>

      <Widget
        w={4}
        h={2}
        x={9}
        y={3}
        title="This week"
        count={data.week.length || undefined}
        meta={data.overdueCount ? `${count(data.overdueCount)} overdue` : undefined}
        state={
          data.week.length === 0
            ? {
                kind: 'done',
                title: 'Nothing due this week',
                body: data.nextDue ? `Next: ${data.nextDue.task.title}, ${shortDate(data.nextDue.task.due_on!)}.` : 'Add dates to tasks to see them here.',
              }
            : undefined
        }
      >
        <ul className="agenda">
          {data.week.slice(0, 5).map((w) => (
            <li key={w.task.id}>
              <Link href={`/jobs/${w.job.job_id}?tab=schedule`}>
                <span className={w.task.due_on === data.today ? 'd neg' : 'd'}>{dayWord(w.task.due_on!, data.today)}</span>
                <span className="txt">
                  <span className="l1">{w.task.title}</span>
                  <span className="l2">{[w.job.job_number, w.job.name].filter(Boolean).join(' · ')}</span>
                </span>
                <Pip kind={w.task.status === 'BLOCKED' ? 'blocked' : w.task.status === 'IN_PROGRESS' ? 'open' : 'track'} />
              </Link>
            </li>
          ))}
        </ul>
      </Widget>

      <Widget
        w={8}
        h={2}
        x={1}
        y={5}
        title="Recent activity"
        foot={data.activity.length ? <Link className="link" href="/activity">All activity</Link> : undefined}
        state={data.activity.length === 0 ? { kind: 'empty', title: 'Activity starts with your first change', body: 'Stage moves, approvals and progress sent to Merit Books show up here.' } : undefined}
      >
        <ActivityFeed rows={data.activity.slice(0, 5)} jobLabels={jobLabels} companyNames={data.multiCompany ? data.companyNames : undefined} />
      </Widget>

      <Widget w={4} h={2} x={9} y={5} title="Open work" pad state={empty ? { kind: 'empty', title: `Figures appear with your first ${lower(v.job)}` } : undefined}>
        <div className="row" style={{ alignItems: 'flex-start', gap: 24 }}>
          <Figure
            dense
            label={`Contract, open ${jobs}`}
            value={dollars(openContract)}
            vs={[`${dollars(openOriginal)} original`, `${money(openContract - openOriginal, { decimals: 0, sign: 'delta' })} changes`]}
            href="/insights/backlog"
            linkLabel="Backlog"
          />
          <Figure
            dense
            label="Pending changes"
            value={dollars(pendingCo)}
            vs={[`${count(data.openCos.length)} open`, 'not in contract yet']}
            href="/review"
            linkLabel="To review"
          />
        </div>
      </Widget>

      <SeamHealthWidget x={1} y={7} w={4} h={2} />
      {has('dispatch') && <TodaysVisitsWidget />}
      {has('production') && <ShopLoadWidget />}
      {has('selections') && <SelectionsDueWidget />}
      {has('lender_draws') && <DrawsInFlightWidget />}
      {OPS_SIGNAL_MODULES.some(has) && <SignalsWidget />}
    </Dash>
  );
}
