'use client';

/** Wizard step 1 — what is being imported, and the context it needs (line, manufacturer…). */

import { useId } from 'react';
import { clsx } from 'clsx';
import { Banknote, Boxes, ClipboardList, Factory, FileSpreadsheet, Handshake, Rocket, ScrollText, Wrench, type LucideIcon } from 'lucide-react';
import type { ImportFileKind, UnitCondition } from '@/lib/dealer/types';
import { FILE_KIND, OEM_LINE_TYPE, UNIT_CONDITION } from '@/lib/dealer/ui/labels';
import { isLenderKind } from '@/lib/dealer/imports/fields';
import type { OemLineType } from '@/lib/dealer/imports/targets';
import { Field, Select, TextInput } from '../../_components/forms';
import { LookupPicker } from '../../_components/lookup-picker';
import { Notice } from '../../_components/ui';
import type { Setup } from '../_lib/wizard';

const KINDS: Array<{ kind: ImportFileKind; icon: LucideIcon; hint: string; ai: boolean }> = [
  { kind: 'UNITS', icon: Boxes, hint: 'A stock list from the dealer system: serial, model, cost, received date. Optionally floor the units on a line.', ai: true },
  { kind: 'DEALS', icon: Handshake, hint: 'Deal recaps / buyer’s orders with trade-ins and rebates. Units and customers must already be in Books.', ai: true },
  { kind: 'WARRANTY', icon: Wrench, hint: 'The warranty claim register (CSV or Excel).', ai: false },
  { kind: 'LENDER_STATEMENT', icon: Banknote, hint: 'The floor-plan lender’s monthly statement — PDF, Excel, CSV or the email body.', ai: true },
  { kind: 'LENDER_AUDIT', icon: ClipboardList, hint: 'A lender floor check (audit) report — lines must add up to its totals.', ai: true },
  { kind: 'OEM_STATEMENT', icon: Factory, hint: 'A manufacturer statement or credit memo: warranty and incentive credits, debits, parts.', ai: true },
  { kind: 'PROGRAMS', icon: ScrollText, hint: 'A manufacturer program bulletin — saved as draft programs for approval.', ai: true },
  { kind: 'OPENING', icon: Rocket, hint: 'Go-live: units in stock and what the lender is owed today. No journal entries — ties to the migrated trial balance.', ai: true },
];

const CONDITIONS = (Object.keys(UNIT_CONDITION) as UnitCondition[]).map((c) => ({ value: c, label: UNIT_CONDITION[c].label }));
const OEM_TYPES = (Object.keys(OEM_LINE_TYPE) as OemLineType[]).map((t) => ({ value: t, label: OEM_LINE_TYPE[t] }));

export function StepChoose({ setup, onChange, dmsSystem }: { setup: Setup; onChange: (s: Setup) => void; dmsSystem: string | null }) {
  const ids = { src: useId(), line: useId(), prog: useId(), oem: useId(), cond: useId(), type: useId(), rebate: useId() };
  const k = setup.kind;
  const set = (p: Partial<Setup>) => onChange({ ...setup, ...p });

  function pickKind(kind: ImportFileKind) {
    const dmsKind = kind === 'UNITS' || kind === 'DEALS' || kind === 'WARRANTY' || kind === 'OPENING';
    onChange({
      ...setup,
      kind,
      sourceSystem: dmsKind ? dmsSystem ?? setup.sourceSystem : setup.sourceSystem,
    });
  }

  return (
    <div className="space-y-6">
      <fieldset>
        <legend className="mb-3 text-label text-slate-300">What are you importing?</legend>
        <div role="radiogroup" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {KINDS.map(({ kind, icon: Icon, hint, ai }) => {
            const on = k === kind;
            return (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => pickKind(kind)}
                className={clsx(
                  'flex h-full flex-col items-start gap-2 rounded-lg border p-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60',
                  on ? 'border-emerald-500/60 bg-emerald-500/[0.06]' : 'border-slate-800 bg-surface-950 hover:border-slate-700',
                )}
              >
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-medium text-white">
                    <Icon size={15} className={on ? 'text-emerald-400' : 'text-slate-500'} />
                    {FILE_KIND[kind].label}
                  </span>
                  {ai && <span className="rounded-full bg-indigo-500/10 px-1.5 py-0.5 text-2xs text-indigo-300" title="The AI can read PDFs and images of this">AI</span>}
                </span>
                <span className="text-xs leading-relaxed text-slate-400">{hint}</span>
              </button>
            );
          })}
        </div>
      </fieldset>

      {k && (
        <div className="grid gap-4 md:grid-cols-2">
          {isLenderKind(k) && (
            <Field label="Floor-plan line" htmlFor={ids.line} required hint="The statement is reconciled against this line’s notes.">
              <LookupPicker
                id={ids.line}
                kind="lines"
                value={setup.lineId}
                onChange={(id, item) => set({ lineId: id, sourceSystem: setup.sourceSystem || item?.label || '' })}
                placeholder="Choose a line…"
              />
            </Field>
          )}
          {(k === 'UNITS' || k === 'OPENING') && (
            <>
              <Field
                label={k === 'OPENING' ? 'Floor-plan line for floored units' : 'Floor the units on a line (optional)'}
                htmlFor={ids.line}
                hint={k === 'OPENING' ? 'Rows with principal owed are loaded as opening notes on this line.' : 'Rows with a floored amount become proposed floorings on this line.'}
              >
                <LookupPicker id={ids.line} kind="lines" value={setup.lineId} onChange={(id) => set({ lineId: id, programId: null })} placeholder="No line — units only" />
              </Field>
              {setup.lineId && (
                <Field label="Floor-plan program (optional)" htmlFor={ids.prog} hint="Sets free-floor days, rate and curtailments for the new notes.">
                  <LookupPicker
                    id={ids.prog}
                    kind="programs"
                    value={setup.programId}
                    onChange={(id) => set({ programId: id })}
                    filter={(it) => it.meta?.lineId === setup.lineId && it.meta?.status === 'ACTIVE'}
                    placeholder="Line default"
                  />
                </Field>
              )}
              <Field label="When the new/used column is blank" htmlFor={ids.cond}>
                <Select<UnitCondition> id={ids.cond} value={setup.defaultCondition} onChange={(v) => set({ defaultCondition: v })} options={CONDITIONS} />
              </Field>
            </>
          )}
          {(k === 'WARRANTY' || k === 'OEM_STATEMENT' || k === 'PROGRAMS') && (
            <Field label="Manufacturer" htmlFor={ids.oem} required>
              <LookupPicker
                id={ids.oem}
                kind="vendors"
                value={setup.oemVendorId}
                onChange={(id, item) => set({ oemVendorId: id, sourceSystem: k === 'WARRANTY' ? setup.sourceSystem : setup.sourceSystem || item?.label || '' })}
                placeholder="Choose the manufacturer…"
              />
            </Field>
          )}
          {k === 'OEM_STATEMENT' && (
            <Field label="When a line has no type" htmlFor={ids.type} hint="Lines the file doesn’t type get this type.">
              <Select<OemLineType | ''>
                id={ids.type}
                value={setup.defaultOemLineType}
                onChange={(v) => set({ defaultOemLineType: v })}
                options={OEM_TYPES}
                placeholder="Leave as a problem to fix"
              />
            </Field>
          )}
          {k === 'DEALS' && (
            <Field label="Retail rebate program (optional)" htmlFor={ids.rebate} hint="Needed only when deals carry a manufacturer retail rebate.">
              <LookupPicker
                id={ids.rebate}
                kind="oem_programs"
                value={setup.retailRebateProgramId}
                onChange={(id) => set({ retailRebateProgramId: id })}
                filter={(it) => it.meta?.type === 'RETAIL_REBATE' && it.meta?.status === 'ACTIVE'}
                placeholder="No rebate program"
              />
            </Field>
          )}
          <Field label="Where the file comes from" htmlFor={ids.src} hint="Your saved column mapping is remembered per source.">
            <TextInput id={ids.src} value={setup.sourceSystem} onChange={(v) => set({ sourceSystem: v })} maxLength={100} placeholder="e.g. dealer system export, lender portal" />
          </Field>
        </div>
      )}

      {k === 'OPENING' && (
        <Notice tone="info">
          Opening balances create units and floor-plan notes <span className="font-medium text-white">without journal entries</span>. After the import, the
          tie-out on Settings must show no difference against the migrated trial balance before the pack can be switched on.
        </Notice>
      )}
      {k === 'DEALS' && (
        <Notice tone="info">
          <FileSpreadsheet size={13} className="mr-1 inline text-slate-400" />
          Every imported deal lands as a proposal; a trade’s ACV always needs a sales manager’s approval before the deal posts.
        </Notice>
      )}
    </div>
  );
}
