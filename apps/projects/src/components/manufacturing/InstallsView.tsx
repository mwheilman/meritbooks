'use client';

import { useState } from 'react';
import { Button, Field, Input, QueueTable, Status, type QueueColumn } from '@meritbooks/merit-ui';
import type { JobOption } from '@/lib/pm/ops/scope';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, JobSelect, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, day, useBoard, useDo } from '@/components/dealer/common/depth';

interface Install { install_id: string; job_id: string; job: string; job_name: string | null; crew_id: string | null; crew: string | null; starts_on: string; ends_on: string; site_ready_on: string | null; status: string; conflicts: Array<{ code: string; message?: string }> }

const CONFLICT_WORD: Record<string, string> = { CREW_OVERLAP: 'Crew booked elsewhere', PRODUCTION_NOT_READY: 'Shop work not finished in time', SITE_NOT_READY: 'Site not ready by the start' };

/** Cabinet / millwork installs: crews by date, with shop-completion and site-ready conflicts flagged. */
export function InstallsView({ companyId, today, jobs, crews }: { companyId: string; today: string; jobs: JobOption[]; crews: Array<{ id: string; name: string }> }) {
  const { readOnly } = useShell();
  const b = useBoard<{ from: string; to: string; installs: Install[] }>(`/api/mfg/installs?company=${companyId}`);
  const { run, busy, error } = useDo(b.reload);
  const [f, setF] = useState({ job: '', start: today, end: today, crew: '', site: '' });
  const cols: QueueColumn<Install>[] = [
    { id: 'j', header: 'Job', cell: (i) => <><span className="l1">{i.job}</span><span className="l2">{i.job_name ?? ''}</span></> },
    { id: 'd', header: 'Dates', width: 200, cell: (i) => `${day(i.starts_on, today)} – ${day(i.ends_on, today)}` },
    { id: 'c', header: 'Crew', width: 140, cell: (i) => i.crew ?? 'No crew' },
    { id: 's', header: 'Site ready', width: 120, cell: (i) => day(i.site_ready_on, today) },
    { id: 'x', header: 'Conflicts', width: 280, cell: (i) => (i.conflicts.length === 0 ? <Status kind="ready" pip="ready">Clear</Status> : <span className="neg">{i.conflicts.map((c) => c.message ?? CONFLICT_WORD[c.code] ?? c.code).join(' · ')}</span>) },
  ];
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      {!readOnly && (
        <Section title="Book an install">
          <div className="ops-toolbar">
            <Field label="Job"><JobSelect jobs={jobs} value={f.job} onChange={(job) => setF({ ...f, job })} /></Field>
            <Field label="Starts"><Input type="date" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></Field>
            <Field label="Ends"><Input type="date" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></Field>
            <Field label="Crew"><select className="select" value={f.crew} onChange={(e) => setF({ ...f, crew: e.target.value })}><option value="">No crew yet</option>{crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
            <Field label="Site ready"><Input type="date" value={f.site} onChange={(e) => setF({ ...f, site: e.target.value })} /></Field>
            <Button variant="primary" disabled={!f.job || f.end < f.start || busy === 'book'} onClick={() => void run('book', '/api/mfg/installs', { jobId: f.job, startsOn: f.start, endsOn: f.end, crewId: f.crew || null, siteReadyOn: f.site || null }, (r: { conflicts?: unknown[] }) => (r.conflicts && r.conflicts.length ? 'Booked, with conflicts to clear' : 'Booked the install'))}>Book</Button>
          </div>
        </Section>
      )}
      <Section title="Install board">
        <BoardState b={b} what="Installs" />
        {b.data && (b.data.installs.length === 0 ? <Empty title="No installs booked" body="Book installs here; each is checked against the shop's completion date, the site-ready date and the crew's other bookings." /> :
          <div className="mp-table"><QueueTable aria-label="Installs" columns={cols} rows={b.data.installs} getRowId={(i) => i.install_id} rowState={(i) => ({ attn: i.conflicts.length > 0 })} /></div>)}
      </Section>
    </div>
  );
}
