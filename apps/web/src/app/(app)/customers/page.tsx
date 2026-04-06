'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Search, Plus, X, Users, ChevronDown, ChevronUp, Loader2, DollarSign, AlertTriangle,
} from 'lucide-react';

interface Customer {
  id: string;
  name: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  payment_terms: string;
  credit_limit_cents: number | null;
  tax_exempt: boolean;
  contact_first_name: string | null;
  contact_last_name: string | null;
  is_portfolio_company: boolean;
  notes: string | null;
  website: string | null;
  created_at: string;
  ar: {
    totalOutstanding: number;
    overdueCount: number;
  };
}

interface CustomerFormData {
  name: string;
  display_name: string;
  email: string;
  phone: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  zip: string;
  payment_terms: string;
  credit_limit: string;
  tax_exempt: boolean;
  contact_first_name: string;
  contact_last_name: string;
  is_portfolio_company: boolean;
  notes: string;
  website: string;
}

const EMPTY_FORM: CustomerFormData = {
  name: '', display_name: '', email: '', phone: '',
  address_line1: '', address_line2: '', city: '', state: '', zip: '',
  payment_terms: 'NET_30', credit_limit: '', tax_exempt: false,
  contact_first_name: '', contact_last_name: '',
  is_portfolio_company: false, notes: '', website: '',
};

const PAYMENT_TERMS = [
  { value: 'NET_10', label: 'Net 10' },
  { value: 'NET_15', label: 'Net 15' },
  { value: 'NET_30', label: 'Net 30' },
  { value: 'NET_45', label: 'Net 45' },
  { value: 'NET_60', label: 'Net 60' },
  { value: 'DUE_ON_RECEIPT', label: 'Due on Receipt' },
];

function formatMoney(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<CustomerFormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [total, setTotal] = useState(0);

  const fetchCustomers = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ search, sort_by: sortBy, sort_dir: sortDir });
      const res = await fetch(`/api/customers?${params}`);
      const data = await res.json();
      setCustomers(data.customers ?? []);
      setTotal(data.total ?? 0);
    } catch {
      setError('Failed to load customers');
    } finally {
      setLoading(false);
    }
  }, [search, sortBy, sortDir]);

  useEffect(() => {
    const timer = setTimeout(fetchCustomers, 300);
    return () => clearTimeout(timer);
  }, [fetchCustomers]);

  const handleSort = (col: string) => {
    if (sortBy === col) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(col);
      setSortDir('asc');
    }
  };

  const SortIcon = ({ col }: { col: string }) => {
    if (sortBy !== col) return null;
    return sortDir === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />;
  };

  const handleCreate = async () => {
    if (!form.name.trim()) { setError('Customer name is required'); return; }
    setSaving(true);
    setError(null);

    try {
      const res = await fetch('/api/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          credit_limit_cents: form.credit_limit ? Math.round(parseFloat(form.credit_limit) * 100) : null,
        }),
      });
      const data = await res.json();

      if (res.status === 409) {
        setError(`Duplicate: ${data.duplicates?.map((d: { name: string }) => d.name).join(', ')}`);
        setSaving(false);
        return;
      }

      if (!res.ok) {
        setError(data.error || 'Failed to create customer');
        setSaving(false);
        return;
      }

      setShowCreate(false);
      setForm(EMPTY_FORM);
      fetchCustomers();
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  };

  const handleUpdate = async () => {
    if (!editingId) return;
    setSaving(true);
    setError(null);

    try {
      const res = await fetch('/api/customers', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editingId,
          ...form,
          credit_limit_cents: form.credit_limit ? Math.round(parseFloat(form.credit_limit) * 100) : null,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to update customer');
        setSaving(false);
        return;
      }

      setEditingId(null);
      setForm(EMPTY_FORM);
      fetchCustomers();
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (c: Customer) => {
    setEditingId(c.id);
    setShowCreate(false);
    setForm({
      name: c.name,
      display_name: c.display_name || '',
      email: c.email || '',
      phone: c.phone || '',
      address_line1: c.address_line1 || '',
      address_line2: '',
      city: c.city || '',
      state: c.state || '',
      zip: c.zip || '',
      payment_terms: c.payment_terms || 'NET_30',
      credit_limit: c.credit_limit_cents ? (c.credit_limit_cents / 100).toString() : '',
      tax_exempt: c.tax_exempt,
      contact_first_name: c.contact_first_name || '',
      contact_last_name: c.contact_last_name || '',
      is_portfolio_company: c.is_portfolio_company,
      notes: c.notes || '',
      website: c.website || '',
    });
  };

  const isFormOpen = showCreate || editingId !== null;

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-white flex items-center gap-2">
            <Users className="w-5 h-5 text-emerald-400" />
            Customers
          </h1>
          <p className="text-sm text-zinc-400 mt-1">{total} customer{total !== 1 ? 's' : ''}</p>
        </div>
        <button
          onClick={() => { setShowCreate(true); setEditingId(null); setForm(EMPTY_FORM); setError(null); }}
          className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-medium transition-colors"
        >
          <Plus className="w-4 h-4" />
          New Customer
        </button>
      </div>

      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            type="text" placeholder="Search customers..." value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-emerald-500/50"
          />
        </div>
      </div>

      {isFormOpen && (
        <div className="mb-6 bg-zinc-800/50 border border-zinc-700 rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-white">{showCreate ? 'New Customer' : 'Edit Customer'}</h3>
            <button onClick={() => { setShowCreate(false); setEditingId(null); setError(null); }} className="text-zinc-500 hover:text-zinc-300"><X className="w-4 h-4" /></button>
          </div>

          {error && (
            <div className="mb-4 px-4 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">{error}</div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Customer Name *</label>
              <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-emerald-500/50"
                placeholder="Acme Corp" />
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Display Name</label>
              <input type="text" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-emerald-500/50" />
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Payment Terms</label>
              <select value={form.payment_terms} onChange={(e) => setForm({ ...form, payment_terms: e.target.value })}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-emerald-500/50">
                {PAYMENT_TERMS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Primary Contact First Name</label>
              <input type="text" value={form.contact_first_name} onChange={(e) => setForm({ ...form, contact_first_name: e.target.value })}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-emerald-500/50" />
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Primary Contact Last Name</label>
              <input type="text" value={form.contact_last_name} onChange={(e) => setForm({ ...form, contact_last_name: e.target.value })}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-emerald-500/50" />
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Email</label>
              <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-emerald-500/50" />
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Phone</label>
              <input type="text" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-emerald-500/50" />
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Credit Limit ($)</label>
              <input type="number" value={form.credit_limit} onChange={(e) => setForm({ ...form, credit_limit: e.target.value })}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-emerald-500/50"
                placeholder="0.00" step="0.01" />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs text-zinc-400 mb-1">Address</label>
              <input type="text" value={form.address_line1} onChange={(e) => setForm({ ...form, address_line1: e.target.value })}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-emerald-500/50" />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <input type="text" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })}
                className="px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-emerald-500/50" placeholder="City" />
              <input type="text" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })}
                className="px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-emerald-500/50" placeholder="State" maxLength={2} />
              <input type="text" value={form.zip} onChange={(e) => setForm({ ...form, zip: e.target.value })}
                className="px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-emerald-500/50" placeholder="ZIP" />
            </div>
            <div className="flex items-center gap-6">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.tax_exempt} onChange={(e) => setForm({ ...form, tax_exempt: e.target.checked })}
                  className="rounded border-zinc-600 text-emerald-500 focus:ring-emerald-500/30 bg-zinc-900" />
                <span className="text-sm text-zinc-300">Tax Exempt</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.is_portfolio_company} onChange={(e) => setForm({ ...form, is_portfolio_company: e.target.checked })}
                  className="rounded border-zinc-600 text-emerald-500 focus:ring-emerald-500/30 bg-zinc-900" />
                <span className="text-sm text-zinc-300">Portfolio Company</span>
              </label>
            </div>
            <div className="md:col-span-3">
              <label className="block text-xs text-zinc-400 mb-1">Notes</label>
              <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-emerald-500/50"
                rows={2} />
            </div>
          </div>

          <div className="flex justify-end gap-3 mt-4 pt-4 border-t border-zinc-700">
            <button onClick={() => { setShowCreate(false); setEditingId(null); }} className="px-4 py-2 text-sm text-zinc-400 hover:text-white transition-colors">Cancel</button>
            <button onClick={showCreate ? handleCreate : handleUpdate} disabled={saving}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-600/50 text-white rounded-lg text-sm font-medium transition-colors">
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              {showCreate ? 'Create Customer' : 'Save Changes'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-emerald-400" /></div>
      ) : customers.length === 0 ? (
        <div className="text-center py-16">
          <Users className="w-12 h-12 text-zinc-600 mx-auto mb-3" />
          <p className="text-zinc-400 text-sm">{search ? 'No customers match your search' : 'No customers yet'}</p>
          {!search && (
            <button onClick={() => { setShowCreate(true); setForm(EMPTY_FORM); }} className="mt-3 text-emerald-400 hover:text-emerald-300 text-sm">
              Create your first customer
            </button>
          )}
        </div>
      ) : (
        <div className="bg-zinc-800/30 border border-zinc-700/50 rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-zinc-700/50">
                <th onClick={() => handleSort('name')} className="text-left px-4 py-3 text-xs font-medium text-zinc-400 uppercase tracking-wider cursor-pointer hover:text-zinc-300">
                  <span className="flex items-center gap-1">Customer <SortIcon col="name" /></span>
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-zinc-400 uppercase tracking-wider">Contact</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-zinc-400 uppercase tracking-wider">Terms</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-zinc-400 uppercase tracking-wider">Outstanding</th>
                <th className="text-center px-4 py-3 text-xs font-medium text-zinc-400 uppercase tracking-wider">Type</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-zinc-400 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id} className="border-b border-zinc-800 hover:bg-zinc-800/50 transition-colors">
                  <td className="px-4 py-3">
                    <div className="text-sm font-medium text-white">{c.display_name || c.name}</div>
                    {c.city && c.state && <div className="text-xs text-zinc-500">{c.city}, {c.state}</div>}
                  </td>
                  <td className="px-4 py-3">
                    {(c.contact_first_name || c.contact_last_name) && (
                      <div className="text-sm text-zinc-300">{c.contact_first_name} {c.contact_last_name}</div>
                    )}
                    {c.email && <div className="text-xs text-zinc-500">{c.email}</div>}
                    {c.phone && <div className="text-xs text-zinc-500">{c.phone}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-sm text-zinc-300">
                      {PAYMENT_TERMS.find((t) => t.value === c.payment_terms)?.label || c.payment_terms}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {c.ar.totalOutstanding > 0 ? (
                      <div>
                        <span className="text-sm font-mono text-white">{formatMoney(c.ar.totalOutstanding)}</span>
                        {c.ar.overdueCount > 0 && (
                          <div className="flex items-center justify-end gap-1 mt-0.5">
                            <AlertTriangle className="w-3 h-3 text-red-400" />
                            <span className="text-[11px] text-red-400">{c.ar.overdueCount} overdue</span>
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-zinc-600">$0.00</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {c.is_portfolio_company ? (
                      <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-500/15 text-emerald-400">Portfolio</span>
                    ) : (
                      <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-blue-500/15 text-blue-400">External</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => startEdit(c)} className="text-xs text-emerald-400 hover:text-emerald-300 transition-colors">Edit</button>
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
