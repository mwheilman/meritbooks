'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, ButtonLink, Check, Field, InlineNotice, Input, KV, Ledger, MoneyInput, Select, Tag, Textarea, money } from '@meritbooks/merit-ui';
import { PAY_APP_STAGE, pctText } from '@/lib/commercial/labels';
import { EXPORT_FORMATS, PAY_APP_STEPS, checkLineEdits, lineEdits, payAppStep, sheetTotals, type ExportFormat, type SheetLine } from '@/lib/commercial/screen-logic';
import type { PayAppWorkspaceData } from '@/lib/commercial/screen-types';
import { stamp } from '@/lib/time';
import { useShell } from '@/components/shell/ShellContext';
import { PctInput } from '@/components/ops/common/bits';
import { useOps } from '@/components/ops/common/useOps';
import { Actions, DSection, Failure, Mk, cm, day } from './common';
import { Stepper, words } from './kit';

type Edits = Record<string, { workToDate?: number | null; stored?: number | null }>;
const PORTALS = ['TEXTURA', 'GCPAY', 'PROCORE_PAY', 'OWNER_PORTAL', 'EMAIL', 'OTHER'] as const;
const PORTAL_STATUS = ['NOT_SUBMITTED', 'SUBMITTED', 'ACCEPTED', 'REJECTED', 'PAID'] as const;
const PRECONDITION_WORDS: Readonly<Record<string, string>> = {
  PRECONDITION_SOV_NOT_ACTIVE: 'The schedule of values is not active.', PRECONDITION_NO_CONTRACT: 'The job has no contract.',
  PRECONDITION_CUSTOMER_MISSING: 'The job has no customer to bill.', PRECONDITION_PERIOD_CLOSED: 'Merit Books has closed this period.',
};

/**
 * One owner pay application (CGC-41/43/44): the G702 face, the G703 continuation sheet (prior,
 * this period, stored materials, % complete, balance, retainage by line with the step-down
 * applied), approved change orders marked on their lines, the pencil → owner review → revise →
 * certify → final loop with its revision history, the contractor's e-signature, and the portal
 * output (Textura, GCPay, Procore Pay, G703 or a GC form).
 */
export function PayAppWorkspace({ data, today, canApprove }: { data: PayAppWorkspaceData; today: string; canApprove: boolean }) {
  const router = useRouter();
  const { readOnly } = useShell();
  const { act, busy, error } = useOps();
  const url = `/api/commercial/pay-apps/${data.requestId}`;
  const stage = data.status?.stage ?? (data.requestStatus === 'DRAFT' ? 'PENCIL' : 'FINAL');
  const step = payAppStep(stage);
  const revisable = !readOnly && (data.requestStatus === 'DRAFT' || data.requestStatus === 'REJECTED') && stage !== 'VOID' && stage !== 'CERTIFIED';
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Edits>({});
  const [reason, setReason] = useState(data.status?.returned_note ?? '');
  const t = sheetTotals(data.lines);
  const g = data.g702;
  const changed = lineEdits(data.lines, edits);
  const problems = checkLineEdits(data.lines, edits);
  const revision = data.status?.revision ?? 1;
  const std = data.lines.filter((l) => l.line_type === 'STANDARD');
  const other = data.lines.filter((l) => l.line_type !== 'STANDARD');

  const revise = async () => {
    const r = await act<{ id: string }>('revise', 'post', url, { op: 'revise', lines: changed.length ? changed : null, reason: reason.trim() || null }, `Saved revision ${revision + 1}`);
    if (r) { setEditing(false); setEdits({}); router.push(`/pay-apps/${r.id}`); }
  };

  return (
    <div className="stack" style={{ gap: 24 }}>
      <div className="ops-toolbar">
        <div className="ops-facts">
          <span><Mk map={PAY_APP_STAGE} status={stage} /></span>
          <span>Application <b>#{data.applicationNo ?? '—'}</b>{revision > 1 ? ` · revision ${revision}` : ''}</span>
          <span>Period ending <b>{day(data.periodEnd, today)}</b></span>
          {data.settings && <span>Form <b>{words(data.settings.billing_form)}</b></span>}
          {data.status?.pencil_sent_to && <span>Pencil to <b>{data.status.pencil_sent_to}</b></span>}
        </div>
        <span className="sp" />
        {data.siblings.length > 1 && (
          <Field label="Application">
            <Select value={data.requestId} onChange={(e) => router.push(`/pay-apps/${e.target.value}`)}>
              {data.siblings.map((s) => <option key={s.id} value={s.id}>#{s.application_no ?? '—'}{s.revision > 1 ? ` rev ${s.revision}` : ''} · {s.period_end ?? ''} · {words(s.stage)}</option>)}
            </Select>
          </Field>
        )}
      </div>
      <Stepper label="Pay application stage" steps={PAY_APP_STEPS} index={step.index} blocked={step.blocked} />
      <Failure text={error} />
      {stage === 'VOID' && <InlineNotice tone="warn" title="This revision was replaced.">{data.status?.superseded_by ? <Link className="link" href={`/pay-apps/${data.status.superseded_by}`}>Open the current revision</Link> : 'Open the current revision from the list.'}</InlineNotice>}
      {stage === 'REVISE' && <InlineNotice tone="neg" title="The owner returned the pencil.">{data.status?.returned_note ?? 'Revise the lines and send it back.'}</InlineNotice>}
      {(data.preview?.preconditions ?? []).map((p) => <InlineNotice key={p} tone="neg" title="Before this can be final">{PRECONDITION_WORDS[p] ?? words(p)}</InlineNotice>)}
      {(data.preview?.warnings ?? []).map((w) => <InlineNotice key={w.code} tone="warn" title="Check before you send">{w.text}{w.code === 'APPROVED_CO_NOT_ON_SOV' && !readOnly ? <> <Button variant="quiet" disabled={busy !== null} onClick={() => void act('sync', 'post', '/api/commercial/pay-apps', { op: 'sync_sov', jobId: data.jobId }, 'Added the approved change orders to the schedule of values')}>Add them to the schedule of values</Button></> : null}</InlineNotice>)}

      <div className="cm-split">
        <section className="sec" aria-label="Application for payment">
          <div className="sec-h"><h2 className="t-section">Application for payment</h2><span className="sp" /><span className="t-cap ink-3">G702-style summary</span></div>
          {g ? (
            <Ledger rows={[
              { label: '1. Original contract sum', value: cm(g.original_contract_cents) },
              { label: '2. Net change by change orders', value: cm(g.net_change_by_co_cents) },
              { label: '3. Contract sum to date (1 + 2)', value: cm(g.contract_sum_to_date_cents) },
              { label: '4. Total completed and stored to date', value: cm(g.total_completed_stored_cents) },
              { label: '5a. Retainage on completed work', value: cm(g.retainage_work_cents) },
              { label: '5b. Retainage on stored material', value: cm(g.retainage_stored_cents) },
              { label: '6. Total earned less retainage (4 − 5)', value: cm(g.total_earned_less_retainage_cents) },
              { label: '7. Less previous certificates for payment', value: cm(g.previous_certificates_cents) },
              { label: '8. Current payment due', value: <b>{cm(g.current_payment_due_cents)}</b> },
              { label: '9. Balance to finish, including retainage', value: cm(g.balance_to_finish_incl_retainage_cents) },
            ]} />
          ) : <p className="t-cap">The summary is not available for this application.</p>}
          {data.preview && data.preview.over_under_after_cents != null && (
            <p className="t-cap" style={{ marginTop: 8 }}>
              After this bill the job is {money(Math.abs(Number(data.preview.over_under_after_cents)), { decimals: 0 })} {Number(data.preview.over_under_after_cents) >= 0 ? 'over' : 'under'} billed against earned revenue
              {data.preview.over_under_before_cents != null ? ` (now ${money(Math.abs(Number(data.preview.over_under_before_cents)), { decimals: 0 })} ${Number(data.preview.over_under_before_cents) >= 0 ? 'over' : 'under'})` : ''}.
            </p>
          )}
        </section>
        <aside className="stack" style={{ gap: 20 }}>
          {!readOnly && stage !== 'VOID' && <StageActions data={data} stage={stage} url={url} busy={busy} act={act} canApprove={canApprove} />}
          {data.settings && (
            <DSection title="Retainage">
              <KV items={[
                { term: 'Step-down', value: data.steps.length ? data.steps.map((s) => `${pctText(Number(s.rate), 1)} from ${pctText(Number(s.from_pct))} complete`).join('; ') : 'None — the contract rate throughout' },
                { term: 'Applies to', value: data.settings.retainage_step_mode === 'REDUCE_TO_DATE' ? 'The whole balance (reduce to date)' : 'New work only' },
                { term: 'Stored materials', value: data.settings.stored_retainage_pct == null ? 'Same rate as work' : pctText(Number(data.settings.stored_retainage_pct), 1) },
              ]} />
            </DSection>
          )}
        </aside>
      </div>

      <section className="sec" aria-label="Continuation sheet">
        <div className="sec-h">
          <h2 className="t-section">Continuation sheet</h2>
          <span className="t-cap ink-3">{std.length} lines{std.some((l) => l.change_order) ? ` · ${std.filter((l) => l.change_order).length} from approved change orders` : ''}</span>
          <span className="sp" />
          {revisable && !editing && <Button chord="e" bindChord onClick={() => setEditing(true)}>Revise lines</Button>}
          {editing && <Button onClick={() => { setEditing(false); setEdits({}); }}>Discard changes</Button>}
        </div>
        <div className="mp-table" style={{ overflowX: 'auto' }}>
          <table className="g703" aria-label="Continuation sheet">
            <thead><tr>
              <th className="l"><span className="col">A</span>Item</th><th className="l"><span className="col">B</span>Description of work</th>
              <th><span className="col">C</span>Scheduled value</th><th><span className="col">D</span>From previous</th><th><span className="col">E</span>This period</th>
              <th><span className="col">F</span>Stored now</th><th><span className="col">G</span>Completed and stored</th><th>G ÷ C</th>
              <th><span className="col">H</span>Balance to finish</th><th><span className="col">I</span>Retainage</th>
            </tr></thead>
            <tbody>
              {std.map((l) => editing ? <EditRow key={l.id} l={l} e={edits[l.id]} onChange={(v) => setEdits((x) => ({ ...x, [l.id]: { ...x[l.id], ...v } }))} bad={problems.some((p) => p.id === l.id)} />
                : <ReadRow key={l.id} l={l} />)}
              {other.map((l) => (
                <tr key={l.id}><td className="l">{l.line_no}</td><td className="l">{l.description} <Tag>{words(l.line_type)}</Tag></td><td colSpan={7} /><td>{cm(l.retainage_this_period_cents)}</td></tr>
              ))}
            </tbody>
            <tfoot><tr>
              <td className="l" /><td className="l">Totals</td><td>{money(t.scheduled)}</td><td>{money(t.previous)}</td><td>{money(t.thisPeriod)}</td><td>{money(t.stored)}</td>
              <td>{money(t.completed)}</td><td>{pctText(t.pct, 1)}</td><td>{money(t.balance)}</td><td>{money(t.retainage)}</td>
            </tr></tfoot>
          </table>
        </div>
        {editing && (
          <div className="stack" style={{ gap: 8, marginTop: 12 }}>
            {problems.map((p) => <InlineNotice key={p.id} tone="neg" title="Fix this line">{p.problem}</InlineNotice>)}
            <Field label="What changed" help="Kept with the revision history (the owner's comments, a corrected quantity)."><Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} /></Field>
            <div className="row" style={{ gap: 8 }}>
              <Button variant="primary" chord="mod+enter" bindChord disabled={busy !== null || problems.length > 0 || (changed.length === 0 && !reason.trim())} onClick={() => void revise()}>
                {busy === 'revise' ? 'Saving…' : `Save as revision ${revision + 1}`}
              </Button>
              <span className="t-cap">{changed.length} {changed.length === 1 ? 'line' : 'lines'} changed. Same application number; the old revision is kept.</span>
            </div>
          </div>
        )}
      </section>

      <div className="cm-split">
        <SignatureSection data={data} readOnly={readOnly} busy={busy} act={act} />
        <PortalSection data={data} readOnly={readOnly} busy={busy} act={act} url={url} />
      </div>

      <DSection title="Revision history">
        {data.revisions.length === 0 ? <p className="t-cap">This is the first revision.</p> : (
          <ul className="feed">{data.revisions.map((r) => (
            <li key={r.id}>
              <span><span className="l1">Revision {r.revision}{r.totals.net_cents != null ? ` · ${money(Number(r.totals.net_cents))} due` : ''}</span><span style={{ display: 'block' }}>{r.reason ?? 'Corrected'}</span></span>
              <span className="t">{stamp(r.created_at)}</span>
            </li>
          ))}</ul>
        )}
      </DSection>
    </div>
  );
}

function ReadRow({ l }: { l: SheetLine }) {
  return (
    <tr>
      <td className="l">{l.line_no}</td>
      <td className="l">{l.description}{l.change_order && <> <Tag tone="solid">{l.change_order}</Tag></>}</td>
      <td>{cm(l.scheduled_value_cents)}</td>
      <td>{cm(Number(l.previous_work_cents ?? 0) + Number(l.previous_stored_cents ?? 0))}</td>
      <td>{cm(l.this_period_work_cents)}</td>
      <td>{cm(l.stored_materials_cents)}</td>
      <td>{cm(l.total_completed_cents)}</td>
      <td>{pctText(l.pct_complete == null ? null : Number(l.pct_complete), 1)}</td>
      <td>{cm(l.balance_to_finish_cents)}</td>
      <td>{cm(Number(l.retainage_work_to_date_cents ?? 0) + Number(l.retainage_stored_to_date_cents ?? 0))}<span className="ops-sub" style={{ display: 'block' }}>{pctText(l.retainage_rate == null ? null : Number(l.retainage_rate), 1)}</span></td>
    </tr>
  );
}

function EditRow({ l, e, onChange, bad }: { l: SheetLine; e: Edits[string] | undefined; onChange: (v: { workToDate?: number | null; stored?: number | null }) => void; bad: boolean }) {
  const sched = Number(l.scheduled_value_cents ?? 0);
  const prev = Number(l.previous_work_cents ?? 0);
  const work = e?.workToDate ?? prev + Number(l.this_period_work_cents ?? 0);
  const stored = e?.stored ?? Number(l.stored_materials_cents ?? 0);
  const g = work + stored;
  return (
    <tr className={bad ? 'is-open' : undefined}>
      <td className="l">{l.line_no}</td>
      <td className="l">{l.description}{l.change_order && <> <Tag tone="solid">{l.change_order}</Tag></>}</td>
      <td>{money(sched)}</td>
      <td>{money(prev + Number(l.previous_stored_cents ?? 0))}</td>
      <td style={{ minWidth: 120 }}>
        <PctInput aria-label={`Line ${l.line_no} work complete to date`} value={sched > 0 ? Math.round((work / sched) * 10000) / 10000 : null}
          onChange={(p) => onChange({ workToDate: p == null ? prev : Math.round(sched * p) })} />
        <span className="ops-sub" style={{ display: 'block' }}>{money(work - prev)} this period</span>
      </td>
      <td style={{ minWidth: 130 }}><MoneyInput aria-label={`Line ${l.line_no} stored materials`} valueCents={stored} onChangeCents={(c) => onChange({ stored: c ?? 0 })} /></td>
      <td>{money(g)}</td>
      <td>{sched > 0 ? pctText(g / sched, 1) : '—'}</td>
      <td>{money(sched - g)}</td>
      <td className="ink-3">recalculated on save</td>
    </tr>
  );
}

type Act = ReturnType<typeof useOps>['act'];

function StageActions({ data, stage, url, busy, act, canApprove }: { data: PayAppWorkspaceData; stage: string; url: string; busy: string | null; act: Act; canApprove: boolean }) {
  const [to, setTo] = useState(data.status?.pencil_sent_to ?? '');
  const [note, setNote] = useState('');
  const [architect, setArchitect] = useState(data.status?.architect_name ?? '');
  const [certified, setCertified] = useState<number | null>(data.preview?.net_cents ?? data.g702?.current_payment_due_cents ?? null);
  const [notarized, setNotarized] = useState(false);
  const due = data.preview?.net_cents ?? null;
  const mismatch = certified != null && due != null && certified !== Number(due);
  const draft = data.requestStatus === 'DRAFT' || data.requestStatus === 'REJECTED';
  return (
    <DSection title="Next step">
      <div className="stack" style={{ gap: 12 }}>
        {(stage === 'PENCIL' || stage === 'REVISE' || stage === 'PENCIL_SENT') && draft && (
          <div className="stack" style={{ gap: 8 }}>
            <Field label="Pencil to" help="The owner's rep or architect who reviews the draft."><Input value={to} onChange={(e) => setTo(e.target.value)} maxLength={200} placeholder="Name or email" /></Field>
            <Button variant={stage === 'PENCIL_SENT' ? 'default' : 'primary'} disabled={busy !== null} onClick={() => void act('pencil', 'post', url, { op: 'pencil', to: to.trim() || null }, stage === 'PENCIL_SENT' ? 'Re-sent the pencil' : 'Sent the pencil to the owner')}>
              {busy === 'pencil' ? 'Sending…' : stage === 'PENCIL_SENT' ? 'Send the pencil again' : 'Send the pencil to the owner'}
            </Button>
          </div>
        )}
        {(stage === 'PENCIL_SENT' || stage === 'CERTIFIED') && draft && (
          <div className="stack" style={{ gap: 8 }}>
            <Field label="Owner's comments"><Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder="Line 4 at 60%, not 75%" /></Field>
            <Button disabled={busy !== null || !note.trim()} onClick={() => void act('return', 'post', url, { op: 'return', note: note.trim() }, 'Recorded the owner’s return')}>{busy === 'return' ? 'Saving…' : 'Owner returned it'}</Button>
          </div>
        )}
        {(stage === 'PENCIL' || stage === 'PENCIL_SENT') && draft && (
          <div className="stack" style={{ gap: 8 }}>
            <Field label="Certified by" help={data.settings?.architect_certification === false ? 'This contract does not require an architect; record the owner rep who approved it.' : 'The architect who signed the certificate for payment.'}>
              <Input value={architect} onChange={(e) => setArchitect(e.target.value)} maxLength={200} />
            </Field>
            <Field label="Amount certified" error={mismatch ? `The application is for ${money(Number(due))}. Revise the lines to the certified figures first.` : undefined}>
              <MoneyInput valueCents={certified} onChangeCents={setCertified} />
            </Field>
            <Check label={data.settings?.notarization_required ? 'Notarized (this contract requires it)' : 'Notarized'} checked={notarized} onChange={(e) => setNotarized(e.target.checked)} />
            <Button variant="primary" disabled={busy !== null || !architect.trim() || certified == null || mismatch || (data.settings?.notarization_required === true && !notarized)}
              onClick={() => void act('certify', 'post', url, { op: 'certify', architect: architect.trim(), certifiedCents: certified, notarized }, 'Recorded the certification')}>
              {busy === 'certify' ? 'Saving…' : 'Record the certification'}
            </Button>
          </div>
        )}
        {stage === 'CERTIFIED' && draft && (
          <div className="stack" style={{ gap: 8 }}>
            <p className="t-cap">Certified by {data.status?.architect_name}{data.status?.certified_at ? ` on ${stamp(data.status.certified_at)}` : ''}. Approving sends it to Merit Books, which issues the invoice dated from the certification.</p>
            {canApprove ? (
              <Actions busy={busy} items={[{ key: 'approve', label: 'Approve and send to Merit Books', primary: true, onClick: () => void act('approve', 'post', `/api/billing/${data.requestId}`, { op: 'approve' }, 'Approved and sent to Merit Books') }]} />
            ) : <p className="t-cap">Someone who approves billing sends it on.</p>}
          </div>
        )}
        {!draft && <p className="t-cap">This application is {words(data.requestStatus)}{data.status?.owner_approved_at ? ` — approved ${stamp(data.status.owner_approved_at)}` : ''}. <Link className="link" href={`/jobs/${data.jobId}?tab=billing&request=${data.requestId}`}>Open it on the job’s billing</Link></p>}
      </div>
    </DSection>
  );
}

function SignatureSection({ data, readOnly, busy, act }: { data: PayAppWorkspaceData; readOnly: boolean; busy: string | null; act: Act }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const open = data.envelopes.find((e) => e.status === 'sent' || e.status === 'draft');
  return (
    <DSection title="Contractor's signature">
      <div className="stack" style={{ gap: 12 }}>
        {data.status?.contractor_signed_at && <p className="t-cap">Contractor signature recorded {stamp(data.status.contractor_signed_at)}{data.status.notarized_at ? `; notarized ${stamp(data.status.notarized_at)}` : ''}.</p>}
        {data.envelopes.length === 0 ? <p className="t-cap">Not sent for signature yet. Signing renders the application cover as it stands and sends a one-time link.</p> : (
          <ul className="feed">{data.envelopes.map((e) => (
            <li key={e.id}>
              <span><span className="l1">{e.title} <Tag tone={e.status === 'completed' ? 'pos' : e.status === 'declined' || e.status === 'voided' ? 'neg' : undefined}>{words(e.status)}</Tag></span>
                <span style={{ display: 'block' }}>{e.signers.map((s) => `${s.name} — ${words(s.status)}`).join(' · ')}</span></span>
              <span className="t">{e.sent_at ? stamp(e.sent_at) : ''}</span>
            </li>
          ))}</ul>
        )}
        {!readOnly && !open && data.requestStatus !== 'VOID' && (
          <form className="stack" style={{ gap: 8 }} onSubmit={async (ev) => {
            ev.preventDefault();
            if (!name.trim()) return;
            const r = await act<{ deliveries: Array<{ link: string | null }> }>('sign', 'post', `/api/commercial/pay-apps/${data.requestId}/sign`,
              { signers: [{ name: name.trim(), email: email.trim() || null, roleLabel: 'Contractor' }] }, 'Sent for signature');
            if (r) setLink(r.deliveries.find((d) => d.link)?.link ?? null);
          }}>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <Field label="Signer"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Officer of the company" /></Field>
              <Field label="Email" help="Blank: you get the link to hand over."><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} /></Field>
            </div>
            <div><Button type="submit" disabled={busy !== null || !name.trim()}>{busy === 'sign' ? 'Sending…' : 'Send for signature'}</Button></div>
          </form>
        )}
        {link && <InlineNotice tone="info" title="Share this one-time link with the signer">{link}</InlineNotice>}
      </div>
    </DSection>
  );
}

function PortalSection({ data, readOnly, busy, act, url }: { data: PayAppWorkspaceData; readOnly: boolean; busy: string | null; act: Act; url: string }) {
  const suggested = useMemo(() => {
    const f = data.settings?.billing_form;
    return f === 'TEXTURA' || f === 'GCPAY' || f === 'PROCORE_PAY' ? (f as ExportFormat) : f === 'GC_FORM' ? 'GC_FORM' : 'AIA_G703';
  }, [data.settings?.billing_form]);
  const [format, setFormat] = useState<ExportFormat>(suggested);
  const [portal, setPortal] = useState<string>(data.status?.portal ?? (suggested === 'AIA_G703' || suggested === 'GC_FORM' ? 'EMAIL' : suggested));
  const [pstatus, setPstatus] = useState<string>(data.status?.portal_status ?? 'NOT_SUBMITTED');
  return (
    <DSection title="Portal and format" aside={data.settings?.billing_portal_url ? <ButtonLink variant="quiet" href={data.settings.billing_portal_url}>Open the portal</ButtonLink> : undefined}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <Field label="Export as" help={EXPORT_FORMATS.find((f) => f.value === format)?.detail}>
            <Select value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>{EXPORT_FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</Select>
          </Field>
          <a className="btn" href={`/api/commercial/pay-apps/${data.requestId}/export?format=${format}`} download>Download CSV</a>
        </div>
        {!readOnly && (
          <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Field label="Submitted through"><Select value={portal} onChange={(e) => setPortal(e.target.value)}>{PORTALS.map((p) => <option key={p} value={p}>{words(p)}</option>)}</Select></Field>
            <Field label="Status there"><Select value={pstatus} onChange={(e) => setPstatus(e.target.value)}>{PORTAL_STATUS.map((p) => <option key={p} value={p}>{words(p)}</option>)}</Select></Field>
            <Button disabled={busy !== null} onClick={() => void act('portal', 'post', url, { op: 'portal', portal, status: pstatus }, 'Saved the portal status')}>{busy === 'portal' ? 'Saving…' : 'Save'}</Button>
          </div>
        )}
        {data.status?.portal && <p className="t-cap">{words(data.status.portal)}: {words(data.status.portal_status ?? 'NOT_SUBMITTED')}{data.status.portal_submitted_at ? `, submitted ${stamp(data.status.portal_submitted_at)}` : ''}.</p>}
      </div>
    </DSection>
  );
}
