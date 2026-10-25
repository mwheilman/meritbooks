'use client';

import { approvalOutcome, chainPending } from '@/lib/approvals/outcome';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Button, ConfirmDialog, Figure, InlineNotice, KV, Keybar, Panel, PanelSection, QueueTable, Seg, WidgetState, money, shortDate,
  type QueueColumn,
} from '@meritbooks/merit-ui';
import type { CostCodeRow } from '@/lib/pm/types';
import type { BillingBundle, PrimaryContract } from '@/lib/pm/money/queries';
import type { BillingRequestRow, BillingStatus, DepositRow, SuppressedReason } from '@/lib/pm/money/types';
import { BILLING_UI_LABELS, BILLING_UI_WHAT, type BillingModesResult, type BillingUiMode } from '@/lib/pm/money/billing-modes';
import { billingKindLabel, billingMark, unissuedSentence } from '@/lib/pm/money/status';
import { billedToDate, heldToDate } from '@/lib/pm/money/summaries';
import { g702FromView, g703FromStored } from '@/lib/pm/money/aia';
import { useShell, useVocab } from '@/components/shell/ShellContext';
import { useAction } from '@/components/job/useAction';
import { BooksNote, MarkStatus, PreconditionNotices, m, m0, p } from './common';
import { AllowanceForm, DepositForm, FixedForm, MilestoneForm, ProgressForm, RetainageForm, TmForm } from './BillingGenerators';
import { SovSection } from './SovSection';
import { G702Table, G703Table } from './PayApp';

export interface BillingTabProps {
  jobId: string;
  bundle: BillingBundle;
  modes: BillingModesResult;
  contract: PrimaryContract | null;
  revisedContractCents: number;
  costCodes: CostCodeRow[];
  currentUserId: string;
  booksPresent: boolean;
  isSample: boolean;
  today: string;
  hasAcceptedEstimate: boolean;
  /** Owner change-order stages by id (allowance variance COs). */
  coStage: Record<string, string>;
  /** Open this request first (?request=). */
  initialRequestId?: string | null;
}

interface ReqRow {
  id: string;
  kind: 'BILLING' | 'DEPOSIT';
  label: string;
  memo: string | null;
  date: string;
  status: BillingStatus;
  suppressed: SuppressedReason | null;
  gross: number;
  retainage: number;
  released: number;
  net: number;
  invoice: string | null;
  error: string | null;
  failing: string[];
  createdBy: string | null;
  request?: BillingRequestRow;
  deposit?: DepositRow;
}

type Show = 'open' | 'all' | 'void';

export function BillingTab(p0: BillingTabProps) {
  const v = useVocab();
  const { readOnly } = useShell();
  const { run, busy } = useAction();
  const b = p0.bundle;
  const failing = useMemo(() => new Map(b.queue.map((q) => [q.id, q.failing_preconditions ?? []])), [b.queue]);
  const rows: ReqRow[] = useMemo(() => [
    ...b.requests.map((r): ReqRow => ({
      id: r.id, kind: 'BILLING', label: billingKindLabel(r), memo: r.memo, date: r.period_end ?? r.occurred_on, status: r.status, suppressed: r.suppressed_reason,
      gross: r.gross_earned_cents, retainage: r.retainage_cents, released: r.retainage_released_cents, net: r.net_cents, invoice: r.invoice_number,
      error: r.error_text, failing: failing.get(r.id) ?? [], createdBy: r.created_by, request: r,
    })),
    ...b.deposits.map((d): ReqRow => ({
      id: d.id, kind: 'DEPOSIT', label: 'Deposit', memo: d.memo, date: d.occurred_on, status: d.status, suppressed: d.suppressed_reason,
      gross: d.amount_cents, retainage: 0, released: 0, net: d.amount_cents, invoice: d.invoice_number, error: d.error_text, failing: [], createdBy: d.created_by, deposit: d,
    })),
  ].sort((a, c) => (c.request?.created_at ?? c.deposit?.created_at ?? '').localeCompare(a.request?.created_at ?? a.deposit?.created_at ?? '')), [b.requests, b.deposits, failing]);

  const [mode, setMode] = useState<BillingUiMode | null>(p0.modes.initial);
  const [show, setShow] = useState<Show>('open');
  const [cursorId, setCursorId] = useState<string | null>(p0.initialRequestId ?? rows.find((r) => r.status === 'DRAFT' || r.status === 'REJECTED')?.id ?? null);
  const [notice, setNotice] = useState<{ id: string; text: string } | null>(null);
  const [voidRow, setVoidRow] = useState<ReqRow | null>(null);

  const visible = rows.filter((r) => (show === 'void' ? r.status === 'VOID' : show === 'open' ? ['DRAFT', 'EMITTED', 'REJECTED'].includes(r.status) : r.status !== 'VOID'));
  const cursor = rows.find((r) => r.id === cursorId) ?? null;

  const billed = billedToDate(b.requests);
  const held = heldToDate(b.requests, b.lines);
  const fin = b.financials;
  const retOut = b.retainage?.outstanding_cents ?? 0;
  const deposits = fin?.deposits_requested_cents ?? b.deposits.filter((d) => ['EMITTED', 'ISSUED', 'UNISSUED'].includes(d.status)).reduce((s, d) => s + d.amount_cents, 0);
  const rate = p0.contract?.retention_pct ?? 0;
  const draftOf = (g: string) => b.requests.some((r) => r.generated_by === g && (r.status === 'DRAFT' || (g === 'retainage_release' && r.status === 'REJECTED')));
  const billedMilestones = new Set(b.lines.filter((l) => { const r = b.requests.find((x) => x.id === l.billing_request_id); return r && r.status !== 'VOID'; }).flatMap((l) => [l.task_id, l.wbs_id]).filter((x): x is string => !!x));

  const approve = async (r: ReqRow) => {
    if (r.kind === 'DEPOSIT') {
      if (r.status !== 'REJECTED') return;
      const res = await run(`a:${r.id}`, 'post', `/api/deposits/${r.id}`, { op: 'resend' }, 'Sent the deposit request to Merit Books again', { quietError: true });
      setNotice(res.error ? { id: r.id, text: res.error.error } : null);
      return;
    }
    if (r.status !== 'DRAFT' && r.status !== 'REJECTED') return;
    const res = await run<{ status: string; resent: boolean; approval?: unknown }>(`a:${r.id}`, 'post', `/api/billing/${r.id}`, { op: 'approve' }, (d) =>
      chainPending(d.approval) ? approvalOutcome(d.approval, '', r.label)
        : d.status === 'EMITTED' ? `${d.resent ? 'Sent again' : 'Approved and sent'} to Merit Books. It numbers and posts the invoice` : 'Approved. Not sent: Merit Books is off or this is a sample job', { quietError: true });
    setNotice(res.error ? { id: r.id, text: res.error.error } : chainPending(res.data?.approval) ? { id: r.id, text: approvalOutcome(res.data?.approval, '', r.label) } : null);
  };

  const columns: QueueColumn<ReqRow>[] = [
    { id: 'what', header: 'Billing', cell: (r) => <><span className="l1">{r.label}</span><span className="l2">{r.memo ?? ' '}</span></> },
    { id: 'date', header: 'Date', width: 96, cell: (r) => <span className="l2">{shortDate(r.date)}</span> },
    { id: 'st', header: 'Status', width: 196, cell: (r) => <MarkStatus mark={billingMark(r.status, r.suppressed)} /> },
    { id: 'gross', header: 'Billed', numeric: true, width: 128, cell: (r) => m(r.released || r.gross) },
    { id: 'ret', header: 'Retainage', numeric: true, width: 112, cell: (r) => (r.released ? <span className="l2">released</span> : m(r.retainage)) },
    { id: 'net', header: 'Due', numeric: true, width: 128, cell: (r) => <b>{m(r.net)}</b> },
    { id: 'inv', header: 'Invoice', width: 132, cell: (r) => (r.invoice ? <span className="code">{r.invoice}</span> : <span className="l2">{r.status === 'EMITTED' ? 'Numbering' : '—'}</span>) },
  ];

  const sovPayApp = cursor?.request?.billing_subtype === 'SOV' ? b.payApps.find((x) => x.billing_request_id === cursor.id) ?? null : null;
  const sovLines = cursor?.request?.billing_subtype === 'SOV' ? b.lines.filter((l) => l.billing_request_id === cursor.id && l.line_type === 'STANDARD') : [];

  return (
    <div className="stack" style={{ gap: 24 }}>
      <div className="row" style={{ alignItems: 'flex-start', gap: 32, flexWrap: 'wrap' }}>
        <Figure dense label="Billed to date" value={m0(fin?.billed_to_date_cents ?? billed)} vs={[`of ${m0(p0.revisedContractCents)} revised contract`, `${p(p0.revisedContractCents > 0 ? (fin?.billed_to_date_cents ?? billed) / p0.revisedContractCents : null)} billed`]} href={`/jobs/${p0.jobId}?tab=contract`} linkLabel="Contract" />
        <Figure dense label="Left to bill" value={m0(p0.revisedContractCents - (fin?.billed_to_date_cents ?? billed))} vs={[`${m0(fin?.billed_net_to_date_cents ?? b.requests.filter((r) => ['EMITTED', 'ISSUED', 'UNISSUED'].includes(r.status) && r.billing_subtype !== 'RETAINAGE_RELEASE').reduce((s, r) => s + r.net_cents, 0))} billed net of retainage`]} href={`/jobs/${p0.jobId}?tab=job-cost`} linkLabel="Job cost" />
        <Figure dense label="Retainage outstanding" value={m0(retOut)} vs={[`${m0(b.retainage?.held_cents ?? 0)} held`, `${m0(b.retainage?.released_cents ?? 0)} released`]} href="/retainage" linkLabel="Retainage" />
        <Figure dense label="Deposits requested" value={m0(deposits)} vs={[`${b.deposits.filter((d) => d.status === 'ISSUED').length} issued by Merit Books`]} href="/billing" linkLabel="Billing queue" />
        {fin?.over_under_billing_cents != null && (
          <Figure dense label={fin.over_under_billing_cents >= 0 ? 'Over billed' : 'Under billed'} value={m0(Math.abs(fin.over_under_billing_cents))} vs={[`vs ${m0(fin.earned_revenue_cents ?? 0)} earned on cost`, 'Merit Books WIP is the book']} href={`/jobs/${p0.jobId}?tab=job-cost`} linkLabel="Job cost" />
        )}
      </div>

      <BooksNote booksPresent={p0.booksPresent && !p0.isSample} />
      {p0.isSample && <InlineNotice title="Sample job.">Approvals here are recorded but never sent to Merit Books.</InlineNotice>}

      {!readOnly && p0.modes.modes.length > 0 && mode && (
        <section className="sec" aria-label="Draft a billing request">
          <div className="sec-h">
            <h2 className="t-section">New {v.invoice_request.toLowerCase()}</h2>
            <span className="sp" />
            <Seg<BillingUiMode> aria-label="Billing mode" value={mode} onChange={setMode} items={p0.modes.modes.map((x) => ({ value: x, label: BILLING_UI_LABELS[x] }))} />
          </div>
          <p className="t-cap" style={{ marginBottom: 12 }}>{BILLING_UI_WHAT[mode]}</p>
          {mode === 'progress' && <ProgressForm jobId={p0.jobId} today={p0.today} onDrafted={setCursorId} revisedContractCents={p0.revisedContractCents} billedToDateCents={billed} heldToDateCents={held} rate={rate} contractPct={p0.contract?.pct_complete ?? null} hasDraft={draftOf('progress')} />}
          {mode === 'sov' && (
            <SovSection jobId={p0.jobId} versions={b.sovVersions} sovLines={b.sovLines} sovStatus={b.sovStatus} requests={b.requests} lines={b.lines} contract={p0.contract}
              revisedContractCents={p0.revisedContractCents} costCodes={p0.costCodes} today={p0.today} hasAcceptedEstimate={p0.hasAcceptedEstimate} onDrafted={setCursorId} />
          )}
          {mode === 'milestone' && <MilestoneForm jobId={p0.jobId} today={p0.today} onDrafted={setCursorId} tasks={b.tasks} wbs={b.wbs} billedIds={billedMilestones} revisedContractCents={p0.revisedContractCents} />}
          {mode === 'tm' && <TmForm jobId={p0.jobId} today={p0.today} onDrafted={setCursorId} />}
          {mode === 'fixed' && <FixedForm jobId={p0.jobId} today={p0.today} onDrafted={setCursorId} remainingCents={p0.revisedContractCents - billed} />}
          {mode === 'deposit' && <DepositForm jobId={p0.jobId} today={p0.today} revisedContractCents={p0.revisedContractCents} requestedCents={b.deposits.filter((d) => d.status !== 'VOID').reduce((s, d) => s + d.amount_cents, 0)} booksPresent={p0.booksPresent && !p0.isSample} />}
          {mode === 'retainage' && <RetainageForm jobId={p0.jobId} today={p0.today} onDrafted={setCursorId} outstandingCents={retOut} heldCents={b.retainage?.held_cents ?? 0} releasedCents={b.retainage?.released_cents ?? 0} inFlight={draftOf('retainage_release')} booksPresent={p0.booksPresent} />}
          {mode === 'allowance' && <AllowanceForm jobId={p0.jobId} onDrafted={setCursorId} allowances={b.allowances} coStage={p0.coStage} />}
        </section>
      )}
      {p0.modes.modes.length === 0 && (
        <InlineNotice title="This job type has no billing mode here.">
          {p0.modes.draws ? <>It bills through lender draws. <Link className="link" href="/draws">Open draws</Link></> : p0.modes.recurring ? 'It bills on a recurring service agreement.' : 'Set its billing modes in Settings.'}
        </InlineNotice>
      )}
      {p0.modes.modes.length > 0 && p0.modes.draws && <p className="t-cap">This job type also bills through lender draws. <Link className="link" href="/draws">Open draws</Link></p>}

      <section className="sec" aria-label="Billing requests on this job">
        <div className="sec-h">
          <h2 className="t-section">Requests</h2>
          <span className="sp" />
          <Seg<Show> aria-label="Show" value={show} onChange={setShow} items={[
            { value: 'open', label: 'Open', count: rows.filter((r) => ['DRAFT', 'EMITTED', 'REJECTED'].includes(r.status)).length },
            { value: 'all', label: 'All', count: rows.filter((r) => r.status !== 'VOID').length },
            { value: 'void', label: 'Void', count: rows.filter((r) => r.status === 'VOID').length },
          ]} />
        </div>
        <div className={cursor ? 'mp-split has-panel' : 'mp-split'}>
          <div className="mp-table" style={{ minWidth: 0 }}>
            {visible.length === 0 ? (
              <WidgetState state={rows.length === 0
                ? { kind: 'empty', title: 'Nothing billed yet', body: 'Draft the first request above. It stays a draft until someone other than the preparer approves it.' }
                : { kind: 'done', title: show === 'open' ? 'Nothing open' : 'Nothing here', body: show === 'open' ? 'Every request is issued, approved or void. Switch to All to see them.' : 'Switch the view above to see the others.' }} />
            ) : (
              <QueueTable
                aria-label="Billing requests"
                columns={columns}
                rows={visible}
                getRowId={(r) => r.id}
                cursorId={cursorId}
                onCursorChange={(id) => setCursorId(id)}
                openOnClick
                onOpen={(r) => setCursorId(r.id)}
                rowState={(r) => ({ done: r.status === 'VOID' || r.status === 'ISSUED' || r.status === 'UNISSUED', attn: r.status === 'REJECTED' || (r.status === 'DRAFT' && r.failing.length > 0) })}
                actions={readOnly ? [] : [{ key: 'a', label: 'approve and send', run: (rs) => rs.forEach((r) => void approve(r)) }]}
              />
            )}
          </div>
          {cursor && (
            <RequestPanel row={cursor} jobId={p0.jobId} lines={b.lines.filter((l) => l.billing_request_id === cursor.id)} mine={cursor.createdBy === p0.currentUserId}
              busy={busy === `a:${cursor.id}`} readOnly={readOnly} notice={notice?.id === cursor.id ? notice.text : null}
              onApprove={() => void approve(cursor)} onVoid={() => setVoidRow(cursor)} onClose={() => setCursorId(null)} />
          )}
        </div>
        {visible.length > 0 && <Keybar hints={[{ chord: 'j k', label: 'move' }, ...(!readOnly ? [{ chord: 'a', label: 'approve and send' }] : [])]} note="Merit Books numbers and posts every invoice" />}
      </section>

      {cursor?.request?.billing_subtype === 'SOV' && sovLines.length > 0 && (
        <section className="sec" aria-label={`${cursor.label} G702 and G703`}>
          <div className="sec-h"><h2 className="t-section">{cursor.label} · period ending {cursor.request.period_end ? shortDate(cursor.request.period_end) : '—'}</h2><span className="sp" /><MarkStatus mark={billingMark(cursor.status, cursor.suppressed)} /></div>
          <G703Table rows={sovLines.map((l) => ({ id: l.id, item: l.line_no, description: l.description, line: g703FromStored(l) }))}
            caption={`Billed ${money(cursor.gross)} this period, ${money(cursor.retainage)} retainage held, ${money(cursor.net)} due. Amounts as drafted by Merit Projects.`} />
          {sovPayApp && <div style={{ maxWidth: 560, marginTop: 24 }}><G702Table s={g702FromView(sovPayApp, cursor.request)} applicationNo={sovPayApp.application_no} /></div>}
        </section>
      )}

      <ConfirmDialog
        open={!!voidRow}
        onClose={() => setVoidRow(null)}
        tone="danger"
        title={`Void ${voidRow?.label ?? ''}`}
        confirmLabel="Void request"
        reason={{ label: 'Why?', placeholder: 'Wrong period; redrafting', minLength: 0 }}
        onConfirm={async (reason) => {
          if (!voidRow) return;
          const r = await run(`v:${voidRow.id}`, 'post', `/api/billing/${voidRow.id}`, { op: 'void', reason: reason?.trim() || null }, `Voided ${voidRow.label}`, { quietError: true });
          if (r.error) throw new Error(r.error.error);
        }}
      >
        {voidRow?.status === 'REJECTED' ? 'Merit Books rejected it, so nothing was invoiced. Voiding frees its amounts (and any billed time) to bill again.' : 'Nothing was sent. Its amounts (and any billed time or milestones) can be billed again.'}
      </ConfirmDialog>
    </div>
  );
}

function RequestPanel({ row, jobId, lines, mine, busy, readOnly, notice, onApprove, onVoid, onClose }: {
  row: ReqRow; jobId: string; lines: BillingBundle['lines']; mine: boolean; busy: boolean; readOnly: boolean; notice: string | null;
  onApprove: () => void; onVoid: () => void; onClose: () => void;
}) {
  const mark = billingMark(row.status, row.suppressed);
  const r = row.request;
  const canSend = !readOnly && (row.kind === 'BILLING' ? row.status === 'DRAFT' || row.status === 'REJECTED' : row.status === 'REJECTED');
  const blocked = row.kind === 'BILLING' && row.failing.length > 0;
  return (
    <Panel
      eyebrow={[row.label, mark.word]}
      title={row.memo ?? row.label}
      meta={`${money(row.net)} due · ${shortDate(row.date)}`}
      onClose={onClose}
      foot={canSend ? (
        <div className="btn-row" style={{ width: '100%' }}>
          {row.kind === 'BILLING' && <Button variant="danger" onClick={onVoid}>Void</Button>}
          <span className="sp" />
          <Button variant="primary" chord="a" disabled={busy || (row.kind === 'BILLING' && (mine || blocked))} title={mine && row.kind === 'BILLING' ? 'You prepared this request' : blocked ? 'Fix the checks above first' : undefined} onClick={onApprove}>
            {row.status === 'REJECTED' ? 'Send to Merit Books again' : 'Approve & send to Merit Books'}
          </Button>
        </div>
      ) : undefined}
    >
      <PanelSection title="Status">
        <ol className="stack" style={{ listStyle: 'none', gap: 6 }} aria-label="Status steps">
          <li className={row.status === 'DRAFT' ? 'b' : undefined}>1 · Drafted{r?.created_at ? ` ${shortDate(r.created_at.slice(0, 10))}` : ''}</li>
          <li className={row.status === 'EMITTED' ? 'b' : undefined}>2 · {row.status === 'UNISSUED' ? 'Approved here, not sent' : 'Sent, waiting on Merit Books'}{r?.emitted_at ?? row.deposit?.emitted_at ? ` ${shortDate((r?.emitted_at ?? row.deposit?.emitted_at ?? '').slice(0, 10))}` : ''}</li>
          <li className={row.status === 'ISSUED' || row.status === 'REJECTED' ? 'b' : undefined}>
            3 · {row.status === 'REJECTED' ? 'Rejected by Merit Books' : row.invoice ? <>Issued as <span className="code">{row.invoice}</span></> : 'Issued by Merit Books'}
          </li>
        </ol>
        {row.status === 'REJECTED' && <InlineNotice tone="neg" title="Merit Books did not issue it." role="alert">{row.error ?? 'No reason was given.'} Fix the cause, then send it again; it keeps its reference so it is never invoiced twice.</InlineNotice>}
        {row.status === 'UNISSUED' && <p className="t-cap" style={{ marginTop: 8 }}>{unissuedSentence(row.suppressed)}</p>}
        {row.status === 'EMITTED' && <p className="t-cap" style={{ marginTop: 8 }}>Merit Books gives the invoice its number and posts it. The number appears here after the next check.</p>}
      </PanelSection>
      {(row.status === 'DRAFT' || row.status === 'REJECTED') && row.failing.length > 0 && (
        <PanelSection><PreconditionNotices codes={row.failing} jobId={jobId} /></PanelSection>
      )}
      {notice && <PanelSection><InlineNotice tone="neg" title="Not sent." role="alert">{notice}</InlineNotice></PanelSection>}
      {mine && row.kind === 'BILLING' && (row.status === 'DRAFT' || row.status === 'REJECTED') && (
        <PanelSection><InlineNotice tone="info" title="You prepared this one.">Someone else approves and sends it; that keeps preparer and approver apart.</InlineNotice></PanelSection>
      )}
      <PanelSection title="Amounts">
        <KV items={[
          ...(row.released ? [{ term: 'Retainage released', value: m(row.released) }] : [{ term: 'Billed (gross)', value: m(row.gross) }, { term: 'Retainage held', value: m(row.retainage) }]),
          { term: 'Due on the invoice', value: <b>{m(row.net)}</b> },
          { term: 'Invoice date', value: shortDate(row.date) },
          ...(r?.period_start ? [{ term: 'Period', value: `${shortDate(r.period_start)}–${r.period_end ? shortDate(r.period_end) : ''}` }] : []),
          ...(r?.approved_at ? [{ term: 'Approved', value: shortDate(r.approved_at.slice(0, 10)) }] : []),
          ...(r?.issued_at ?? row.deposit?.issued_at ? [{ term: 'Issued', value: shortDate((r?.issued_at ?? row.deposit?.issued_at ?? '').slice(0, 10)) }] : []),
        ]} />
      </PanelSection>
      {lines.length > 0 && (
        <PanelSection title="Lines">
          <ul className="ev">
            {lines.map((l) => (
              <li key={l.id}>{l.description}<span className="dl" /><span className="v tnum">{money(l.amount_cents)}</span></li>
            ))}
          </ul>
        </PanelSection>
      )}
    </Panel>
  );
}
