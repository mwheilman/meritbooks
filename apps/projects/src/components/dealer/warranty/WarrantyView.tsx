'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  Bands, Button, Figure, MoneyInput, QueueTable, Search, Status, WidgetState, count, shortDate, type QueueColumn,
} from '@meritbooks/merit-ui';
import { useMoneyText } from '@/components/money/useMoneyText';
import { BOOKS_OUTCOME, WARRANTY_BANDS, deadlineMark, outboxMark } from '@/lib/pm/dealer/labels';
import type { WarrantyBoard } from '@/lib/pm/dealer/store-queries';
import type { SettledClaim, WarrantyClaimStatus, WarrantyOutstandingRow } from '@/lib/pm/dealer/types';
import { CLAIM_STATUS } from '@/lib/pm/ops/labels';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, StatusMark } from '@/components/ops/common/bits';
import { useStore } from '../common/useStore';

type Band = WarrantyClaimStatus | 'SETTLED';

export interface WarrantyViewProps {
  data: WarrantyBoard;
  booksPresent: boolean;
  today: string;
  initialBand: Band | null;
}

/** Claims the manufacturer still owes, filing deadlines, and what Merit Books recorded when the credit came in. */
export function WarrantyView(p: WarrantyViewProps) {
  const money = useMoneyText('contract');
  const { readOnly } = useShell();
  const { act, busy, error } = useStore();
  const d = p.data;
  const inBand = (b: Band) => (b === 'SETTLED' ? [] : d.open.filter((c) => c.status === b));
  const first: Band = p.initialBand ?? (d.open.some((c) => c.status === 'DRAFT' && c.deadline_at_risk) ? 'DRAFT' : (['RETURNED', 'DRAFT', 'SUBMITTED', 'APPROVED'] as Band[]).find((b) => inBand(b).length) ?? 'SUBMITTED');
  const [band, setBand] = useState<Band>(first);
  const [q, setQ] = useState('');
  const [amount, setAmount] = useState<Record<string, number | null>>({});

  const t = q.trim().toLowerCase();
  const match = <R extends { claim_number: string | null; ro_number: string | null; payer_customer_id: string }>(xs: R[]): R[] => (t ? xs.filter((c) => [c.claim_number, c.ro_number, d.customers[c.payer_customer_id]].filter(Boolean).join(' ').toLowerCase().includes(t)) : xs);
  const owed = d.open.filter((c) => c.status !== 'DRAFT');
  const atRisk = d.open.filter((c) => c.deadline_at_risk);
  const short = d.settled.filter((c) => c.books_outcome !== 'CREDITED');
  const shortCents = short.reduce((s, c) => s + c.short_paid_cents + (c.books_outcome === 'REJECTED' ? c.claimed_cents : 0), 0);

  const advance = (c: WarrantyOutstandingRow, to: WarrantyClaimStatus, label: string) =>
    void act(`c:${c.claim_id}`, 'post', `/api/ops/claims/${c.claim_id}`, { op: 'advance', to, amountCents: to === 'APPROVED' || to === 'PAID' ? amount[c.claim_id] ?? null : null }, label);

  const openCols: QueueColumn<WarrantyOutstandingRow>[] = [
    { id: 'n', header: 'Claim', width: 140, cell: (c) => <><Link className="l1 code nlink" href={`/warranty/${c.claim_id}`}>{c.claim_number ?? 'Draft'}</Link><span className="l2">{c.serial_number ? `S/N ${c.serial_number}` : ' '}</span></> },
    { id: 'ro', header: 'Repair order', width: 150, cell: (c) => <><Link className="l1 nlink" href={`/work-orders?wo=${c.work_order_id}`}>{c.ro_number ?? 'RO'}</Link><span className="l2">{d.customers[c.payer_customer_id] ?? 'Manufacturer'}</span></> },
    { id: 'st', header: 'Status', width: 170, cell: (c) => <><StatusMark mark={CLAIM_STATUS[c.status]} />{c.last_event_status && <span className="l2">{outboxMark(c.last_event_status).word}</span>}</> },
    { id: 'cl', header: 'Claimed', numeric: true, width: 110, cell: (c) => money(c.claimed_cents) },
    { id: 'ap', header: 'Approved', numeric: true, width: 110, cell: (c) => (c.approved_cents == null ? '—' : money(c.approved_cents)) },
    { id: 'os', header: 'Outstanding', numeric: true, width: 120, cell: (c) => (c.status === 'DRAFT' ? '—' : <b>{money(c.outstanding_cents)}</b>) },
    {
      id: 'dl', header: 'Deadline or age', width: 160,
      cell: (c) => { const m = deadlineMark(c.filing_deadline, c.status, p.today); return m ? <Status kind={m.kind} pip={m.pip}>{m.word}</Status> : c.days_outstanding != null ? <span className={c.days_outstanding > 60 ? 'neg b' : undefined}>{count(c.days_outstanding)} days out</span> : '—'; },
    },
    ...(readOnly ? [] : [{
      id: 'a', header: <span className="sr">Next</span>, width: 260,
      cell: (c: WarrantyOutstandingRow) => (
        <div className="btn-row">
          {c.status === 'DRAFT' && <Button disabled={busy === `c:${c.claim_id}`} onClick={() => advance(c, 'SUBMITTED', 'Submitted the claim')}>Submit</Button>}
          {c.status === 'SUBMITTED' && (
            <>
              <MoneyInput aria-label="Approved amount" valueCents={amount[c.claim_id] ?? null} onChangeCents={(v) => setAmount({ ...amount, [c.claim_id]: v })} placeholder={money(c.claimed_cents)} style={{ width: 100 }} />
              <Button disabled={busy === `c:${c.claim_id}`} onClick={() => advance(c, 'APPROVED', 'Recorded the approval')}>Approved</Button>
              <Button variant="quiet" disabled={busy === `c:${c.claim_id}`} onClick={() => advance(c, 'RETURNED', 'Marked returned for information')}>Returned</Button>
            </>
          )}
          {c.status === 'RETURNED' && (
            <>
              <Button disabled={busy === `c:${c.claim_id}`} onClick={() => advance(c, 'SUBMITTED', 'Resubmitted the claim')}>Resubmit</Button>
              <Button variant="quiet" disabled={busy === `c:${c.claim_id}`} onClick={() => advance(c, 'WRITTEN_OFF', 'Wrote the claim off')}>Write off</Button>
            </>
          )}
          {c.status === 'APPROVED' && (p.booksPresent
            ? <span className="t-cap">Merit Books records the credit</span>
            : <Button disabled={busy === `c:${c.claim_id}`} onClick={() => advance(c, 'PAID', 'Marked paid')}>Paid</Button>)}
        </div>
      ),
    } satisfies QueueColumn<WarrantyOutstandingRow>]),
  ];

  const settledCols: QueueColumn<SettledClaim>[] = [
    { id: 'n', header: 'Claim', width: 140, cell: (c) => <span className="l1 code">{c.claim_number ?? 'Claim'}</span> },
    { id: 'ro', header: 'Repair order', width: 150, cell: (c) => <><Link className="l1 nlink" href={`/work-orders?wo=${c.work_order_id}`}>{c.ro_number ?? 'RO'}</Link><span className="l2">{d.customers[c.payer_customer_id] ?? 'Manufacturer'}</span></> },
    { id: 'o', header: 'Merit Books', width: 160, cell: (c) => <><StatusMark mark={BOOKS_OUTCOME[c.books_outcome]} />{c.books_paid_on && <span className="l2">{shortDate(c.books_paid_on, p.today)}{c.books_credit_ref ? ` · ${c.books_credit_ref}` : ''}</span>}</> },
    { id: 'cl', header: 'Claimed', numeric: true, width: 110, cell: (c) => money(c.claimed_cents) },
    { id: 'pd', header: 'Credited', numeric: true, width: 110, cell: (c) => money(c.paid_cents) },
    { id: 'sh', header: 'Short', numeric: true, width: 110, cell: (c) => { const x = c.books_outcome === 'REJECTED' ? c.claimed_cents : c.short_paid_cents; return x ? <span className="neg b">{money(x)}</span> : '—'; } },
    { id: 'r', header: 'Reason', cell: (c) => <span className="l2">{c.reason ?? ' '}</span> },
  ];

  return (
    <div className="stack">
      <div className="dl-strip">
        <Figure dense label="Owed by manufacturers" value={money(owed.reduce((s, c) => s + c.outstanding_cents, 0), { decimals: 0 })} vs={[`${count(owed.length)} claims submitted or approved`, `${count(owed.filter((c) => (c.days_outstanding ?? 0) > 60).length)} out over 60 days`]} href="/warranty?band=SUBMITTED" linkLabel="Submitted claims" />
        <Figure dense label="Deadlines this week" value={count(atRisk.length)} vs={[`${count(d.open.filter((c) => c.status === 'DRAFT').length)} drafts to file`, atRisk.length ? 'file these first' : 'none at risk']} href="/warranty?band=DRAFT" linkLabel="Drafts" />
        <Figure dense label="Short or rejected, 90 days" value={money(shortCents, { decimals: 0 })} vs={[`${count(short.length)} of ${count(d.settled.length)} settled`, 'recorded by Merit Books']} href="/warranty?band=SETTLED" linkLabel="Settled claims" />
      </div>
      <div className="ops-toolbar">
        <div style={{ width: 300 }}><Search aria-label="Find a claim" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Claim, RO or manufacturer" slashToFocus /></div>
        <span className="sp" />
        <span className="t-cap">Draft claims from a repair order’s warranty lines on the RO itself.</span>
        <Link className="link" href="/warranty/credits">Deadlines and credit memos</Link>
      </div>
      {error && <Failure text={error} />}
      <Bands<Band> aria-label="Claims by status" value={band} onChange={setBand}
        items={WARRANTY_BANDS.map((b) => ({ value: b.value, label: b.label, count: count(b.value === 'SETTLED' ? d.settled.length : inBand(b.value).length), caption: b.caption }))} />
      <div className="mp-table">
        {band === 'SETTLED' ? (
          match(d.settled).length === 0
            ? <WidgetState state={{ kind: 'done', title: 'Nothing settled in the last 90 days', body: 'When Merit Books records a manufacturer credit, short-pay or rejection, it shows here with the reason.' }} />
            : <QueueTable aria-label="Settled claims" columns={settledCols} rows={match(d.settled)} getRowId={(c) => c.claim_id} rowState={(c) => ({ attn: c.books_outcome !== 'CREDITED' })} />
        ) : match(inBand(band)).length === 0 ? (
          <WidgetState state={d.open.length === 0 && d.settled.length === 0
            ? { kind: 'empty', title: 'No warranty claims yet', body: 'Put the manufacturer’s work on warranty pay lines on the repair order, then create the claim from the RO. It shows here until the credit comes in.' }
            : { kind: 'done', title: `Nothing ${WARRANTY_BANDS.find((b) => b.value === band)?.label.toLowerCase()}`, body: 'Pick another band above.' }} />
        ) : (
          <QueueTable aria-label="Open warranty claims" columns={openCols} rows={match(inBand(band))} getRowId={(c) => c.claim_id}
            rowState={(c) => ({ attn: c.deadline_at_risk || c.status === 'RETURNED' })} />
        )}
      </div>
    </div>
  );
}
