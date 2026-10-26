'use client';

import { useState, useEffect } from 'react';
import { formatMoney } from '@meritbooks/shared';
import { Button, Check, Dialog, Field, InlineNotice, Input, MoneyInput, Select, cx } from '@meritbooks/merit-ui';
import { useQuery } from '@/hooks/use-query';
import type { CustomerOption, LocationOption } from './invoice-types';
import s from './invoices.module.css';

// ─── Create Invoice Form ──────────────────────────────────────────────

interface InvoiceLine {
  description: string;
  account_id: string;
  quantity: number;
  unit_price_cents: number;
}

export function CreateInvoiceForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [locationId, setLocationId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().split('T')[0]);
  const [dueDate, setDueDate] = useState('');
  const [memo, setMemo] = useState('');
  const [taxCents, setTaxCents] = useState(0);
  // Auto sales-tax (GATE 11d): compute tax from the tenant's configured rate rows +
  // the customer's jurisdiction. Toggle off to key tax by hand. Degrade-safe.
  const [autoTax, setAutoTax] = useState(true);
  const [taxInfo, setTaxInfo] = useState<
    { ratePct: number; jurisdictionLabel: string | null; exempt: boolean; rateResolved: boolean } | null
  >(null);
  const [lines, setLines] = useState<InvoiceLine[]>([{ description: '', account_id: '', quantity: 1, unit_price_cents: 0 }]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  const { data: locData } = useQuery<{ data: LocationOption[] }>('/api/locations');
  const { data: custData } = useQuery<{ data: CustomerOption[] }>('/api/customers?per_page=200');
  const { data: acctData } = useQuery<{ data: { id: string; account_number: string; name: string }[] }>(
    locationId ? `/api/accounts/search?location_id=${locationId}&q=4` : null
  );

  const locations = locData?.data ?? [];
  const customers = custData?.data ?? [];
  const accounts = acctData?.data ?? [];

  // Auto-calculate due date from customer terms
  useEffect(() => {
    if (customerId && invoiceDate) {
      const cust = customers.find((c) => c.id === customerId);
      if (cust) {
        const d = new Date(invoiceDate);
        d.setDate(d.getDate() + cust.paymentTermsDays);
        setDueDate(d.toISOString().split('T')[0]);
      }
    }
  }, [customerId, invoiceDate, customers]);

  const subtotal = lines.reduce((sum, l) => sum + Math.round(l.quantity * l.unit_price_cents), 0);
  const total = subtotal + taxCents;

  // Live sales-tax resolution (GATE 11d). Debounced: when auto-tax is on and we have a
  // customer + taxable subtotal, ask the server for the jurisdiction rate and set the
  // accrual. No configured rate / exempt customer → tax 0 (behaves as before).
  useEffect(() => {
    if (!autoTax) { setTaxInfo(null); return; }
    if (!customerId || subtotal <= 0 || !invoiceDate) {
      setTaxCents(0);
      setTaxInfo(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await fetch('/api/tax/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            customer_id: customerId,
            invoice_date: invoiceDate,
            line_amounts_cents: [subtotal],
          }),
        });
        if (!res.ok) return;
        const j = await res.json();
        if (cancelled) return;
        setTaxCents(Number(j.taxCents) || 0);
        setTaxInfo({
          ratePct: Number(j.ratePct) || 0,
          jurisdictionLabel: j.jurisdictionLabel ?? null,
          exempt: !!j.exempt,
          rateResolved: !!j.rateResolved,
        });
      } catch {
        /* leave prior tax; degrade-safe */
      }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [autoTax, customerId, invoiceDate, subtotal]);

  const addLine = () => setLines([...lines, { description: '', account_id: '', quantity: 1, unit_price_cents: 0 }]);
  const removeLine = (i: number) => { if (lines.length > 1) setLines(lines.filter((_, j) => j !== i)); };
  const updateLine = (i: number, field: keyof InvoiceLine, value: string | number) => {
    setLines(lines.map((l, j) => j === i ? { ...l, [field]: value } : l));
  };

  const handleSubmit = async () => {
    setFormError('');
    if (!locationId || !customerId || !invoiceDate || !dueDate) {
      setFormError('Please fill all required fields');
      return;
    }
    if (lines.some((l) => !l.description || !l.account_id)) {
      setFormError('All lines must have a description and GL account');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_id: locationId,
          customer_id: customerId,
          invoice_date: invoiceDate,
          due_date: dueDate,
          memo: memo || undefined,
          tax_cents: taxCents,
          auto_tax: autoTax,
          lines: lines.map((l) => ({
            description: l.description,
            account_id: l.account_id,
            quantity: l.quantity,
            unit_price_cents: l.unit_price_cents,
          })),
        }),
      });
      const result = await res.json();
      if (!res.ok) {
        setFormError(result.error ?? 'Failed to create invoice');
        return;
      }
      onCreated();
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
      title="New invoice"
      width={820}
      className={s.tallDialog}
      dismissOnScrim={!submitting}
      footNote={<span className="tnum">Total {formatMoney(total)}</span>}
      actions={
        <>
          <Button onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button variant="primary" onClick={() => void handleSubmit()} disabled={submitting} aria-busy={submitting || undefined}>
            {submitting ? 'Creating…' : 'Create invoice'}
          </Button>
        </>
      }
    >
      <div className={s.form}>
        {formError && <InlineNotice tone="neg" title="Not created.">{formError}</InlineNotice>}

        <div className={s.grid2}>
          <Field label="Company *">
            <Select value={locationId} onChange={(e) => setLocationId(e.target.value)} data-autofocus>
              <option value="">Select company</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          </Field>
          <Field label="Customer *">
            <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">Select customer</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
        </div>

        <div className={s.grid3}>
          <Field label="Invoice date *">
            <Input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
          </Field>
          <Field label="Due date *" help={customerId ? 'Set from the customer’s terms; change it if needed.' : undefined}>
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
          <Field label="Memo">
            <Input type="text" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Optional" />
          </Field>
        </div>

        {/* Line items */}
        <div>
          <div className={s.linesHead}>
            <span className="eyebrow">Lines</span>
            <Button variant="quiet" icon="plus" onClick={addLine}>Add line</Button>
          </div>
          <div className={s.lineRows}>
            <div className={s.lineGrid} aria-hidden="true">
              <span className="field-label">Description</span>
              <span className="field-label">GL account</span>
              <span className={cx('field-label', s.num)}>Qty</span>
              <span className={cx('field-label', s.num)}>Unit price</span>
              <span className={cx('field-label', s.num)}>Amount</span>
              <span />
            </div>
            {lines.map((line, i) => (
              <div key={i} className={s.lineGrid}>
                <Input
                  type="text"
                  value={line.description}
                  onChange={(e) => updateLine(i, 'description', e.target.value)}
                  placeholder="Service or item"
                  aria-label={`Line ${i + 1} description`}
                />
                <Select value={line.account_id} onChange={(e) => updateLine(i, 'account_id', e.target.value)} aria-label={`Line ${i + 1} GL account`}>
                  <option value="">{locationId ? 'Select account' : 'Pick a company first'}</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.account_number} · {a.name}</option>)}
                </Select>
                <Input
                  type="number"
                  value={line.quantity}
                  min={0}
                  step={0.01}
                  className={s.num}
                  onChange={(e) => updateLine(i, 'quantity', parseFloat(e.target.value) || 0)}
                  aria-label={`Line ${i + 1} quantity`}
                />
                <MoneyInput
                  valueCents={line.unit_price_cents}
                  onChangeCents={(c) => updateLine(i, 'unit_price_cents', c ?? 0)}
                  aria-label={`Line ${i + 1} unit price`}
                />
                <span className={s.amount}>{formatMoney(Math.round(line.quantity * line.unit_price_cents))}</span>
                {lines.length > 1 ? (
                  <Button variant="quiet" iconOnly icon="x" onClick={() => removeLine(i)} aria-label={`Remove line ${i + 1}`} />
                ) : <span />}
              </div>
            ))}
          </div>
        </div>

        {/* Totals */}
        <div className={s.totals}>
          <div className={s.totRow}>
            <span>Subtotal</span>
            <span>{formatMoney(subtotal)}</span>
          </div>
          <div className={s.totRow}>
            <span className={s.inline}>
              Tax
              <Check label="Auto" checked={autoTax} onChange={(e) => setAutoTax(e.target.checked)} />
            </span>
            {autoTax ? (
              <span>{formatMoney(taxCents)}</span>
            ) : (
              <MoneyInput className={s.taxInput} valueCents={taxCents} onChangeCents={(c) => setTaxCents(c ?? 0)} aria-label="Tax amount" />
            )}
          </div>
          {autoTax && (
            <div className={cx('t-cap', s.totHint)}>
              {taxInfo?.exempt
                ? 'Customer is tax-exempt — no tax'
                : taxInfo?.rateResolved
                  ? `${taxInfo.jurisdictionLabel ?? 'Jurisdiction'} · ${taxInfo.ratePct}%`
                  : customerId
                    ? 'No sales-tax rate configured for this jurisdiction'
                    : 'Select a customer to resolve tax'}
            </div>
          )}
          <div className={cx(s.totRow, s.totGrand)}>
            <span>Total</span>
            <span>{formatMoney(total)}</span>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
