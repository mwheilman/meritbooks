'use client';

/**
 * Edit a unit's descriptive fields (PATCH /api/dealer/units, schema `unitUpdate`).
 * Serial and make lock once cost is posted (the D1 service refuses the change).
 * Only fields that changed are sent.
 */

import { useEffect, useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { fieldErrors } from '@/lib/dealer/ui/errors';
import type { UnitView } from '@/lib/dealer/ui/unit-deal-types';
import { DateInput, Field, Modal, MoneyInput, TextArea, TextInput } from '../../_components/forms';
import { LookupPicker } from '../../_components/lookup-picker';
import { dealerMutate } from '../../_lib/use-dealer';

interface Form {
  serialNumber: string;
  makeVendorId: string | null;
  stockNumber: string;
  vinHin: string;
  model: string;
  modelYear: string;
  receivedDate: string;
  listPriceCents: number | null;
  description: string;
  notes: string;
}

const fromUnit = (u: UnitView): Form => ({
  serialNumber: u.serial_number,
  makeVendorId: u.make_vendor_id,
  stockNumber: u.stock_number ?? '',
  vinHin: u.vin_hin ?? '',
  model: u.model ?? '',
  modelYear: u.model_year ? String(u.model_year) : '',
  receivedDate: u.received_date ?? '',
  listPriceCents: u.list_price_cents,
  description: u.description ?? '',
  notes: u.notes ?? '',
});

const orNull = (s: string) => (s.trim() ? s.trim() : null);

export function EditUnitModal({ open, onClose, locationId, unit, onSaved }: { open: boolean; onClose: () => void; locationId: string; unit: UnitView; onSaved: () => void }) {
  const id = useId();
  const [f, setF] = useState<Form>(() => fromUnit(unit));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const locked = unit.cost_cents !== 0;

  useEffect(() => {
    if (open) {
      setF(fromUnit(unit));
      setErrors({});
    }
  }, [open, unit]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));

  async function submit() {
    const e: Record<string, string> = {};
    if (!f.serialNumber.trim()) e.serialNumber = 'Serial number is required';
    if (f.modelYear.trim() && !/^\d{4}$/.test(f.modelYear.trim())) e.modelYear = 'Use a 4-digit year';
    setErrors(e);
    if (Object.keys(e).length) return;

    const o = fromUnit(unit);
    const patch: Record<string, unknown> = { id: unit.id };
    if (!locked && f.serialNumber.trim() !== o.serialNumber) patch.serialNumber = f.serialNumber.trim();
    if (!locked && f.makeVendorId !== o.makeVendorId) patch.makeVendorId = f.makeVendorId;
    if (f.stockNumber !== o.stockNumber) patch.stockNumber = orNull(f.stockNumber);
    if (f.vinHin !== o.vinHin) patch.vinHin = orNull(f.vinHin);
    if (f.model !== o.model) patch.model = orNull(f.model);
    if (f.modelYear !== o.modelYear) patch.modelYear = f.modelYear.trim() ? Number(f.modelYear) : null;
    if (f.receivedDate !== o.receivedDate) patch.receivedDate = f.receivedDate || null;
    if (f.listPriceCents !== o.listPriceCents) patch.listPriceCents = f.listPriceCents;
    if (f.description !== o.description) patch.description = orNull(f.description);
    if (f.notes !== o.notes) patch.notes = orNull(f.notes);
    if (Object.keys(patch).length === 1) {
      onClose();
      return;
    }
    setBusy(true);
    const res = await dealerMutate<UnitView>('patch', '/api/dealer/units', locationId, patch, 'Unit updated');
    setBusy(false);
    if (res.error) {
      setErrors(fieldErrors(res.error));
      return;
    }
    onSaved();
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title="Edit unit"
      description="Descriptive details only — nothing posts to the books."
      width="lg"
      footer={
        <>
          <button type="button" className="btn-secondary btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary btn-sm inline-flex items-center gap-1.5" onClick={() => void submit()} disabled={busy}>
            {busy && <Loader2 size={13} className="animate-spin" />}
            Save changes
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
        <Field label="Serial number" htmlFor={`${id}-sn`} required error={errors.serialNumber} hint={locked ? 'Locked — cost has been posted to this unit.' : undefined}>
          <TextInput id={`${id}-sn`} value={f.serialNumber} onChange={(v) => set('serialNumber', v)} className="font-mono" disabled={locked} maxLength={100} invalid={!!errors.serialNumber} />
        </Field>
        <Field label="Make (manufacturer)" htmlFor={`${id}-mk`} hint={locked ? 'Locked — cost has been posted to this unit.' : undefined}>
          <LookupPicker id={`${id}-mk`} kind="vendors" value={f.makeVendorId} onChange={(v) => set('makeVendorId', v)} disabled={locked} />
        </Field>
        <Field label="Stock number" htmlFor={`${id}-st`}>
          <TextInput id={`${id}-st`} value={f.stockNumber} onChange={(v) => set('stockNumber', v)} className="font-mono" maxLength={100} />
        </Field>
        <Field label="VIN / HIN" htmlFor={`${id}-vin`}>
          <TextInput id={`${id}-vin`} value={f.vinHin} onChange={(v) => set('vinHin', v)} className="font-mono" maxLength={100} />
        </Field>
        <Field label="Model" htmlFor={`${id}-md`}>
          <TextInput id={`${id}-md`} value={f.model} onChange={(v) => set('model', v)} maxLength={200} />
        </Field>
        <Field label="Model year" htmlFor={`${id}-yr`} error={errors.modelYear}>
          <TextInput id={`${id}-yr`} value={f.modelYear} onChange={(v) => set('modelYear', v)} inputMode="numeric" className="font-mono" maxLength={4} invalid={!!errors.modelYear} />
        </Field>
        <Field label="Received" htmlFor={`${id}-rc`} hint="Days in stock count from this date.">
          <DateInput id={`${id}-rc`} value={f.receivedDate} onChange={(v) => set('receivedDate', v)} />
        </Field>
        <Field label="List price" htmlFor={`${id}-lp`}>
          <MoneyInput id={`${id}-lp`} cents={f.listPriceCents} onChange={(c) => set('listPriceCents', c)} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Description" htmlFor={`${id}-ds`}>
            <TextArea id={`${id}-ds`} value={f.description} onChange={(v) => set('description', v)} rows={2} maxLength={1000} />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Internal notes" htmlFor={`${id}-nt`}>
            <TextArea id={`${id}-nt`} value={f.notes} onChange={(v) => set('notes', v)} rows={2} maxLength={2000} />
          </Field>
        </div>
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}
