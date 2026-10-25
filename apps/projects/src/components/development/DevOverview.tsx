'use client';

import { useRouter } from 'next/navigation';
import { Figure, QueueTable, Status, count, money, type QueueColumn } from '@meritbooks/merit-ui';
import { Section } from '@/components/ops/common/bits';
import { BoardState, Empty, day, qty, useBoard } from '@/components/dealer/common/depth';

interface Proj { job_id: string; job_number: string; name: string; stage: string | null; spe_name: string | null; revised_cents: number | null; ecac_cents: number | null; variance_cents: number | null; paid_cents: number | null; contingency_remaining_cents: number | null; in_balance: boolean | null; gap_cents: number | null; interest_reserve_months: number | null; draws_in_flight: number; key_dates: Array<{ kind: string; label: string | null; due_on: string }> }
interface Data { projects: Proj[]; capital_needs: Record<string, { uses_cents: number; equity_cents: number; loan_cents: number }> }

/** Every development project the caller reaches: in balance or not, contingency left, dates due, and capital needed by month. */
export function DevOverview({ companyId, today }: { companyId: string | null; today: string }) {
  const router = useRouter();
  const b = useBoard<Data>(`/api/development${companyId ? `?company=${companyId}` : ''}`);
  const state = <BoardState b={b} what="Development projects" />;
  if (!b.data) return state;
  const d = b.data;
  const out = d.projects.filter((p) => p.in_balance === false);
  const soon = d.projects.flatMap((p) => p.key_dates.map((k) => ({ ...k, job: p.job_number, job_id: p.job_id }))).sort((a, c) => a.due_on.localeCompare(c.due_on));
  const months = Object.keys(d.capital_needs).sort();
  const cols: QueueColumn<Proj>[] = [
    { id: 'p', header: 'Project', cell: (p) => <><span className="l1">{p.job_number} · {p.name}</span><span className="l2">{p.spe_name ?? 'No SPE yet'} · {(p.stage ?? 'pursuit').toLowerCase().replace(/_/g, ' ')}</span></> },
    { id: 'b', header: 'Budget', numeric: true, width: 130, cell: (p) => (p.revised_cents == null ? '—' : money(p.revised_cents, { decimals: 0 })) },
    { id: 'e', header: 'Cost at completion', numeric: true, width: 150, cell: (p) => (p.ecac_cents == null ? '—' : money(p.ecac_cents, { decimals: 0 })) },
    { id: 'c', header: 'Contingency left', numeric: true, width: 140, cell: (p) => (p.contingency_remaining_cents == null ? '—' : money(p.contingency_remaining_cents, { decimals: 0 })) },
    { id: 'i', header: 'In balance', width: 170, cell: (p) => (p.in_balance == null ? <span className="l2">No sources yet</span> : p.in_balance ? <Status kind="ready" pip="ready">In balance</Status> : <Status kind="blocked" pip="blocked">Short {money(p.gap_cents ?? 0, { decimals: 0 })}</Status>) },
    { id: 'r', header: 'Interest reserve', numeric: true, width: 130, cell: (p) => (p.interest_reserve_months == null ? '—' : `${qty(p.interest_reserve_months)} mo`) },
    { id: 'd', header: 'Draws open', numeric: true, width: 100, cell: (p) => count(p.draws_in_flight) },
  ];
  return (
    <div className="stack">
      <div className="dl-strip">
        <Figure dense label="Projects" value={count(d.projects.length)} vs={[`${count(out.length)} out of balance`, `${count(d.projects.reduce((s, p) => s + p.draws_in_flight, 0))} draws open`]} href="/development" linkLabel="Projects" />
        <Figure dense label="Dates due in 90 days" value={count(soon.length)} vs={[soon[0] ? `next: ${soon[0].label ?? soon[0].kind.toLowerCase().replace(/_/g, ' ')} ${day(soon[0].due_on, today)}` : 'none', 'rate locks, closings, maturities']} href={soon[0] ? `/development/${soon[0].job_id}` : '/development'} linkLabel="Next date" />
      </div>
      <Section title="Projects">
        {d.projects.length === 0 ? <Empty title="No development projects you can see" body="A development project is a job with its pro forma, sources and lender budget. Projects show here for people who hold job financials on them." /> :
          <div className="mp-table"><QueueTable aria-label="Development projects" columns={cols} rows={d.projects} getRowId={(p) => p.job_id} openOnClick onOpen={(p) => router.push(`/development/${p.job_id}`)} rowState={(p) => ({ attn: p.in_balance === false })} /></div>}
      </Section>
      {months.length > 0 && (
        <Section title="Capital needs by month" meta="From each project's capital plan">
          <table className="ops-mini" aria-label="Capital needs">
            <thead><tr><th>Month</th><th className="n">Uses</th><th className="n">Equity</th><th className="n">Loan</th></tr></thead>
            <tbody>{months.map((m) => <tr key={m}><td>{m}</td><td className="n">{money(d.capital_needs[m]!.uses_cents, { decimals: 0 })}</td><td className="n">{money(d.capital_needs[m]!.equity_cents, { decimals: 0 })}</td><td className="n">{money(d.capital_needs[m]!.loan_cents, { decimals: 0 })}</td></tr>)}</tbody>
          </table>
        </Section>
      )}
      {soon.length > 0 && (
        <Section title="Dates due">
          <ul className="ops-agenda">{soon.slice(0, 30).map((k, i) => <li key={`${k.job_id}${i}`}><span className="d">{day(k.due_on, today)}</span><span>{k.label ?? k.kind.toLowerCase().replace(/_/g, ' ')} · {k.job}</span></li>)}</ul>
        </Section>
      )}
    </div>
  );
}
