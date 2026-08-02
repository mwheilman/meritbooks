'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Plus, Trash2, AlertCircle, Loader2, Check, Save, X, Search, ChevronDown, Layers,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery } from '@/hooks';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks/use-toast';
import { formatMoney, dollarsToCents, centsToDollars } from '@meritbooks/shared';

// ─── Types ──────────────────────────────────────────────────

interface AccountOption {
  id: string;
  account_number: string;
  name: string;
  account_type: string;
  is_control_account: boolean;
}
interface LocationOption { id: string; name: string; short_code: string; }
interface DeptOption { id: string; name: string; code: string; locationId: string | null; }

export interface ExistingTemplate {
  id: string;
  name: string;
  location_id: string;
  cadence: 'MONTHLY' | 'QUARTERLY';
  start_date: string;
  end_date: string | null;
  entry_type: string;
  memo: string | null;
  lines: {
    account_id: string;
    debit_cents: number;
    credit_cents: number;
    department_id?: string | null;
    memo?: string | null;
  }[];
}

interface BuilderLine {
  key: string;
  account_id: string;
  accountLabel: string;
  debit: string;
  credit: string;
  department_id: string;
  memo: string;
}

function genKey() { return Math.random().toString(36).slice(2, 8); }
function emptyLine(): BuilderLine {
  return { key: genKey(), account_id: '', accountLabel: '', debit: '', credit: '', department_id: '', memo: '' };
}

// ─── Account picker (search dropdown) ───────────────────────

function AccountPicker({ value, label, onChange, locationId }: {
  value: string; label: string; onChange: (id: string, label: string) => void; locationId: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebounced(search), 200); return () => clearTimeout(t); }, [search]);

  const params: Record<string, string> = {};
  if (debounced.length >= 1) params.q = debounced;
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
        className={clsx('w-full text-left px-2.5 py-1.5 rounded-lg border text-sm truncate relative',
          value ? 'bg-slate-800 border-slate-700 text-white' : 'bg-slate-800/50 border-slate-700/50 text-slate-500')}
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
                type="text" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus
                placeholder="Search by number or name..."
                className="w-full pl-8 pr-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-emerald-500/50"
              />
            </div>
          </div>
          <div className="max-h-48 overflow-y-auto">
            {accounts.length === 0 ? (
              <p className="px-3 py-4 text-xs text-slate-500 text-center">{debounced ? 'No accounts found' : 'Type to search accounts'}</p>
            ) : accounts.slice(0, 30).map((acct) => (
              <button
                key={acct.id} type="button"
                onClick={() => { onChange(acct.id, `${acct.account_number} · ${acct.name}`); setOpen(false); setSearch(''); }}
                className={clsx('w-full text-left px-3 py-2 text-sm hover:bg-slate-800 flex items-center gap-2', value === acct.id && 'bg-slate-800')}
              >
                <span className="font-mono text-xs text-slate-500 w-14 shrink-0">{acct.account_number}</span>
                <span className="text-slate-300 truncate">{acct.name}</span>
                <span className="ml-auto text-[10px] text-slate-600 shrink-0">{acct.account_type}</span>
                {value === acct.id && <Check size={12} className="text-emerald-400 shrink-0" />}
              </button>
            ))}
          </div>
          <div className="p-1.5 border-t border-slate-800">
            <button type="button" onClick={() => { setOpen(false); setSearch(''); }} className="w-full text-center text-xs text-slate-500 hover:text-slate-400 py-1">Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

function DollarInput({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <div className="relative">
      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500 text-xs">$</span>
      <input
        type="text" inputMode="decimal" value={value} disabled={disabled}
        onChange={(e) => {
          const v = e.target.value.replace(/[^0-9.]/g, '');
          const parts = v.split('.');
          if (parts.length > 2) return;
          if (parts[1] && parts[1].length > 2) return;
          onChange(v);
        }}
        placeholder="0.00"
        className={clsx('w-full pl-5 pr-2 py-1.5 rounded-lg border text-sm font-mono text-right',
          disabled ? 'bg-slate-900/50 border-slate-800 text-slate-600 cursor-not-allowed'
            : 'bg-slate-800 border-slate-700 text-white focus:outline-none focus:border-emerald-500/50')}
      />
    </div>
  );
}

// ─── Allocation helper ──────────────────────────────────────

function AllocationHelper({ locationId, departments, onGenerate }: {
  locationId: string;
  departments: DeptOption[];
  onGenerate: (lines: BuilderLine[]) => void;
}) {
  const [total, setTotal] = useState('');
  const [offset, setOffset] = useState({ id: '', label: '' });
  const [expenseAcct, setExpenseAcct] = useState({ id: '', label: '' });
  const [picked, setPicked] = useState<string[]>([]);

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const build = () => {
    const cents = dollarsToCents(parseFloat(total) || 0);
    if (cents <= 0) { addToast('error', 'Enter an accrual amount'); return; }
    if (!expenseAcct.id) { addToast('error', 'Pick the expense/cost account to allocate'); return; }
    if (!offset.id) { addToast('error', 'Pick the offset (e.g. accrued liability) account'); return; }
    if (picked.length < 1) { addToast('error', 'Pick at least one department'); return; }
    // Even split with remainder on the last bucket (mirrors the pure engine).
    const per = Math.floor(cents / picked.length);
    let remaining = cents;
    const lines: BuilderLine[] = picked.map((deptId, i) => {
      const amt = i === picked.length - 1 ? remaining : per;
      remaining -= amt;
      return {
        key: genKey(),
        account_id: expenseAcct.id,
        accountLabel: expenseAcct.label,
        debit: String(centsToDollars(amt)),
        credit: '',
        department_id: deptId,
        memo: '',
      };
    });
    lines.push({ key: genKey(), account_id: offset.id, accountLabel: offset.label, debit: '', credit: String(centsToDollars(cents)), department_id: '', memo: '' });
    onGenerate(lines);
    addToast('success', `Built ${lines.length} balanced lines`);
  };

  return (
    <div className="rounded-xl border border-indigo-500/25 bg-indigo-500/5 p-4 space-y-3">
      <p className="text-xs text-indigo-300 flex items-center gap-1.5"><Layers size={13} /> Allocate a fixed accrual straight-line across departments</p>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="block text-[11px] text-slate-500 mb-1">Accrual amount</label>
          <DollarInput value={total} onChange={setTotal} />
        </div>
        <div>
          <label className="block text-[11px] text-slate-500 mb-1">Expense / cost account (DR)</label>
          <AccountPicker value={expenseAcct.id} label={expenseAcct.label} locationId={locationId} onChange={(id, label) => setExpenseAcct({ id, label })} />
        </div>
        <div>
          <label className="block text-[11px] text-slate-500 mb-1">Offset account (CR)</label>
          <AccountPicker value={offset.id} label={offset.label} locationId={locationId} onChange={(id, label) => setOffset({ id, label })} />
        </div>
      </div>
      <div>
        <label className="block text-[11px] text-slate-500 mb-1.5">Departments to split across</label>
        {departments.length === 0 ? (
          <p className="text-xs text-slate-600">No departments for this company.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {departments.map((d) => (
              <button
                key={d.id} type="button" onClick={() => toggle(d.id)}
                className={clsx('px-2.5 py-1 rounded-lg border text-xs',
                  picked.includes(d.id) ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300' : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-white')}
              >
                {d.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <button type="button" onClick={build} className="px-3 py-1.5 text-xs font-medium bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-200 border border-indigo-500/30 rounded-lg">
        Build allocated lines
      </button>
    </div>
  );
}

// ─── Builder modal ──────────────────────────────────────────

export function RecurringJeBuilder({ existing, onClose, onSaved }: {
  existing: ExistingTemplate | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = !!existing;
  const [name, setName] = useState(existing?.name ?? '');
  const [locationId, setLocationId] = useState(existing?.location_id ?? '');
  const [cadence, setCadence] = useState<'MONTHLY' | 'QUARTERLY'>(existing?.cadence ?? 'MONTHLY');
  const [startDate, setStartDate] = useState(existing?.start_date ?? new Date().toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState(existing?.end_date ?? '');
  const [entryType, setEntryType] = useState(existing?.entry_type ?? 'ADJUSTING');
  const [memo, setMemo] = useState(existing?.memo ?? '');
  const [showAlloc, setShowAlloc] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const [lines, setLines] = useState<BuilderLine[]>(
    existing
      ? existing.lines.map((l) => ({
          key: genKey(),
          account_id: l.account_id,
          accountLabel: '', // resolved lazily via picker; number/name not stored on the line
          debit: l.debit_cents > 0 ? String(centsToDollars(l.debit_cents)) : '',
          credit: l.credit_cents > 0 ? String(centsToDollars(l.credit_cents)) : '',
          department_id: l.department_id ?? '',
          memo: l.memo ?? '',
        }))
      : [emptyLine(), emptyLine()],
  );

  const { data: locData } = useQuery<LocationOption[]>('/api/locations');
  const locations = locData ?? [];
  const { data: deptData } = useQuery<{ departments: DeptOption[] }>('/api/departments');
  const departments = useMemo(
    () => (deptData?.departments ?? []).filter((d) => !locationId || !d.locationId || d.locationId === locationId),
    [deptData, locationId],
  );

  const totalDebits = useMemo(() => lines.reduce((s, l) => s + (parseFloat(l.debit) || 0), 0), [lines]);
  const totalCredits = useMemo(() => lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0), [lines]);
  const difference = totalDebits - totalCredits;
  const isBalanced = Math.abs(difference) < 0.005 && totalDebits > 0;

  const updateLine = useCallback((key: string, field: keyof BuilderLine, value: string) => {
    setLines((prev) => prev.map((l) => {
      if (l.key !== key) return l;
      const u = { ...l, [field]: value };
      if (field === 'debit' && value) u.credit = '';
      if (field === 'credit' && value) u.debit = '';
      return u;
    }));
  }, []);
  const addLine = useCallback(() => setLines((p) => [...p, emptyLine()]), []);
  const removeLine = useCallback((key: string) => setLines((p) => (p.length <= 2 ? p : p.filter((l) => l.key !== key))), []);

  async function save() {
    setFormError('');
    if (!name.trim()) { setFormError('Name the template'); return; }
    if (!locationId) { setFormError('Select a company'); return; }
    const valid = lines.filter((l) => l.account_id && (parseFloat(l.debit) > 0 || parseFloat(l.credit) > 0));
    if (valid.length < 2) { setFormError('At least 2 lines with amounts required'); return; }
    if (!isBalanced) { setFormError(`Not balanced — off by ${formatMoney(dollarsToCents(Math.abs(difference)))}`); return; }
    if (endDate && endDate < startDate) { setFormError('End date must be on or after the start date'); return; }

    const payload = {
      location_id: locationId,
      name: name.trim(),
      cadence,
      start_date: startDate,
      end_date: endDate || null,
      entry_type: entryType,
      memo: memo || null,
      lines: valid.map((l) => ({
        account_id: l.account_id,
        debit_cents: dollarsToCents(parseFloat(l.debit) || 0),
        credit_cents: dollarsToCents(parseFloat(l.credit) || 0),
        department_id: l.department_id || null,
        memo: l.memo || null,
      })),
    };

    setSaving(true);
    const res = editing
      ? await api.patch(`/api/recurring-journal-entries/${existing!.id}`, payload)
      : await api.post('/api/recurring-journal-entries', payload);
    setSaving(false);
    if (res.error) { setFormError(res.error.error || 'Failed to save'); return; }
    addToast('success', editing ? 'Template updated' : 'Recurring template created');
    onSaved();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-8">
      <div className="w-full max-w-4xl bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden my-4">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <h2 className="text-lg font-semibold text-white">{editing ? 'Edit recurring entry' : 'New recurring journal entry'}</h2>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white"><X size={18} /></button>
        </div>

        <div className="p-6 space-y-5">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="col-span-2 md:col-span-1">
              <label className="block text-xs text-slate-500 mb-1 font-medium">Template name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Monthly rent accrual"
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder:text-slate-600" />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1 font-medium">Company</label>
              <select value={locationId} onChange={(e) => setLocationId(e.target.value)}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white">
                <option value="">Select...</option>
                {locations.map((loc) => <option key={loc.id} value={loc.id}>{loc.short_code} · {loc.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1 font-medium">Cadence</label>
              <select value={cadence} onChange={(e) => setCadence(e.target.value as 'MONTHLY' | 'QUARTERLY')}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white">
                <option value="MONTHLY">Monthly</option>
                <option value="QUARTERLY">Quarterly</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1 font-medium">Type</label>
              <select value={entryType} onChange={(e) => setEntryType(e.target.value)}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white">
                <option value="ADJUSTING">Adjusting</option>
                <option value="STANDARD">Standard</option>
                <option value="CLOSING">Closing</option>
                <option value="REVERSING">Reversing</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1 font-medium">Start</label>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white font-mono" />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1 font-medium">End <span className="text-slate-600">(optional)</span></label>
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white font-mono" />
            </div>
            <div className="col-span-2">
              <label className="block text-xs text-slate-500 mb-1 font-medium">Memo <span className="text-slate-600">(optional)</span></label>
              <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Posted each period with the period appended"
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder:text-slate-600" />
            </div>
          </div>

          <div className="flex items-center justify-between">
            <p className="text-xs text-slate-500">The same balanced entry posts every period. Each period is proposed for your approval before it hits the GL.</p>
            <button type="button" onClick={() => setShowAlloc((s) => !s)}
              className="text-xs text-indigo-300 hover:text-indigo-200 flex items-center gap-1">
              <Layers size={12} /> {showAlloc ? 'Hide' : 'Allocate across departments'}
            </button>
          </div>

          {showAlloc && (
            <AllocationHelper locationId={locationId} departments={departments} onGenerate={(l) => { setLines(l); setShowAlloc(false); }} />
          )}

          <div className="border border-slate-800 rounded-xl overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-800/30">
                  <th className="px-3 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500 w-8">#</th>
                  <th className="px-3 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500 min-w-[220px]">Account</th>
                  <th className="px-3 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500 w-28">Debit</th>
                  <th className="px-3 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500 w-28">Credit</th>
                  <th className="px-3 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500 w-36">Department</th>
                  <th className="px-3 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500 w-10" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/30">
                {lines.map((line, idx) => (
                  <tr key={line.key} className="hover:bg-slate-800/20">
                    <td className="px-3 py-2 text-xs text-slate-600 font-mono">{idx + 1}</td>
                    <td className="px-3 py-2">
                      <AccountPicker value={line.account_id} label={line.accountLabel} locationId={locationId}
                        onChange={(id, label) => setLines((prev) => prev.map((l) => (l.key === line.key ? { ...l, account_id: id, accountLabel: label } : l)))} />
                    </td>
                    <td className="px-3 py-2"><DollarInput value={line.debit} onChange={(v) => updateLine(line.key, 'debit', v)} disabled={!!line.credit} /></td>
                    <td className="px-3 py-2"><DollarInput value={line.credit} onChange={(v) => updateLine(line.key, 'credit', v)} disabled={!!line.debit} /></td>
                    <td className="px-3 py-2">
                      <select value={line.department_id} onChange={(e) => updateLine(line.key, 'department_id', e.target.value)}
                        className="w-full px-2 py-1.5 bg-slate-800/50 border border-slate-700/50 rounded-lg text-xs text-slate-300">
                        <option value="">—</option>
                        {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                      </select>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <button type="button" onClick={() => removeLine(line.key)} disabled={lines.length <= 2}
                        className={clsx('p-1 rounded', lines.length <= 2 ? 'text-slate-700 cursor-not-allowed' : 'text-slate-500 hover:text-red-400 hover:bg-red-500/10')}>
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-slate-700">
                  <td colSpan={2} className="px-3 py-2.5">
                    <button type="button" onClick={addLine} className="flex items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300">
                      <Plus size={13} /> Add line
                    </button>
                  </td>
                  <td className="px-3 py-2.5 text-right"><span className={clsx('text-sm font-mono font-semibold', totalDebits > 0 ? 'text-white' : 'text-slate-600')}>{formatMoney(dollarsToCents(totalDebits))}</span></td>
                  <td className="px-3 py-2.5 text-right"><span className={clsx('text-sm font-mono font-semibold', totalCredits > 0 ? 'text-white' : 'text-slate-600')}>{formatMoney(dollarsToCents(totalCredits))}</span></td>
                  <td colSpan={2} className="px-3 py-2.5">
                    {totalDebits > 0 || totalCredits > 0 ? (
                      isBalanced ? <span className="flex items-center gap-1 text-xs text-emerald-400"><Check size={12} /> Balanced</span>
                        : <span className="text-xs text-red-400">Off by {formatMoney(dollarsToCents(Math.abs(difference)))}</span>
                    ) : null}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {formError && (
            <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/20">
              <AlertCircle size={14} className="text-red-400 shrink-0" />
              <p className="text-sm text-red-400">{formError}</p>
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-1">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-white hover:bg-slate-800">Cancel</button>
            <button type="button" onClick={save} disabled={saving || !isBalanced || !locationId || !name.trim()}
              className={clsx('flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium',
                saving || !isBalanced || !locationId || !name.trim() ? 'bg-slate-700 text-slate-500 cursor-not-allowed' : 'bg-emerald-600 text-white hover:bg-emerald-500')}>
              {saving ? <><Loader2 size={14} className="animate-spin" /> Saving...</> : <><Save size={14} /> {editing ? 'Save changes' : 'Create template'}</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
