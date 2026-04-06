'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Search, Plus, X, Truck, AlertTriangle, Check, FileText,
  ChevronDown, ChevronUp, Loader2, ExternalLink, Shield,
} from 'lucide-react';

interface Vendor {
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
  is_1099: boolean;
  tax_id: string | null;
  notes: string | null;
  website: string | null;
  ai_confidence: number;
  auto_approve: boolean;
  created_at: string;
  compliance: {
    w9: 'valid' | 'expired' | 'missing';
    glCoi: 'valid' | 'expired' | 'missing';
    wcCoi: 'valid' | 'expired' | 'missing';
    hasActiveHold: boolean;
  };
}

interface VendorFormData {
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
  is_1099: boolean;
  tax_id: string;
  notes: string;
  website: string;
}

const EMPTY_FORM: VendorFormData = {
  name: '', display_name: '', email: '', phone: '',
  address_line1: '', address_line2: '', city: '', state: '', zip: '',
  payment_terms: 'NET_30', is_1099: false, tax_id: '', notes: '', website: '',
};

const PAYMENT_TERMS = [
  { value: 'NET_10', label: 'Net 10' },
  { value: 'NET_15', label: 'Net 15' },
  { value: 'NET_30', label: 'Net 30' },
  { value: 'NET_45', label: 'Net 45' },
  { value: 'NET_60', label: 'Net 60' },
  { value: 'NET_90', label: 'Net 90' },
  { value: 'DUE_ON_RECEIPT', label: 'Due on Receipt' },
  { value: '2_10_NET_30', label: '2/10 Net 30' },
];

function ComplianceBadge({ status }: { status: 'valid' | 'expired' | 'missing' }) {
  if (status === 'valid') return <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-emerald-500/15 text-emerald-400"><Check className="w-3 h-3" /></span>;
  if (status === 'expired') return <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-amber-500/15 text-amber-400"><AlertTriangle className="w-3 h-3" /></span>;
  return <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-red-500/15 text-red-400"><X className="w-3 h-3" /></span>;
}

export default function VendorsPage() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<VendorFormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicateWarning, setDuplicateWarning] = useState<Array<{ id: string; name: string }> | null>(null);
  const [sortBy, setSortBy] = useState('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [total, setTotal] = useState(0);
  const [filter1099, setFilter1099] = useState(false);

  const fetchVendors = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        search, sort_by: sortBy, sort_dir: sortDir,
        ...(filter1099 ? { is_1099: 'true' } : {}),
      });
      const res = await fetch(`/api/vendors?${params}`);
      const data = await res.json();
      setVendors(data.vendors ?? []);
      setTotal(data.total ?? 0);
    } catch {
      setError('Failed to load vendors');
    } finally {
      setLoading(false);
    }
  }, [search, sortBy, sortDir, filter1099]);

  useEffect(() => {
    const timer = setTimeout(fetchVendors, 300);
    return () => clearTimeout(timer);
  }, [fetchVendors]);

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
    if (!form.name.trim()) { setError('Vendor name is required'); return; }
    setSaving(true);
    setError(null);
    setDuplicateWarning(null);

    try {
      const res = await fetch('/api/vendors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();

      if (res.status === 409) {
        setDuplicateWarning(data.duplicates);
        setSaving(false);
        return;
      }

      if (!res.ok) {
        setError(data.error || 'Failed to create vendor');
        setSaving(false);
        return;
      }

      setShowCreate(false);
      setForm(EMPTY_FORM);
      fetchVendors();
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
      const res = await fetch('/api/vendors', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: editingId, ...form }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to update vendor');
        setSaving(false);
        return;
      }

      setEditingId(null);
      setForm(EMPTY_FORM);
      fetchVendors();
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (vendor: Vendor) => {
    setEditingId(vendor.id);
    setShowCreate(false);
    setForm({
      name: vendor.name,
      display_name: vendor.display_name || '',
      email: vendor.email || '',
      phone: vendor.phone || '',
      address_line1: vendor.address_line1 || '',
      address_line2: '',
      city: vendor.city || '',
      state: vendor.state || '',
      zip: vendor.zip || '',
      payment_terms: vendor.payment_terms || 'NET_30',
      is_1099: vendor.is_1099,
      tax_id: vendor.tax_id || '',
      notes: vendor.notes || '',
      website: vendor.website || '',
    });
  };

  const isFormOpen = showCreate || editingId !== null;

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-white flex items-center gap-2">
            <Truck className="w-5 h-5 text-emerald-400" />
            Vendors
          </h1>
          <p className="text-sm text-zinc-400 mt-1">{total} vendor{total !== 1 ? 's' : ''}</p>
        </div>
        <button
          onClick={() => { setShowCreate(true); setEditingId(null); setForm(EMPTY_FORM); setError(null); setDuplicateWarning(null); }}
          className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-medium transition-colors"
        >
          <Plus className="w-4 h-4" />
          New Vendor
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            type="text"
            placeholder="Search vendors..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-emerald-500/50"
          />
        </div>
        <button
          onClick={() => setFilter1099(!filter1099)}
          className={`px-3 py-2 rounded-lg text-sm border transition-colors ${
            filter1099 ? 'bg-amber-500/15 border-amber-500/30 text-amber-400' : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-zinc-300'
          }`}
        >
          1099 Only
        </button>
      </div>

      {/* Create/Edit Form */}
      {isFormOpen && (
        <div className="mb-6 bg-zinc-800/50 border border-zinc-700 rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-white">
              {showCreate ? 'New Vendor' : 'Edit Vendor'}
            </h3>
            <button onClick={() => { setShowCreate(false); setEditingId(null); setError(null); setDuplicateWarning(null); }} className="text-zinc-500 hover:text-zinc-300">
              <X className="w-4 h-4" />
            </button>
          </div>

          {error && (
            <div className="mb-4 px-4 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
              {error}
            </div>
          )}

          {duplicateWarning && (
            <div className="mb-4 px-4 py-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
              <p className="text-sm text-amber-400 font-medium mb-1">Potential duplicate detected</p>
              <p className="text-xs text-amber-400/70">
                Similar vendor{duplicateWarning.length > 1 ? 's' : ''} already exist: {duplicateWarning.map(d => d.name).join(', ')}
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Vendor Name *</label>
              <input
                type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-emerald-500/50"
                placeholder="ABC Supply Co."
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Display Name</label>
              <input
                type="text" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-emerald-500/50"
                placeholder="ABC Supply"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Payment Terms</label>
              <select
                value={form.payment_terms} onChange={(e) => setForm({ ...form, payment_terms: e.target.value })}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-emerald-500/50"
              >
                {PAYMENT_TERMS.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Email</label>
              <input
                type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-emerald-500/50"
                placeholder="ap@vendor.com"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Phone</label>
              <input
                type="text" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-emerald-500/50"
                placeholder="(515) 555-0100"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Website</label>
              <input
                type="text" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-emerald-500/50"
                placeholder="https://vendor.com"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs text-zinc-400 mb-1">Address</label>
              <input
                type="text" value={form.address_line1} onChange={(e) => setForm({ ...form, address_line1: e.target.value })}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-emerald-500/50"
                placeholder="123 Main St"
              />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <input
                type="text" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })}
                className="px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-emerald-500/50"
                placeholder="City"
              />
              <input
                type="text" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })}
                className="px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-emerald-500/50"
                placeholder="State"
                maxLength={2}
              />
              <input
                type="text" value={form.zip} onChange={(e) => setForm({ ...form, zip: e.target.value })}
                className="px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-emerald-500/50"
                placeholder="ZIP"
              />
            </div>
            <div className="flex items-center gap-6">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox" checked={form.is_1099} onChange={(e) => setForm({ ...form, is_1099: e.target.checked })}
                  className="rounded border-zinc-600 text-emerald-500 focus:ring-emerald-500/30 bg-zinc-900"
                />
                <span className="text-sm text-zinc-300">1099 Contractor</span>
              </label>
            </div>
            {form.is_1099 && (
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Tax ID (EIN/SSN)</label>
                <input
                  type="text" value={form.tax_id} onChange={(e) => setForm({ ...form, tax_id: e.target.value })}
                  className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-emerald-500/50"
                  placeholder="XX-XXXXXXX"
                />
              </div>
            )}
            <div className="md:col-span-3">
              <label className="block text-xs text-zinc-400 mb-1">Notes</label>
              <textarea
                value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-emerald-500/50 min-h-[60px]"
                rows={2}
              />
            </div>
          </div>

          <div className="flex justify-end gap-3 mt-4 pt-4 border-t border-zinc-700">
            <button
              onClick={() => { setShowCreate(false); setEditingId(null); }}
              className="px-4 py-2 text-sm text-zinc-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={showCreate ? handleCreate : handleUpdate}
              disabled={saving}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-600/50 text-white rounded-lg text-sm font-medium transition-colors"
            >
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              {showCreate ? 'Create Vendor' : 'Save Changes'}
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-emerald-400" />
        </div>
      ) : vendors.length === 0 ? (
        <div className="text-center py-16">
          <Truck className="w-12 h-12 text-zinc-600 mx-auto mb-3" />
          <p className="text-zinc-400 text-sm">
            {search ? 'No vendors match your search' : 'No vendors yet'}
          </p>
          {!search && (
            <button
              onClick={() => { setShowCreate(true); setForm(EMPTY_FORM); }}
              className="mt-3 text-emerald-400 hover:text-emerald-300 text-sm"
            >
              Create your first vendor
            </button>
          )}
        </div>
      ) : (
        <div className="bg-zinc-800/30 border border-zinc-700/50 rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-zinc-700/50">
                <th
                  onClick={() => handleSort('name')}
                  className="text-left px-4 py-3 text-xs font-medium text-zinc-400 uppercase tracking-wider cursor-pointer hover:text-zinc-300"
                >
                  <span className="flex items-center gap-1">Vendor <SortIcon col="name" /></span>
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-zinc-400 uppercase tracking-wider">Contact</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-zinc-400 uppercase tracking-wider">Terms</th>
                <th className="text-center px-4 py-3 text-xs font-medium text-zinc-400 uppercase tracking-wider">
                  <span className="flex items-center gap-1 justify-center"><Shield className="w-3 h-3" /> Compliance</span>
                </th>
                <th className="text-center px-4 py-3 text-xs font-medium text-zinc-400 uppercase tracking-wider">1099</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-zinc-400 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody>
              {vendors.map((v) => (
                <tr key={v.id} className="border-b border-zinc-800 hover:bg-zinc-800/50 transition-colors">
                  <td className="px-4 py-3">
                    <div className="text-sm font-medium text-white">{v.display_name || v.name}</div>
                    {v.display_name && v.display_name !== v.name && (
                      <div className="text-xs text-zinc-500">{v.name}</div>
                    )}
                    {v.city && v.state && (
                      <div className="text-xs text-zinc-500">{v.city}, {v.state}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {v.email && <div className="text-sm text-zinc-300">{v.email}</div>}
                    {v.phone && <div className="text-xs text-zinc-500">{v.phone}</div>}
                    {!v.email && !v.phone && <span className="text-xs text-zinc-600">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-sm text-zinc-300">
                      {PAYMENT_TERMS.find((t) => t.value === v.payment_terms)?.label || v.payment_terms}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-center gap-2">
                      <div className="flex items-center gap-0.5" title="W-9">
                        <span className="text-[10px] text-zinc-500 mr-0.5">W9</span>
                        <ComplianceBadge status={v.compliance.w9} />
                      </div>
                      <div className="flex items-center gap-0.5" title="GL COI">
                        <span className="text-[10px] text-zinc-500 mr-0.5">GL</span>
                        <ComplianceBadge status={v.compliance.glCoi} />
                      </div>
                      <div className="flex items-center gap-0.5" title="WC COI">
                        <span className="text-[10px] text-zinc-500 mr-0.5">WC</span>
                        <ComplianceBadge status={v.compliance.wcCoi} />
                      </div>
                      {v.compliance.hasActiveHold && (
                        <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-500/15 text-red-400">HOLD</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center">
                    {v.is_1099 ? (
                      <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-amber-500/15 text-amber-400">1099</span>
                    ) : (
                      <span className="text-xs text-zinc-600">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => startEdit(v)}
                      className="text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
                    >
                      Edit
                    </button>
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
