'use client';

/**
 * Add / edit a floor-plan line (lender, credit limit, payable account override,
 * payment/statement days, the lender's sold-and-unpaid audit codes, status).
 * Validated client-side to match `lineCreate` / `lineUpdate`.
 */

import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { Loader2, X } from 'lucide-react';
import type { LineStatus } from '@/lib/dealer/types';
import { LINE_STATUS } from '@/lib/dealer/ui/labels';
import { fieldErrors, type DealerApiError } from '@/lib/dealer/ui/errors';
import { dealerMutate } from '../../_lib/use-dealer';
import { Field, Modal, MoneyInput, Select, TextArea, TextInput } from '../../_components/forms';
import { LookupPicker } from '../../_components/lookup-picker';
import { ErrorPanel } from '../../_components/ui';
import { validateLine, type LineDraft } from '../_lib/forms';
import type { FpLine } from '../_lib/types';

function draftFrom(l: FpLine | null): LineDraft {
  return {
    lenderVendorId: l?.lender_vendor_id ?? null,
    name: l?.name ?? '',
    creditLimitCents: l ? l.credit_limit_cents : null,
    liabilityAccountId: l?.liability_account_id ?? null,
    interestDueDay: l?.interest_due_day ? String(l.interest_due_day) : '',
    scheduledPaymentDay: l?.scheduled_payment_day ? String(l.scheduled_payment_day) : '',
    statementDay: l?.statement_day ? String(l.statement_day) : '',
    sauCodes: l?.sau_codes ?? [],
    status: l?.status ?? 'ACTIVE',
    notes: l?.notes ?? '',
  };
}

export function LineFormModal({ open, onClose, line, locationId, onSaved }: { open: boolean; onClose: () => void; line: FpLine | null; locationId: string; onSaved: () => void }) {
  const [v, setV] = useState<LineDraft>(draftFrom(line));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DealerApiError | null>(null);
  const [codeText, setCodeText] = useState('');
  const id = {
    lender: useId(),
    name: useId(),
    limit: useId(),
    acct: useId(),
    due: useId(),
    pay: useId(),
    stmt: useId(),
    codes: useId(),
    status: useId(),
    notes: useId(),
  };

  useEffect(() => {
    if (open) {
      setV(draftFrom(line));
      setTouched(false);
      setError(null);
      setCodeText('');
    }
  }, [open, line]);

  const { body, errors } = validateLine(v);
  const server = fieldErrors(error);
  const err = (k: string) => (touched ? errors[k] ?? server[k] ?? null : server[k] ?? null);
  const set = <K extends keyof LineDraft>(k: K, val: LineDraft[K]) => setV((s) => ({ ...s, [k]: val }));

  function addCode() {
    const parts = codeText.split(/[\s,]+/).map((c) => c.trim().toUpperCase()).filter(Boolean);
    if (!parts.length) return;
    set('sauCodes', [...new Set([...v.sauCodes, ...parts])]);
    setCodeText('');
  }
  function onCodeKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addCode();
    } else if (e.key === 'Backspace' && codeText === '' && v.sauCodes.length) {
      set('sauCodes', v.sauCodes.slice(0, -1));
    }
  }

  async function save() {
    setTouched(true);
    if (!body) return;
    setBusy(true);
    setError(null);
    const res = line
      ? await dealerMutate('patch', '/api/dealer/lines', locationId, { id: line.id, ...body }, 'Line saved')
      : await dealerMutate('post', '/api/dealer/lines', locationId, { ...body }, 'Line added');
    setBusy(false);
    if (res.error) setError(res.error);
    else {
      onSaved();
      onClose();
    }
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title={line ? `Edit ${line.name}` : 'Add a floor-plan line'}
      description="One line per lender credit facility. Programs (rates, free floor, curtailments) sit under the line."
      width="lg"
      footer={
        <>
          <button type="button" className="btn-secondary btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary btn-sm inline-flex items-center gap-1.5" onClick={() => void save()} disabled={busy}>
            {busy && <Loader2 size={13} className="animate-spin" />}
            {line ? 'Save line' : 'Add line'}
          </button>
        </>
      }
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="space-y-4"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Lender" htmlFor={id.lender} required error={err('lenderVendorId')} hint="The lender is a vendor in Books.">
            <LookupPicker id={id.lender} kind="vendors" value={v.lenderVendorId} onChange={(x) => set('lenderVendorId', x)} invalid={!!err('lenderVendorId')} placeholder="Choose the lender" />
          </Field>
          <Field label="Line name" htmlFor={id.name} required error={err('name')}>
            <TextInput id={id.name} value={v.name} onChange={(x) => set('name', x)} maxLength={200} invalid={!!err('name')} placeholder="For example: Wholegoods line" />
          </Field>
          <Field label="Credit limit" htmlFor={id.limit} required error={err('creditLimitCents')}>
            <MoneyInput id={id.limit} cents={v.creditLimitCents} onChange={(x) => set('creditLimitCents', x)} invalid={!!err('creditLimitCents')} />
          </Field>
          <Field label="Status" htmlFor={id.status}>
            <Select<LineStatus>
              id={id.status}
              value={v.status}
              onChange={(x) => set('status', x)}
              options={(Object.keys(LINE_STATUS) as LineStatus[]).map((k) => ({ value: k, label: LINE_STATUS[k].label }))}
            />
          </Field>
        </div>
        <Field
          label="Payable account for this line"
          htmlFor={id.acct}
          error={err('liabilityAccountId')}
          hint="Leave blank to use the client’s floor plan payable account. Can’t change after the line has postings."
        >
          <LookupPicker id={id.acct} kind="accounts" types={['LIABILITY']} value={v.liabilityAccountId} onChange={(x) => set('liabilityAccountId', x)} placeholder="Client default" />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Interest due day" htmlFor={id.due} error={err('interestDueDay')} hint="Day of the month (1–31).">
            <TextInput id={id.due} inputMode="numeric" value={v.interestDueDay} onChange={(x) => set('interestDueDay', x)} invalid={!!err('interestDueDay')} className="font-mono" />
          </Field>
          <Field label="Scheduled payment day" htmlFor={id.pay} error={err('scheduledPaymentDay')} hint="Open account / scheduled items.">
            <TextInput id={id.pay} inputMode="numeric" value={v.scheduledPaymentDay} onChange={(x) => set('scheduledPaymentDay', x)} invalid={!!err('scheduledPaymentDay')} className="font-mono" />
          </Field>
          <Field label="Statement day" htmlFor={id.stmt} error={err('statementDay')} hint="When the lender’s statement arrives.">
            <TextInput id={id.stmt} inputMode="numeric" value={v.statementDay} onChange={(x) => set('statementDay', x)} invalid={!!err('statementDay')} className="font-mono" />
          </Field>
        </div>
        <Field
          label="Sold-and-unpaid codes on floor checks"
          htmlFor={id.codes}
          error={err('sauCodes')}
          hint="The codes this lender prints on an audit for a unit it believes is sold and not paid off. Statement matching flags those lines and opens a “record the sale” task when Books still shows the unit in stock."
        >
          <div className="input flex min-h-[38px] flex-wrap items-center gap-1.5 py-1.5">
            {v.sauCodes.map((c) => (
              <span key={c} className="inline-flex items-center gap-1 rounded bg-slate-700/70 px-1.5 py-0.5 font-mono text-2xs text-slate-200">
                {c}
                <button type="button" aria-label={`Remove code ${c}`} onClick={() => set('sauCodes', v.sauCodes.filter((x) => x !== c))} className="text-slate-400 hover:text-white">
                  <X size={10} />
                </button>
              </span>
            ))}
            <input
              id={id.codes}
              value={codeText}
              onChange={(e) => setCodeText(e.target.value)}
              onKeyDown={onCodeKey}
              onBlur={addCode}
              maxLength={20}
              placeholder={v.sauCodes.length ? '' : 'Type a code, press Enter'}
              className="min-w-[120px] flex-1 bg-transparent font-mono text-sm text-slate-100 placeholder-slate-600 focus:outline-none"
            />
          </div>
        </Field>
        <Field label="Notes" htmlFor={id.notes} error={err('notes')}>
          <TextArea id={id.notes} value={v.notes} onChange={(x) => set('notes', x)} rows={2} maxLength={2000} />
        </Field>
        {error && <ErrorPanel error={error} compact />}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}
