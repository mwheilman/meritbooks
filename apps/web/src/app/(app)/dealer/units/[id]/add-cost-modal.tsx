'use client';

/**
 * Add a cost to a unit (POST /api/dealer/units/costs, schema `unitCostAdd`).
 * Three sources (FPB §3.6):
 *  - Vendor bill line — links an already-posted AP bill line (no second entry).
 *  - Internal repair order — setup / PDI labor at ACTUAL cost + parts at cost.
 *    No overhead, burden or labor class exists anywhere (canon §2).
 *  - Journal entry — a direct cost with a plain-English offset; post now or leave
 *    it for review.
 */

import { useEffect, useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { DealerSettings } from '@/lib/dealer/types';
import { COST_TYPE } from '@/lib/dealer/ui/labels';
import { COST_OFFSET, type CostOffset } from '@/lib/dealer/ui/unit-deal-labels';
import { fieldErrors } from '@/lib/dealer/ui/errors';
import { money, todayLocal } from '@/lib/dealer/ui/format';
import type { CostView, UnitView } from '@/lib/dealer/ui/unit-deal-types';
import { addToast } from '@/hooks/use-toast';
import { DateInput, Field, Modal, MoneyInput, Select, TextInput, Toggle } from '../../_components/forms';
import { Segments } from '../../_components/dealer-table';
import { dealerMutate } from '../../_lib/use-dealer';
import { BillLinePicker } from './bill-line-picker';

type Source = 'BILL_LINE' | 'INTERNAL_RO' | 'JE';
type AddableCost = 'BASE_INVOICE' | 'FREIGHT' | 'SETUP_PDI' | 'ACCESSORY' | 'RECON' | 'OTHER';
const COST_TYPES: AddableCost[] = ['BASE_INVOICE', 'FREIGHT', 'SETUP_PDI', 'ACCESSORY', 'RECON', 'OTHER'];
const OFFSETS = Object.keys(COST_OFFSET) as CostOffset[];

export function AddCostModal({
  open,
  onClose,
  locationId,
  unit,
  settings,
  enabled,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  locationId: string;
  unit: UnitView;
  settings: DealerSettings | null;
  enabled: boolean;
  onAdded: () => void;
}) {
  const id = useId();
  const [source, setSource] = useState<Source>('INTERNAL_RO');
  const [costType, setCostType] = useState<AddableCost>('SETUP_PDI');
  const [billLineId, setBillLineId] = useState<string | null>(null);
  const [labor, setLabor] = useState<number | null>(null);
  const [parts, setParts] = useState<number | null>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const [offset, setOffset] = useState<CostOffset | ''>('');
  const [ref, setRef] = useState('');
  const [costDate, setCostDate] = useState(todayLocal());
  const [memo, setMemo] = useState('');
  const [postNow, setPostNow] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSource(unit.condition === 'USED' ? 'JE' : 'INTERNAL_RO');
    setCostType(unit.condition === 'USED' ? 'RECON' : 'SETUP_PDI');
    setBillLineId(null);
    setLabor(null);
    setParts(null);
    setAmount(null);
    setOffset('');
    setRef('');
    setCostDate(todayLocal());
    setMemo('');
    setPostNow(false);
    setErrors({});
  }, [open, unit.condition]);

  const capitalizeLabor = settings?.capitalize_setup_labor !== false;
  const roTotal = (capitalizeLabor ? labor ?? 0 : 0) + (parts ?? 0);

  function validate(): Record<string, string> {
    const e: Record<string, string> = {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(costDate)) e.costDate = 'Date is required';
    if (source === 'BILL_LINE' && !billLineId) e.billLineId = 'Choose the bill line';
    if (source === 'INTERNAL_RO' && !(labor && labor > 0) && !(parts && parts > 0)) e.laborCents = 'Enter the labor and/or parts cost from the repair order';
    else if (source === 'INTERNAL_RO' && !capitalizeLabor && roTotal === 0) e.laborCents = 'Nothing would be added — this client keeps setup labor in wages, so enter parts';
    if (source === 'JE') {
      if (!amount || amount <= 0) e.amountCents = 'Enter the amount';
      if (!offset) e.offset = 'Where did the money come from?';
    }
    return e;
  }

  async function submit() {
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    const body: Record<string, unknown> = { unitId: unit.id, costType, sourceType: source, costDate, memo: memo.trim() || null, sourceRef: ref.trim() || null };
    if (source === 'BILL_LINE') body.billLineId = billLineId;
    if (source === 'INTERNAL_RO') {
      body.laborCents = labor ?? 0;
      body.partsCents = parts ?? 0;
      body.post = postNow;
    }
    if (source === 'JE') {
      body.amountCents = amount;
      body.offset = offset;
      body.post = postNow;
    }
    const res = await dealerMutate<{ cost: CostView; warnings: string[] }>('post', '/api/dealer/units/costs', locationId, body);
    setBusy(false);
    if (res.error) {
      setErrors(fieldErrors(res.error));
      return;
    }
    const c = res.data?.cost;
    addToast('success', c?.status === 'POSTED' ? `Cost of ${money(c.amount_cents)} posted to the unit` : `Cost of ${money(c?.amount_cents ?? 0)} added — waiting to be posted`);
    for (const w of res.data?.warnings ?? []) addToast('info', w);
    onAdded();
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title="Add a cost to this unit"
      description={`S/N ${unit.serial_number} · current cost ${money(unit.cost_cents)}`}
      width="lg"
      footer={
        <>
          <button type="button" className="btn-secondary btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary btn-sm inline-flex items-center gap-1.5" onClick={() => void submit()} disabled={busy}>
            {busy && <Loader2 size={13} className="animate-spin" />}
            {source === 'BILL_LINE' ? 'Link bill line' : postNow ? 'Add and post' : 'Add for review'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Segments<Source>
          label="Where the cost comes from"
          value={source}
          onChange={setSource}
          options={[
            { value: 'INTERNAL_RO', label: 'Internal repair order' },
            { value: 'BILL_LINE', label: 'Vendor bill line' },
            { value: 'JE', label: 'Journal entry' },
          ]}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Kind of cost" htmlFor={`${id}-type`} required>
            <Select<AddableCost> id={`${id}-type`} value={costType} onChange={setCostType} options={COST_TYPES.map((t) => ({ value: t, label: COST_TYPE[t].label }))} />
          </Field>
          <Field label="Date" htmlFor={`${id}-date`} required error={errors.costDate} hint={source === 'BILL_LINE' ? undefined : 'The entry date if you post it now.'}>
            <DateInput id={`${id}-date`} value={costDate} onChange={setCostDate} invalid={!!errors.costDate} />
          </Field>
        </div>

        {source === 'BILL_LINE' && (
          <>
            <p className="text-xs text-slate-400">
              The bill already booked this cost to the unit’s inventory account. Linking the line adds it to the unit’s cost — no second journal entry.
              The line must be coded to this unit’s inventory account and the bill must be posted.
            </p>
            <BillLinePicker locationId={locationId} value={billLineId} onChange={setBillLineId} error={errors.billLineId} />
          </>
        )}

        {source === 'INTERNAL_RO' && (
          <>
            <p className="text-xs text-slate-400">
              Enter the repair order’s <span className="text-slate-200">actual cost</span>: technician labor at actual cost and parts at cost. No overhead,
              burden or markup is added.
            </p>
            {!capitalizeLabor && (
              <p className="text-xs text-amber-300">This client keeps setup labor in wages — only the parts will be added to the unit.</p>
            )}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label="Labor at actual cost" htmlFor={`${id}-labor`} error={errors.laborCents}>
                <MoneyInput id={`${id}-labor`} cents={labor} onChange={setLabor} invalid={!!errors.laborCents} disabled={!capitalizeLabor} />
              </Field>
              <Field label="Parts at cost" htmlFor={`${id}-parts`} error={errors.partsCents}>
                <MoneyInput id={`${id}-parts`} cents={parts} onChange={setParts} />
              </Field>
              <Field label="Repair order #" htmlFor={`${id}-ro`} hint="Keeps the same RO from being added twice.">
                <TextInput id={`${id}-ro`} value={ref} onChange={setRef} className="font-mono" maxLength={200} />
              </Field>
            </div>
            <p className="text-xs text-slate-500">
              Adds <span className="font-mono tabular-nums text-slate-300">{money(roTotal)}</span> to the unit.
            </p>
          </>
        )}

        {source === 'JE' && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Amount" htmlFor={`${id}-amt`} required error={errors.amountCents}>
              <MoneyInput id={`${id}-amt`} cents={amount} onChange={setAmount} invalid={!!errors.amountCents} />
            </Field>
            <Field label="Paid or owed from" htmlFor={`${id}-off`} required error={errors.offset} hint={offset ? COST_OFFSET[offset].hint : undefined}>
              <Select<CostOffset>
                id={`${id}-off`}
                value={offset}
                onChange={setOffset}
                placeholder="Choose…"
                invalid={!!errors.offset}
                options={OFFSETS.map((o) => ({ value: o, label: COST_OFFSET[o].label }))}
              />
            </Field>
            <Field label="Reference" htmlFor={`${id}-ref`}>
              <TextInput id={`${id}-ref`} value={ref} onChange={setRef} className="font-mono" maxLength={200} />
            </Field>
          </div>
        )}

        <Field label="Memo" htmlFor={`${id}-memo`}>
          <TextInput id={`${id}-memo`} value={memo} onChange={setMemo} maxLength={500} />
        </Field>

        {source !== 'BILL_LINE' && (
          <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-800 bg-surface-950 px-4 py-3">
            <div>
              <p className="text-label text-slate-300">Post it now</p>
              <p className="text-xs text-slate-500">
                {enabled ? 'Otherwise it waits on the unit for someone with posting rights to review.' : 'The dealer pack is off for this client — add it for review and post once it’s switched on.'}
              </p>
            </div>
            <Toggle id={`${id}-post`} checked={postNow} onChange={setPostNow} label="Post it now" disabled={!enabled} />
          </div>
        )}
      </div>
    </Modal>
  );
}
