'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Check, Drawer, Field, Figure, Input, Select, Tabs, Tag, Textarea, WidgetState, count, money, toast } from '@meritbooks/merit-ui';
import { COI_STATUS, SUB_PAY_APP_STATUS, WAIVER_STATUS, WAIVER_TYPE, pctText } from '@/lib/commercial/labels';
import type { CoiRow, ComplianceQueueRow, LienWaiverRow, SubPayAppRow } from '@/lib/commercial/types';
import { stamp } from '@/lib/time';
import { useMoneyVis, useShell } from '@/components/shell/ShellContext';
import { useDetail, useOps } from '@/components/ops/common/useOps';
import { Actions, DSection, Failure, Mk, cm, day, parseDollars } from './common';

type Act = ReturnType<typeof useOps>['act'];
type Tab = 'holds' | 'sub-pay-apps' | 'waivers' | 'insurance';
const DOC_WORDS: Readonly<Record<string, string>> = { COI: 'Insurance certificate', W9: 'W-9', LICENSE: 'License', LIEN_WAIVER: 'Lien waiver', BOND: 'Bond', OTHER: 'Document' };

export interface ComplianceViewProps {
  queue: ComplianceQueueRow[];
  apps: SubPayAppRow[];
  waivers: LienWaiverRow[];
  cois: CoiRow[];
  vendorNames: Readonly<Record<string, string>>;
  jobLabels: Readonly<Record<string, string>>;
  companies: Array<{ id: string; name: string }>;
  activeCompanyId: string | null;
  today: string;
  initialTab?: Tab;
  initialItem?: string | null;
}

/**
 * Subcontractor compliance and pay (CGC-45..49): what holds each subcontract's payment (the hold
 * Merit Books reads on JOB_COMMITMENT), sub pay applications through the approval chain, lien
 * waivers on the project state's statutory forms, and insurance certificates checked against
 * the requirements with renewal chases.
 */
export function ComplianceView(p: ComplianceViewProps) {
  const vis = useMoneyVis();
  const { readOnly } = useShell();
  const { act, busy, version, error } = useOps();
  const [tab, setTab] = useState<Tab>(p.initialTab ?? 'holds');
  const [appId, setAppId] = useState<string | null>(p.initialTab === 'sub-pay-apps' ? p.initialItem ?? null : null);
  const vname = (id: string | null) => (id ? p.vendorNames[id] ?? 'Subcontractor' : '—');
  const held = p.queue.filter((q) => q.payment_hold_effective);
  const inReview = p.apps.filter((a) => a.status === 'SUBMITTED' || a.status === 'IN_REVIEW');
  const waiting = p.waivers.filter((w) => w.direction === 'INBOUND' && ['REQUESTED', 'SENT', 'RECEIVED', 'REJECTED'].includes(w.status));
  const expiring = p.cois.filter((c) => c.status === 'VERIFIED' && c.earliest_expiry && c.earliest_expiry <= addDays(p.today, 30));

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="row" style={{ gap: 32, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <Figure dense label="Payments on hold" value={count(held.length)} vs={[`of ${count(p.queue.length)} subcontracts`, `${count(held.filter((h) => h.manual_hold).length)} held by hand`]} href="/compliance" linkLabel="Holds" />
        <Figure dense label="Pay applications in review" value={count(inReview.length)} vs={vis.cost ? [`${money(inReview.reduce((s, a) => s + Number(a.net_due_cents ?? 0), 0), { decimals: 0 })} net due`] : ['waiting on approval']} href="/compliance?tab=sub-pay-apps" linkLabel="Pay applications" />
        <Figure dense label="Waivers outstanding" value={count(waiting.length)} vs={[`${count(waiting.filter((w) => w.status === 'RECEIVED').length)} received, to verify`]} href="/compliance?tab=waivers" linkLabel="Lien waivers" />
        <Figure dense label="Certificates expiring" value={count(expiring.length)} vs={['in the next 30 days', `${count(p.cois.filter((c) => c.status === 'DEFICIENT' || c.status === 'EXPIRED').length)} deficient or expired`]} href="/compliance?tab=insurance" linkLabel="Insurance" />
      </div>
      <Tabs aria-label="Compliance" value={tab} onChange={setTab} items={[
        { value: 'holds', label: 'Payment holds', count: held.length || undefined },
        { value: 'sub-pay-apps', label: 'Sub pay applications', count: inReview.length || undefined },
        { value: 'waivers', label: 'Lien waivers', count: waiting.length || undefined },
        { value: 'insurance', label: 'Insurance' },
      ]} />
      <Failure text={error} />

      {tab === 'holds' && (p.queue.length === 0 ? <WidgetState state={{ kind: 'empty', title: 'No approved subcontracts yet', body: 'Once a subcontract is approved, its insurance, W-9, license and lien waivers are tracked here; anything missing or expired holds its payment in Merit Books.' }} /> : (
        <div className="mp-table">
          <table className="tbl tbl-q tbl-q--compact">
            <thead><tr><th>Subcontractor</th><th>Job</th><th style={{ width: 130 }}>Payment</th><th>What blocks it</th><th style={{ width: 150 }}>Insurance</th><th style={{ width: 100 }}>Waivers due</th><th style={{ width: 200 }} /></tr></thead>
            <tbody>{[...p.queue].sort((a, b) => Number(b.payment_hold_effective) - Number(a.payment_hold_effective)).map((q) => (
              <tr key={q.commitment_id} className="q-row">
                <td><span className="b">{q.vendor_name ?? vname(q.vendor_id)}</span><span className="ops-sub" style={{ display: 'block' }}>{q.number ?? 'Subcontract'}</span></td>
                <td>{p.jobLabels[q.job_id] ?? 'Job'}</td>
                <td>{q.payment_hold_effective ? <Tag tone="neg">On hold</Tag> : <Tag tone="pos">Clear to pay</Tag>}</td>
                <td>{q.manual_hold && <span style={{ display: 'block' }}>Held: {q.hold_reason ?? 'by hand'}</span>}
                  {q.blocking_docs.map((d) => <span key={d.id} style={{ display: 'block' }}>{DOC_WORDS[d.doc_type] ?? d.doc_type}: {d.status.toLowerCase()}{d.expires_on ? `, expires ${day(d.expires_on, p.today)}` : ''}</span>)}
                  {!q.manual_hold && q.blocking_docs.length === 0 && <span className="t-cap">Nothing</span>}</td>
                <td>{q.coi_status ? <Mk map={COI_STATUS} status={q.coi_status} /> : <span className="t-cap">None on file</span>}{q.coi_expires_on && <span className="ops-sub" style={{ display: 'block' }}>Expires {day(q.coi_expires_on, p.today)}</span>}</td>
                <td>{q.waivers_outstanding || '—'}</td>
                <td>{!readOnly && <RequestWaiver commitmentId={q.commitment_id} busy={busy} act={act} />}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ))}

      {tab === 'sub-pay-apps' && <SubPayApps {...p} vname={vname} readOnly={readOnly} busy={busy} act={act} openId={appId} setOpenId={setAppId} version={version} />}
      {tab === 'waivers' && <Waivers waivers={p.waivers} vname={vname} jobLabels={p.jobLabels} today={p.today} readOnly={readOnly} busy={busy} act={act} />}
      {tab === 'insurance' && <Insurance cois={p.cois} queue={p.queue} vname={vname} companies={p.companies} activeCompanyId={p.activeCompanyId} today={p.today} readOnly={readOnly} busy={busy} act={act} />}
    </div>
  );
}

function addDays(d: string, n: number): string {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

function RequestWaiver({ commitmentId, busy, act }: { commitmentId: string; busy: string | null; act: Act }) {
  const [type, setType] = useState('CONDITIONAL_PROGRESS');
  return (
    <div className="row" style={{ gap: 4 }}>
      <Select aria-label="Waiver type" value={type} onChange={(e) => setType(e.target.value)}>{Object.entries(WAIVER_TYPE).map(([k, w]) => <option key={k} value={k}>{w}</option>)}</Select>
      <Button variant="quiet" disabled={busy !== null} onClick={() => void act(`w${commitmentId}`, 'post', '/api/commercial/lien-waivers', { commitmentId, type, amountCents: null, through: null, subPayAppId: null, tier: 1, claimant: null }, 'Requested the waiver on the state form')}>Request</Button>
    </div>
  );
}

function SubPayApps(p: ComplianceViewProps & { vname: (id: string | null) => string; readOnly: boolean; busy: string | null; act: Act; openId: string | null; setOpenId: (id: string | null) => void; version: number }) {
  const vis = useMoneyVis();
  const [cmt, setCmt] = useState('');
  const [period, setPeriod] = useState(p.today);
  const open = p.apps.find((a) => a.id === p.openId) ?? null;
  return (
    <section className="stack" style={{ gap: 12 }} aria-label="Sub pay applications">
      {!p.readOnly && p.queue.length > 0 && (
        <div className="ops-toolbar">
          <Field label="Subcontract"><Select value={cmt} onChange={(e) => setCmt(e.target.value)}>
            <option value="">Pick a subcontract</option>
            {p.queue.map((q) => <option key={q.commitment_id} value={q.commitment_id}>{q.vendor_name ?? p.vname(q.vendor_id)} · {q.number ?? ''} · {p.jobLabels[q.job_id] ?? ''}</option>)}
          </Select></Field>
          <Field label="Period ending"><Input type="date" value={period} onChange={(e) => setPeriod(e.target.value)} /></Field>
          <Button icon="plus" disabled={!cmt || p.busy !== null} onClick={async () => {
            const r = await p.act<{ id: string }>('newapp', 'post', '/api/commercial/sub-pay-apps', { commitmentId: cmt, periodEnd: period, lines: [] }, 'Started the pay application; enter this period’s progress');
            if (r) p.setOpenId(r.id);
          }}>Enter a pay application</Button>
        </div>
      )}
      {p.apps.length === 0 ? <WidgetState state={{ kind: 'empty', title: 'No sub pay applications', body: 'Subs bill against their subcontract’s schedule of values here or through their portal. Each one goes project manager → project accountant (→ executive above the threshold) and waits on its conditional waiver.' }} /> : (
        <div className="mp-table">
          <table className="tbl tbl-q tbl-q--compact">
            <thead><tr><th>Subcontractor</th><th>Job</th><th style={{ width: 70 }}>No.</th><th style={{ width: 110 }}>Period</th><th style={{ width: 130 }}>Status</th><th>Waiting on</th>{vis.cost && <th className="n" style={{ width: 120 }}>This period</th>}{vis.cost && <th className="n" style={{ width: 120 }}>Net due</th>}</tr></thead>
            <tbody>{p.apps.map((a) => {
              const step = a.chain?.find((c) => c.step === a.current_step);
              return (
                <tr key={a.id} className="q-row" onClick={() => p.setOpenId(a.id)} style={{ cursor: 'pointer' }}>
                  <td className="b">{p.vname(a.vendor_id)}{a.submitted_via === 'PORTAL' && <> <Tag>Portal</Tag></>}</td><td>{p.jobLabels[a.job_id] ?? 'Job'}</td><td>#{a.application_no}</td>
                  <td>{day(a.period_end, p.today)}</td><td><Mk map={SUB_PAY_APP_STATUS} status={a.status} /></td>
                  <td>{(a.status === 'SUBMITTED' || a.status === 'IN_REVIEW') && step ? step.label : '—'}</td>
                  {vis.cost && <td className="n">{cm(a.gross_this_period_cents)}</td>}{vis.cost && <td className="n b">{cm(a.net_due_cents)}</td>}
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
      <Drawer open={!!open} onClose={() => p.setOpenId(null)} width={760} title={open ? `${p.vname(open.vendor_id)} · pay application #${open.application_no}` : ''} eyebrow={open ? p.jobLabels[open.job_id] ?? 'Job' : undefined}>
        {open && <SubPayAppDetail id={open.id} version={p.version} readOnly={p.readOnly} busy={p.busy} act={p.act} today={p.today} />}
      </Drawer>
    </section>
  );
}

interface SubLine { id: string; commitment_line_id: string; line_no: number; description: string; scheduled_value_cents: number; previous_work_cents: number; this_period_work_cents: number; previous_stored_cents: number; stored_materials_cents: number; total_completed_cents: number; pct_complete: number | null; balance_to_finish_cents: number; retainage_this_period_cents: number }
interface SubDetail {
  app: SubPayAppRow & { stored_to_date_cents: number | null; retainage_to_date_cents: number | null };
  lines: SubLine[];
  actions: Array<{ step: number; action: string; actor: string | null; note: string | null; created_at: string }>;
  check: { claimed_pct: number | null; field_opinion_pct: number | null; field_note: string | null; manpower_days_in_period: number; over_claim: boolean | null } | null;
}

function SubPayAppDetail({ id, version, readOnly, busy, act, today }: { id: string; version: number; readOnly: boolean; busy: string | null; act: Act; today: string }) {
  const d = useDetail<SubDetail>(`/api/commercial/sub-pay-apps/${id}`, version);
  const [pct, setPct] = useState<Record<string, string>>({});
  const [stored, setStored] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const url = `/api/commercial/sub-pay-apps/${id}`;
  if (!d.data) return d.error ? <Failure text={d.error} title="The pay application did not load." /> : <WidgetState state={{ kind: 'loading', label: 'Loading the pay application…', lines: 6 }} />;
  const { app, lines, actions, check } = d.data;
  const editable = !readOnly && (app.status === 'DRAFT' || app.status === 'REVISE');
  const inReview = app.status === 'SUBMITTED' || app.status === 'IN_REVIEW';
  const step = app.chain?.find((c) => c.step === app.current_step);
  const dirty = Object.keys(pct).length + Object.keys(stored).length > 0;
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="ops-facts">
        <span><Mk map={SUB_PAY_APP_STATUS} status={app.status} /></span>
        <span>Period <b>{day(app.period_end, today)}</b></span>
        <span>Scheduled <b>{cm(app.scheduled_value_cents, 0)}</b></span>
        <span>This period <b>{cm(app.gross_this_period_cents)}</b></span>
        <span>Retainage <b>{cm(app.retainage_this_period_cents)}</b></span>
        <span>Net due <b>{cm(app.net_due_cents)}</b></span>
        {inReview && step && <span>Waiting on <b>{step.label}</b></span>}
      </div>
      {app.rejected_reason && <Failure title={app.status === 'REVISE' ? 'Sent back.' : 'Rejected.'} text={app.rejected_reason} />}
      {check && (
        <DSection title="Field check">
          <div className="ops-facts">
            <span>Claimed <b>{pctText(check.claimed_pct == null ? null : Number(check.claimed_pct), 0)}</b></span>
            <span>Superintendent says <b>{pctText(check.field_opinion_pct == null ? null : Number(check.field_opinion_pct), 0)}</b></span>
            <span><b>{count(check.manpower_days_in_period)}</b> crew-days on the daily logs this period</span>
            {check.over_claim && <span><Tag tone="neg">Claims more than the field sees</Tag></span>}
          </div>
          {check.field_note && <p className="t-cap">{check.field_note}</p>}
        </DSection>
      )}
      <div style={{ overflowX: 'auto' }}>
        <table className="ops-mini">
          <thead><tr><th>#</th><th>Line</th><th className="n">Scheduled</th><th className="n">Previous</th><th className="n">This period</th><th className="n">Stored</th><th className="n">Complete</th><th className="n">Retainage</th></tr></thead>
          <tbody>{lines.map((l) => (
            <tr key={l.id}>
              <td>{l.line_no}</td><td>{l.description}</td><td className="n">{cm(l.scheduled_value_cents, 0)}</td><td className="n">{cm(l.previous_work_cents, 0)}</td>
              <td className="n">{cm(l.this_period_work_cents, 0)}</td>
              <td className="n">{editable ? <Input aria-label={`Stored materials, line ${l.line_no}`} inputMode="decimal" value={stored[l.commitment_line_id] ?? String(Number(l.stored_materials_cents) / 100)} onChange={(e) => setStored({ ...stored, [l.commitment_line_id]: e.target.value })} style={{ width: 100, textAlign: 'right' }} /> : cm(l.stored_materials_cents, 0)}</td>
              <td className="n">{editable ? <Input aria-label={`Percent complete, line ${l.line_no}`} inputMode="decimal" value={pct[l.commitment_line_id] ?? (l.pct_complete == null ? '' : String(Math.round(Number(l.pct_complete) * 10000) / 100))} onChange={(e) => setPct({ ...pct, [l.commitment_line_id]: e.target.value })} style={{ width: 70, textAlign: 'right' }} /> : pctText(l.pct_complete == null ? null : Number(l.pct_complete), 0)}</td>
              <td className="n">{cm(l.retainage_this_period_cents)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {editable && (
        <Actions busy={busy} items={[
          { key: 'lines', label: 'Save progress', onClick: () => {
            const out = lines.map((l) => {
              const pt = pct[l.commitment_line_id];
              const st = stored[l.commitment_line_id];
              const pctN = pt === undefined || pt.trim() === '' ? null : Number(pt) / 100;
              const stN = st === undefined ? null : parseDollars(st);
              return { commitment_line_id: l.commitment_line_id, ...(pctN !== null && Number.isFinite(pctN) ? { pct_complete: Math.min(1, Math.max(0, pctN)) } : { work_to_date_cents: Number(l.previous_work_cents) + Number(l.this_period_work_cents) }), stored_materials_cents: stN ?? Number(l.stored_materials_cents) };
            });
            void act('lines', 'post', url, { op: 'lines', lines: out }, 'Saved').then((r) => { if (r) { setPct({}); setStored({}); } });
          }, hidden: !dirty },
          { key: 'submit', label: 'Submit for approval', primary: true, onClick: () => void act('submit', 'post', url, { op: 'submit' }, 'Submitted; the conditional waiver was requested'), hidden: dirty },
          { key: 'void', label: 'Void', danger: true, onClick: () => void act('void', 'post', url, { op: 'void', reason: null }, 'Voided') },
        ]} />
      )}
      {!readOnly && inReview && (
        <DSection title={step ? `Step ${step.step}: ${step.label}` : 'Decide'}>
          <Field label="Note"><Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder="Required to reject or send back" /></Field>
          <Actions busy={busy} items={[
            { key: 'approve', label: 'Approve this step', primary: true, onClick: () => void act<{ status: string }>('approve', 'post', url, { op: 'approve', note: note.trim() || null }, (r) => r.status === 'APPROVED' ? 'Approved; queued for payment in Merit Books' : 'Approved this step') },
            { key: 'back', label: 'Send back', onClick: () => { if (note.trim()) void act('back', 'post', url, { op: 'send_back', note: note.trim() }, 'Sent back to the sub'); } },
            { key: 'reject', label: 'Reject', danger: true, onClick: () => { if (note.trim()) void act('reject', 'post', url, { op: 'reject', note: note.trim() }, 'Rejected'); } },
          ]} />
          <p className="t-cap" style={{ marginTop: 8 }}>The person who entered it cannot approve it, and nobody approves two steps.</p>
        </DSection>
      )}
      <DSection title="Trail">
        {actions.length === 0 ? <p className="t-cap">Not submitted yet.</p> : <ul className="feed">{actions.map((a, i) => <li key={i}><span><span className="l1">{a.action === 'SUBMIT' ? 'Submitted' : a.action === 'APPROVE' ? `Approved step ${a.step}` : a.action === 'REJECT' ? 'Rejected' : a.action === 'REVISE' ? 'Sent back' : 'Voided'}</span>{a.note && <span className="l2">{a.note}</span>}</span><span className="t">{stamp(a.created_at)}</span></li>)}</ul>}
      </DSection>
    </div>
  );
}

function Waivers({ waivers, vname, jobLabels, today, readOnly, busy, act }: { waivers: LienWaiverRow[]; vname: (id: string | null) => string; jobLabels: Readonly<Record<string, string>>; today: string; readOnly: boolean; busy: string | null; act: Act }) {
  const vis = useMoneyVis();
  const [recv, setRecv] = useState<LienWaiverRow | null>(null);
  const [amt, setAmt] = useState('');
  const [thru, setThru] = useState('');
  const [problems, setProblems] = useState<Array<{ code: string; text: string }> | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [upErr, setUpErr] = useState<string | null>(null);
  const router = useRouter();
  if (waivers.length === 0) return <WidgetState state={{ kind: 'empty', title: 'No lien waivers yet', body: 'A conditional waiver is requested with each sub pay application, and an unconditional one when Merit Books records the payment. Each uses the statutory form for the project’s state.' }} />;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="mp-table">
        <table className="tbl tbl-q tbl-q--compact">
          <thead><tr><th>Subcontractor</th><th>Job</th><th>Waiver</th><th style={{ width: 110 }}>Through</th>{vis.cost && <th className="n" style={{ width: 120 }}>Amount</th>}<th style={{ width: 130 }}>Status</th><th style={{ width: 220 }} /></tr></thead>
          <tbody>{waivers.map((w) => (
            <tr key={w.id} className="q-row">
              <td>{w.direction === 'OUTBOUND' ? 'Ours, to the owner' : vname(w.vendor_id)}</td><td>{jobLabels[w.job_id] ?? 'Job'}</td>
              <td>{WAIVER_TYPE[w.waiver_type] ?? w.waiver_type}<span className="ops-sub" style={{ display: 'block' }}>{w.state_code ? `${w.state_code} statutory form` : 'Standard form'}</span></td>
              <td>{day(w.through_date, today)}</td>{vis.cost && <td className="n">{cm(w.amount_cents)}</td>}
              <td><Mk map={WAIVER_STATUS} status={w.status} />{w.rejected_reason && <span className="ops-sub" style={{ display: 'block' }}>{w.rejected_reason}</span>}</td>
              <td>{!readOnly && w.direction === 'INBOUND' && <Actions busy={busy} items={[
                { key: `s${w.id}`, label: 'Sent', onClick: () => void act(`s${w.id}`, 'post', `/api/commercial/lien-waivers/${w.id}`, { op: 'sent', envelopeId: null }, 'Marked as sent for signature'), hidden: w.status !== 'REQUESTED' },
                { key: `r${w.id}`, label: 'Received', onClick: () => { setRecv(w); setFile(null); setUpErr(null); setAmt(w.amount_cents != null ? String(Number(w.amount_cents) / 100) : ''); setThru(w.through_date ?? ''); setProblems(null); }, hidden: !['REQUESTED', 'SENT', 'SIGNED', 'REJECTED'].includes(w.status) },
                { key: `v${w.id}`, label: 'Verify', primary: true, onClick: () => void act<{ ok: boolean; problems?: Array<{ code: string; text: string }> }>(`v${w.id}`, 'post', `/api/commercial/lien-waivers/${w.id}`, { op: 'verify' }, (r) => { if (!r.ok) setProblems(r.problems ?? []); return r.ok ? 'Verified; the hold is released' : 'Does not tie: see the problems'; }), hidden: w.status !== 'RECEIVED' && w.status !== 'SIGNED' },
              ]} />}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {problems && problems.length > 0 && <Failure title="The waiver does not tie." text={problems.map((x) => x.text).join(' ')} />}
      <Drawer open={!!recv} onClose={() => setRecv(null)} width={420} title="Waiver received" eyebrow={recv ? vname(recv.vendor_id) : undefined}>
        {recv && (
          <form className="stack" style={{ gap: 12 }} onSubmit={async (e) => {
            e.preventDefault();
            const c = amt.trim() ? parseDollars(amt) : null;
            if (amt.trim() && c === null) { setUpErr('Enter the amount like 12,500.'); return; }
            if (file) {
              // the signed copy goes up with the receipt (multipart), so verification has evidence
              const fd = new FormData();
              fd.set('file', file);
              if (c !== null) fd.set('amountCents', String(c));
              if (thru) fd.set('throughDate', thru);
              setUploading(true);
              setUpErr(null);
              const res = await fetch(`/api/commercial/lien-waivers/${recv.id}/document`, { method: 'POST', body: fd }).catch(() => null);
              setUploading(false);
              if (!res || !res.ok) {
                const body = (await res?.json().catch(() => null)) as { error?: string } | null;
                setUpErr(body?.error ?? 'The file did not upload. Try again.');
                return;
              }
              toast('Recorded with the signed copy; someone else verifies it');
              setRecv(null);
              router.refresh();
              return;
            }
            const r = await act('recv', 'post', `/api/commercial/lien-waivers/${recv.id}`, { op: 'receive', documentId: null, amountCents: c, throughDate: thru || null, formKey: recv.form_key }, 'Recorded; attach the signed copy before it can be verified');
            if (r) setRecv(null);
          }}>
            <p className="t-cap">Enter what the signed form says. Verifying checks it against the payment, the through-date and the {recv.state_code ?? 'standard'} form.</p>
            <p className="t-cap">A waiver is verified only with the signed copy on file (attached here or completed by e-sign), and by someone other than the person who logs it as received.</p>
            <Field label="Signed waiver (PDF or photo)"><Input type="file" accept="application/pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
            <Field label="Amount on the waiver ($)"><Input inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} /></Field>
            <Field label="Through date"><Input type="date" value={thru} onChange={(e) => setThru(e.target.value)} /></Field>
            <Failure text={upErr} />
            <div><Button type="submit" variant="primary" disabled={busy !== null || uploading}>{uploading ? 'Uploading…' : 'Save'}</Button></div>
          </form>
        )}
      </Drawer>
    </div>
  );
}

function Insurance({ cois, queue, vname, companies, activeCompanyId, today, readOnly, busy, act }: { cois: CoiRow[]; queue: ComplianceQueueRow[]; vname: (id: string | null) => string; companies: Array<{ id: string; name: string }>; activeCompanyId: string | null; today: string; readOnly: boolean; busy: string | null; act: Act }) {
  const vendors = useMemo(() => [...new Map(queue.filter((q) => q.vendor_id).map((q) => [q.vendor_id!, { id: q.vendor_id!, name: q.vendor_name ?? vname(q.vendor_id), companyId: q.location_id, jobId: q.job_id }])).values()], [queue, vname]);
  const [adding, setAdding] = useState(false);
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="ops-toolbar">
        <span className="sp" />
        {!readOnly && <Button disabled={busy !== null} onClick={() => void act<{ chased: number }>('chase', 'post', '/api/commercial/compliance', { op: 'chase', companyId: activeCompanyId }, (r) => r.chased ? `Sent ${count(r.chased)} renewal reminders` : 'Nothing due for a reminder today')}>Send renewal reminders</Button>}
        {!readOnly && vendors.length > 0 && <Button icon="plus" onClick={() => setAdding((v) => !v)}>Record a certificate</Button>}
      </div>
      {adding && <RecordCoi vendors={vendors} companies={companies} busy={busy === 'coi'} onSave={async (b) => { const r = await act<{ id: string }>('coi', 'post', '/api/commercial/compliance', b, 'Recorded and checked against the requirements'); if (r) setAdding(false); return !!r; }} />}
      {cois.length === 0 ? <WidgetState state={{ kind: 'empty', title: 'No certificates on file', body: 'Record each sub’s certificate of insurance. It is checked against the job’s limits and endorsements (additional insured, waiver of subrogation, primary and non-contributory); deficient or expired holds payment.' }} /> : (
        <div className="mp-table">
          <table className="tbl tbl-q tbl-q--compact">
            <thead><tr><th>Subcontractor</th><th>Carrier</th><th style={{ width: 130 }}>Status</th><th style={{ width: 140 }}>Earliest expiry</th><th>Checks</th></tr></thead>
            <tbody>{cois.map((c) => (
              <tr key={c.id} className="q-row">
                <td className="b">{vname(c.vendor_id)}</td><td>{c.carrier ?? '—'}</td><td><Mk map={COI_STATUS} status={c.status} /></td>
                <td>{day(c.earliest_expiry, today)}{c.earliest_expiry && c.earliest_expiry < today && <> <Tag tone="neg">Expired</Tag></>}</td>
                <td>{(c.verification ?? []).filter((v) => !v.ok).map((v) => <span key={v.requirement} style={{ display: 'block' }}>{v.detail ?? v.requirement}</span>)}{(c.verification ?? []).every((v) => v.ok) && <span className="t-cap">Meets every requirement</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <p className="t-cap">Requirements come from the job’s project template; set them in Settings or on the job. <Link className="link" href="/subcontractors">Subcontractors</Link></p>
    </div>
  );
}

function RecordCoi({ vendors, companies, busy, onSave }: { vendors: Array<{ id: string; name: string; companyId: string; jobId: string }>; companies: Array<{ id: string; name: string }>; busy: boolean; onSave: (b: Record<string, unknown>) => Promise<boolean> }) {
  const [vendor, setVendor] = useState(vendors[0]?.id ?? '');
  const [carrier, setCarrier] = useState('');
  const [glOcc, setGlOcc] = useState('1000000');
  const [glAgg, setGlAgg] = useState('2000000');
  const [glExp, setGlExp] = useState('');
  const [autoLim, setAutoLim] = useState('');
  const [autoExp, setAutoExp] = useState('');
  const [wcExp, setWcExp] = useState('');
  const [umbLim, setUmbLim] = useState('');
  const [umbExp, setUmbExp] = useState('');
  const [endorse, setEndorse] = useState('CG 20 10, CG 20 37');
  const [ai, setAi] = useState(true);
  const [wos, setWos] = useState(false);
  const [pnc, setPnc] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const v = vendors.find((x) => x.id === vendor);
  return (
    <form className="mp-table mp-add" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 12 }} onSubmit={(e) => {
      e.preventDefault();
      if (!v) return setErr('Pick the subcontractor.');
      const pol: Array<Record<string, unknown>> = [];
      const d = (t: string) => (t.trim() ? parseDollars(t) : null);
      if (glExp) pol.push({ type: 'GL', each_occurrence_cents: d(glOcc), aggregate_cents: d(glAgg), limit_cents: null, policy_no: null, expires: glExp });
      if (autoExp) pol.push({ type: 'AUTO', limit_cents: d(autoLim), each_occurrence_cents: null, aggregate_cents: null, policy_no: null, expires: autoExp });
      if (wcExp) pol.push({ type: 'WC', limit_cents: null, each_occurrence_cents: null, aggregate_cents: null, policy_no: null, expires: wcExp });
      if (umbExp) pol.push({ type: 'UMBRELLA', limit_cents: d(umbLim), each_occurrence_cents: null, aggregate_cents: null, policy_no: null, expires: umbExp });
      if (!pol.length) return setErr('Enter at least one policy with its expiry date.');
      setErr(null);
      void onSave({ op: 'record_coi', vendorId: v.id, companyId: companies.some((c) => c.id === v.companyId) ? v.companyId : companies[0]?.id, jobId: null, commitmentId: null, carrier: carrier.trim() || null,
        producer: null, certificateDate: null, policies: pol, endorsements: endorse.split(',').map((x) => x.trim()).filter((x) => x.length >= 2), additionalInsured: ai, waiverOfSubrogation: wos, primaryNoncontributory: pnc,
        emr: null, licenseNo: null, licenseExpires: null, documentId: null });
    }}>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Subcontractor" error={err ?? undefined}><Select value={vendor} onChange={(e) => setVendor(e.target.value)}>{vendors.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
        <Field label="Carrier"><Input value={carrier} onChange={(e) => setCarrier(e.target.value)} maxLength={200} style={{ width: 200 }} /></Field>
      </div>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="General liability, each occurrence ($)"><Input inputMode="decimal" value={glOcc} onChange={(e) => setGlOcc(e.target.value)} style={{ width: 140 }} /></Field>
        <Field label="Aggregate ($)"><Input inputMode="decimal" value={glAgg} onChange={(e) => setGlAgg(e.target.value)} style={{ width: 140 }} /></Field>
        <Field label="Expires"><Input type="date" value={glExp} onChange={(e) => setGlExp(e.target.value)} /></Field>
      </div>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Auto, combined ($)"><Input inputMode="decimal" value={autoLim} onChange={(e) => setAutoLim(e.target.value)} style={{ width: 140 }} /></Field>
        <Field label="Expires"><Input type="date" value={autoExp} onChange={(e) => setAutoExp(e.target.value)} /></Field>
        <Field label="Workers’ comp expires"><Input type="date" value={wcExp} onChange={(e) => setWcExp(e.target.value)} /></Field>
        <Field label="Umbrella ($)"><Input inputMode="decimal" value={umbLim} onChange={(e) => setUmbLim(e.target.value)} style={{ width: 140 }} /></Field>
        <Field label="Expires"><Input type="date" value={umbExp} onChange={(e) => setUmbExp(e.target.value)} /></Field>
      </div>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Endorsement forms" help="As printed on the certificate, separated by commas."><Input value={endorse} onChange={(e) => setEndorse(e.target.value)} style={{ width: 240 }} /></Field>
        <Check label="Additional insured" checked={ai} onChange={(e) => setAi(e.target.checked)} />
        <Check label="Waiver of subrogation" checked={wos} onChange={(e) => setWos(e.target.checked)} />
        <Check label="Primary and non-contributory" checked={pnc} onChange={(e) => setPnc(e.target.checked)} />
      </div>
      <div><Button type="submit" variant="primary" disabled={busy}>{busy ? 'Checking…' : 'Record and check'}</Button></div>
    </form>
  );
}
