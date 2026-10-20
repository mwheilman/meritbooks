'use client';

/**
 * New / edit (draft) warranty claim with a LIVE claimed-total preview computed by
 * the same pure engine the server uses (engine/warranty computeClaim): labor =
 * hours × warranty rate, parts = cost × (1 + markup), each rounded half-up, so what
 * the person sees is what the database CHECK will accept.
 * POST /api/dealer/warranty (warrantyCreate) · PATCH (warrantyUpdate, draft only).
 */

import { useEffect, useId, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { computeClaim, type ClaimComponents } from '@/lib/dealer/engine/warranty';
import { bpsToPct, money, pctToBps } from '@/lib/dealer/ui/format';
import { fieldErrors } from '@/lib/dealer/ui/errors';
import { hoursNumber, type WarrantyClaimRow } from '@/lib/dealer/ui/claims';
import { dealerMutate, type DealerApiError } from '../../_lib/use-dealer';
import { DateInput, Field, Modal, MoneyInput, TextInput } from '../../_components/forms';
import { LookupPicker } from '../../_components/lookup-picker';
import { ErrorPanel, Mono } from '../../_components/ui';

interface Draft {
  oemVendorId: string | null;
  oemClaimNumber: string;
  dealerClaimRef: string;
  repairOrderRef: string;
  unitId: string | null;
  serialNumber: string;
  customerId: string | null;
  failureDate: string;
  repairDate: string;
  filingDeadline: string;
  laborHours: string;
  laborRateCents: number | null;
  partsCostCents: number | null;
  partsMarkupPct: string;
  subletCents: number | null;
  freightCents: number | null;
  otherCents: number | null;
}

function fromRow(r: WarrantyClaimRow | null): Draft {
  return {
    oemVendorId: r?.oem_vendor_id ?? null,
    oemClaimNumber: r?.oem_claim_number ?? '',
    dealerClaimRef: r?.dealer_claim_ref ?? '',
    repairOrderRef: r?.repair_order_ref ?? '',
    unitId: r?.unit_id ?? null,
    serialNumber: r?.serial_number ?? '',
    customerId: r?.customer_id ?? null,
    failureDate: r?.failure_date ?? '',
    repairDate: r?.repair_date ?? '',
    filingDeadline: r?.filing_deadline ?? '',
    laborHours: r ? hoursNumber(r.labor_hours).toFixed(2) : '0',
    laborRateCents: r?.labor_rate_cents ?? 0,
    partsCostCents: r?.parts_cost_cents ?? 0,
    partsMarkupPct: r ? bpsToPct(r.parts_markup_bps).replace('%', '').replace(/\.00$/, '') : '0',
    subletCents: r?.sublet_cents ?? 0,
    freightCents: r?.freight_cents ?? 0,
    otherCents: r?.other_cents ?? 0,
  };
}

const HOURS = /^\d{1,5}(\.\d{1,2})?$/;

type Errors = Partial<Record<keyof Draft, string>>;

function validate(d: Draft): { errors: Errors; markupBps: number | null; preview: ClaimComponents | null } {
  const e: Errors = {};
  if (!d.oemVendorId) e.oemVendorId = 'Choose the manufacturer';
  if (!HOURS.test(d.laborHours.trim())) e.laborHours = 'Hours like 2 or 1.75';
  else if (Number(d.laborHours) > 10_000) e.laborHours = 'At most 10,000 hours';
  if (d.laborRateCents === null) e.laborRateCents = 'Enter the rate (0.00 if none)';
  if (d.partsCostCents === null) e.partsCostCents = 'Enter the parts cost (0.00 if none)';
  const markupBps = /^\d+(\.\d{1,2})?$/.test(d.partsMarkupPct.trim()) ? pctToBps(d.partsMarkupPct) : null;
  if (markupBps === null) e.partsMarkupPct = 'A percentage like 30';
  else if (markupBps > 100_000) e.partsMarkupPct = 'At most 1,000%';
  if (d.subletCents === null) e.subletCents = 'Enter 0.00 if none';
  if (d.freightCents === null) e.freightCents = 'Enter 0.00 if none';
  if (d.otherCents === null) e.otherCents = 'Enter 0.00 if none';
  if (d.failureDate && d.repairDate && d.repairDate < d.failureDate) e.repairDate = 'Repair can’t be before the failure';
  let preview: ClaimComponents | null = null;
  if (!e.laborHours && !e.laborRateCents && !e.partsCostCents && markupBps !== null && !e.partsMarkupPct && !e.subletCents && !e.freightCents && !e.otherCents) {
    try {
      preview = computeClaim({
        laborHours: d.laborHours.trim(),
        laborRateCents: d.laborRateCents ?? 0,
        partsCostCents: d.partsCostCents ?? 0,
        partsMarkupBps: markupBps,
        subletCents: d.subletCents ?? 0,
        freightCents: d.freightCents ?? 0,
        otherCents: d.otherCents ?? 0,
      });
    } catch {
      preview = null;
    }
  }
  if (preview && preview.claimedCents <= 0) e.laborHours = e.laborHours ?? 'A claim must claim something — add labor or parts';
  return { errors: e, markupBps, preview };
}

const SERVER_FIELD: Record<string, keyof Draft> = {
  oemVendorId: 'oemVendorId',
  laborHours: 'laborHours',
  laborRateCents: 'laborRateCents',
  partsCostCents: 'partsCostCents',
  partsMarkupBps: 'partsMarkupPct',
  filingDeadline: 'filingDeadline',
  repairDate: 'repairDate',
  failureDate: 'failureDate',
};

export function WarrantyForm({
  open,
  onClose,
  initial,
  locationId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  initial: WarrantyClaimRow | null;
  locationId: string;
  onSaved: (row: WarrantyClaimRow) => void;
}) {
  const [d, setD] = useState<Draft>(fromRow(initial));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DealerApiError | null>(null);
  const [serverErrors, setServerErrors] = useState<Errors>({});
  const id = useId();
  const f = (k: string) => `${id}-${k}`;

  useEffect(() => {
    if (!open) return;
    setD(fromRow(initial));
    setTouched(false);
    setError(null);
    setServerErrors({});
  }, [open, initial]);

  const { errors, markupBps, preview } = useMemo(() => validate(d), [d]);
  const shown: Errors = touched ? { ...errors, ...serverErrors } : serverErrors;
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setD((p) => ({ ...p, [k]: v }));
    setServerErrors((s) => ({ ...s, [k]: undefined }));
  };

  async function save() {
    setTouched(true);
    if (Object.keys(errors).length > 0 || markupBps === null) return;
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = {
      oemVendorId: d.oemVendorId,
      oemClaimNumber: d.oemClaimNumber.trim() || null,
      dealerClaimRef: d.dealerClaimRef.trim() || null,
      repairOrderRef: d.repairOrderRef.trim() || null,
      jobId: initial?.job_id ?? null,
      unitId: d.unitId,
      serialNumber: d.serialNumber.trim() || null,
      customerId: d.customerId,
      failureDate: d.failureDate || null,
      repairDate: d.repairDate || null,
      filingDeadline: d.filingDeadline || null,
      laborHours: d.laborHours.trim(),
      laborRateCents: d.laborRateCents,
      partsCostCents: d.partsCostCents,
      partsMarkupBps: markupBps,
      subletCents: d.subletCents,
      freightCents: d.freightCents,
      otherCents: d.otherCents,
      ...(initial ? { id: initial.id } : {}),
    };
    const res = await dealerMutate<WarrantyClaimRow>(initial ? 'patch' : 'post', '/api/dealer/warranty', locationId, body, initial ? 'Claim updated' : 'Warranty claim created as a draft');
    setBusy(false);
    if (res.error || !res.data) {
      setError(res.error);
      const fe = fieldErrors(res.error);
      const mapped: Errors = {};
      for (const [k, v] of Object.entries(fe)) if (SERVER_FIELD[k]) mapped[SERVER_FIELD[k]] = v;
      setServerErrors(mapped);
      return;
    }
    onSaved(res.data);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      width="xl"
      title={initial ? 'Edit draft claim' : 'New warranty claim'}
      description="Saved as a draft. Nothing posts until the claim is submitted to the manufacturer."
      footer={
        <>
          <button type="button" className="btn-secondary btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void save()}>
            {busy && <Loader2 size={13} className="animate-spin" />}
            {initial ? 'Save draft' : 'Create draft'}
          </button>
        </>
      }
    >
      <form
        className="grid gap-6 lg:grid-cols-[1fr_280px]"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        noValidate
      >
        <div className="space-y-5">
          <fieldset className="grid grid-cols-2 gap-4">
            <legend className="col-span-2 mb-1 text-caption uppercase tracking-caps text-slate-500">Claim</legend>
            <div className="col-span-2">
              <Field label="Manufacturer" htmlFor={f('oem')} required error={shown.oemVendorId}>
                <LookupPicker id={f('oem')} kind="vendors" value={d.oemVendorId} onChange={(v) => set('oemVendorId', v)} placeholder="Choose the manufacturer…" invalid={!!shown.oemVendorId} />
              </Field>
            </div>
            <Field label="Manufacturer claim #" htmlFor={f('ocn')} hint="Often assigned on submission">
              <TextInput id={f('ocn')} value={d.oemClaimNumber} onChange={(v) => set('oemClaimNumber', v)} maxLength={100} className="font-mono" />
            </Field>
            <Field label="Your claim reference" htmlFor={f('dcr')}>
              <TextInput id={f('dcr')} value={d.dealerClaimRef} onChange={(v) => set('dealerClaimRef', v)} maxLength={100} className="font-mono" />
            </Field>
            <Field label="Repair order #" htmlFor={f('ro')}>
              <TextInput id={f('ro')} value={d.repairOrderRef} onChange={(v) => set('repairOrderRef', v)} maxLength={100} className="font-mono" />
            </Field>
            <Field label="Filing deadline" htmlFor={f('fd')} error={shown.filingDeadline} hint="The manufacturer’s last day to file">
              <DateInput id={f('fd')} value={d.filingDeadline} onChange={(v) => set('filingDeadline', v)} />
            </Field>
          </fieldset>

          <fieldset className="grid grid-cols-2 gap-4">
            <legend className="col-span-2 mb-1 text-caption uppercase tracking-caps text-slate-500">Unit and customer</legend>
            <Field label="Unit" htmlFor={f('unit')} hint="Optional — links the claim to the unit’s history">
              <LookupPicker
                id={f('unit')}
                kind="units"
                value={d.unitId}
                onChange={(v, item) => {
                  set('unitId', v);
                  if (item && !d.serialNumber.trim()) set('serialNumber', item.label);
                }}
                placeholder="Search serial or stock #…"
              />
            </Field>
            <Field label="Serial number" htmlFor={f('sn')}>
              <TextInput id={f('sn')} value={d.serialNumber} onChange={(v) => set('serialNumber', v)} maxLength={100} className="font-mono" />
            </Field>
            <div className="col-span-2">
              <Field label="Customer" htmlFor={f('cust')}>
                <LookupPicker id={f('cust')} kind="customers" value={d.customerId} onChange={(v) => set('customerId', v)} placeholder="Optional" />
              </Field>
            </div>
            <Field label="Failure date" htmlFor={f('fail')} error={shown.failureDate}>
              <DateInput id={f('fail')} value={d.failureDate} onChange={(v) => set('failureDate', v)} />
            </Field>
            <Field label="Repair date" htmlFor={f('rep')} error={shown.repairDate}>
              <DateInput id={f('rep')} value={d.repairDate} onChange={(v) => set('repairDate', v)} />
            </Field>
          </fieldset>

          <fieldset className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <legend className="col-span-full mb-1 text-caption uppercase tracking-caps text-slate-500">What you’re claiming</legend>
            <Field label="Labor hours" htmlFor={f('hrs')} required error={shown.laborHours}>
              <TextInput id={f('hrs')} inputMode="decimal" value={d.laborHours} onChange={(v) => set('laborHours', v)} invalid={!!shown.laborHours} className="text-right font-mono tabular-nums" />
            </Field>
            <Field label="Warranty labor rate" htmlFor={f('rate')} required error={shown.laborRateCents} hint="Per hour">
              <MoneyInput id={f('rate')} cents={d.laborRateCents} onChange={(v) => set('laborRateCents', v)} invalid={!!shown.laborRateCents} />
            </Field>
            <Field label="Parts at cost" htmlFor={f('pc')} required error={shown.partsCostCents}>
              <MoneyInput id={f('pc')} cents={d.partsCostCents} onChange={(v) => set('partsCostCents', v)} invalid={!!shown.partsCostCents} />
            </Field>
            <Field label="Parts markup %" htmlFor={f('mk')} required error={shown.partsMarkupPct} hint="The manufacturer’s reimbursement">
              <TextInput id={f('mk')} inputMode="decimal" value={d.partsMarkupPct} onChange={(v) => set('partsMarkupPct', v)} invalid={!!shown.partsMarkupPct} className="text-right font-mono tabular-nums" />
            </Field>
            <Field label="Sublet" htmlFor={f('sub')} error={shown.subletCents}>
              <MoneyInput id={f('sub')} cents={d.subletCents} onChange={(v) => set('subletCents', v)} invalid={!!shown.subletCents} />
            </Field>
            <Field label="Freight" htmlFor={f('frt')} error={shown.freightCents}>
              <MoneyInput id={f('frt')} cents={d.freightCents} onChange={(v) => set('freightCents', v)} invalid={!!shown.freightCents} />
            </Field>
            <Field label="Other" htmlFor={f('oth')} error={shown.otherCents}>
              <MoneyInput id={f('oth')} cents={d.otherCents} onChange={(v) => set('otherCents', v)} invalid={!!shown.otherCents} />
            </Field>
          </fieldset>
          {error && <ErrorPanel error={error} compact />}
        </div>

        <aside aria-live="polite" className="h-fit rounded-xl border border-slate-800 bg-surface-950 p-4 lg:sticky lg:top-0">
          <h3 className="mb-3 text-caption uppercase tracking-caps text-slate-500">Claim total</h3>
          {preview ? (
            <dl className="space-y-2 text-xs">
              <Row label="Labor" detail={`${(preview.laborHoursHundredths / 100).toFixed(2)} h × ${money(d.laborRateCents)}`} cents={preview.laborCents} />
              <Row label="Parts" detail={`${money(d.partsCostCents)} × (1 + ${markupBps !== null ? bpsToPct(markupBps).replace(/\.00%$/, '%') : '—'})`} cents={preview.partsCents} />
              <Row label="Sublet" cents={preview.subletCents} />
              <Row label="Freight" cents={preview.freightCents} />
              <Row label="Other" cents={preview.otherCents} />
              <div className="mt-2 flex items-baseline justify-between border-t border-slate-800 pt-3">
                <dt className="text-sm text-slate-300">Claimed</dt>
                <dd>
                  <Mono className="text-xl font-semibold text-white">{money(preview.claimedCents)}</Mono>
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-xs text-slate-500">Fill in hours, rate and parts to see the claim total.</p>
          )}
          <p className="mt-4 text-2xs leading-relaxed text-slate-500">
            Labor and parts are each rounded to the cent once, exactly as the books will record them. The claimed total must equal the sum of its parts.
          </p>
        </aside>
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}

function Row({ label, detail, cents }: { label: string; detail?: string; cents: number }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="min-w-0 text-slate-400">
        {label}
        {detail && <span className="block truncate font-mono text-2xs tabular-nums text-slate-600">{detail}</span>}
      </dt>
      <dd>
        <Mono className={cents === 0 ? 'text-slate-500' : 'text-slate-200'}>{money(cents)}</Mono>
      </dd>
    </div>
  );
}
