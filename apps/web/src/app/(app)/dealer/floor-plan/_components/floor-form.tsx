'use client';

/**
 * Floor a unit by hand (`POST /api/dealer/floor`) — line, program, collateral,
 * lender invoice #, floored date, principal, and an existing unit or a new one.
 * Saved for review by default; "post now" books it immediately (needs posting
 * rights). The outcome is explained in plain English (posted / waiting / already
 * recorded).
 */

import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Clock, Info, Loader2 } from 'lucide-react';
import type { CollateralType, UnitCondition } from '@/lib/dealer/types';
import { COLLATERAL, UNIT_CONDITION } from '@/lib/dealer/ui/labels';
import { money, todayLocal } from '@/lib/dealer/ui/format';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { fieldErrors, type DealerApiError } from '@/lib/dealer/ui/errors';
import { dealerMutate } from '../../_lib/use-dealer';
import { DateInput, Field, Modal, MoneyInput, Select, TextInput, Toggle } from '../../_components/forms';
import { LookupPicker } from '../../_components/lookup-picker';
import { ErrorPanel } from '../../_components/ui';
import { validateFloor, type FloorDraft } from '../_lib/forms';
import type { FpNote, FpTxn } from '../_lib/types';

interface FloorResult {
  note: FpNote;
  unit: { id: string; serial_number: string } | null;
  txn: FpTxn;
  created: boolean;
  disposition: 'POSTED' | 'PROPOSED' | 'OPENING' | 'EXISTING';
  reason?: string;
}

function blank(): FloorDraft {
  return {
    lineId: null,
    programId: null,
    collateralType: 'WHOLE_GOOD',
    lenderInvoiceNumber: '',
    flooredDate: todayLocal(),
    principalCents: null,
    description: '',
    scheduledDueDate: '',
    unitMode: 'new',
    unitId: null,
    serialNumber: '',
    makeVendorId: null,
    model: '',
    modelYear: '',
    condition: 'NEW',
    postNow: false,
  };
}

const OUTCOME: Record<FloorResult['disposition'], { title: string; body: string; icon: typeof CheckCircle2; tone: string }> = {
  POSTED: { title: 'Floored and posted', body: 'Unit inventory and the floor-plan payable are booked.', icon: CheckCircle2, tone: 'text-emerald-400' },
  PROPOSED: { title: 'Saved for review', body: 'It posts when someone approves it in “Floorings waiting for review”.', icon: Clock, tone: 'text-amber-400' },
  OPENING: { title: 'Opening balance loaded', body: 'No entry was posted — it ties to the migrated trial balance.', icon: Info, tone: 'text-blue-400' },
  EXISTING: { title: 'Already recorded', body: 'This lender invoice was floored before for this unit. Nothing new was saved or posted.', icon: Info, tone: 'text-blue-400' },
};

export function FloorFormModal({ open, onClose, locationId, canPost, onSaved }: { open: boolean; onClose: () => void; locationId: string; canPost: boolean; onSaved: () => void }) {
  const [v, setV] = useState<FloorDraft>(blank());
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DealerApiError | null>(null);
  const [result, setResult] = useState<FloorResult | null>(null);
  const f = {
    line: useId(),
    prog: useId(),
    coll: useId(),
    inv: useId(),
    date: useId(),
    amt: useId(),
    unit: useId(),
    serial: useId(),
    make: useId(),
    model: useId(),
    year: useId(),
    cond: useId(),
    desc: useId(),
    due: useId(),
    post: useId(),
  };

  useEffect(() => {
    if (open) {
      setV(blank());
      setTouched(false);
      setError(null);
      setResult(null);
    }
  }, [open]);

  const { body, errors } = validateFloor(v);
  const server = fieldErrors(error);
  const err = (k: string) => (touched ? errors[k] ?? server[k] ?? null : server[k] ?? null);
  const set = <K extends keyof FloorDraft>(k: K, val: FloorDraft[K]) => setV((s) => ({ ...s, [k]: val }));

  async function save() {
    setTouched(true);
    if (!body) return;
    setBusy(true);
    setError(null);
    const res = await dealerMutate<FloorResult>('post', '/api/dealer/floor', locationId, { ...body }, undefined);
    setBusy(false);
    if (res.error) setError(res.error);
    else if (res.data) {
      setResult(res.data);
      onSaved();
    }
  }

  const outcome = result ? OUTCOME[result.disposition] : null;

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title="Floor a unit"
      description="Record that the lender paid the manufacturer for a unit (or an open-account invoice). Use this when it isn’t coming in on a lender import."
      width="lg"
      footer={
        result ? (
          <>
            <button type="button" className="btn-secondary btn-sm" onClick={() => { setResult(null); setV(blank()); setTouched(false); }}>
              Floor another
            </button>
            <button type="button" className="btn-primary btn-sm" onClick={onClose}>
              Done
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn-secondary btn-sm" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn-primary btn-sm inline-flex items-center gap-1.5" onClick={() => void save()} disabled={busy || !canPost}>
              {busy && <Loader2 size={13} className="animate-spin" />}
              {v.postNow ? 'Floor and post' : 'Save for review'}
            </button>
          </>
        )
      }
    >
      {result && outcome ? (
        <div className="space-y-3 text-sm" role="status">
          <div className="flex items-start gap-3">
            <outcome.icon size={18} className={`mt-0.5 shrink-0 ${outcome.tone}`} />
            <div>
              <p className="font-medium text-white">{outcome.title}</p>
              <p className="mt-0.5 text-slate-300">{outcome.body}</p>
              {result.reason && <p className="mt-1 text-xs text-slate-500">{result.reason}</p>}
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-3 rounded-lg border border-slate-800 bg-surface-950 p-4 text-xs">
            <div>
              <dt className="text-slate-500">Lender invoice #</dt>
              <dd className="font-mono tabular-nums text-slate-200">{result.note.lender_invoice_number}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Principal</dt>
              <dd className="font-mono tabular-nums text-slate-200">{money(result.note.original_principal_cents)}</dd>
            </div>
            {result.unit && (
              <div>
                <dt className="text-slate-500">Unit</dt>
                <dd>
                  <Link href={dealerLinks.unit(result.unit.id)} className="font-mono tabular-nums text-emerald-400 hover:underline">
                    {result.unit.serial_number}
                  </Link>
                </dd>
              </div>
            )}
            <div>
              <dt className="text-slate-500">Note</dt>
              <dd>
                <Link href={dealerLinks.note(result.note.id)} className="text-emerald-400 hover:underline">
                  Open note →
                </Link>
              </dd>
            </div>
          </dl>
        </div>
      ) : (
        <form
          noValidate
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Line" htmlFor={f.line} required error={err('lineId')}>
              <LookupPicker id={f.line} kind="lines" value={v.lineId} onChange={(x) => setV((s) => ({ ...s, lineId: x, programId: null }))} invalid={!!err('lineId')} placeholder="Choose a line" />
            </Field>
            <Field label="Program" htmlFor={f.prog} hint="Sets free floor, maturity and curtailments. Only active programs on this line.">
              <LookupPicker
                id={f.prog}
                kind="programs"
                value={v.programId}
                onChange={(x) => set('programId', x)}
                disabled={!v.lineId}
                filter={(it) => it.meta?.lineId === v.lineId && it.meta?.status === 'ACTIVE'}
                placeholder={v.lineId ? 'No program' : 'Choose a line first'}
              />
            </Field>
            <Field label="What’s floored" htmlFor={f.coll}>
              <Select<CollateralType>
                id={f.coll}
                value={v.collateralType}
                onChange={(x) => set('collateralType', x)}
                options={(Object.keys(COLLATERAL) as CollateralType[]).map((k) => ({ value: k, label: COLLATERAL[k] }))}
              />
            </Field>
            <Field label="Lender invoice #" htmlFor={f.inv} required error={err('lenderInvoiceNumber')}>
              <TextInput id={f.inv} value={v.lenderInvoiceNumber} onChange={(x) => set('lenderInvoiceNumber', x)} maxLength={100} invalid={!!err('lenderInvoiceNumber')} className="font-mono" />
            </Field>
            <Field label="Floored date" htmlFor={f.date} required error={err('flooredDate')}>
              <DateInput id={f.date} value={v.flooredDate} onChange={(x) => set('flooredDate', x)} invalid={!!err('flooredDate')} />
            </Field>
            <Field label="Principal (amount the lender paid)" htmlFor={f.amt} required error={err('principalCents')}>
              <MoneyInput id={f.amt} cents={v.principalCents} onChange={(x) => set('principalCents', x)} invalid={!!err('principalCents')} />
            </Field>
          </div>

          {v.collateralType === 'WHOLE_GOOD' ? (
            <fieldset className="rounded-lg border border-slate-800 p-4">
              <legend className="px-1 text-caption uppercase tracking-caps text-slate-500">Unit</legend>
              <div role="radiogroup" aria-label="Unit" className="mb-3 inline-flex rounded-lg border border-slate-800 bg-surface-950 p-0.5">
                {(['new', 'existing'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={v.unitMode === m}
                    onClick={() => set('unitMode', m)}
                    className={`rounded-md px-2.5 py-1 text-xs ${v.unitMode === m ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                  >
                    {m === 'new' ? 'New unit' : 'Unit already in Books'}
                  </button>
                ))}
              </div>
              {v.unitMode === 'existing' ? (
                <Field label="Unit" htmlFor={f.unit} required error={err('unitId')}>
                  <LookupPicker id={f.unit} kind="units" value={v.unitId} onChange={(x) => set('unitId', x)} invalid={!!err('unitId')} placeholder="Search serial, stock # or model" />
                </Field>
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <Field label="Serial number" htmlFor={f.serial} required error={err('serialNumber')}>
                    <TextInput id={f.serial} value={v.serialNumber} onChange={(x) => set('serialNumber', x)} maxLength={100} invalid={!!err('serialNumber')} className="font-mono" />
                  </Field>
                  <Field label="Make (manufacturer)" htmlFor={f.make}>
                    <LookupPicker id={f.make} kind="vendors" value={v.makeVendorId} onChange={(x) => set('makeVendorId', x)} placeholder="Optional" />
                  </Field>
                  <Field label="Condition" htmlFor={f.cond}>
                    <Select<UnitCondition>
                      id={f.cond}
                      value={v.condition}
                      onChange={(x) => set('condition', x)}
                      options={(Object.keys(UNIT_CONDITION) as UnitCondition[]).map((k) => ({ value: k, label: UNIT_CONDITION[k].label }))}
                    />
                  </Field>
                  <Field label="Model" htmlFor={f.model} error={err('model')}>
                    <TextInput id={f.model} value={v.model} onChange={(x) => set('model', x)} maxLength={200} />
                  </Field>
                  <Field label="Model year" htmlFor={f.year} error={err('modelYear')}>
                    <TextInput id={f.year} inputMode="numeric" value={v.modelYear} onChange={(x) => set('modelYear', x)} maxLength={4} invalid={!!err('modelYear')} className="font-mono" />
                  </Field>
                </div>
              )}
            </fieldset>
          ) : (
            <Field label="Scheduled due date" htmlFor={f.due} error={err('scheduledDueDate')} hint="When the lender expects this open-account item paid.">
              <DateInput id={f.due} value={v.scheduledDueDate} onChange={(x) => set('scheduledDueDate', x)} />
            </Field>
          )}

          <Field label="Description" htmlFor={f.desc} error={err('description')}>
            <TextInput id={f.desc} value={v.description} onChange={(x) => set('description', x)} maxLength={500} />
          </Field>

          <div className="flex items-start gap-3 rounded-lg border border-slate-800 bg-surface-950 p-3">
            <Toggle id={f.post} checked={v.postNow} onChange={(x) => set('postNow', x)} label="Post now" disabled={!canPost} />
            <div className="text-xs">
              <label htmlFor={f.post} className="font-medium text-slate-200">
                Post now
              </label>
              <p className="mt-0.5 text-slate-400">
                {canPost
                  ? 'Books debit unit inventory / credit floor-plan payable right away. Leave off to save it for someone to review first.'
                  : 'Flooring is a money event — switch the dealer pack on for this client first (opening balances load from Imports).'}
              </p>
            </div>
          </div>
          {error && <ErrorPanel error={error} compact />}
        </form>
      )}
    </Modal>
  );
}
