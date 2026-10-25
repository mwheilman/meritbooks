'use client';

import { useState } from 'react';
import { Bands, Button, ButtonRow, ConfirmDialog, Field, Input, QueueTable, Select, Status, count, money, type QueueColumn } from '@meritbooks/merit-ui';
import type { JobOption } from '@/lib/pm/ops/scope';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, JobSelect, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, centsFrom, day, qty, useBoard, useDo } from '@/components/dealer/common/depth';

type St = 'OPEN' | 'APPROVED' | 'PAID' | 'VOID';
interface Ticket { id: string; job_id: string; number: string; worker_type: 'W2' | '1099'; employee_id: string | null; vendor_id: string | null; completed_on: string; split_pct: number; hours_worked: number | null; status: string; gross_cents: number | null; chargeback_cents: number | null; net_cents: number | null; posting: string | null }
interface Line { id: string; ticket_id: string; labor_code: string; description: string; unit: string; qty: number; rate_cents: number | null; amount_cents: number | null; measured_qty: number | null; over_measured: boolean }
interface Cb { id: string; job_id: string | null; worker_type: string; employee_id: string | null; vendor_id: string | null; reason: string; description: string; amount_cents: number | null; applied_cents: number | null; status: string }
interface Data { tickets: Ticket[]; lines: Line[]; chargebacks: Cb[] }

export interface Worker { id: string; name: string; type: 'W2' | '1099' }

/** Installer pay: piece-rate tickets from a completion (splits, minimums, over-measure flags, chargebacks netted), approved by someone else. */
export function PayView({ companyId, today, jobs, workers }: { companyId: string; today: string; jobs: JobOption[]; workers: Worker[] }) {
  const { readOnly } = useShell();
  const [st, setSt] = useState<St>('OPEN');
  const b = useBoard<Data>(`/api/flooring/pay?company=${companyId}&status=${st}`);
  const { run, busy, error } = useDo(b.reload);
  const [c, setC] = useState({ job: '', on: today, lines: [{ code: '', qty: '' }], splits: [{ worker: '', pct: '100' }] });
  const [cb, setCb] = useState({ worker: '', reason: 'CALLBACK', desc: '', amount: '', job: '' });
  const [voiding, setVoiding] = useState<Ticket | null>(null);
  const wname = (t: { employee_id: string | null; vendor_id: string | null }) => workers.find((w) => w.id === (t.employee_id ?? t.vendor_id))?.name ?? 'Installer';
  const jname = (id: string | null) => jobs.find((j) => j.id === id)?.label ?? 'Job';

  const cols: QueueColumn<Ticket>[] = [
    { id: 't', header: 'Ticket', cell: (t) => <><span className="l1">{t.number} · {wname(t)}</span><span className="l2">{jname(t.job_id)} · {day(t.completed_on, today)} · {t.worker_type === 'W2' ? 'W-2 (payroll)' : '1099 (payable)'}{t.split_pct < 1 ? ` · ${Math.round(t.split_pct * 100)}% split` : ''}</span></> },
    { id: 'g', header: 'Gross', numeric: true, width: 110, cell: (t) => (t.gross_cents == null ? '—' : money(t.gross_cents)) },
    { id: 'c', header: 'Chargebacks', numeric: true, width: 120, cell: (t) => (t.chargeback_cents ? <span className="neg">{money(-t.chargeback_cents)}</span> : '—') },
    { id: 'n', header: 'Net', numeric: true, width: 110, cell: (t) => (t.net_cents == null ? '—' : <b>{money(t.net_cents)}</b>) },
    { id: 's', header: 'Status', width: 130, cell: (t) => <Status kind={t.status === 'APPROVED' || t.status === 'PAID' ? 'ready' : t.status === 'VOID' ? 'blocked' : 'track'} pip="open">{t.status.toLowerCase()}</Status> },
    ...(readOnly ? [] : [{ id: 'a', header: <span className="sr">Next</span>, width: 220, cell: (t: Ticket) => (
      <ButtonRow>
        {t.status === 'DRAFT' && <Button disabled={busy === t.id} onClick={() => void run(t.id, '/api/flooring/pay', { op: 'finalize', ticketId: t.id }, `Finalized ${t.number}`)}>Finalize</Button>}
        {t.status === 'FINALIZED' && <Button variant="primary" disabled={busy === t.id} onClick={() => void run(t.id, '/api/flooring/pay', { op: 'approve', ticketId: t.id }, (r: { posting?: string }) => (r.posting === 'PAYABLE_HELD' ? `Approved ${t.number}; held for Merit Books payables` : `Approved ${t.number}; on the time sheet for payroll`))}>Approve</Button>}
        {(t.status === 'DRAFT' || t.status === 'FINALIZED') && <Button variant="quiet" onClick={() => setVoiding(t)}>Void</Button>}
      </ButtonRow>
    ) } satisfies QueueColumn<Ticket>]),
  ];

  const submit = async () => {
    const lines = c.lines.filter((l) => l.code.trim() && Number(l.qty) > 0).map((l) => ({ labor_code: l.code.trim().toUpperCase(), qty: Number(l.qty) }));
    const splits = c.splits.filter((s) => s.worker).map((s) => { const w = workers.find((x) => x.id === s.worker)!; return { worker_type: w.type, employee_id: w.type === 'W2' ? w.id : null, vendor_id: w.type === '1099' ? w.id : null, pct: Number(s.pct) / 100 }; });
    if (await run('comp', '/api/flooring/pay', { op: 'from_completion', jobId: c.job, completedOn: c.on, lines, splits }, (r: { tickets: unknown[] }) => `Made ${r.tickets.length} pay ticket${r.tickets.length === 1 ? '' : 's'}`)) setC({ ...c, lines: [{ code: '', qty: '' }] });
  };
  const splitSum = c.splits.reduce((s, x) => s + (Number(x.pct) || 0), 0);

  return (
    <div className="stack">
      {error && <Failure text={error} />}
      {!readOnly && (
        <Section title="Pay a completed install" meta="Quantities by labor code; splits between installers add up to 100%">
          <div className="ops-toolbar">
            <Field label="Job"><JobSelect jobs={jobs} value={c.job} onChange={(job) => setC({ ...c, job })} /></Field>
            <Field label="Completed"><Input type="date" value={c.on} onChange={(e) => setC({ ...c, on: e.target.value })} /></Field>
          </div>
          {c.lines.map((l, i) => (
            <div key={`l${i}`} className="ops-toolbar">
              <Field label="Labor code"><Input value={l.code} onChange={(e) => setC({ ...c, lines: c.lines.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)) })} style={{ width: 140 }} /></Field>
              <Field label="Qty"><Input inputMode="decimal" value={l.qty} onChange={(e) => setC({ ...c, lines: c.lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)) })} style={{ width: 90 }} /></Field>
            </div>
          ))}
          <Button variant="quiet" onClick={() => setC({ ...c, lines: [...c.lines, { code: '', qty: '' }] })}>Add a labor line</Button>
          {c.splits.map((s, i) => (
            <div key={`s${i}`} className="ops-toolbar">
              <Field label="Installer"><Select value={s.worker} onChange={(e) => setC({ ...c, splits: c.splits.map((x, j) => (j === i ? { ...x, worker: e.target.value } : x)) })}><option value="">Pick an installer</option>{workers.map((w) => <option key={w.id} value={w.id}>{w.name} · {w.type === 'W2' ? 'W-2' : '1099'}</option>)}</Select></Field>
              <Field label="Share %"><Input inputMode="decimal" value={s.pct} onChange={(e) => setC({ ...c, splits: c.splits.map((x, j) => (j === i ? { ...x, pct: e.target.value } : x)) })} style={{ width: 80 }} /></Field>
            </div>
          ))}
          <ButtonRow>
            <Button variant="quiet" onClick={() => setC({ ...c, splits: [...c.splits, { worker: '', pct: '0' }] })}>Split with another installer</Button>
            <Button variant="primary" disabled={!c.job || Math.abs(splitSum - 100) > 0.001 || busy === 'comp'} onClick={() => void submit()}>Make pay tickets</Button>
            {Math.abs(splitSum - 100) > 0.001 && <span className="t-cap neg">Shares add up to {qty(splitSum)}%.</span>}
          </ButtonRow>
        </Section>
      )}
      <Bands<St> aria-label="Pay tickets" value={st} onChange={setSt} items={[{ value: 'OPEN', label: 'To approve', count: '' }, { value: 'APPROVED', label: 'Approved', count: '' }, { value: 'PAID', label: 'Paid', count: '' }, { value: 'VOID', label: 'Void', count: '' }]} />
      <BoardState b={b} what="Pay tickets" />
      {b.data && (b.data.tickets.length === 0 ? <Empty title="No pay tickets here" body="Make tickets from a completed install; each installer gets one at their piece rate and share." /> : (
        <>
          <div className="mp-table"><QueueTable aria-label="Pay tickets" columns={cols} rows={b.data.tickets} getRowId={(t) => t.id} rowState={(t) => ({ attn: b.data!.lines.some((l) => l.ticket_id === t.id && l.over_measured) })} /></div>
          {b.data.lines.some((l) => l.over_measured) && <p className="t-cap neg">Some tallies are above the measured quantity: check them before approving.</p>}
        </>
      ))}
      <Section title="Chargebacks" meta="Proposed, acknowledged by the installer, then taken off the next ticket">
        {b.data && b.data.chargebacks.length > 0 && (
          <table className="ops-mini" aria-label="Chargebacks">
            <thead><tr><th>Installer</th><th>Why</th><th className="n">Amount</th><th>Status</th><th /></tr></thead>
            <tbody>{b.data.chargebacks.map((x) => <tr key={x.id}><td>{wname(x)}</td><td>{x.reason.toLowerCase().replace(/_/g, ' ')} · {x.description}</td><td className="n">{x.amount_cents == null ? '—' : money(x.amount_cents)}</td><td>{x.status.toLowerCase()}</td>
              <td>{!readOnly && x.status === 'PROPOSED' && <ButtonRow><Button disabled={busy === x.id} onClick={() => void run(x.id, '/api/flooring/pay', { op: 'acknowledge_chargeback', chargebackId: x.id, name: wname(x) }, 'Acknowledged')}>Acknowledged</Button><Button variant="quiet" disabled={busy === x.id} onClick={() => void run(x.id, '/api/flooring/pay', { op: 'acknowledge_chargeback', chargebackId: x.id, waive: true }, 'Waived')}>Waive</Button></ButtonRow>}</td></tr>)}</tbody>
          </table>
        )}
        {!readOnly && (
          <div className="ops-toolbar" style={{ marginTop: 8 }}>
            <Field label="Installer"><Select value={cb.worker} onChange={(e) => setCb({ ...cb, worker: e.target.value })}><option value="">Pick</option>{workers.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></Field>
            <Field label="Why"><Select value={cb.reason} onChange={(e) => setCb({ ...cb, reason: e.target.value })}>{['CALLBACK', 'DAMAGE', 'MATERIAL_OVERUSE', 'NO_SHOW', 'OTHER'].map((r) => <option key={r} value={r}>{r.toLowerCase().replace(/_/g, ' ')}</option>)}</Select></Field>
            <Field label="What happened"><Input value={cb.desc} onChange={(e) => setCb({ ...cb, desc: e.target.value })} style={{ width: 220 }} /></Field>
            <Field label="Amount"><Input inputMode="decimal" value={cb.amount} onChange={(e) => setCb({ ...cb, amount: e.target.value })} style={{ width: 100 }} /></Field>
            <Field label="Job"><JobSelect jobs={jobs} value={cb.job} onChange={(job) => setCb({ ...cb, job })} placeholder="No job" /></Field>
            <Button disabled={!cb.worker || !cb.desc.trim() || !(centsFrom(cb.amount) ?? 0) || busy === 'cb'} onClick={async () => {
              const w = workers.find((x) => x.id === cb.worker)!;
              if (await run('cb', '/api/flooring/pay', { op: 'propose_chargeback', companyId, workerType: w.type, workerId: w.id, reason: cb.reason, description: cb.desc.trim(), amountCents: centsFrom(cb.amount), jobId: cb.job || null }, 'Proposed the chargeback')) setCb({ worker: '', reason: 'CALLBACK', desc: '', amount: '', job: '' });
            }}>Propose</Button>
          </div>
        )}
      </Section>
      <ConfirmDialog open={voiding !== null} title={`Void ${voiding?.number ?? ''}?`} confirmLabel="Void ticket" tone="danger" reason={{ label: 'Why', minLength: 3 }} onClose={() => setVoiding(null)}
        onConfirm={async (reason) => { const t = voiding; setVoiding(null); if (t) await run(t.id, '/api/flooring/pay', { op: 'void', ticketId: t.id, reason: reason ?? 'Voided' }, `Voided ${t.number}`); }}>
        The ticket stops counting toward the installer's pay; the reason is kept on it.
      </ConfirmDialog>
    </div>
  );
}
