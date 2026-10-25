'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, ButtonRow, Check, Field, InlineNotice, Input, KV, Select, Status, Textarea, count, toast } from '@meritbooks/merit-ui';
import { daysLeft, missingLabels, packetText, type ClaimPacket } from '@/lib/dealer/warranty-adapters';
import { useMoneyText } from '@/components/money/useMoneyText';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, centsFrom, day, useBoard, useDo } from '../common/depth';

interface ClaimData {
  claim: Record<string, string | number | null> & { id: string; status: string; claimed_cents: number; claim_number: string | null };
  readiness: { ready: boolean; missing: string[]; brand: string | null; channel: 'DIRECT' | 'PORTAL'; submit_by: string | null; days_left: number | null; response_due_on: string | null; retention_days: number | null };
  parts: Array<{ id: string; part_number: string; description: string | null; qty: number; unit_price_cents: number | null; amount_cents: number | null; is_causal: boolean; return_required: boolean }>;
  submissions: Array<{ id: string; attempt_no: number; channel: string; status: string; external_ref: string | null; packet: ClaimPacket; created_at: string }>;
  unit: { id: string; stock_number: string | null; make: string | null; model: string | null; serial_number: string | null } | null;
  workOrder: { id: string; number: string; status: string } | null;
}

const TEXT_FIELDS: Array<[string, string, number]> = [
  ['oem_brand', 'Manufacturer', 30], ['causal_part_number', 'Causal part number', 40], ['causal_part_serial', 'Causal part serial', 60],
  ['symptom_code', 'Symptom code', 30], ['defect_code', 'Defect code', 30], ['remedy_code', 'Remedy code', 30], ['labor_op', 'Labor op', 30],
  ['pre_auth_ref', 'Pre-authorization', 60], ['engine_serial', 'Engine serial', 60], ['return_tag', 'Return tag', 60],
];
const DATE_FIELDS: Array<[string, string]> = [['failure_on', 'Failure date'], ['repair_on', 'Repair date'], ['purchase_on', 'Purchase / delivery date']];
const NUM_FIELDS: Array<[string, string]> = [['machine_hours', 'Machine hours'], ['engine_hours', 'Engine hours'], ['requested_hours', 'Requested labor hours']];
const STORY: Array<[string, string]> = [['complaint', 'Complaint'], ['cause', 'Cause'], ['correction', 'Correction']];

/** One warranty claim: every field the manufacturer asks for, the parts, the filing packet, the answer. */
export function ClaimBuilder({ claimId, today }: { claimId: string; today: string }) {
  const { readOnly } = useShell();
  const money$ = useMoneyText('contract');
  const b = useBoard<ClaimData>(`/api/dealer/warranty/${claimId}`);
  const { run, busy, error } = useDo(b.reload);
  const [form, setForm] = useState<Record<string, string>>({});
  const [packet, setPacket] = useState<{ submission_id: string; channel: string; packet: ClaimPacket; adapter: { status: string; message?: string } | null } | null>(null);
  const [filed, setFiled] = useState('');
  const [resp, setResp] = useState({ outcome: 'ACCEPTED', approved: '', reason: '' });
  const [part, setPart] = useState({ pn: '', qty: '1', price: '', causal: true, ret: false });

  useEffect(() => {
    if (!b.data) return;
    const c = b.data.claim;
    const f: Record<string, string> = {};
    for (const [k] of [...TEXT_FIELDS, ...DATE_FIELDS, ...NUM_FIELDS, ...STORY]) f[k] = c[k] == null ? '' : String(c[k]);
    setForm(f);
  }, [b.data]);

  const s = <BoardState b={b} what="The claim" />;
  if (!b.data) return s;
  const d = b.data;
  const locked = readOnly || !['DRAFT', 'RETURNED', 'REJECTED'].includes(d.claim.status);
  const left = daysLeft(d.readiness.submit_by, today);
  const save = () => {
    const fields: Record<string, string | number | null> = {};
    for (const [k] of [...TEXT_FIELDS, ...DATE_FIELDS, ...STORY]) fields[k] = form[k]?.trim() ? form[k]!.trim() : null;
    for (const [k] of NUM_FIELDS) fields[k] = form[k]?.trim() ? Number(form[k]) : null;
    for (const [k] of DATE_FIELDS) if (fields[k] === null) delete fields[k];
    for (const [k] of NUM_FIELDS) if (fields[k] === null || !Number.isFinite(fields[k] as number)) delete fields[k];
    return run('save', `/api/dealer/warranty/${claimId}`, { op: 'update', fields }, 'Saved the claim');
  };

  return (
    <div className="stack">
      <div className="dl-strip">
        <KV items={[
          { term: 'Status', value: <Status kind={d.claim.status === 'REJECTED' ? 'blocked' : d.claim.status === 'DRAFT' ? 'track' : 'ready'} pip="open">{d.claim.status.replace(/_/g, ' ').toLowerCase()}</Status> },
          { term: 'Claimed', value: money$(d.claim.claimed_cents) },
          { term: 'File by', value: d.readiness.submit_by ? <span className={left != null && left <= 7 ? 'neg b' : undefined}>{day(d.readiness.submit_by, today)}{left != null ? ` · ${left < 0 ? `${-left} days late` : `${left} days left`}` : ''}</span> : '—' },
          { term: 'Channel', value: d.readiness.channel === 'DIRECT' ? 'Direct (when connected)' : 'Dealer portal' },
          { term: 'Unit', value: d.unit ? <Link className="nlink" href={`/stock/units/${d.unit.id}/timeline`}>{[d.unit.make, d.unit.model, d.unit.serial_number].filter(Boolean).join(' · ')}</Link> : '—' },
          { term: 'Repair order', value: d.workOrder ? <Link className="nlink" href={`/work-orders?wo=${d.workOrder.id}`}>{d.workOrder.number}</Link> : '—' },
        ]} />
      </div>
      {d.readiness.missing.length > 0
        ? <InlineNotice tone="warn" title={`${count(d.readiness.missing.length)} things the manufacturer needs before filing.`}>{missingLabels(d.readiness.missing).join(' · ')}</InlineNotice>
        : <InlineNotice tone="info" title="Everything the manufacturer asks for is here.">Prepare the packet and file it.</InlineNotice>}
      {error && <Failure text={error} />}
      <Section title="Claim" meta={d.readiness.brand ? `${d.readiness.brand} requirements` : undefined} actions={!locked ? <Button variant="primary" disabled={busy === 'save'} onClick={() => void save()}>Save</Button> : undefined}>
        <div className="dl-kv2">
          {TEXT_FIELDS.map(([k, label, max]) => (
            <Field key={k} label={label} error={d.readiness.missing.includes(k) ? 'Required by the manufacturer' : undefined}>
              <Input value={form[k] ?? ''} maxLength={max} disabled={locked} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
            </Field>
          ))}
          {DATE_FIELDS.map(([k, label]) => (
            <Field key={k} label={label} error={d.readiness.missing.includes(k) ? 'Required by the manufacturer' : undefined}>
              <Input type="date" value={form[k] ?? ''} disabled={locked} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
            </Field>
          ))}
          {NUM_FIELDS.map(([k, label]) => (
            <Field key={k} label={label} error={d.readiness.missing.includes(k) ? 'Required by the manufacturer' : undefined}>
              <Input inputMode="decimal" value={form[k] ?? ''} disabled={locked} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
            </Field>
          ))}
        </div>
        {STORY.map(([k, label]) => (
          <Field key={k} label={label} error={d.readiness.missing.includes(k) ? 'Required by the manufacturer' : undefined}>
            <Textarea rows={2} value={form[k] ?? ''} disabled={locked} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
          </Field>
        ))}
      </Section>
      <Section title="Parts on the claim" meta={`${count(d.parts.length)} parts`}>
        {d.parts.length === 0 ? <p className="t-cap">No parts yet. Add the causal part first.</p> : (
          <table className="ops-mini" aria-label="Claim parts">
            <thead><tr><th>Part</th><th>Description</th><th className="n">Qty</th><th className="n">Price</th><th>Causal</th><th>Return</th></tr></thead>
            <tbody>{d.parts.map((p) => <tr key={p.id}><td className="code">{p.part_number}</td><td>{p.description ?? ''}</td><td className="n">{p.qty}</td><td className="n">{p.unit_price_cents == null ? '—' : money$(p.unit_price_cents)}</td><td>{p.is_causal ? 'Causal' : ''}</td><td>{p.return_required ? 'Hold for return' : ''}</td></tr>)}</tbody>
          </table>
        )}
        {!locked && (
          <div className="ops-toolbar" style={{ marginTop: 8 }}>
            <Field label="Part number"><Input value={part.pn} onChange={(e) => setPart({ ...part, pn: e.target.value.toUpperCase() })} style={{ width: 150 }} /></Field>
            <Field label="Qty"><Input inputMode="decimal" value={part.qty} onChange={(e) => setPart({ ...part, qty: e.target.value })} style={{ width: 60 }} /></Field>
            <Field label="Price"><Input inputMode="decimal" value={part.price} onChange={(e) => setPart({ ...part, price: e.target.value })} style={{ width: 100 }} /></Field>
            <Check label="Causal" checked={part.causal} onChange={(e) => setPart({ ...part, causal: e.target.checked })} />
            <Check label="Return required" checked={part.ret} onChange={(e) => setPart({ ...part, ret: e.target.checked })} />
            <Button disabled={!part.pn.trim() || busy === 'parts'} onClick={async () => {
              const next = [...d.parts.map((p) => ({ part_number: p.part_number, description: p.description, qty: Number(p.qty), unit_price_cents: p.unit_price_cents, is_causal: p.is_causal, return_required: p.return_required })),
                { part_number: part.pn.trim(), qty: Number(part.qty) > 0 ? Number(part.qty) : 1, unit_price_cents: centsFrom(part.price), is_causal: part.causal, return_required: part.ret }];
              if (await run('parts', `/api/dealer/warranty/${claimId}`, { op: 'parts', parts: next }, 'Added the part')) setPart({ pn: '', qty: '1', price: '', causal: false, ret: false });
            }}>Add part</Button>
          </div>
        )}
      </Section>
      {!locked && (
        <Section title="File the claim" meta="Direct filing when the manufacturer’s interface is connected; otherwise the dealer portal">
          <ButtonRow>
            <Button variant="primary" disabled={!d.readiness.ready || busy === 'prep'} onClick={async () => {
              const r = await run<{ submission_id: string; channel: string; packet: ClaimPacket; adapter: { status: string; message?: string } | null }>('prep', `/api/dealer/warranty/${claimId}`, { op: 'prepare' }, 'Prepared the filing packet');
              if (r) setPacket(r);
            }}>Prepare packet</Button>
            {!d.readiness.ready && <span className="t-cap">Fill the missing fields first.</span>}
          </ButtonRow>
          {packet && (
            <div className="stack" style={{ marginTop: 12 }}>
              {packet.adapter && packet.adapter.status !== 'SENT' && packet.adapter.status !== 'ACKNOWLEDGED' && <InlineNotice tone="info" title="File on the dealer portal.">{packet.adapter.message}</InlineNotice>}
              <table className="ops-mini" aria-label="Fields to copy into the portal">
                <tbody>{packet.packet.copy_fields.map((f) => (
                  <tr key={f.label}><td>{f.label}</td><td>{f.value == null ? '—' : String(f.value)}</td>
                    <td className="n">{f.value != null && <Button variant="quiet" onClick={() => { void navigator.clipboard?.writeText(String(f.value)); toast(`Copied ${f.label.toLowerCase()}`); }}>Copy</Button>}</td></tr>
                ))}</tbody>
              </table>
              <ButtonRow>
                <Button variant="quiet" onClick={() => { void navigator.clipboard?.writeText(packetText(packet.packet)); toast('Copied the whole packet'); }}>Copy all</Button>
                <Field label="Claim number from the portal"><Input value={filed} onChange={(e) => setFiled(e.target.value)} style={{ width: 180 }} /></Field>
                <Button variant="primary" disabled={!filed.trim() || busy === 'filed'} onClick={async () => {
                  if (await run('filed', `/api/dealer/warranty/${claimId}`, { op: 'submitted', submissionId: packet.submission_id, status: 'FILED_ON_PORTAL', claimNumber: filed.trim() }, 'Recorded the filing')) { setPacket(null); setFiled(''); }
                }}>Record as filed</Button>
              </ButtonRow>
            </div>
          )}
        </Section>
      )}
      {!readOnly && d.claim.status === 'SUBMITTED' && (
        <Section title="The manufacturer’s answer">
          <div className="ops-toolbar">
            <Field label="Outcome"><Select value={resp.outcome} onChange={(e) => setResp({ ...resp, outcome: e.target.value })}>
              <option value="ACCEPTED">Accepted in full</option><option value="ADJUSTED">Accepted, adjusted</option><option value="RETURNED">Returned for information</option><option value="REJECTED">Rejected</option>
            </Select></Field>
            {resp.outcome === 'ADJUSTED' && <Field label="Approved amount"><Input inputMode="decimal" value={resp.approved} onChange={(e) => setResp({ ...resp, approved: e.target.value })} style={{ width: 120 }} /></Field>}
            <Field label="Reason or note"><Input value={resp.reason} onChange={(e) => setResp({ ...resp, reason: e.target.value })} style={{ width: 280 }} /></Field>
            <Button variant="primary" disabled={busy === 'resp' || (resp.outcome === 'ADJUSTED' && centsFrom(resp.approved) == null)} onClick={() => void run('resp', `/api/dealer/warranty/${claimId}`, { op: 'response', outcome: resp.outcome, approvedCents: resp.outcome === 'ADJUSTED' ? centsFrom(resp.approved) : null, reason: resp.reason || null }, 'Recorded the answer')}>Record</Button>
          </div>
        </Section>
      )}
      {!readOnly && d.claim.status === 'REJECTED' && (
        <Section title="Rejected: what next">
          <ButtonRow>
            <Button disabled={busy === 'res'} onClick={() => void run('res', `/api/dealer/warranty/${claimId}`, { op: 'resolve', action: 'RESUBMIT', reason: resp.reason || null }, 'Reopened to resubmit')}>Fix and resubmit</Button>
            <Button disabled={busy === 'res'} onClick={() => void run('res', `/api/dealer/warranty/${claimId}`, { op: 'resolve', action: 'REBILL', reason: resp.reason || null }, 'Sent back to bill the customer')}>Bill the customer</Button>
            <Button variant="danger" disabled={busy === 'res'} onClick={() => void run('res', `/api/dealer/warranty/${claimId}`, { op: 'resolve', action: 'WRITE_OFF', reason: resp.reason || null }, 'Wrote the claim off')}>Write off</Button>
          </ButtonRow>
        </Section>
      )}
      <Section title="Filing history" meta={`${count(d.submissions.length)} attempts`}>
        {d.submissions.length === 0 ? <p className="t-cap">Not filed yet.</p> : (
          <table className="ops-mini" aria-label="Filing attempts">
            <thead><tr><th>#</th><th>Channel</th><th>Status</th><th>Reference</th><th>When</th></tr></thead>
            <tbody>{d.submissions.map((x) => <tr key={x.id}><td>{x.attempt_no}</td><td>{x.channel === 'DIRECT' ? 'Direct' : 'Portal'}</td><td>{x.status.replace(/_/g, ' ').toLowerCase()}</td><td>{x.external_ref ?? '—'}</td><td>{day(x.created_at, today)}</td></tr>)}</tbody>
          </table>
        )}
      </Section>
    </div>
  );
}
