'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Upload, Plus, Trash2, AlertCircle, Loader2, Check, Send,
  Search, X, ChevronDown, ShieldAlert, AlertTriangle, FileText,
  Camera, Sparkles, Eye
} from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, useMutation } from '@/hooks';
import { formatMoney, dollarsToCents } from '@meritbooks/shared';

// ─── Types ──────────────────────────────────────────────────

interface VendorOption {
  id: string;
  name: string;
  display_name: string | null;
  payment_terms_days: number;
  default_account_id: string | null;
}

interface LocationOption { id: string; name: string; short_code: string }

interface AccountOption {
  id: string;
  account_number: string;
  name: string;
  is_control_account: boolean;
}

interface BillLineState {
  key: string;
  description: string;
  account_id: string;
  accountLabel: string;
  quantity: string;
  unitCost: string;
  amount: string;
  confidence: number | null;
}

interface ParsedResponse {
  parsed: {
    vendorName: string;
    vendorNameConfidence: number;
    billNumber: string | null;
    billNumberConfidence: number;
    billDate: string | null;
    billDateConfidence: number;
    dueDate: string | null;
    dueDateConfidence: number;
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
    totalConfidence: number;
    lines: Array<{
      description: string;
      quantity: number;
      unitCostCents: number;
      amountCents: number;
      confidence: number;
    }>;
    notes: string;
    parseTimeMs: number;
  };
  vendor: { id: string; name: string; confidence: number; paymentTermsDays: number; defaultAccountId: string | null } | null;
  suggestedAccount: { id: string; label: string } | null;
  duplicateWarning: string | null;
}

function genKey() { return Math.random().toString(36).slice(2, 8); }
function emptyLine(): BillLineState {
  return { key: genKey(), description: '', account_id: '', accountLabel: '', quantity: '1', unitCost: '', amount: '', confidence: null };
}

function confidenceColor(c: number): string {
  if (c >= 0.85) return 'text-emerald-400';
  if (c >= 0.6) return 'text-amber-400';
  return 'text-red-400';
}

function confidenceBg(c: number): string {
  if (c >= 0.85) return 'bg-emerald-500/10 border-emerald-500/20';
  if (c >= 0.6) return 'bg-amber-500/10 border-amber-500/20';
  return 'bg-red-500/10 border-red-500/20';
}

// ─── Confidence Badge ───────────────────────────────────────

function ConfBadge({ score }: { score: number | null }) {
  if (score === null) return null;
  const pct = Math.round(score * 100);
  return (
    <span className={clsx('inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-mono font-medium border', confidenceBg(score))}>
      <Sparkles size={8} className={confidenceColor(score)} />
      <span className={confidenceColor(score)}>{pct}%</span>
    </span>
  );
}

// ─── Account Picker ─────────────────────────────────────────

function AccountPicker({ value, label, onChange, locationId }: {
  value: string; label: string;
  onChange: (id: string, label: string) => void;
  locationId: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { const t = setTimeout(() => setDebounced(search), 200); return () => clearTimeout(t); }, [search]);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, []);

  const params: Record<string, string> = {};
  if (debounced.length >= 1) params.q = debounced;
  if (locationId) params.location_id = locationId;

  const { data } = useQuery<{ data: AccountOption[] }>(open ? '/api/accounts/search' : null, Object.keys(params).length > 0 ? params : undefined);
  const accounts = (data?.data ?? []).filter((a) => !a.is_control_account);

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(!open)}
        className={clsx('w-full text-left px-2 py-1.5 rounded-lg border text-xs truncate',
          value ? 'bg-slate-800 border-slate-700 text-white' : 'bg-slate-800/50 border-slate-700/50 text-slate-500')}>
        {label || 'Select account...'}
        <ChevronDown size={10} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500" />
      </button>
      {open && (
        <div className="absolute z-50 top-full mt-1 left-0 w-72 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl overflow-hidden">
          <div className="p-2 border-b border-slate-800">
            <div className="relative">
              <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
              <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search..." autoFocus
                className="w-full pl-7 pr-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-emerald-500/50" />
            </div>
          </div>
          <div className="max-h-40 overflow-y-auto">
            {accounts.length === 0 ? (
              <p className="px-3 py-3 text-xs text-slate-500 text-center">{debounced ? 'No matches' : 'Type to search'}</p>
            ) : accounts.slice(0, 20).map((a) => (
              <button key={a.id} type="button" onClick={() => { onChange(a.id, `${a.account_number} · ${a.name}`); setOpen(false); setSearch(''); }}
                className="w-full text-left px-3 py-1.5 text-xs hover:bg-slate-800 flex items-center gap-2">
                <span className="font-mono text-slate-500 w-12 shrink-0">{a.account_number}</span>
                <span className="text-slate-300 truncate">{a.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Form ──────────────────────────────────────────────

export function BillForm({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  // Upload state
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [documentPreview, setDocumentPreview] = useState<string | null>(null);
  const [isAiParsed, setIsAiParsed] = useState(false);

  // Form state
  const [locationId, setLocationId] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [vendorName, setVendorName] = useState('');
  const [vendorConfidence, setVendorConfidence] = useState<number | null>(null);
  const [billNumber, setBillNumber] = useState('');
  const [billNumberConf, setBillNumberConf] = useState<number | null>(null);
  const [billDate, setBillDate] = useState(new Date().toISOString().split('T')[0]);
  const [billDateConf, setBillDateConf] = useState<number | null>(null);
  const [dueDate, setDueDate] = useState('');
  const [dueDateConf, setDueDateConf] = useState<number | null>(null);
  const [taxCents, setTaxCents] = useState(0);
  const [lines, setLines] = useState<BillLineState[]>([emptyLine()]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [duplicateWarning, setDuplicateWarning] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const { data: locData } = useQuery<LocationOption[]>('/api/locations');
  const locations = locData ?? [];

  const { data: vendorData } = useQuery<{ data: VendorOption[] }>('/api/vendors?per_page=200');
  const vendors = vendorData?.data ?? [];

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Compute totals
  const subtotalCents = useMemo(() =>
    lines.reduce((s, l) => s + dollarsToCents(parseFloat(l.amount) || 0), 0),
    [lines]
  );
  const totalCents = subtotalCents + taxCents;

  // Auto due date from vendor terms
  useEffect(() => {
    if (vendorId && billDate && !isAiParsed) {
      const vendor = vendors.find((v) => v.id === vendorId);
      if (vendor) {
        const d = new Date(billDate);
        d.setDate(d.getDate() + vendor.payment_terms_days);
        setDueDate(d.toISOString().split('T')[0]);
      }
    }
  }, [vendorId, billDate, vendors, isAiParsed]);

  // Auto-calculate line amount from qty × unit cost
  const updateLine = useCallback((key: string, field: keyof BillLineState, value: string) => {
    setLines((prev) => prev.map((l) => {
      if (l.key !== key) return l;
      const updated = { ...l, [field]: value };
      if (field === 'quantity' || field === 'unitCost') {
        const qty = parseFloat(field === 'quantity' ? value : l.quantity) || 0;
        const uc = parseFloat(field === 'unitCost' ? value : l.unitCost) || 0;
        updated.amount = (qty * uc).toFixed(2);
      }
      return updated;
    }));
  }, []);

  // ─── AI Upload Handler ──────────────────────────────────

  const handleFileUpload = useCallback(async (file: File) => {
    setUploading(true);
    setUploadError('');
    setDuplicateWarning('');

    // Show preview for images
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (e) => setDocumentPreview(e.target?.result as string);
      reader.readAsDataURL(file);
    } else {
      setDocumentPreview(null); // PDFs can't preview in img tag
    }

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/bills/parse', { method: 'POST', body: formData });
      const data: ParsedResponse | { error: string } = await res.json();

      if (!res.ok || 'error' in data) {
        setUploadError('error' in data ? data.error : 'Failed to parse document');
        setUploading(false);
        return;
      }

      const { parsed, vendor, suggestedAccount, duplicateWarning: dw } = data as ParsedResponse;

      // Populate form with AI-extracted data
      setIsAiParsed(true);
      setVendorName(parsed.vendorName);
      setVendorConfidence(parsed.vendorNameConfidence);
      setBillNumber(parsed.billNumber ?? '');
      setBillNumberConf(parsed.billNumberConfidence);
      if (parsed.billDate) { setBillDate(parsed.billDate); setBillDateConf(parsed.billDateConfidence); }
      if (parsed.dueDate) { setDueDate(parsed.dueDate); setDueDateConf(parsed.dueDateConfidence); }
      setTaxCents(parsed.taxCents);

      if (vendor) {
        setVendorId(vendor.id);
        setVendorName(vendor.name);
        setVendorConfidence(vendor.confidence);
      }

      if (parsed.lines.length > 0) {
        setLines(parsed.lines.map((pl) => ({
          key: genKey(),
          description: pl.description,
          account_id: suggestedAccount?.id ?? '',
          accountLabel: suggestedAccount?.label ?? '',
          quantity: String(pl.quantity),
          unitCost: (pl.unitCostCents / 100).toFixed(2),
          amount: (pl.amountCents / 100).toFixed(2),
          confidence: pl.confidence,
        })));
      }

      if (dw) setDuplicateWarning(dw);
    } catch {
      setUploadError('Failed to upload file');
    }
    setUploading(false);
  }, []);

  // ─── Submit ─────────────────────────────────────────────

  const handleSubmit = useCallback(async () => {
    setFormError('');
    setSuccessMsg('');

    if (!locationId) { setFormError('Select a company'); return; }
    if (!vendorId) { setFormError('Select or match a vendor'); return; }
    if (!billDate) { setFormError('Enter a bill date'); return; }
    if (!dueDate) { setFormError('Enter a due date'); return; }

    const validLines = lines.filter((l) => l.account_id && parseFloat(l.amount) > 0);
    if (validLines.length === 0) { setFormError('Add at least one line with an amount'); return; }

    setSubmitting(true);

    const payload = {
      location_id: locationId,
      vendor_id: vendorId,
      bill_number: billNumber || undefined,
      bill_date: billDate,
      due_date: dueDate,
      tax_cents: taxCents,
      lines: validLines.map((l) => ({
        description: l.description || undefined,
        account_id: l.account_id,
        quantity: parseFloat(l.quantity) || 1,
        unit_cost_cents: dollarsToCents(parseFloat(l.unitCost) || 0),
        amount_cents: dollarsToCents(parseFloat(l.amount) || 0),
      })),
    };

    try {
      const res = await fetch('/api/bills/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const result = await res.json();

      if (!res.ok) {
        setFormError(result.error ?? 'Failed to create bill');
        setSubmitting(false);
        return;
      }

      const statusMsg = result.compliance_warning
        ? `Bill created (ON HOLD — ${result.compliance_warning})`
        : 'Bill created successfully';
      setSuccessMsg(statusMsg);
      setTimeout(() => onSuccess(), 1500);
    } catch {
      setFormError('Network error');
    }
    setSubmitting(false);
  }, [locationId, vendorId, billNumber, billDate, dueDate, taxCents, lines, onSuccess]);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-white">New Bill</h2>
          {isAiParsed && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
              <Sparkles size={10} /> AI Extracted
            </span>
          )}
        </div>
        <button onClick={onClose} className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white"><X size={18} /></button>
      </div>

      <div className="flex">
        {/* Document preview (left side) */}
        {documentPreview && (
          <div className="w-80 border-r border-slate-800 p-4 shrink-0">
            <p className="text-xs text-slate-500 mb-2 flex items-center gap-1"><Eye size={11} /> Original Document</p>
            <img src={documentPreview} alt="Invoice" className="w-full rounded-lg border border-slate-700" />
          </div>
        )}

        {/* Form (right side) */}
        <div className="flex-1 p-6 space-y-5">
          {/* Upload area */}
          {!isAiParsed && (
            <div
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-slate-700 rounded-xl p-8 text-center cursor-pointer hover:border-indigo-500/40 hover:bg-indigo-500/[0.02] transition-colors"
            >
              <input ref={fileInputRef} type="file" className="hidden" accept=".pdf,.jpg,.jpeg,.png,.webp"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileUpload(f); }} />
              {uploading ? (
                <div className="flex flex-col items-center gap-2">
                  <Loader2 size={24} className="text-indigo-400 animate-spin" />
                  <p className="text-sm text-indigo-300">AI is reading the invoice...</p>
                  <p className="text-xs text-slate-500">Extracting vendor, amounts, line items, and dates</p>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-center gap-3 mb-2">
                    <Upload size={20} className="text-slate-500" />
                    <Camera size={20} className="text-slate-500" />
                    <FileText size={20} className="text-slate-500" />
                  </div>
                  <p className="text-sm text-slate-300">Drop an invoice or click to upload</p>
                  <p className="text-xs text-slate-500 mt-1">PDF, JPEG, PNG, WebP · AI will auto-extract all fields</p>
                </>
              )}
            </div>
          )}

          {uploadError && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20">
              <AlertCircle size={13} className="text-red-400" />
              <p className="text-xs text-red-400">{uploadError}</p>
            </div>
          )}

          {duplicateWarning && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
              <AlertTriangle size={13} className="text-amber-400" />
              <p className="text-xs text-amber-400">{duplicateWarning}</p>
            </div>
          )}

          {/* Divider for manual entry */}
          {!isAiParsed && !uploading && (
            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-slate-800" />
              <span className="text-xs text-slate-600">or enter manually</span>
              <div className="h-px flex-1 bg-slate-800" />
            </div>
          )}

          {/* Form fields */}
          <div className="grid grid-cols-4 gap-4">
            <div>
              <label className="block text-xs text-slate-500 mb-1 font-medium">Company</label>
              <select value={locationId} onChange={(e) => setLocationId(e.target.value)}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white">
                <option value="">Select...</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.short_code} · {l.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1 font-medium flex items-center gap-1">
                Vendor <ConfBadge score={vendorConfidence} />
              </label>
              <select value={vendorId} onChange={(e) => { setVendorId(e.target.value); setVendorConfidence(null); }}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white">
                <option value="">{vendorName && !vendorId ? `"${vendorName}" (no match)` : 'Select vendor...'}</option>
                {vendors.map((v) => <option key={v.id} value={v.id}>{v.display_name ?? v.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1 font-medium flex items-center gap-1">
                Bill # <ConfBadge score={billNumberConf} />
              </label>
              <input type="text" value={billNumber} onChange={(e) => { setBillNumber(e.target.value); setBillNumberConf(null); }}
                placeholder="INV-001" className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white font-mono placeholder:text-slate-600" />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1 font-medium">Tax</label>
              <div className="relative">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-500">$</span>
                <input type="number" value={taxCents / 100} onChange={(e) => setTaxCents(Math.round(parseFloat(e.target.value || '0') * 100))}
                  step="0.01" min="0" className="w-full pl-6 pr-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white font-mono" />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-slate-500 mb-1 font-medium flex items-center gap-1">
                Bill Date <ConfBadge score={billDateConf} />
              </label>
              <input type="date" value={billDate} onChange={(e) => { setBillDate(e.target.value); setBillDateConf(null); }}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white font-mono" />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1 font-medium flex items-center gap-1">
                Due Date <ConfBadge score={dueDateConf} />
              </label>
              <input type="date" value={dueDate} onChange={(e) => { setDueDate(e.target.value); setDueDateConf(null); }}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white font-mono" />
            </div>
          </div>

          {/* Line items */}
          <div className="border border-slate-800 rounded-xl overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-800/30">
                  <th className="px-3 py-2 text-left text-2xs font-semibold uppercase text-slate-500 w-8">#</th>
                  <th className="px-3 py-2 text-left text-2xs font-semibold uppercase text-slate-500">Description</th>
                  <th className="px-3 py-2 text-left text-2xs font-semibold uppercase text-slate-500 min-w-[180px]">Account</th>
                  <th className="px-3 py-2 text-right text-2xs font-semibold uppercase text-slate-500 w-16">Qty</th>
                  <th className="px-3 py-2 text-right text-2xs font-semibold uppercase text-slate-500 w-24">Unit Cost</th>
                  <th className="px-3 py-2 text-right text-2xs font-semibold uppercase text-slate-500 w-24">Amount</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/30">
                {lines.map((line, idx) => (
                  <tr key={line.key} className="hover:bg-slate-800/20">
                    <td className="px-3 py-2 text-xs text-slate-600 font-mono">
                      {idx + 1}
                      {line.confidence !== null && <ConfBadge score={line.confidence} />}
                    </td>
                    <td className="px-3 py-2">
                      <input type="text" value={line.description} onChange={(e) => updateLine(line.key, 'description', e.target.value)}
                        placeholder="Line description" className="w-full px-2 py-1 bg-slate-800/50 border border-slate-700/50 rounded text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-500/50" />
                    </td>
                    <td className="px-3 py-2">
                      <AccountPicker value={line.account_id} label={line.accountLabel}
                        onChange={(id, lbl) => setLines((prev) => prev.map((l) => l.key === line.key ? { ...l, account_id: id, accountLabel: lbl } : l))}
                        locationId={locationId} />
                    </td>
                    <td className="px-3 py-2">
                      <input type="number" value={line.quantity} onChange={(e) => updateLine(line.key, 'quantity', e.target.value)}
                        min="0" step="1" className="w-full px-2 py-1 bg-slate-800 border border-slate-700 rounded text-xs text-white font-mono text-right focus:outline-none focus:border-emerald-500/50" />
                    </td>
                    <td className="px-3 py-2">
                      <div className="relative">
                        <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[10px] text-slate-500">$</span>
                        <input type="text" value={line.unitCost} onChange={(e) => updateLine(line.key, 'unitCost', e.target.value.replace(/[^0-9.]/g, ''))}
                          placeholder="0.00" className="w-full pl-4 pr-1 py-1 bg-slate-800 border border-slate-700 rounded text-xs text-white font-mono text-right focus:outline-none focus:border-emerald-500/50" />
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="relative">
                        <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[10px] text-slate-500">$</span>
                        <input type="text" value={line.amount} onChange={(e) => updateLine(line.key, 'amount', e.target.value.replace(/[^0-9.]/g, ''))}
                          placeholder="0.00" className="w-full pl-4 pr-1 py-1 bg-slate-800 border border-slate-700 rounded text-xs text-white font-mono text-right focus:outline-none focus:border-emerald-500/50" />
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <button type="button" onClick={() => lines.length > 1 && setLines((p) => p.filter((l) => l.key !== line.key))}
                        disabled={lines.length <= 1}
                        className={clsx('p-1 rounded', lines.length <= 1 ? 'text-slate-700' : 'text-slate-500 hover:text-red-400')}>
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-slate-700">
                  <td colSpan={4} className="px-3 py-2">
                    <button type="button" onClick={() => setLines((p) => [...p, emptyLine()])}
                      className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300">
                      <Plus size={12} /> Add line
                    </button>
                  </td>
                  <td className="px-3 py-2 text-right text-xs text-slate-500">Subtotal</td>
                  <td className="px-3 py-2 text-right text-sm font-mono font-semibold text-white">{formatMoney(subtotalCents)}</td>
                  <td />
                </tr>
                {taxCents > 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-1 text-right text-xs text-slate-500">Tax</td>
                    <td className="px-3 py-1 text-right text-xs font-mono text-slate-400">{formatMoney(taxCents)}</td>
                    <td />
                  </tr>
                )}
                <tr className="bg-slate-800/20">
                  <td colSpan={5} className="px-3 py-2.5 text-right text-sm font-medium text-white">Total</td>
                  <td className="px-3 py-2.5 text-right text-base font-mono font-bold text-white">{formatMoney(totalCents)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Error / Success */}
          {formError && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20">
              <AlertCircle size={13} className="text-red-400" /><p className="text-xs text-red-400">{formError}</p>
            </div>
          )}
          {successMsg && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
              <Check size={13} className="text-emerald-400" /><p className="text-xs text-emerald-400">{successMsg}</p>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-white hover:bg-slate-800">Cancel</button>
            <button onClick={handleSubmit} disabled={submitting || !locationId || !vendorId || subtotalCents === 0}
              className={clsx('flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium',
                submitting || !locationId || !vendorId || subtotalCents === 0
                  ? 'bg-slate-700 text-slate-500 cursor-not-allowed'
                  : 'bg-emerald-600 text-white hover:bg-emerald-500')}>
              {submitting ? <><Loader2 size={14} className="animate-spin" /> Saving...</> : <><Send size={14} /> Create Bill</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
