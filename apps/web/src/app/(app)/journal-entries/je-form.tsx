'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Plus, Trash2, AlertCircle, Loader2, Check, Save, Send,
  Search, X, ChevronDown
} from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, useMutation } from '@/hooks';
import { formatMoney, dollarsToCents } from '@meritbooks/shared';

// ─── Types ──────────────────────────────────────────────────

interface AccountOption {
  id: string;
  account_number: string;
  name: string;
  account_type: string;
  is_control_account: boolean;
}

interface LocationOption {
  id: string;
  name: string;
  short_code: string;
}

interface DeptOption {
  id: string;
  name: string;
  code: string;
}

interface JELine {
  key: string; // client-side key for React
  account_id: string;
  accountLabel: string;
  debit: string; // string for controlled input
  credit: string;
  memo: string;
  department_id: string;
  class_id: string;
}

interface CreateResult {
  success: boolean;
  entry: { id: string; entryNumber: string; status: string; totalDebitCents: number; lineCount: number };
}

function genKey() { return Math.random().toString(36).slice(2, 8); }

function emptyLine(): JELine {
  return { key: genKey(), account_id: '', accountLabel: '', debit: '', credit: '', memo: '', department_id: '', class_id: '' };
}

// ─── Account Search Dropdown ────────────────────────────────

function AccountPicker({ value, label, onChange, locationId }: {
  value: string;
  label: string;
  onChange: (id: string, label: string) => void;
  locationId: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 200);
    return () => clearTimeout(t);
  }, [search]);

  const params: Record<string, string> = {};
  if (debouncedSearch.length >= 1) params.q = debouncedSearch;
  if (locationId) params.location_id = locationId;

  const { data } = useQuery<{ data: AccountOption[] }>(
    open ? '/api/accounts/search' : null,
    Object.keys(params).length > 0 ? params : undefined,
  );

  const accounts = (data?.data ?? []).filter((a) => !a.is_control_account);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={clsx(
          'w-full text-left px-2.5 py-1.5 rounded-lg border text-sm truncate',
          value
            ? 'bg-slate-800 border-slate-700 text-white'
            : 'bg-slate-800/50 border-slate-700/50 text-slate-500'
        )}
      >
        {label || 'Select account...'}
        <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500" />
      </button>

      {open && (
        <div className="absolute z-50 top-full mt-1 left-0 w-80 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl overflow-hidden">
          <div className="p-2 border-b border-slate-800">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by number or name..."
                className="w-full pl-8 pr-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-emerald-500/50"
                autoFocus
              />
            </div>
          </div>
          <div className="max-h-48 overflow-y-auto">
            {accounts.length === 0 ? (
              <p className="px-3 py-4 text-xs text-slate-500 text-center">
                {debouncedSearch ? 'No accounts found' : 'Type to search accounts'}
              </p>
            ) : (
              accounts.slice(0, 30).map((acct) => (
                <button
                  key={acct.id}
                  type="button"
                  onClick={() => {
                    onChange(acct.id, `${acct.account_number} · ${acct.name}`);
                    setOpen(false);
                    setSearch('');
                  }}
                  className={clsx(
                    'w-full text-left px-3 py-2 text-sm hover:bg-slate-800 transition-colors flex items-center gap-2',
                    value === acct.id && 'bg-slate-800'
                  )}
                >
                  <span className="font-mono text-xs text-slate-500 w-14 shrink-0">{acct.account_number}</span>
                  <span className="text-slate-300 truncate">{acct.name}</span>
                  <span className="ml-auto text-[10px] text-slate-600 shrink-0">{acct.account_type}</span>
                  {value === acct.id && <Check size={12} className="text-emerald-400 shrink-0" />}
                </button>
              ))
            )}
          </div>
          <div className="p-1.5 border-t border-slate-800">
            <button type="button" onClick={() => { setOpen(false); setSearch(''); }} className="w-full text-center text-xs text-slate-500 hover:text-slate-400 py-1">
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Dollar Input ───────────────────────────────────────────

function DollarInput({ value, onChange, disabled, placeholder }: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <div className="relative">
      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500 text-xs">$</span>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => {
          const v = e.target.value.replace(/[^0-9.]/g, '');
          // Only allow one decimal point and max 2 decimal places
          const parts = v.split('.');
          if (parts.length > 2) return;
          if (parts[1] && parts[1].length > 2) return;
          onChange(v);
        }}
        disabled={disabled}
        placeholder={placeholder ?? '0.00'}
        className={clsx(
          'w-full pl-5 pr-2 py-1.5 rounded-lg border text-sm font-mono text-right',
          disabled
            ? 'bg-slate-900/50 border-slate-800 text-slate-600 cursor-not-allowed'
            : 'bg-slate-800 border-slate-700 text-white focus:outline-none focus:border-emerald-500/50'
        )}
      />
    </div>
  );
}

// ─── Main Form ──────────────────────────────────────────────

export function JournalEntryForm({ onClose, onSuccess }: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [locationId, setLocationId] = useState('');
  const [entryDate, setEntryDate] = useState(new Date().toISOString().split('T')[0]);
  const [entryType, setEntryType] = useState('STANDARD');
  const [memo, setMemo] = useState('');
  const [postImmediately, setPostImmediately] = useState(true);
  const [lines, setLines] = useState<JELine[]>([emptyLine(), emptyLine()]);
  const [formError, setFormError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const { data: locData } = useQuery<LocationOption[]>('/api/locations');
  const locations = locData ?? [];

  const { mutate, isLoading: submitting } = useMutation<Record<string, unknown>, CreateResult>(
    '/api/journal-entries'
  );

  // Totals
  const totalDebits = useMemo(() =>
    lines.reduce((s, l) => s + (parseFloat(l.debit) || 0), 0),
    [lines]
  );
  const totalCredits = useMemo(() =>
    lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0),
    [lines]
  );
  const isBalanced = Math.abs(totalDebits - totalCredits) < 0.005 && totalDebits > 0;
  const difference = totalDebits - totalCredits;

  // Line mutations
  const updateLine = useCallback((key: string, field: keyof JELine, value: string) => {
    setLines((prev) => prev.map((l) => {
      if (l.key !== key) return l;
      const updated = { ...l, [field]: value };
      // Auto-clear the other side when entering a debit or credit
      if (field === 'debit' && value) updated.credit = '';
      if (field === 'credit' && value) updated.debit = '';
      return updated;
    }));
  }, []);

  const addLine = useCallback(() => {
    setLines((prev) => [...prev, emptyLine()]);
  }, []);

  const removeLine = useCallback((key: string) => {
    setLines((prev) => prev.length <= 2 ? prev : prev.filter((l) => l.key !== key));
  }, []);

  // Submit
  const handleSubmit = useCallback(async () => {
    setFormError('');
    setSuccessMsg('');

    if (!locationId) { setFormError('Select a company'); return; }
    if (!entryDate) { setFormError('Enter a date'); return; }

    const validLines = lines.filter((l) => l.account_id && (parseFloat(l.debit) > 0 || parseFloat(l.credit) > 0));
    if (validLines.length < 2) { setFormError('At least 2 lines with amounts required'); return; }
    if (!isBalanced) { setFormError(`Entry is not balanced. Difference: ${formatMoney(dollarsToCents(difference))}`); return; }

    const payload = {
      location_id: locationId,
      entry_date: entryDate,
      entry_type: entryType,
      memo: memo || undefined,
      post_immediately: postImmediately,
      lines: validLines.map((l) => ({
        account_id: l.account_id,
        debit_cents: dollarsToCents(parseFloat(l.debit) || 0),
        credit_cents: dollarsToCents(parseFloat(l.credit) || 0),
        location_id: locationId,
        department_id: l.department_id || null,
        class_id: l.class_id || null,
        memo: l.memo || null,
      })),
    };

    const result = await mutate(payload);

    if (result?.success) {
      setSuccessMsg(`${result.entry.entryNumber} ${postImmediately ? 'posted' : 'saved as draft'} — ${formatMoney(result.entry.totalDebitCents)}`);
      setTimeout(() => {
        onSuccess();
      }, 1200);
    } else {
      setFormError('Failed to create entry. Check the error above.');
    }
  }, [locationId, entryDate, entryType, memo, postImmediately, lines, isBalanced, difference, mutate, onSuccess]);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
        <h2 className="text-lg font-semibold text-white">New Journal Entry</h2>
        <button onClick={onClose} className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition-colors">
          <X size={18} />
        </button>
      </div>

      <div className="p-6 space-y-5">
        {/* Top controls */}
        <div className="grid grid-cols-4 gap-4">
          <div>
            <label className="block text-xs text-slate-500 mb-1 font-medium">Company</label>
            <select
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white"
            >
              <option value="">Select company...</option>
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>{loc.short_code} · {loc.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1 font-medium">Date</label>
            <input
              type="date"
              value={entryDate}
              onChange={(e) => setEntryDate(e.target.value)}
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white font-mono"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1 font-medium">Type</label>
            <select
              value={entryType}
              onChange={(e) => setEntryType(e.target.value)}
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white"
            >
              <option value="STANDARD">Standard</option>
              <option value="ADJUSTING">Adjusting</option>
              <option value="CLOSING">Closing</option>
              <option value="REVERSING">Reversing</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1 font-medium">Memo</label>
            <input
              type="text"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="Description of this entry..."
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder:text-slate-600"
            />
          </div>
        </div>

        {/* Line items table */}
        <div className="border border-slate-800 rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-800/30">
                <th className="px-3 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500 w-8">#</th>
                <th className="px-3 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500 min-w-[240px]">Account</th>
                <th className="px-3 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500 w-32">Debit</th>
                <th className="px-3 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500 w-32">Credit</th>
                <th className="px-3 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500 w-40">Line Memo</th>
                <th className="px-3 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500 w-10" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/30">
              {lines.map((line, idx) => (
                <tr key={line.key} className="hover:bg-slate-800/20">
                  <td className="px-3 py-2 text-xs text-slate-600 font-mono">{idx + 1}</td>
                  <td className="px-3 py-2">
                    <AccountPicker
                      value={line.account_id}
                      label={line.accountLabel}
                      onChange={(id, label) => {
                        setLines((prev) => prev.map((l) =>
                          l.key === line.key ? { ...l, account_id: id, accountLabel: label } : l
                        ));
                      }}
                      locationId={locationId}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <DollarInput
                      value={line.debit}
                      onChange={(v) => updateLine(line.key, 'debit', v)}
                      disabled={!!line.credit}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <DollarInput
                      value={line.credit}
                      onChange={(v) => updateLine(line.key, 'credit', v)}
                      disabled={!!line.debit}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="text"
                      value={line.memo}
                      onChange={(e) => updateLine(line.key, 'memo', e.target.value)}
                      placeholder="—"
                      className="w-full px-2 py-1.5 bg-slate-800/50 border border-slate-700/50 rounded-lg text-xs text-slate-300 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500/50"
                    />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <button
                      type="button"
                      onClick={() => removeLine(line.key)}
                      disabled={lines.length <= 2}
                      className={clsx(
                        'p-1 rounded',
                        lines.length <= 2 ? 'text-slate-700 cursor-not-allowed' : 'text-slate-500 hover:text-red-400 hover:bg-red-500/10'
                      )}
                    >
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-700">
                <td colSpan={2} className="px-3 py-2.5">
                  <button
                    type="button"
                    onClick={addLine}
                    className="flex items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
                  >
                    <Plus size={13} /> Add line
                  </button>
                </td>
                <td className="px-3 py-2.5 text-right">
                  <span className={clsx('text-sm font-mono font-semibold', totalDebits > 0 ? 'text-white' : 'text-slate-600')}>
                    {formatMoney(dollarsToCents(totalDebits))}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-right">
                  <span className={clsx('text-sm font-mono font-semibold', totalCredits > 0 ? 'text-white' : 'text-slate-600')}>
                    {formatMoney(dollarsToCents(totalCredits))}
                  </span>
                </td>
                <td colSpan={2} className="px-3 py-2.5">
                  {totalDebits > 0 || totalCredits > 0 ? (
                    isBalanced ? (
                      <span className="flex items-center gap-1 text-xs text-emerald-400">
                        <Check size={12} /> Balanced
                      </span>
                    ) : (
                      <span className="text-xs text-red-400">
                        Off by {formatMoney(dollarsToCents(Math.abs(difference)))}
                      </span>
                    )
                  ) : null}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* Error / Success */}
        {formError && (
          <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/20">
            <AlertCircle size={14} className="text-red-400 shrink-0" />
            <p className="text-sm text-red-400">{formError}</p>
          </div>
        )}
        {successMsg && (
          <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
            <Check size={14} className="text-emerald-400 shrink-0" />
            <p className="text-sm text-emerald-400">{successMsg}</p>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-between pt-2">
          <label className="flex items-center gap-2 text-sm text-slate-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={postImmediately}
              onChange={(e) => setPostImmediately(e.target.checked)}
              className="rounded border-slate-600 bg-slate-800 text-emerald-500 focus:ring-emerald-500/20"
            />
            Post immediately
          </label>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting || !isBalanced || !locationId}
              className={clsx(
                'flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium transition-colors',
                submitting || !isBalanced || !locationId
                  ? 'bg-slate-700 text-slate-500 cursor-not-allowed'
                  : postImmediately
                    ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                    : 'bg-slate-700 text-white hover:bg-slate-600'
              )}
            >
              {submitting ? (
                <><Loader2 size={14} className="animate-spin" /> Posting...</>
              ) : postImmediately ? (
                <><Send size={14} /> Post Entry</>
              ) : (
                <><Save size={14} /> Save Draft</>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
