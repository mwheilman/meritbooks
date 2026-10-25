'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bands, Button, ButtonRow, Field, Input, QueueTable, Status, count, type QueueColumn } from '@meritbooks/merit-ui';
import { parseCreditMemo, WARRANTY_BRANDS } from '@/lib/dealer/warranty-adapters';
import { useMoneyText } from '@/components/money/useMoneyText';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, FilePick, day, pctText, useBoard, useDo } from '../common/depth';

interface Deadline {
  claim_id: string; claim_number: string | null; status: string; oem_brand: string | null; ro_number: string; serial_number: string | null; make: string | null; model: string | null;
  claimed_cents: number; approved_cents: number | null; credited_cents: number | null; submit_by: string | null; days_to_submit: number | null; response_due_on: string | null;
  retention_until: string | null; parts_returned_on: string | null; submit_at_risk: boolean; response_overdue: boolean; retain_parts: boolean;
}
interface Memo { id: string; memo_ref: string; memo_on: string; brand: string | null; total_cents: number; status: string }
interface MemoLine { id: string; memo_id: string; line_no: number; reference: string | null; claim_number: string | null; serial_number: string | null; description: string | null; amount_cents: number; proposed_claim_id: string | null; matched_claim_id: string | null; confidence: number | null; match_status: string }
interface Data { deadlines: Deadline[]; memos: Memo[]; lines: MemoLine[] }

type Band = 'FILE' | 'ANSWER' | 'RETAIN' | 'MATCH';

/** Warranty deadlines (file by, answer due, parts to keep) and OEM credit memos matched to claims. */
export function CreditsView({ companyId, today }: { companyId: string; today: string }) {
  const { readOnly } = useShell();
  const router = useRouter();
  const money = useMoneyText('contract');
  const b = useBoard<Data>(`/api/dealer/warranty-credits?company=${companyId}`);
  const { run, busy, error } = useDo(b.reload);
  const [band, setBand] = useState<Band>('FILE');
  const [memo, setMemo] = useState({ ref: '', on: today, brand: 'KUBOTA' });
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const parsed = file ? parseCreditMemo(file.text) : null;

  const state = <BoardState b={b} what="Warranty deadlines" />;
  const d = b.data;
  const toFile = d?.deadlines.filter((x) => ['DRAFT', 'RETURNED'].includes(x.status)) ?? [];
  const toAnswer = d?.deadlines.filter((x) => x.status === 'SUBMITTED') ?? [];
  const toRetain = d?.deadlines.filter((x) => x.retain_parts) ?? [];
  const open = d?.lines.filter((l) => l.match_status === 'PROPOSED' || l.match_status === 'UNMATCHED') ?? [];
  const claimLabel = (id: string | null) => (id ? d?.deadlines.find((x) => x.claim_id === id)?.claim_number ?? 'claim' : null);

  const cols: QueueColumn<Deadline>[] = [
    { id: 'c', header: 'Claim', width: 150, cell: (x) => <><span className="l1 code">{x.claim_number ?? 'Draft'}</span><span className="l2">{x.ro_number}</span></> },
    { id: 'u', header: 'Unit', cell: (x) => <span className="l2">{[x.oem_brand ?? x.make, x.model, x.serial_number].filter(Boolean).join(' · ')}</span> },
    { id: 'a', header: 'Claimed', numeric: true, width: 110, cell: (x) => money(x.claimed_cents) },
    { id: 'd', header: band === 'ANSWER' ? 'Answer due' : band === 'RETAIN' ? 'Keep parts until' : 'File by', width: 170, cell: (x) => {
      const on = band === 'ANSWER' ? x.response_due_on : band === 'RETAIN' ? x.retention_until : x.submit_by;
      const risk = band === 'ANSWER' ? x.response_overdue : band === 'FILE' ? x.submit_at_risk : false;
      return on ? <Status kind={risk ? 'overdue' : 'track'} pip={risk ? 'overdue' : 'open'}>{day(on, today)}{band === 'FILE' && x.days_to_submit != null ? ` · ${x.days_to_submit < 0 ? `${-x.days_to_submit} late` : `${x.days_to_submit} days`}` : ''}</Status> : '—';
    } },
  ];
  const lineCols: QueueColumn<MemoLine>[] = [
    { id: 'r', header: 'Memo line', width: 180, cell: (l) => <><span className="l1">{l.claim_number ?? l.reference ?? `Line ${l.line_no}`}</span><span className="l2">{l.serial_number ?? l.description ?? ' '}</span></> },
    { id: 'a', header: 'Credit', numeric: true, width: 110, cell: (l) => money(l.amount_cents) },
    { id: 'm', header: 'Proposed claim', cell: (l) => (l.proposed_claim_id ? <><Link className="nlink" href={`/warranty/${l.proposed_claim_id}`}>{claimLabel(l.proposed_claim_id)}</Link><span className="l2">{pctText(l.confidence, 0)} sure</span></> : <span className="l2">No match found</span>) },
    ...(readOnly ? [] : [{ id: 'x', header: <span className="sr">Decide</span>, width: 220, cell: (l: MemoLine) => (
      <ButtonRow>
        {l.proposed_claim_id && <Button disabled={busy === l.id} onClick={() => void run(l.id, '/api/dealer/warranty-credits', { op: 'confirm', lineId: l.id, claimId: l.proposed_claim_id }, 'Matched the credit')}>Confirm</Button>}
        <Button variant="quiet" disabled={busy === l.id} onClick={() => void run(l.id, '/api/dealer/warranty-credits', { op: 'confirm', lineId: l.id, ignore: true }, 'Set the line aside')}>Not a claim</Button>
      </ButtonRow>
    ) } satisfies QueueColumn<MemoLine>]),
  ];
  const rows = band === 'FILE' ? toFile : band === 'ANSWER' ? toAnswer : toRetain;

  return (
    <div className="stack">
      {error && <Failure text={error} />}
      {state}
      {d && (
        <>
          <Bands<Band> aria-label="Warranty work" value={band} onChange={setBand} items={[
            { value: 'FILE', label: 'To file', count: count(toFile.length), caption: `${count(toFile.filter((x) => x.submit_at_risk).length)} within a week` },
            { value: 'ANSWER', label: 'Waiting on the OEM', count: count(toAnswer.length), caption: `${count(toAnswer.filter((x) => x.response_overdue).length)} answer overdue` },
            { value: 'RETAIN', label: 'Parts to keep', count: count(toRetain.length), caption: 'until the retention date' },
            { value: 'MATCH', label: 'Credits to match', count: count(open.length), caption: `${count(d.memos.length)} memos` },
          ]} />
          {band !== 'MATCH' ? (rows.length === 0
            ? <Empty title="Nothing here" body="Claims show here when they are due to file, waiting on an answer, or their parts must be kept for the manufacturer." />
            : <div className="mp-table"><QueueTable aria-label="Claims" columns={cols} rows={rows} getRowId={(x) => x.claim_id} openOnClick onOpen={(x) => router.push(`/warranty/${x.claim_id}`)} rowState={(x) => ({ attn: x.submit_at_risk || x.response_overdue })} /></div>)
            : (
              <>
                {!readOnly && (
                  <Section title="Import a credit memo" meta="The OEM’s statement as CSV">
                    <div className="ops-toolbar">
                      <Field label="Memo number"><Input value={memo.ref} onChange={(e) => setMemo({ ...memo, ref: e.target.value })} style={{ width: 140 }} /></Field>
                      <Field label="Memo date"><Input type="date" value={memo.on} onChange={(e) => setMemo({ ...memo, on: e.target.value })} /></Field>
                      <Field label="Manufacturer"><select className="select" value={memo.brand} onChange={(e) => setMemo({ ...memo, brand: e.target.value })}>{WARRANTY_BRANDS.map((x) => <option key={x} value={x}>{x}</option>)}<option value="">Other</option></select></Field>
                      <FilePick label="Choose statement" accept=".csv,.txt,.tsv" onText={(name, text) => setFile({ name, text })} />
                      <Button variant="primary" disabled={!file || !memo.ref.trim() || !parsed?.lines.length || busy === 'imp'} onClick={async () => {
                        if (await run('imp', '/api/dealer/warranty-credits', { op: 'import', companyId, memoRef: memo.ref.trim(), memoOn: memo.on, brand: memo.brand || null, text: file!.text }, (r: { proposed?: number }) => `Imported; ${count(r.proposed ?? 0)} lines matched to claims`)) setFile(null);
                      }}>Import {parsed ? `${count(parsed.lines.length)} lines` : ''}</Button>
                    </div>
                    {parsed?.issues.slice(0, 3).map((i) => <p key={i} className="t-cap neg">{i}</p>)}
                  </Section>
                )}
                {open.length === 0
                  ? <Empty title="Every credit line is matched" body="Import the manufacturer’s credit memo; each line is matched to a claim by claim number, serial and amount for you to confirm." />
                  : <div className="mp-table"><QueueTable aria-label="Credit lines to match" columns={lineCols} rows={open} getRowId={(l) => l.id} openOnClick onOpen={(l) => { if (l.proposed_claim_id) router.push(`/warranty/${l.proposed_claim_id}`); }} /></div>}
              </>
            )}
        </>
      )}
    </div>
  );
}
