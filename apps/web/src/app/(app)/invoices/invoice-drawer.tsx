'use client';

import { useState, useEffect } from 'react';
import { clsx } from 'clsx';
import { Pencil, Plus, Trash2, Loader2, ShieldAlert, Download, Link2, Send, Receipt, Ban, FileX } from 'lucide-react';
import { useQuery, addToast } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { StatusBadge } from '@/components/ui';
import { DetailDrawer, DetailSection, DetailField, DetailTable } from '@/components/detail-drawer';
import { InvoiceTextOverrides } from '@/components/invoice-text-overrides';

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
  amountPaidCents: number; balanceCents: number;
  customerName: string; customerEmail: string | null;
  locationName: string; locationCode: string; jobLabel: string | null;
  lines: InvLine[];
  delivery?: {
    sentAt: string | null; sentTo: string | null; sentCount: number;
    deliveredAt: string | null; viewCount: number;
    lastViewedAt: string | null; lastReminderAt: string | null;
  } | null;
}
interface AccountOption { id: string; account_number: string; name: string; account_type?: string }

const centsToInput = (c: number) => (c / 100).toFixed(2);
const inputToCents = (v: string) => Math.round((parseFloat(v.replace(/[^0-9.-]/g, '')) || 0) * 100);

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

  const [editing, setEditing] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [needsOverride, setNeedsOverride] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);

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

  async function sendInvoice() {
    if (!data) return;
    if (!data.customerEmail) {
      addToast('error', `${data.customerName} has no email address on file.`);
      return;
    }
    setSending(true);
    try {
      const res = await fetch(`/api/invoices/${data.id}/send`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.sent) {
        addToast('success', `Invoice emailed to ${body.to}`);
        refetch();
      } else {
        // Surface the real reason, not a generic failure — "not configured",
        // "no email on file", and "provider rejected" are different problems.
        addToast('error', body.error ?? 'Could not send the invoice.');
      }
    } catch {
      addToast('error', 'Could not reach the send service. Try again.');
    } finally {
      setSending(false);
    }
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
          <div className="flex items-center gap-2">
            <StatusBadge status={data.status} />
            {!editing && (
              <>
                <a href={`/api/invoices/${data.id}/pdf`} target="_blank" rel="noreferrer"
                   className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-slate-800 text-slate-200 hover:bg-slate-700">
                  <Download size={12} /> PDF
                </a>
                <button onClick={() => { navigator.clipboard?.writeText(`${window.location.origin}/pay/${data.publicToken}`); addToast('success', 'Customer link copied'); }}
                   className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-slate-800 text-slate-200 hover:bg-slate-700">
                  <Link2 size={12} /> Link
                </button>
                <button onClick={sendInvoice} disabled={sending || !data.customerEmail}
                   title={data.customerEmail ? `Email this invoice to ${data.customerEmail}` : 'No customer email on file'}
                   className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed">
                  {sending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                  {sending ? 'Sending…' : data.delivery?.sentAt ? 'Resend' : 'Send'}
                </button>
              </>
            )}
            {!editing && onCreateCreditMemo && data.status !== 'DRAFT' && data.status !== 'VOIDED' && (
              <button
                onClick={() => onCreateCreditMemo({ invoiceId: data.id, customerId: data.customerId, locationId: data.locationId })}
                title="Issue a customer credit against this invoice"
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-slate-800 text-slate-200 hover:bg-slate-700">
                <Receipt size={12} /> Credit memo
              </button>
            )}
            {!editing && (
              <button onClick={beginEdit} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-slate-800 text-slate-200 hover:bg-slate-700">
                <Pencil size={12} /> Edit
              </button>
            )}
          </div>
        ) : undefined
      }
    >
      {data && !editing && (
        <>
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

          <h3 className="text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-2">Lines ({data.lines.length})</h3>
          <DetailTable columns={[
            { key: 'desc', label: 'Description' }, { key: 'qty', label: 'Qty', align: 'right' },
            { key: 'price', label: 'Unit', align: 'right' }, { key: 'amt', label: 'Amount', align: 'right' },
          ]}>
            {data.lines.map((l) => (
              <tr key={l.id}>
                <td className="px-3 py-2">
                  <div className="text-sm text-slate-200">{l.description}</div>
                  <div className="text-2xs text-slate-500 mt-0.5 font-mono">{l.accountNumber} · {l.accountName}</div>
                </td>
                <td className="px-3 py-2 text-right text-sm font-mono tabular-nums text-slate-400">{l.quantity}</td>
                <td className="px-3 py-2 text-right text-sm font-mono tabular-nums text-slate-400">{formatMoney(l.unitPriceCents)}</td>
                <td className="px-3 py-2 text-right text-sm font-mono tabular-nums text-slate-200">{formatMoney(l.amountCents)}</td>
              </tr>
            ))}
          </DetailTable>

          <DetailSection title="">
            <DetailField label="Subtotal" value={formatMoney(data.subtotalCents)} mono />
            <DetailField label="Tax" value={formatMoney(data.taxCents)} mono />
            <DetailField label="Total" value={formatMoney(data.totalCents)} mono />
            <DetailField label="Paid" value={formatMoney(data.amountPaidCents)} mono />
            <DetailField label="Balance" value={formatMoney(data.balanceCents)} mono />
          </DetailSection>

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
            ) : (
              <div className="px-4 py-3 text-xs text-slate-500">
                {data.customerEmail
                  ? 'Not sent yet. Use Send to email the branded invoice and a Pay Now link to the customer.'
                  : `Not sent. Add an email to ${data.customerName || 'this customer'} to enable sending.`}
              </div>
            )}
          </DetailSection>

          <div className="mt-5 pt-4 border-t border-slate-800">
            <h3 className="text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-2">Customer-facing text — this invoice</h3>
            <InvoiceTextOverrides scope="INVOICE" refId={data.id} />
          </div>

          {(() => {
            const st = data.status;
            const isTerminal = st === 'VOIDED' || st === 'WRITTEN_OFF';
            const hasPayment = data.amountPaidCents > 0 || st === 'PAID' || st === 'PARTIALLY_PAID';
            // Void: only an unpaid, non-terminal invoice (a paid one must be
            // credit-memo'd). Write-off: an unpaid/partially-paid invoice that was
            // posted and still carries an open balance.
            const canVoid = !isTerminal && !hasPayment && st !== 'DRAFT';
            const canWriteOff = !isTerminal && st !== 'PAID' && st !== 'DRAFT' && data.balanceCents > 0;
            if (!canVoid && !canWriteOff) return null;

            return (
              <div className="mt-5 pt-4 border-t border-red-900/40">
                <h3 className="text-2xs text-red-400/80 uppercase tracking-wider font-semibold mb-2 flex items-center gap-1.5">
                  <ShieldAlert size={12} /> Irreversible corrections
                </h3>

                {!confirmAction && (
                  <div className="flex items-center gap-2">
                    {canVoid && (
                      <button onClick={() => { setConfirmAction('void'); setActionReason(''); }}
                        title="Reverse this invoice's GL posting and mark it VOIDED (unpaid invoices only)"
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border border-red-800/60 bg-red-950/30 text-red-300 hover:bg-red-900/40">
                        <Ban size={13} /> Void invoice
                      </button>
                    )}
                    {canWriteOff && (
                      <button onClick={() => { setConfirmAction('write-off'); setActionReason(''); }}
                        title="Post DR Bad Debt Expense / CR Accounts Receivable for the open balance and mark it WRITTEN_OFF"
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border border-amber-800/60 bg-amber-950/30 text-amber-300 hover:bg-amber-900/40">
                        <FileX size={13} /> Write off bad debt
                      </button>
                    )}
                  </div>
                )}

                {confirmAction && (
                  <div className="rounded-lg border border-red-800/50 bg-red-950/20 p-3 space-y-2">
                    <p className="text-xs text-slate-300">
                      {confirmAction === 'void' ? (
                        <>Void <span className="font-mono">{data.invoiceNumber}</span>? This reverses its GL entry and removes it from receivables. The invoice number is kept for audit and cannot be reused.</>
                      ) : (
                        <>Write off the <span className="font-mono tabular-nums">{formatMoney(data.balanceCents)}</span> open balance on <span className="font-mono">{data.invoiceNumber}</span> as bad debt? This posts DR Bad Debt Expense / CR Accounts Receivable and marks the invoice WRITTEN_OFF.</>
                      )}
                    </p>
                    <input type="text" value={actionReason} onChange={(e) => setActionReason(e.target.value)}
                      placeholder={confirmAction === 'void' ? 'Reason for voiding (recommended)…' : 'Reason for write-off (recommended)…'}
                      className="w-full px-3 py-2 rounded-md bg-slate-900/60 border border-slate-700 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-red-500/40" />
                    <div className="flex items-center justify-end gap-2">
                      <button onClick={() => { setConfirmAction(null); setActionReason(''); }} disabled={actioning}
                        className="px-3 py-1.5 rounded-md text-xs text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]">
                        Cancel
                      </button>
                      <button onClick={() => runCorrection(confirmAction)} disabled={actioning}
                        className={clsx('inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium',
                          actioning ? 'bg-slate-800 text-slate-600'
                            : confirmAction === 'void' ? 'bg-red-600 text-white hover:bg-red-500'
                            : 'bg-amber-600 text-white hover:bg-amber-500')}>
                        {actioning ? <Loader2 size={13} className="animate-spin" /> : confirmAction === 'void' ? <Ban size={13} /> : <FileX size={13} />}
                        {actioning ? 'Working…' : confirmAction === 'void' ? 'Void invoice' : 'Write off'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </>
      )}

      {data && editing && (
        <>
          {needsOverride && (
            <div className="mb-4 rounded-lg border border-amber-600/40 bg-amber-500/5 p-3">
              <div className="flex items-center gap-2 text-amber-400 text-sm font-medium mb-2">
                <ShieldAlert size={15} /> Posted invoice — override required
              </div>
              <p className="text-2xs text-slate-400 mb-2">
                This invoice is posted to the GL. Editing it is logged to the audit trail; changing amounts reverses and re-posts the journal entry.
              </p>
              <input type="text" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)}
                placeholder="Reason for override (required)…"
                className="w-full px-3 py-2 rounded-md bg-slate-800/60 border border-slate-700 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-amber-500/40" />
            </div>
          )}

          <DetailSection title="Invoice">
            <div className="px-4 py-3 space-y-3">
              <label className="block">
                <span className="text-2xs text-slate-500 uppercase tracking-wider font-semibold">Memo</span>
                <textarea value={memo} onChange={(e) => setMemo(e.target.value)} rows={2}
                  className="mt-1 w-full px-3 py-2 rounded-md bg-slate-800/60 border border-slate-700 text-sm text-slate-200 resize-none" />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-2xs text-slate-500 uppercase tracking-wider font-semibold">Invoice date</span>
                  <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)}
                    className="mt-1 w-full px-3 py-2 rounded-md bg-slate-800/60 border border-slate-700 text-sm text-slate-200" />
                </label>
                <label className="block">
                  <span className="text-2xs text-slate-500 uppercase tracking-wider font-semibold">Due date</span>
                  <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)}
                    className="mt-1 w-full px-3 py-2 rounded-md bg-slate-800/60 border border-slate-700 text-sm text-slate-200" />
                </label>
              </div>
            </div>
          </DetailSection>

          <div className="flex items-center justify-between mb-2">
            <h3 className="text-2xs text-slate-500 uppercase tracking-wider font-semibold">Lines</h3>
            <button onClick={() => setLines((p) => [...p, { description: '', quantity: 1, unitPriceCents: 0, amountCents: 0, accountNumber: '', accountName: '' }])}
              className="inline-flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300">
              <Plus size={12} /> Add line
            </button>
          </div>
          <div className="space-y-2">
            {lines.map((l, i) => (
              <div key={i} className="rounded-lg bg-slate-800/30 p-3 space-y-2">
                <input type="text" value={l.description} onChange={(e) => updateLine(i, { description: e.target.value })}
                  placeholder="Description"
                  className="w-full px-2 py-1.5 rounded bg-slate-800/60 border border-slate-700 text-sm text-slate-200" />
                <div className="grid grid-cols-12 gap-2 items-center">
                  <select value={l.accountId ?? ''} onChange={(e) => updateLine(i, { accountId: e.target.value })}
                    className="col-span-6 px-2 py-1.5 rounded bg-slate-800/60 border border-slate-700 text-xs text-slate-200">
                    <option value="">Account…</option>
                    {accountOptions.map((a) => <option key={a.id} value={a.id}>{a.account_number} · {a.name}</option>)}
                  </select>
                  <input type="number" value={l.quantity} onChange={(e) => updateLine(i, { quantity: parseFloat(e.target.value) || 0 })}
                    className="col-span-2 px-2 py-1.5 rounded bg-slate-800/60 border border-slate-700 text-xs text-slate-200 text-right" />
                  <input type="text" inputMode="decimal" defaultValue={centsToInput(l.unitPriceCents)}
                    onChange={(e) => updateLine(i, { unitPriceCents: inputToCents(e.target.value) })}
                    className="col-span-3 px-2 py-1.5 rounded bg-slate-800/60 border border-slate-700 text-xs text-slate-200 text-right font-mono" />
                  <button onClick={() => setLines((p) => p.filter((_, j) => j !== i))} className="col-span-1 p-1 text-slate-500 hover:text-red-400">
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className="text-right text-2xs text-slate-500 font-mono">= {formatMoney(l.amountCents)}</div>
              </div>
            ))}
          </div>

          <div className="mt-3 flex items-center justify-between rounded-lg bg-slate-800/40 px-4 py-2.5">
            <span className="text-xs text-slate-400">New subtotal</span>
            <span className="text-sm font-mono tabular-nums text-slate-100">{formatMoney(editedSubtotal)}</span>
          </div>

          <div className="mt-4 flex items-center justify-end gap-2">
            <button onClick={() => { setEditing(false); setNeedsOverride(false); }} className="px-4 py-2 rounded-md text-sm text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]">
              Cancel
            </button>
            <button onClick={save} disabled={saving}
              className={clsx('inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium',
                saving ? 'bg-slate-800 text-slate-600' : 'bg-emerald-600 text-white hover:bg-emerald-500')}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Pencil size={14} />} Save
            </button>
          </div>
        </>
      )}
    </DetailDrawer>
  );
}
