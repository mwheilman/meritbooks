'use client';

import { useMemo, useState } from 'react';
import { Bands, Button, ButtonRow, Field, Input, Status, Textarea, count } from '@meritbooks/merit-ui';
import { parseVendorEmail } from '@/lib/design/inbox-parse';
import type { InboxMessage, InboxProposal } from '@/app/api/design/inbox/route';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, day, pctText, useBoard, useDo } from '@/components/dealer/common/depth';

const KIND_WORD: Record<string, string> = { ACKNOWLEDGEMENT: 'Acknowledgement', SHIP_NOTICE: 'Shipped', BACKORDER: 'Backorder', INVOICE: 'Invoice', DELIVERY: 'Delivered', OTHER: 'Other' };
const FIELD_WORD: Record<string, string> = { status: 'Status', acknowledged_on: 'Acknowledged', expected_on: 'Expected delivery', shipped_on: 'Shipped', tracking_ref: 'Tracking', unit_cost_cents: 'Unit cost' };

/**
 * Forwarded vendor email, read by rules (no model): PO numbers, sidemarks, ship and delivery dates,
 * tracking, prices. Each proposed change to a component is applied or rejected by a person; price
 * changes and anything uncertain need an approver.
 */
export function InboxView({ companyId, today }: { companyId: string; today: string }) {
  const { readOnly } = useShell();
  const [st, setSt] = useState<'OPEN' | 'ALL'>('OPEN');
  const b = useBoard<{ messages: InboxMessage[]; proposals: InboxProposal[] }>(`/api/design/inbox?company=${companyId}&status=${st}`);
  const { run, busy, error } = useDo(b.reload);
  const [m, setM] = useState({ from: '', subject: '', body: '' });
  const preview = useMemo(() => (m.subject || m.body ? parseVendorEmail(m.subject, m.body, today) : null), [m, today]);
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      {!readOnly && (
        <Section title="Paste a vendor email" meta="Or forward it to the studio inbox when the mail hook is connected">
          <div className="ops-toolbar">
            <Field label="From"><Input value={m.from} onChange={(e) => setM({ ...m, from: e.target.value })} placeholder="orders@vendor.com" style={{ width: 240 }} /></Field>
            <Field label="Subject"><Input value={m.subject} onChange={(e) => setM({ ...m, subject: e.target.value })} style={{ width: 360 }} /></Field>
          </div>
          <Field label="Body"><Textarea rows={6} value={m.body} onChange={(e) => setM({ ...m, body: e.target.value })} /></Field>
          {preview && <p className="t-cap">Read as {KIND_WORD[preview.kind]} · POs {preview.po_numbers.join(', ') || 'none'} · sidemarks {preview.sidemarks.join(', ') || 'none'}{preview.dates.ship_on ? ` · ships ${day(preview.dates.ship_on, today)}` : ''}{preview.dates.delivery_on ? ` · delivers ${day(preview.dates.delivery_on, today)}` : ''}{preview.tracking.length ? ` · tracking ${preview.tracking.join(', ')}` : ''}</p>}
          <Button variant="primary" disabled={!m.from.trim() || (!m.subject.trim() && !m.body.trim()) || busy === 'in'} onClick={async () => {
            if (await run('in', '/api/design/inbox', { op: 'ingest', companyId, from: m.from.trim(), subject: m.subject, body: m.body }, (r: { proposals?: unknown[] }) => `Read the email; ${count(Array.isArray(r.proposals) ? r.proposals.length : 0)} changes proposed`)) setM({ from: '', subject: '', body: '' });
          }}>Read it</Button>
        </Section>
      )}
      <Bands<'OPEN' | 'ALL'> aria-label="Messages" value={st} onChange={setSt} items={[{ value: 'OPEN', label: 'To review', count: st === 'OPEN' && b.data ? count(b.data.messages.length) : '' }, { value: 'ALL', label: 'All', count: st === 'ALL' && b.data ? count(b.data.messages.length) : '' }]} />
      <BoardState b={b} what="The vendor inbox" />
      {b.data && (b.data.messages.length === 0 ? <Empty title="Nothing to review" body="Vendor acknowledgements, ship notices and backorders land here, matched to the components they are about." /> : b.data.messages.map((msg) => {
        const props = b.data!.proposals.filter((p) => p.message_id === msg.id);
        return (
          <Section key={msg.id} title={msg.subject || `${KIND_WORD[msg.kind] ?? 'Vendor email'} from ${msg.from_address}`} meta={`${msg.from_address} · ${day(msg.received_at, today)} · ${KIND_WORD[msg.kind] ?? msg.kind}`}
            actions={!readOnly && (msg.status === 'NEW' || msg.status === 'PROPOSED') ? <Button variant="quiet" disabled={busy === msg.id} onClick={() => void run(msg.id, '/api/design/inbox', { op: 'dismiss', messageId: msg.id }, 'Dismissed')}>Dismiss</Button> : undefined}>
            {props.length === 0 ? <p className="t-cap">{msg.match_status === 'UNMATCHED' ? 'No component matched this email’s PO numbers or sidemarks.' : 'Nothing to change.'}</p> : (
              <table className="ops-mini" aria-label="Proposed changes">
                <thead><tr><th>Change</th><th>Was</th><th>Becomes</th><th className="n">Sure</th><th /></tr></thead>
                <tbody>{props.map((p) => (
                  <tr key={p.id}><td>{FIELD_WORD[p.field] ?? p.field.replace(/_/g, ' ')}{p.needs_approval ? <div className="t-cap">needs an approver</div> : null}</td><td>{p.old_value ?? '—'}</td><td><b>{p.new_value ?? '—'}</b></td><td className="n">{pctText(p.confidence, 0)}</td>
                    <td>{p.status === 'PROPOSED' && !readOnly ? <ButtonRow>
                      <Button disabled={busy === p.id} onClick={() => void run(p.id, '/api/design/inbox', { op: 'decide', proposalId: p.id, decision: 'apply' }, 'Applied')}>Apply</Button>
                      <Button variant="quiet" disabled={busy === p.id} onClick={() => void run(p.id, '/api/design/inbox', { op: 'decide', proposalId: p.id, decision: 'reject' }, 'Rejected')}>Reject</Button>
                    </ButtonRow> : <Status kind={p.status === 'APPLIED' ? 'ready' : 'blocked'} pip="closed">{p.status.toLowerCase()}</Status>}</td></tr>
                ))}</tbody>
              </table>
            )}
          </Section>
        );
      }))}
    </div>
  );
}
