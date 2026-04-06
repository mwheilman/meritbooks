'use client';

import { useState, useEffect, useCallback } from 'react';
import { useQuery } from '@/hooks/use-query';
import { formatMoney } from '@meritbooks/shared';
import {
  FileText, Plus, DollarSign, Clock, AlertCircle, Search, ChevronDown,
  Check, Send, CreditCard, X, Loader2, Building2
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────

interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  totalCents: number;
  amountPaidCents: number;
  balanceCents: number;
  status: string;
  isProgressBill: boolean;
  daysOverdue: number;
  memo: string | null;
  customer: { id: string; name: string; email: string | null } | null;
  location: { id: string; name: string; shortCode: string } | null;
  job: { id: string; jobNumber: string; name: string } | null;
}

interface StatusCounts {
  [key: string]: { count: number; totalCents: number; balanceCents: number };
}

interface CustomerOption {
  id: string;
  name: string;
  email: string | null;
  paymentTermsDays: number;
}

interface LocationOption {
  id: string;
  name: string;
  short_code: string;
}

// ─── Invoice List Component ───────────────────────────────────────────

function InvoiceList({
  onCreateClick,
  onPaymentClick,
}: {
  onCreateClick: () => void;
  onPaymentClick: (inv: InvoiceRow) => void;
}) {
  const [status, setStatus] = useState('ALL');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [locationId, setLocationId] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const params = new URLSearchParams();
  if (status !== 'ALL') params.set('status', status);
  if (debouncedSearch) params.set('search', debouncedSearch);
  if (locationId) params.set('location_id', locationId);

  const { data, isLoading, error } = useQuery<{
    data: InvoiceRow[];
    counts: StatusCounts;
  }>(`/api/invoices?${params}`);

  const { data: locData } = useQuery<{ data: LocationOption[] }>('/api/locations');
  const locations = locData?.data ?? [];

  const invoices = data?.data ?? [];
  const counts = data?.counts ?? {};

  const tabs = ['ALL', 'DRAFT', 'SENT', 'PARTIALLY_PAID', 'OVERDUE', 'PAID'];

  if (error) {
    return (
      <div className="p-8 text-center">
        <AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" />
        <p className="text-red-400">Failed to load invoices</p>
        <p className="text-sm text-gray-500 mt-1">{error}</p>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-white">Invoices & AR</h1>
          <p className="text-sm text-gray-400 mt-1">Create, send, and track customer invoices</p>
        </div>
        <button
          onClick={onCreateClick}
          className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-medium transition-colors"
        >
          <Plus className="w-4 h-4" />
          New Invoice
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Outstanding', value: counts.SENT?.balanceCents ?? 0, icon: FileText, color: 'text-blue-400' },
          { label: 'Overdue', value: counts.OVERDUE?.balanceCents ?? 0, icon: AlertCircle, color: 'text-red-400' },
          { label: 'Paid This Month', value: counts.PAID?.totalCents ?? 0, icon: Check, color: 'text-emerald-400' },
          { label: 'Draft', value: counts.DRAFT?.totalCents ?? 0, icon: Clock, color: 'text-gray-400' },
        ].map((card) => (
          <div key={card.label} className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-gray-400">{card.label}</span>
              <card.icon className={`w-4 h-4 ${card.color}`} />
            </div>
            <p className="text-xl font-mono font-semibold text-white">{formatMoney(card.value)}</p>
            <p className="text-xs text-gray-500 mt-1">{counts[card.label === 'Outstanding' ? 'SENT' : card.label === 'Overdue' ? 'OVERDUE' : card.label === 'Paid This Month' ? 'PAID' : 'DRAFT']?.count ?? 0} invoices</p>
          </div>
        ))}
      </div>

      {/* Company filter + search */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative">
          <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <select
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            className="pl-9 pr-8 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white appearance-none cursor-pointer"
          >
            <option value="">All Companies</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
          <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
        </div>
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="text"
            placeholder="Search invoices..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder:text-gray-500"
          />
        </div>
      </div>

      {/* Status tabs */}
      <div className="flex gap-1 mb-4 border-b border-gray-700/50 pb-px">
        {tabs.map((t) => {
          const c = counts[t];
          return (
            <button
              key={t}
              onClick={() => setStatus(t)}
              className={`px-3 py-2 text-sm rounded-t-lg transition-colors ${
                status === t
                  ? 'bg-gray-800 text-emerald-400 border-b-2 border-emerald-400'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              {t.replace('_', ' ')} <span className="text-xs ml-1 opacity-70">{c?.count ?? 0}</span>
            </button>
          );
        })}
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 text-emerald-400 animate-spin" />
        </div>
      ) : invoices.length === 0 ? (
        <div className="text-center py-16">
          <FileText className="w-10 h-10 text-gray-600 mx-auto mb-3" />
          <p className="text-gray-400 font-medium">No invoices</p>
          <p className="text-sm text-gray-500 mt-1">Create your first invoice to get started</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-700/50">
                <th className="pb-3 pr-4">Invoice #</th>
                <th className="pb-3 pr-4">Customer</th>
                <th className="pb-3 pr-4">Company</th>
                <th className="pb-3 pr-4">Date</th>
                <th className="pb-3 pr-4">Due</th>
                <th className="pb-3 pr-4 text-right">Total</th>
                <th className="pb-3 pr-4 text-right">Paid</th>
                <th className="pb-3 pr-4 text-right">Balance</th>
                <th className="pb-3 pr-4">Status</th>
                <th className="pb-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                  <td className="py-3 pr-4">
                    <span className="font-mono text-white">{inv.invoiceNumber}</span>
                    {inv.isProgressBill && (
                      <span className="ml-2 px-1.5 py-0.5 text-xs bg-indigo-500/20 text-indigo-300 rounded">AIA</span>
                    )}
                  </td>
                  <td className="py-3 pr-4 text-gray-300">{inv.customer?.name ?? '—'}</td>
                  <td className="py-3 pr-4">
                    {inv.location && (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-6 h-6 rounded bg-gray-700 text-[10px] font-mono text-gray-300 flex items-center justify-center">
                          {inv.location.shortCode}
                        </span>
                        <span className="text-gray-400 text-xs">{inv.location.name}</span>
                      </span>
                    )}
                  </td>
                  <td className="py-3 pr-4 font-mono text-gray-400 text-xs">{inv.invoiceDate}</td>
                  <td className="py-3 pr-4">
                    <span className={`font-mono text-xs ${inv.daysOverdue > 0 && inv.status !== 'PAID' ? 'text-red-400' : 'text-gray-400'}`}>
                      {inv.dueDate}
                    </span>
                    {inv.daysOverdue > 0 && inv.status !== 'PAID' && (
                      <span className="ml-1 text-[10px] text-red-400">{inv.daysOverdue}d late</span>
                    )}
                  </td>
                  <td className="py-3 pr-4 text-right font-mono text-white">{formatMoney(inv.totalCents)}</td>
                  <td className="py-3 pr-4 text-right font-mono text-gray-400">{formatMoney(inv.amountPaidCents)}</td>
                  <td className="py-3 pr-4 text-right font-mono text-white font-medium">{formatMoney(inv.balanceCents)}</td>
                  <td className="py-3 pr-4">
                    <StatusBadge status={inv.status} />
                  </td>
                  <td className="py-3">
                    {inv.status !== 'PAID' && inv.status !== 'VOIDED' && inv.status !== 'DRAFT' && (
                      <button
                        onClick={() => onPaymentClick(inv)}
                        className="p-1.5 text-gray-400 hover:text-emerald-400 hover:bg-gray-700/50 rounded transition-colors"
                        title="Receive payment"
                      >
                        <DollarSign className="w-4 h-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { bg: string; text: string; label: string }> = {
    DRAFT: { bg: 'bg-gray-500/20', text: 'text-gray-300', label: 'Draft' },
    SENT: { bg: 'bg-blue-500/20', text: 'text-blue-300', label: 'Sent' },
    PARTIALLY_PAID: { bg: 'bg-amber-500/20', text: 'text-amber-300', label: 'Partial' },
    PAID: { bg: 'bg-emerald-500/20', text: 'text-emerald-300', label: 'Paid' },
    OVERDUE: { bg: 'bg-red-500/20', text: 'text-red-300', label: 'Overdue' },
    VOIDED: { bg: 'bg-gray-500/20', text: 'text-gray-500', label: 'Voided' },
  };
  const c = config[status] ?? config.DRAFT;
  return <span className={`px-2 py-0.5 text-xs rounded-full ${c.bg} ${c.text}`}>{c.label}</span>;
}

// ─── Create Invoice Form ──────────────────────────────────────────────

interface InvoiceLine {
  description: string;
  account_id: string;
  quantity: number;
  unit_price_cents: number;
}

function CreateInvoiceForm({
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

  const subtotal = lines.reduce((s, l) => s + Math.round(l.quantity * l.unit_price_cents), 0);
  const total = subtotal + taxCents;

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
    <div className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center pt-8 overflow-y-auto">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-3xl mb-8">
        <div className="flex items-center justify-between p-6 border-b border-gray-700/50">
          <h2 className="text-lg font-semibold text-white">Create Invoice</h2>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-6 space-y-5">
          {formError && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">{formError}</div>
          )}

          {/* Top row: company, customer, dates */}
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
              <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white">
                <option value="">Select customer</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Invoice Date *</label>
              <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Due Date *</label>
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Memo</label>
              <input type="text" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Optional" className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder:text-gray-500" />
            </div>
          </div>

          {/* Line items */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-gray-400 uppercase tracking-wider">Line Items</label>
              <button onClick={addLine} className="text-xs text-emerald-400 hover:text-emerald-300">+ Add line</button>
            </div>
            <div className="space-y-2">
              {lines.map((line, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-end">
                  <div className="col-span-4">
                    {i === 0 && <label className="block text-[10px] text-gray-500 mb-0.5">Description</label>}
                    <input
                      type="text" value={line.description} onChange={(e) => updateLine(i, 'description', e.target.value)}
                      placeholder="Service or item description"
                      className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-white placeholder:text-gray-600"
                    />
                  </div>
                  <div className="col-span-3">
                    {i === 0 && <label className="block text-[10px] text-gray-500 mb-0.5">GL Account</label>}
                    <select value={line.account_id} onChange={(e) => updateLine(i, 'account_id', e.target.value)}
                      className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-white">
                      <option value="">Select account</option>
                      {accounts.map((a) => <option key={a.id} value={a.id}>{a.account_number} · {a.name}</option>)}
                    </select>
                  </div>
                  <div className="col-span-1">
                    {i === 0 && <label className="block text-[10px] text-gray-500 mb-0.5">Qty</label>}
                    <input type="number" value={line.quantity} min={0} step={0.01}
                      onChange={(e) => updateLine(i, 'quantity', parseFloat(e.target.value) || 0)}
                      className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-white text-right font-mono"
                    />
                  </div>
                  <div className="col-span-2">
                    {i === 0 && <label className="block text-[10px] text-gray-500 mb-0.5">Unit Price</label>}
                    <input type="number" value={(line.unit_price_cents / 100).toFixed(2)} min={0} step={0.01}
                      onChange={(e) => updateLine(i, 'unit_price_cents', Math.round(parseFloat(e.target.value) * 100) || 0)}
                      className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-white text-right font-mono"
                    />
                  </div>
                  <div className="col-span-1 text-right font-mono text-sm text-white py-1.5">
                    {formatMoney(Math.round(line.quantity * line.unit_price_cents))}
                  </div>
                  <div className="col-span-1">
                    {lines.length > 1 && (
                      <button onClick={() => removeLine(i)} className="p-1 text-gray-500 hover:text-red-400"><X className="w-4 h-4" /></button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Totals */}
          <div className="border-t border-gray-700/50 pt-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">Subtotal</span>
              <span className="font-mono text-white">{formatMoney(subtotal)}</span>
            </div>
            <div className="flex justify-between text-sm items-center">
              <span className="text-gray-400">Tax</span>
              <input type="number" value={(taxCents / 100).toFixed(2)} min={0} step={0.01}
                onChange={(e) => setTaxCents(Math.round(parseFloat(e.target.value) * 100) || 0)}
                className="w-24 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm text-white text-right font-mono"
              />
            </div>
            <div className="flex justify-between text-base font-semibold border-t border-gray-700/50 pt-2">
              <span className="text-white">Total</span>
              <span className="font-mono text-emerald-400">{formatMoney(total)}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 p-6 border-t border-gray-700/50">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium"
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Create Invoice
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Payment Application Dialog ───────────────────────────────────────

function PaymentDialog({
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
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md">
        <div className="flex items-center justify-between p-5 border-b border-gray-700/50">
          <div>
            <h2 className="text-base font-semibold text-white">Receive Payment</h2>
            <p className="text-xs text-gray-400 mt-0.5">Invoice {invoice.invoiceNumber} — {invoice.customer?.name}</p>
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-5 space-y-4">
          {formError && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">{formError}</div>
          )}

          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-400">Invoice balance</span>
            <span className="font-mono text-white font-medium">{formatMoney(invoice.balanceCents)}</span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Amount *</label>
              <input type="number" value={(amountCents / 100).toFixed(2)} min={0} step={0.01}
                onChange={(e) => setAmountCents(Math.round(parseFloat(e.target.value) * 100) || 0)}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white font-mono text-right"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Date *</label>
              <input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Method</label>
              <select value={method} onChange={(e) => setMethod(e.target.value)}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white">
                <option value="CHECK">Check</option>
                <option value="ACH">ACH</option>
                <option value="WIRE">Wire</option>
                <option value="CREDIT_CARD">Credit Card</option>
                <option value="CASH">Cash</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Reference #</label>
              <input type="text" value={reference} onChange={(e) => setReference(e.target.value)}
                placeholder="Check # or ref"
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder:text-gray-500"
              />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 p-5 border-t border-gray-700/50">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>
          <button onClick={handleSubmit} disabled={submitting}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium">
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />}
            Apply Payment
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Manager ─────────────────────────────────────────────────────

export function InvoiceManager() {
  const [showCreate, setShowCreate] = useState(false);
  const [paymentInvoice, setPaymentInvoice] = useState<InvoiceRow | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setShowCreate(false);
    setPaymentInvoice(null);
  }, []);

  return (
    <div className="p-6" key={refreshKey}>
      <InvoiceList
        onCreateClick={() => setShowCreate(true)}
        onPaymentClick={(inv) => setPaymentInvoice(inv)}
      />
      {showCreate && <CreateInvoiceForm onClose={() => setShowCreate(false)} onCreated={refresh} />}
      {paymentInvoice && <PaymentDialog invoice={paymentInvoice} onClose={() => setPaymentInvoice(null)} onPaid={refresh} />}
    </div>
  );
}
