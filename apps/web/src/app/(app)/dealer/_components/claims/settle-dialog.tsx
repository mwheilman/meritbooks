'use client';

/**
 * "Record payment" for a warranty or incentive claim — a manufacturer statement
 * credit or a check / ACH. Shows exactly what will post before anything does.
 * POST /api/dealer/warranty/settle | /api/dealer/incentives/settle (claimSettle).
 */

import { useEffect, useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { SETTLEMENT_METHOD, hintOf } from '@/lib/dealer/ui/labels';
import { money, todayLocal } from '@/lib/dealer/ui/format';
import { settlementEffect } from '@/lib/dealer/ui/claims';
import type { OemSettlementMethod } from '@/lib/dealer/types';
import { dealerMutate, type DealerApiError } from '../../_lib/use-dealer';
import { DateInput, Field, Modal, MoneyInput, Select, TextInput } from '../forms';
import { ErrorPanel } from '../ui';

const METHODS: OemSettlementMethod[] = ['STATEMENT_CREDIT', 'CASH'];

export function SettleDialog({
  open,
  onClose,
  kind,
  claimId,
  claimLabel,
  openCents,
  defaultMethod,
  manufacturer,
  locationId,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  kind: 'warranty' | 'incentive';
  claimId: string;
  claimLabel: string;
  openCents: number;
  defaultMethod: OemSettlementMethod;
  manufacturer: string | null;
  locationId: string;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState<number | null>(openCents);
  const [method, setMethod] = useState<OemSettlementMethod>(defaultMethod);
  const [date, setDate] = useState(todayLocal());
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DealerApiError | null>(null);
  const ids = { amount: useId(), method: useId(), date: useId(), ref: useId() };

  useEffect(() => {
    if (!open) return;
    setAmount(openCents);
    setMethod(defaultMethod);
    setDate(todayLocal());
    setReference('');
    setError(null);
  }, [open, openCents, defaultMethod]);

  const amountError =
    amount === null ? 'Enter the amount the manufacturer paid' : amount <= 0 ? 'Must be more than $0.00' : amount > openCents ? `Only ${money(openCents)} is open on this claim` : null;
  const dateError = /^\d{4}-\d{2}-\d{2}$/.test(date) ? null : 'Choose the date';
  const valid = !amountError && !dateError;

  async function submit() {
    if (!valid || amount === null) return;
    setBusy(true);
    setError(null);
    const res = await dealerMutate(
      'post',
      kind === 'warranty' ? '/api/dealer/warranty/settle' : '/api/dealer/incentives/settle',
      locationId,
      { claimId, amountCents: amount, method, date, reference: reference.trim() || null },
      `Payment of ${money(amount)} recorded`,
    );
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    onDone();
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title="Record payment"
      description={`${claimLabel} · ${money(openCents)} open`}
      footer={
        <>
          <button type="button" className="btn-secondary btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary btn-sm" disabled={!valid || busy} onClick={() => void submit()}>
            {busy && <Loader2 size={13} className="animate-spin" />}
            Record {amount ? money(amount) : 'payment'}
          </button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="grid grid-cols-2 gap-4">
          <Field label="Amount paid" htmlFor={ids.amount} required error={amountError}hint="Defaults to everything open">
            <MoneyInput id={ids.amount} cents={amount} onChange={setAmount} invalid={!!amountError} />
          </Field>
          <Field label="Date" htmlFor={ids.date} required error={dateError}>
            <DateInput id={ids.date} value={date} onChange={setDate} />
          </Field>
        </div>
        <Field label="How it was paid" htmlFor={ids.method} hint={hintOf(SETTLEMENT_METHOD, method)?.replace(/\s*\(Default\)\s*$/, '')}>
          <Select<OemSettlementMethod>
            id={ids.method}
            value={method}
            onChange={setMethod}
            options={METHODS.map((m) => ({ value: m, label: `${SETTLEMENT_METHOD[m].label}${m === defaultMethod ? ' (this client’s default)' : ''}` }))}
          />
        </Field>
        <Field label="Reference" htmlFor={ids.ref} hint="Check number, ACH trace or statement reference (optional)">
          <TextInput id={ids.ref} value={reference} onChange={setReference} maxLength={200} />
        </Field>
        {amount !== null && amount > 0 && amount <= openCents && (
          <p className="rounded-lg border border-slate-800 bg-surface-950 px-3 py-2 text-xs text-slate-300">
            <span className="font-medium text-slate-200">What this posts: </span>
            {settlementEffect({ receivable: kind, amountCents: amount, openCents, method, manufacturer })}
          </p>
        )}
        {error && <ErrorPanel error={error} compact />}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}
