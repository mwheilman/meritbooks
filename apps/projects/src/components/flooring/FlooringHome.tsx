'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ButtonLink, ButtonRow, Field, Input, QueueTable, Status, count, type QueueColumn } from '@meritbooks/merit-ui';
import type { JobOption } from '@/lib/pm/ops/scope';
import { Section } from '@/components/ops/common/bits';
import { BoardState, Empty, day, qty, useBoard } from '@/components/dealer/common/depth';

interface Day { day: string; capacity_sf: number | null; capacity_jobs: number | null; booked_sf: number; booked_jobs: number; over: boolean }
interface Booking { booking_id: string; job_id: string; job: string; job_name: string | null; crew_id: string | null; crew: string | null; install_on: string; days: number; sf: number; status: string; overridden: boolean; ready: boolean }
interface Board { from: string; to: string; days: Day[]; bookings: Booking[] }

/** The flooring week: square feet booked per day against crew capacity, each job's readiness, and the jobs to work on. */
export function FlooringHome({ companyId, today, jobs }: { companyId: string; today: string; jobs: JobOption[] }) {
  const router = useRouter();
  const [from, setFrom] = useState(today);
  const to = new Date(Date.parse(`${from}T00:00:00Z`) + 13 * 86_400_000).toISOString().slice(0, 10);
  const b = useBoard<Board>(`/api/flooring/installs?company=${companyId}&from=${from}&to=${to}`);
  const [q, setQ] = useState('');
  const shown = jobs.filter((j) => j.open && (!q.trim() || `${j.label} ${j.customer ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())));
  const cols: QueueColumn<Booking>[] = [
    { id: 'd', header: 'Install', width: 140, cell: (x) => <><span className="l1">{day(x.install_on, today)}</span><span className="l2">{x.days} day{x.days === 1 ? '' : 's'}</span></> },
    { id: 'j', header: 'Job', cell: (x) => <><span className="l1">{x.job}</span><span className="l2">{x.job_name ?? ''}</span></> },
    { id: 'c', header: 'Crew', width: 140, cell: (x) => x.crew ?? 'Any crew' },
    { id: 's', header: 'Square feet', numeric: true, width: 120, cell: (x) => qty(x.sf) },
    { id: 'r', header: 'Ready', width: 170, cell: (x) => (x.ready ? <Status kind="ready" pip="ready">Ready</Status> : <Status kind={x.overridden ? 'risk' : 'blocked'} pip={x.overridden ? 'risk' : 'blocked'}>{x.overridden ? 'Booked over a gap' : 'Not ready'}</Status>) },
  ];
  const jcols: QueueColumn<JobOption>[] = [
    { id: 'j', header: 'Job', cell: (j) => <><span className="l1">{j.label}</span><span className="l2">{j.customer ?? ' '}</span></> },
  ];
  return (
    <div className="stack">
      <ButtonRow>
        <ButtonLink variant="quiet" href="/flooring/rolls">Rolls and remnants</ButtonLink>
        <ButtonLink variant="quiet" href="/flooring/pay">Installer pay</ButtonLink>
        <ButtonLink variant="quiet" href="/flooring/catalog">Products, labor and capacity</ButtonLink>
      </ButtonRow>
      <Section title="Install capacity" meta="Square feet booked vs the crews’ daily capacity" actions={<Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>}>
        <BoardState b={b} what="The install board" />
        {b.data && (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table className="ops-mini" aria-label="Capacity by day">
                <thead><tr><th>Day</th>{b.data.days.map((d) => <th key={d.day} className="n">{day(d.day, today)}</th>)}</tr></thead>
                <tbody>
                  <tr><td>Booked SF</td>{b.data.days.map((d) => <td key={d.day} className={`n${d.over ? ' neg b' : ''}`}>{qty(d.booked_sf)}</td>)}</tr>
                  <tr><td>Capacity SF</td>{b.data.days.map((d) => <td key={d.day} className="n">{d.capacity_sf == null ? '—' : qty(d.capacity_sf)}</td>)}</tr>
                  <tr><td>Jobs</td>{b.data.days.map((d) => <td key={d.day} className="n">{count(d.booked_jobs)}{d.capacity_jobs != null ? ` / ${d.capacity_jobs}` : ''}</td>)}</tr>
                </tbody>
              </table>
            </div>
            {b.data.bookings.length === 0 ? <Empty title="No installs booked in these two weeks" body="Book an install from the job: it checks readiness (deposit, material, lots, site checks) and the crew's square-foot capacity." /> :
              <div className="mp-table" style={{ marginTop: 12 }}><QueueTable aria-label="Bookings" columns={cols} rows={b.data.bookings} getRowId={(x) => x.booking_id} openOnClick onOpen={(x) => router.push(`/flooring/jobs/${x.job_id}`)} rowState={(x) => ({ attn: !x.ready })} /></div>}
          </>
        )}
      </Section>
      <Section title="Jobs" meta={`${count(shown.length)} open`} actions={<Input aria-label="Find a job" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a job" style={{ width: 220 }} />}>
        {shown.length === 0 ? <Empty title="No open jobs" body="Open a job, import its measure, and build the quote from it." /> :
          <div className="mp-table"><QueueTable aria-label="Flooring jobs" columns={jcols} rows={shown} getRowId={(j) => j.id} openOnClick onOpen={(j) => router.push(`/flooring/jobs/${j.id}`)} /></div>}
      </Section>
    </div>
  );
}
