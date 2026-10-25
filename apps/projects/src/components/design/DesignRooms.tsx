'use client';

import { useState } from 'react';
import { Button, Check, Field, InlineNotice, Input, Select, Status, Textarea, money } from '@meritbooks/merit-ui';
import type { DesignProductRow } from '@/app/api/design/ops/route';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, PctInput, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, centsFrom, day, qty, useBoard, useDo } from '@/components/dealer/common/depth';

type View = 'rooms' | 'ffe' | 'agreement' | 'statement' | 'changes' | 'claims' | 'install' | 'reimbursables';
const VIEWS: Array<[View, string]> = [['rooms', 'Rooms and budgets'], ['ffe', 'FF&E schedule'], ['agreement', 'Agreement'], ['statement', 'Deposits'], ['changes', 'Changes'], ['claims', 'Freight claims'], ['install', 'Install day'], ['reimbursables', 'Reimbursables']];
const PHASES = ['PROGRAMMING', 'CONCEPT', 'DESIGN_DEVELOPMENT', 'PROCUREMENT', 'INSTALL', 'COMPLETE'] as const;

interface Room { room_id: string | null; room: string; phase: string | null; budget_cents: number | null; specified_cents: number | null; placeholders: number; items: number; remaining_cents: number | null; over: boolean }
interface Component { id: string; kind: string | null; vendor: string | null; po_number: string | null; status: string; expected_on: string | null }
interface FfeItem { item_id: string; doc_code: string | null; room: string; name: string; category: string | null; qty: number; status: string; placeholder: boolean; client_unit_price_cents?: number | null; client_total_cents?: number | null; net_cost_cents?: number | null; components: Component[] | null }
interface StatementItem { item_id: string; item: string; room: string; status: string; client_total_cents: number; deposit_required_cents: number; deposit_held_cents: number; applied_cents: number; remaining_cents: number }
interface Agreement { id: string; version: number; status: string; retainer_cents: number | null; signer_name: string | null; signed_at: string | null; created_at: string }
interface Change { id: string; item_id: string; kind: string; reason: string; restocking_fee_cents: number | null; deposit_moved_cents: number | null; created_at: string }
interface Claim { id: string; carrier: string | null; tracking_ref: string | null; damage: string; claim_cents: number | null; status: string; filed_on: string | null; settled_cents: number | null }
interface Reimb { id: string; kind: string; description: string; incurred_on: string | null; cost_cents: number; markup_pct: number | null; billable: boolean; status: string }
interface InstallItem { item_id: string; room: string; doc_code: string | null; name: string; qty: number; status: string; ready: boolean; components: Array<{ id: string; status: string; received_condition: string | null; freight_claim_open: boolean }> | null }
interface Install { checklist: { id: string; items: Array<{ key: string; label: string; done: boolean }>; completed_at?: string | null }; items: InstallItem[] }

/** A design project (ID-04 agreement, ID-05 rooms and budgets, ID-11 FF&E, ID-13 deposits, ID-24 changes, ID-25 freight claims, ID-28 install, ID-33 product invoice, ID-34 reimbursables). */
export function DesignRooms({ jobId, companyId, today }: { jobId: string; companyId: string; today: string }) {
  const [view, setView] = useState<View>('rooms');
  return (
    <div className="stack">
      <div className="btn-row" role="tablist" aria-label="Project views">{VIEWS.map(([k, l]) => <Button key={k} role="tab" aria-selected={view === k} variant={view === k ? 'dark' : 'quiet'} onClick={() => setView(k)}>{l}</Button>)}</div>
      {view === 'rooms' && <Rooms jobId={jobId} companyId={companyId} />}
      {view === 'ffe' && <Ffe jobId={jobId} today={today} />}
      {view === 'agreement' && <AgreementView jobId={jobId} today={today} />}
      {view === 'statement' && <Statement jobId={jobId} />}
      {view === 'changes' && <Changes jobId={jobId} today={today} />}
      {view === 'claims' && <Claims jobId={jobId} today={today} />}
      {view === 'install' && <InstallDay jobId={jobId} today={today} />}
      {view === 'reimbursables' && <Reimbursables jobId={jobId} today={today} />}
    </div>
  );
}

const base = (jobId: string) => `/api/design/jobs/${jobId}/ops`;

function Rooms({ jobId, companyId }: { jobId: string; companyId: string }) {
  const { readOnly } = useShell();
  const b = useBoard<{ rooms: Room[] }>(`${base(jobId)}?view=rooms`);
  const lib = useBoard<{ products: DesignProductRow[] }>(readOnly ? null : `/api/design/ops?company=${companyId}&view=library`);
  const { run, busy, error } = useDo(b.reload);
  const [nr, setNr] = useState({ name: '', budget: '' });
  const [budget, setBudget] = useState<Record<string, string>>({});
  const [add, setAdd] = useState({ room: '', productId: '', qty: '1' });
  const state = <BoardState b={b} what="Rooms" />;
  if (!b.data) return state;
  const over = b.data.rooms.filter((r) => r.over);
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      {over.length > 0 && <InlineNotice tone="warn" title={`${over.length} room(s) over budget.`}>{over.map((r) => r.room).join(', ')} — the client sees the change before anything is ordered.</InlineNotice>}
      {b.data.rooms.length === 0 ? <Empty title="No rooms yet" body="Add each room with its budget; every specified item counts against it." /> :
        <table className="ops-mini" aria-label="Rooms"><thead><tr><th>Room</th><th>Phase</th><th className="n">Budget</th><th className="n">Specified</th><th className="n">Left</th><th>Items</th></tr></thead>
          <tbody>{b.data.rooms.map((r) => <tr key={r.room_id ?? r.room}><td>{r.room}</td>
            <td>{readOnly || !r.room_id ? (r.phase ?? '—').toLowerCase().replace(/_/g, ' ') : <Select aria-label="Phase" value={r.phase ?? ''} onChange={(e) => run(`p${r.room_id}`, base(jobId), { op: 'room', roomId: r.room_id, name: r.room, phase: e.target.value || null }, null)}>
              <option value="">—</option>{PHASES.map((p) => <option key={p} value={p}>{p.toLowerCase().replace(/_/g, ' ')}</option>)}</Select>}</td>
            <td className="n">{readOnly ? (r.budget_cents == null ? '—' : money(r.budget_cents, { decimals: 0 })) : <span className="btn-row"><Input aria-label={`Budget for ${r.room}`} style={{ width: 100 }} value={budget[r.room] ?? (r.budget_cents == null ? '' : String(r.budget_cents / 100))} onChange={(e) => setBudget({ ...budget, [r.room]: e.target.value })} />
              {budget[r.room] != null && <Button disabled={centsFrom(budget[r.room] ?? '') == null || busy === `b${r.room}`} onClick={() => run(`b${r.room}`, base(jobId), { op: 'room', roomId: r.room_id, name: r.room, budgetCents: centsFrom(budget[r.room] ?? '') }, 'Budget saved')}>Save</Button>}</span>}</td>
            <td className="n">{r.specified_cents == null ? '—' : money(r.specified_cents, { decimals: 0 })}</td>
            <td className={`n${r.over ? ' neg' : ''}`}>{r.remaining_cents == null ? '—' : money(r.remaining_cents, { decimals: 0 })}</td><td>{r.items}{r.placeholders ? <span className="l2"> · {r.placeholders} placeholder(s)</span> : null}</td></tr>)}</tbody></table>}
      {!readOnly && <>
        <div className="ops-toolbar">
          <Field label="New room"><Input value={nr.name} onChange={(e) => setNr({ ...nr, name: e.target.value })} /></Field>
          <Field label="Budget" error={nr.budget && centsFrom(nr.budget) == null ? 'Dollars' : undefined}><Input value={nr.budget} style={{ width: 110 }} onChange={(e) => setNr({ ...nr, budget: e.target.value })} /></Field>
          <Button disabled={!nr.name.trim() || (!!nr.budget && centsFrom(nr.budget) == null) || busy === 'room'} onClick={async () => { const x = await run('room', base(jobId), { op: 'room', name: nr.name.trim(), budgetCents: nr.budget ? centsFrom(nr.budget) : null, phase: 'PROGRAMMING' }, 'Room added'); if (x) setNr({ name: '', budget: '' }); }}>Add room</Button>
        </div>
        <div className="ops-toolbar">
          <Field label="Specify from the library"><Select value={add.productId} onChange={(e) => setAdd({ ...add, productId: e.target.value })}><option value="">Pick a product</option>{(lib.data?.products ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}{p.vendor_name ? ` · ${p.vendor_name}` : ''}</option>)}</Select></Field>
          <Field label="Room"><Select value={add.room} onChange={(e) => setAdd({ ...add, room: e.target.value })}><option value="">Pick</option>{b.data.rooms.map((r) => <option key={r.room} value={r.room}>{r.room}</option>)}</Select></Field>
          <Field label="Qty" error={/^\d+(\.\d+)?$/.test(add.qty) && Number(add.qty) > 0 ? undefined : 'More than zero'}><Input value={add.qty} style={{ width: 70 }} onChange={(e) => setAdd({ ...add, qty: e.target.value })} /></Field>
          <Button disabled={!add.productId || !add.room || !(Number(add.qty) > 0) || busy === 'add'} onClick={async () => { const x = await run('add', base(jobId), { op: 'add_product', productId: add.productId, room: add.room, qty: Number(add.qty) }, 'Specified — priced by the firm’s rules'); if (x) setAdd({ ...add, productId: '', qty: '1' }); }}>Specify</Button>
        </div>
      </>}
    </div>
  );
}

function Ffe({ jobId, today }: { jobId: string; today: string }) {
  const { readOnly } = useShell();
  const b = useBoard<{ items: FfeItem[]; financial_columns: boolean }>(`${base(jobId)}?view=ffe`);
  const { run, busy, error } = useDo(b.reload);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [kind, setKind] = useState<'DEPOSIT' | 'PROGRESS' | 'FINAL'>('DEPOSIT');
  const [tax, setTax] = useState<number | null>(0);
  const state = <BoardState b={b} what="FF&E schedule" />;
  if (!b.data) return state;
  const money2 = b.data.financial_columns;
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      {b.data.items.length === 0 ? <Empty title="Nothing specified yet" body="Specify products into rooms; the schedule lists every item with its vendor components, PO and dates." /> :
        <table className="ops-mini" aria-label="FF&E schedule"><thead><tr>{!readOnly && <th />}<th>Code</th><th>Room</th><th>Item</th><th className="n">Qty</th>{money2 && <th className="n">Client</th>}<th>Status</th><th>Components</th></tr></thead>
          <tbody>{b.data.items.map((i) => <tr key={i.item_id}>{!readOnly && <td><Check aria-label={`Invoice ${i.name}`} checked={picked.has(i.item_id)} onChange={(e) => { const n = new Set(picked); if (e.target.checked) n.add(i.item_id); else n.delete(i.item_id); setPicked(n); }} /></td>}
            <td>{i.doc_code ?? '—'}</td><td>{i.room}</td><td>{i.name}{i.placeholder && <span className="l2"> · placeholder</span>}</td><td className="n">{qty(i.qty)}</td>
            {money2 && <td className="n">{i.client_total_cents == null ? '—' : money(i.client_total_cents)}</td>}<td>{i.status.toLowerCase()}</td>
            <td className="l2">{(i.components ?? []).map((c) => `${c.kind ?? 'item'} ${c.status.toLowerCase()}${c.po_number ? ` PO ${c.po_number}` : ''}${c.expected_on ? ` ${day(c.expected_on, today)}` : ''}`).join(' · ') || '—'}</td></tr>)}</tbody></table>}
      {!readOnly && money2 && picked.size > 0 && <div className="ops-toolbar">
        <Field label="Invoice"><Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}><option value="DEPOSIT">Deposit</option><option value="PROGRESS">Progress</option><option value="FINAL">Final</option></Select></Field>
        <Field label="Sales tax"><PctInput value={tax} max={50} aria-label="Sales tax" onChange={setTax} /></Field>
        <Button variant="primary" disabled={busy === 'inv'} onClick={async () => { const x = await run('inv', base(jobId), { op: 'product_invoice', kind, itemIds: [...picked], taxRate: tax ?? 0 }, 'Product invoice drafted for Books'); if (x) setPicked(new Set()); }}>Draft the product invoice ({picked.size})</Button>
      </div>}
    </div>
  );
}

function AgreementView({ jobId, today }: { jobId: string; today: string }) {
  const { readOnly } = useShell();
  const b = useBoard<{ agreements: Agreement[] }>(`${base(jobId)}?view=agreement`);
  const { run, busy, error } = useDo(b.reload);
  const [terms, setTerms] = useState('');
  const [signer, setSigner] = useState('');
  const state = <BoardState b={b} what="Agreement" />;
  if (!b.data) return state;
  const cur = b.data.agreements[0] ?? null;
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      {!cur ? <Empty title="No letter of agreement yet" body="Draft it from the discovery call and the firm's fee model; sign it and the retainer is requested." /> :
        <p className="l1">Version {cur.version} · <Status kind={cur.status === 'SIGNED' ? 'ready' : 'track'} pip="open">{cur.status.toLowerCase()}</Status>{cur.retainer_cents != null && ` · retainer ${money(cur.retainer_cents)}`}{cur.signed_at && ` · signed by ${cur.signer_name} ${day(cur.signed_at, today)}`}</p>}
      {!readOnly && <>
        <Field label="Extra terms (optional)"><Textarea rows={3} value={terms} onChange={(e) => setTerms(e.target.value)} /></Field>
        <span className="btn-row">
          <Button disabled={busy === 'dr'} onClick={() => run('dr', base(jobId), { op: 'agreement_draft', extraTerms: terms || null }, 'Drafted')}>{cur ? 'Draft a new version' : 'Draft the agreement'}</Button>
          {cur && cur.status === 'DRAFT' && <Button disabled={busy === 'sn'} onClick={() => run('sn', base(jobId), { op: 'agreement_sent', agreementId: cur.id }, 'Marked sent')}>Mark sent for signature</Button>}
          {cur && (cur.status === 'SENT' || cur.status === 'DRAFT') && <><Input aria-label="Signer name" placeholder="Signed by" value={signer} onChange={(e) => setSigner(e.target.value)} />
            <Button variant="primary" disabled={!signer.trim() || busy === 'sg'} onClick={() => run('sg', base(jobId), { op: 'agreement_signed', agreementId: cur.id, signerName: signer.trim() }, 'Signed — retainer requested')}>Record the signature</Button></>}
        </span>
      </>}
    </div>
  );
}

function Statement({ jobId }: { jobId: string }) {
  const b = useBoard<{ items: StatementItem[]; held_cents: number; applied_cents: number; remaining_cents: number }>(`${base(jobId)}?view=statement`);
  const state = <BoardState b={b} what="Deposit statement" />;
  if (!b.data) return state;
  return (
    <Section title="Client deposit statement" meta={`Held ${money(b.data.held_cents)} · applied ${money(b.data.applied_cents)} · still owed ${money(b.data.remaining_cents)}`}>
      {b.data.items.length === 0 ? <p className="l2">No product items yet.</p> :
        <table className="ops-mini" aria-label="Deposits by item"><thead><tr><th>Item</th><th>Room</th><th className="n">Total</th><th className="n">Deposit due</th><th className="n">Held</th><th className="n">Applied</th><th className="n">Owed</th></tr></thead>
          <tbody>{b.data.items.map((i) => <tr key={i.item_id}><td>{i.item}</td><td>{i.room}</td><td className="n">{money(i.client_total_cents)}</td><td className="n">{money(i.deposit_required_cents)}</td><td className="n">{money(i.deposit_held_cents)}</td><td className="n">{money(i.applied_cents)}</td><td className="n">{money(i.remaining_cents)}</td></tr>)}</tbody></table>}
    </Section>
  );
}

function Changes({ jobId, today }: { jobId: string; today: string }) {
  const { readOnly } = useShell();
  const b = useBoard<{ changes: Change[] }>(`${base(jobId)}?view=changes`);
  const items = useBoard<{ items: FfeItem[] }>(`${base(jobId)}?view=ffe`);
  const { run, busy, error } = useDo(() => { b.reload(); items.reload(); });
  const [f, setF] = useState<{ itemId: string; kind: 'CANCEL' | 'RETURN' | 'CHANGE'; reason: string }>({ itemId: '', kind: 'CANCEL', reason: '' });
  const state = <BoardState b={b} what="Changes" />;
  if (!b.data) return state;
  const name = (id: string) => items.data?.items.find((i) => i.item_id === id)?.name ?? 'Item';
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      {!readOnly && <div className="ops-toolbar">
        <Field label="Item"><Select value={f.itemId} onChange={(e) => setF({ ...f, itemId: e.target.value })}><option value="">Pick</option>{(items.data?.items ?? []).filter((i) => i.status !== 'CANCELLED').map((i) => <option key={i.item_id} value={i.item_id}>{i.room} · {i.name}</option>)}</Select></Field>
        <Field label="Change"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as typeof f.kind })}><option value="CANCEL">Cancel</option><option value="RETURN">Return</option><option value="CHANGE">Change</option></Select></Field>
        <Field label="Why"><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
        <Button variant="danger" disabled={!f.itemId || !f.reason.trim() || busy === 'ch'} onClick={async () => { if (!window.confirm(`${f.kind.toLowerCase()} ${name(f.itemId)}? The vendor's restocking fee applies.`)) return; const x = await run('ch', base(jobId), { op: 'change_item', itemId: f.itemId, kind: f.kind, reason: f.reason.trim() }, 'Recorded'); if (x) setF({ itemId: '', kind: 'CANCEL', reason: '' }); }}>Record</Button>
      </div>}
      {b.data.changes.length === 0 ? <Empty title="No cancellations or returns" body="A cancel or return figures the restocking fee from the vendor's terms and moves the client's deposit." /> :
        <ul className="ops-agenda">{b.data.changes.map((c) => <li key={c.id}><span className="d">{day(c.created_at, today)}</span><span>{c.kind.toLowerCase()} {name(c.item_id)} — {c.reason}{c.restocking_fee_cents != null && ` · restocking ${money(c.restocking_fee_cents)}`}{c.deposit_moved_cents ? ` · deposit moved ${money(c.deposit_moved_cents)}` : ''}</span></li>)}</ul>}
    </div>
  );
}

function Claims({ jobId, today }: { jobId: string; today: string }) {
  const { readOnly } = useShell();
  const b = useBoard<{ claims: Claim[] }>(`${base(jobId)}?view=claims`);
  const items = useBoard<{ items: FfeItem[] }>(readOnly ? null : `${base(jobId)}?view=ffe`);
  const { run, busy, error } = useDo(b.reload);
  const [f, setF] = useState({ componentId: '', damage: '', carrier: '', tracking: '', amount: '' });
  const comps = (items.data?.items ?? []).flatMap((i) => (i.components ?? []).map((c) => ({ id: c.id, label: `${i.room} · ${i.name}${c.po_number ? ` · PO ${c.po_number}` : ''}` })));
  const state = <BoardState b={b} what="Freight claims" />;
  if (!b.data) return state;
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      {b.data.claims.length === 0 ? <Empty title="No freight claims" body="Damaged on arrival? Open a claim with the carrier and photos; the item is held from install until it is settled." /> :
        <table className="ops-mini" aria-label="Freight claims"><thead><tr><th>Damage</th><th>Carrier</th><th className="n">Claim</th><th>Status</th><th /></tr></thead>
          <tbody>{b.data.claims.map((c) => <tr key={c.id}><td>{c.damage}</td><td>{c.carrier ?? '—'}{c.tracking_ref && <span className="l2"> · {c.tracking_ref}</span>}</td><td className="n">{c.claim_cents == null ? '—' : money(c.claim_cents)}</td>
            <td>{c.status.toLowerCase()}{c.filed_on && <span className="l2"> {day(c.filed_on, today)}</span>}</td>
            <td>{!readOnly && (c.status === 'OPEN' || c.status === 'FILED') && <Select aria-label="Claim status" value="" onChange={(e) => e.target.value && run(`c${c.id}`, base(jobId), { op: 'claim_status', claimId: c.id, status: e.target.value }, 'Updated')}>
              <option value="">Update…</option>{['FILED', 'PAID', 'DENIED', 'WITHDRAWN'].map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}</Select>}</td></tr>)}</tbody></table>}
      {!readOnly && <div className="ops-toolbar">
        <Field label="Item"><Select value={f.componentId} onChange={(e) => setF({ ...f, componentId: e.target.value })}><option value="">Pick</option>{comps.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select></Field>
        <Field label="Damage"><Input value={f.damage} onChange={(e) => setF({ ...f, damage: e.target.value })} /></Field>
        <Field label="Carrier"><Input value={f.carrier} style={{ width: 120 }} onChange={(e) => setF({ ...f, carrier: e.target.value })} /></Field>
        <Field label="Tracking / PRO"><Input value={f.tracking} style={{ width: 120 }} onChange={(e) => setF({ ...f, tracking: e.target.value })} /></Field>
        <Field label="Claim amount" error={f.amount && centsFrom(f.amount) == null ? 'Dollars' : undefined}><Input value={f.amount} style={{ width: 100 }} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Button disabled={!f.componentId || !f.damage.trim() || (!!f.amount && centsFrom(f.amount) == null) || busy === 'cl'} onClick={async () => { const x = await run('cl', base(jobId), { op: 'freight_claim', componentId: f.componentId, damage: f.damage.trim(), carrier: f.carrier || null, tracking: f.tracking || null, claimCents: f.amount ? centsFrom(f.amount) : null }, 'Claim opened'); if (x) setF({ componentId: '', damage: '', carrier: '', tracking: '', amount: '' }); }}>Open claim</Button>
      </div>}
    </div>
  );
}

function InstallDay({ jobId, today }: { jobId: string; today: string }) {
  const { readOnly } = useShell();
  const [on, setOn] = useState(today);
  const b = useBoard<Install>(/^\d{4}-\d{2}-\d{2}$/.test(on) ? `${base(jobId)}?view=install&on=${on}` : null);
  const { run, busy, error } = useDo(b.reload);
  const [done, setDone] = useState<Set<string> | null>(null);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [punch, setPunch] = useState('');
  const keys = done ?? new Set((b.data?.checklist.items ?? []).filter((i) => i.done).map((i) => i.key));
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <Field label="Install date"><Input type="date" value={on} onChange={(e) => { setOn(e.target.value); setDone(null); }} /></Field>
      <BoardState b={b} what="Install day" />
      {b.data && <>
        <Section title="Checklist">
          <div className="stack">{b.data.checklist.items.map((i) => <Check key={i.key} disabled={readOnly} checked={keys.has(i.key)} label={i.label} onChange={(e) => { const n = new Set(keys); if (e.target.checked) n.add(i.key); else n.delete(i.key); setDone(n); }} />)}</div>
        </Section>
        <Section title="What goes in" meta={`${b.data.items.filter((i) => i.ready).length} of ${b.data.items.length} ready`}>
          {b.data.items.length === 0 ? <p className="l2">No approved items for this day.</p> :
            <table className="ops-mini" aria-label="Install items"><tbody>{b.data.items.map((i) => <tr key={i.item_id}><td>{!readOnly && <Check aria-label={`Installed ${i.name}`} checked={installed.has(i.item_id)} disabled={!i.ready} onChange={(e) => { const n = new Set(installed); if (e.target.checked) n.add(i.item_id); else n.delete(i.item_id); setInstalled(n); }} />}</td>
              <td>{i.room}</td><td>{i.doc_code ? `${i.doc_code} · ` : ''}{i.name}</td><td>{i.ready ? <Status kind="ready" pip="ready">In storage</Status> : (i.components ?? []).some((c) => c.freight_claim_open) ? <Status kind="blocked" pip="closed">Freight claim</Status> : <Status kind="risk" pip="risk">Not received</Status>}</td></tr>)}</tbody></table>}
        </Section>
        {!readOnly && <>
          <Field label="Punch list" help="One item per line"><Textarea rows={3} value={punch} onChange={(e) => setPunch(e.target.value)} /></Field>
          <span className="btn-row"><Button variant="primary" disabled={busy === 'fin'} onClick={() => run('fin', base(jobId), { op: 'complete_install', checklistId: b.data!.checklist.id, doneKeys: [...keys], installedItemIds: [...installed],
            punch: punch.split('\n').map((t) => t.trim()).filter(Boolean).map((title) => ({ title })) }, 'Install day saved')}>Save the install day</Button></span>
        </>}
      </>}
    </div>
  );
}

function Reimbursables({ jobId, today }: { jobId: string; today: string }) {
  const { readOnly } = useShell();
  const b = useBoard<{ reimbursables: Reimb[] }>(`${base(jobId)}?view=reimbursables`);
  const { run, busy, error } = useDo(b.reload);
  const [f, setF] = useState<{ kind: 'SAMPLES' | 'TRAVEL' | 'PRINTING' | 'FREIGHT' | 'STORAGE' | 'OTHER'; description: string; on: string; cost: string; markup: number | null }>({ kind: 'SAMPLES', description: '', on: today, cost: '', markup: null });
  const state = <BoardState b={b} what="Reimbursables" />;
  if (!b.data) return state;
  const open = b.data.reimbursables.filter((r) => r.status === 'OPEN' && r.billable);
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      {b.data.reimbursables.length === 0 ? <Empty title="No reimbursable expenses" body="Samples, travel, printing, freight and storage the client pays back, with the firm's markup." /> :
        <table className="ops-mini" aria-label="Reimbursables"><tbody>{b.data.reimbursables.map((r) => <tr key={r.id}><td>{day(r.incurred_on, today)}</td><td>{r.kind.toLowerCase()}</td><td>{r.description}</td><td className="n">{money(r.cost_cents)}</td><td>{r.billable ? r.status.toLowerCase() : 'not billable'}</td></tr>)}</tbody></table>}
      {!readOnly && <div className="ops-toolbar">
        <Field label="Kind"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as typeof f.kind })}>{(['SAMPLES', 'TRAVEL', 'PRINTING', 'FREIGHT', 'STORAGE', 'OTHER'] as const).map((k) => <option key={k} value={k}>{k.toLowerCase()}</option>)}</Select></Field>
        <Field label="What"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="Date"><Input type="date" value={f.on} onChange={(e) => setF({ ...f, on: e.target.value })} /></Field>
        <Field label="Cost" error={f.cost && centsFrom(f.cost) == null ? 'Dollars' : undefined}><Input value={f.cost} style={{ width: 100 }} onChange={(e) => setF({ ...f, cost: e.target.value })} /></Field>
        <Field label="Markup"><PctInput value={f.markup} max={500} aria-label="Markup" onChange={(v) => setF({ ...f, markup: v })} /></Field>
        <Button disabled={!f.description.trim() || !((centsFrom(f.cost) ?? 0) > 0) || busy === 'add'} onClick={async () => { const x = await run('add', base(jobId), { op: 'reimbursable', kind: f.kind, description: f.description.trim(), incurredOn: f.on || null, costCents: centsFrom(f.cost), markupPct: f.markup }, 'Added'); if (x) setF({ ...f, description: '', cost: '' }); }}>Add</Button>
        {open.length > 0 && <Button variant="primary" disabled={busy === 'bill'} onClick={() => run('bill', base(jobId), { op: 'bill_reimbursables' }, 'Billed to the client')}>Bill {open.length} open</Button>}
      </div>}
    </div>
  );
}
