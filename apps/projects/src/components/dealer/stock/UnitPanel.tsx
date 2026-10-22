'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Button, ButtonLink, Field, Input, KV, MoneyInput, Panel, PanelSection, Select, Status, Tag, Textarea, money, shortDate, toast,
} from '@meritbooks/merit-ui';
import {
  CONDITION_WORDS, COST_SOURCE_WORDS, COST_TYPE_WORDS, UNIT_STATUS, UNIT_VERB, agingMark, dealerActivitySentence, floorMark, outboxMark,
  unitMoves, unitTitle,
} from '@/lib/pm/dealer/labels';
import { ADDABLE_COST_TYPES, type PhotoItem, type StockLocationRow, type UnitCostType, type UnitStatus } from '@/lib/pm/dealer/types';
import type { UnitDetail } from '@/lib/pm/dealer/unit-queries';
import { HISTORY_WORDS, WO_STATUS } from '@/lib/pm/ops/labels';
import type { LookupItem } from '@/lib/pm/ops/types';
import { stamp } from '@/lib/time';
import { useShell } from '@/components/shell/ShellContext';
import { DetailState, Failure, StatusMark, parseNum } from '@/components/ops/common/bits';
import { Lookup } from '@/components/ops/common/Lookup';
import { useStore, useStoreDetail } from '../common/useStore';

export interface UnitPanelProps {
  id: string;
  today: string;
  stockLocations: StockLocationRow[];
  companyNames: Record<string, string>;
  onClose: () => void;
}

type Mode = 'none' | 'cost' | 'status' | 'transfer' | 'pdi' | 'register';

/**
 * One unit: status, Merit Books' floor-plan word (with its as-of time), the operational cost
 * build-up against what Books has acknowledged, prices, photos, service history and the store
 * actions the database will take from here.
 */
export function UnitPanel(p: UnitPanelProps) {
  const router = useRouter();
  const { readOnly } = useShell();
  const { act, busy, version, error } = useStore();
  const { data, error: loadError, isLoading, refetch } = useStoreDetail<UnitDetail>(`/api/dealer/units/${p.id}`, version);
  const [mode, setMode] = useState<Mode>('none');
  const url = `/api/dealer/units/${p.id}`;
  useEffect(() => setMode('none'), [p.id]);

  if (!data) {
    return (
      <Panel eyebrow="Unit" title="Loading" onClose={p.onClose}>
        <PanelSection><DetailState loading={isLoading} error={loadError} onRetry={() => void refetch()} what="Unit" /></PanelSection>
      </Panel>
    );
  }
  const u = data.unit;
  const inv = data.inventory;
  const status = u.unit_status;
  const days = inv?.days_in_stock ?? null;
  const ageMark = agingMark(days);
  const floor = floorMark({ ...u, sold_out_of_trust: !!u.sot_alert_at }, p.today);
  const moves = unitMoves(status, u.deal_id);
  const canDeal = !u.deal_id && !!status && ['ON_ORDER', 'IN_TRANSIT', 'IN_STOCK', 'PDI', 'DEMO'].includes(status);
  const canPdi = !!status && ['IN_STOCK', 'ON_HOLD', 'SOLD', 'DEMO'].includes(status) && !data.openWork.some((w) => w.kind === 'PDI');
  const canRegister = !!status && ['SOLD', 'DELIVERED', 'DEMO'].includes(status);
  const canTransfer = !!status && ['IN_STOCK', 'DEMO', 'RENTAL'].includes(status) && !u.deal_id;
  const canCost = !!status && ['ON_ORDER', 'IN_TRANSIT', 'IN_STOCK', 'PDI', 'DEMO', 'ON_HOLD', 'SOLD', 'RENTAL'].includes(status);
  const lifeCosts = data.costs.filter((c) => c.unit_life === u.unit_life);
  const olderCosts = data.costs.length - lifeCosts.length;
  const asOf = data.floor?.as_of ?? u.floor_status_at;

  const startDeal = async () => {
    const r = await act<{ dealId: string }>('deal', 'post', url, { op: 'deal', customerId: null }, 'Started a deal with this unit');
    if (r.data) router.push(`/deals/${r.data.dealId}`);
  };

  return (
    <Panel
      eyebrow={[u.stock_number ?? 'Unit', u.condition ? CONDITION_WORDS[u.condition] : 'Equipment']}
      title={unitTitle(u)}
      meta={[u.serial_number ? `S/N ${u.serial_number}` : null, u.vin ? `VIN ${u.vin}` : null, p.companyNames[u.location_id]].filter(Boolean).join(' · ')}
      figure={money(u.dealer_cost_cents)}
      onClose={p.onClose}
      foot={readOnly ? undefined : (
        <div className="btn-row" style={{ width: '100%' }}>
          {canCost && <Button onClick={() => setMode(mode === 'cost' ? 'none' : 'cost')}>Add cost</Button>}
          {moves.length > 0 && <Button onClick={() => setMode(mode === 'status' ? 'none' : 'status')}>Change status</Button>}
          {canTransfer && <Button variant="quiet" onClick={() => setMode(mode === 'transfer' ? 'none' : 'transfer')}>Transfer</Button>}
          <span className="sp" />
          {canDeal && <Button variant="primary" disabled={busy === 'deal'} onClick={() => void startDeal()}>Start a deal</Button>}
          {u.deal_id && data.deal && <ButtonLink variant="primary" href={`/deals/${u.deal_id}`}>Open deal {data.deal.number}</ButtonLink>}
        </div>
      )}
    >
      <PanelSection>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          {status ? <StatusMark mark={UNIT_STATUS[status]} /> : <Tag>Customer equipment</Tag>}
          {ageMark && <Status kind={ageMark.kind} pip={ageMark.pip}>{ageMark.word} in stock</Status>}
          {u.is_sample && <Tag>Sample</Tag>}
        </div>
        {u.sot_alert_at && (
          <div className="dl-note neg" style={{ marginTop: 12 }} role="alert">
            <b>Sold out of trust.</b> Merit Books reports this unit sold and the floor-plan lender not paid{typeof u.sot_alert?.amount_cents === 'number' ? `: ${money(u.sot_alert.amount_cents)} owed` : ''}{typeof u.sot_alert?.payoff_due_on === 'string' ? `, due ${shortDate(u.sot_alert.payoff_due_on, p.today)}` : ''}. Pay the lender in Merit Books today.
          </div>
        )}
        <div style={{ marginTop: 12 }}>
          <KV items={[
            ...(u.received_on ? [{ term: 'Received', value: shortDate(u.received_on, p.today) }] : []),
            ...(u.stock_location_id ? [{ term: 'Location', value: p.stockLocations.find((s) => s.id === u.stock_location_id)?.name ?? inv?.stock_location_code ?? 'Stock' }] : []),
            ...(u.mfr_vendor_id ? [{ term: 'Manufacturer', value: data.vendors[u.mfr_vendor_id] ?? 'Vendor' }] : []),
            ...(u.mfr_invoice_ref ? [{ term: 'Invoice', value: u.mfr_invoice_ref }] : []),
            ...(u.meter_reading != null ? [{ term: 'Hours', value: `${u.meter_reading}${u.meter_read_on ? ` on ${shortDate(u.meter_read_on, p.today)}` : ''}` }] : []),
            ...(data.customer ? [{ term: 'Owner', value: data.customer }] : []),
            ...(u.unit_sold_on ? [{ term: 'Sold', value: shortDate(u.unit_sold_on, p.today) }] : []),
            ...(u.unit_delivered_on ? [{ term: 'Delivered', value: shortDate(u.unit_delivered_on, p.today) }] : []),
            ...(u.registered_on ? [{ term: 'Registered', value: `${shortDate(u.registered_on, p.today)}${u.warranty_expires_on ? `, warranty to ${shortDate(u.warranty_expires_on, p.today)}` : ''}` }] : []),
          ]} />
        </div>
        {error && <div style={{ marginTop: 12 }}><Failure text={error} /></div>}
      </PanelSection>

      {mode === 'cost' && !readOnly && <CostForm busy={busy === 'cost'} onCancel={() => setMode('none')} onSubmit={async (b) => { const r = await act('cost', 'post', url, { op: 'cost', ...b }, `Added ${COST_TYPE_WORDS[b.costType].toLowerCase()} of ${money(b.amountCents)}`); if (r.data) setMode('none'); }} />}
      {mode === 'status' && !readOnly && status && <StatusForm moves={moves} busy={busy === 'status'} onCancel={() => setMode('none')} onSubmit={async (to, reason) => { const r = await act('status', 'post', url, { op: 'status', to, reason }, `${u.stock_number ?? 'Unit'} moved to ${UNIT_STATUS[to].word.toLowerCase()}`); if (r.data) setMode('none'); }} />}
      {mode === 'transfer' && !readOnly && <TransferForm current={u.stock_location_id} locations={p.stockLocations} companyNames={p.companyNames} unitCompany={u.location_id} busy={busy === 'transfer'} onCancel={() => setMode('none')} onSubmit={async (to, reason) => { const r = await act('transfer', 'post', url, { op: 'transfer', toStockLocationId: to, reason }, 'Transferred the unit'); if (r.data) setMode('none'); }} />}
      {mode === 'pdi' && !readOnly && <PdiForm busy={busy === 'pdi'} onCancel={() => setMode('none')} onSubmit={async (summary) => { const r = await act<{ workOrderId: string }>('pdi', 'post', url, { op: 'pdi', summary }, 'Opened the PDI repair order'); if (r.data) { setMode('none'); router.push(`/work-orders?wo=${r.data.workOrderId}`); } }} />}
      {mode === 'register' && !readOnly && <RegisterForm today={p.today} busy={busy === 'register'} onCancel={() => setMode('none')} onSubmit={async (b) => { const r = await act('register', 'post', url, { op: 'register', ...b }, 'Registered the warranty'); if (r.data) setMode('none'); }} />}

      <PanelSection title="Floor plan" meta={<Status kind={floor.kind} pip={floor.pip}>{floor.word}</Status>}>
        {data.floor || u.floor_status ? (
          <>
            <KV items={[
              ...((data.floor?.lender_vendor_id ?? u.floor_lender_vendor_id) ? [{ term: 'Lender', value: data.vendors[(data.floor?.lender_vendor_id ?? u.floor_lender_vendor_id)!] ?? 'Lender' }] : []),
              ...((data.floor?.note_ref ?? u.floor_note_ref) ? [{ term: 'Note', value: (data.floor?.note_ref ?? u.floor_note_ref)! }] : []),
              ...(data.floor?.principal_cents != null ? [{ term: 'Principal', value: money(data.floor.principal_cents) }] : []),
              ...(u.payoff_cents ? [{ term: 'Payoff', value: money(u.payoff_cents) }] : []),
              ...(u.payoff_due_on ? [{ term: 'Payoff due', value: shortDate(u.payoff_due_on, p.today) }] : []),
              ...(data.floor?.curtailment_due_on ? [{ term: 'Curtailment', value: `${data.floor.curtailment_cents != null ? money(data.floor.curtailment_cents) : ''} due ${shortDate(data.floor.curtailment_due_on, p.today)}` }] : []),
              { term: 'Payoff scheduled', value: u.payoff_scheduled ? 'Yes' : 'No' },
            ]} />
            <p className="t-cap" style={{ marginTop: 8 }}>From Merit Books{asOf ? `, as of ${stamp(asOf)}` : ''}. Lenders, notes and payoffs are kept there.</p>
          </>
        ) : (
          <p className="t-cap">Merit Books has not reported a floor-plan status for this unit. Floored units show their lender, payoff and due date here once Books does.</p>
        )}
      </PanelSection>

      <PanelSection title="Cost build-up" meta={<span className="tnum b">{money(u.dealer_cost_cents)}</span>}>
        {lifeCosts.length === 0 ? (
          <p className="t-cap">No cost yet. The manufacturer invoice comes with the receipt; add freight, setup and accessories as they land.</p>
        ) : (
          <table className="dl-tbl">
            <thead><tr><th>Cost</th><th className="n">Amount</th><th>Merit Books</th></tr></thead>
            <tbody>
              {lifeCosts.map((c) => {
                const m = c.outbox_id ? data.costMarks[c.outbox_id] : null;
                const mk = m ? outboxMark(m.status, m.suppressed_reason) : null;
                return (
                  <tr key={c.id} className={c.status === 'VOID' ? 'void' : undefined}>
                    <td>
                      <span className="l1">{COST_TYPE_WORDS[c.cost_type]}</span>
                      <span className="l2">{[COST_SOURCE_WORDS[c.source], c.vendor_id ? data.vendors[c.vendor_id] : null, c.vendor_invoice_ref, c.labor_cents ? `labor ${money(c.labor_cents)}` : null, c.parts_cents ? `parts ${money(c.parts_cents)}` : null, c.memo].filter(Boolean).join(' · ')}</span>
                    </td>
                    <td className="n">{money(c.amount_cents)}</td>
                    <td>{mk ? <Status kind={mk.kind} pip={mk.pip}>{mk.word}</Status> : <span className="l2">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot><tr><td>Operational cost</td><td className="n">{money(u.dealer_cost_cents)}</td><td /></tr></tfoot>
          </table>
        )}
        <div className="ops-facts" style={{ marginTop: 8 }}>
          {inv && <span>Acknowledged by Books <b className="tnum">{money(inv.cost_acked_by_books_cents)}</b> of {money(u.dealer_cost_cents)}</span>}
          {u.books_cost_cents != null && <span>Merit Books cost basis <b className="tnum">{money(u.books_cost_cents)}</b>{u.books_cost_as_of ? ` as of ${shortDate(u.books_cost_as_of.slice(0, 10), p.today)}` : ''}</span>}
          {olderCosts > 0 && <span>{olderCosts} cost row{olderCosts === 1 ? '' : 's'} from an earlier life of this serial</span>}
        </div>
      </PanelSection>

      <PricesSection unit={u} readOnly={readOnly} busy={busy} onSave={(patch, label) => void act('edit', 'post', url, { op: 'update', ...patch }, label)} />

      {(canPdi || canRegister || data.openWork.length > 0) && (
        <PanelSection title="Service">
          {data.openWork.length > 0 && (
            <ul className="feed feed--flush">
              {data.openWork.map((w) => (
                <li key={w.id}>
                  <Link className="l1 nlink" href={`/work-orders?wo=${w.id}`} style={{ fontWeight: 400 }}>{w.number} · {w.summary}</Link>
                  <span className="t">{WO_STATUS[w.status as keyof typeof WO_STATUS]?.word ?? w.status}</span>
                </li>
              ))}
            </ul>
          )}
          {!readOnly && (
            <div className="btn-row" style={{ marginTop: 8 }}>
              {canPdi && <Button onClick={() => setMode('pdi')}>Open PDI</Button>}
              {canRegister && <Button onClick={() => setMode('register')}>Register warranty</Button>}
            </div>
          )}
        </PanelSection>
      )}

      <Photos unitId={u.id} photos={data.photos} readOnly={readOnly} onAdded={() => void refetch()} />

      <PanelSection title="History">
        {data.history.length === 0 && data.activity.length === 0 ? (
          <p className="t-cap">Receipts, status moves, PDI and repairs on this serial show here.</p>
        ) : (
          <ul className="feed feed--flush">
            {data.history.slice(0, 8).map((h) => (
              <li key={h.history_id}>
                <span><span className="l1" style={{ fontWeight: 400 }}>{HISTORY_WORDS[h.kind]}{h.summary ? `: ${h.summary}` : ''}</span>{h.work_order_number && <span className="l2">{h.work_order_number}{h.meter_reading != null ? ` · ${h.meter_reading} hours` : ''}</span>}</span>
                <span className="t">{shortDate(h.performed_on, p.today)}</span>
              </li>
            ))}
            {data.activity.slice(0, 10).map((a) => (
              <li key={a.id}>
                <span className="l1" style={{ fontWeight: 400 }}>{dealerActivitySentence(a)} {a.actor_type === 'SYSTEM' ? <Tag>System</Tag> : null}</span>
                <span className="t">{stamp(a.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </PanelSection>
    </Panel>
  );
}

function CostForm({ busy, onCancel, onSubmit }: { busy: boolean; onCancel: () => void; onSubmit: (b: { costType: UnitCostType; amountCents: number; laborCents: number | null; partsCents: number | null; vendorId: string | null; vendorInvoiceRef: string | null; memo: string | null }) => void }) {
  const [type, setType] = useState<UnitCostType>('FREIGHT');
  const [amount, setAmount] = useState<number | null>(null);
  const [labor, setLabor] = useState<number | null>(null);
  const [parts, setParts] = useState<number | null>(null);
  const [vendor, setVendor] = useState<LookupItem | null>(null);
  const [ref, setRef] = useState('');
  const [memo, setMemo] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <PanelSection title="Add cost">
      <form className="mp-form" onSubmit={(e) => {
        e.preventDefault();
        if (!amount || amount <= 0) return setErr('Give the amount.');
        if ((labor ?? 0) + (parts ?? 0) > amount) return setErr('Labor plus parts cannot be more than the amount.');
        setErr(null);
        onSubmit({ costType: type, amountCents: amount, laborCents: labor, partsCents: parts, vendorId: vendor?.id ?? null, vendorInvoiceRef: ref.trim() || null, memo: memo.trim() || null });
      }}>
        <div className="mp-form-2">
          <Field label="Kind">
            <Select value={type} onChange={(e) => setType(e.target.value as UnitCostType)} autoFocus>
              {ADDABLE_COST_TYPES.map((t) => <option key={t} value={t}>{COST_TYPE_WORDS[t]}</option>)}
            </Select>
          </Field>
          <Field label="Amount" error={err ?? undefined}><MoneyInput valueCents={amount} onChangeCents={setAmount} placeholder="0.00" /></Field>
        </div>
        {(type === 'SETUP_PDI' || type === 'RECON') && (
          <div className="mp-form-2">
            <Field label="Of which labor"><MoneyInput valueCents={labor} onChangeCents={setLabor} placeholder="0.00" /></Field>
            <Field label="Of which parts"><MoneyInput valueCents={parts} onChangeCents={setParts} placeholder="0.00" /></Field>
          </div>
        )}
        <div className="mp-form-2">
          <Field label="Vendor"><Lookup kind="vendors" value={vendor ? { id: vendor.id, label: vendor.label } : null} onChange={setVendor} placeholder="Optional" /></Field>
          <Field label="Vendor invoice"><Input value={ref} onChange={(e) => setRef(e.target.value)} maxLength={60} /></Field>
        </div>
        <Field label="Note"><Input value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={300} placeholder="Freight from the Kubota depot" /></Field>
        <p className="t-cap">Goes to Merit Books as a unit cost. Internal repair orders on the unit add their own cost when they close.</p>
        <div className="btn-row"><Button onClick={onCancel}>Back</Button><Button type="submit" variant="primary" disabled={busy}>Add cost</Button></div>
      </form>
    </PanelSection>
  );
}

function StatusForm({ moves, busy, onCancel, onSubmit }: { moves: UnitStatus[]; busy: boolean; onCancel: () => void; onSubmit: (to: UnitStatus, reason: string | null) => void }) {
  const [to, setTo] = useState<UnitStatus>(moves[0]!);
  const [reason, setReason] = useState('');
  const needsReason = to === 'RETURNED_TO_MFR' || to === 'TRANSFERRED';
  return (
    <PanelSection title="Change status">
      <form className="mp-form" onSubmit={(e) => { e.preventDefault(); onSubmit(to, reason.trim() || null); }}>
        <Field label="Move to">
          <Select value={to} onChange={(e) => setTo(e.target.value as UnitStatus)} autoFocus>
            {moves.map((m) => <option key={m} value={m}>{UNIT_VERB[m]}</option>)}
          </Select>
        </Field>
        <Field label={needsReason ? 'Why (goes to Merit Books)' : 'Why'}><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder={to === 'TRANSFERRED' ? 'Dealer trade to Ankeny Equipment' : to === 'DEMO' ? 'Demo for the spring open house' : ''} /></Field>
        {(to === 'DEMO' || to === 'RENTAL' || to === 'RETURNED_TO_MFR' || to === 'TRANSFERRED') && <p className="t-cap">Merit Books hears about this move; a floored demo or rental may change the lender’s terms.</p>}
        <div className="btn-row"><Button onClick={onCancel}>Back</Button><Button type="submit" variant="primary" disabled={busy || (needsReason && !reason.trim())}>{UNIT_VERB[to]}</Button></div>
      </form>
    </PanelSection>
  );
}

function TransferForm({ current, locations, companyNames, unitCompany, busy, onCancel, onSubmit }: { current: string | null; locations: StockLocationRow[]; companyNames: Record<string, string>; unitCompany: string; busy: boolean; onCancel: () => void; onSubmit: (to: string, reason: string | null) => void }) {
  const options = locations.filter((l) => l.id !== current);
  const [to, setTo] = useState(options[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const target = locations.find((l) => l.id === to);
  return (
    <PanelSection title="Transfer">
      {options.length === 0 ? (
        <p className="t-cap">There is no other stock location yet. Add lots and stores in Store settings.</p>
      ) : (
        <form className="mp-form" onSubmit={(e) => { e.preventDefault(); if (to) onSubmit(to, reason.trim() || null); }}>
          <Field label="To">
            <Select value={to} onChange={(e) => setTo(e.target.value)} autoFocus>
              {options.map((l) => <option key={l.id} value={l.id}>{l.code} · {l.name}{l.location_id !== unitCompany ? ` (${companyNames[l.location_id] ?? 'another company'})` : ''}</option>)}
            </Select>
          </Field>
          {target && target.location_id !== unitCompany && <p className="dl-note info">This moves the unit to another company. Merit Books records an inter-company transfer at its cost.</p>}
          <Field label="Why"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>
          <div className="btn-row"><Button onClick={onCancel}>Back</Button><Button type="submit" variant="primary" disabled={busy || !to}>Transfer</Button></div>
        </form>
      )}
    </PanelSection>
  );
}

function PdiForm({ busy, onCancel, onSubmit }: { busy: boolean; onCancel: () => void; onSubmit: (summary: string | null) => void }) {
  const [summary, setSummary] = useState('');
  return (
    <PanelSection title="Open PDI">
      <form className="mp-form" onSubmit={(e) => { e.preventDefault(); onSubmit(summary.trim() || null); }}>
        <Field label="Work"><Input autoFocus value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={200} placeholder="Pre-delivery inspection and setup" /></Field>
        <p className="t-cap">Opens an internal repair order on the unit. When it closes, its labor and parts become a setup cost on the unit.</p>
        <div className="btn-row"><Button onClick={onCancel}>Back</Button><Button type="submit" variant="primary" disabled={busy}>Open PDI</Button></div>
      </form>
    </PanelSection>
  );
}

function RegisterForm({ today, busy, onCancel, onSubmit }: { today: string; busy: boolean; onCancel: () => void; onSubmit: (b: { registeredOn: string | null; warrantyExpiresOn: string | null; oemRef: string | null }) => void }) {
  const [on, setOn] = useState(today);
  const [exp, setExp] = useState('');
  const [ref, setRef] = useState('');
  return (
    <PanelSection title="Register warranty">
      <form className="mp-form" onSubmit={(e) => { e.preventDefault(); onSubmit({ registeredOn: on || null, warrantyExpiresOn: exp || null, oemRef: ref.trim() || null }); }}>
        <div className="mp-form-2">
          <Field label="Registered on"><Input type="date" value={on} onChange={(e) => setOn(e.target.value)} autoFocus /></Field>
          <Field label="Warranty ends"><Input type="date" value={exp} onChange={(e) => setExp(e.target.value)} min={on} /></Field>
        </div>
        <Field label="Manufacturer registration number"><Input value={ref} onChange={(e) => setRef(e.target.value)} maxLength={60} /></Field>
        <p className="t-cap">Merit Books uses registration dates for sold-out-of-trust checks; lenders read them too.</p>
        <div className="btn-row"><Button onClick={onCancel}>Back</Button><Button type="submit" variant="primary" disabled={busy}>Register</Button></div>
      </form>
    </PanelSection>
  );
}

function PricesSection({ unit, readOnly, busy, onSave }: { unit: UnitDetail['unit']; readOnly: boolean; busy: string | null; onSave: (patch: Record<string, unknown>, label: string) => void }) {
  const [retail, setRetail] = useState<number | null>(unit.retail_price_cents);
  const [adv, setAdv] = useState<number | null>(unit.advertised_price_cents);
  const [stockNo, setStockNo] = useState(unit.stock_number ?? '');
  const [vin, setVin] = useState(unit.vin ?? '');
  const [category, setCategory] = useState(unit.category ?? '');
  const attachments = Array.isArray(unit.attachments) ? (unit.attachments as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  const [att, setAtt] = useState(attachments.join('\n'));
  useEffect(() => {
    setRetail(unit.retail_price_cents); setAdv(unit.advertised_price_cents); setStockNo(unit.stock_number ?? ''); setVin(unit.vin ?? ''); setCategory(unit.category ?? '');
  }, [unit.id, unit.retail_price_cents, unit.advertised_price_cents, unit.stock_number, unit.vin, unit.category]);
  if (readOnly) {
    return (
      <PanelSection title="Prices">
        <KV items={[{ term: 'Retail', value: unit.retail_price_cents == null ? '—' : money(unit.retail_price_cents) }, { term: 'Advertised', value: unit.advertised_price_cents == null ? '—' : money(unit.advertised_price_cents) }]} />
        {attachments.length > 0 && <p className="t-cap" style={{ marginTop: 8 }}>With: {attachments.join(', ')}</p>}
      </PanelSection>
    );
  }
  const margin = (adv ?? retail) != null && unit.dealer_cost_cents ? (adv ?? retail)! - unit.dealer_cost_cents : null;
  return (
    <PanelSection title="Prices and details" meta={margin != null ? <span className={margin < 0 ? 'tnum neg' : 'tnum'}>{money(margin)} over cost</span> : undefined}>
      <div className="mp-form">
        <div className="mp-form-2">
          <Field label="Retail"><MoneyInput valueCents={retail} onChangeCents={setRetail} onBlur={() => { if (retail !== unit.retail_price_cents) onSave({ retailPriceCents: retail }, 'Saved the retail price'); }} placeholder="0.00" /></Field>
          <Field label="Advertised"><MoneyInput valueCents={adv} onChangeCents={setAdv} onBlur={() => { if (adv !== unit.advertised_price_cents) onSave({ advertisedPriceCents: adv }, 'Saved the advertised price'); }} placeholder="0.00" /></Field>
        </div>
        <div className="mp-form-2">
          <Field label="Stock number"><Input value={stockNo} onChange={(e) => setStockNo(e.target.value)} onBlur={() => { if (stockNo.trim() && stockNo.trim().toUpperCase() !== (unit.stock_number ?? '')) onSave({ stockNumber: stockNo.trim() }, 'Saved the stock number'); }} maxLength={24} /></Field>
          <Field label="VIN or PIN"><Input value={vin} onChange={(e) => setVin(e.target.value)} onBlur={() => { if (vin.trim() !== (unit.vin ?? '')) onSave({ vin: vin.trim() || null }, 'Saved the VIN'); }} maxLength={40} /></Field>
        </div>
        <Field label="Category"><Input value={category} onChange={(e) => setCategory(e.target.value)} onBlur={() => { if (category.trim() !== (unit.category ?? '')) onSave({ category: category.trim().toUpperCase().replace(/\s+/g, '_') || null }, 'Saved the category'); }} maxLength={40} /></Field>
        <Field label="Attachments" help="One per line"><Textarea value={att} onChange={(e) => setAtt(e.target.value)} onBlur={() => { const next = att.split('\n').map((s) => s.trim()).filter(Boolean); if (next.join('|') !== attachments.join('|')) onSave({ attachments: next }, 'Saved the attachments'); }} maxLength={2000} /></Field>
        {busy === 'edit' && <span className="t-cap">Saving…</span>}
      </div>
    </PanelSection>
  );
}

function Photos({ unitId, photos: initial, readOnly, onAdded }: { unitId: string; photos: PhotoItem[]; readOnly: boolean; onAdded: () => void }) {
  const [photos, setPhotos] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => setPhotos(initial), [initial]);
  const upload = async (f: File) => {
    setBusy(true);
    setErr(null);
    const body = new FormData();
    body.append('file', f);
    try {
      const res = await fetch(`/api/dealer/units/${unitId}/photos`, { method: 'POST', body });
      const json = (await res.json().catch(() => null)) as { photos?: PhotoItem[]; error?: string } | null;
      if (!res.ok) { setErr(json?.error ?? 'The photo did not upload. Try again.'); return; }
      setPhotos(json?.photos ?? photos);
      toast('Added the photo');
      onAdded();
    } finally {
      setBusy(false);
      if (file.current) file.current.value = '';
    }
  };
  return (
    <PanelSection title="Photos" meta={photos.length ? <span className="t-cap">{photos.length}</span> : undefined}>
      {photos.length > 0 ? (
        <div className="dl-photos">
          {photos.map((ph) => (ph.url ? <a key={ph.id} href={ph.url} target="_blank" rel="noreferrer" aria-label={`Open ${ph.name}`}>{/* eslint-disable-next-line @next/next/no-img-element */}<img src={ph.url} alt={ph.name} loading="lazy" /></a> : <span key={ph.id} className="t-cap">{ph.name}</span>))}
        </div>
      ) : (
        <p className="t-cap">No photos yet. Lot photos help the desk and the website listing.</p>
      )}
      {!readOnly && (
        <div style={{ marginTop: 8 }}>
          <input ref={file} type="file" accept="image/*" capture="environment" className="sr" id={`ph-${unitId}`} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
          <Button icon="camera" disabled={busy} onClick={() => file.current?.click()}>{busy ? 'Uploading…' : 'Add a photo'}</Button>
          {err && <div style={{ marginTop: 8 }}><Failure text={err} title="Not added." /></div>}
        </div>
      )}
    </PanelSection>
  );
}
