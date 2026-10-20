'use client';

/**
 * "Record earned incentive" — accrue an incentive under an ACTIVE program
 * (POST /api/dealer/incentives, incentiveAccrue). The preview runs the same pure
 * engine the server uses (engine/incentive incentiveAccrualPlan) so the person sees
 * the treatment's GL effect before it posts; the server's warnings[] are shown after.
 */

import { useEffect, useId, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { incentiveAccrualPlan } from '@/lib/dealer/engine/incentive';
import { initialUnitRoles } from '@/lib/dealer/roles';
import { PROGRAM_TYPE, TREATMENT, hintOf, labelOf } from '@/lib/dealer/ui/labels';
import { dateLabel, money, todayLocal } from '@/lib/dealer/ui/format';
import { addDaysIso, incentiveAccrualEffect, type IncentiveClaimRow, type OemProgramRecord } from '@/lib/dealer/ui/claims';
import type { LookupItem } from '@/lib/dealer/lookups';
import { dealerMutate, nameOf, useDealerQuery, useNames, type DealerApiError, type ListPage } from '../../_lib/use-dealer';
import { useDealerPack } from '../../_components/dealer-shell';
import { DateInput, Field, Modal, MoneyInput, Select, TextInput } from '../../_components/forms';
import { LookupPicker } from '../../_components/lookup-picker';
import { ErrorPanel, Notice } from '../../_components/ui';

/** dealer_unit_sales columns this picker reads (migration 169). */
interface SaleLite {
  id: string;
  unit_id: string;
  sale_date: string;
  sale_price_cents: number;
  status: 'PROPOSED' | 'POSTED' | 'VOID';
  external_deal_ref: string | null;
}

export function AccrueModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (row: IncentiveClaimRow) => void }) {
  const { settings, readiness, locationId } = useDealerPack();
  const programs = useDealerQuery<ListPage<OemProgramRecord>>(open ? '/api/dealer/oem-programs' : null, { status: 'ACTIVE', per_page: 100, sort: 'name', dir: 'asc' });
  const [programId, setProgramId] = useState('');
  const [unitId, setUnitId] = useState<string | null>(null);
  const [unitItem, setUnitItem] = useState<LookupItem | null>(null);
  const [saleId, setSaleId] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [earned, setEarned] = useState(todayLocal());
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<DealerApiError | null>(null);
  const [pendingWarnings, setPendingWarnings] = useState<string[]>([]);
  const sales = useDealerQuery<ListPage<SaleLite>>(open && unitId ? '/api/dealer/sales' : null, { unit_id: unitId, per_page: 10 });
  const id = useId();

  useEffect(() => {
    if (!open) return;
    setProgramId('');
    setUnitId(null);
    setUnitItem(null);
    setSaleId('');
    setAmount(null);
    setEarned(todayLocal());
    setRef('');
    setTouched(false);
    setError(null);
  }, [open]);

  const liveSales = (sales.data?.rows ?? []).filter((s) => s.status !== 'VOID');
  useEffect(() => {
    if (liveSales.length === 1) setSaleId(liveSales[0].id);
    if (!unitId) setSaleId('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitId, liveSales.map((s) => s.id).join(',')]);

  const rows = programs.data?.rows ?? [];
  const vendors = useNames('vendors', rows.map((p) => p.oem_vendor_id));
  const program = rows.find((p) => p.id === programId) ?? null;
  const coOpMapped = !!readiness?.roles.find((r) => r.roleKey === 'CO_OP_ADVERTISING_RECOVERY')?.accountId;
  const unitStatus = (unitItem?.meta?.status as string | undefined) ?? null;
  const unitCondition = (unitItem?.meta?.condition as string | undefined) ?? 'NEW';

  const preview = useMemo(() => {
    if (!program || amount === null || amount <= 0) return null;
    try {
      const r = incentiveAccrualPlan({
        treatment: program.treatment,
        programType: program.program_type,
        paidDirect: program.paid_direct,
        amountCents: amount,
        unit: unitId ? { inventoryRole: initialUnitRoles(unitCondition).inventoryRole, condition: unitCondition, sold: unitStatus === 'SOLD' || unitStatus === 'DELIVERED' } : null,
        costReductionInStock: settings?.cost_reduction_in_stock ?? 'REDUCE_UNIT_COST',
        coOpRoleMapped: coOpMapped,
        memo: '',
      });
      return { ok: true as const, text: incentiveAccrualEffect({ targetRole: r.targetRole, amountCents: amount, unitCostReductionCents: r.unitCostReductionCents }), warnings: r.warnings };
    } catch (e) {
      return { ok: false as const, text: (e as Error).message, warnings: [] as string[] };
    }
  }, [program, amount, unitId, unitCondition, unitStatus, settings?.cost_reduction_in_stock, coOpMapped]);

  const errors = {
    program: !programId ? 'Choose an active program' : program && (program.paid_direct || program.treatment === 'TRANSACTION_PRICE') ? 'This program can’t be accrued here (see below)' : null,
    amount: amount === null ? 'Enter the amount earned' : amount <= 0 ? 'Must be more than $0.00' : null,
    earned: /^\d{4}-\d{2}-\d{2}$/.test(earned) ? null : 'Choose the date it was earned',
  };
  const valid = !errors.program && !errors.amount && !errors.earned && (!preview || preview.ok);

  async function save() {
    setTouched(true);
    if (!valid || !locationId) return;
    setBusy(true);
    setError(null);
    const res = await dealerMutate<{ claim: IncentiveClaimRow; warnings: string[] }>(
      'post',
      '/api/dealer/incentives',
      locationId,
      { programId, unitId, saleId: saleId || null, amountCents: amount, earnedDate: earned, claimReference: ref.trim() || null },
      `Incentive of ${money(amount)} recorded`,
    );
    setBusy(false);
    if (res.error || !res.data) return setError(res.error);
    onSaved(res.data.claim);
    onClose();
    // The server's notes (e.g. co-op account unmapped → treated as a cost reduction).
    if (res.data.warnings.length) setPendingWarnings(res.data.warnings);
  }

  return (
    <>
      <Modal
        open={open}
        onClose={busy ? () => undefined : onClose}
        width="lg"
        title="Record earned incentive"
        description="Books what the manufacturer owes under one of this client’s approved programs."
        footer={
          <>
            <button type="button" className="btn-secondary btn-sm" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn-primary btn-sm" disabled={busy || (touched && !valid)} onClick={() => void save()}>
              {busy && <Loader2 size={13} className="animate-spin" />}
              Record {amount ? money(amount) : 'incentive'}
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
          <Field label="Program" htmlFor={`${id}-p`} required error={touched ? errors.program : null} hint={programs.data && rows.length === 0 ? undefined : 'Only approved (active) programs are listed'}>
            {programs.error ? (
              <ErrorPanel error={programs.error} onRetry={() => void programs.refetch()} compact />
            ) : (
              <Select<string>
                id={`${id}-p`}
                value={programId}
                onChange={setProgramId}
                placeholder={programs.isLoading ? 'Loading programs…' : rows.length === 0 ? 'No active programs — approve one on the Programs tab' : 'Choose a program…'}
                options={rows.map((p) => ({ value: p.id, label: `${p.name}${p.program_code ? ` (${p.program_code})` : ''} — ${nameOf(vendors, p.oem_vendor_id)}` }))}
              />
            )}
          </Field>
          {program && (
            <div className="rounded-lg border border-slate-800 bg-surface-950 px-3 py-2 text-xs text-slate-400">
              <p>
                <span className="text-slate-200">{labelOf(PROGRAM_TYPE, program.program_type)}</span> · {labelOf(TREATMENT, program.treatment)}
              </p>
              <p className="mt-0.5">{hintOf(TREATMENT, program.treatment)}</p>
              {program.treatment === 'TRANSACTION_PRICE' && <p className="mt-1 text-amber-300">Retail rebates are recorded on the unit sale (the deal), not accrued here.</p>}
              {program.paid_direct && <p className="mt-1 text-amber-300">The manufacturer pays this program directly — it creates no dealer entry.</p>}
              {program.claim_deadline_days != null && /^\d{4}-\d{2}-\d{2}$/.test(earned) && (
                <p className="mt-1">
                  Claim deadline: <span className="font-mono tabular-nums text-slate-200">{dateLabel(addDaysIso(earned, program.claim_deadline_days))}</span> ({program.claim_deadline_days} days after earning)
                </p>
              )}
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <Field label="Unit" htmlFor={`${id}-u`} hint="Optional — a dealer rebate on a unit adjusts that unit’s cost">
              <LookupPicker
                id={`${id}-u`}
                kind="units"
                value={unitId}
                onChange={(v, item) => {
                  setUnitId(v);
                  setUnitItem(item);
                }}
                placeholder="Search serial or stock #…"
              />
            </Field>
            <Field label="Sale" htmlFor={`${id}-s`} hint={unitId ? (sales.isLoading ? 'Looking up the unit’s sale…' : liveSales.length === 0 ? 'This unit has no recorded sale' : undefined) : 'Pick a unit to link its sale'}>
              <Select<string>
                id={`${id}-s`}
                value={saleId}
                onChange={setSaleId}
                disabled={!unitId || liveSales.length === 0}
                placeholder="No sale"
                options={liveSales.map((s) => ({ value: s.id, label: `${dateLabel(s.sale_date)} · ${money(s.sale_price_cents)}${s.external_deal_ref ? ` · ${s.external_deal_ref}` : ''}${s.status === 'PROPOSED' ? ' (not posted)' : ''}` }))}
              />
            </Field>
            <Field label="Amount earned" htmlFor={`${id}-a`} required error={touched ? errors.amount : null}>
              <MoneyInput id={`${id}-a`} cents={amount} onChange={setAmount} />
            </Field>
            <Field label="Earned on" htmlFor={`${id}-e`} required error={touched ? errors.earned : null}>
              <DateInput id={`${id}-e`} value={earned} onChange={setEarned} />
            </Field>
            <div className="col-span-2">
              <Field label="Claim reference" htmlFor={`${id}-r`} hint="The manufacturer’s number if you have it — statement credits are matched by it">
                <TextInput id={`${id}-r`} value={ref} onChange={setRef} maxLength={100} className="font-mono" />
              </Field>
            </div>
          </div>
          {preview && (
            <p className={`rounded-lg border px-3 py-2 text-xs ${preview.ok ? 'border-slate-800 bg-surface-950 text-slate-300' : 'border-amber-500/30 bg-amber-500/[0.05] text-amber-200'}`}>
              <span className="font-medium text-slate-200">{preview.ok ? 'What this posts: ' : 'Can’t record this: '}</span>
              {preview.text}
              {preview.warnings.map((w) => (
                <span key={w} className="mt-1 block text-amber-300">
                  {w}
                </span>
              ))}
            </p>
          )}
          {unitId && preview?.ok && <p className="text-2xs text-slate-500">Preview assumes the unit’s current inventory account; the server confirms.</p>}
          {error && <ErrorPanel error={error} compact />}
          <button type="submit" hidden aria-hidden tabIndex={-1} />
        </form>
      </Modal>
      {pendingWarnings.length > 0 && (
        <Modal open onClose={() => setPendingWarnings([])} width="sm" title="Recorded — with a note" footer={<button type="button" className="btn-primary btn-sm" onClick={() => setPendingWarnings([])}>Got it</button>}>
          <Notice tone="warning">
            {pendingWarnings.map((w) => (
              <p key={w}>{w}</p>
            ))}
          </Notice>
        </Modal>
      )}
    </>
  );
}
