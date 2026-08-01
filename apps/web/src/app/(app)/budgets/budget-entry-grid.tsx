'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { Loader2, AlertCircle, Building2, Save, Copy, Wand2, Info } from 'lucide-react';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks';
import { formatMoney, dollarsToCents, centsToDollars } from '@meritbooks/shared';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PERIODS = Array.from({ length: 12 }, (_, i) => i + 1);
// Income-statement types only (CANON-ANCHOR §2 — no EXPENSE type).
const PNL_TYPES = ['REVENUE', 'COGS', 'OPEX', 'OTHER'];
const TYPE_LABEL: Record<string, string> = {
  REVENUE: 'Revenue', COGS: 'Cost of Goods Sold', OPEX: 'Operating Expenses', OTHER: 'Other Income / Expense',
};

interface AccountLite {
  id: string; accountNumber: string; name: string; accountType: string;
  isActive: boolean; approvalStatus: string;
}
interface AccountsResp { data: AccountLite[] }
interface BudgetResp {
  fiscalYear: number;
  accounts: { accountId: string; periods: Record<number, number> }[];
}

// cents keyed by accountId -> period(1..12)
type Draft = Record<string, Record<number, number>>;

export function BudgetEntryGrid({ locationId, locationName, fiscalYear, departmentId }: {
  locationId: string; locationName: string; fiscalYear: number; departmentId: string | null;
}) {
  const [accounts, setAccounts] = useState<AccountLite[]>([]);
  const [draft, setDraft] = useState<Draft>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dirty = useRef<Set<string>>(new Set());
  const [dirtyCount, setDirtyCount] = useState(0);

  const markDirty = useCallback((accountId: string) => {
    dirty.current.add(accountId);
    setDirtyCount(dirty.current.size);
  }, []);

  const load = useCallback(async () => {
    if (!locationId) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    dirty.current = new Set();
    setDirtyCount(0);

    const acctParams: Record<string, string> = { location_id: locationId };
    const budgetParams: Record<string, string> = { location_id: locationId, fiscal_year: String(fiscalYear) };
    if (departmentId) budgetParams.department_id = departmentId;

    const [acctRes, budgetRes] = await Promise.all([
      api.get<AccountsResp>('/api/accounts', acctParams),
      api.get<BudgetResp>('/api/budgets', budgetParams),
    ]);

    if (acctRes.error) { setError(acctRes.error.error); setLoading(false); return; }

    const pnl = (acctRes.data?.data ?? [])
      .filter((a) => PNL_TYPES.includes(a.accountType) && a.isActive && a.approvalStatus === 'APPROVED')
      .sort((a, b) => a.accountNumber.localeCompare(b.accountNumber));
    setAccounts(pnl);

    const next: Draft = {};
    for (const row of budgetRes.data?.accounts ?? []) {
      next[row.accountId] = { ...row.periods };
    }
    setDraft(next);
    setLoading(false);
  }, [locationId, fiscalYear, departmentId]);

  useEffect(() => { load(); }, [load]);

  const grouped = useMemo(() => {
    const map = new Map<string, AccountLite[]>();
    for (const a of accounts) {
      if (!map.has(a.accountType)) map.set(a.accountType, []);
      map.get(a.accountType)!.push(a);
    }
    return PNL_TYPES.filter((t) => map.has(t)).map((t) => ({ type: t, accounts: map.get(t)! }));
  }, [accounts]);

  const rowTotal = useCallback((accountId: string) => {
    const p = draft[accountId] ?? {};
    return PERIODS.reduce((s, n) => s + (p[n] ?? 0), 0);
  }, [draft]);

  const setCell = useCallback((accountId: string, period: number, cents: number) => {
    setDraft((prev) => ({ ...prev, [accountId]: { ...(prev[accountId] ?? {}), [period]: cents } }));
    markDirty(accountId);
  }, [markDirty]);

  // Spread an annual dollar amount evenly across 12 months (remainder to Jan).
  const spreadAnnual = useCallback((accountId: string, annualCents: number) => {
    const base = Math.trunc(annualCents / 12);
    const remainder = annualCents - base * 12;
    const periods: Record<number, number> = {};
    for (const n of PERIODS) periods[n] = base + (n === 1 ? remainder : 0);
    setDraft((prev) => ({ ...prev, [accountId]: periods }));
    markDirty(accountId);
  }, [markDirty]);

  const copyPriorYear = useCallback(async () => {
    const params: Record<string, string> = { location_id: locationId, fiscal_year: String(fiscalYear - 1) };
    if (departmentId) params.department_id = departmentId;
    const res = await api.get<BudgetResp>('/api/budgets', params);
    if (res.error) { addToast('error', `Copy failed: ${res.error.error}`); return; }
    const rows = res.data?.accounts ?? [];
    if (rows.length === 0) { addToast('error', `No FY ${fiscalYear - 1} budget to copy.`); return; }
    setDraft((prev) => {
      const next = { ...prev };
      for (const row of rows) { next[row.accountId] = { ...row.periods }; markDirty(row.accountId); }
      return next;
    });
    addToast('success', `Copied ${rows.length} accounts from FY ${fiscalYear - 1}. Review, then Save.`);
  }, [locationId, fiscalYear, departmentId, markDirty]);

  const save = useCallback(async () => {
    if (dirty.current.size === 0) return;
    setSaving(true);
    const entries: { account_id: string; period_number: number; amount_cents: number }[] = [];
    for (const accountId of dirty.current) {
      const p = draft[accountId] ?? {};
      for (const n of PERIODS) entries.push({ account_id: accountId, period_number: n, amount_cents: p[n] ?? 0 });
    }
    const res = await api.post<{ saved: number }>('/api/budgets', {
      location_id: locationId,
      fiscal_year: fiscalYear,
      department_id: departmentId,
      entries,
    });
    setSaving(false);
    if (res.error) { addToast('error', `Save failed: ${res.error.error}`); return; }
    dirty.current = new Set();
    setDirtyCount(0);
    addToast('success', `Budget saved (${entries.length} cells).`);
  }, [draft, locationId, fiscalYear, departmentId]);

  // ── States ──
  if (!locationId) {
    return (
      <div className="card p-12 text-center">
        <Building2 size={26} className="mx-auto text-slate-600 mb-3" />
        <p className="text-sm text-slate-300 font-medium">Select a company to author its budget</p>
        <p className="text-xs text-slate-500 mt-1">Budgets are entered per company (and optionally per department) for a fiscal year.</p>
      </div>
    );
  }
  if (loading) return <div className="card p-12 flex items-center justify-center"><Loader2 size={24} className="animate-spin text-slate-500" /></div>;
  if (error) return <div className="card p-8 text-center"><AlertCircle size={24} className="mx-auto text-red-400 mb-2" /><p className="text-sm text-red-400">{error}</p></div>;
  if (accounts.length === 0) {
    return (
      <div className="card p-10 text-center">
        <Info size={22} className="mx-auto text-slate-600 mb-2" />
        <p className="text-sm text-slate-400">No approved income-statement accounts for this company.</p>
        <p className="text-xs text-slate-500 mt-1">Approve revenue / COGS / OPEX accounts in the Chart of Accounts first.</p>
      </div>
    );
  }

  return (
    <div>
      {/* Action bar */}
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <p className="text-xs text-slate-500">
          FY {fiscalYear} · {locationName}{departmentId ? ' · department' : ' · company-level'} · monthly budget in dollars
        </p>
        <div className="flex items-center gap-2">
          <button onClick={copyPriorYear} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 border border-slate-700 text-slate-300 hover:border-slate-600">
            <Copy size={12} /> Copy FY {fiscalYear - 1}
          </button>
          <button
            onClick={save}
            disabled={saving || dirtyCount === 0}
            className={clsx('flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors',
              dirtyCount > 0 && !saving ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700')}
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            {saving ? 'Saving…' : dirtyCount > 0 ? `Save ${dirtyCount} changed` : 'Saved'}
          </button>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800/50">
                <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500 sticky left-0 bg-slate-950 z-10 min-w-[220px]">Account</th>
                {MONTHS.map((m) => <th key={m} className="px-2 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500 min-w-[84px]">{m}</th>)}
                <th className="px-3 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500 min-w-[110px] bg-slate-800/20">Annual</th>
                <th className="px-2 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500 min-w-[70px]">Spread</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map((section) => {
                const sectionTotal = section.accounts.reduce((s, a) => s + rowTotal(a.id), 0);
                return (
                  <FragmentSection
                    key={section.type}
                    label={TYPE_LABEL[section.type] ?? section.type}
                    total={sectionTotal}
                    accounts={section.accounts}
                    draft={draft}
                    rowTotal={rowTotal}
                    onCell={setCell}
                    onSpread={spreadAnnual}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function FragmentSection({ label, total, accounts, draft, rowTotal, onCell, onSpread }: {
  label: string; total: number; accounts: AccountLite[];
  draft: Draft; rowTotal: (id: string) => number;
  onCell: (id: string, period: number, cents: number) => void;
  onSpread: (id: string, annualCents: number) => void;
}) {
  return (
    <>
      <tr className="bg-slate-800/30">
        <td className="px-4 py-2 text-xs font-semibold text-slate-300 uppercase sticky left-0 bg-slate-800/30 z-10">{label}</td>
        <td colSpan={MONTHS.length} />
        <td className="px-3 py-2 text-right text-xs font-mono font-semibold text-slate-300 bg-slate-800/20">{formatMoney(total)}</td>
        <td />
      </tr>
      {accounts.map((a) => {
        const periods = draft[a.id] ?? {};
        return (
          <tr key={a.id} className="hover:bg-slate-800/20">
            <td className="px-4 py-1 text-xs text-slate-400 sticky left-0 bg-slate-950 z-10">
              <span className="font-mono text-slate-600 mr-1.5">{a.accountNumber}</span>{a.name}
            </td>
            {PERIODS.map((n) => (
              <td key={n} className="px-1 py-1">
                <DollarCell value={periods[n] ?? 0} onCommit={(cents) => onCell(a.id, n, cents)} />
              </td>
            ))}
            <td className="px-3 py-1 text-right font-mono text-xs font-medium text-slate-200 bg-slate-800/20">{formatMoney(rowTotal(a.id))}</td>
            <td className="px-2 py-1 text-center">
              <SpreadButton onSpread={(cents) => onSpread(a.id, cents)} />
            </td>
          </tr>
        );
      })}
    </>
  );
}

// Editable dollar cell — local text state, commits cents on blur/Enter.
function DollarCell({ value, onCommit }: { value: number; onCommit: (cents: number) => void }) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(value ? String(centsToDollars(value)) : '');
  }, [value, focused]);

  const commit = () => {
    setFocused(false);
    const trimmed = text.trim();
    const cents = trimmed === '' ? 0 : dollarsToCents(trimmed);
    if (Number.isNaN(cents)) { setText(value ? String(centsToDollars(value)) : ''); return; }
    if (cents !== value) onCommit(cents);
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      value={text}
      placeholder="—"
      onFocus={() => setFocused(true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      className="w-full px-1.5 py-1 bg-slate-900/60 border border-slate-800 rounded text-right font-mono text-xs text-slate-200 placeholder:text-slate-700 focus:outline-none focus:border-emerald-500/50 focus:bg-slate-900"
    />
  );
}

// Spread annual: prompt for a full-year amount, divide evenly across 12 months.
function SpreadButton({ onSpread }: { onSpread: (annualCents: number) => void }) {
  return (
    <button
      title="Spread an annual amount evenly across 12 months"
      onClick={() => {
        const raw = window.prompt('Annual amount to spread evenly across 12 months (dollars):');
        if (raw == null) return;
        const cents = dollarsToCents(raw);
        if (Number.isNaN(cents)) { addToast('error', 'Enter a valid dollar amount.'); return; }
        onSpread(cents);
      }}
      className="p-1 rounded text-slate-500 hover:text-emerald-400 hover:bg-slate-800"
    >
      <Wand2 size={13} />
    </button>
  );
}
