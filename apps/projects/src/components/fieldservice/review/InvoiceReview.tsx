'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, Field, InlineNotice, Input, Select, Status, Tabs, Tag, Textarea, WidgetState, count, money, pct } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import type { FinancingRecon, FinancingRow, ReviewRow } from '@/lib/fieldservice/completion-types';
import { fmtWhen, useAction, words } from '../common/useAction';

export interface InvoiceReviewProps {
  companyId: string;
  reviews: ReviewRow[];
  error: string | null;
  financing: FinancingRecon | null;
  financingError: string | null;
  can: { approve: boolean; override: boolean; dispatch: boolean; financing: boolean };
  initialTab?: 'queue' | 'financing';
}

const REVIEW_STATUS: Record<ReviewRow['status'], { kind: 'ready' | 'track' | 'risk' | 'overdue' | 'blocked'; word: string }> = {
  PENDING: { kind: 'track', word: 'Ready to review' }, FLAGGED: { kind: 'risk', word: 'Flagged' }, RETURNED: { kind: 'overdue', word: 'Returned to tech' },
  APPROVED: { kind: 'ready', word: 'Sent to Books' }, VOID: { kind: 'blocked', word: 'Void' },
};

/**
 * The invoice review queue (FS-94): every completed customer visit waits here before anything goes
 * to Books, with rule flags (parts used but not billed, below the price-book floor, member pricing
 * mistakes, missing photos / checklists, undecided options). Approving drafts the billing request
 * and routes it through the approval engine; returning sends it back to the tech with the reason.
 * Text-to-pay once Books issued the invoice. The Financing tab tracks lender funding (FS-97).
 */
export function InvoiceReview(p: InvoiceReviewProps) {
  const { readOnly } = useShell();
  const [tab, setTab] = useState<'queue' | 'financing'>(p.initialTab ?? 'queue');
  const [open, setOpen] = useState<string | null>(null);
  const waiting = p.reviews.filter((r) => r.status !== 'APPROVED');
  return (
    <div className="stack">
      <Tabs aria-label="Invoice review" value={tab} onChange={setTab} items={[
        { value: 'queue', label: 'Review queue', count: count(waiting.length) },
        ...(p.can.financing ? [{ value: 'financing' as const, label: 'Financing', count: count(p.financing?.unfunded ?? 0) }] : []),
      ]} />
      {tab === 'queue' ? (
        p.error ? <WidgetState state={{ kind: 'error', title: 'The review queue did not load', body: p.error }} />
          : p.reviews.length === 0 ? <WidgetState state={{ kind: 'empty', title: 'Nothing to review', body: 'Completed customer visits land here before they are invoiced in Books.' }} />
          : (
            <section className="fs-card" aria-label="Review queue">
              <table className="fs-table">
                <thead><tr><th>Visit</th><th>Customer</th><th>Tech</th><th>Flags</th><th>Status</th>{p.reviews.some((r) => r.total_cents != null) && <th className="n">Total</th>}<th className="n">Age</th></tr></thead>
                <tbody>{p.reviews.map((r) => (
                  <ReviewRowView key={r.id} r={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} can={p.can} readOnly={readOnly} />
                ))}</tbody>
              </table>
            </section>
          )
      ) : <Financing recon={p.financing} error={p.financingError} readOnly={readOnly} />}
    </div>
  );
}

function ReviewRowView({ r, open, onToggle, can, readOnly }: { r: ReviewRow; open: boolean; onToggle: () => void; can: InvoiceReviewProps['can']; readOnly: boolean }) {
  const { run, busy, error } = useAction();
  const [override, setOverride] = useState('');
  const [reason, setReason] = useState('');
  const blocks = r.flags.filter((f) => f.severity === 'BLOCK');
  const st = REVIEW_STATUS[r.status];
  return (
    <>
      <tr data-click aria-expanded={open} onClick={onToggle} aria-selected={open}>
        <td><span className="l1">{r.number ?? 'Visit'}</span><span className="l2">{r.summary}</span></td>
        <td>{r.customer ?? '—'}</td>
        <td>{r.technician ?? '—'}</td>
        <td><span className="fs-flags">{r.flags.length === 0 ? <Tag tone="pos">Clean</Tag> : r.flags.slice(0, 3).map((f, i) => <Tag key={`${f.code}${i}`} tone={f.severity === 'BLOCK' ? 'neg' : 'warn'}>{words(f.code)}</Tag>)}
          {r.flags.length > 3 && <Tag>{`+${r.flags.length - 3}`}</Tag>}</span></td>
        <td><Status kind={st.kind}>{st.word}</Status>{r.invoice_number && <span className="l2">{r.invoice_number}</span>}</td>
        {r.total_cents !== undefined && r.total_cents !== null ? <td className="n">{money(r.total_cents)}{r.tax_cents ? <span className="l2">incl. {money(r.tax_cents)} tax</span> : null}</td> : <td className="n">—</td>}
        <td className="n">{r.age_days} d</td>
      </tr>
      {open && (
        <tr><td colSpan={7}>
          <div className="stack" style={{ padding: 8 }}>
            {error && <InlineNotice tone="neg" title="That did not go through.">{error}</InlineNotice>}
            {r.return_reason && r.status === 'RETURNED' && <InlineNotice tone="warn" title="Returned to the tech.">{r.return_reason}</InlineNotice>}
            {r.flags.length > 0 && <ul>{r.flags.map((f, i) => <li key={i} className={f.severity === 'BLOCK' ? 'fs-flag-block' : undefined}>{f.severity === 'BLOCK' ? 'Must fix: ' : 'Check: '}{f.message}</li>)}</ul>}
            <div className="fs-toolbar" style={{ marginBottom: 0 }}>
              <Link className="btn btn--quiet" href={`/dispatch/visit/${r.work_order_id}`}>Open the visit</Link>
              {!readOnly && r.status !== 'APPROVED' && <Button variant="quiet" disabled={!!busy} onClick={() => void run('refresh', '/api/fieldservice/invoice-review', { op: 'refresh', reviewId: r.id }, 'Flags refreshed')}>Re-check</Button>}
              <span className="sp" />
              {!readOnly && r.status === 'APPROVED' && r.billing_status === 'ISSUED' && (can.dispatch || can.approve) && (
                <Button disabled={!!busy} onClick={() => void run<{ link: string }>('pay', '/api/fieldservice/invoice-review', { op: 'pay_link', reviewId: r.id }, 'Pay link texted to the customer')}>Text pay link</Button>
              )}
            </div>
            {!readOnly && r.status !== 'APPROVED' && (
              <div className="fs-form">
                <Field label="Send back to the tech" help="What needs fixing"><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
                {blocks.length > 0 && can.override && <Field label="Approve anyway — reason" help="Billing approvers only; recorded with the invoice"><Textarea rows={2} value={override} onChange={(e) => setOverride(e.target.value)} /></Field>}
                <div className="fs-span fs-toolbar" style={{ marginBottom: 0 }}>
                  <Button variant="quiet" disabled={reason.trim().length < 3 || !!busy} onClick={() => void run('ret', '/api/fieldservice/invoice-review', { op: 'return', reviewId: r.id, reason }, 'Returned to the tech')}>Return</Button>
                  <span className="sp" />
                  {can.approve ? (
                    <Button variant="primary" disabled={!!busy || (blocks.length > 0 && override.trim().length < 5)}
                      onClick={() => void run<{ approval: { status: string; waitingOn: string | null } | null }>('ok', '/api/fieldservice/invoice-review', { op: 'approve', reviewId: r.id, overrideReason: override || null },
                        (d) => d.approval?.status === 'pending' ? `Sent for approval${d.approval.waitingOn ? ` — waiting on ${d.approval.waitingOn}` : ''}` : 'Approved — Books will mint the invoice')}>
                      Approve for invoicing</Button>
                  ) : <span className="t-cap">A billing person approves invoices.</span>}
                </div>
              </div>
            )}
            {r.completed_at && <span className="t-cap">Completed {fmtWhen(r.completed_at)}</span>}
          </div>
        </td></tr>
      )}
    </>
  );
}

const FIN_STATUS = ['APPLIED', 'APPROVED', 'DOCS_SIGNED', 'FUNDING_REQUESTED', 'FUNDED', 'CANCELLED'] as const;

function Financing({ recon, error, readOnly }: { recon: FinancingRecon | null; error: string | null; readOnly: boolean }) {
  if (error) return <WidgetState state={{ kind: 'error', title: 'Financing did not load', body: error }} />;
  if (!recon || recon.rows.length === 0) return <WidgetState state={{ kind: 'empty', title: 'No financed sales', body: 'A sale signed with a financing plan is tracked here until the lender funds it.' }} />;
  return (
    <section className="fs-card" aria-label="Financing">
      <div className="fs-card-h"><h2 className="t-section">Lender funding</h2><span className="sp" />
        <span className="t-cap">{count(recon.unfunded)} unfunded{recon.unfunded_cents != null ? ` · ${money(recon.unfunded_cents)}` : ''} · {count(recon.chase)} to chase</span></div>
      <table className="fs-table">
        <thead><tr><th>Sale</th><th>Lender</th><th>Status</th><th className="n">Financed</th><th className="n">Dealer fee</th><th className="n">Expected</th><th className="n">Funded</th><th className="n">Days</th><th aria-label="Update" /></tr></thead>
        <tbody>{recon.rows.map((f) => <FinRow key={f.id} f={f} readOnly={readOnly} />)}</tbody>
      </table>
      <p className="t-cap" style={{ padding: 12 }}>The lender receivable and the dealer fee post in Books; this tracks each loan until it is funded.</p>
    </section>
  );
}

function FinRow({ f, readOnly }: { f: FinancingRow; readOnly: boolean }) {
  const { run, busy, error } = useAction();
  const [status, setStatus] = useState<string>(f.status === 'SHORT_FUNDED' ? 'FUNDED' : f.status);
  const [funded, setFunded] = useState('');
  const cents = funded ? Math.round(Number(funded.replace(/[$,]/g, '')) * 100) : null;
  return (
    <tr>
      <td><span className="l1">{f.estimate_number ?? 'Sale'}</span><span className="l2">{f.customer ?? ''}</span>{error && <span className="l2 neg">{error}</span>}</td>
      <td>{words(f.provider)}{f.application_ref && <span className="l2">{f.application_ref}</span>}</td>
      <td>{f.chase ? <Status kind="overdue">{words(f.status)}</Status> : <Status kind={f.status === 'FUNDED' ? 'ready' : f.status === 'SHORT_FUNDED' ? 'risk' : 'track'}>{words(f.status)}</Status>}</td>
      <td className="n">{f.amount_financed_cents == null ? '—' : money(f.amount_financed_cents)}</td>
      <td className="n">{f.dealer_fee_cents == null ? '—' : <>{money(f.dealer_fee_cents)}{f.dealer_fee_pct != null && <span className="l2">{pct(f.dealer_fee_pct)}</span>}</>}</td>
      <td className="n">{f.expected_net_cents == null ? '—' : money(f.expected_net_cents)}</td>
      <td className="n">{f.funded_cents == null ? '—' : money(f.funded_cents)}{f.short_cents ? <span className="l2 neg">short {money(f.short_cents)}</span> : null}</td>
      <td className="n">{f.days_outstanding}</td>
      <td>{!readOnly && f.status !== 'FUNDED' && f.status !== 'CANCELLED' && (
        <div className="fs-flags">
          <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">{FIN_STATUS.map((s) => <option key={s} value={s}>{words(s)}</option>)}</Select>
          {status === 'FUNDED' && <Input inputMode="decimal" placeholder="Funded $" value={funded} onChange={(e) => setFunded(e.target.value)} aria-label="Funded amount" />}
          <Button variant="quiet" disabled={!!busy || (status === 'FUNDED' && cents == null)}
            onClick={() => void run('fin', '/api/fieldservice/financing', { op: 'update', financedId: f.id, status, fundedCents: cents }, 'Updated')}>Save</Button>
        </div>
      )}</td>
    </tr>
  );
}
