'use client';

/**
 * Create / edit a DRAFT manufacturer incentive program (POST / PATCH
 * /api/dealer/oem-programs). The treatment defaults from the program type
 * (engine/incentive defaultTreatment) and every treatment is explained, because the
 * treatment — not the program's name — decides how its incentives post (FPB §3.9).
 */

import { useEffect, useId, useState } from 'react';
import { clsx } from 'clsx';
import { Loader2 } from 'lucide-react';
import { defaultTreatment } from '@/lib/dealer/engine/incentive';
import { PROGRAM_TYPE, TREATMENT } from '@/lib/dealer/ui/labels';
import { fieldErrors } from '@/lib/dealer/ui/errors';
import type { OemProgramRecord } from '@/lib/dealer/ui/claims';
import type { IncentiveTreatment, ProgramType } from '@/lib/dealer/types';
import { dealerMutate, type DealerApiError } from '../../_lib/use-dealer';
import { DateInput, Field, Modal, Select, TextInput, Toggle } from '../../_components/forms';
import { LookupPicker } from '../../_components/lookup-picker';
import { ErrorPanel } from '../../_components/ui';

const TYPES = Object.keys(PROGRAM_TYPE) as ProgramType[];
const TREATMENTS = Object.keys(TREATMENT) as IncentiveTreatment[];

export function ProgramForm({
  open,
  onClose,
  initial,
  locationId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  initial: OemProgramRecord | null;
  locationId: string;
  onSaved: () => void;
}) {
  const [oem, setOem] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<ProgramType>('DEALER_REBATE');
  const [treatment, setTreatment] = useState<IncentiveTreatment>(defaultTreatment('DEALER_REBATE'));
  const [overridden, setOverridden] = useState(false);
  const [paidDirect, setPaidDirect] = useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [deadline, setDeadline] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DealerApiError | null>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    setOem(initial?.oem_vendor_id ?? null);
    setCode(initial?.program_code ?? '');
    setName(initial?.name ?? '');
    setType(initial?.program_type ?? 'DEALER_REBATE');
    setTreatment(initial?.treatment ?? defaultTreatment('DEALER_REBATE'));
    setOverridden(!!initial && initial.treatment !== defaultTreatment(initial.program_type));
    setPaidDirect(initial?.paid_direct ?? false);
    setStart(initial?.start_date ?? '');
    setEnd(initial?.end_date ?? '');
    setDeadline(initial?.claim_deadline_days != null ? String(initial.claim_deadline_days) : '');
    setTouched(false);
    setError(null);
  }, [open, initial]);

  const server = fieldErrors(error);
  const errors = {
    oem: !oem ? 'Choose the manufacturer' : server.oemVendorId ?? null,
    name: name.trim() === '' ? 'Give the program a name' : name.length > 200 ? 'At most 200 characters' : server.name ?? null,
    end: start && end && end < start ? 'Ends before it starts' : server.endDate ?? null,
    deadline: deadline.trim() !== '' && (!/^\d+$/.test(deadline.trim()) || Number(deadline) > 3650) ? 'Whole days, 0–3,650' : server.claimDeadlineDays ?? null,
  };
  const valid = !errors.oem && !errors.name && !errors.end && !errors.deadline;

  function chooseType(t: ProgramType) {
    setType(t);
    if (!overridden) setTreatment(defaultTreatment(t));
  }

  async function save() {
    setTouched(true);
    if (!valid) return;
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = {
      oemVendorId: oem,
      programCode: code.trim() || null,
      name: name.trim(),
      programType: type,
      treatment,
      paidDirect,
      startDate: start || null,
      endDate: end || null,
      claimDeadlineDays: deadline.trim() === '' ? null : Number(deadline),
      ...(initial ? { id: initial.id } : {}),
    };
    const res = await dealerMutate(initial ? 'patch' : 'post', '/api/dealer/oem-programs', locationId, body, initial ? 'Program updated' : 'Program saved as a draft — approve it to start recording incentives');
    setBusy(false);
    if (res.error) return setError(res.error);
    onSaved();
    onClose();
  }

  const show = (e: string | null) => (touched ? e : null);

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      width="lg"
      title={initial ? 'Edit draft program' : 'New manufacturer program'}
      description="Programs start as drafts. An approver turns a program on before incentives can be recorded under it."
      footer={
        <>
          <button type="button" className="btn-secondary btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void save()}>
            {busy && <Loader2 size={13} className="animate-spin" />}
            Save draft
          </button>
        </>
      }
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <Field label="Manufacturer" htmlFor={`${id}-o`} required error={show(errors.oem)}>
              <LookupPicker id={`${id}-o`} kind="vendors" value={oem} onChange={(v) => setOem(v)} placeholder="Choose the manufacturer…" invalid={!!show(errors.oem)} />
            </Field>
          </div>
          <Field label="Program name" htmlFor={`${id}-n`} required error={show(errors.name)}>
            <TextInput id={`${id}-n`} value={name} onChange={setName} maxLength={200} invalid={!!show(errors.name)} />
          </Field>
          <Field label="Program code" htmlFor={`${id}-c`} hint="As printed on the bulletin">
            <TextInput id={`${id}-c`} value={code} onChange={setCode} maxLength={100} className="font-mono" />
          </Field>
          <Field label="Program type" htmlFor={`${id}-t`} required>
            <Select<ProgramType> id={`${id}-t`} value={type} onChange={chooseType} options={TYPES.map((t) => ({ value: t, label: PROGRAM_TYPE[t] }))} />
          </Field>
          <Field label="Claim deadline" htmlFor={`${id}-dl`} error={show(errors.deadline)} hint="Days after an incentive is earned (blank = none)">
            <TextInput id={`${id}-dl`} inputMode="numeric" value={deadline} onChange={setDeadline} className="text-right font-mono tabular-nums" invalid={!!show(errors.deadline)} />
          </Field>
          <Field label="Starts" htmlFor={`${id}-s`}>
            <DateInput id={`${id}-s`} value={start} onChange={setStart} />
          </Field>
          <Field label="Ends" htmlFor={`${id}-e`} error={show(errors.end)}>
            <DateInput id={`${id}-e`} value={end} onChange={setEnd} invalid={!!show(errors.end)} />
          </Field>
        </div>

        <fieldset>
          <legend className="mb-1 text-label text-slate-300">How its incentives post</legend>
          <p className="mb-2 text-xs text-slate-500">
            Suggested for a {PROGRAM_TYPE[type].toLowerCase()}: <span className="text-slate-300">{TREATMENT[defaultTreatment(type)].label}</span>. Change it only if your accountant treats this program differently. It can’t change once incentives exist under an approved program.
          </p>
          <div className="space-y-2" role="radiogroup">
            {TREATMENTS.map((t) => (
              <label key={t} className={clsx('flex cursor-pointer gap-3 rounded-lg border px-3 py-2', treatment === t ? 'border-emerald-500/50 bg-emerald-500/[0.04]' : 'border-slate-800 hover:border-slate-700')}>
                <input
                  type="radio"
                  name={`${id}-treat`}
                  value={t}
                  checked={treatment === t}
                  onChange={() => {
                    setTreatment(t);
                    setOverridden(t !== defaultTreatment(type));
                  }}
                  className="mt-1 accent-emerald-500"
                />
                <span className="min-w-0">
                  <span className="block text-sm text-slate-200">
                    {TREATMENT[t].label}
                    {t === defaultTreatment(type) && <span className="ml-2 text-2xs text-slate-500">Suggested</span>}
                  </span>
                  <span className="block text-xs text-slate-500">{TREATMENT[t].hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="flex items-start justify-between gap-4 rounded-lg border border-slate-800 px-3 py-3">
          <div>
            <p className="text-sm text-slate-200">Paid by the manufacturer directly</p>
            <p className="text-xs text-slate-500">E.g. spiffs paid straight to salespeople or interest subsidies paid to the lender. Kept for reporting only — no dealer entry is ever booked.</p>
          </div>
          <Toggle checked={paidDirect} onChange={setPaidDirect} label="Paid by the manufacturer directly" />
        </div>
        {error && <ErrorPanel error={error} compact />}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}
