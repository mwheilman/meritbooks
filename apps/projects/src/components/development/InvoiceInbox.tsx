'use client';

import { useState } from 'react';
import { Button, Field, InlineNotice, Input, QueueTable, Select, Status, money, type QueueColumn } from '@meritbooks/merit-ui';
import type { InboxItem } from '@/app/api/development/inbox/route';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, centsFrom, day, useBoard, useDo } from '@/components/dealer/common/depth';

type Band = 'NEW' | 'CONFIRMED' | 'DISMISSED' | 'ALL';
export interface DrawOption { id: string; jobId: string; label: string }
interface Draft { vendor: string; number: string; on: string; amount: string; subject: string; ref: string }
const EMPTY: Draft = { vendor: '', number: '', on: '', amount: '', subject: '', ref: '' };

/** The sponsor's central invoice inbox (RED-21): invoices arrive (email or logged here), get a suggested project and draw, duplicates are flagged, and one click puts each on its draw. */
export function InvoiceInbox({ companyId, today, draws }: { companyId: string; today: string; draws: DrawOption[] }) {
  const { readOnly } = useShell();
  const url = '/api/development/inbox';
  const [band, setBand] = useState<Band>('NEW');
  const b = useBoard<{ items: InboxItem[] }>(`${url}?company=${companyId}&status=${band}`);
  const { run, busy, error } = useDo(b.reload);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [d, setD] = useState<Draft>(EMPTY);
  const amount = d.amount ? centsFrom(d.amount) : null;
  const drawFor = (i: InboxItem) => pick[i.id] ?? i.suggested.draw_id ?? '';
  const confirm = async (i: InboxItem) => {
    const dup = !!i.duplicate_of;
    if (dup && !window.confirm('This looks like an invoice already on a draw (same vendor and number). Put it on anyway?')) return;
    await run(i.id, url, { op: 'confirm', itemId: i.id, drawId: drawFor(i), costCodeId: i.suggested.cost_code_id ?? null, commitmentId: i.suggested.commitment_id ?? null, allowDuplicate: dup }, 'On the draw');
  };
  const cols: QueueColumn<InboxItem>[] = [
    { id: 'v', header: 'Vendor', cell: (i) => <><span className="l1">{i.vendor_name ?? i.from_address ?? 'Unknown sender'}</span><span className="l2">{i.invoice_number ? `#${i.invoice_number} · ` : ''}{day(i.invoice_on ?? i.received_at, today)}</span></> },
    { id: 'a', header: 'Amount', numeric: true, width: 120, cell: (i) => (i.amount_cents == null ? '—' : money(i.amount_cents)) },
    { id: 'f', header: 'Flags', width: 150, cell: (i) => (i.duplicate_of ? <Status kind="risk" pip="risk">Possible duplicate</Status> : i.suggested.confidence ? <span className="l2">match {i.suggested.confidence.toLowerCase()}</span> : '—') },
    { id: 'd', header: 'Draw', width: 380, cell: (i) => (i.status !== 'NEW' ? <Status kind={i.status === 'CONFIRMED' ? 'ready' : 'blocked'} pip="closed">{i.status.toLowerCase()}</Status> : readOnly ? '—' : <span className="btn-row">
      <Select aria-label="Draw" value={drawFor(i)} onChange={(e) => setPick({ ...pick, [i.id]: e.target.value })}><option value="">Pick a draw</option>{draws.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</Select>
      <Button variant="primary" disabled={!drawFor(i) || busy === i.id} onClick={() => confirm(i)}>Put on draw</Button>
      <Button variant="quiet" disabled={busy === `x${i.id}`} onClick={() => run(`x${i.id}`, url, { op: 'dismiss', itemId: i.id }, 'Dismissed')}>Dismiss</Button></span>) },
  ];
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      {draws.length === 0 && <InlineNotice tone="info" title="No open draws.">Open a draft draw on the project to receive invoices into it.</InlineNotice>}
      {!readOnly && (
        <Section title="Log an invoice" meta="Invoices emailed to the inbox address arrive here on their own">
          <div className="ops-toolbar">
            <Field label="Vendor"><Input value={d.vendor} onChange={(e) => setD({ ...d, vendor: e.target.value })} /></Field>
            <Field label="Invoice #"><Input value={d.number} style={{ width: 110 }} onChange={(e) => setD({ ...d, number: e.target.value })} /></Field>
            <Field label="Date"><Input type="date" value={d.on} onChange={(e) => setD({ ...d, on: e.target.value })} /></Field>
            <Field label="Amount" error={d.amount && amount == null ? 'Dollars' : undefined}><Input value={d.amount} style={{ width: 120 }} onChange={(e) => setD({ ...d, amount: e.target.value })} /></Field>
            <Field label="Job / PO reference"><Input value={d.ref} onChange={(e) => setD({ ...d, ref: e.target.value })} placeholder="Job number or PO in the invoice" /></Field>
            <Button disabled={!d.vendor.trim() || (!!d.amount && amount == null) || busy === 'in'} onClick={async () => {
              const r = await run('in', url, { op: 'ingest', companyId, vendorName: d.vendor.trim(), invoiceNumber: d.number || null, invoiceOn: d.on || null, amountCents: amount, subject: d.subject || null, referenceText: d.ref || null }, 'Logged');
              if (r) setD(EMPTY);
            }}>Log it</Button>
          </div>
        </Section>
      )}
      <div className="btn-row" role="group" aria-label="Inbox by status">{(['NEW', 'CONFIRMED', 'DISMISSED', 'ALL'] as const).map((x) => <Button key={x} variant={band === x ? 'dark' : 'quiet'} aria-pressed={band === x} onClick={() => setBand(x)}>{x === 'NEW' ? 'To place' : x.charAt(0) + x.slice(1).toLowerCase()}</Button>)}</div>
      <BoardState b={b} what="Invoice inbox" />
      {b.data && (b.data.items.length === 0 ? <Empty title={band === 'NEW' ? 'Nothing to place' : 'Nothing here'} body="Every trade and soft-cost invoice lands in one inbox; it suggests the project and draw from the vendor, PO and job reference." /> :
        <div className="mp-table"><QueueTable aria-label="Invoices" columns={cols} rows={b.data.items} getRowId={(i) => i.id} rowState={(i) => ({ attn: !!i.duplicate_of })} /></div>)}
    </div>
  );
}
