'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AppLink, Button, Check, Field, InlineNotice, Input, MoneyInput, Panel, PanelSection, QueueTable, Select, Textarea, WidgetState, money, toast,
  type QueueColumn,
} from '@meritbooks/merit-ui';
import type { CoExposureRow } from '@/lib/residential/types';
import { CO_TYPE_WORDS, EXPOSURE_STATE } from '@/lib/residential/labels';
import { useShell } from '@/components/shell/ShellContext';
import { postForm } from '@/components/documents/client';
import { Failure, StatusMark, parseNum } from '@/components/ops/common/bits';
import { useOps } from '@/components/ops/common/useOps';

type Mode = { kind: 'co'; id: string } | { kind: 'field' } | { kind: 'internal' } | null;

export function HomeChangeOrders({ jobId, rows, today, canEdit }: { jobId: string; rows: CoExposureRow[]; today: string; canEdit: boolean }) {
  const { readOnly } = useShell();
  const [mode, setMode] = useState<Mode>(null);
  const open = rows.filter((r) => r.exposure_state === 'unpriced' || r.exposure_state === 'sent' || r.exposure_state === 'signed');
  const unsignedWork = rows.filter((r) => r.work_logged_unsigned).length;
  const cur = mode?.kind === 'co' ? rows.find((r) => r.id === mode.id) ?? null : null;
  const columns: QueueColumn<CoExposureRow>[] = [
    { id: 'what', header: 'Change order', cell: (r) => <><span className="l1">{r.number} · {r.title}</span><span className="l2">{[CO_TYPE_WORDS[r.co_type], r.reason_code?.toLowerCase().replace(/_/g, ' '), r.stop_work ? 'Do not proceed until signed' : null, r.emergency ? 'Emergency — proceeded' : null].filter(Boolean).join(' · ')}</span></> },
    { id: 'age', header: 'Age', width: 80, numeric: true, cell: (r) => <span className={r.age_days > 3 && r.exposure_state !== 'approved' ? 'neg b' : undefined}>{r.age_days} d</span> },
    { id: 'st', header: 'Status', width: 200, cell: (r) => <><StatusMark mark={EXPOSURE_STATE[r.exposure_state]} />{r.work_logged_unsigned && <span className="l2 neg">Work logged before signature</span>}</> },
  ];
  return (
    <div className="stack">
      <div className="ops-toolbar">
        <p className="t-cap" style={{ margin: 0 }}>{open.length} open{unsignedWork ? ` · ${unsignedWork} with work logged before the signature` : ''}. Unsigned exposure is money the job has spent or promised without a signature.</p>
        <span className="sp" />
        {canEdit && !readOnly && (
          <div className="btn-row">
            <Button onClick={() => setMode({ kind: 'internal' })}>No-charge (internal)</Button>
            <Button variant="primary" icon="plus" onClick={() => setMode({ kind: 'field' })}>Request from the field</Button>
          </div>
        )}
      </div>
      {unsignedWork > 0 && <InlineNotice tone="neg" title="Work happened before a signature">Time or costs were logged on a change order the homeowner has not signed. Get it signed today.</InlineNotice>}
      <div className={mode ? 'ops-split has-panel' : 'ops-split'}>
        <div className="mp-table" style={{ minWidth: 0 }}>
          {rows.length === 0 ? <WidgetState state={{ kind: 'empty', title: 'No change orders', body: 'The crew can request one from the field with photos and a voice note; the job stops on that work until the homeowner signs.' }} /> : (
            <QueueTable aria-label="Change orders" columns={columns} rows={rows} getRowId={(r) => r.id} cursorId={cur?.id ?? null} openOnClick
              onCursorChange={(id) => setMode(id ? { kind: 'co', id } : null)} onOpen={(r) => setMode({ kind: 'co', id: r.id })}
              rowState={(r) => ({ attn: r.work_logged_unsigned || (r.stop_work && r.exposure_state !== 'approved' && r.exposure_state !== 'void'), done: r.exposure_state === 'void' || r.exposure_state === 'rejected' })} />
          )}
        </div>
        {mode?.kind === 'field' && <FieldRequest jobId={jobId} onClose={() => setMode(null)} />}
        {mode?.kind === 'internal' && <InternalCo jobId={jobId} onClose={() => setMode(null)} />}
        {cur && <CoPanel key={cur.id} co={cur} today={today} canEdit={canEdit && !readOnly} onClose={() => setMode(null)} />}
      </div>
    </div>
  );
}

function FieldRequest({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [area, setArea] = useState('');
  const [demo, setDemo] = useState(false);
  const [emergency, setEmergency] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const photos = useRef<HTMLInputElement>(null);
  const voice = useRef<HTMLInputElement>(null);
  const submit = async () => {
    if (!title.trim()) return setErr('Say what you found.');
    const f = new FormData();
    f.set('title', title.trim());
    if (note.trim()) f.set('note', note.trim());
    if (area.trim()) f.set('area', area.trim());
    f.set('demoDiscovery', String(demo));
    f.set('emergency', String(emergency));
    for (const file of Array.from(photos.current?.files ?? [])) f.append('photo', file);
    const v = voice.current?.files?.[0];
    if (v) f.set('voice', v);
    setBusy(true);
    const r = await postForm<{ changeOrderId: string; photos: number }>(`/api/residential/jobs/${jobId}/field-co`, f);
    setBusy(false);
    if (r.error) return setErr(r.error);
    toast(emergency ? 'Emergency change order logged — proceed and document' : 'Change order requested — hold that work until it is signed');
    router.refresh();
    onClose();
  };
  return (
    <Panel eyebrow={['New', 'Change order']} title={title.trim() || 'Request from the field'} meta="The office prices it; the homeowner signs" onClose={onClose}
      foot={<div className="btn-row" style={{ justifyContent: 'flex-end', width: '100%' }}><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy} onClick={() => void submit()}>Send request</Button></div>}>
      <PanelSection>
        <form className="mp-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <Field label="What did you find?" error={err ?? undefined}><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus placeholder="Rotted subfloor under the dishwasher" /></Field>
          <Field label="Where"><Input value={area} onChange={(e) => setArea(e.target.value)} maxLength={120} placeholder="Kitchen, sink wall" /></Field>
          <Field label="Photos"><input ref={photos} type="file" accept="image/*" capture="environment" multiple className="input" /></Field>
          <Field label="Voice note" help="Optional — describe it out loud"><input ref={voice} type="file" accept="audio/*" capture className="input" /></Field>
          <Field label="Notes"><Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={4000} /></Field>
          <Check checked={demo} onChange={(e) => setDemo(e.target.checked)} label="Found during demolition (fast-sign so work resumes today)" />
          <Check checked={emergency} onChange={(e) => setEmergency(e.target.checked)} label="Emergency — safety or damage; proceed now and document" />
          {!emergency && <InlineNotice tone="warn" title="Do not proceed">Stop work on this item until the homeowner signs.</InlineNotice>}
          <button type="submit" hidden />
        </form>
      </PanelSection>
    </Panel>
  );
}

function InternalCo({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const { act, busy, error } = useOps();
  const [title, setTitle] = useState('');
  const [reason, setReason] = useState<'BUILDER_ERROR' | 'GOODWILL' | 'VENDOR_ERROR' | 'DAMAGE' | 'OTHER'>('BUILDER_ERROR');
  const [cost, setCost] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const go = async () => {
    if (!title.trim() || cost == null) return;
    const r = await act('internal', 'post', `/api/residential/jobs/${jobId}`, { op: 'internal_co', title: title.trim(), reasonCode: reason, costCents: cost, note: note.trim() || null }, 'No-charge change order recorded');
    if (r) onClose();
  };
  return (
    <Panel eyebrow={['New', 'No-charge change order']} title={title.trim() || 'Internal change order'} meta="Moves budget; the homeowner pays nothing" onClose={onClose}
      foot={<div className="btn-row" style={{ justifyContent: 'flex-end', width: '100%' }}><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!title.trim() || cost == null || busy === 'internal'} onClick={() => void go()}>Record</Button></div>}>
      <PanelSection>
        <div className="mp-form">
          <Field label="What changed"><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus /></Field>
          <div className="mp-form-2">
            <Field label="Why">
              <Select value={reason} onChange={(e) => setReason(e.target.value as typeof reason)}>
                <option value="BUILDER_ERROR">Our error</option><option value="GOODWILL">Goodwill</option><option value="VENDOR_ERROR">Vendor error</option><option value="DAMAGE">Damage</option><option value="OTHER">Other</option>
              </Select>
            </Field>
            <Field label="Cost to us"><MoneyInput valueCents={cost} onChangeCents={setCost} /></Field>
          </div>
          <Field label="Notes"><Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={4000} /></Field>
          <Failure text={error} />
        </div>
      </PanelSection>
    </Panel>
  );
}

interface LineDraft { description: string; qty: string; unitCost: number | null; unitPrice: number | null }

function CoPanel({ co, canEdit, onClose }: { co: CoExposureRow; today: string; canEdit: boolean; onClose: () => void }) {
  const { act, busy, error } = useOps();
  const url = `/api/residential/change-orders/${co.id}`;
  const [lines, setLines] = useState<LineDraft[]>([{ description: co.title, qty: '1', unitCost: null, unitPrice: null }]);
  const [days, setDays] = useState('');
  const [signer, setSigner] = useState('');
  const [phone, setPhone] = useState('');
  const set = (i: number, p: Partial<LineDraft>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const priceTotal = lines.reduce((s, l) => s + Math.round((parseNum(l.qty) ?? 0) * (l.unitPrice ?? 0)), 0);
  const canPrice = co.exposure_state === 'unpriced';
  const canSign = co.exposure_state === 'unpriced' || co.exposure_state === 'sent';
  const price = () => void act('price', 'post', url, {
    op: 'price', scheduleDays: parseNum(days),
    lines: lines.filter((l) => l.description.trim()).map((l) => ({ description: l.description.trim(), qty: parseNum(l.qty) ?? 1, unitCostCents: l.unitCost ?? undefined, unitPriceCents: l.unitPrice })),
  }, 'Priced — ready to sign');
  return (
    <Panel eyebrow={[CO_TYPE_WORDS[co.co_type], EXPOSURE_STATE[co.exposure_state].word]} title={`${co.number} · ${co.title}`} meta={`${co.age_days} days old${co.signer_name ? ` · signed by ${co.signer_name}` : ''}`} onClose={onClose}>
      <PanelSection>
        <div className="stack">
          {co.stop_work && co.exposure_state !== 'approved' && <InlineNotice tone="warn" title="Do not proceed">Work on this item waits for the homeowner’s signature.</InlineNotice>}
          <Failure text={error} />
          {canEdit && canPrice && (
            <div className="mp-form">
              <h3 className="t-section">Price it</h3>
              {lines.map((l, i) => (
                <div key={i} className="mp-form-2" style={{ gridTemplateColumns: '2fr 0.6fr 1fr 1fr' }}>
                  <Field label={i === 0 ? 'Line' : ''}><Input aria-label="Line" value={l.description} onChange={(e) => set(i, { description: e.target.value })} maxLength={500} /></Field>
                  <Field label={i === 0 ? 'Qty' : ''}><Input aria-label="Quantity" inputMode="decimal" value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} /></Field>
                  <Field label={i === 0 ? 'Unit cost' : ''}><MoneyInput aria-label="Unit cost" valueCents={l.unitCost} onChangeCents={(v) => set(i, { unitCost: v })} /></Field>
                  <Field label={i === 0 ? 'Unit price' : ''}><MoneyInput aria-label="Unit price" valueCents={l.unitPrice} onChangeCents={(v) => set(i, { unitPrice: v })} placeholder="Cost + markup" /></Field>
                </div>
              ))}
              <div className="btn-row">
                <Button variant="quiet" icon="plus" onClick={() => setLines((ls) => [...ls, { description: '', qty: '1', unitCost: null, unitPrice: null }])}>Line</Button>
                <span className="sp" />
                <Field label="Schedule impact (days)"><Input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 90 }} /></Field>
              </div>
              {priceTotal > 0 && <p className="t-cap">Typed prices: {money(priceTotal)} (lines without a price use cost + the company markup)</p>}
              <Button variant="primary" disabled={busy === 'price'} onClick={price}>Save price</Button>
            </div>
          )}
          {canEdit && canSign && !canPrice && (
            <div className="mp-form">
              <h3 className="t-section">Homeowner signature</h3>
              <Field label="Homeowner"><Input value={signer} onChange={(e) => setSigner(e.target.value)} maxLength={200} /></Field>
              <div className="btn-row">
                <Button variant="primary" disabled={!signer.trim() || busy === 'sign'} onClick={() => void act('sign', 'post', url, { op: 'sign', signerName: signer.trim(), method: 'IN_PERSON' }, 'Signed on site — approved through Approvals')}>Signed here, on the tablet</Button>
              </div>
              <Field label="…or text a fast-sign link" help={co.co_type === 'DEMO_DISCOVERY' ? 'One-day link so the crew can resume today' : 'Seven-day link'}>
                <div className="row" style={{ gap: 6 }}>
                  <Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 515 555 0100" aria-label="Homeowner mobile" />
                  <Button disabled={!signer.trim() || !phone.trim() || busy === 'send'} onClick={() => void act('send', 'post', url, { op: 'send', fast: co.co_type === 'DEMO_DISCOVERY', signers: [{ name: signer.trim(), phone: phone.trim(), channel: 'sms' }] }, 'Signature link sent')}>Send</Button>
                </div>
              </Field>
            </div>
          )}
          {canEdit && (co.exposure_state === 'approved' || co.exposure_state === 'signed') && (
            <Button disabled={busy === 'trade'} onClick={() => void act<{ drafts: unknown[] }>('trade', 'post', url, { op: 'trade_cos' }, (d) => (d.drafts.length ? `${d.drafts.length} trade change orders drafted` : 'No trade commitments are touched'))}>Draft matching trade change orders</Button>
          )}
          <AppLink href={`/change-orders?co=${co.id}`}>Open in Change orders</AppLink>
        </div>
      </PanelSection>
    </Panel>
  );
}
