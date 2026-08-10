'use client';

import { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { Landmark, Plus, Trash2, Pencil, Wand2, Loader2, AlertCircle, CheckCircle2, AlertTriangle, X } from 'lucide-react';
import { useQuery, addToast } from '@/hooks';
import { api } from '@/lib/api-client';
import { formatMoney, dollarsToCents, centsToDollars } from '@meritbooks/shared';

/**
 * Reporting-basis adjustment manager.
 *
 * Manage the per-account presentation adjustments that the report viewer layers on top of
 * the GAAP trial balance to present a TAX / CASH / CUSTOM basis. These rows never post to the
 * GL — the accrual ledger stays the single book of record. For TAX, "Derive from Book-to-Tax"
 * seeds the adjustments from the existing M-1 differences so nothing is hand-keyed.
 */

type Basis = 'TAX' | 'CASH' | 'CUSTOM';
type AdjType = 'TIMING' | 'PERMANENT' | 'RECLASS';

interface AdjRow {
  id: string;
  basis: string;
  customLabel: string | null;
  periodYear: number;
  periodMonth: number | null;
  accountId: string;
  accountNumber: string;
  accountName: string;
  accountType: string;
  normalBalance: 'DEBIT' | 'CREDIT';
  description: string | null;
  amountCents: number;
  adjustmentType: string | null;
  source: string;
}
interface ListResp {
  adjustments: AdjRow[];
  summary: { count: number; netDebitPositiveCents: number; balances: boolean };
}
interface AccountOpt { id: string; accountNumber: string; name: string; accountType: string; isActive: boolean }

const MONTHS = ['Whole year', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function BasisAdjustmentsManager() {
  const nowYear = new Date().getFullYear();
  const [basis, setBasis] = useState<Basis>('TAX');
  const [year, setYear] = useState<number>(nowYear);
  const [month, setMonth] = useState<number>(0); // 0 = whole year

  // form state
  const [accountId, setAccountId] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [adjType, setAdjType] = useState<AdjType | ''>('');
  const [description, setDescription] = useState('');
  const [customLabel, setCustomLabel] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deriving, setDeriving] = useState(false);

  const listParams = useMemo(() => {
    const p: Record<string, string> = { basis, period_year: String(year) };
    if (month > 0) p.period_month = String(month);
    return p;
  }, [basis, year, month]);

  const { data: listWrap, isLoading, error, refetch } = useQuery<{ data: ListResp }>('/api/basis-adjustments', listParams, { scope: false });
  const { data: acctWrap } = useQuery<{ data: AccountOpt[] }>('/api/accounts', undefined, { scope: false });
  const accountOptions = useMemo(() => (acctWrap?.data ?? []).filter((a) => a.isActive), [acctWrap]);

  const rows = listWrap?.data.adjustments ?? [];
  const summary = listWrap?.data.summary;

  function resetForm() {
    setAccountId(''); setAmountStr(''); setAdjType(''); setDescription(''); setEditingId(null);
  }

  async function submit() {
    const cents = amountStr.trim() ? dollarsToCents(amountStr) : 0;
    if (!editingId && !accountId) { addToast('error', 'Pick an account.'); return; }
    if (cents === 0) { addToast('error', 'Enter a non-zero amount.'); return; }
    setBusy(true);
    try {
      if (editingId) {
        const res = await api.patch(`/api/basis-adjustments/${editingId}`, {
          amount_cents: cents,
          description: description || null,
          adjustment_type: adjType || null,
          ...(basis === 'CUSTOM' ? { custom_label: customLabel || null } : {}),
        });
        if (res.error) throw new Error(res.error.error);
        addToast('success', 'Adjustment updated.');
      } else {
        const res = await api.post('/api/basis-adjustments', {
          basis,
          custom_label: basis === 'CUSTOM' ? (customLabel || null) : null,
          period_year: year,
          period_month: month > 0 ? month : null,
          account_id: accountId,
          amount_cents: cents,
          description: description || null,
          adjustment_type: adjType || null,
        });
        if (res.error) throw new Error(res.error.error);
        addToast('success', 'Adjustment added.');
      }
      resetForm();
      refetch();
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!window.confirm('Delete this basis adjustment? This never affects the GL.')) return;
    const res = await api.delete(`/api/basis-adjustments/${id}`);
    if (res.error) { addToast('error', res.error.error); return; }
    addToast('success', 'Deleted.');
    if (editingId === id) resetForm();
    refetch();
  }

  function startEdit(r: AdjRow) {
    setEditingId(r.id);
    setAccountId(r.accountId);
    setAmountStr(String(centsToDollars(r.amountCents)));
    setAdjType((r.adjustmentType as AdjType) || '');
    setDescription(r.description ?? '');
  }

  async function derive() {
    if (basis !== 'TAX') { addToast('error', 'Derivation is available for the Tax basis only.'); return; }
    if (!window.confirm(`Derive tax-basis adjustments for ${year}${month > 0 ? '-' + String(month).padStart(2, '0') : ''} from the Book-to-Tax M-1 differences? This replaces any previously derived rows for this period.`)) return;
    setDeriving(true);
    try {
      const res = await api.post<{ data: { created: number; differenceCount: number; balances: boolean } }>('/api/basis-adjustments/derive', {
        basis: 'TAX',
        period_year: year,
        period_month: month > 0 ? month : null,
      });
      if (res.error) throw new Error(res.error.error);
      const d = res.data?.data;
      addToast('success', `Derived ${d?.created ?? 0} adjustments from ${d?.differenceCount ?? 0} M-1 differences.`);
      refetch();
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Derivation failed.');
    } finally {
      setDeriving(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* ─── Period / basis controls ─── */}
      <div className="flex items-center gap-2 p-3 rounded-xl bg-slate-800/20 border border-slate-800 flex-wrap">
        <Landmark size={15} className="text-indigo-400" />
        <div className="flex gap-0.5 p-0.5 rounded-lg bg-slate-900 border border-slate-700">
          {(['TAX', 'CASH', 'CUSTOM'] as Basis[]).map((b) => (
            <button key={b} onClick={() => { setBasis(b); resetForm(); }}
              className={clsx('px-2.5 py-1 rounded-md text-xs font-medium', basis === b ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white')}>
              {b === 'TAX' ? 'Tax' : b === 'CASH' ? 'Cash' : 'Custom'}
            </button>
          ))}
        </div>
        <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value) || nowYear)}
          className="w-24 px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white font-mono" aria-label="Year" />
        <select value={month} onChange={(e) => setMonth(Number(e.target.value))}
          className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white" aria-label="Month">
          {MONTHS.map((m, i) => <option key={i} value={i}>{m}</option>)}
        </select>
        {basis === 'CUSTOM' && (
          <input type="text" value={customLabel} onChange={(e) => setCustomLabel(e.target.value)} placeholder="Custom basis name (e.g. Bank covenant)"
            className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white w-56" />
        )}
        {basis === 'TAX' && (
          <button onClick={derive} disabled={deriving}
            className="ml-auto btn-secondary btn-sm flex items-center gap-1.5 disabled:opacity-50">
            {deriving ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} className="text-indigo-400" />}
            Derive from Book-to-Tax M-1
          </button>
        )}
      </div>

      {/* ─── Balance status ─── */}
      {summary && summary.count > 0 && (
        summary.balances ? (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-xs text-emerald-300">
            <CheckCircle2 size={14} /> These {summary.count} adjustments net to zero — the adjusted trial balance balances.
          </div>
        ) : (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200" role="alert">
            <AlertTriangle size={14} /> These adjustments are out of balance by <span className="font-mono font-semibold">{formatMoney(Math.abs(summary.netDebitPositiveCents))}</span>. Add an offsetting balance-sheet adjustment so the presentation ties out.
          </div>
        )
      )}

      {/* ─── Add / edit form ─── */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-semibold text-white">{editingId ? 'Edit adjustment' : 'Add adjustment'}</p>
          {editingId && <button onClick={resetForm} className="text-xs text-slate-500 hover:text-white flex items-center gap-1"><X size={12} /> Cancel edit</button>}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-end">
          <div className="md:col-span-4">
            <label className="block text-2xs uppercase text-slate-500 mb-1">Account</label>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)} disabled={!!editingId}
              className="w-full px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white disabled:opacity-60">
              <option value="">Select account…</option>
              {accountOptions.map((a) => <option key={a.id} value={a.id}>{a.accountNumber} · {a.name}</option>)}
            </select>
          </div>
          <div className="md:col-span-3">
            <label className="block text-2xs uppercase text-slate-500 mb-1" title="Signed delta to the account's natural balance. + increases (more expense / revenue / asset), − decreases.">Amount ($, signed)</label>
            <input type="text" inputMode="decimal" value={amountStr} onChange={(e) => setAmountStr(e.target.value)} placeholder="e.g. -1250.00"
              className="w-full px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white font-mono" />
          </div>
          <div className="md:col-span-2">
            <label className="block text-2xs uppercase text-slate-500 mb-1">Type</label>
            <select value={adjType} onChange={(e) => setAdjType(e.target.value as AdjType | '')}
              className="w-full px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white">
              <option value="">—</option>
              <option value="TIMING">Timing</option>
              <option value="PERMANENT">Permanent</option>
              <option value="RECLASS">Reclass</option>
            </select>
          </div>
          <div className="md:col-span-3">
            <label className="block text-2xs uppercase text-slate-500 mb-1">Description</label>
            <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional note"
              className="w-full px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white" />
          </div>
        </div>
        <div className="flex items-center gap-2 mt-3">
          <button onClick={submit} disabled={busy} className="btn-primary btn-sm flex items-center gap-1.5 disabled:opacity-50">
            {busy ? <Loader2 size={13} className="animate-spin" /> : editingId ? <Pencil size={13} /> : <Plus size={13} />}
            {editingId ? 'Save changes' : 'Add adjustment'}
          </button>
          <p className="text-2xs text-slate-500">A signed delta to the account&apos;s natural balance. These never post to the GL.</p>
        </div>
      </div>

      {/* ─── Adjustments list ─── */}
      {isLoading ? (
        <div className="card p-12 flex items-center justify-center"><Loader2 size={22} className="animate-spin text-slate-500" /></div>
      ) : error ? (
        <div className="card p-8 text-center"><AlertCircle size={22} className="mx-auto text-red-400 mb-2" /><p className="text-sm text-red-400">{error}</p></div>
      ) : rows.length === 0 ? (
        <div className="card p-8 text-center text-sm text-slate-500">
          No {basis === 'TAX' ? 'tax' : basis === 'CASH' ? 'cash' : 'custom'}-basis adjustments for this period yet.
          {basis === 'TAX' && ' Use “Derive from Book-to-Tax M-1” or add one above.'}
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-slate-800/50 text-2xs text-slate-500 uppercase">
              <th className="px-6 py-2.5 text-left w-20">Acct</th>
              <th className="px-4 py-2.5 text-left">Account / Description</th>
              <th className="px-4 py-2.5 text-left w-20">Type</th>
              <th className="px-4 py-2.5 text-left w-20">Source</th>
              <th className="px-6 py-2.5 text-right w-32">Amount</th>
              <th className="px-4 py-2.5 text-right w-24">Actions</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-800/30">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-800/20">
                  <td className="px-6 py-1.5 text-xs font-mono text-slate-500">{r.accountNumber}</td>
                  <td className="px-4 py-1.5 text-slate-300">{r.accountName}{r.description && <span className="text-slate-500"> — {r.description}</span>}</td>
                  <td className="px-4 py-1.5 text-2xs text-slate-500">{r.adjustmentType ?? '—'}</td>
                  <td className="px-4 py-1.5 text-2xs"><span className={clsx('px-1.5 py-0.5 rounded', r.source === 'DERIVED' ? 'bg-indigo-500/10 text-indigo-300' : 'bg-slate-700/50 text-slate-400')}>{r.source}</span></td>
                  <td className={clsx('px-6 py-1.5 text-right font-mono', r.amountCents >= 0 ? 'text-emerald-400' : 'text-red-400')}>{r.amountCents > 0 ? '+' : ''}{formatMoney(r.amountCents)}</td>
                  <td className="px-4 py-1.5 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <button onClick={() => startEdit(r)} className="text-slate-500 hover:text-indigo-300" title="Edit"><Pencil size={13} /></button>
                      <button onClick={() => remove(r.id)} className="text-slate-500 hover:text-red-400" title="Delete"><Trash2 size={13} /></button>
                    </div>
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
