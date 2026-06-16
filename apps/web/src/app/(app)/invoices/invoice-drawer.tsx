'use client';

import { useState, useEffect } from 'react';
import { clsx } from 'clsx';
import { Pencil, Plus, Trash2, Loader2, ShieldAlert, Download, Link2 } from 'lucide-react';
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
  subtotalCents: number; taxCents: number; totalCents: number;
  amountPaidCents: number; balanceCents: number;
  customerName: string; customerEmail: string | null;
  locationName: string; locationCode: string; jobLabel: string | null;
  lines: InvLine[];
}
interface AccountOption { id: string; account_number: string; name: string; account_type?: string }

const centsToInput = (c: number) => (c / 100).toFixed(2);
const inputToCents = (v: string) => Math.round((parseFloat(v.replace(/[^0-9.-]/g, '')) || 0) * 100);

export function InvoiceDrawer({ invoiceId, onClose }: { invoiceId: string | null; onClose: () => void }) {
  const { data, isLoading, error, refetch } = useQuery<InvDetail>(
    invoiceId ? `/api/invoices/${invoiceId}` : '', undefined, { enabled: !!invoiceId }
  );

  const [editing, setEditing] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [needsOverride, setNeedsOverride] = useState(false);
  const [saving, setSaving] = useState(false);

  const [memo, setMemo] = useState('');
  const [invoiceDate, setInvoiceDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [lines, setLines] = useState<InvLine[]>([]);

  const { data: acctResp } = useQuery<{ recent: AccountOption[]; accounts: AccountOption[] }>(
    '/api/accounts/search', undefined, { enabled: editing }
  );
  const accountOptions = [...(acctResp?.recent ?? []), ...(acctResp?.accounts ?? [])];

  useEffect(() => { setEditing(false); setNeedsOverride(false); setOverrideReason(''); }, [invoiceId]);

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
              </>
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

          <div className="mt-5 pt-4 border-t border-slate-800">
            <h3 className="text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-2">Customer-facing text — this invoice</h3>
            <InvoiceTextOverrides scope="INVOICE" refId={data.id} />
          </div>
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
