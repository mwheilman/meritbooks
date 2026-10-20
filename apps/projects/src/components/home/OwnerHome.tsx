'use client';

import Link from 'next/link';
import {
  ButtonLink, Dash, StatementTable, Widget, count, pct, ratio, shortDate,
  type StatementColumn, type StatementRow,
} from '@meritbooks/merit-ui';
import type { HomeData } from '@/lib/pm/home';
import { dollars, marginCents, marginPctText, sumBy } from '@/lib/pm/money';
import type { ProjectListRow } from '@/lib/pm/types';
import { useVocab } from '@/components/shell/ShellContext';
import { lower } from '@/lib/pm/vocab';

const MONEY0 = { decimals: 0 as const };

const STAGE_COLUMNS: StatementColumn[] = [
  { id: 'n', header: 'Count', width: 72, render: (v) => count(v) },
  { id: 'contract', header: 'Revised contract', width: 128, format: MONEY0, current: true },
  { id: 'budget', header: 'Budget', width: 128, format: MONEY0 },
  { id: 'margin', header: 'Projected margin', width: 136, format: MONEY0 },
];

const BACKLOG_COLUMNS: StatementColumn[] = [
  { id: 'contract', header: 'Revised contract', width: 128, format: MONEY0, current: true },
  { id: 'budget', header: 'Budget', width: 120, format: MONEY0 },
  { id: 'margin', header: 'Projected margin', width: 136, format: MONEY0 },
];

function stageRows(projects: ReadonlyArray<ProjectListRow>, names: Record<string, string>, multi: boolean): StatementRow[] {
  const out: StatementRow[] = [];
  const companies = [...new Set(projects.map((p) => p.location_id))].sort((a, b) => (names[a] ?? '').localeCompare(names[b] ?? ''));
  const subIds: string[] = [];
  for (const co of companies) {
    const mine = projects.filter((p) => p.location_id === co);
    const stages = [...new Map(mine.map((p) => [p.stage_key, p])).values()].sort((a, b) => (a.stage_sort ?? 0) - (b.stage_sort ?? 0));
    if (multi) out.push({ kind: 'head', label: names[co] ?? 'Company' });
    const lineIds: string[] = [];
    for (const s of stages) {
      const rows = mine.filter((p) => p.stage_key === s.stage_key);
      const id = `${co}:${s.stage_key}`;
      lineIds.push(id);
      out.push({
        kind: 'line',
        id,
        label: <Link className="nlink" href={`/jobs?stage=${encodeURIComponent(s.stage_key)}`}>{s.stage_label ?? s.stage_key}</Link>,
        values: [rows.length, sumBy(rows, (p) => p.contract_revised_cents), sumBy(rows, (p) => p.budget_total_cents), sumBy(rows, marginCents)],
      });
    }
    if (multi) {
      const subId = `${co}:sub`;
      subIds.push(subId);
      out.push({
        kind: 'sub', id: subId, label: `${names[co] ?? 'Company'} total`, sumOf: lineIds,
        values: [mine.length, sumBy(mine, (p) => p.contract_revised_cents), sumBy(mine, (p) => p.budget_total_cents), sumBy(mine, marginCents)],
      });
    } else {
      subIds.push(...lineIds);
    }
  }
  out.push({
    kind: 'grand', label: 'All stages', sumOf: subIds,
    values: [projects.length, sumBy(projects, (p) => p.contract_revised_cents), sumBy(projects, (p) => p.budget_total_cents), sumBy(projects, marginCents)],
  });
  return out;
}

function backlogRows(active: ReadonlyArray<ProjectListRow>, names: Record<string, string>, multi: boolean): StatementRow[] {
  const sorted = [...active].sort((a, b) => b.contract_revised_cents - a.contract_revised_cents);
  const top = sorted.slice(0, 9);
  const rest = sorted.slice(9);
  const vals = (rows: ReadonlyArray<ProjectListRow>) => [sumBy(rows, (p) => p.contract_revised_cents), sumBy(rows, (p) => p.budget_total_cents), sumBy(rows, marginCents)];
  const out: StatementRow[] = top.map((p) => ({
    kind: 'line' as const,
    id: p.job_id,
    label: (
      <Link className="nlink" href={`/jobs/${p.job_id}`}>
        {[p.job_number, p.name].filter(Boolean).join(' · ')}
        {multi ? <span className="ink-3"> · {names[p.location_id]}</span> : null}
      </Link>
    ),
    values: vals([p]),
  }));
  if (rest.length) out.push({ kind: 'line', id: 'rest', label: `${count(rest.length)} other jobs`, values: vals(rest) });
  out.push({ kind: 'grand', label: 'Contract on jobs in progress', sumOf: [...top.map((p) => p.job_id), ...(rest.length ? ['rest'] : [])], values: vals(sorted) });
  return out;
}

export function OwnerHome({ data }: { data: HomeData }) {
  const v = useVocab();
  const jobs = lower(v.jobs);
  const open = data.projects.filter((p) => !p.stage_is_terminal);
  const active = open.filter((p) => p.core_status === 'ACTIVE' || p.core_status === 'ON_HOLD');
  const empty = data.projects.length === 0;
  const contract = sumBy(open, (p) => p.contract_revised_cents);
  const original = sumBy(open, (p) => p.original_contract_cents);
  const margin = sumBy(open, marginCents);
  const pending = sumBy(data.openCos, (c) => c.amount_cents);
  const noBudget = open.filter((p) => p.budget_total_cents == null).length;
  const withContract = open.filter((p) => p.contract_revised_cents > 0);
  const watch = [...withContract].sort((a, b) => ratio(marginCents(a), a.contract_revised_cents) - ratio(marginCents(b), b.contract_revised_cents)).slice(0, 6);
  const marginFrac = ratio(margin, contract);
  const oldestCo = [...data.openCos].sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  const emptyState = { kind: 'empty' as const, title: `Figures appear with your first ${lower(v.job)}`, action: <ButtonLink href="/jobs?new=1">New {lower(v.job)}</ButtonLink> };

  return (
    <Dash flow="row">
      <Widget primary w={8} h={4} x={1} y={1} title={`${v.jobs} by stage`} meta={`${count(data.projects.length)} ${jobs} · in US dollars`} state={empty ? emptyState : undefined}>
        <StatementTable
          aria-label={`${v.jobs} by stage`}
          unitLabel="Stage"
          columns={STAGE_COLUMNS}
          rows={stageRows(data.projects, data.companyNames, data.multiCompany)}
          caption="Projected margin is revised contract less the cost estimate: the approved revised budget, else the original budget plus approved change-order cost. Totals tie."
        />
      </Widget>

      <Widget w={4} h={4} x={9} y={1} title="At a glance" meta={`${count(open.length)} open ${jobs}`} state={empty ? emptyState : undefined}>
        <ul className="glance">
          <li>
            <Link className="gl" href="/insights/backlog">
              <span className="fig-l">Contract, open {jobs}</span>
              <span className="fig-v--dense">{dollars(contract)}</span>
              <span className="fig-vs">
                <span>{dollars(original)} original</span>
                <span>{dollars(contract - original)} from approved {lower(v.change_orders)}</span>
              </span>
            </Link>
          </li>
          <li>
            <Link className="gl" href="/insights/margin">
              <span className="fig-l">Projected margin</span>
              <span className="fig-v--dense">{Number.isFinite(marginFrac) ? pct(marginFrac) : '—'}</span>
              <span className="fig-vs">
                <span>{dollars(margin)} on {dollars(contract)} of contract</span>
                {watch[0] ? <span>Lowest: {watch[0].job_number} at {marginPctText(watch[0])}</span> : null}
              </span>
            </Link>
          </li>
          <li>
            <Link className="gl" href="/review">
              <span className="fig-l">Pending change exposure</span>
              <span className="fig-v--dense">{dollars(pending)}</span>
              <span className="fig-vs">
                <span>{count(data.openCos.length)} open {lower(v.change_orders)}, not in contract yet</span>
                {oldestCo ? <span>Oldest {oldestCo.number} from {shortDate(oldestCo.created_at.slice(0, 10))}</span> : null}
              </span>
            </Link>
          </li>
          <li>
            <Link className="gl" href="/jobs">
              <span className="fig-l">Without a budget</span>
              <span className="fig-v--dense">{count(noBudget)}</span>
              <span className="fig-vs">
                <span>of {count(open.length)} open {jobs}</span>
              </span>
            </Link>
          </li>
        </ul>
      </Widget>

      <Widget
        w={8}
        h={4}
        x={1}
        y={5}
        title="Backlog"
        meta="Jobs started and not finished · in US dollars"
        state={active.length === 0 ? { kind: 'empty', title: `No ${lower(v.job)} is in progress`, body: `Backlog counts ${jobs} that have started and are not finished.` } : undefined}
      >
        <StatementTable
          aria-label="Backlog by job"
          unitLabel={v.job}
          columns={BACKLOG_COLUMNS}
          rows={backlogRows(active, data.companyNames, data.multiCompany)}
          caption="Contract value on jobs in progress. Earned revenue comes from Merit Books, so remaining backlog arrives with the Books seam."
        />
      </Widget>

      <Widget
        w={4}
        h={4}
        x={9}
        y={5}
        title="Margin watch"
        meta="Lowest projected margin first"
        state={withContract.length === 0 ? { kind: 'empty', title: 'Margin shows once a job has a contract' } : undefined}
        foot={<Link className="link" href="/insights/margin">Margin by job</Link>}
      >
        <ul className="glance">
          {watch.map((p) => (
            <li key={p.job_id}>
              <Link className="gl" href={`/jobs/${p.job_id}`}>
                <span className="l1" style={{ gridColumn: 1, gridRow: 1, alignSelf: 'center' }}>
                  {[p.job_number, p.name].filter(Boolean).join(' · ')}
                </span>
                <span className="fig-v--dense">{marginPctText(p)}</span>
                <span className="fig-vs">
                  <span>{dollars(marginCents(p))} on {dollars(p.contract_revised_cents)}</span>
                  {data.multiCompany ? <span>{data.companyNames[p.location_id]}</span> : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Widget>
    </Dash>
  );
}
