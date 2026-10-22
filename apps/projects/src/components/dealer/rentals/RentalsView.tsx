'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Button, Check, ConfirmDialog, Field, Figure, Input, KV, MoneyInput, Panel, PanelSection, Seg, Select, Textarea, WidgetState, api, count, money, pct,
  shortDate, useDebounce,
} from '@meritbooks/merit-ui';
import { RENTAL_STATUS } from '@/lib/pm/dealer/labels';
import { chargeWords, parseRange, pickRentalRate, utilization } from '@/lib/pm/dealer/math';
import type { FleetUnit, RentalBoard } from '@/lib/pm/dealer/store-queries';
import type { RentalCharge, RentalContractRow, RentalRateRow } from '@/lib/pm/dealer/types';
import { useShell } from '@/components/shell/ShellContext';
import { CustomerPicker, type CustomerValue } from '@/components/jobs/CustomerPicker';
import { Failure, PctInput, StatusMark, parseNum } from '@/components/ops/common/bits';
import { PickStoreNote } from '../common/StoreOff';
import { useStore } from '../common/useStore';

type View = 'board' | 'contracts' | 'rates';
const DAY = 86_400_000;
const WINDOW = 14;

export interface RentalsViewProps {
  data: RentalBoard;
  companyId: string | null;
  today: string;
  focusContractId: string | null;
  initialView: View;
}

interface Preview { charge: RentalCharge | null; rate: { day: number | null; week: number | null; month: number | null; waiverPct: number | null; label: string | null } | null; waiverCents: number; feesCents: number; noRate?: boolean }

function dayIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function localInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocal(v: string): string | null {
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function when(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${shortDate(dayIso(d.getTime()))} ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

/** The rental fleet: a reservation calendar, check-out and check-in with meter and condition, cycle and final billing. */
export function RentalsView(p: RentalsViewProps) {
  const { readOnly } = useShell();
  const [view, setView] = useState<View>(p.initialView);
  const [cursor, setCursor] = useState<string | null>(p.focusContractId);
  const [reserving, setReserving] = useState<{ unitId: string; start: number } | null>(null);
  const [offset, setOffset] = useState(0);
  const d = p.data;
  const units = useMemo(() => new Map(d.fleet.map((u) => [u.unit_id, u])), [d.fleet]);
  const cur = d.contracts.find((c) => c.id === cursor) ?? null;
  const out = d.contracts.filter((c) => c.status === 'OUT');
  const util = utilization(d.fleet.reduce((s, u) => s + u.on_rent_days, 0), d.fleet.reduce((s, u) => s + u.available_days, 0));
  const now = Date.now();
  const late = out.filter((c) => (parseRange(c.reserved)?.end ?? Infinity) < now);
  const panel = !!cur || !!reserving;

  return (
    <div className="stack">
      <div className="dl-strip">
        <Figure dense label="Fleet" value={count(d.fleet.length)} vs={[`${count(out.length)} out now`, `${count(d.contracts.filter((c) => c.status === 'RESERVED').length)} reserved`]} href="/rentals" linkLabel="Calendar" />
        <Figure dense label="Time utilization, 90 days" value={util == null ? '—' : pct(util)} vs={['days on rent ÷ days in the fleet', `${count(d.fleet.filter((u) => (utilization(u.on_rent_days, u.available_days) ?? 0) < 0.3).length)} units under 30%`]} href="/rentals?view=board" linkLabel="By unit" />
        <Figure dense label="Billed, 90 days" value={money(d.fleet.reduce((s, u) => s + u.billed_90d_cents, 0), { decimals: 0 })} vs={[late.length ? `${count(late.length)} late back` : 'none late', `${count(d.contracts.filter((c) => c.status === 'RETURNED').length)} back, to bill`]} href="/rentals?view=contracts" linkLabel="Contracts" />
      </div>
      <div className="ops-toolbar">
        <Seg<View> aria-label="Show" value={view} onChange={setView} items={[{ value: 'board', label: 'Calendar' }, { value: 'contracts', label: 'Contracts', count: d.contracts.filter((c) => ['RESERVED', 'OUT', 'RETURNED'].includes(c.status)).length }, { value: 'rates', label: 'Rates', count: d.rates.filter((r) => r.is_active).length }]} />
        {view === 'board' && (
          <div className="btn-row">
            <Button variant="quiet" iconOnly icon="left" aria-label="A week earlier" onClick={() => setOffset(offset - 7)} />
            <Button variant="quiet" onClick={() => setOffset(0)}>Today</Button>
            <Button variant="quiet" iconOnly icon="right" aria-label="A week later" onClick={() => setOffset(offset + 7)} />
          </div>
        )}
        <span className="sp" />
        {!readOnly && p.companyId && view !== 'rates' && d.fleet.length > 0 && <Button variant="primary" icon="plus" chord="n" bindChord={!panel} onClick={() => { setReserving({ unitId: d.fleet[0]!.unit_id, start: now }); setCursor(null); }}>Reserve</Button>}
      </div>
      {!readOnly && !p.companyId && <PickStoreNote what="Rentals" />}

      {view === 'rates' ? (
        <RatesView rates={d.rates} fleet={d.fleet} companyId={p.companyId} />
      ) : (
        <div className={panel ? 'ops-split has-panel' : 'ops-split'}>
          <div style={{ minWidth: 0 }}>
            {d.fleet.length === 0 ? (
              <WidgetState state={{ kind: 'empty', title: 'No units in the rental fleet', body: 'Move a unit to the rental fleet from Stock (Change status), add a day, week or month rate, then reserve it here.' }} />
            ) : view === 'board' ? (
              <Calendar fleet={d.fleet} contracts={d.contracts} customers={d.customers} today={p.today} offset={offset} cursor={cursor}
                onOpen={(id) => { setCursor(id); setReserving(null); }} onPick={(unitId, start) => { if (!readOnly && p.companyId) { setReserving({ unitId, start }); setCursor(null); } }} />
            ) : (
              <ContractsTable contracts={d.contracts} units={units} customers={d.customers} cursor={cursor} onOpen={(id) => { setCursor(id); setReserving(null); }} />
            )}
          </div>
          {reserving && p.companyId ? (
            <ReservePanel key={`${reserving.unitId}:${reserving.start}`} fleet={d.fleet} rates={d.rates} unitId={reserving.unitId} start={reserving.start} companyId={p.companyId} onClose={() => setReserving(null)} onDone={(id) => { setReserving(null); setCursor(id); }} />
          ) : cur ? (
            <ContractPanel key={cur.id} c={cur} unit={units.get(cur.asset_id) ?? null} customer={d.customers[cur.customer_id] ?? null} billings={d.billings.filter((b) => b.contract_id === cur.id)} onClose={() => setCursor(null)} />
          ) : null}
        </div>
      )}
    </div>
  );
}

function Calendar({ fleet, contracts, customers, today, offset, cursor, onOpen, onPick }: { fleet: FleetUnit[]; contracts: RentalContractRow[]; customers: Record<string, string>; today: string; offset: number; cursor: string | null; onOpen: (id: string) => void; onPick: (unitId: string, start: number) => void }) {
  const start = Date.parse(`${today}T00:00:00`) + (offset - 2) * DAY;
  const end = start + WINDOW * DAY;
  const days = Array.from({ length: WINDOW }, (_, i) => start + i * DAY);
  const now = Date.now();
  return (
    <div className="dl-cal" style={{ ['--days' as string]: WINDOW }} role="grid" aria-label="Reservation calendar">
      <div className="dl-cal-head" role="row">
        <span className="dl-cal-who t-cap" role="columnheader">Unit</span>
        <div className="dl-cal-days">{days.map((t) => <span key={t} role="columnheader" className={dayIso(t + 12 * 3600_000) === today ? 'today' : undefined}>{new Date(t).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' })}</span>)}</div>
      </div>
      {fleet.map((u) => {
        const mine = contracts.filter((c) => c.asset_id === u.unit_id && ['RESERVED', 'OUT', 'RETURNED', 'CLOSED'].includes(c.status));
        const ut = utilization(u.on_rent_days, u.available_days);
        return (
          <div className="dl-cal-row" role="row" key={u.unit_id}>
            <div className="dl-cal-who" role="rowheader">
              <span className="l1">{u.stock_number ?? u.serial_number} · {[u.make, u.model].filter(Boolean).join(' ')}</span>
              <span className="l2">{ut == null ? 'New to the fleet' : `${pct(ut)} on rent, 90 days`}{u.meter_reading != null ? ` · ${u.meter_reading} h` : ''}</span>
              <div className="dl-bar" aria-hidden="true"><i style={{ width: `${Math.round((ut ?? 0) * 100)}%` }} /></div>
            </div>
            <div className="dl-cal-track">
              <div className="dl-cal-grid">
                {days.map((t) => (
                  <i key={t} className={dayIso(t + 12 * 3600_000) === today ? 'today' : undefined} onClick={() => onPick(u.unit_id, Math.max(t + 8 * 3600_000, now))} aria-hidden="true" />
                ))}
              </div>
              {mine.map((c) => {
                const r = parseRange(c.reserved);
                if (!r || r.end <= start || r.start >= end) return null;
                const left = ((Math.max(r.start, start) - start) / (end - start)) * 100;
                const width = ((Math.min(r.end, end) - Math.max(r.start, start)) / (end - start)) * 100;
                const lateBack = c.status === 'OUT' && r.end < now;
                const cls = ['dl-cal-blk', c.status === 'OUT' ? (lateBack ? 'late' : 'out') : c.status === 'RETURNED' ? 'back' : ''].filter(Boolean).join(' ');
                return (
                  <button key={c.id} type="button" className={cls} style={{ left: `${left}%`, width: `max(${width}%, 8px)` }} aria-current={cursor === c.id || undefined}
                    aria-label={`${c.number}, ${customers[c.customer_id] ?? 'customer'}, ${RENTAL_STATUS[c.status].word}`} onClick={() => onOpen(c.id)}>
                    {c.number} · {customers[c.customer_id] ?? 'Customer'}{lateBack ? ' · late' : ''}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ContractsTable({ contracts, units, customers, cursor, onOpen }: { contracts: RentalContractRow[]; units: Map<string, FleetUnit>; customers: Record<string, string>; cursor: string | null; onOpen: (id: string) => void }) {
  const rows = [...contracts].sort((a, b) => ['RETURNED', 'OUT', 'RESERVED', 'CLOSED', 'CANCELLED'].indexOf(a.status) - ['RETURNED', 'OUT', 'RESERVED', 'CLOSED', 'CANCELLED'].indexOf(b.status));
  if (!rows.length) return <WidgetState state={{ kind: 'empty', title: 'No rentals yet', body: 'Reserve a fleet unit for a customer: the rate that covers the unit is pinned on the contract.' }} />;
  return (
    <div className="mp-table">
      <table className="dl-tbl">
        <thead><tr><th>Contract</th><th>Unit</th><th>Customer</th><th>Window</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map((c) => {
            const r = parseRange(c.reserved);
            const u = units.get(c.asset_id);
            return (
              <tr key={c.id} style={cursor === c.id ? { background: 'var(--sky)' } : undefined}>
                <td><button type="button" className="nlink b" style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', font: 'inherit' }} onClick={() => onOpen(c.id)}>{c.number}</button></td>
                <td>{u ? `${u.stock_number ?? ''} ${[u.make, u.model].filter(Boolean).join(' ')}` : 'Unit'}</td>
                <td>{customers[c.customer_id] ?? 'Customer'}</td>
                <td className="tnum">{r ? `${when(new Date(r.start).toISOString())} – ${when(new Date(r.end).toISOString())}` : '—'}</td>
                <td><StatusMark mark={RENTAL_STATUS[c.status]} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function usePreview(params: Record<string, string | null | undefined> | null) {
  const key = JSON.stringify(params);
  const debounced = useDebounce(key, 250);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const q = JSON.parse(debounced) as Record<string, string | null | undefined> | null;
    if (!q) { setPreview(null); return; }
    void api.get<Preview>('/api/dealer/rentals', q).then((r) => {
      if (!live) return;
      if (r.error) { setErr(r.error.error); setPreview(null); } else { setErr(null); setPreview(r.data); }
    });
    return () => { live = false; };
  }, [debounced]);
  return { preview, err };
}

function ChargeLines({ preview, feesLabel }: { preview: Preview | null; feesLabel?: string }) {
  if (!preview?.charge) return null;
  const c = preview.charge;
  const total = Number(c.rental_cents) + preview.waiverCents + preview.feesCents;
  return (
    <ul className="dl-totals">
      <li><span>{c.days} day{c.days === 1 ? '' : 's'}: {chargeWords(c)}</span><span className="v">{money(Number(c.rental_cents))}</span></li>
      {preview.waiverCents > 0 && <li><span>Damage waiver</span><span className="v">{money(preview.waiverCents)}</span></li>}
      {preview.feesCents > 0 && <li><span>{feesLabel ?? 'Fees'}</span><span className="v">{money(preview.feesCents)}</span></li>}
      <li className="rule strong"><span>Estimate</span><span className="v">{money(total)}</span></li>
      <li className="muted"><span className="t-cap">At {[c.rate_day_cents ? `${money(c.rate_day_cents)} a day` : null, c.rate_week_cents ? `${money(c.rate_week_cents)} a week` : null, c.rate_month_cents ? `${money(c.rate_month_cents)} a 4-week month` : null].filter(Boolean).join(', ')}. Merit Books invoices it.</span><span /></li>
    </ul>
  );
}

function ReservePanel({ fleet, rates, unitId: u0, start: s0, companyId, onClose, onDone }: { fleet: FleetUnit[]; rates: RentalRateRow[]; unitId: string; start: number; companyId: string; onClose: () => void; onDone: (id: string) => void }) {
  const { act, busy, error } = useStore();
  const [unitId, setUnitId] = useState(u0);
  const [customer, setCustomer] = useState<CustomerValue>({ id: null, name: '' });
  const [start, setStart] = useState(localInput(s0));
  const [end, setEnd] = useState(localInput(s0 + DAY));
  const [waiver, setWaiver] = useState(false);
  const [delivery, setDelivery] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const unit = fleet.find((f) => f.unit_id === unitId) ?? null;
  const rate = unit ? pickRentalRate(rates, { id: unit.unit_id, location_id: unit.location_id, model: unit.model, category: unit.category }) : null;
  const sIso = fromLocal(start);
  const eIso = fromLocal(end);
  const { preview, err } = usePreview(unitId && sIso && eIso ? { unitId, start: sIso, end: eIso } : null);
  const shown: Preview | null = preview ? { ...preview, waiverCents: waiver ? preview.waiverCents : 0, feesCents: delivery ?? 0 } : null;
  const submit = async () => {
    if (!customer.id || !sIso || !eIso) return;
    const r = await act<{ contractId: string }>('reserve', 'post', '/api/dealer/rentals', { unitId, customerId: customer.id, start: sIso, end: eIso, damageWaiver: waiver, deliveryCents: delivery ?? 0, notes: notes.trim() || null }, `Reserved ${unit?.stock_number ?? 'the unit'} for ${customer.name}`);
    if (r.data) onDone(r.data.contractId);
  };
  return (
    <Panel eyebrow={['Rentals', 'Reserve']} title="Reserve a unit" meta={rate ? `Rate: ${rate.label ?? (rate.asset_id ? 'this unit' : rate.model ? `model ${rate.model}` : rate.category ? `category ${rate.category}` : 'company default')}` : 'No rate covers this unit yet'} onClose={onClose}
      foot={<div className="btn-row" style={{ width: '100%' }}><Button onClick={onClose}>Cancel</Button><span className="sp" /><Button variant="primary" chord="mod+enter" bindChord disabled={busy === 'reserve' || !customer.id || !sIso || !eIso || !rate} onClick={() => void submit()}>Reserve</Button></div>}>
      <PanelSection>
        <form className="mp-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <Field label="Unit"><Select value={unitId} onChange={(e) => setUnitId(e.target.value)}>{fleet.map((f) => <option key={f.unit_id} value={f.unit_id}>{f.stock_number ?? f.serial_number} · {[f.make, f.model].filter(Boolean).join(' ')}</option>)}</Select></Field>
          <Field label="Customer"><CustomerPicker value={customer} onChange={setCustomer} companyId={companyId} /></Field>
          <div className="mp-form-2">
            <Field label="Out"><Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
            <Field label="Back"><Input type="datetime-local" value={end} min={start} onChange={(e) => setEnd(e.target.value)} /></Field>
          </div>
          <div className="mp-form-2">
            <Field label="Delivery fee"><MoneyInput valueCents={delivery} onChangeCents={setDelivery} placeholder="0.00" /></Field>
            <Field label="Damage waiver"><Check label={rate?.damage_waiver_pct ? `Add at ${pct(Number(rate.damage_waiver_pct))}` : 'No waiver rate set'} checked={waiver} disabled={!rate?.damage_waiver_pct} onChange={(e) => setWaiver(e.target.checked)} /></Field>
          </div>
          <Field label="Notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} /></Field>
          {!rate && <p className="dl-note">No active rate covers this unit. Add one on the Rates view (by unit, model or category).</p>}
          {err && <Failure text={err} title="No preview." />}
          {error && <Failure text={error} title="Not reserved." />}
        </form>
      </PanelSection>
      {shown?.charge && <PanelSection title="Rate preview"><ChargeLines preview={shown} feesLabel="Delivery" /></PanelSection>}
    </Panel>
  );
}

function ContractPanel({ c, unit, customer, billings, onClose }: { c: RentalContractRow; unit: FleetUnit | null; customer: string | null; billings: RentalBoard['billings']; onClose: () => void }) {
  const { readOnly } = useShell();
  const { act, busy, error } = useStore();
  const url = `/api/dealer/rentals/${c.id}`;
  const r = parseRange(c.reserved);
  const [meterOut, setMeterOut] = useState(unit?.meter_reading != null ? String(unit.meter_reading) : '');
  const [condOut, setCondOut] = useState('');
  const [meterIn, setMeterIn] = useState('');
  const [condIn, setCondIn] = useState('');
  const [damage, setDamage] = useState<number | null>(null);
  const [damageNotes, setDamageNotes] = useState('');
  const [fuel, setFuel] = useState<number | null>(null);
  const [cleaning, setCleaning] = useState<number | null>(null);
  const [through, setThrough] = useState(localInput(Date.now()));
  const [cancelOpen, setCancelOpen] = useState(false);
  const throughIso = fromLocal(through);
  const { preview } = usePreview(c.status === 'OUT' || c.status === 'RETURNED' ? { contractId: c.id, through: c.status === 'OUT' ? throughIso : null } : null);
  const live = !readOnly;
  return (
    <Panel eyebrow={['Rental', c.number]} title={unit ? `${unit.stock_number ?? ''} ${[unit.make, unit.model].filter(Boolean).join(' ')}`.trim() : 'Unit'} meta={customer ?? 'Customer'} onClose={onClose}>
      <PanelSection>
        <StatusMark mark={RENTAL_STATUS[c.status]} />
        <div style={{ marginTop: 12 }}>
          <KV items={[
            { term: 'Reserved', value: r ? `${when(new Date(r.start).toISOString())} to ${when(new Date(r.end).toISOString())}` : '—' },
            { term: 'Rates', value: [c.rate_day_cents ? `${money(c.rate_day_cents)}/day` : null, c.rate_week_cents ? `${money(c.rate_week_cents)}/week` : null, c.rate_month_cents ? `${money(c.rate_month_cents)}/4 weeks` : null].filter(Boolean).join(' · ') || '—' },
            ...(c.damage_waiver ? [{ term: 'Damage waiver', value: c.damage_waiver_pct ? pct(c.damage_waiver_pct) : 'Yes' }] : []),
            ...(c.delivery_cents ? [{ term: 'Delivery', value: money(c.delivery_cents) }] : []),
            ...(c.checked_out_at ? [{ term: 'Out', value: `${when(c.checked_out_at)} at ${c.meter_out ?? '—'} h` }] : []),
            ...(c.checked_in_at ? [{ term: 'Back', value: `${when(c.checked_in_at)} at ${c.meter_in ?? '—'} h${c.meter_in != null && c.meter_out != null ? ` (${Math.round((c.meter_in - c.meter_out) * 10) / 10} used)` : ''}` }] : []),
            ...(c.billed_through ? [{ term: 'Billed through', value: when(c.billed_through) }] : []),
          ]} />
        </div>
        {c.condition_out && <p className="t-cap" style={{ marginTop: 8 }}>Out: {c.condition_out}</p>}
        {c.condition_in && <p className="t-cap">Back: {c.condition_in}</p>}
        {c.damage_notes && <p className="t-cap">Damage: {c.damage_notes}</p>}
        {error && <div style={{ marginTop: 8 }}><Failure text={error} /></div>}
      </PanelSection>

      {c.status === 'RESERVED' && live && (
        <PanelSection title="Check out">
          <form className="mp-form" onSubmit={(e) => { e.preventDefault(); const m = parseNum(meterOut); if (m == null || m < 0) return; void act('out', 'post', url, { op: 'check_out', meterOut: m, conditionOut: condOut.trim() || null }, `${c.number} is out`); }}>
            <Field label="Hour meter out" help={unit?.meter_reading != null ? `Last reading ${unit.meter_reading}` : undefined}><Input inputMode="decimal" value={meterOut} onChange={(e) => setMeterOut(e.target.value)} autoFocus /></Field>
            <Field label="Condition going out"><Textarea value={condOut} onChange={(e) => setCondOut(e.target.value)} maxLength={1000} placeholder="Clean, full tank, bucket teeth good" /></Field>
            <div className="btn-row"><Button type="submit" variant="primary" disabled={busy === 'out' || parseNum(meterOut) == null}>Check out</Button><Button variant="quiet" onClick={() => setCancelOpen(true)}>Cancel the reservation</Button></div>
          </form>
        </PanelSection>
      )}

      {c.status === 'OUT' && live && (
        <>
          <PanelSection title="Bill this cycle">
            <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
              <Field label="Through"><Input type="datetime-local" value={through} onChange={(e) => setThrough(e.target.value)} /></Field>
              <Button disabled={busy === 'bill' || !throughIso} onClick={() => void act('bill', 'post', url, { op: 'bill', through: throughIso }, 'Billed the cycle; sent to Merit Books')}>Bill now</Button>
            </div>
            <ChargeLines preview={preview} feesLabel="Delivery" />
          </PanelSection>
          <PanelSection title="Check in">
            <form className="mp-form" onSubmit={(e) => {
              e.preventDefault();
              const m = parseNum(meterIn);
              if (m == null || (c.meter_out != null && m < c.meter_out)) return;
              void act('in', 'post', url, { op: 'check_in', meterIn: m, conditionIn: condIn.trim() || null, damageCents: damage ?? 0, damageNotes: damageNotes.trim() || null, fuelCents: fuel ?? 0, cleaningCents: cleaning ?? 0 }, `${c.number} is back`);
            }}>
              <Field label="Hour meter in" error={meterIn && c.meter_out != null && (parseNum(meterIn) ?? 0) < c.meter_out ? `At least ${c.meter_out}` : undefined}><Input inputMode="decimal" value={meterIn} onChange={(e) => setMeterIn(e.target.value)} /></Field>
              <Field label="Condition coming back"><Textarea value={condIn} onChange={(e) => setCondIn(e.target.value)} maxLength={1000} /></Field>
              <div className="mp-form-2">
                <Field label="Fuel"><MoneyInput valueCents={fuel} onChangeCents={setFuel} placeholder="0.00" /></Field>
                <Field label="Cleaning"><MoneyInput valueCents={cleaning} onChangeCents={setCleaning} placeholder="0.00" /></Field>
              </div>
              <div className="mp-form-2">
                <Field label="Damage"><MoneyInput valueCents={damage} onChangeCents={setDamage} placeholder="0.00" /></Field>
                <Field label="Damage notes"><Input value={damageNotes} onChange={(e) => setDamageNotes(e.target.value)} maxLength={1000} /></Field>
              </div>
              <div><Button type="submit" variant="primary" disabled={busy === 'in' || parseNum(meterIn) == null}>Check in</Button></div>
            </form>
          </PanelSection>
        </>
      )}

      {c.status === 'RETURNED' && live && (
        <PanelSection title="Final bill">
          <ChargeLines preview={preview} feesLabel="Fuel, cleaning, damage and delivery" />
          <div style={{ marginTop: 8 }}><Button variant="primary" disabled={busy === 'bill'} onClick={() => void act('bill', 'post', url, { op: 'bill', through: null }, 'Final bill sent to Merit Books; the contract is closed')}>Send the final bill</Button></div>
        </PanelSection>
      )}

      <PanelSection title="Bills" meta={billings.length ? <span className="tnum b">{money(billings.reduce((s, b) => s + b.total_cents, 0))}</span> : undefined}>
        {billings.length === 0 ? <p className="t-cap">Nothing billed yet. Cycle bills go out while it is on rent; the final bill closes the contract.</p> : (
          <table className="dl-tbl">
            <thead><tr><th>Period</th><th className="n">Rent</th><th className="n">Waiver</th><th className="n">Fees</th><th className="n">Total</th></tr></thead>
            <tbody>{billings.map((b) => <tr key={b.id}><td><span className="l1">{shortDate(b.period_start.slice(0, 10))} – {shortDate(b.period_end.slice(0, 10))}</span><span className="l2">{chargeWords(b.breakdown)}{b.is_final ? ' · final' : ''}</span></td><td className="n">{money(b.rental_cents)}</td><td className="n">{money(b.damage_waiver_cents)}</td><td className="n">{money(b.fees_cents)}</td><td className="n b">{money(b.total_cents)}</td></tr>)}</tbody>
          </table>
        )}
      </PanelSection>

      <ConfirmDialog open={cancelOpen} onClose={() => setCancelOpen(false)} tone="danger" title={`Cancel ${c.number}`} confirmLabel="Cancel the reservation" cancelLabel="Keep it"
        reason={{ label: 'Why', placeholder: 'Customer rescheduled', minLength: 0 }}
        onConfirm={async (reason) => { const res = await act('cancel', 'post', url, { op: 'cancel', reason: reason || null }, `Cancelled ${c.number}`); if (res.error) throw new Error(res.error.error); }}>
        The unit is free again for those dates.
      </ConfirmDialog>
    </Panel>
  );
}

function RatesView({ rates, fleet, companyId }: { rates: RentalRateRow[]; fleet: FleetUnit[]; companyId: string | null }) {
  const { readOnly } = useShell();
  const { act, busy, error } = useStore();
  const [scope, setScope] = useState<'default' | 'unit' | 'model' | 'category'>('category');
  const [assetId, setAssetId] = useState(fleet[0]?.unit_id ?? '');
  const [model, setModel] = useState('');
  const [category, setCategory] = useState('');
  const [label, setLabel] = useState('');
  const [day, setDay] = useState<number | null>(null);
  const [week, setWeek] = useState<number | null>(null);
  const [month, setMonth] = useState<number | null>(null);
  const [waiver, setWaiver] = useState<number | null>(null);
  const live = !readOnly && !!companyId;
  const scopeWord = (r: RentalRateRow) => (r.asset_id ? `Unit ${fleet.find((f) => f.unit_id === r.asset_id)?.stock_number ?? ''}` : r.model ? `Model ${r.model}` : r.category ? `Category ${r.category.replace(/_/g, ' ').toLowerCase()}` : 'Company default');
  return (
    <div className="stack">
      <p className="t-cap">The most specific active rate covers a unit: the unit itself, then its model, then its category, then the company default. Missing tiers derive (a week is 7 days, a month is 4 weeks); each tier is capped by the next, and returns get a 59-minute grace.</p>
      {error && <Failure text={error} />}
      <div className="mp-table">
        {rates.length === 0 ? <WidgetState state={{ kind: 'empty', title: 'No rental rates yet', body: 'Add a rate for a category (compact excavators), a model, a single unit, or a company default.' }} /> : (
          <table className="dl-tbl">
            <thead><tr><th>Covers</th><th className="n">Day</th><th className="n">Week</th><th className="n">4 weeks</th><th className="n">Waiver</th><th>Active</th></tr></thead>
            <tbody>
              {rates.map((r) => (
                <tr key={r.id} className={r.is_active ? undefined : 'void'}>
                  <td><span className="l1">{r.label ?? scopeWord(r)}</span><span className="l2">{scopeWord(r)}</span></td>
                  <td className="n">{r.day_cents ? money(r.day_cents) : '—'}</td>
                  <td className="n">{r.week_cents ? money(r.week_cents) : '—'}</td>
                  <td className="n">{r.month_cents ? money(r.month_cents) : '—'}</td>
                  <td className="n">{r.damage_waiver_pct != null ? pct(r.damage_waiver_pct) : '—'}</td>
                  <td>{live ? <Check label={r.is_active ? 'Active' : 'Retired'} checked={r.is_active} disabled={busy === `r:${r.id}`} onChange={(e) => void act(`r:${r.id}`, 'post', `/api/dealer/rental-rates/${r.id}`, { isActive: e.target.checked }, e.target.checked ? 'Rate is active' : 'Retired the rate')} /> : r.is_active ? 'Active' : 'Retired'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {live && (
        <form className="dl-card" onSubmit={(e) => {
          e.preventDefault();
          void act('rate', 'post', '/api/dealer/rental-rates', {
            companyId, assetId: scope === 'unit' ? assetId || null : null, model: scope === 'model' ? model.trim() || null : null, category: scope === 'category' ? category.trim().toUpperCase().replace(/\s+/g, '_') || null : null,
            label: label.trim() || null, dayCents: day, weekCents: week, monthCents: month, damageWaiverPct: waiver,
          }, 'Added the rate').then((r) => { if (r.data) { setDay(null); setWeek(null); setMonth(null); setLabel(''); } });
        }}>
          <div className="dl-card-h"><h2 className="t-section">Add a rate</h2></div>
          <div className="dl-card-b mp-form">
            <Seg aria-label="Covers" value={scope} onChange={setScope} items={[{ value: 'category', label: 'A category' }, { value: 'model', label: 'A model' }, { value: 'unit', label: 'One unit' }, { value: 'default', label: 'Company default' }]} />
            <div className="mp-form-2">
              {scope === 'unit' && <Field label="Unit"><Select value={assetId} onChange={(e) => setAssetId(e.target.value)}>{fleet.map((f) => <option key={f.unit_id} value={f.unit_id}>{f.stock_number ?? f.serial_number} · {[f.make, f.model].filter(Boolean).join(' ')}</option>)}</Select></Field>}
              {scope === 'model' && <Field label="Model"><Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="KX040-4" maxLength={80} /></Field>}
              {scope === 'category' && <Field label="Category"><Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Compact excavator" maxLength={40} /></Field>}
              {scope === 'default' && <span />}
              <Field label="Label"><Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder="Mini excavator rate" /></Field>
            </div>
            <div className="mp-form-2">
              <Field label="Per day"><MoneyInput valueCents={day} onChangeCents={setDay} placeholder="0.00" /></Field>
              <Field label="Per week"><MoneyInput valueCents={week} onChangeCents={setWeek} placeholder={day ? money(day * 7) : '0.00'} /></Field>
            </div>
            <div className="mp-form-2">
              <Field label="Per 4 weeks"><MoneyInput valueCents={month} onChangeCents={setMonth} placeholder={week ? money(week * 4) : day ? money(day * 28) : '0.00'} /></Field>
              <Field label="Damage waiver"><PctInput value={waiver} onChange={setWaiver} placeholder="12" aria-label="Damage waiver percent" /></Field>
            </div>
            <div><Button type="submit" variant="primary" disabled={busy === 'rate' || !(day || week || month)}>Add the rate</Button></div>
          </div>
        </form>
      )}
    </div>
  );
}
