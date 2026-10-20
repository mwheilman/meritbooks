'use client';

import { useState } from 'react';
import {
  Button, Check, ConfirmDialog, Field, Input, InlineNotice, KV, MoneyInput, Tag, money, shortDate,
} from '@meritbooks/merit-ui';
import type { AllowanceRow, MilestoneTaskRow, MilestoneWbsRow } from '@/lib/pm/money/types';
import { progressPreview, roundMul } from '@/lib/pm/money/aia';
import { useAction } from '@/components/job/useAction';
import { m, p, parsePct, pctInput } from './common';

interface Base {
  jobId: string;
  today: string;
  onDrafted: (id: string) => void;
}

const url = (jobId: string) => `/api/jobs/${jobId}/billing`;

// ---------------------------------------------------------------------------
// Progress %
// ---------------------------------------------------------------------------

export function ProgressForm({ jobId, today, onDrafted, revisedContractCents, billedToDateCents, heldToDateCents, rate, contractPct, hasDraft }: Base & {
  revisedContractCents: number; billedToDateCents: number; heldToDateCents: number; rate: number; contractPct: number | null; hasDraft: boolean;
}) {
  const { run, busy } = useAction();
  const [text, setText] = useState(pctInput(contractPct));
  const [asOf, setAsOf] = useState(today);
  const [err, setErr] = useState<string | null>(null);
  const f = text.trim() ? parsePct(text) : null;
  const pv = f != null ? progressPreview({ revisedContractCents, pct: f, billedToDateCents, rate, heldToDateCents }) : null;

  const submit = async () => {
    if (f == null) return setErr('Enter percent complete, 0 to 100.');
    if (pv?.nothing) return setErr(`Nothing to bill: ${p(f)} of the contract is ${money(pv.earnedToDate)}, and ${money(billedToDateCents)} is already billed.`);
    setErr(null);
    const r = await run<{ requestId: string }>('progress', 'post', url(jobId), { mode: 'progress', pct: f, asOf }, `Drafted progress billing to ${p(f)}`, { quietError: true });
    if (r.error) setErr(r.error.error);
    else if (r.data) onDrafted(r.data.requestId);
  };

  return (
    <form className="grid-12" style={{ alignItems: 'start', rowGap: 16 }} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div style={{ gridColumn: 'span 5' }} className="mp-form">
        <div className="mp-form-2">
          <Field label="Percent complete to date" help={contractPct != null ? `Contract tab says ${p(contractPct)}` : 'Or set it on the Contract tab'} error={err ?? undefined}>
            <Input inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} placeholder="0" />
          </Field>
          <Field label="Through"><Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
        </div>
        {hasDraft && <InlineNotice tone="warn" title="A progress draft is open.">Approve or void it below before drafting another.</InlineNotice>}
        <div className="btn-row"><Button type="submit" variant="primary" disabled={busy === 'progress' || hasDraft}>Draft progress billing</Button></div>
      </div>
      <div style={{ gridColumn: 'span 7' }}>
        <KV items={[
          { term: 'Revised contract', value: m(revisedContractCents) },
          { term: `Earned to date${f != null ? ` at ${p(f)}` : ''}`, value: pv ? m(pv.earnedToDate) : '—' },
          { term: 'Less billed to date', value: m(billedToDateCents) },
          { term: 'This bill', value: pv ? m(pv.thisBill) : '—' },
          { term: `Retainage held${rate ? ` at ${p(rate)}` : ''}`, value: pv ? m(pv.retainageThisPeriod) : '—' },
          { term: 'Due on this bill', value: pv ? <b>{m(pv.net)}</b> : '—' },
        ]} />
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

export function MilestoneForm({ jobId, today, onDrafted, tasks, wbs, billedIds, revisedContractCents }: Base & {
  tasks: MilestoneTaskRow[]; wbs: MilestoneWbsRow[]; billedIds: ReadonlySet<string>; revisedContractCents: number;
}) {
  const { run, busy } = useAction();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [on, setOn] = useState(today);
  const [err, setErr] = useState<string | null>(null);
  const valueOf = (x: { billing_amount_cents: number | null; billing_pct: number | null }) =>
    x.billing_amount_cents ?? (x.billing_pct != null ? roundMul(revisedContractCents, x.billing_pct) : null);
  const items = [
    ...tasks.map((t) => ({ id: t.id, name: t.title, done: t.status === 'DONE', when: t.completed_at?.slice(0, 10) ?? t.due_on, value: valueOf(t), how: t.billing_amount_cents != null ? 'fixed amount' : t.billing_pct != null ? `${p(t.billing_pct)} of contract` : null })),
    ...wbs.map((w) => ({ id: w.id, name: w.name, done: (w.pct_complete ?? 0) >= 1, when: null as string | null, value: valueOf(w), how: w.billing_amount_cents != null ? 'fixed amount' : w.billing_pct != null ? `${p(w.billing_pct)} of contract` : null })),
  ];
  const total = items.filter((i) => picked.has(i.id)).reduce((s, i) => s + (i.value ?? 0), 0);

  if (items.length === 0) {
    return <InlineNotice title="No milestones on this job.">Mark schedule tasks as milestones and give them a billing amount or share of the contract; completed milestones then bill here.</InlineNotice>;
  }
  const submit = async () => {
    if (!picked.size) return setErr('Pick at least one completed milestone.');
    setErr(null);
    const r = await run<{ requestId: string }>('ms', 'post', url(jobId), { mode: 'milestone', ids: [...picked], occurredOn: on }, `Drafted milestone billing (${picked.size})`, { quietError: true });
    if (r.error) setErr(r.error.error);
    else if (r.data) { setPicked(new Set()); onDrafted(r.data.requestId); }
  };
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="mp-table">
        <table className="tbl tbl-q tbl-q--compact">
          <colgroup><col style={{ width: 48 }} /><col /><col style={{ width: 160 }} /><col style={{ width: 120 }} /><col style={{ width: 136 }} /></colgroup>
          <thead><tr><th><span className="sr">Pick</span></th><th>Milestone</th><th>Billing value</th><th>Done</th><th className="n">Amount</th></tr></thead>
          <tbody>
            {items.map((i) => {
              const billed = billedIds.has(i.id);
              const can = i.done && !billed && (i.value ?? 0) > 0;
              return (
                <tr key={i.id} className="q-row">
                  <td><Check aria-label={`Bill ${i.name}`} disabled={!can} checked={picked.has(i.id)} onChange={(e) => { const n = new Set(picked); if (e.target.checked) n.add(i.id); else n.delete(i.id); setPicked(n); }} /></td>
                  <td>{i.name}{billed && <Tag style={{ marginLeft: 8 }}>Billed</Tag>}</td>
                  <td>{i.how ?? <span className="l2">No billing value set</span>}</td>
                  <td>{i.done ? (i.when ? shortDate(i.when) : 'Complete') : <span className="l2">Not complete</span>}</td>
                  <td className="n">{m(i.value)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <Field label="Invoice date"><Input type="date" value={on} onChange={(e) => setOn(e.target.value)} /></Field>
        <Field label="Picked" error={err ?? undefined}><span className="tnum" style={{ lineHeight: '32px' }}>{money(total)}</span></Field>
        <Button type="submit" variant="primary" disabled={busy === 'ms'}>Draft milestone billing</Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Time & materials
// ---------------------------------------------------------------------------

export function TmForm({ jobId, today, onDrafted }: Base) {
  const { run, busy } = useAction();
  const first = `${today.slice(0, 8)}01`;
  const [from, setFrom] = useState(first);
  const [to, setTo] = useState(today);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    if (to < from) return setErr('The end date is before the start date.');
    setErr(null);
    const r = await run<{ requestId: string }>('tm', 'post', url(jobId), { mode: 'tm', from, to }, `Drafted time and materials for ${shortDate(from)}–${shortDate(to)}`, { quietError: true });
    if (r.error) setErr(r.error.error);
    else if (r.data) onDrafted(r.data.requestId);
  };
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <p className="t-cap" style={{ maxWidth: '72ch' }}>Bills approved, billable time on this job in the date range at each entry’s pinned bill rate, grouped by cost code, pay type and rate. Each time entry bills once; voiding the draft frees it.</p>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To" error={err ?? undefined}><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Button type="submit" variant="primary" disabled={busy === 'tm'}>Draft T&amp;M billing</Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Fixed amount (manual request)
// ---------------------------------------------------------------------------

export function FixedForm({ jobId, today, onDrafted, remainingCents }: Base & { remainingCents: number }) {
  const { run, busy } = useAction();
  const [desc, setDesc] = useState('');
  const [amt, setAmt] = useState<number | null>(null);
  const [on, setOn] = useState(today);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    if (!desc.trim()) return setErr('Describe what is being billed.');
    if (amt == null || amt <= 0) return setErr('Enter an amount above zero.');
    setErr(null);
    const r = await run<{ requestId: string }>('fixed', 'post', url(jobId), { mode: 'fixed', description: desc.trim(), amountCents: amt, occurredOn: on }, `Drafted ${money(amt)}`, { quietError: true });
    if (r.error) setErr(r.error.error);
    else if (r.data) { setDesc(''); setAmt(null); onDrafted(r.data.requestId); }
  };
  return (
    <form className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <Field label="What is billed"><Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Second installment: rough-in complete" maxLength={200} style={{ width: 320 }} /></Field>
      <Field label="Amount" help={`${money(remainingCents)} left to bill on the contract`} error={err ?? undefined}><MoneyInput valueCents={amt} onChangeCents={setAmt} placeholder="0.00" /></Field>
      <Field label="Invoice date"><Input type="date" value={on} onChange={(e) => setOn(e.target.value)} /></Field>
      <Button type="submit" variant="primary" disabled={busy === 'fixed'}>Draft billing</Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Deposit (sent at once: there is no draft step in pm.request_deposit)
// ---------------------------------------------------------------------------

export function DepositForm({ jobId, today, revisedContractCents, requestedCents, booksPresent }: Omit<Base, 'onDrafted'> & { revisedContractCents: number; requestedCents: number; booksPresent: boolean }) {
  const { run } = useAction();
  const [amt, setAmt] = useState<number | null>(null);
  const [memo, setMemo] = useState('Deposit');
  const [on, setOn] = useState(today);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const room = revisedContractCents > 0 ? revisedContractCents - requestedCents : null;
  const ask = () => {
    if (amt == null || amt <= 0) return setErr('Enter a deposit above zero.');
    if (room != null && amt > room) return setErr(`Deposits would pass the contract: ${money(room)} is left.`);
    setErr(null);
    setConfirm(true);
  };
  const quick = (f: number) => revisedContractCents > 0 && setAmt(roundMul(revisedContractCents, f));
  return (
    <>
      <form className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); ask(); }}>
        <Field label="Deposit" help={revisedContractCents > 0 ? `${money(requestedCents)} requested so far of ${money(revisedContractCents)}` : 'No contract yet: any amount'} error={err ?? undefined}>
          <MoneyInput valueCents={amt} onChangeCents={setAmt} placeholder="0.00" />
        </Field>
        {revisedContractCents > 0 && (
          <div className="btn-row" aria-label="Quick amounts">
            {[0.1, 0.25, 0.33, 0.5].map((f) => <Button key={f} variant="quiet" onClick={() => quick(f)}>{p(f, 0)}</Button>)}
          </div>
        )}
        <Field label="Memo"><Input value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={200} style={{ width: 220 }} /></Field>
        <Field label="Invoice date"><Input type="date" value={on} onChange={(e) => setOn(e.target.value)} /></Field>
        <Button type="submit" variant="primary">Request deposit</Button>
      </form>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Request a ${amt != null ? money(amt) : ''} deposit`}
        confirmLabel="Request deposit"
        onConfirm={async () => {
          const r = await run<{ status: string }>('dep', 'post', `/api/jobs/${jobId}/deposits`, { amountCents: amt, memo: memo.trim() || null, occurredOn: on }, (d) => (d.status === 'EMITTED' ? 'Sent the deposit request to Merit Books' : 'Recorded the deposit request (not sent: Merit Books is off or this is a sample job)'), { quietError: true });
          if (r.error) throw new Error(r.error.error);
          setAmt(null);
        }}
      >
        {booksPresent
          ? 'This goes to Merit Books now: it invoices the customer and holds the money as a customer deposit until it is applied to a bill. There is no draft step.'
          : 'Merit Books is not on, so the request is recorded here as approved, not sent. It still counts for stage checks that need a deposit.'}
      </ConfirmDialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Retainage release
// ---------------------------------------------------------------------------

export function RetainageForm({ jobId, today, onDrafted, outstandingCents, heldCents, releasedCents, inFlight, booksPresent }: Base & {
  outstandingCents: number; heldCents: number; releasedCents: number; inFlight: boolean; booksPresent: boolean;
}) {
  const { run, busy } = useAction();
  const [amt, setAmt] = useState<number | null>(null);
  const [on, setOn] = useState(today);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    if (amt != null && (amt <= 0 || amt > outstandingCents)) return setErr(`Release up to ${money(outstandingCents)}.`);
    setErr(null);
    const r = await run<{ requestId: string }>('rel', 'post', url(jobId), { mode: 'retainage', amountCents: amt, occurredOn: on }, `Drafted a ${money(amt ?? outstandingCents)} retainage release`, { quietError: true });
    if (r.error) setErr(r.error.error);
    else if (r.data) onDrafted(r.data.requestId);
  };
  return (
    <div className="grid-12" style={{ alignItems: 'start', rowGap: 16 }}>
      <div style={{ gridColumn: 'span 5' }}>
        <KV items={[{ term: 'Held on bills', value: m(heldCents) }, { term: 'Released', value: m(releasedCents) }, { term: 'Outstanding', value: <b>{m(outstandingCents)}</b> }]} />
        <p className="t-cap" style={{ marginTop: 8 }}>Counts bills that reached Merit Books or were approved here; a rejected or void bill held nothing.</p>
      </div>
      <form style={{ gridColumn: 'span 7' }} className="mp-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {outstandingCents <= 0 ? (
          <InlineNotice title="No retainage is outstanding.">Nothing has been held on this job’s bills yet, or it has all been released.</InlineNotice>
        ) : (
          <>
            <div className="mp-form-2">
              <Field label="Release" help="Blank = all outstanding (closeout)" error={err ?? undefined}><MoneyInput valueCents={amt} onChangeCents={setAmt} placeholder={money(outstandingCents)} /></Field>
              <Field label="Invoice date"><Input type="date" value={on} onChange={(e) => setOn(e.target.value)} /></Field>
            </div>
            {inFlight && <InlineNotice tone="warn" title="A release is already open.">Approve or void it below before drafting another.</InlineNotice>}
            {booksPresent && <p className="t-cap">Merit Books books a release as a move from retainage receivable to receivables, with no new revenue. Until your Merit Books supports that, an approved release waits here.</p>}
            <div className="btn-row"><Button type="submit" variant="primary" disabled={busy === 'rel' || inFlight}>Draft retainage release</Button></div>
          </>
        )}
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Allowances
// ---------------------------------------------------------------------------

export function AllowanceForm({ jobId, onDrafted, allowances, coStage }: Omit<Base, 'today'> & { allowances: AllowanceRow[]; coStage: Record<string, string> }) {
  const { run, busy } = useAction();
  const [actual, setActual] = useState<Record<string, number | null>>({});
  const [errs, setErrs] = useState<Record<string, string>>({});
  if (!allowances.length) {
    return <InlineNotice title="No allowances on this job.">Mark estimate lines as allowances; accepting the estimate carries them here to close at actual cost.</InlineNotice>;
  }
  const close = async (a: AllowanceRow) => {
    const v = actual[a.id];
    if (v == null) return setErrs({ ...errs, [a.id]: 'Enter the actual cost.' });
    const r = await run<{ changeOrderId: string | null }>(`c:${a.id}`, 'post', `${url(jobId)}/allowances`, { op: 'close', allowanceId: a.id, actualCents: v },
      (d) => (d.changeOrderId ? `Closed. The ${money(v - a.allowance_cents)} difference is a potential change order now` : 'Closed at the allowance'), { quietError: true });
    setErrs({ ...errs, [a.id]: r.error ? r.error.error : '' });
  };
  const bill = async (a: AllowanceRow) => {
    const r = await run<{ requestId: string }>(`b:${a.id}`, 'post', `${url(jobId)}/allowances`, { op: 'bill_overage', allowanceId: a.id }, 'Drafted the overage billing', { quietError: true });
    if (r.error) setErrs({ ...errs, [a.id]: r.error.error });
    else if (r.data) onDrafted(r.data.requestId);
  };
  return (
    <div className="mp-table">
      <table className="tbl tbl-q tbl-q--compact">
        <colgroup><col /><col style={{ width: 128 }} /><col style={{ width: 168 }} /><col style={{ width: 128 }} /><col style={{ width: 220 }} /></colgroup>
        <thead><tr><th>Allowance</th><th className="n">Allowance</th><th className="n">Actual</th><th className="n">Difference</th><th><span className="sr">Action</span></th></tr></thead>
        <tbody>
          {allowances.map((a) => {
            const diff = a.actual_cents != null ? a.actual_cents - a.allowance_cents : null;
            const co = a.variance_co_id ? coStage[a.variance_co_id] : null;
            return (
              <tr key={a.id} className="q-row">
                <td>
                  <span className="l1">{a.description}</span>
                  <span className="l2">{a.status === 'OPEN' ? 'Open' : co === 'APPROVED' ? 'Closed · change order approved' : a.variance_co_id ? 'Closed · change order waiting for approval' : 'Closed'}</span>
                  {errs[a.id] && <span className="field-error" style={{ display: 'block' }}>{errs[a.id]}</span>}
                </td>
                <td className="n">{money(a.allowance_cents)}</td>
                <td className="n">{a.status === 'OPEN' ? <MoneyInput aria-label={`${a.description} actual`} valueCents={actual[a.id] ?? null} onChangeCents={(v) => setActual({ ...actual, [a.id]: v })} placeholder="0.00" /> : m(a.actual_cents)}</td>
                <td className="n">{diff == null ? '—' : money(diff)}</td>
                <td>
                  {a.status === 'OPEN' && <Button disabled={busy === `c:${a.id}`} onClick={() => void close(a)}>Close at actual</Button>}
                  {a.status === 'CLOSED' && (diff ?? 0) > 0 && <Button variant="primary" disabled={busy === `b:${a.id}` || co !== 'APPROVED'} title={co !== 'APPROVED' ? 'Approve the change order first' : undefined} onClick={() => void bill(a)}>Bill the overage</Button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
