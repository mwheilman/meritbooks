'use client';

import { useState } from 'react';
import { formatMoney } from '@meritbooks/shared';
import { Button, Dialog, Field, InlineNotice, Input, MoneyInput, Select } from '@meritbooks/merit-ui';
import type { InvoiceRow } from './invoice-types';
import s from './invoices.module.css';

// ─── Payment Application Dialog ───────────────────────────────────────

export function PaymentDialog({
  invoice,
  onClose,
  onPaid,
}: {
  invoice: InvoiceRow;
  onClose: () => void;
  onPaid: () => void;
}) {
  const [amountCents, setAmountCents] = useState(invoice.balanceCents);
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split('T')[0]);
  const [method, setMethod] = useState('CHECK');
  const [reference, setReference] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  const handleSubmit = async () => {
    if (amountCents <= 0) { setFormError('Amount must be positive'); return; }
    if (amountCents > invoice.balanceCents) { setFormError('Amount exceeds invoice balance'); return; }

    setSubmitting(true);
    setFormError('');
    try {
      const res = await fetch('/api/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_id: invoice.customer?.id,
          location_id: invoice.location?.id,
          payment_date: paymentDate,
          amount_cents: amountCents,
          payment_method: method,
          reference_number: reference || undefined,
          applications: [{ invoice_id: invoice.id, amount_cents: amountCents }],
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        setFormError(err.error ?? 'Failed to apply payment');
        return;
      }
      onPaid();
    } catch {
      setFormError('Network error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      onClose={() => { if (!submitting) onClose(); }}
      title="Receive payment"
      width={520}
      dismissOnScrim={!submitting}
      footNote={`Invoice ${invoice.invoiceNumber}${invoice.customer?.name ? ` · ${invoice.customer.name}` : ''}`}
      actions={
        <>
          <Button onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button variant="primary" onClick={() => void handleSubmit()} disabled={submitting} aria-busy={submitting || undefined}>
            {submitting ? 'Applying…' : 'Apply payment'}
          </Button>
        </>
      }
    >
      <div className={s.form}>
        {formError && <InlineNotice tone="neg" title="Not applied.">{formError}</InlineNotice>}

        <div className={s.totRow}>
          <span>Invoice balance</span>
          <span style={{ fontWeight: 600 }}>{formatMoney(invoice.balanceCents)}</span>
        </div>

        <div className={s.grid2}>
          <Field label="Amount *">
            <MoneyInput valueCents={amountCents} onChangeCents={(c) => setAmountCents(c ?? 0)} data-autofocus />
          </Field>
          <Field label="Date *">
            <Input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
          </Field>
        </div>

        <div className={s.grid2}>
          <Field label="Method">
            <Select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="CHECK">Check</option>
              <option value="ACH">ACH</option>
              <option value="WIRE">Wire</option>
              <option value="CREDIT_CARD">Credit card</option>
              <option value="CASH">Cash</option>
            </Select>
          </Field>
          <Field label="Reference #">
            <Input type="text" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Check # or ref" />
          </Field>
        </div>
      </div>
    </Dialog>
  );
}
