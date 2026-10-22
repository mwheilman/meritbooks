'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ButtonLink, Dash, Keys, QueueTable, Widget, count, money,
  type QueueColumn, type QueueGroup,
} from '@meritbooks/merit-ui';
import type { AdminGroup, AdminHomeData, AdminItem } from './persona-data';
import { useCan, useMoneyVis, useVocab } from '@/components/shell/ShellContext';
import { lower } from '@/lib/pm/vocab';

const GROUPS: ReadonlyArray<{ id: AdminGroup; title: string; caption: string }> = [
  { id: 'unscheduled', title: 'Not scheduled', caption: 'Open work with no date or no one booked' },
  { id: 'billing', title: 'Billing not sent', caption: 'Drafts to approve and bills Merit Books sent back' },
  { id: 'compliance', title: 'Compliance expiring', caption: 'Insurance and waivers in the next 30 days' },
];

function dayText(n: AdminItem): string {
  if (n.days == null) return '—';
  if (n.dayWord === 'expires') return n.days < 0 ? `${count(-n.days)}d ago` : n.days === 0 ? 'today' : `in ${count(n.days)}d`;
  return n.days <= 0 ? 'today' : `${count(n.days)}d`;
}

/** The office desk (spec §5 "needs-you queue"): what's waiting on the office, oldest first. */
export function AdminHome({ data, readOnly }: { data: AdminHomeData; readOnly: boolean }) {
  const router = useRouter();
  const v = useVocab();
  const mv = useMoneyVis();
  const seesLeads = useCan('projects.leads:view');
  const live = GROUPS.filter((g) => !data.sources.find((s) => s.group === g.id)?.off);
  const errors = data.sources.filter((s) => !s.off && s.error);
  const groups: QueueGroup<AdminItem>[] = live
    .map((g) => ({
      id: g.id, title: g.title, caption: g.caption,
      rows: data.items.filter((n) => n.group === g.id).sort((a, b) => (g.id === 'compliance' ? (a.days ?? 0) - (b.days ?? 0) : (b.days ?? 0) - (a.days ?? 0))),
    }))
    .filter((g) => g.rows.length > 0);

  const columns: QueueColumn<AdminItem>[] = [
    {
      id: 'item',
      header: 'What needs the office',
      cell: (n) => (
        <Link href={n.href} className="nlink" style={{ display: 'block', minWidth: 0 }}>
          <span className="l1">{n.title}</span>
          <span className="l2">{n.sub}</span>
        </Link>
      ),
    },
    ...(data.items.some((n) => n.company) ? [{ id: 'co', header: 'Company', width: 160, cell: (n: AdminItem) => <span className="l2">{n.company}</span> }] : []),
    ...(mv.contract
      ? [{ id: 'amt', header: 'Amount', numeric: true, width: 120, cell: (n: AdminItem) => (n.amountCents != null ? money(n.amountCents) : '—') }]
      : []),
    {
      id: 'age',
      header: 'Waiting',
      numeric: true,
      width: 96,
      cell: (n) => <span className={n.dayWord === 'expires' && (n.days ?? 1) <= 0 ? 'neg b' : undefined}>{dayText(n)}</span>,
    },
    { id: 'fix', header: <span className="sr">Action</span>, width: 152, cell: (n) => <ButtonLink variant="quiet" href={n.href}>{n.fix}</ButtonLink> },
  ];

  const total = groups.reduce((s, g) => s + g.rows.length, 0);
  const allFailed = errors.length > 0 && errors.length === live.length;

  return (
    <Dash flow="row">
      <Widget
        primary
        w={8}
        h={5}
        x={1}
        y={1}
        title="Needs the office"
        count={total || undefined}
        meta={groups.length ? groups.map((g) => `${g.rows.length} ${(GROUPS.find((x) => x.id === g.id)?.title ?? '').toLowerCase()}`).join(' · ') : undefined}
        foot={
          total ? (
            <>
              <span>{errors.length ? errors.map((e) => e.error).join(' ') : `Checked ${count(data.openJobs)} open ${lower(v.jobs)}`}</span>
              <Keys chord="j k">move</Keys>
              <Keys chord="enter">open</Keys>
            </>
          ) : undefined
        }
        state={
          allFailed
            ? { kind: 'error', title: 'The office queue didn’t load', body: `${errors.map((e) => e.error).join(' ')} Try again; if it repeats, tell support.`, onRetry: () => router.refresh(), retryLabel: 'Try again' }
            : total === 0
              ? {
                  kind: 'done',
                  title: 'Nothing is waiting on the office',
                  body: errors.length
                    ? `${errors.map((e) => e.error).join(' ')} Everything else is clear.`
                    : `Every open ${lower(v.job)} has a start date${live.some((g) => g.id === 'billing') ? ', no bill is waiting to be sent' : ''}${live.some((g) => g.id === 'compliance') ? ' and no compliance document expires in the next 30 days' : ''}.`,
                  action: readOnly ? undefined : <ButtonLink href="/jobs">Open {lower(v.jobs)}</ButtonLink>,
                }
              : undefined
        }
      >
        <QueueTable
          aria-label="Work waiting on the office, by kind"
          columns={columns}
          groups={groups}
          getRowId={(n) => n.id}
          rowState={(n) => ({ attn: n.group === 'compliance' && (n.days ?? 1) <= 0 })}
          openOnClick
          onOpen={(n) => router.push(n.href)}
          flush
          compact
        />
      </Widget>

      {seesLeads && (
        <Widget
          w={4}
          h={2}
          x={9}
          y={1}
          title="New leads"
          state={{
            kind: 'empty',
            title: 'Leads arrive in the next release',
            body: 'Calls and web inquiries will land here with their source and a follow-up date. Until then, start the work as a job.',
            action: readOnly ? undefined : <ButtonLink href="/jobs?new=1">New {lower(v.job)}</ButtonLink>,
          }}
        />
      )}

      <Widget w={4} h={3} x={9} y={seesLeads ? 3 : 1} title="Where it stands" pad>
        <ul className="glance">
          {GROUPS.map((g) => {
            const src = data.sources.find((s) => s.group === g.id);
            if (!src || src.off) return null;
            const n = data.items.filter((i) => i.group === g.id).length;
            return (
              <li key={g.id}>
                <span className="gl">
                  <span className="fig-l">{g.title}</span>
                  <span className="fig-v--dense">{src.error ? '—' : count(n)}</span>
                  <span className="fig-vs">
                    <span>{src.error ?? g.caption}</span>
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      </Widget>
    </Dash>
  );
}
