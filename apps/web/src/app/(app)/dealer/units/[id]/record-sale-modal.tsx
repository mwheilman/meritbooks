'use client';

/**
 * Record a sale (deal) for a unit — POST /api/dealer/sales (schema `saleCreate`,
 * DEAL mode). Creates a PROPOSED deal; nothing posts until someone posts it from
 * the deal page. Live recap uses the D1 engine (deal-math → engine/sale.ts) so the
 * preview matches the posted deal to the cent (FPB §3.4, §3.5, DL-11).
 */

import { useEffect, useId, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api } from '@/lib/api-client';
import type { LookupItem } from '@/lib/dealer/lookups';
import type { DealerSettings } from '@/lib/dealer/types';
import { fieldErrors } from '@/lib/dealer/ui/errors';
import { dateLabel, money, todayLocal } from '@/lib/dealer/ui/format';
import { dealRecap, tradeNeedsApproval } from '@/lib/dealer/ui/deal-math';
import type { SaleView, TradeView, UnitView } from '@/lib/dealer/ui/unit-deal-types';
import { DealRecapView } from '../../deals/_components/deal-recap';
import { DateInput, Field, Modal, MoneyInput, Select, TextInput, Toggle } from '../../_components/forms';
import { LookupPicker } from '../../_components/lookup-picker';
import { Notice } from '../../_components/ui';
import { dealerMutate } from '../../_lib/use-dealer';

interface DepositOption {
  id: string;
  deposit_date: string;
  remainingCents: number;
  status: string;
  memo: string | null;
}

interface Form {
  customerId: string | null;
  saleDate: string;
  priceCents: number | null;
  taxCents: number | null;
  depositId: string;
  depositCents: number | null;
  rebateCents: number | null;
  rebateProgramId: string | null;
  hasTrade: boolean;
  tradeSerial: string;
  tradeMakeId: string | null;
  tradeModel: string;
  tradeYear: string;
  allowanceCents: number | null;
  acvCents: number | null;
  lienCents: number | null;
  lienholderId: string | null;
  salesperson: string;
  dealRef: string;
}

const blank = (): Form => ({
  customerId: null,
  saleDate: todayLocal(),
  priceCents: null,
  taxCents: null,
  depositId: '',
  depositCents: null,
  rebateCents: null,
  rebateProgramId: null,
  hasTrade: false,
  tradeSerial: '',
  tradeMakeId: null,
  tradeModel: '',
  tradeYear: '',
  allowanceCents: null,
  acvCents: null,
  lienCents: null,
  lienholderId: null,
  salesperson: '',
  dealRef: '',
});

const z0 = (c: number | null) => c ?? 0;

function useCustomerDeposits(locationId: string, customerId: string | null) {
  const [items, setItems] = useState<DepositOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!customerId) {
      setItems([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    void api.get<{ data: DepositOption[] }>('/api/customer-deposits', { customer_id: customerId, location_id: locationId }).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (res.error) {
        setFailed(true);
        setItems([]);
        return;
      }
      setItems((res.data?.data ?? []).filter((d) => d.remainingCents > 0 && (d.status === 'HELD' || d.status === 'PARTIALLY_APPLIED')));
    });
    return () => {
      cancelled = true;
    };
  }, [locationId, customerId]);
  return { items, loading, failed };
}

export function RecordSaleModal({
  open,
  onClose,
  locationId,
  unit,
  settings,
  proposedCostCount,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  locationId: string;
  unit: UnitView;
  settings: DealerSettings | null;
  proposedCostCount: number;
  onCreated: (sale: SaleView, trade: TradeView | null) => void;
}) {
  const [f, setF] = useState<Form>(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const id = useId();
  const deposits = useCustomerDeposits(locationId, f.customerId);
  const policy = settings?.trade_valuation_policy ?? 'LOWER_OF_ACV_AND_ALLOWANCE';
  const warnBps = settings?.over_allowance_warn_bps ?? 2000;

  useEffect(() => {
    if (open) {
      setF(blank());
      setErrors({});
    }
  }, [open]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));

  const deposit = deposits.items.find((d) => d.id === f.depositId) ?? null;
  const recap = useMemo(
    () =>
      dealRecap(
        {
          salePriceCents: z0(f.priceCents),
          taxCents: z0(f.taxCents),
          retailRebateCents: z0(f.rebateCents),
          depositAppliedCents: deposit ? z0(f.depositCents) : 0,
          unitCostCents: unit.cost_cents,
          trade: f.hasTrade ? { allowanceCents: z0(f.allowanceCents), acvCents: z0(f.acvCents), lienPayoffCents: z0(f.lienCents) } : null,
        },
        policy,
        warnBps,
      ),
    [f, deposit, unit.cost_cents, policy, warnBps],
  );

  function validate(): Record<string, string> {
    const e: Record<string, string> = {};
    if (!f.customerId) e.customerId = 'Choose the customer — the Books invoice is created for them';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.saleDate)) e.saleDate = 'Sale date is required';
    if (f.priceCents === null) e.salePriceCents = 'Enter the sale price';
    if (z0(f.rebateCents) > 0 && !f.rebateProgramId) e.retailRebateProgramId = 'Choose the manufacturer program the rebate comes from';
    if (f.hasTrade) {
      if (!f.tradeSerial.trim()) e.tradeSerial = 'Serial of the trade-in is required';
      if (f.allowanceCents === null) e.allowanceCents = 'Enter the allowance given';
      if (f.acvCents === null) e.acvCents = 'Enter the appraised value';
      if (z0(f.lienCents) > 0 && !f.lienholderId) e.lienholderId = 'Who holds the lien?';
      if (f.tradeYear.trim() && !/^\d{4}$/.test(f.tradeYear.trim())) e.tradeYear = 'Use a 4-digit year';
    }
    if (deposit) {
      const amt = z0(f.depositCents);
      if (amt <= 0) e.depositAppliedCents = 'Enter how much of the deposit to apply';
      else if (amt > deposit.remainingCents) e.depositAppliedCents = `Only ${money(deposit.remainingCents)} is left on this deposit`;
      else if (amt > recap.receivableCents) e.depositAppliedCents = 'More than the customer owes on this deal';
    }
    if (recap.receivableCents < 0) e.salePriceCents = 'The trade allowance and rebate are more than the price plus tax';
    return e;
  }

  async function submit() {
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    const res = await dealerMutate<{ sale: SaleView; trade: TradeView | null }>(
      'post',
      '/api/dealer/sales',
      locationId,
      {
        unitId: unit.id,
        customerId: f.customerId,
        saleDate: f.saleDate,
        salePriceCents: z0(f.priceCents),
        taxCents: z0(f.taxCents),
        depositId: deposit ? deposit.id : null,
        depositAppliedCents: deposit ? z0(f.depositCents) : 0,
        retailRebateCents: z0(f.rebateCents),
        retailRebateProgramId: z0(f.rebateCents) > 0 ? f.rebateProgramId : null,
        trade: f.hasTrade
          ? {
              serialNumber: f.tradeSerial.trim(),
              makeVendorId: f.tradeMakeId,
              model: f.tradeModel.trim() || null,
              modelYear: f.tradeYear.trim() ? Number(f.tradeYear) : null,
              allowanceCents: z0(f.allowanceCents),
              acvCents: z0(f.acvCents),
              lienPayoffCents: z0(f.lienCents),
              lienholderVendorId: z0(f.lienCents) > 0 ? f.lienholderId : null,
            }
          : null,
        salesperson: f.salesperson.trim() || null,
        externalDealRef: f.dealRef.trim() || null,
        source: 'BOOKS',
      },
      'Deal recorded — review and post it',
    );
    setBusy(false);
    if (res.error) {
      setErrors(fieldErrors(res.error));
      return;
    }
    if (res.data) onCreated(res.data.sale, res.data.trade);
  }

  const needsApproval = f.hasTrade && f.acvCents !== null && tradeNeedsApproval(f.acvCents, settings?.trade_acv_approval_threshold_cents ?? 0);
  const rebateFilter = (it: LookupItem) => it.meta?.treatment === 'TRANSACTION_PRICE' && it.meta?.status === 'ACTIVE';

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title={`Record a sale — S/N ${unit.serial_number}`}
      description="Records the deal for review. Nothing posts until it’s posted from the deal page."
      width="xl"
      footer={
        <>
          <button type="button" className="btn-secondary btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary btn-sm inline-flex items-center gap-1.5" onClick={() => void submit()} disabled={busy}>
            {busy && <Loader2 size={13} className="animate-spin" />}
            Record deal
          </button>
        </>
      }
    >
      {proposedCostCount > 0 && (
        <Notice tone="warning">
          This unit has {proposedCostCount} cost{proposedCostCount === 1 ? '' : 's'} waiting to be posted. You can record the deal now, but it can’t
          post until those are posted or voided.
        </Notice>
      )}
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <legend className="sr-only">Sale</legend>
            <div className="sm:col-span-2">
              <Field label="Customer" htmlFor={`${id}-cust`} required error={errors.customerId}>
                <LookupPicker
                  id={`${id}-cust`}
                  kind="customers"
                  value={f.customerId}
                  onChange={(v) => {
                    set('customerId', v);
                    set('depositId', '');
                    set('depositCents', null);
                  }}
                  invalid={!!errors.customerId}
                  placeholder="Choose a customer…"
                />
              </Field>
            </div>
            <Field label="Sale date" htmlFor={`${id}-date`} required error={errors.saleDate}>
              <DateInput id={`${id}-date`} value={f.saleDate} onChange={(v) => set('saleDate', v)} invalid={!!errors.saleDate} />
            </Field>
            <Field label="Sale price" htmlFor={`${id}-price`} required error={errors.salePriceCents}>
              <MoneyInput id={`${id}-price`} cents={f.priceCents} onChange={(c) => set('priceCents', c)} invalid={!!errors.salePriceCents} />
            </Field>
            <Field label="Sales tax" htmlFor={`${id}-tax`} hint="Leave blank if tax is handled elsewhere." error={errors.taxCents}>
              <MoneyInput id={`${id}-tax`} cents={f.taxCents} onChange={(c) => set('taxCents', c)} />
            </Field>
            <Field label="Salesperson" htmlFor={`${id}-sp`}>
              <TextInput id={`${id}-sp`} value={f.salesperson} onChange={(v) => set('salesperson', v)} maxLength={200} />
            </Field>
            <Field label="Deal number in the dealer system" htmlFor={`${id}-ref`} hint="Optional — stops the same deal being imported twice.">
              <TextInput id={`${id}-ref`} value={f.dealRef} onChange={(v) => set('dealRef', v)} className="font-mono" maxLength={200} />
            </Field>
          </fieldset>

          <fieldset className="rounded-lg border border-slate-800 p-4">
            <legend className="px-1 text-label text-slate-300">Customer deposit</legend>
            {!f.customerId ? (
              <p className="text-xs text-slate-500">Choose the customer to see deposits they’ve paid.</p>
            ) : deposits.loading ? (
              <p className="text-xs text-slate-500" role="status">Looking up deposits…</p>
            ) : deposits.failed ? (
              <p className="text-xs text-amber-300">Deposits couldn’t be loaded — record the deal without one and apply the deposit from Customer deposits.</p>
            ) : deposits.items.length === 0 ? (
              <p className="text-xs text-slate-500">This customer has no unapplied deposit.</p>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Deposit" htmlFor={`${id}-dep`}>
                  <Select<string>
                    id={`${id}-dep`}
                    value={f.depositId}
                    onChange={(v) => {
                      set('depositId', v);
                      const d = deposits.items.find((x) => x.id === v);
                      set('depositCents', d ? Math.min(d.remainingCents, Math.max(0, recap.receivableCents)) : null);
                    }}
                    placeholder="Don’t apply a deposit"
                    options={deposits.items.map((d) => ({ value: d.id, label: `${dateLabel(d.deposit_date)} — ${money(d.remainingCents)} left` }))}
                  />
                </Field>
                {deposit && (
                  <Field label="Apply" htmlFor={`${id}-depamt`} required error={errors.depositAppliedCents}>
                    <MoneyInput id={`${id}-depamt`} cents={f.depositCents} onChange={(c) => set('depositCents', c)} invalid={!!errors.depositAppliedCents} />
                  </Field>
                )}
              </div>
            )}
          </fieldset>

          <fieldset className="rounded-lg border border-slate-800 p-4">
            <legend className="px-1 text-label text-slate-300">Manufacturer retail rebate</legend>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Rebate amount" htmlFor={`${id}-reb`} hint="Paid by the manufacturer toward the customer’s price.">
                <MoneyInput id={`${id}-reb`} cents={f.rebateCents} onChange={(c) => set('rebateCents', c)} />
              </Field>
              <Field label="Program" htmlFor={`${id}-prog`} required={z0(f.rebateCents) > 0} error={errors.retailRebateProgramId}>
                <LookupPicker
                  id={`${id}-prog`}
                  kind="oem_programs"
                  value={f.rebateProgramId}
                  onChange={(v) => set('rebateProgramId', v)}
                  filter={rebateFilter}
                  invalid={!!errors.retailRebateProgramId}
                  placeholder="Active retail-rebate programs"
                  disabled={z0(f.rebateCents) === 0}
                />
              </Field>
            </div>
          </fieldset>

          <fieldset className="rounded-lg border border-slate-800 p-4">
            <legend className="sr-only">Trade-in</legend>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-label text-slate-300">Trade-in</p>
                <p className="text-xs text-slate-500">The customer’s unit taken in part payment.</p>
              </div>
              <Toggle id={`${id}-trade`} checked={f.hasTrade} onChange={(v) => set('hasTrade', v)} label="Deal includes a trade-in" />
            </div>
            {f.hasTrade && (
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Trade serial number" htmlFor={`${id}-tsn`} required error={errors.tradeSerial}>
                  <TextInput id={`${id}-tsn`} value={f.tradeSerial} onChange={(v) => set('tradeSerial', v)} className="font-mono" invalid={!!errors.tradeSerial} maxLength={100} />
                </Field>
                <Field label="Make" htmlFor={`${id}-tmk`}>
                  <LookupPicker id={`${id}-tmk`} kind="vendors" value={f.tradeMakeId} onChange={(v) => set('tradeMakeId', v)} placeholder="Manufacturer…" />
                </Field>
                <Field label="Model" htmlFor={`${id}-tmd`}>
                  <TextInput id={`${id}-tmd`} value={f.tradeModel} onChange={(v) => set('tradeModel', v)} maxLength={200} />
                </Field>
                <Field label="Year" htmlFor={`${id}-tyr`} error={errors.tradeYear}>
                  <TextInput id={`${id}-tyr`} value={f.tradeYear} onChange={(v) => set('tradeYear', v)} inputMode="numeric" className="font-mono" maxLength={4} invalid={!!errors.tradeYear} />
                </Field>
                <Field label="Allowance given" htmlFor={`${id}-alw`} required error={errors.allowanceCents} hint="What the customer was credited.">
                  <MoneyInput id={`${id}-alw`} cents={f.allowanceCents} onChange={(c) => set('allowanceCents', c)} invalid={!!errors.allowanceCents} />
                </Field>
                <Field label="Appraised value (ACV)" htmlFor={`${id}-acv`} required error={errors.acvCents} hint="What the trade is actually worth.">
                  <MoneyInput id={`${id}-acv`} cents={f.acvCents} onChange={(c) => set('acvCents', c)} invalid={!!errors.acvCents} />
                </Field>
                <Field label="Lien payoff" htmlFor={`${id}-lien`} hint="Still owed to the customer’s lender — the dealer pays it.">
                  <MoneyInput id={`${id}-lien`} cents={f.lienCents} onChange={(c) => set('lienCents', c)} />
                </Field>
                <Field label="Lienholder" htmlFor={`${id}-lh`} required={z0(f.lienCents) > 0} error={errors.lienholderId}>
                  <LookupPicker id={`${id}-lh`} kind="vendors" value={f.lienholderId} onChange={(v) => set('lienholderId', v)} invalid={!!errors.lienholderId} disabled={z0(f.lienCents) === 0} placeholder="The customer’s lender…" />
                </Field>
                {needsApproval && (
                  <p className="sm:col-span-2 text-xs text-slate-400">
                    A sales manager with approval rights must approve this appraisal on the deal page before the deal can post.
                  </p>
                )}
              </div>
            )}
          </fieldset>
          <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
        </form>

        <aside aria-label="Deal recap preview" className="rounded-lg border border-slate-800 bg-surface-950 p-4 lg:sticky lg:top-0 lg:self-start">
          <h3 className="mb-3 text-subheading text-white">Deal recap</h3>
          <DealRecapView
            salePriceCents={z0(f.priceCents)}
            taxCents={z0(f.taxCents)}
            retailRebateCents={z0(f.rebateCents)}
            depositAppliedCents={deposit ? z0(f.depositCents) : 0}
            allowanceCents={f.hasTrade ? z0(f.allowanceCents) : null}
            acvCents={f.hasTrade ? z0(f.acvCents) : null}
            unitCostCents={unit.cost_cents}
            policy={policy}
            recap={recap}
            overAllowanceWarnBps={warnBps}
            costIsEstimate={proposedCostCount > 0}
          />
        </aside>
      </div>
    </Modal>
  );
}
