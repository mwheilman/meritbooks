'use client';

import { useMemo, useState } from 'react';
import { Button, ButtonRow, Check, Field, InlineNotice, Input, QueueTable, Select, Status, Tabs, count, money, type QueueColumn } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, PctInput, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, centsFrom, day, qty, useBoard, useDo } from '@/components/dealer/common/depth';
import { DATE_KEYS, DATE_WORDS } from './DesignHub';

interface Item { id: string; room: string; doc_code: string | null; name: string; category: string | null; qty: number; is_placeholder: boolean; budget_cents: number | null; client_unit_price_cents: number | null; client_total_cents: number | null; deposit_pct: number; client_visible: boolean; status: string; decided_by_name: string | null; client_comment: string | null }
interface Comp { id: string; dsn_item_id: string; component_kind: string | null; description: string; vendor_id: string | null; vendor_sku: string | null; sidemark: string | null; qty: number; uom: string | null; unit_cost_cents: number | null; markup_pct: number | null; status: string; po_number: string | null; commitment_id: string | null; ordered_on: string | null; shipped_on: string | null; expected_on: string | null; install_on: string | null; client_deposit_on: string | null; vendor_deposit_on: string | null; client_balance_on: string | null; vendor_balance_on: string | null; dates_done: Record<string, boolean> | null; received_condition: string | null; freight_claim_open: boolean | null }
interface Proposal { id: string; number: string; version: number; title: string | null; status: string; sent_at: string | null }
interface PItem { id: string; proposal_id: string; item_id: string; client_price_cents: number | null; deposit_cents: number | null; decision: string | null; comment: string | null; decided_by_name: string | null; decided_method: string | null; decided_at: string | null }
interface Dep { item_id: string; name: string; room: string; deposit_request_id: string | null; request_status: string | null; invoice_number: string | null; required_cents: number | null; allocated_cents: number | null; held_cents: number | null }
interface Data { items: Item[]; components: Comp[]; proposals: Proposal[]; proposalItems: PItem[]; deposits: Dep[]; moves: Array<{ id: string; from_item_id: string; to_item_id: string; cents: number | null; reason: string; books_state: string | null; created_at: string }>; agreement: Record<string, unknown> | null; ledger: Array<{ id: string; kind: string; key: string; cents: number | null; created_at: string }> }

type Tab = 'items' | 'proposals' | 'money' | 'fees';
const KINDS = ['ITEM', 'FRAME', 'COM_FABRIC', 'WORKROOM', 'FINISH', 'HARDWARE', 'FREIGHT', 'OTHER'] as const;
const dateOf = (c: Comp, k: (typeof DATE_KEYS)[number]): string | null => ({ order: c.ordered_on, ship: c.shipped_on, delivery: c.expected_on, install: c.install_on, client_deposit: c.client_deposit_on, vendor_deposit: c.vendor_deposit_on, client_balance: c.client_balance_on, vendor_balance: c.vendor_balance_on })[k];

/** A design project: items by room with their components, client approvals item by item, deposits per item, POs by vendor, fees. */
export function DesignProject({ jobId, today, vendors, contacts }: { jobId: string; today: string; vendors: Array<{ id: string; name: string }>; contacts: Array<{ id: string; name: string }> }) {
  const { readOnly } = useShell();
  const url = `/api/design/jobs/${jobId}`;
  const b = useBoard<Data>(url);
  const { run, busy, error } = useDo(b.reload);
  const [tab, setTab] = useState<Tab>('items');
  const [openItem, setOpenItem] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [it, setIt] = useState({ room: '', name: '', qty: '1', budget: '', price: '', dep: 0.5 as number | null, placeholder: false });
  const [co, setCo] = useState({ kind: 'ITEM', vendor: '', desc: '', qty: '1', uom: 'EA', cost: '', markup: '', sidemark: '', sku: '' });
  const [dec, setDec] = useState({ name: '', method: 'IN_PERSON' });
  const [mv, setMv] = useState({ from: '', to: '', amount: '', reason: '' });
  const [notify, setNotify] = useState('');
  const [fee, setFee] = useState({ model: 'HOURLY', hourly: '', pct: null as number | null, proc: null as number | null });
  const vname = (id: string | null) => vendors.find((v) => v.id === id)?.name ?? '—';
  const byRoom = useMemo(() => { const m = new Map<string, Item[]>(); for (const i of b.data?.items ?? []) m.set(i.room, [...(m.get(i.room) ?? []), i]); return [...m.entries()]; }, [b.data]);

  const state = <BoardState b={b} what="The project" />;
  if (!b.data) return state;
  const d = b.data;
  const item = d.items.find((i) => i.id === openItem) ?? null;
  const comps = d.components.filter((c) => c.dsn_item_id === openItem);
  const itemCols: QueueColumn<Item>[] = [
    { id: 'n', header: 'Item', cell: (i) => <><span className="l1">{i.doc_code ? `${i.doc_code} · ` : ''}{i.name}</span><span className="l2">{i.category ?? ''}{i.is_placeholder ? ' · placeholder' : ''}{i.client_comment ? ` · “${i.client_comment}”` : ''}</span></> },
    { id: 'q', header: 'Qty', numeric: true, width: 70, cell: (i) => qty(i.qty) },
    { id: 'b', header: 'Budget', numeric: true, width: 110, cell: (i) => (i.budget_cents == null ? '—' : money(i.budget_cents)) },
    { id: 'p', header: 'Client price', numeric: true, width: 120, cell: (i) => (i.client_total_cents == null ? '—' : money(i.client_total_cents)) },
    { id: 's', header: 'Status', width: 140, cell: (i) => <Status kind={i.status === 'APPROVED' || i.status === 'ORDERED' ? 'ready' : i.status === 'REJECTED' ? 'blocked' : 'track'} pip="open">{i.status.toLowerCase()}{i.decided_by_name ? ` · ${i.decided_by_name}` : ''}</Status> },
  ];

  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <Tabs<Tab> aria-label="Project" value={tab} onChange={setTab} items={[{ value: 'items', label: 'Items', count: count(d.items.length) }, { value: 'proposals', label: 'Client approvals', count: count(d.proposalItems.filter((p) => !p.decision).length) }, { value: 'money', label: 'Deposits and POs', count: '' }, { value: 'fees', label: 'Fees', count: '' }]} />
      {tab === 'items' && (
        <>
          {d.items.length === 0 ? <Empty title="No items yet" body="Add each piece by room: its budget, client price and deposit. Components (frame, fabric, workroom, freight) hang off the item and are ordered from their vendors." /> : byRoom.map(([room, items]) => (
            <Section key={room} title={room} meta={`${count(items.length)} items`}>
              <div className="mp-table"><QueueTable aria-label={`${room} items`} columns={itemCols} rows={items} getRowId={(i) => i.id} selectable={!readOnly} selected={sel} onSelectedChange={setSel} cursorId={openItem} openOnClick onOpen={(i) => setOpenItem(i.id)} /></div>
            </Section>
          ))}
          {item && (
            <Section title={item.name} meta={`${item.room} · ${count(comps.length)} components`}>
              {comps.length === 0 ? <p className="t-cap">No components yet.</p> : (
                <table className="ops-mini" aria-label="Components">
                  <thead><tr><th>Component</th><th>Vendor</th><th className="n">Qty</th><th className="n">Cost</th><th>Status</th>{DATE_KEYS.map((k) => <th key={k}>{DATE_WORDS[k]}</th>)}</tr></thead>
                  <tbody>{comps.map((c) => <tr key={c.id}><td>{c.description}<div className="t-cap">{(c.component_kind ?? '').toLowerCase().replace(/_/g, ' ')}{c.sidemark ? ` · ${c.sidemark}` : ''}{c.po_number ? ` · ${c.po_number}` : ''}</div></td><td>{vname(c.vendor_id)}</td><td className="n">{qty(c.qty, c.uom)}</td><td className="n">{c.unit_cost_cents == null ? '—' : money(c.unit_cost_cents)}</td><td>{c.freight_claim_open ? <span className="neg">Freight claim</span> : c.status.toLowerCase()}</td>
                    {DATE_KEYS.map((k) => <td key={k} className={c.dates_done?.[k] ? 'ink-3' : undefined}>{day(dateOf(c, k), today)}</td>)}</tr>)}</tbody>
                </table>
              )}
              {!readOnly && (
                <div className="ops-toolbar" style={{ marginTop: 8 }}>
                  <Field label="Kind"><Select value={co.kind} onChange={(e) => setCo({ ...co, kind: e.target.value })}>{KINDS.map((k) => <option key={k} value={k}>{k.toLowerCase().replace(/_/g, ' ')}</option>)}</Select></Field>
                  <Field label="Vendor"><Select value={co.vendor} onChange={(e) => setCo({ ...co, vendor: e.target.value })}><option value="">Pick</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select></Field>
                  <Field label="Description"><Input value={co.desc} onChange={(e) => setCo({ ...co, desc: e.target.value })} style={{ width: 200 }} /></Field>
                  <Field label="Qty"><Input inputMode="decimal" value={co.qty} onChange={(e) => setCo({ ...co, qty: e.target.value })} style={{ width: 60 }} /></Field>
                  <Field label="Unit"><Input value={co.uom} onChange={(e) => setCo({ ...co, uom: e.target.value.toUpperCase() })} style={{ width: 60 }} /></Field>
                  <Field label="Unit cost"><Input inputMode="decimal" value={co.cost} onChange={(e) => setCo({ ...co, cost: e.target.value })} style={{ width: 90 }} /></Field>
                  <Field label="Markup %"><Input inputMode="decimal" value={co.markup} onChange={(e) => setCo({ ...co, markup: e.target.value })} style={{ width: 70 }} /></Field>
                  <Field label="Sidemark"><Input value={co.sidemark} onChange={(e) => setCo({ ...co, sidemark: e.target.value })} style={{ width: 140 }} /></Field>
                  <Button disabled={!co.vendor || !co.desc.trim() || centsFrom(co.cost) == null || busy === 'co'} onClick={async () => {
                    if (await run('co', url, { op: 'add_component', itemId: item.id, kind: co.kind, vendorId: co.vendor, description: co.desc.trim(), qty: Number(co.qty) > 0 ? Number(co.qty) : 1, uom: co.uom || 'EA', unitCostCents: centsFrom(co.cost), markupPct: co.markup.trim() ? Number(co.markup) / 100 : null, sidemark: co.sidemark || null, vendorSku: co.sku || null }, 'Added the component')) setCo({ ...co, desc: '', cost: '', sku: '' });
                  }}>Add component</Button>
                </div>
              )}
            </Section>
          )}
          {!readOnly && (
            <Section title="Add an item">
              <div className="ops-toolbar">
                <Field label="Room"><Input value={it.room} onChange={(e) => setIt({ ...it, room: e.target.value })} style={{ width: 140 }} /></Field>
                <Field label="Item"><Input value={it.name} onChange={(e) => setIt({ ...it, name: e.target.value })} style={{ width: 200 }} /></Field>
                <Field label="Qty"><Input inputMode="decimal" value={it.qty} onChange={(e) => setIt({ ...it, qty: e.target.value })} style={{ width: 60 }} /></Field>
                <Field label="Budget"><Input inputMode="decimal" value={it.budget} onChange={(e) => setIt({ ...it, budget: e.target.value })} style={{ width: 100 }} /></Field>
                <Field label="Client unit price"><Input inputMode="decimal" value={it.price} onChange={(e) => setIt({ ...it, price: e.target.value })} style={{ width: 110 }} /></Field>
                <Field label="Deposit"><PctInput aria-label="Deposit percent" value={it.dep} onChange={(v) => setIt({ ...it, dep: v })} /></Field>
                <Check label="Placeholder" checked={it.placeholder} onChange={(e) => setIt({ ...it, placeholder: e.target.checked })} />
                <Button variant="primary" disabled={!it.room.trim() || !it.name.trim() || busy === 'it'} onClick={async () => {
                  if (await run('it', url, { op: 'add_item', item: { room: it.room.trim(), name: it.name.trim(), qty: Number(it.qty) > 0 ? Number(it.qty) : 1, budgetCents: centsFrom(it.budget), clientUnitPriceCents: centsFrom(it.price), depositPct: it.dep ?? 0.5, isPlaceholder: it.placeholder } }, 'Added the item')) setIt({ ...it, name: '', budget: '', price: '' });
                }}>Add item</Button>
              </div>
            </Section>
          )}
          {!readOnly && sel.size > 0 && (
            <InlineNotice tone="info" title={`${count(sel.size)} items selected.`}>
              <ButtonRow>
                <Select aria-label="Tell the client" value={notify} onChange={(e) => setNotify(e.target.value)}><option value="">Do not email the client</option>{contacts.map((c) => <option key={c.id} value={c.id}>Email {c.name}</option>)}</Select>
                <Button variant="primary" disabled={busy === 'send'} onClick={async () => { if (await run('send', url, { op: 'send_proposal', itemIds: [...sel], notifyContactId: notify || null }, (r: { number: string }) => `Sent ${r.number} for approval`)) setSel(new Set()); }}>Send for client approval</Button>
                <Button disabled={busy === 'dep'} onClick={() => void run('dep', url, { op: 'request_deposits', itemIds: [...sel] }, 'Requested the deposits')}>Request deposits</Button>
              </ButtonRow>
            </InlineNotice>
          )}
        </>
      )}
      {tab === 'proposals' && (
        <Section title="Client approvals" meta="Each item is approved or declined on its own">
          {d.proposals.length === 0 ? <Empty title="Nothing sent yet" body="Select items and send them for approval; the client decides item by item, and an approval can request the item's deposit." /> : d.proposals.map((p) => (
            <div key={p.id} className="stack" style={{ marginBottom: 16 }}>
              <h3 className="t-section">{p.number} · v{p.version} {p.title ? `· ${p.title}` : ''} <span className="t-cap">{p.sent_at ? `sent ${day(p.sent_at, today)}` : ''}</span></h3>
              <table className="ops-mini" aria-label={`Items on ${p.number}`}>
                <thead><tr><th>Item</th><th className="n">Price</th><th className="n">Deposit</th><th>Decision</th><th /></tr></thead>
                <tbody>{d.proposalItems.filter((x) => x.proposal_id === p.id).map((x) => {
                  const i = d.items.find((y) => y.id === x.item_id);
                  return (
                    <tr key={x.id}><td>{i?.name ?? 'Item'}<div className="t-cap">{i?.room ?? ''}</div></td><td className="n">{x.client_price_cents == null ? '—' : money(x.client_price_cents)}</td><td className="n">{x.deposit_cents == null ? '—' : money(x.deposit_cents)}</td>
                      <td>{x.decision ? `${x.decision.toLowerCase()} · ${x.decided_by_name ?? ''} · ${(x.decided_method ?? '').toLowerCase().replace(/_/g, ' ')}` : 'Waiting'}{x.comment ? <div className="t-cap">“{x.comment}”</div> : null}</td>
                      <td>{!readOnly && !x.decision && <ButtonRow>
                        <Button disabled={!dec.name.trim() || busy === x.id} onClick={() => void run(x.id, url, { op: 'decide', proposalItemId: x.id, decision: 'APPROVED', name: dec.name.trim(), method: dec.method, requestDeposit: true }, 'Recorded the approval; deposit requested')}>Approved</Button>
                        <Button variant="quiet" disabled={!dec.name.trim() || busy === x.id} onClick={() => void run(x.id, url, { op: 'decide', proposalItemId: x.id, decision: 'REJECTED', name: dec.name.trim(), method: dec.method }, 'Recorded the decline')}>Declined</Button>
                      </ButtonRow>}</td></tr>
                  );
                })}</tbody>
              </table>
            </div>
          ))}
          {!readOnly && d.proposals.length > 0 && (
            <div className="ops-toolbar">
              <Field label="Who decided"><Input value={dec.name} onChange={(e) => setDec({ ...dec, name: e.target.value })} style={{ width: 180 }} /></Field>
              <Field label="How"><Select value={dec.method} onChange={(e) => setDec({ ...dec, method: e.target.value })}><option value="IN_PERSON">In person</option><option value="PHONE">Phone</option><option value="EMAIL">Email</option><option value="PORTAL">Client portal</option></Select></Field>
            </div>
          )}
        </Section>
      )}
      {tab === 'money' && (
        <>
          <Section title="Deposits by item" meta="Held per item; moving money between items leaves a memo for Merit Books">
            {d.deposits.length === 0 ? <p className="t-cap">No deposits requested.</p> : (
              <table className="ops-mini" aria-label="Deposits">
                <thead><tr><th>Item</th><th>Invoice</th><th className="n">Required</th><th className="n">Moved in / out</th><th className="n">Held</th></tr></thead>
                <tbody>{d.deposits.map((x) => <tr key={`${x.item_id}${x.deposit_request_id ?? ''}`}><td>{x.name}<div className="t-cap">{x.room}</div></td><td>{x.invoice_number ?? (x.request_status ?? '—').toLowerCase()}</td><td className="n">{x.required_cents == null ? '—' : money(x.required_cents)}</td><td className="n">{x.allocated_cents == null ? '—' : money(x.allocated_cents)}</td><td className="n"><b>{x.held_cents == null ? '—' : money(x.held_cents)}</b></td></tr>)}</tbody>
              </table>
            )}
            {!readOnly && d.deposits.length > 0 && (
              <div className="ops-toolbar" style={{ marginTop: 8 }}>
                <Field label="From item"><Select value={mv.from} onChange={(e) => setMv({ ...mv, from: e.target.value })}><option value="">Pick</option>{d.deposits.map((x) => <option key={x.item_id} value={x.item_id}>{x.name}</option>)}</Select></Field>
                <Field label="To item"><Select value={mv.to} onChange={(e) => setMv({ ...mv, to: e.target.value })}><option value="">Pick</option>{d.items.filter((x) => x.id !== mv.from).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
                <Field label="Amount"><Input inputMode="decimal" value={mv.amount} onChange={(e) => setMv({ ...mv, amount: e.target.value })} style={{ width: 100 }} /></Field>
                <Field label="Why"><Input value={mv.reason} onChange={(e) => setMv({ ...mv, reason: e.target.value })} style={{ width: 220 }} /></Field>
                <Button disabled={!mv.from || !mv.to || !(centsFrom(mv.amount) ?? 0) || !mv.reason.trim() || busy === 'mv'} onClick={async () => { if (await run('mv', url, { op: 'reallocate', fromItemId: mv.from, toItemId: mv.to, cents: centsFrom(mv.amount), reason: mv.reason.trim() }, 'Moved the deposit')) setMv({ from: '', to: '', amount: '', reason: '' }); }}>Move deposit</Button>
              </div>
            )}
          </Section>
          <Section title="Purchase orders" meta="One PO per vendor, a line per component with its sidemark">
            <p className="t-cap">{count(d.components.filter((c) => c.status === 'APPROVED' && !c.commitment_id).length)} approved components not yet ordered.</p>
            {!readOnly && <Button variant="primary" disabled={busy === 'po' || !d.components.some((c) => c.status === 'APPROVED' && !c.commitment_id)} onClick={() => void run('po', url, { op: 'create_pos' }, (r: { purchase_orders: unknown[] }) => `Drafted ${r.purchase_orders.length} purchase orders`)}>Draft POs by vendor</Button>}
          </Section>
        </>
      )}
      {tab === 'fees' && (
        <Section title="Design fees" meta={d.agreement ? `Model: ${String(d.agreement.fee_model ?? '').toLowerCase().replace(/_/g, ' ')}` : 'No agreement yet'}>
          {!readOnly && (
            <div className="ops-toolbar">
              <Field label="Fee model"><Select value={fee.model} onChange={(e) => setFee({ ...fee, model: e.target.value })}>{['HOURLY', 'FLAT_PHASE', 'PCT_BUDGET', 'COST_PLUS', 'PROCUREMENT_FEE', 'HYBRID'].map((k) => <option key={k} value={k}>{k.toLowerCase().replace(/_/g, ' ')}</option>)}</Select></Field>
              <Field label="Hourly rate"><Input inputMode="decimal" value={fee.hourly} onChange={(e) => setFee({ ...fee, hourly: e.target.value })} style={{ width: 90 }} /></Field>
              <Field label="% of budget"><PctInput aria-label="Percent of budget" value={fee.pct} onChange={(v) => setFee({ ...fee, pct: v })} /></Field>
              <Field label="Procurement fee"><PctInput aria-label="Procurement fee percent" value={fee.proc} onChange={(v) => setFee({ ...fee, proc: v })} /></Field>
              <Button disabled={busy === 'fee'} onClick={() => void run('fee', url, { op: 'fee_agreement', agreement: { fee_model: fee.model, hourly_rate_cents: centsFrom(fee.hourly), pct_of_budget: fee.pct, procurement_fee_pct: fee.proc } }, 'Saved the fee agreement')}>Save agreement</Button>
              <span className="sp" />
              <Button variant="primary" disabled={!d.agreement || busy === 'inv'} onClick={() => void run('inv', url, { op: 'draft_fee_invoice', through: today }, (r: { total_cents?: number }) => `Drafted the fee invoice${r.total_cents != null ? ` · ${money(r.total_cents)}` : ''}; it goes through billing approval`)}>Draft fee invoice</Button>
            </div>
          )}
          {d.ledger.length === 0 ? <p className="t-cap">Nothing billed yet.</p> : (
            <table className="ops-mini" aria-label="Billed fees"><thead><tr><th>When</th><th>Kind</th><th>Basis</th><th className="n">Amount</th></tr></thead>
              <tbody>{d.ledger.map((x) => <tr key={x.id}><td>{day(x.created_at, today)}</td><td>{x.kind.toLowerCase().replace(/_/g, ' ')}</td><td>{x.key}</td><td className="n">{x.cents == null ? '—' : money(x.cents)}</td></tr>)}</tbody></table>
          )}
          <p className="t-cap">Hourly time is billed once: an entry on a fee invoice is locked.</p>
        </Section>
      )}
    </div>
  );
}
