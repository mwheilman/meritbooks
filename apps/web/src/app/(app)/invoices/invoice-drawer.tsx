'use client';

import { useState, useEffect } from 'react';
import { Button, Field, Input, InlineNotice, MoneyInput, Select, Textarea } from '@meritbooks/merit-ui';
import { useQuery, addToast } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { CurrencyTag } from '@/components/ui';
import { DetailDrawer, DetailSection, DetailField, DetailTable } from '@/components/detail-drawer';
import { InvoiceTextOverrides } from '@/components/invoice-text-overrides';
import { AttachmentsPanel } from '@/components/documents/attachments-panel';
import { ExplainPanel } from '@/components/explain-panel';
import { PayLinkPanel } from './pay-link-panel';
import { InvoiceStatus } from './invoice-status';
import { SendInvoiceDialog } from './send-invoice-dialog';
import s from './invoices.module.css';

interface InvLine {
  id?: string; lineNumber?: number; description: string;
  quantity: number; unitPriceCents: number; amountCents: number;
  accountId?: string; accountNumber: string; accountName: string;
}
interface InvDetail {
  id: string; invoiceNumber: string; invoiceDate: string; dueDate: string;
  status: string; memo: string | null; isProgressBill: boolean; publicToken: string;
  customerId?: string; locationId?: string;
  subtotalCents: number; taxCents: number; totalCents: number;
  currency?: string; fxRate?: number | null; homeCurrency?: string;
  taxRatePct?: number | null; taxJurisdiction?: string | null;
  amountPaidCents: number; balanceCents: number;
  customerName: string; customerEmail: string | null;
  locationName: string; locationCode: string; jobLabel: string | null;
  lines: InvLine[];
  delivery?: {
    sentAt: string | null; sentTo: string | null; sentCount: number;
    deliveredAt: string | null; viewCount: number;
    lastViewedAt: string | null; lastReminderAt: string | null;
  } | null;
  /** Header status — THE derivation the list uses (lib/invoices/display-status.ts). */
  displayStatus?: string;
  displayStatusLabel?: string;
  displayStatusDetail?: string;
  displayStatusHint?: string | null;
  daysOverdue?: number;
  payments?: Array<{
    id: string; paymentDate: string; amountCents: number; appliedCents: number;
    method: string | null; referenceNumber: string | null;
  }>;
}
interface AccountOption { id: string; account_number: string; name: string; account_type?: string }

/** "Jul 3, 2026, 4:12 PM" — a delivery timestamp reads better with the time. */
const fmtWhen = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
      })
    : null;

export function InvoiceDrawer({ invoiceId, onClose, onCreateCreditMemo }: {
  invoiceId: string | null;
  onClose: () => void;
  onCreateCreditMemo?: (ctx: { invoiceId: string; customerId?: string; locationId?: string }) => void;
}) {
  const { data, isLoading, error, refetch } = useQuery<InvDetail>(
    invoiceId ? `/api/invoices/${invoiceId}` : '', undefined, { enabled: !!invoiceId }
  );

  // Currency the record's amounts are denominated in (stored in this currency's
  // minor unit) vs the tenant reporting currency — so foreign records read clearly.
  const ccy = (data?.currency ?? 'USD').toUpperCase();
  const homeCcy = (data?.homeCurrency ?? 'USD').toUpperCase();
  const isForeign = ccy !== homeCcy;

  const [editing, setEditing] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [needsOverride, setNeedsOverride] = useState(false);
  const [saving, setSaving] = useState(false);

  // Irreversible AR corrections (void / write-off). `confirm` holds which action
  // is armed; each requires a typed reason before it fires.
  const [confirmAction, setConfirmAction] = useState<null | 'void' | 'write-off'>(null);
  const [actionReason, setActionReason] = useState('');
  const [actioning, setActioning] = useState(false);

  async function runCorrection(action: 'void' | 'write-off') {
    if (!data) return;
    setActioning(true);
    try {
      const res = await fetch(`/api/invoices/${data.id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: actionReason.trim() || undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok) {
        addToast('success', action === 'void' ? 'Invoice voided' : 'Invoice written off to bad debt');
        setConfirmAction(null);
        setActionReason('');
        refetch();
      } else {
        // Surface the real refusal — "paid, credit-memo instead", "no bad-debt
        // account configured", "hard-closed period" are distinct problems.
        addToast('error', body.error ?? `Could not ${action === 'void' ? 'void' : 'write off'} this invoice.`);
      }
    } catch {
      addToast('error', 'Network error. Try again.');
    } finally {
      setActioning(false);
    }
  }

  // Send / Resend opens the Send dialog (To, CC, copy to me, message, attachments).
  const [sendOpen, setSendOpen] = useState(false);
  function sendInvoice() {
    if (!data) return;
    setSendOpen(true);
  }

  const [memo, setMemo] = useState('');
  const [invoiceDate, setInvoiceDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [lines, setLines] = useState<InvLine[]>([]);

  const { data: acctResp } = useQuery<{ recent: AccountOption[]; accounts: AccountOption[] }>(
    '/api/accounts/search', undefined, { enabled: editing }
  );
  const accountOptions = [...(acctResp?.recent ?? []), ...(acctResp?.accounts ?? [])];

  useEffect(() => {
    setEditing(false); setNeedsOverride(false); setOverrideReason('');
    setConfirmAction(null); setActionReason('');
  }, [invoiceId]);

  function beginEdit() {
    if (!data) return;
    setMemo(data.memo ?? '');
    setInvoiceDate(data.invoiceDate);
    setDueDate(data.dueDate);
    setLines(data.lines.map((l) => ({ ...l })));
    if (data.status !== 'DRAFT') setNeedsOverride(true);
    setEditing(true);
  }

  function updateLine(i: number, patch: Partial<InvLine>) {
    setLines((prev) => prev.map((l, j) => {
      if (j !== i) return l;
      const next = { ...l, ...patch };
      next.amountCents = Math.round(next.quantity * next.unitPriceCents);
      return next;
    }));
  }
  const editedSubtotal = lines.reduce((s, l) => s + l.amountCents, 0);

  async function save() {
    if (!data) return;
    if (data.status !== 'DRAFT' && overrideReason.trim().length < 3) {
      addToast('error', 'Enter an override reason to edit a posted invoice');
      return;
    }
    if (lines.some((l) => !l.accountId && !l.id)) {
      addToast('error', 'Each line needs an account');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/invoices/${data.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memo,
          invoice_date: invoiceDate,
          due_date: dueDate,
          lines: lines.map((l) => ({
            description: l.description || 'Line',
            account_id: l.accountId,
            quantity: l.quantity,
            unit_price_cents: l.unitPriceCents,
          })),
          ...(data.status !== 'DRAFT' ? { override: { reason: overrideReason.trim() } } : {}),
        }),
      });
      const result = await res.json().catch(() => ({}));
      if (res.ok && result?.ok) {
        addToast('success', data.status !== 'DRAFT' ? 'Saved with override (audit-logged)' : 'Invoice updated');
        setEditing(false); setNeedsOverride(false); setOverrideReason('');
        refetch();
      } else {
        addToast('error', result?.error ?? 'Failed to save');
      }
    } catch {
      addToast('error', 'Network error while saving');
    } finally {
      setSaving(false);
    }
  }

  const st = data?.status;
  const isTerminal = st === 'VOIDED' || st === 'WRITTEN_OFF';
  const hasPayment = !!data && (data.amountPaidCents > 0 || st === 'PAID' || st === 'PARTIALLY_PAID');
  // Void: only an unpaid, non-terminal invoice (a paid one must be
  // credit-memo'd). Write-off: an unpaid/partially-paid invoice that was
  // posted and still carries an open balance.
  const canVoid = !!data && !isTerminal && !hasPayment && st !== 'DRAFT';
  const canWriteOff = !!data && !isTerminal && st !== 'PAID' && st !== 'DRAFT' && data.balanceCents > 0;

  return (
    <DetailDrawer
      open={!!invoiceId}
      onClose={onClose}
      width="lg"
      title={data?.invoiceNumber ? `Invoice ${data.invoiceNumber}` : 'Invoice'}
      subtitle={data ? `${data.customerName}${data.locationCode ? ` · ${data.locationCode}` : ''}` : null}
      isLoading={isLoading}
      error={error}
      headerRight={
        data ? (
          <InvoiceStatus status={data.displayStatus ?? data.status} daysOverdue={data.daysOverdue} hint={data.displayStatusHint} />
        ) : undefined
      }
    >
      {data && !editing && (
        <>
          <div className="btn-row">
            <Button
              variant="primary"
              onClick={sendInvoice}
              disabled={data.status === 'VOIDED'}
              title={data.customerEmail ? `Email this invoice to ${data.customerEmail}` : 'Type an address in the Send dialog'}
            >
              {data.delivery?.sentAt ? 'Resend' : 'Send'}
            </Button>
            <a className="btn" href={`/api/invoices/${data.id}/pdf`} target="_blank" rel="noreferrer">Download PDF</a>
            {onCreateCreditMemo && data.status !== 'DRAFT' && data.status !== 'VOIDED' && (
              <Button
                onClick={() => onCreateCreditMemo({ invoiceId: data.id, customerId: data.customerId, locationId: data.locationId })}
                title="Issue a customer credit against this invoice"
              >
                Issue credit memo
              </Button>
            )}
            <Button variant="quiet" onClick={beginEdit}>Edit</Button>
          </div>

          <DetailSection title="Invoice">
            <DetailField label="Customer" value={data.customerName || '--'} />
            {data.customerEmail && <DetailField label="Email" value={data.customerEmail} />}
            <DetailField label="Company" value={data.locationName || '--'} />
            {data.jobLabel && <DetailField label="Job" value={data.jobLabel} />}
            <DetailField label="Invoice date" value={data.invoiceDate} mono />
            <DetailField label="Due date" value={data.dueDate} mono />
            {data.isProgressBill && <DetailField label="Progress bill" value="AIA" />}
            {data.memo && <DetailField label="Memo" value={data.memo} />}
          </DetailSection>

          <section className="panel-sec">
            <div className="panel-sec-h"><h3>Lines ({data.lines.length})</h3></div>
            <DetailTable columns={[
              { key: 'desc', label: 'Description' }, { key: 'qty', label: 'Qty', align: 'right' },
              { key: 'price', label: 'Unit', align: 'right' }, { key: 'amt', label: 'Amount', align: 'right' },
            ]}>
              {data.lines.map((l) => (
                <tr key={l.id}>
                  <td className={s.lineCell}>
                    <div>{l.description}</div>
                    <div className="t-cap tnum">{l.accountNumber} · {l.accountName}</div>
                  </td>
                  <td className="n ink-2">{l.quantity}</td>
                  <td className="n ink-2">{formatMoney(l.unitPriceCents, { currency: ccy })}</td>
                  <td className="n">{formatMoney(l.amountCents, { currency: ccy })}</td>
                </tr>
              ))}
            </DetailTable>
          </section>

          <DetailSection title="Totals">
            {(isForeign || ccy !== 'USD') && (
              <DetailField
                label="Currency"
                value={
                  <span className={s.inline}>
                    <CurrencyTag code={ccy} homeCurrency={homeCcy} />
                    {isForeign && (
                      <span className="t-cap">
                        reported in {homeCcy}
                        {data.fxRate ? ` · rate ${data.fxRate}` : ''}
                      </span>
                    )}
                  </span>
                }
              />
            )}
            <DetailField label="Subtotal" value={formatMoney(data.subtotalCents, { currency: ccy })} mono />
            <DetailField
              label={
                data.taxJurisdiction === 'EXEMPT'
                  ? 'Tax (exempt)'
                  : data.taxRatePct
                    ? `Tax · ${data.taxJurisdiction ? `${data.taxJurisdiction} ` : ''}${data.taxRatePct}%`
                    : 'Tax'
              }
              value={formatMoney(data.taxCents, { currency: ccy })}
              mono
            />
            <DetailField label="Total" value={formatMoney(data.totalCents, { currency: ccy })} mono />
            <DetailField label="Paid" value={formatMoney(data.amountPaidCents, { currency: ccy })} mono />
            <DetailField label="Balance" value={<b>{formatMoney(data.balanceCents, { currency: ccy })}</b>} mono />
          </DetailSection>

          {/* Ledger-grounded "explain this invoice" — DR AR / CR revenue, tax, status */}
          <div className={s.drawerBlock}>
            <ExplainPanel kind="INVOICE" id={data.id} />
          </div>

          {data.payments && data.payments.length > 0 && (
            <section className="panel-sec">
              <div className="panel-sec-h"><h3>Payments received ({data.payments.length})</h3></div>
              <div className={s.stackGap}>
                {data.payments.map((p) => (
                  <div key={p.id} className={s.payment}>
                    <div>
                      <span className="tnum" style={{ fontWeight: 600 }}>{formatMoney(p.appliedCents)}</span> applied
                      {p.appliedCents !== p.amountCents && (
                        <span className="ink-2"> of <span className="tnum">{formatMoney(p.amountCents)}</span></span>
                      )}
                    </div>
                    <div className="t-cap tnum">
                      {p.paymentDate}{p.method ? ` · ${p.method}` : ''}{p.referenceNumber ? ` · ${p.referenceNumber}` : ''}
                    </div>
                    {/* Ledger-grounded "explain this payment" — DR cash / CR AR, applied invoices */}
                    <ExplainPanel kind="PAYMENT" id={p.id} />
                  </div>
                ))}
              </div>
            </section>
          )}

          <DetailSection title="Delivery">
            {data.delivery?.sentAt ? (
              <>
                <DetailField
                  label={data.delivery.sentCount > 1 ? `Sent (${data.delivery.sentCount}×)` : 'Sent'}
                  value={
                    data.delivery.sentTo
                      ? `${fmtWhen(data.delivery.sentAt)} → ${data.delivery.sentTo}`
                      : (fmtWhen(data.delivery.sentAt) ?? '--')
                  }
                />
                {data.delivery.deliveredAt && (
                  <DetailField label="Delivered" value={fmtWhen(data.delivery.deliveredAt) ?? '--'} />
                )}
                {data.delivery.viewCount > 0 && (
                  <DetailField
                    label="Opened"
                    value={`${data.delivery.viewCount}×${data.delivery.lastViewedAt ? ` · last ${fmtWhen(data.delivery.lastViewedAt)}` : ''}`}
                  />
                )}
                {data.delivery.lastReminderAt && (
                  <DetailField label="Reminder sent" value={fmtWhen(data.delivery.lastReminderAt) ?? '--'} />
                )}
              </>
            ) : data.delivery && (data.delivery.viewCount > 0 || data.delivery.lastReminderAt) ? (
              // Never emailed as an invoice, but it DID reach the customer (a reminder or the
              // pay link) — the same delivery evidence the status chip uses.
              <>
                <div className="mb-detail-row">
                  <span className="ink-2" style={{ whiteSpace: 'normal' }}>
                    The invoice email was never sent, but the customer has it through a reminder or the pay link.
                  </span>
                </div>
                {data.delivery.lastReminderAt && (
                  <DetailField label="Reminder sent" value={fmtWhen(data.delivery.lastReminderAt) ?? '--'} />
                )}
                {data.delivery.viewCount > 0 && (
                  <DetailField
                    label="Opened"
                    value={`${data.delivery.viewCount}×${data.delivery.lastViewedAt ? ` · last ${fmtWhen(data.delivery.lastViewedAt)}` : ''}`}
                  />
                )}
              </>
            ) : (
              <div className="mb-detail-row">
                <span className="ink-2" style={{ whiteSpace: 'normal' }}>
                  {data.customerEmail
                    ? 'Not sent yet. Use Send to email the branded invoice and a Pay now link to the customer.'
                    : `Not sent. Add an email to ${data.customerName || 'this customer'} to enable sending.`}
                </span>
              </div>
            )}
          </DetailSection>

          <div className={s.drawerBlock}>
            <PayLinkPanel invoiceId={data.id} />
          </div>

          <section className="panel-sec">
            <div className="panel-sec-h"><h3>Customer-facing text — this invoice</h3></div>
            <InvoiceTextOverrides scope="INVOICE" refId={data.id} />
          </section>

          <div className={s.drawerBlock}>
            <AttachmentsPanel entityType="invoice" entityId={data.id} defaultDocType="OTHER" title="Documents" />
          </div>

          {(canVoid || canWriteOff) && (
            <section className={s.danger} aria-label="Irreversible corrections">
              <div className="panel-sec-h"><h3>Irreversible corrections</h3></div>

              {!confirmAction && (
                <div className="btn-row">
                  {canVoid && (
                    <Button
                      variant="danger"
                      onClick={() => { setConfirmAction('void'); setActionReason(''); }}
                      title="Reverse this invoice's GL posting and mark it VOIDED (unpaid invoices only)"
                    >
                      Void invoice
                    </Button>
                  )}
                  {canWriteOff && (
                    <Button
                      onClick={() => { setConfirmAction('write-off'); setActionReason(''); }}
                      title="Post DR Bad Debt Expense / CR Accounts Receivable for the open balance and mark it WRITTEN_OFF"
                    >
                      Write off bad debt
                    </Button>
                  )}
                </div>
              )}

              {confirmAction && (
                <div className={s.confirmBox} role="alertdialog" aria-label={confirmAction === 'void' ? 'Confirm void' : 'Confirm write-off'}>
                  <p className="ink-2">
                    {confirmAction === 'void' ? (
                      <>Void <b className="tnum">{data.invoiceNumber}</b>? This reverses its GL entry and removes it from receivables. The invoice number is kept for audit and cannot be reused.</>
                    ) : (
                      <>Write off the <b className="tnum">{formatMoney(data.balanceCents)}</b> open balance on <b className="tnum">{data.invoiceNumber}</b> as bad debt? This posts DR Bad Debt Expense / CR Accounts Receivable and marks the invoice WRITTEN_OFF.</>
                    )}
                  </p>
                  <Field label="Reason" help="Recommended — it goes on the audit trail.">
                    <Input
                      type="text"
                      value={actionReason}
                      onChange={(e) => setActionReason(e.target.value)}
                      placeholder={confirmAction === 'void' ? 'Reason for voiding' : 'Reason for write-off'}
                      autoFocus
                    />
                  </Field>
                  <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
                    <Button variant="quiet" onClick={() => { setConfirmAction(null); setActionReason(''); }} disabled={actioning}>
                      Cancel
                    </Button>
                    <Button variant="danger" onClick={() => runCorrection(confirmAction)} disabled={actioning} aria-busy={actioning || undefined}>
                      {actioning ? 'Working…' : confirmAction === 'void' ? 'Void invoice' : 'Write off'}
                    </Button>
                  </div>
                </div>
              )}
            </section>
          )}
        </>
      )}

      {data && editing && (
        <>
          {needsOverride && (
            <InlineNotice tone="warn" title="Posted invoice — override required.">
              This invoice is posted to the GL. Editing it is logged to the audit trail; changing amounts reverses and re-posts the journal entry.
            </InlineNotice>
          )}

          <section className="panel-sec">
            <div className={s.form}>
              {needsOverride && (
                <Field label="Reason for override *">
                  <Input type="text" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="Why this posted invoice is changing" autoFocus />
                </Field>
              )}
              <Field label="Memo">
                <Textarea value={memo} onChange={(e) => setMemo(e.target.value)} rows={2} />
              </Field>
              <div className={s.grid2}>
                <Field label="Invoice date">
                  <Input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
                </Field>
                <Field label="Due date">
                  <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                </Field>
              </div>
            </div>
          </section>

          <section className="panel-sec">
            <div className={s.drawerHead}>
              <span className="eyebrow">Lines</span>
              <Button
                variant="quiet"
                icon="plus"
                onClick={() => setLines((p) => [...p, { description: '', quantity: 1, unitPriceCents: 0, amountCents: 0, accountNumber: '', accountName: '' }])}
              >
                Add line
              </Button>
            </div>
            <div className={s.stackGap}>
              {lines.map((l, i) => (
                <div key={i} className={s.editLine}>
                  <Input
                    type="text"
                    value={l.description}
                    onChange={(e) => updateLine(i, { description: e.target.value })}
                    placeholder="Description"
                    aria-label={`Line ${i + 1} description`}
                  />
                  <Select value={l.accountId ?? ''} onChange={(e) => updateLine(i, { accountId: e.target.value })} aria-label={`Line ${i + 1} account`}>
                    <option value="">Account…</option>
                    {accountOptions.map((a) => <option key={a.id} value={a.id}>{a.account_number} · {a.name}</option>)}
                  </Select>
                  <div className={s.editLineGrid}>
                    <Input
                      type="number"
                      value={l.quantity}
                      onChange={(e) => updateLine(i, { quantity: parseFloat(e.target.value) || 0 })}
                      className={s.num}
                      aria-label={`Line ${i + 1} quantity`}
                    />
                    <MoneyInput
                      valueCents={l.unitPriceCents}
                      onChangeCents={(c) => updateLine(i, { unitPriceCents: c ?? 0 })}
                      aria-label={`Line ${i + 1} unit price`}
                    />
                    <span className={s.amount}>= {formatMoney(l.amountCents)}</span>
                    <Button variant="quiet" iconOnly icon="x" onClick={() => setLines((p) => p.filter((_, j) => j !== i))} aria-label={`Remove line ${i + 1}`} />
                  </div>
                </div>
              ))}
            </div>

            <div className={s.subtotalBar}>
              <span className="ink-2">New subtotal</span>
              <span className="tnum" style={{ fontWeight: 600 }}>{formatMoney(editedSubtotal)}</span>
            </div>

            <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
              <Button variant="quiet" onClick={() => { setEditing(false); setNeedsOverride(false); }}>
                Cancel
              </Button>
              <Button variant="primary" onClick={save} disabled={saving} aria-busy={saving || undefined}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </section>
        </>
      )}
      {data && (
        <SendInvoiceDialog
          invoiceId={data.id}
          invoiceNumber={data.invoiceNumber}
          open={sendOpen}
          resend={!!data.delivery?.sentAt}
          onClose={() => setSendOpen(false)}
          onSent={() => { void refetch(); }}
        />
      )}
    </DetailDrawer>
  );
}
