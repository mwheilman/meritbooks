'use client';

import { useState } from 'react';
import { Button, Field, Input, MoneyInput, Panel, PanelSection, Seg, Select, Textarea, money } from '@meritbooks/merit-ui';
import { CONDITION_WORDS, unitTitle } from '@/lib/pm/dealer/labels';
import type { StockLocationRow, UnitCondition, UnitInventoryRow } from '@/lib/pm/dealer/types';
import type { LookupItem } from '@/lib/pm/ops/types';
import { Failure, parseNum } from '@/components/ops/common/bits';
import { Lookup } from '@/components/ops/common/Lookup';
import { useStore } from '../common/useStore';

type Mode = 'receive' | 'order';

export interface ReceivePanelProps {
  companyId: string;
  stockLocations: StockLocationRow[];
  defaultStockLocationId: string | null;
  onOrder: UnitInventoryRow[];
  today: string;
  onClose: () => void;
  onDone: (unitId: string) => void;
}

/**
 * Receive a unit against its manufacturer invoice (serial, model, cost) or put one on order. Stock
 * numbers are minted (N26-0001, U26-…) unless one is typed; the base cost goes to Merit Books as
 * DEALER_UNIT_RECEIVED, with the flooring lender as a hint for Books' flooring proposal.
 */
export function ReceivePanel(p: ReceivePanelProps) {
  const { act, busy, error } = useStore();
  const [mode, setMode] = useState<Mode>('receive');
  const [fromOrder, setFromOrder] = useState('');
  const [serial, setSerial] = useState('');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState('');
  const [vin, setVin] = useState('');
  const [category, setCategory] = useState('');
  const [condition, setCondition] = useState<UnitCondition>('NEW');
  const [cost, setCost] = useState<number | null>(null);
  const [invoice, setInvoice] = useState('');
  const [mfr, setMfr] = useState<LookupItem | null>(null);
  const [sl, setSl] = useState(p.defaultStockLocationId ?? '');
  const [stockNo, setStockNo] = useState('');
  const [receivedOn, setReceivedOn] = useState(p.today);
  const [retail, setRetail] = useState<number | null>(null);
  const [advertised, setAdvertised] = useState<number | null>(null);
  const [meter, setMeter] = useState('');
  const [attachments, setAttachments] = useState('');
  const [lender, setLender] = useState<LookupItem | null>(null);
  const [program, setProgram] = useState('');
  const [err, setErr] = useState<Record<string, string>>({});

  const ordered = p.onOrder.find((u) => u.unit_id === fromOrder) ?? null;

  const submit = async () => {
    const e: Record<string, string> = {};
    const y = year.trim() ? parseNum(year) : null;
    if (year.trim() && (y == null || y < 1900 || y > 2200)) e.year = 'Use a four-digit year.';
    if (mode === 'receive' && !ordered && !serial.trim()) e.serial = 'Key the serial number from the unit.';
    if (!ordered && !model.trim()) e.model = 'Give the model.';
    const m = meter.trim() ? parseNum(meter) : null;
    if (meter.trim() && (m == null || m < 0)) e.meter = 'Hours must be a number.';
    setErr(e);
    if (Object.keys(e).length) return;
    if (mode === 'order') {
      const r = await act<{ unitId: string }>('order', 'post', '/api/dealer/units', {
        op: 'order', companyId: p.companyId, make: make.trim() || null, model: model.trim(), modelYear: y, category: category.trim() || null,
        serialNumber: serial.trim() || null, retailPriceCents: retail, mfrVendorId: mfr?.id ?? null,
      }, `Put ${[make, model].filter(Boolean).join(' ')} on order`);
      if (r.data) p.onDone(r.data.unitId);
      return;
    }
    const r = await act<{ unitId: string; stockNumber: string | null }>('receive', 'post', '/api/dealer/units', {
      op: 'receive', companyId: p.companyId, unitId: ordered?.unit_id ?? null,
      serialNumber: serial.trim().toUpperCase() || null, make: make.trim() || null, model: model.trim() || null, modelYear: y, vin: vin.trim().toUpperCase() || null,
      category: category.trim().toUpperCase().replace(/\s+/g, '_') || null, condition, costCents: cost ?? 0, mfrInvoiceRef: invoice.trim() || null,
      mfrVendorId: mfr?.id ?? null, stockLocationId: sl || null, stockNumber: stockNo.trim() || null, receivedOn: receivedOn || null,
      retailPriceCents: retail, advertisedPriceCents: advertised, meterReading: m,
      attachments: attachments.split(/\n|,/).map((s) => s.trim()).filter(Boolean),
      floorLenderVendorId: lender?.id ?? null, floorProgramRef: program.trim() || null,
    }, (d) => `Received ${d.stockNumber ?? 'the unit'}`);
    if (r.data) p.onDone(r.data.unitId);
  };

  return (
    <Panel
      eyebrow={['Stock', mode === 'receive' ? 'Receive' : 'Order']}
      title={mode === 'receive' ? 'Receive a unit' : 'Put a unit on order'}
      meta={mode === 'receive' ? 'Against the manufacturer invoice' : 'Nothing reaches Merit Books until it is received'}
      onClose={p.onClose}
      foot={
        <div className="btn-row" style={{ width: '100%' }}>
          <Button onClick={p.onClose}>Cancel</Button>
          <span className="sp" />
          <Button variant="primary" chord="mod+enter" bindChord disabled={busy === 'receive' || busy === 'order'} onClick={() => void submit()}>
            {mode === 'receive' ? 'Receive into stock' : 'Put on order'}
          </Button>
        </div>
      }
    >
      <PanelSection>
        <Seg<Mode> aria-label="What arrived" value={mode} onChange={setMode} items={[{ value: 'receive', label: 'It arrived' }, { value: 'order', label: 'On order' }]} />
        {error && <div style={{ marginTop: 12 }}><Failure text={error} title="Not received." /></div>}
      </PanelSection>
      <PanelSection title="The unit">
        <form className="mp-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          {mode === 'receive' && p.onOrder.length > 0 && (
            <Field label="An ordered unit arriving" help="Leave on ‘A new unit’ for one not on order">
              <Select value={fromOrder} onChange={(e) => setFromOrder(e.target.value)}>
                <option value="">A new unit</option>
                {p.onOrder.map((u) => <option key={u.unit_id} value={u.unit_id}>{u.stock_number} · {unitTitle(u)}</option>)}
              </Select>
            </Field>
          )}
          <Field label="Serial number" error={err.serial}><Input autoFocus value={serial} onChange={(e) => setSerial(e.target.value)} placeholder={ordered?.serial_number ?? 'From the serial plate'} maxLength={80} autoCapitalize="characters" /></Field>
          {!ordered && (
            <>
              <div className="mp-form-2">
                <Field label="Make"><Input value={make} onChange={(e) => setMake(e.target.value)} placeholder="Kubota" maxLength={60} /></Field>
                <Field label="Model" error={err.model}><Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="BX2380" maxLength={80} /></Field>
              </div>
              <div className="mp-form-2">
                <Field label="Model year" error={err.year}><Input inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value)} placeholder="2026" maxLength={4} /></Field>
                <Field label="Category"><Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Compact tractor" maxLength={40} /></Field>
              </div>
            </>
          )}
          {mode === 'receive' && (
            <div className="mp-form-2">
              <Field label="Condition">
                <Select value={condition} onChange={(e) => setCondition(e.target.value as UnitCondition)}>
                  {(Object.keys(CONDITION_WORDS) as UnitCondition[]).map((c) => <option key={c} value={c}>{CONDITION_WORDS[c]}</option>)}
                </Select>
              </Field>
              <Field label="VIN or PIN"><Input value={vin} onChange={(e) => setVin(e.target.value)} maxLength={40} /></Field>
            </div>
          )}
        </form>
      </PanelSection>
      {mode === 'receive' && (
        <PanelSection title="Manufacturer invoice">
          <div className="mp-form">
            <div className="mp-form-2">
              <Field label="Invoice cost" help="The base cost Merit Books books"><MoneyInput valueCents={cost} onChangeCents={setCost} placeholder="0.00" /></Field>
              <Field label="Invoice number"><Input value={invoice} onChange={(e) => setInvoice(e.target.value)} maxLength={60} /></Field>
            </div>
            <Field label="Manufacturer (vendor)"><Lookup kind="vendors" value={mfr ? { id: mfr.id, label: mfr.label } : null} onChange={setMfr} placeholder="Search vendors" /></Field>
            <div className="mp-form-2">
              <Field label="Floor-plan lender" help="A hint for Books’ flooring proposal"><Lookup kind="vendors" value={lender ? { id: lender.id, label: lender.label } : null} onChange={setLender} placeholder="Not floored" /></Field>
              <Field label="Program"><Input value={program} onChange={(e) => setProgram(e.target.value)} placeholder="Free floor 180" maxLength={60} /></Field>
            </div>
          </div>
        </PanelSection>
      )}
      <PanelSection title={mode === 'receive' ? 'On the lot' : 'Price'}>
        <div className="mp-form">
          {mode === 'receive' && (
            <div className="mp-form-2">
              <Field label="Stock location">
                <Select value={sl} onChange={(e) => setSl(e.target.value)}>
                  <option value="">Not set</option>
                  {p.stockLocations.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}
                </Select>
              </Field>
              <Field label="Received on"><Input type="date" value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} max={p.today} /></Field>
            </div>
          )}
          <div className="mp-form-2">
            <Field label="Retail price"><MoneyInput valueCents={retail} onChangeCents={setRetail} placeholder="0.00" /></Field>
            {mode === 'receive' ? <Field label="Advertised price"><MoneyInput valueCents={advertised} onChangeCents={setAdvertised} placeholder={retail != null ? money(retail) : '0.00'} /></Field> : <span />}
          </div>
          {mode === 'receive' && (
            <>
              <div className="mp-form-2">
                <Field label="Stock number" help="Blank gets the next one"><Input value={stockNo} onChange={(e) => setStockNo(e.target.value)} maxLength={24} autoCapitalize="characters" /></Field>
                <Field label="Hour meter" error={err.meter}><Input inputMode="decimal" value={meter} onChange={(e) => setMeter(e.target.value)} placeholder="0" /></Field>
              </div>
              <Field label="Attachments on the unit" help="One per line or comma-separated"><Textarea value={attachments} onChange={(e) => setAttachments(e.target.value)} placeholder="LA340 loader, 60-inch mid-mount deck" maxLength={2000} /></Field>
            </>
          )}
        </div>
      </PanelSection>
    </Panel>
  );
}
