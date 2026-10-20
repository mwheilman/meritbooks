'use client';

/**
 * Add a unit to the register (POST /api/dealer/units, schema `unitCreate`).
 * No accounting entry: an owned unit gets its cost from flooring or cost rows.
 */

import { useEffect, useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { UnitCondition } from '@/lib/dealer/types';
import { UNIT_CONDITION, UNIT_STATUS } from '@/lib/dealer/ui/labels';
import { fieldErrors } from '@/lib/dealer/ui/errors';
import { todayLocal } from '@/lib/dealer/ui/format';
import type { UnitView } from '@/lib/dealer/ui/unit-deal-types';
import { DateInput, Field, Modal, MoneyInput, Select, TextArea, TextInput, Toggle } from '../_components/forms';
import { LookupPicker } from '../_components/lookup-picker';
import { dealerMutate } from '../_lib/use-dealer';

type NewStatus = 'ON_ORDER' | 'IN_TRANSIT' | 'IN_STOCK';

interface Form {
  serialNumber: string;
  stockNumber: string;
  vinHin: string;
  makeVendorId: string | null;
  model: string;
  modelYear: string;
  condition: UnitCondition;
  status: NewStatus;
  receivedDate: string;
  listPriceCents: number | null;
  isConsignment: boolean;
  consignorVendorId: string | null;
  description: string;
  notes: string;
}

const blank = (): Form => ({
  serialNumber: '',
  stockNumber: '',
  vinHin: '',
  makeVendorId: null,
  model: '',
  modelYear: '',
  condition: 'NEW',
  status: 'IN_STOCK',
  receivedDate: todayLocal(),
  listPriceCents: null,
  isConsignment: false,
  consignorVendorId: null,
  description: '',
  notes: '',
});

function validate(f: Form): Record<string, string> {
  const e: Record<string, string> = {};
  if (!f.serialNumber.trim()) e.serialNumber = 'Serial number is required';
  else if (f.serialNumber.trim().length > 100) e.serialNumber = 'Keep it under 100 characters';
  if (f.modelYear.trim() && (!/^\d{4}$/.test(f.modelYear.trim()) || Number(f.modelYear) < 1900 || Number(f.modelYear) > 2200)) e.modelYear = 'Use a 4-digit year';
  if (f.status === 'IN_STOCK' && !f.receivedDate) e.receivedDate = 'When was it received? (drives days in stock)';
  if (f.isConsignment && f.condition === 'RENTAL') e.condition = 'A consignment unit can’t be a rental';
  if (f.isConsignment && !f.consignorVendorId) e.consignorVendorId = 'Choose who owns the unit';
  return e;
}

export function AddUnitModal({ open, onClose, locationId, onCreated }: { open: boolean; onClose: () => void; locationId: string; onCreated: (u: UnitView) => void }) {
  const [f, setF] = useState<Form>(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const ids = { serial: useId(), stock: useId(), vin: useId(), make: useId(), model: useId(), year: useId(), cond: useId(), status: useId(), recv: useId(), list: useId(), cons: useId(), consignor: useId(), desc: useId(), notes: useId() };

  useEffect(() => {
    if (open) {
      setF(blank());
      setErrors({});
    }
  }, [open]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));

  async function submit() {
    const e = validate(f);
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    const res = await dealerMutate<UnitView>(
      'post',
      '/api/dealer/units',
      locationId,
      {
        serialNumber: f.serialNumber.trim(),
        stockNumber: f.stockNumber.trim() || null,
        vinHin: f.vinHin.trim() || null,
        makeVendorId: f.makeVendorId,
        model: f.model.trim() || null,
        modelYear: f.modelYear.trim() ? Number(f.modelYear) : null,
        condition: f.condition,
        status: f.status,
        receivedDate: f.receivedDate || null,
        listPriceCents: f.listPriceCents,
        isConsignment: f.isConsignment,
        consignorVendorId: f.isConsignment ? f.consignorVendorId : null,
        description: f.description.trim() || null,
        notes: f.notes.trim() || null,
        source: 'MANUAL',
      },
      'Unit added to the register',
    );
    setBusy(false);
    if (res.error) {
      setErrors(fieldErrors(res.error));
      return;
    }
    if (res.data) onCreated(res.data);
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title="Add a unit"
      description="Adds the serialized unit to this client’s register. Nothing posts to the books — cost arrives when the unit is floored or a cost is posted."
      width="lg"
      footer={
        <>
          <button type="button" className="btn-secondary btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary btn-sm inline-flex items-center gap-1.5" onClick={() => void submit()} disabled={busy}>
            {busy && <Loader2 size={13} className="animate-spin" />}
            Add unit
          </button>
        </>
      }
    >
      <form
        className="grid grid-cols-1 gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Serial number" htmlFor={ids.serial} required error={errors.serialNumber}>
          <TextInput id={ids.serial} value={f.serialNumber} onChange={(v) => set('serialNumber', v)} invalid={!!errors.serialNumber} className="font-mono" maxLength={100} autoComplete="off" />
        </Field>
        <Field label="Stock number" htmlFor={ids.stock} error={errors.stockNumber}>
          <TextInput id={ids.stock} value={f.stockNumber} onChange={(v) => set('stockNumber', v)} className="font-mono" maxLength={100} />
        </Field>
        <Field label="Make (manufacturer)" htmlFor={ids.make} hint="The manufacturer’s vendor record." error={errors.makeVendorId}>
          <LookupPicker id={ids.make} kind="vendors" value={f.makeVendorId} onChange={(id) => set('makeVendorId', id)} placeholder="Choose a manufacturer…" />
        </Field>
        <Field label="Model" htmlFor={ids.model} error={errors.model}>
          <TextInput id={ids.model} value={f.model} onChange={(v) => set('model', v)} maxLength={200} />
        </Field>
        <Field label="Model year" htmlFor={ids.year} error={errors.modelYear}>
          <TextInput id={ids.year} value={f.modelYear} onChange={(v) => set('modelYear', v)} inputMode="numeric" className="font-mono" invalid={!!errors.modelYear} maxLength={4} />
        </Field>
        <Field label="VIN / HIN" htmlFor={ids.vin} error={errors.vinHin}>
          <TextInput id={ids.vin} value={f.vinHin} onChange={(v) => set('vinHin', v)} className="font-mono" maxLength={100} />
        </Field>
        <Field label="Condition" htmlFor={ids.cond} required error={errors.condition}>
          <Select<UnitCondition>
            id={ids.cond}
            value={f.condition}
            onChange={(v) => set('condition', v)}
            options={(Object.keys(UNIT_CONDITION) as UnitCondition[]).map((c) => ({ value: c, label: UNIT_CONDITION[c].label }))}
            invalid={!!errors.condition}
          />
        </Field>
        <Field label="Where is it?" htmlFor={ids.status} required>
          <Select<NewStatus>
            id={ids.status}
            value={f.status}
            onChange={(v) => set('status', v)}
            options={(['IN_STOCK', 'IN_TRANSIT', 'ON_ORDER'] as NewStatus[]).map((s) => ({ value: s, label: UNIT_STATUS[s].label }))}
          />
        </Field>
        <Field label="Received" htmlFor={ids.recv} hint="Days in stock count from this date." error={errors.receivedDate}>
          <DateInput id={ids.recv} value={f.receivedDate} onChange={(v) => set('receivedDate', v)} invalid={!!errors.receivedDate} />
        </Field>
        <Field label="List price" htmlFor={ids.list} error={errors.listPriceCents}>
          <MoneyInput
            id={ids.list}
            cents={f.listPriceCents}
            onChange={(c) => set('listPriceCents', c)}
            invalid={!!errors.listPriceCents}
          />
        </Field>
        <div className="sm:col-span-2 flex items-center justify-between gap-4 rounded-lg border border-slate-800 bg-surface-950 px-4 py-3">
          <div>
            <p className="text-label text-slate-300" id={`${ids.cons}-label`}>
              Consignment unit
            </p>
            <p className="text-xs text-slate-500">Owned by someone else and sold on their behalf — tracked here, never on this client’s balance sheet.</p>
          </div>
          <Toggle id={ids.cons} checked={f.isConsignment} onChange={(v) => set('isConsignment', v)} label="Consignment unit" />
        </div>
        {f.isConsignment && (
          <Field label="Consignor" htmlFor={ids.consignor} required error={errors.consignorVendorId}>
            <LookupPicker id={ids.consignor} kind="vendors" value={f.consignorVendorId} onChange={(id) => set('consignorVendorId', id)} invalid={!!errors.consignorVendorId} placeholder="Who owns the unit?" />
          </Field>
        )}
        <div className="sm:col-span-2">
          <Field label="Description" htmlFor={ids.desc}>
            <TextArea id={ids.desc} value={f.description} onChange={(v) => set('description', v)} rows={2} maxLength={1000} />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Internal notes" htmlFor={ids.notes}>
            <TextArea id={ids.notes} value={f.notes} onChange={(v) => set('notes', v)} rows={2} maxLength={2000} />
          </Field>
        </div>
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}
