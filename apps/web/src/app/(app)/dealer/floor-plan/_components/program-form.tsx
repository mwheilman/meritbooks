'use client';

/**
 * Add / edit a floor-plan program: free floor, fixed or index-plus rate, the
 * sold-and-unpaid penalty rate, day count, payoff terms, maximum term, and the
 * curtailment schedule editor with a live preview (pure `buildCurtailmentSchedule`
 * — the same function flooring uses). Validated to match `programCreate`.
 */

import { useEffect, useId, useMemo, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import type { DayCount, PayoffTerms, ProgramStatus, RateType } from '@/lib/dealer/types';
import { buildCurtailmentSchedule } from '@/lib/dealer/engine/notes';
import { DAY_COUNT, PAYOFF_TERMS, PROGRAM_STATUS, RATE_TYPE } from '@/lib/dealer/ui/labels';
import { bpsToPct, dateLabel, money, todayLocal } from '@/lib/dealer/ui/format';
import { fieldErrors, type DealerApiError } from '@/lib/dealer/ui/errors';
import { dealerMutate } from '../../_lib/use-dealer';
import { DateInput, Field, Modal, MoneyInput, Select, TextInput, Toggle } from '../../_components/forms';
import { LookupPicker } from '../../_components/lookup-picker';
import { ErrorPanel } from '../../_components/ui';
import { draftEffectiveRateBps, validateProgram, type ProgramDraft } from '../_lib/forms';
import { MAX_SCHEDULE_ROWS, newScheduleRow, rulesToDrafts, validateSchedule, type ScheduleDraftRow } from '../_lib/schedule';
import type { FpProgram } from '../_lib/types';

const pct = (bps: number | null | undefined) => (bps === null || bps === undefined ? '' : String(bps / 100));

function draftFrom(p: FpProgram | null, lineId: string | null): ProgramDraft {
  return {
    lineId: p?.line_id ?? lineId,
    oemVendorId: p?.oem_vendor_id ?? null,
    name: p?.name ?? '',
    freeFloorDays: p ? String(p.free_floor_days) : '0',
    rateType: p?.rate_type ?? 'FIXED',
    ratePct: p && p.rate_type === 'FIXED' ? pct(p.rate_bps) : '',
    indexName: p?.index_name ?? '',
    indexRatePct: pct(p?.index_rate_bps),
    spreadPct: pct(p?.spread_bps),
    penaltyPct: pct(p?.sau_penalty_rate_bps),
    dayCount: p?.day_count ?? 'ACT_365',
    payoffTerms: p?.payoff_terms ?? 'PAY_AS_SOLD',
    payoffDays: p && p.payoff_terms === 'DAYS_AFTER_SALE' ? String(p.payoff_days) : '',
    maxTermDays: p?.max_term_days ? String(p.max_term_days) : '',
    curtailDemos: p?.curtail_demos ?? false,
    effectiveFrom: p?.effective_from ?? '',
    effectiveTo: p?.effective_to ?? '',
    status: p?.status ?? 'ACTIVE',
  };
}

export function ProgramFormModal({
  open,
  onClose,
  program,
  defaultLineId,
  locationId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  program: FpProgram | null;
  defaultLineId: string | null;
  locationId: string;
  onSaved: () => void;
}) {
  const [v, setV] = useState<ProgramDraft>(draftFrom(program, defaultLineId));
  const [rows, setRows] = useState<ScheduleDraftRow[]>(rulesToDrafts(program?.curtailment_schedule));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DealerApiError | null>(null);
  const [sample, setSample] = useState<number | null>(1_000_000);
  const f = {
    line: useId(),
    oem: useId(),
    name: useId(),
    ff: useId(),
    rt: useId(),
    rate: useId(),
    idxName: useId(),
    idxRate: useId(),
    spread: useId(),
    pen: useId(),
    dc: useId(),
    pt: useId(),
    pd: useId(),
    max: useId(),
    demo: useId(),
    from: useId(),
    to: useId(),
    status: useId(),
    sample: useId(),
  };

  useEffect(() => {
    if (open) {
      setV(draftFrom(program, defaultLineId));
      setRows(rulesToDrafts(program?.curtailment_schedule));
      setTouched(false);
      setError(null);
    }
  }, [open, program, defaultLineId]);

  const schedule = validateSchedule(rows);
  const { body, errors } = validateProgram(v, schedule);
  const server = fieldErrors(error);
  const err = (k: string) => (touched ? errors[k] ?? server[k] ?? null : server[k] ?? null);
  const set = <K extends keyof ProgramDraft>(k: K, val: ProgramDraft[K]) => setV((s) => ({ ...s, [k]: val }));
  const effective = draftEffectiveRateBps(v);
  const today = todayLocal();
  const preview = useMemo(() => (sample && sample > 0 && schedule.ok ? buildCurtailmentSchedule(today, sample, schedule.rules) : []), [sample, schedule.ok, schedule.rules, today]);

  function setRow(key: string, patch: Partial<ScheduleDraftRow>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  async function save() {
    setTouched(true);
    if (!body) return;
    setBusy(true);
    setError(null);
    const res = program
      ? await dealerMutate('patch', '/api/dealer/programs', locationId, { id: program.id, ...body }, 'Program saved')
      : await dealerMutate('post', '/api/dealer/programs', locationId, { ...body }, 'Program added');
    setBusy(false);
    if (res.error) setError(res.error);
    else {
      onSaved();
      onClose();
    }
  }

  let cumulative = 0;
  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title={program ? `Edit ${program.name}` : 'Add a floor-plan program'}
      description="The lender’s terms for a manufacturer or product group. New notes copy these terms when they’re floored; existing notes keep theirs."
      width="xl"
      footer={
        <>
          <button type="button" className="btn-secondary btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary btn-sm inline-flex items-center gap-1.5" onClick={() => void save()} disabled={busy}>
            {busy && <Loader2 size={13} className="animate-spin" />}
            {program ? 'Save program' : 'Add program'}
          </button>
        </>
      }
    >
      <form
        noValidate
        className="space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <legend className="mb-3 text-caption uppercase tracking-caps text-slate-500">Program</legend>
          <Field label="Line" htmlFor={f.line} required error={err('lineId')}>
            <LookupPicker id={f.line} kind="lines" value={v.lineId} onChange={(x) => set('lineId', x)} invalid={!!err('lineId')} placeholder="Choose a line" disabled={!!program} />
          </Field>
          <Field label="Name" htmlFor={f.name} required error={err('name')}>
            <TextInput id={f.name} value={v.name} onChange={(x) => set('name', x)} maxLength={200} invalid={!!err('name')} placeholder="For example: New mowers 2026" />
          </Field>
          <Field label="Manufacturer" htmlFor={f.oem} hint="Optional — the vendor whose units this program floors.">
            <LookupPicker id={f.oem} kind="vendors" value={v.oemVendorId} onChange={(x) => set('oemVendorId', x)} placeholder="Any manufacturer" />
          </Field>
          <Field label="Free-floor days" htmlFor={f.ff} required error={err('freeFloorDays')} hint="No interest until this many days after flooring.">
            <TextInput id={f.ff} inputMode="numeric" value={v.freeFloorDays} onChange={(x) => set('freeFloorDays', x)} invalid={!!err('freeFloorDays')} className="font-mono" />
          </Field>
          <Field label="Maximum term (days)" htmlFor={f.max} error={err('maxTermDays')} hint="Sets each note’s maturity. Blank = no maturity.">
            <TextInput id={f.max} inputMode="numeric" value={v.maxTermDays} onChange={(x) => set('maxTermDays', x)} invalid={!!err('maxTermDays')} className="font-mono" />
          </Field>
          <Field label="Status" htmlFor={f.status}>
            <Select<ProgramStatus>
              id={f.status}
              value={v.status}
              onChange={(x) => set('status', x)}
              options={(Object.keys(PROGRAM_STATUS) as ProgramStatus[]).map((k) => ({ value: k, label: PROGRAM_STATUS[k].label }))}
            />
          </Field>
        </fieldset>

        <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <legend className="mb-3 text-caption uppercase tracking-caps text-slate-500">Interest</legend>
          <Field label="Rate type" htmlFor={f.rt}>
            <Select<RateType> id={f.rt} value={v.rateType} onChange={(x) => set('rateType', x)} options={(Object.keys(RATE_TYPE) as RateType[]).map((k) => ({ value: k, label: RATE_TYPE[k] }))} />
          </Field>
          {v.rateType === 'FIXED' ? (
            <Field label="Annual rate %" htmlFor={f.rate} required error={err('ratePct')}>
              <TextInput id={f.rate} inputMode="decimal" value={v.ratePct} onChange={(x) => set('ratePct', x)} invalid={!!err('ratePct')} placeholder="9.5" className="text-right font-mono" />
            </Field>
          ) : (
            <>
              <Field label="Index name" htmlFor={f.idxName} required error={err('indexName')}>
                <TextInput id={f.idxName} value={v.indexName} onChange={(x) => set('indexName', x)} maxLength={100} invalid={!!err('indexName')} placeholder="The lender’s base rate" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Index %" htmlFor={f.idxRate} required error={err('indexRatePct')}>
                  <TextInput id={f.idxRate} inputMode="decimal" value={v.indexRatePct} onChange={(x) => set('indexRatePct', x)} invalid={!!err('indexRatePct')} className="text-right font-mono" />
                </Field>
                <Field label="Spread %" htmlFor={f.spread} required error={err('spreadPct')}>
                  <TextInput id={f.spread} inputMode="decimal" value={v.spreadPct} onChange={(x) => set('spreadPct', x)} invalid={!!err('spreadPct')} className="text-right font-mono" />
                </Field>
              </div>
            </>
          )}
          <Field label="Day count" htmlFor={f.dc}>
            <Select<DayCount> id={f.dc} value={v.dayCount} onChange={(x) => set('dayCount', x)} options={(Object.keys(DAY_COUNT) as DayCount[]).map((k) => ({ value: k, label: DAY_COUNT[k] }))} />
          </Field>
          <Field
            label="Sold-and-unpaid penalty rate %"
            htmlFor={f.pen}
            error={err('penaltyPct')}
            hint="Replaces the normal rate once a sold unit passes its payoff date. Blank = no penalty rate."
          >
            <TextInput id={f.pen} inputMode="decimal" value={v.penaltyPct} onChange={(x) => set('penaltyPct', x)} invalid={!!err('penaltyPct')} className="text-right font-mono" />
          </Field>
          <div className="self-end pb-2 text-xs text-slate-400">
            Effective rate: <span className="font-mono tabular-nums text-slate-200">{effective === null ? '—' : bpsToPct(effective)}</span>
          </div>
        </fieldset>

        <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <legend className="mb-3 text-caption uppercase tracking-caps text-slate-500">Payoff and dates</legend>
          <Field label="Payoff terms" htmlFor={f.pt}>
            <Select<PayoffTerms> id={f.pt} value={v.payoffTerms} onChange={(x) => set('payoffTerms', x)} options={(Object.keys(PAYOFF_TERMS) as PayoffTerms[]).map((k) => ({ value: k, label: PAYOFF_TERMS[k] }))} />
          </Field>
          {v.payoffTerms === 'DAYS_AFTER_SALE' ? (
            <Field label="Days after sale" htmlFor={f.pd} required error={err('payoffDays')}>
              <TextInput id={f.pd} inputMode="numeric" value={v.payoffDays} onChange={(x) => set('payoffDays', x)} invalid={!!err('payoffDays')} className="font-mono" />
            </Field>
          ) : (
            <div className="self-end pb-2 text-xs text-slate-400">The payoff is due the day the unit sells.</div>
          )}
          <div className="flex items-center gap-3 self-end pb-2">
            <Toggle id={f.demo} checked={v.curtailDemos} onChange={(x) => set('curtailDemos', x)} label="Curtail demo units" />
            <label htmlFor={f.demo} className="text-sm text-slate-300">
              Lender curtails demo units
            </label>
          </div>
          <Field label="Effective from" htmlFor={f.from} error={err('effectiveFrom')} hint="Blank = today.">
            <DateInput id={f.from} value={v.effectiveFrom} onChange={(x) => set('effectiveFrom', x)} />
          </Field>
          <Field label="Effective to" htmlFor={f.to} error={err('effectiveTo')} hint="Blank = open-ended.">
            <DateInput id={f.to} value={v.effectiveTo} onChange={(x) => set('effectiveTo', x)} invalid={!!err('effectiveTo')} />
          </Field>
        </fieldset>

        <fieldset>
          <legend className="mb-1 text-caption uppercase tracking-caps text-slate-500">Curtailment schedule</legend>
          <p className="mb-3 text-xs text-slate-400">
            Pay-downs the lender requires as a unit ages, measured from the floored date. Each step is a percent of the original principal or a fixed amount; the total never exceeds the
            principal.
          </p>
          {err('curtailmentSchedule') && (
            <p className="mb-2 text-xs text-red-400" role="alert">
              {err('curtailmentSchedule')}
            </p>
          )}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
            <div className="lg:col-span-3">
              {rows.length === 0 ? (
                <p className="rounded-lg border border-dashed border-slate-700 px-4 py-6 text-center text-xs text-slate-500">No curtailments — the full balance is due at payoff or maturity.</p>
              ) : (
                <table className="w-full text-sm">
                  <caption className="sr-only">Curtailment steps</caption>
                  <thead>
                    <tr className="text-caption uppercase tracking-caps text-slate-500">
                      <th scope="col" className="pb-2 text-left font-medium">After (days)</th>
                      <th scope="col" className="pb-2 text-left font-medium">Pay</th>
                      <th scope="col" className="pb-2 text-left font-medium">Amount</th>
                      <th scope="col" className="w-8" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => {
                      const rowErr = touched || r.afterDays ? schedule.errors[r.key] : undefined;
                      return (
                        <tr key={r.key} className="align-top">
                          <td className="pb-2 pr-2">
                            <TextInput
                              aria-label={`Step ${i + 1}: days after flooring`}
                              inputMode="numeric"
                              value={r.afterDays}
                              onChange={(x) => setRow(r.key, { afterDays: x })}
                              invalid={!!rowErr}
                              className="font-mono"
                              placeholder="180"
                            />
                          </td>
                          <td className="pb-2 pr-2">
                            <Select<'pct' | 'amount'>
                              aria-label={`Step ${i + 1}: percent or fixed amount`}
                              value={r.mode}
                              onChange={(x) => setRow(r.key, { mode: x })}
                              options={[
                                { value: 'pct', label: '% of original' },
                                { value: 'amount', label: 'Fixed amount' },
                              ]}
                            />
                          </td>
                          <td className="pb-2 pr-2">
                            {r.mode === 'pct' ? (
                              <TextInput
                                aria-label={`Step ${i + 1}: percent`}
                                inputMode="decimal"
                                value={r.pct}
                                onChange={(x) => setRow(r.key, { pct: x })}
                                invalid={!!rowErr}
                                className="text-right font-mono"
                                placeholder="10"
                              />
                            ) : (
                              <MoneyInput aria-label={`Step ${i + 1}: amount`} cents={r.amountCents} onChange={(c) => setRow(r.key, { amountCents: c })} invalid={!!rowErr} />
                            )}
                            {rowErr && <p className="mt-1 text-2xs text-red-400">{rowErr}</p>}
                          </td>
                          <td className="pb-2">
                            <button type="button" aria-label={`Remove step ${i + 1}`} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} className="btn-ghost btn-sm p-1.5">
                              <Trash2 size={13} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              <button
                type="button"
                className="btn-ghost btn-sm mt-2 inline-flex items-center gap-1"
                disabled={rows.length >= MAX_SCHEDULE_ROWS}
                onClick={() => setRows((rs) => [...rs, newScheduleRow()])}
              >
                <Plus size={13} /> Add step
              </button>
            </div>
            <div className="rounded-lg border border-slate-800 bg-surface-950 p-4 lg:col-span-2">
              <div className="mb-3 flex items-end justify-between gap-3">
                <h3 className="text-label text-slate-300">Preview</h3>
                <div className="w-36">
                  <label htmlFor={f.sample} className="mb-1 block text-2xs text-slate-500">
                    Sample unit floored today at
                  </label>
                  <MoneyInput id={f.sample} cents={sample} onChange={setSample} />
                </div>
              </div>
              {!schedule.ok ? (
                <p className="text-xs text-slate-500">Fix the steps to see the schedule.</p>
              ) : preview.length === 0 ? (
                <p className="text-xs text-slate-500">No payments scheduled.</p>
              ) : (
                <table className="w-full text-xs">
                  <caption className="sr-only">Curtailment schedule preview</caption>
                  <thead>
                    <tr className="text-caption uppercase tracking-caps text-slate-500">
                      <th scope="col" className="pb-1 text-left font-medium">Due</th>
                      <th scope="col" className="pb-1 text-right font-medium">Pay</th>
                      <th scope="col" className="pb-1 text-right font-medium">Left owing</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50">
                    {preview.map((p) => {
                      cumulative += p.amountCents;
                      const left = (sample ?? 0) - cumulative;
                      return (
                        <tr key={p.sequence}>
                          <td className="py-1 font-mono tabular-nums text-slate-300">{dateLabel(p.dueDate)}</td>
                          <td className="py-1 text-right font-mono tabular-nums text-white">{money(p.amountCents)}</td>
                          <td className={clsx('py-1 text-right font-mono tabular-nums', left === 0 ? 'text-emerald-400' : 'text-slate-400')}>{money(left)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </fieldset>
        {error && <ErrorPanel error={error} compact />}
      </form>
    </Modal>
  );
}
