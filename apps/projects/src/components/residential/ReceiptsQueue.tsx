'use client';

import { useState } from 'react';
import { Bands, Button, Input, QueueTable, Select, Status, money, type QueueColumn } from '@meritbooks/merit-ui';
import type { ReceiptRow } from '@/app/api/residential/receipts/route';
import { useShell } from '@/components/shell/ShellContext';
import { Failure } from '@/components/ops/common/bits';
import { BoardState, Empty, day, useBoard, useDo } from '@/components/dealer/common/depth';

type Band = 'CAPTURED' | 'CODED' | 'ALL';
interface CostCode { id: string; code: string; name: string }

/** Receipts and supply-house card charges from the field (RES-62): uncoded first; the office codes each to a cost code (Books gets the coding). */
export function ReceiptsQueue({ companyId, today, costCodes }: { companyId: string; today: string; costCodes: CostCode[] }) {
  const { readOnly } = useShell();
  const [band, setBand] = useState<Band>('CAPTURED');
  const b = useBoard<{ receipts: ReceiptRow[]; counts: { CAPTURED: number; CODED: number; SENT: number; ALL: number } }>(`/api/residential/receipts?company=${companyId}&status=${band}`);
  const { run, busy, error } = useDo(b.reload);
  const [pick, setPick] = useState<Record<string, { cc: string; ref: string }>>({});
  const cols: QueueColumn<ReceiptRow>[] = [
    { id: 'v', header: 'Vendor', cell: (r) => <><span className="l1">{r.vendor_name ?? 'Receipt'}</span><span className="l2">{r.card_last4 ? `card ••${r.card_last4} · ` : ''}{day(r.purchased_on ?? r.created_at, today)}</span></> },
    { id: 'a', header: 'Amount', numeric: true, width: 110, cell: (r) => (r.amount_cents == null ? '—' : money(r.amount_cents)) },
    { id: 's', header: 'Status', width: 110, cell: (r) => <Status kind={r.status === 'CAPTURED' ? 'risk' : 'ready'} pip="open">{r.status.toLowerCase()}</Status> },
    { id: 'c', header: 'Cost code', width: 360, cell: (r) => (readOnly || r.status !== 'CAPTURED' ? (costCodes.find((c) => c.id === r.cost_code_id)?.code ?? '—') : <span className="btn-row">
      <Select aria-label="Cost code" value={pick[r.id]?.cc ?? ''} onChange={(e) => setPick({ ...pick, [r.id]: { cc: e.target.value, ref: pick[r.id]?.ref ?? '' } })}><option value="">Pick</option>{costCodes.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</Select>
      <Input aria-label="Books card transaction" placeholder="Card txn ref" value={pick[r.id]?.ref ?? ''} onChange={(e) => setPick({ ...pick, [r.id]: { cc: pick[r.id]?.cc ?? '', ref: e.target.value } })} style={{ width: 120 }} />
      <Button disabled={!pick[r.id]?.cc || busy === r.id} onClick={() => run(r.id, '/api/residential/receipts', { receiptId: r.id, costCodeId: pick[r.id]!.cc, booksTxnRef: pick[r.id]!.ref || null }, 'Coded')}>Code</Button></span>) },
  ];
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <Bands<Band> aria-label="Receipts by status" value={band} onChange={setBand} items={[{ value: 'CAPTURED', label: 'To code', count: b.data?.counts.CAPTURED ?? '—' }, { value: 'CODED', label: 'Coded', count: b.data ? b.data.counts.CODED + b.data.counts.SENT : '—' }, { value: 'ALL', label: 'All', count: b.data?.counts.ALL ?? '—' }]} />
      <BoardState b={b} what="Receipts" />
      {b.data && (b.data.receipts.length === 0 ? <Empty title="No receipts here" body="Crews snap receipts from the phone on the job they are on; they land here to code." /> :
        <div className="mp-table"><QueueTable aria-label="Receipts" columns={cols} rows={b.data.receipts} getRowId={(r) => r.id} /></div>)}
    </div>
  );
}
