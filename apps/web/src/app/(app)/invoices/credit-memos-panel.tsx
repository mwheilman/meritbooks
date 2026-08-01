'use client';

import { useState, useEffect, useMemo } from 'react';
import { useQuery, addToast } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { DetailDrawer, DetailSection, DetailField, DetailTable } from '@/components/detail-drawer';
import {
  Plus, X, Loader2, Receipt, AlertCircle, Check, Ban, Send, Link2, ChevronRight,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────
interface MemoRow {
  id: string;
  creditNumber: string | null;
  creditDate: string;
  status: string;
  memo: string | null;
  reason: string | null;
  totalCents: number;
  appliedCents: number;
  unappliedCents: number;
  invoiceId: string | null;
  customer: { id: string; name: string } | null;
  location: { id: string; name: string; shortCode: string } | null;
}
interface LocationOption { id: string; name: string; short_code: string }
interface CustomerOption { id: string; name: string }
interface AccountOption { id: string; account_number: string; name: string }

// ─── Local status badge (covers APPLIED, which the shared one does not) ──
function MemoStatusBadge({ status }: { status: string }) {
  const cfg: Record<string, { bg: string; text: string; label: string }> = {
    DRAFT: { bg: 'bg-gray-500/20', text: 'text-gray-300', label: 'Draft' },
    POSTED: { bg: 'bg-blue-500/20', text: 'text-blue-300', label: 'Posted' },
    APPLIED: { bg: 'bg-emerald-500/20', text: 'text-emerald-300', label: 'Applied' },
    VOIDED: { bg: 'bg-gray-500/20', text: 'text-gray-500', label: 'Voided' },
  };
  const c = cfg[status] ?? cfg.DRAFT;
  return <span className={`px-2 py-0.5 text-xs rounded-full ${c.bg} ${c.text}`}>{c.label}</span>;
}

export interface CreditMemoPrefill {
  invoiceId?: string;
  customerId?: string;
  locationId?: string;
}

// ─── Panel ────────────────────────────────────────────────────────────
export function CreditMemosPanel({ prefill, onConsumePrefill }: {
  prefill?: CreditMemoPrefill | null;
  onConsumePrefill?: () => void;
}) {
  const [showCreate, setShowCreate] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Open the create modal pre-filled when the parent hands us an invoice context.
  useEffect(() => {
    if (prefill) setShowCreate(true);
  }, [prefill]);

  const { data, isLoading, error } = useQuery<{
    data: MemoRow[];
    counts: Record<string, number>;
    openCreditCents: number;
  }>(`/api/credit-memos?_k=${refreshKey}`);

  const memos = data?.data ?? [];
  const refresh = () => { setRefreshKey((k) => k + 1); setShowCreate(false); setDetailId(null); };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-white">Credit Memos</h2>
          <p className="text-sm text-gray-400 mt-1">Issue customer credits, post to the GL, and apply against open invoices</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-medium transition-colors"
        >
          <Plus className="w-4 h-4" /> New Credit Memo
        </button>
      </div>

      {/* Summary tiles */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Open credit', value: formatMoney(data?.openCreditCents ?? 0), sub: `${data?.counts?.POSTED ?? 0} posted` },
          { label: 'Draft', value: String(data?.counts?.DRAFT ?? 0), sub: 'awaiting post' },
          { label: 'Applied', value: String(data?.counts?.APPLIED ?? 0), sub: 'fully used' },
          { label: 'Total', value: String(data?.counts?.ALL ?? 0), sub: 'all memos' },
        ].map((c) => (
          <div key={c.label} className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4">
            <span className="text-sm text-gray-400">{c.label}</span>
            <p className="text-xl font-mono font-semibold text-white mt-2">{c.value}</p>
            <p className="text-xs text-gray-500 mt-1">{c.sub}</p>
          </div>
        ))}
      </div>

      {error ? (
        <div className="p-8 text-center">
          <AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" />
          <p className="text-red-400">Failed to load credit memos</p>
          <p className="text-sm text-gray-500 mt-1">{error}</p>
        </div>
      ) : isLoading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-emerald-400 animate-spin" /></div>
      ) : memos.length === 0 ? (
        <div className="text-center py-16">
          <Receipt className="w-10 h-10 text-gray-600 mx-auto mb-3" />
          <p className="text-gray-400 font-medium">No credit memos</p>
          <p className="text-sm text-gray-500 mt-1">Create a credit memo to reverse revenue and reduce a customer&apos;s balance</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-700/50">
                <th className="pb-3 pr-4">Credit #</th>
                <th className="pb-3 pr-4">Customer</th>
                <th className="pb-3 pr-4">Company</th>
                <th className="pb-3 pr-4">Date</th>
                <th className="pb-3 pr-4 text-right">Total</th>
                <th className="pb-3 pr-4 text-right">Applied</th>
                <th className="pb-3 pr-4 text-right">Open</th>
                <th className="pb-3 pr-4">Status</th>
                <th className="pb-3"></th>
              </tr>
            </thead>
            <tbody>
              {memos.map((m) => (
                <tr key={m.id} onClick={() => setDetailId(m.id)} className="border-b border-gray-800/50 cursor-pointer hover:bg-gray-800/30">
                  <td className="py-3 pr-4 font-mono text-white">{m.creditNumber ?? '—'}</td>
                  <td className="py-3 pr-4 text-gray-300">{m.customer?.name ?? '—'}</td>
                  <td className="py-3 pr-4 text-gray-400 text-xs">{m.location?.name ?? '—'}</td>
                  <td className="py-3 pr-4 font-mono text-gray-400 text-xs">{m.creditDate}</td>
                  <td className="py-3 pr-4 text-right font-mono text-white">{formatMoney(m.totalCents)}</td>
                  <td className="py-3 pr-4 text-right font-mono text-gray-400">{formatMoney(m.appliedCents)}</td>
                  <td className="py-3 pr-4 text-right font-mono text-emerald-400">{formatMoney(m.unappliedCents)}</td>
                  <td className="py-3 pr-4"><MemoStatusBadge status={m.status} /></td>
                  <td className="py-3"><ChevronRight size={15} className="text-gray-600 inline" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreateCreditMemoModal
          prefill={prefill ?? null}
          onClose={() => { setShowCreate(false); onConsumePrefill?.(); }}
          onCreated={() => { onConsumePrefill?.(); refresh(); }}
        />
      )}
      <CreditMemoDrawer memoId={detailId} onClose={() => setDetailId(null)} onChanged={refresh} />
    </div>
  );
}

// ─── Detail drawer with Post / Apply / Void ───────────────────────────
interface MemoDetail {
  id: string; creditNumber: string; creditDate: string; status: string;
  memo: string | null; reason: string | null;
  subtotalCents: number; taxCents: number; totalCents: number;
  appliedCents: number; unappliedCents: number;
  glEntryId: string | null; invoiceId: string | null; customerId: string;
  customerName: string; locationName: string; locationCode: string;
  linkedInvoice: { id: string; invoiceNumber: string; balanceCents: number; status: string } | null;
  lines: { id: string; description: string | null; amountCents: number; accountNumber: string; accountName: string }[];
}
interface OpenInvoiceOption { id: string; invoiceNumber: string; balanceCents: number; customerId: string }

function CreditMemoDrawer({ memoId, onClose, onChanged }: {
  memoId: string | null; onClose: () => void; onChanged: () => void;
}) {
  const { data, isLoading, error, refetch } = useQuery<MemoDetail>(
    memoId ? `/api/credit-memos/${memoId}` : '', undefined, { enabled: !!memoId },
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [applyInvoiceId, setApplyInvoiceId] = useState('');

  useEffect(() => { setApplyInvoiceId(''); }, [memoId]);

  // For an unlinked POSTED credit, offer the customer's other open invoices.
  const needsPicker = !!data && data.status === 'POSTED' && !data.linkedInvoice;
  const { data: invResp } = useQuery<{ data: { id: string; invoiceNumber: string; balanceCents: number; customer: { id: string } | null; status: string }[] }>(
    needsPicker && data ? `/api/invoices?customer_id=${data.customerId}` : '', undefined, { enabled: needsPicker },
  );
  const openInvoices: OpenInvoiceOption[] = useMemo(() => {
    if (!invResp || !data) return [];
    return invResp.data
      .filter((i) => i.balanceCents > 0 && i.status !== 'DRAFT' && i.status !== 'VOIDED')
      .map((i) => ({ id: i.id, invoiceNumber: i.invoiceNumber, balanceCents: i.balanceCents, customerId: i.customer?.id ?? '' }));
  }, [invResp, data]);

  async function act(path: string, body?: unknown, ok?: string) {
    if (!memoId) return;
    setBusy(path);
    try {
      const res = await fetch(`/api/credit-memos/${memoId}/${path}`, {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const result = await res.json().catch(() => ({}));
      if (res.ok && result.ok) {
        addToast('success', ok ?? 'Done');
        refetch(); onChanged();
      } else {
        addToast('error', result.error ?? 'Action failed');
      }
    } catch {
      addToast('error', 'Network error');
    } finally {
      setBusy(null);
    }
  }

  const applyTarget = data?.linkedInvoice?.id || applyInvoiceId;

  return (
    <DetailDrawer
      open={!!memoId}
      onClose={onClose}
      width="lg"
      title={data?.creditNumber ? `Credit ${data.creditNumber}` : 'Credit memo'}
      subtitle={data ? `${data.customerName}${data.locationCode ? ` · ${data.locationCode}` : ''}` : null}
      isLoading={isLoading}
      error={error}
      headerRight={data ? <MemoStatusBadge status={data.status} /> : undefined}
    >
      {data && (
        <>
          <DetailSection title="Credit memo">
            <DetailField label="Customer" value={data.customerName || '--'} />
            <DetailField label="Company" value={data.locationName || '--'} />
            <DetailField label="Date" value={data.creditDate} mono />
            {data.reason && <DetailField label="Reason" value={data.reason} />}
            {data.memo && <DetailField label="Memo" value={data.memo} />}
            {data.linkedInvoice && (
              <DetailField label="Linked invoice" value={`${data.linkedInvoice.invoiceNumber} · open ${formatMoney(data.linkedInvoice.balanceCents)}`} />
            )}
          </DetailSection>

          <h3 className="text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-2">Lines ({data.lines.length})</h3>
          <DetailTable columns={[{ key: 'd', label: 'Description' }, { key: 'a', label: 'Amount', align: 'right' }]}>
            {data.lines.map((l) => (
              <tr key={l.id}>
                <td className="px-3 py-2">
                  <div className="text-sm text-slate-200">{l.description || 'Credit'}</div>
                  <div className="text-2xs text-slate-500 mt-0.5 font-mono">{l.accountNumber} · {l.accountName}</div>
                </td>
                <td className="px-3 py-2 text-right text-sm font-mono tabular-nums text-slate-200">{formatMoney(l.amountCents)}</td>
              </tr>
            ))}
          </DetailTable>

          <DetailSection title="">
            <DetailField label="Subtotal" value={formatMoney(data.subtotalCents)} mono />
            <DetailField label="Tax" value={formatMoney(data.taxCents)} mono />
            <DetailField label="Total credit" value={formatMoney(data.totalCents)} mono />
            <DetailField label="Applied" value={formatMoney(data.appliedCents)} mono />
            <DetailField label="Open credit" value={formatMoney(data.unappliedCents)} mono />
          </DetailSection>

          {/* Actions by lifecycle state */}
          <div className="mt-5 pt-4 border-t border-slate-800 space-y-3">
            {data.status === 'DRAFT' && (
              <div className="flex items-center gap-2">
                <button onClick={() => act('post', undefined, 'Credit memo posted to GL')} disabled={busy === 'post'}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50">
                  {busy === 'post' ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Post to GL
                </button>
                <button onClick={() => { if (confirm('Void this draft credit memo? The number is retained for audit.')) act('void', undefined, 'Credit memo voided'); }} disabled={busy === 'void'}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-50">
                  {busy === 'void' ? <Loader2 size={14} className="animate-spin" /> : <Ban size={14} />} Void
                </button>
              </div>
            )}

            {data.status === 'POSTED' && data.unappliedCents > 0 && (
              <div className="rounded-lg border border-slate-700 bg-slate-800/30 p-3 space-y-2">
                <div className="flex items-center gap-2 text-sm text-slate-200 font-medium">
                  <Link2 size={14} className="text-emerald-400" /> Apply {formatMoney(data.unappliedCents)} credit
                </div>
                {data.linkedInvoice ? (
                  <p className="text-2xs text-slate-400">
                    To invoice {data.linkedInvoice.invoiceNumber} (open {formatMoney(data.linkedInvoice.balanceCents)}).
                  </p>
                ) : (
                  <select value={applyInvoiceId} onChange={(e) => setApplyInvoiceId(e.target.value)}
                    className="w-full px-2 py-1.5 rounded bg-slate-800/60 border border-slate-700 text-xs text-slate-200">
                    <option value="">Select an open invoice…</option>
                    {openInvoices.map((i) => (
                      <option key={i.id} value={i.id}>{i.invoiceNumber} · open {formatMoney(i.balanceCents)}</option>
                    ))}
                  </select>
                )}
                <button
                  onClick={() => act('apply', applyTarget ? { invoice_id: applyTarget } : {}, 'Credit applied to invoice')}
                  disabled={busy === 'apply' || !applyTarget}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50">
                  {busy === 'apply' ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Apply credit
                </button>
              </div>
            )}

            {data.status === 'POSTED' && data.glEntryId && (
              <p className="text-2xs text-slate-500 font-mono">GL entry {data.glEntryId}</p>
            )}
            {data.status === 'APPLIED' && (
              <p className="text-xs text-emerald-400">Fully applied — this credit has been consumed against invoice balances.</p>
            )}
            {data.status === 'VOIDED' && (
              <p className="text-xs text-slate-500">Voided before posting. No GL impact.</p>
            )}
          </div>
        </>
      )}
    </DetailDrawer>
  );
}

// ─── Create modal ─────────────────────────────────────────────────────
interface CMLine { account_id: string; description: string; amount_cents: number }

function CreateCreditMemoModal({ prefill, onClose, onCreated }: {
  prefill: CreditMemoPrefill | null; onClose: () => void; onCreated: () => void;
}) {
  const [locationId, setLocationId] = useState(prefill?.locationId ?? '');
  const [customerId, setCustomerId] = useState(prefill?.customerId ?? '');
  const [invoiceId, setInvoiceId] = useState(prefill?.invoiceId ?? '');
  const [creditDate, setCreditDate] = useState(new Date().toISOString().split('T')[0]);
  const [reason, setReason] = useState('');
  const [memo, setMemo] = useState('');
  const [taxCents, setTaxCents] = useState(0);
  const [lines, setLines] = useState<CMLine[]>([{ account_id: '', description: '', amount_cents: 0 }]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  const { data: locData } = useQuery<{ data: LocationOption[] }>('/api/locations');
  const { data: custData } = useQuery<{ data: CustomerOption[] }>('/api/customers?per_page=200');
  const { data: acctData } = useQuery<{ data: AccountOption[] }>(
    locationId ? `/api/accounts/search?location_id=${locationId}&q=4` : null,
  );
  // Open invoices for the chosen customer, to optionally link the credit.
  const { data: invData } = useQuery<{ data: { id: string; invoiceNumber: string; balanceCents: number; customer: { id: string } | null; status: string }[] }>(
    customerId ? `/api/invoices?customer_id=${customerId}` : null,
  );

  const locations = locData?.data ?? [];
  const customers = custData?.data ?? [];
  const accounts = acctData?.data ?? [];
  const linkableInvoices = (invData?.data ?? []).filter((i) => i.balanceCents > 0 && i.status !== 'DRAFT' && i.status !== 'VOIDED');

  const subtotal = lines.reduce((s, l) => s + Math.max(0, l.amount_cents), 0);
  const total = subtotal + taxCents;

  const updateLine = (i: number, patch: Partial<CMLine>) => setLines((p) => p.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function submit() {
    setFormError('');
    if (!locationId || !customerId || !creditDate) { setFormError('Company, customer, and date are required'); return; }
    if (lines.some((l) => !l.account_id || l.amount_cents <= 0)) { setFormError('Each line needs an account and a positive amount'); return; }
    setSubmitting(true);
    try {
      const res = await fetch('/api/credit-memos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_id: locationId,
          customer_id: customerId,
          invoice_id: invoiceId || undefined,
          credit_date: creditDate,
          reason: reason || undefined,
          memo: memo || undefined,
          tax_cents: taxCents,
          lines: lines.map((l) => ({ account_id: l.account_id, description: l.description || undefined, amount_cents: l.amount_cents })),
        }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) { setFormError(result.error ?? 'Failed to create credit memo'); return; }
      addToast('success', `Credit memo ${result.credit_number} created`);
      onCreated();
    } catch {
      setFormError('Network error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center pt-8 overflow-y-auto">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl mb-8">
        <div className="flex items-center justify-between p-6 border-b border-gray-700/50">
          <h2 className="text-lg font-semibold text-white">Create Credit Memo</h2>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-6 space-y-5">
          {formError && <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">{formError}</div>}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Company *</label>
              <select value={locationId} onChange={(e) => setLocationId(e.target.value)} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white">
                <option value="">Select company</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Customer *</label>
              <select value={customerId} onChange={(e) => { setCustomerId(e.target.value); setInvoiceId(''); }} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white">
                <option value="">Select customer</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Credit date *</label>
              <input type="date" value={creditDate} onChange={(e) => setCreditDate(e.target.value)} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Apply to invoice (optional)</label>
              <select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} disabled={!customerId} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white disabled:opacity-50">
                <option value="">No linked invoice</option>
                {linkableInvoices.map((i) => <option key={i.id} value={i.id}>{i.invoiceNumber} · open {formatMoney(i.balanceCents)}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Reason</label>
              <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Overbilled, returned goods" className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder:text-gray-600" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Memo</label>
              <input type="text" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Internal note" className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder:text-gray-600" />
            </div>
          </div>

          {/* Lines */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-gray-400 uppercase tracking-wider">Credit lines (revenue account to reverse)</label>
              <button onClick={() => setLines((p) => [...p, { account_id: '', description: '', amount_cents: 0 }])} className="text-xs text-emerald-400 hover:text-emerald-300">+ Add line</button>
            </div>
            <div className="space-y-2">
              {lines.map((l, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-center">
                  <select value={l.account_id} onChange={(e) => updateLine(i, { account_id: e.target.value })} className="col-span-5 px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-white">
                    <option value="">GL account…</option>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.account_number} · {a.name}</option>)}
                  </select>
                  <input type="text" value={l.description} onChange={(e) => updateLine(i, { description: e.target.value })} placeholder="Description" className="col-span-4 px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-white placeholder:text-gray-600" />
                  <input type="number" min={0} step={0.01} value={(l.amount_cents / 100).toFixed(2)} onChange={(e) => updateLine(i, { amount_cents: Math.round((parseFloat(e.target.value) || 0) * 100) })} className="col-span-2 px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-white text-right font-mono" />
                  <button onClick={() => setLines((p) => (p.length > 1 ? p.filter((_, j) => j !== i) : p))} className="col-span-1 p-1 text-gray-500 hover:text-red-400"><X className="w-4 h-4" /></button>
                </div>
              ))}
            </div>
          </div>

          {/* Totals */}
          <div className="border-t border-gray-700/50 pt-4 space-y-2">
            <div className="flex justify-between text-sm"><span className="text-gray-400">Subtotal</span><span className="font-mono text-white">{formatMoney(subtotal)}</span></div>
            <div className="flex justify-between text-sm items-center">
              <span className="text-gray-400">Tax to reverse</span>
              <input type="number" min={0} step={0.01} value={(taxCents / 100).toFixed(2)} onChange={(e) => setTaxCents(Math.round((parseFloat(e.target.value) || 0) * 100))} className="w-24 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm text-white text-right font-mono" />
            </div>
            <div className="flex justify-between text-base font-semibold border-t border-gray-700/50 pt-2"><span className="text-white">Total credit</span><span className="font-mono text-emerald-400">{formatMoney(total)}</span></div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 p-6 border-t border-gray-700/50">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>
          <button onClick={submit} disabled={submitting} className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium">
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create Credit Memo
          </button>
        </div>
      </div>
    </div>
  );
}
