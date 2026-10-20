'use client';

/**
 * Accounting policies + thresholds (docs/dealer-pack-api.md §3). Every FPB "[U]
 * unverified" treatment is a per-client setting here, labelled in plain English with
 * its DEFAULT marked. Thresholds are typed in human units ($, %, days) and stored as
 * cents / basis points / days. Saves only the fields that changed (PUT /api/dealer/settings).
 */

import { useEffect, useId, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { Loader2, Plus, RotateCcw, X } from 'lucide-react';
import type { DealerSettings } from '@/lib/dealer/types';
import { COST_REDUCTION_POLICY, SETTLEMENT_METHOD, TRADE_POLICY, WARRANTY_RECOGNITION, type Labelled } from '@/lib/dealer/ui/labels';
import { fieldErrors } from '@/lib/dealer/ui/errors';
import {
  DEFAULTS,
  THRESHOLD_FIELDS,
  THRESHOLD_GROUPS,
  bucketLabels,
  editable,
  formatStored,
  fromDisplay,
  settingsDiff,
  toDisplay,
  validateBuckets,
  type EditableSettings,
  type NumericSettingKey,
  type ThresholdField,
} from '@/lib/dealer/ui/settings-form';
import { dealerMutate, type DealerApiError } from '../../_lib/use-dealer';
import { Field, TextInput, Toggle } from '../../_components/forms';
import { ErrorPanel, Section } from '../../_components/ui';

const stripDefault = (s?: string) => (s ?? '').replace(/\s*\(Default\)\s*$/, '');

export function PoliciesSection({ settings, locationId, onSaved }: { settings: DealerSettings; locationId: string; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState<EditableSettings>(editable(settings));
  const [texts, setTexts] = useState<Record<NumericSettingKey, string>>(() => textsFrom(settings));
  const [bucketText, setBucketText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DealerApiError | null>(null);

  // A fresh server copy (after save / refetch) resets the form.
  const serverKey = JSON.stringify(editable(settings));
  useEffect(() => {
    setDraft(editable(settings));
    setTexts(textsFrom(settings));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey]);

  const parsed = useMemo(() => {
    const errs: Partial<Record<NumericSettingKey, string>> = {};
    const values: Partial<Record<NumericSettingKey, number>> = {};
    for (const f of THRESHOLD_FIELDS) {
      const r = fromDisplay(f, texts[f.key]);
      if (r.ok) values[f.key] = r.value;
      else errs[f.key] = r.error;
    }
    return { errs, values };
  }, [texts]);
  const bucketError = validateBuckets(draft.aging_buckets);
  const merged: EditableSettings = { ...draft, ...parsed.values };
  const patch = settingsDiff(settings, merged);
  const changedCount = Object.keys(patch).length;
  const hasErrors = Object.keys(parsed.errs).length > 0 || !!bucketError;
  const server = fieldErrors(error);

  function set<K extends keyof EditableSettings>(k: K, v: EditableSettings[K]) {
    setDraft((d) => ({ ...d, [k]: v }));
  }

  async function save() {
    if (hasErrors || changedCount === 0) return;
    setBusy(true);
    setError(null);
    const res = await dealerMutate<DealerSettings>('put', '/api/dealer/settings', locationId, patch as Record<string, unknown>, `Saved ${changedCount} setting${changedCount === 1 ? '' : 's'}`);
    setBusy(false);
    if (res.error) return setError(res.error);
    await onSaved();
  }

  function discard() {
    setDraft(editable(settings));
    setTexts(textsFrom(settings));
    setError(null);
  }

  function addBucket() {
    const n = Number(bucketText.trim());
    if (!/^\d+$/.test(bucketText.trim()) || n < 1 || n > 3650) return;
    set('aging_buckets', [...new Set([...draft.aging_buckets, n])].sort((a, b) => a - b));
    setBucketText('');
  }

  return (
    <Section
      id="policies"
      className="scroll-mt-6"
      title="Accounting policies"
      description="How this client books the judgement calls, and when the pack warns. Defaults follow common dealer practice — change them only with the client’s accountant."
      actions={
        changedCount > 0 ? (
          <>
            <button type="button" className="btn-ghost btn-sm" onClick={discard} disabled={busy}>
              Discard
            </button>
            <button type="button" className="btn-primary btn-sm" onClick={() => void save()} disabled={busy || hasErrors}>
              {busy && <Loader2 size={13} className="animate-spin" />}
              Save {changedCount} change{changedCount === 1 ? '' : 's'}
            </button>
          </>
        ) : null
      }
    >
      <fieldset disabled={busy} className="divide-y divide-slate-800">
        {error && (
          <div className="px-5 py-4">
            <ErrorPanel error={error} compact />
          </div>
        )}

        <Choice<DealerSettings['trade_valuation_policy']>
          name="trade_valuation_policy"
          title="Trade-in valuation"
          question="What value does a traded-in unit go on the books at?"
          map={TRADE_POLICY}
          value={draft.trade_valuation_policy}
          def={DEFAULTS.trade_valuation_policy}
          onChange={(v) => set('trade_valuation_policy', v)}
          error={server.trade_valuation_policy}
        />
        <Choice<DealerSettings['warranty_recognition']>
          name="warranty_recognition"
          title="When warranty is booked"
          question="When does a warranty claim become a receivable?"
          map={WARRANTY_RECOGNITION}
          value={draft.warranty_recognition}
          def={DEFAULTS.warranty_recognition}
          onChange={(v) => set('warranty_recognition', v)}
          error={server.warranty_recognition}
        />
        <Switch
          title="Relieve parts inventory on warranty claims"
          help="On: booking a warranty claim moves the parts used from parts inventory to parts cost of sales, at cost. Turn this off if the dealer system’s parts ticket already relieved them — otherwise the parts would be taken out of inventory twice."
          checked={draft.warranty_relieve_parts_inventory}
          def={DEFAULTS.warranty_relieve_parts_inventory}
          onChange={(v) => set('warranty_relieve_parts_inventory', v)}
        />
        <Switch
          title="Add setup / pre-delivery labor to the unit’s cost"
          help="On: setup labor from an internal repair order is added to the unit at the repair order’s actual cost — never an overhead or burden rate — and expensed when the unit sells. Off: setup labor stays in wages. Needs the setup-labor account mapped above."
          checked={draft.capitalize_setup_labor}
          def={DEFAULTS.capitalize_setup_labor}
          onChange={(v) => set('capitalize_setup_labor', v)}
        />
        <Choice<DealerSettings['cost_reduction_in_stock']>
          name="cost_reduction_in_stock"
          title="Dealer rebates on units still in stock"
          question="When the manufacturer pays a rebate on a unit that hasn’t sold yet…"
          map={COST_REDUCTION_POLICY}
          value={draft.cost_reduction_in_stock}
          def={DEFAULTS.cost_reduction_in_stock}
          onChange={(v) => set('cost_reduction_in_stock', v)}
          error={server.cost_reduction_in_stock}
        />
        <Choice<DealerSettings['oem_settlement_default']>
          name="oem_settlement_default"
          title="How manufacturers usually pay claims"
          question="The default when recording a warranty or incentive payment (you can change it each time)."
          map={SETTLEMENT_METHOD}
          value={draft.oem_settlement_default}
          def={DEFAULTS.oem_settlement_default}
          onChange={(v) => set('oem_settlement_default', v)}
          error={server.oem_settlement_default}
        />
        <div className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] md:items-start">
          <div>
            <p className="text-sm text-slate-100">Dealer management system</p>
            <p className="mt-0.5 text-xs text-slate-500">The system the store runs on — used to label imports. Default: not set.</p>
          </div>
          <Field label="System name" htmlFor="dms_system" error={server.dms_system}>
            <TextInput id="dms_system" value={draft.dms_system ?? ''} onChange={(v) => set('dms_system', v)} maxLength={100} placeholder="e.g. the vendor’s product name" />
          </Field>
        </div>

        <div className="px-5 py-4">
          <p className="text-sm text-slate-100">Unit aging buckets</p>
          <p className="mt-0.5 text-xs text-slate-500">
            Day edges for the unit-aging report and the home-page buckets. Default: {DEFAULTS.aging_buckets.join(', ')} days. Currently reads as {bucketLabels(draft.aging_buckets).join(' · ')}.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {draft.aging_buckets.map((b) => (
              <span key={b} className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-800/60 py-0.5 pl-2.5 pr-1 font-mono text-xs tabular-nums text-slate-200">
                {b}
                <button type="button" aria-label={`Remove ${b} days`} disabled={draft.aging_buckets.length <= 1} onClick={() => set('aging_buckets', draft.aging_buckets.filter((x) => x !== b))} className="rounded-full p-0.5 text-slate-500 hover:text-red-400 disabled:opacity-30">
                  <X size={11} />
                </button>
              </span>
            ))}
            <div className="flex items-center gap-1">
              <input
                aria-label="Add an aging edge (days)"
                inputMode="numeric"
                value={bucketText}
                onChange={(e) => setBucketText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addBucket();
                  }
                }}
                placeholder="Days"
                className="input w-20 py-1 text-right font-mono text-xs"
                disabled={draft.aging_buckets.length >= 8}
              />
              <button type="button" className="btn-ghost btn-sm" onClick={addBucket} disabled={draft.aging_buckets.length >= 8}>
                <Plus size={12} /> Add
              </button>
            </div>
            {!sameArr(draft.aging_buckets, DEFAULTS.aging_buckets) && (
              <button type="button" className="btn-ghost btn-sm text-slate-500" onClick={() => set('aging_buckets', [...DEFAULTS.aging_buckets])}>
                <RotateCcw size={12} /> Use default
              </button>
            )}
          </div>
          {bucketError && <p className="mt-2 text-xs text-red-400" role="alert">{bucketError}</p>}
        </div>

        {THRESHOLD_GROUPS.map((g) => (
          <div key={g} className="px-5 py-4">
            <h3 className="mb-3 text-caption uppercase tracking-caps text-slate-500">{g} — thresholds</h3>
            <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">
              {THRESHOLD_FIELDS.filter((f) => f.group === g).map((f) => (
                <Threshold
                  key={f.key}
                  field={f}
                  text={texts[f.key]}
                  error={parsed.errs[f.key] ?? server[f.key] ?? null}
                  dirty={parsed.values[f.key] !== undefined && parsed.values[f.key] !== settings[f.key]}
                  onChange={(v) => setTexts((t) => ({ ...t, [f.key]: v }))}
                  onReset={() => setTexts((t) => ({ ...t, [f.key]: toDisplay(f.unit, DEFAULTS[f.key]) }))}
                />
              ))}
            </div>
          </div>
        ))}

        <p className="px-5 py-4 text-xs text-slate-500">
          Two treatments are set per program, not here: each manufacturer program’s accounting treatment (Incentives → Programs) and each floor-plan program’s day count — Actual/365 by default (Floor plan → Setup).
        </p>
      </fieldset>
    </Section>
  );
}

function textsFrom(s: DealerSettings): Record<NumericSettingKey, string> {
  const out = {} as Record<NumericSettingKey, string>;
  for (const f of THRESHOLD_FIELDS) out[f.key] = toDisplay(f.unit, s[f.key]);
  return out;
}

function sameArr(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function Choice<V extends string>({
  name,
  title,
  question,
  map,
  value,
  def,
  onChange,
  error,
}: {
  name: string;
  title: string;
  question: string;
  map: Record<V, Labelled>;
  value: V;
  def: V;
  onChange: (v: V) => void;
  error?: string;
}) {
  const id = useId();
  return (
    <div className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] md:items-start">
      <div>
        <p id={`${id}-t`} className="text-sm text-slate-100">{title}</p>
        <p className="mt-0.5 text-xs text-slate-500">{question}</p>
        <p className="mt-1 text-xs text-slate-500">
          Default: <span className="text-slate-300">{map[def].label}</span>
        </p>
      </div>
      <div role="radiogroup" aria-labelledby={`${id}-t`} className="space-y-2">
        {(Object.keys(map) as V[]).map((k) => (
          <label key={k} className={clsx('flex cursor-pointer gap-3 rounded-lg border px-3 py-2', value === k ? 'border-emerald-500/50 bg-emerald-500/[0.04]' : 'border-slate-800 hover:border-slate-700')}>
            <input type="radio" name={name} value={k} checked={value === k} onChange={() => onChange(k)} className="mt-1 accent-emerald-500" />
            <span className="min-w-0">
              <span className="block text-sm text-slate-200">
                {map[k].label}
                {k === def && <span className="ml-2 text-2xs text-slate-500">Default</span>}
              </span>
              {map[k].hint && <span className="block text-xs text-slate-500">{stripDefault(map[k].hint)}</span>}
            </span>
          </label>
        ))}
        {error && <p className="text-xs text-red-400" role="alert">{error}</p>}
      </div>
    </div>
  );
}

function Switch({ title, help, checked, def, onChange }: { title: string; help: string; checked: boolean; def: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-6 px-5 py-4">
      <div className="max-w-2xl">
        <p className="text-sm text-slate-100">{title}</p>
        <p className="mt-0.5 text-xs text-slate-500">{help}</p>
        <p className="mt-1 text-xs text-slate-500">
          Default: <span className="text-slate-300">{def ? 'On' : 'Off'}</span>
        </p>
      </div>
      <div className="flex items-center gap-2 pt-0.5">
        <span className="text-xs text-slate-400">{checked ? 'On' : 'Off'}</span>
        <Toggle checked={checked} onChange={onChange} label={title} />
      </div>
    </div>
  );
}

function Threshold({ field, text, error, dirty, onChange, onReset }: { field: ThresholdField; text: string; error: string | null; dirty: boolean; onChange: (v: string) => void; onReset: () => void }) {
  const id = useId();
  const def = DEFAULTS[field.key];
  const atDefault = fromDisplay(field, text);
  const isDefault = atDefault.ok && atDefault.value === def;
  return (
    <Field
      label={field.label}
      htmlFor={id}
      error={error}
      hint={
        <>
          {field.help} <span className="text-slate-400">Default: {formatStored(field.unit, def)}.</span>
        </>
      }
    >
      <div className="flex items-center gap-2">
        <div className="relative w-40">
          {field.unit === 'dollars' && <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">$</span>}
          <TextInput
            id={id}
            inputMode="decimal"
            value={text}
            onChange={onChange}
            invalid={!!error}
            className={clsx('text-right font-mono tabular-nums', field.unit === 'dollars' && 'pl-6', field.unit !== 'dollars' && 'pr-12')}
          />
          {field.unit !== 'dollars' && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-500">{field.unit === 'percent' ? '%' : 'days'}</span>}
        </div>
        {dirty && <span className="text-2xs text-amber-300">Unsaved</span>}
        {!isDefault && (
          <button type="button" onClick={onReset} className="inline-flex items-center gap-1 text-2xs text-slate-500 hover:text-slate-300">
            <RotateCcw size={11} /> Default
          </button>
        )}
      </div>
    </Field>
  );
}
