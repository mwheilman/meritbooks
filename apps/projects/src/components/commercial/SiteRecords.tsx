'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Check, Drawer, Field, Input, Seg, Tag, Textarea, WidgetState, count } from '@meritbooks/merit-ui';
import { DAILY_LOG_STATUS, TM_STATUS } from '@/lib/commercial/labels';
import type { JobOption } from '@/lib/pm/ops/scope';
import { useCan, useMoneyVis, useShell } from '@/components/shell/ShellContext';
import { JobSelect } from '@/components/ops/common/bits';
import { useOps } from '@/components/ops/common/useOps';
import { Actions, Failure, Mk, cm, day } from './common';

export interface SiteLogRef { id: string; job_id: string; log_date: string; status: string; signed_by_name: string | null; amended_count: number }
export interface TmTicketRef { id: string; job_id: string; number: string; work_date: string; description: string; status: string; signer_name: string | null; signed_at: string | null; disputed_reason: string | null; change_event_id: string | null; billed_request_id: string | null }

type Act = ReturnType<typeof useOps>['act'];

/**
 * The structured site record beside the quick field logs: open the day's daily log (one per job
 * per day, CGC-70), and T&M tickets the GC signs on the device before they are billed (CGC-94).
 */
export function SiteRecords({ logs, tickets, jobs, today, initialTab, initialItem }: { logs: SiteLogRef[]; tickets: TmTicketRef[]; jobs: JobOption[]; today: string; initialTab?: 'logs' | 'tm'; initialItem?: string | null }) {
  const router = useRouter();
  const { readOnly } = useShell();
  const { act, busy, error } = useOps();
  const [tab, setTab] = useState<'logs' | 'tm'>(initialTab ?? 'logs');
  const [jobId, setJobId] = useState('');
  const [date, setDate] = useState(today);
  const label = (id: string) => jobs.find((j) => j.id === id)?.label ?? 'Job';
  return (
    <section className="sec" aria-label="Site records">
      <div className="sec-h" style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <h2 className="t-section">Site records</h2><span style={{ flex: 1 }} />
        <Seg aria-label="Site records" value={tab} onChange={setTab} items={[{ value: 'logs', label: 'Daily logs', count: logs.length }, { value: 'tm', label: 'T&M tickets', count: tickets.filter((t) => t.status === 'SUBMITTED').length || undefined }]} />
      </div>
      <Failure text={error} />
      {tab === 'logs' && (
        <div className="stack" style={{ gap: 12 }}>
          {!readOnly && (
            <div className="ops-toolbar">
              <Field label="Job"><JobSelect jobs={jobs.filter((j) => j.open)} value={jobId} onChange={setJobId} /></Field>
              <Field label="Day"><Input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} /></Field>
              <Button variant="primary" disabled={!jobId || busy !== null} onClick={async () => {
                const r = await act<{ id: string }>('open', 'post', '/api/commercial/daily-logs', { jobId, logDate: date, copyForward: true }, '');
                if (r) router.push(`/daily-logs/${r.id}`);
              }}>{busy === 'open' ? 'Opening…' : 'Open the day’s log'}</Button>
              <span className="t-cap">Yesterday’s crews and equipment carry forward.</span>
            </div>
          )}
          {logs.length === 0 ? <WidgetState state={{ kind: 'empty', title: 'No structured logs yet', body: 'The structured log records manpower by company, delays with their cause, deliveries and inspections, and locks when the superintendent signs it.' }} /> : (
            <div className="mp-table">
              <table className="tbl tbl-q tbl-q--compact">
                <thead><tr><th style={{ width: 120 }}>Day</th><th>Job</th><th style={{ width: 130 }}>Status</th><th>Signed</th></tr></thead>
                <tbody>{logs.map((l) => (
                  <tr key={l.id} className="q-row" onClick={() => router.push(`/daily-logs/${l.id}`)} style={{ cursor: 'pointer' }}>
                    <td><Link className="nlink" href={`/daily-logs/${l.id}`}>{l.log_date === today ? 'Today' : day(l.log_date, today)}</Link></td>
                    <td>{label(l.job_id)}</td><td><Mk map={DAILY_LOG_STATUS} status={l.status} /></td>
                    <td>{l.signed_by_name ?? '—'}{l.amended_count > 0 && <span className="ops-sub" style={{ display: 'block' }}>{count(l.amended_count)} amended</span>}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {tab === 'tm' && <Tickets tickets={tickets} jobs={jobs} label={label} today={today} readOnly={readOnly} busy={busy} act={act} initialItem={initialItem ?? null} />}
    </section>
  );
}

function Tickets({ tickets, jobs, label, today, readOnly, busy, act, initialItem }: { tickets: TmTicketRef[]; jobs: JobOption[]; label: (id: string) => string; today: string; readOnly: boolean; busy: string | null; act: Act; initialItem: string | null }) {
  const vis = useMoneyVis();
  const canBill = useCan('projects.billing:create') && vis.contract;
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [signing, setSigning] = useState<TmTicketRef | null>(() => tickets.find((t) => t.id === initialItem && t.status === 'SUBMITTED') ?? null);
  const pickedJob = tickets.find((t) => picked.has(t.id))?.job_id ?? null;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="ops-toolbar">
        <span className="sp" />
        {!readOnly && canBill && picked.size > 0 && <Button variant="primary" disabled={busy !== null} onClick={async () => {
          const r = await act('bill', 'post', '/api/commercial/tm/bill', { jobId: pickedJob, ticketIds: [...picked], occurredOn: null }, `Billed ${count(picked.size)} tickets at the rate sheet`);
          if (r) setPicked(new Set());
        }}>Bill {count(picked.size)} signed</Button>}
        {!readOnly && <Button icon="plus" onClick={() => setAdding((v) => !v)}>New T&amp;M ticket</Button>}
      </div>
      {adding && !readOnly && <NewTicket jobs={jobs.filter((j) => j.open)} today={today} busy={busy === 'tm'} onSave={async (b) => { const r = await act<{ number: string }>('tm', 'post', '/api/commercial/tm', b, (d) => `Wrote ${d.number}`); if (r) setAdding(false); return !!r; }} />}
      {tickets.length === 0 ? <WidgetState state={{ kind: 'empty', title: 'No T&M tickets', body: 'Write the ticket the day the extra work happens: who, how many hours, what material. The GC signs it on the device; signed tickets bill at the contract rate sheet.' }} /> : (
        <div className="mp-table">
          <table className="tbl tbl-q tbl-q--compact">
            <thead><tr>{!readOnly && canBill && <th style={{ width: 36 }}><span className="sr-only">Pick</span></th>}<th style={{ width: 90 }}>Ticket</th><th style={{ width: 100 }}>Date</th><th>Work</th><th style={{ width: 120 }}>Status</th><th style={{ width: 260 }} /></tr></thead>
            <tbody>{tickets.map((t) => {
              const url = `/api/commercial/tm/${t.id}`;
              return (
                <tr key={t.id} className="q-row">
                  {!readOnly && canBill && <td><Check aria-label={`Pick ${t.number}`} disabled={t.status !== 'SIGNED' || (!!pickedJob && pickedJob !== t.job_id)} checked={picked.has(t.id)} onChange={(e) => { const n = new Set(picked); if (e.target.checked) n.add(t.id); else n.delete(t.id); setPicked(n); }} /></td>}
                  <td><span className="code">{t.number}</span></td><td>{day(t.work_date, today)}</td>
                  <td>{t.description}<span className="ops-sub" style={{ display: 'block' }}>{label(t.job_id)}{t.signer_name ? ` · signed by ${t.signer_name}` : ''}</span>{t.disputed_reason && <span className="ops-sub" style={{ display: 'block' }}>Disputed: {t.disputed_reason}</span>}</td>
                  <td><Mk map={TM_STATUS} status={t.status} /></td>
                  <td>{!readOnly && <Actions busy={busy} items={[
                    { key: `pull${t.id}`, label: 'Pull crew hours', onClick: () => void act<{ added: number }>(`pull${t.id}`, 'post', url, { op: 'pull_hours' }, (r) => r.added ? `Added ${r.added} lines from the timecards` : 'No new hours on the timecards'), hidden: t.status !== 'DRAFT' },
                    { key: `sub${t.id}`, label: 'For signature', primary: true, onClick: () => void act(`sub${t.id}`, 'post', url, { op: 'submit' }, 'Ready for the GC’s signature'), hidden: t.status !== 'DRAFT' },
                    { key: `sign${t.id}`, label: 'GC signs', primary: true, onClick: () => setSigning(t), hidden: t.status !== 'SUBMITTED' },
                    { key: `ce${t.id}`, label: 'Change event', onClick: () => void act(`ce${t.id}`, 'post', url, { op: 'to_change_event' }, 'Opened a change event for this work'), hidden: !!t.change_event_id || t.status === 'VOID' },
                  ]} />}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
      <Drawer open={!!signing} onClose={() => setSigning(null)} width={480} title={signing ? `Sign ${signing.number}` : ''} eyebrow={signing ? label(signing.job_id) : undefined}>
        {signing && <SignTicket t={signing} busy={busy} act={act} onDone={() => setSigning(null)} />}
      </Drawer>
    </div>
  );
}

function NewTicket({ jobs, today, busy, onSave }: { jobs: JobOption[]; today: string; busy: boolean; onSave: (b: Record<string, unknown>) => Promise<boolean> }) {
  const vis = useMoneyVis();
  const [jobId, setJobId] = useState('');
  const [date, setDate] = useState(today);
  const [desc, setDesc] = useState('');
  const [ref, setRef] = useState('');
  const [workers, setWorkers] = useState('');
  const [st, setSt] = useState('');
  const [ot, setOt] = useState('');
  const [mat, setMat] = useState('');
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <form className="mp-table mp-add" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 12 }} onSubmit={(e) => {
      e.preventDefault();
      if (!jobId) return setErr('Pick the job.');
      if (!desc.trim()) return setErr('Describe the extra work.');
      const lines: Array<Record<string, unknown>> = [];
      const n = Math.max(1, Number(workers) || 1);
      if (Number(st) > 0 || Number(ot) > 0) for (let i = 0; i < n; i++) lines.push({ kind: 'LABOR', labor_class: 'default', hours_st: Number(st) || 0, hours_ot: Number(ot) || 0, hours_dt: 0, description: '' });
      if (mat.trim()) lines.push({ kind: 'MATERIAL', description: mat.trim(), qty: Number(qty) || null, hours_st: 0, hours_ot: 0, hours_dt: 0, unit_cost_cents: vis.cost && unit.trim() ? Math.round(Number(unit) * 100) : null });
      setErr(null);
      void onSave({ jobId, workDate: date, description: desc.trim(), gcReference: ref.trim() || null, area: null, changeEventId: null, lines });
    }}>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Job" error={err ?? undefined}><JobSelect jobs={jobs} value={jobId} onChange={setJobId} /></Field>
        <Field label="Date"><Input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="GC reference"><Input value={ref} onChange={(e) => setRef(e.target.value)} maxLength={60} placeholder="Directive or super’s name" style={{ width: 180 }} /></Field>
      </div>
      <Field label="Extra work"><Textarea value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={4000} placeholder="Relocate panel L2-B per GC super; not on the drawings." /></Field>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Workers"><Input inputMode="numeric" value={workers} onChange={(e) => setWorkers(e.target.value)} style={{ width: 70 }} /></Field>
        <Field label="Regular hours each"><Input inputMode="decimal" value={st} onChange={(e) => setSt(e.target.value)} style={{ width: 90 }} /></Field>
        <Field label="Overtime each"><Input inputMode="decimal" value={ot} onChange={(e) => setOt(e.target.value)} style={{ width: 90 }} /></Field>
        <Field label="Material"><Input value={mat} onChange={(e) => setMat(e.target.value)} maxLength={200} placeholder="#12 THHN" style={{ width: 160 }} /></Field>
        <Field label="Qty"><Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} style={{ width: 70 }} /></Field>
        {vis.cost && <Field label="Unit cost ($)"><Input inputMode="decimal" value={unit} onChange={(e) => setUnit(e.target.value)} style={{ width: 90 }} /></Field>}
      </div>
      <div><Button type="submit" variant="primary" disabled={busy}>{busy ? 'Saving…' : 'Write ticket'}</Button></div>
    </form>
  );
}

/** Signature on the device: a square canvas, pointer events, saved as PNG. */
function SignTicket({ t, busy, act, onDone }: { t: TmTicketRef; busy: string | null; act: Act; onDone: () => void }) {
  const vis = useMoneyVis();
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [inked, setInked] = useState(false);
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [company, setCompany] = useState('');
  const [reason, setReason] = useState('');
  const [price, setPrice] = useState<number | null>(null);
  useEffect(() => {
    if (!vis.contract) return;
    void fetch(`/api/commercial/tm/${t.id}`).then((r) => (r.ok ? r.json() : null)).then((d: { total_cents?: number } | null) => setPrice(d?.total_cents ?? null)).catch(() => setPrice(null));
  }, [t.id, vis.contract]);
  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * e.currentTarget.width) / r.width, y: ((e.clientY - r.top) * e.currentTarget.height) / r.height };
  };
  return (
    <div className="stack" style={{ gap: 12 }}>
      <p>{t.description}</p>
      {price != null && <p className="t-cap">Priced at the rate sheet: <b>{cm(price)}</b></p>}
      <Field label="Signed by"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
      <div className="row" style={{ gap: 8 }}>
        <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="Superintendent" /></Field>
        <Field label="Company"><Input value={company} onChange={(e) => setCompany(e.target.value)} maxLength={120} /></Field>
      </div>
      <div>
        <span className="field-label">Signature</span>
        <canvas ref={ref} width={420} height={140} aria-label="Sign here" style={{ width: '100%', height: 140, border: '1px solid var(--line)', background: 'var(--white)', touchAction: 'none', display: 'block' }}
          onPointerDown={(e) => { drawing.current = true; const c = e.currentTarget.getContext('2d'); const p = pos(e); c?.beginPath(); c?.moveTo(p.x, p.y); e.currentTarget.setPointerCapture(e.pointerId); }}
          onPointerMove={(e) => { if (!drawing.current) return; const c = e.currentTarget.getContext('2d'); if (!c) return; const p = pos(e); c.lineWidth = 2; c.strokeStyle = '#0A1628'; c.lineTo(p.x, p.y); c.stroke(); setInked(true); }}
          onPointerUp={() => { drawing.current = false; }} />
        <div className="row" style={{ gap: 8, marginTop: 4 }}><Button variant="quiet" onClick={() => { const c = ref.current; c?.getContext('2d')?.clearRect(0, 0, c.width, c.height); setInked(false); }}>Clear</Button></div>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <Button variant="primary" disabled={!name.trim() || !inked || busy !== null} onClick={async () => {
          const png = ref.current?.toDataURL('image/png') ?? null;
          const r = await act('sign', 'post', `/api/commercial/tm/${t.id}`, { op: 'sign', signerName: name.trim(), signerTitle: title.trim() || null, signerCompany: company.trim() || null, signaturePng: png, method: 'DEVICE' }, 'Signed; the ticket is locked');
          if (r) onDone();
        }}>{busy === 'sign' ? 'Saving…' : 'Sign'}</Button>
      </div>
      <Field label="Or the GC disputes it"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} placeholder="What is disputed" /></Field>
      <div><Button disabled={!reason.trim() || busy !== null} onClick={async () => { const r = await act('dispute', 'post', `/api/commercial/tm/${t.id}`, { op: 'dispute', reason: reason.trim() }, 'Recorded the dispute'); if (r) onDone(); }}>Record dispute</Button></div>
      {t.status === 'SUBMITTED' && <Tag>Waiting for signature</Tag>}
    </div>
  );
}
