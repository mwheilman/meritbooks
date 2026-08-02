'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import {
  Loader2, AlertCircle, Building2, Plus, Trash2, Save, Calculator, Sparkles, Info,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { useQuery, addToast } from '@/hooks';
import { formatMoney, dollarsToCents, centsToDollars } from '@meritbooks/shared';
import {
  expandDrivers, MONTHS_IN_YEAR,
  type BudgetDriver, type DriverType, type AccountType,
} from '@/lib/budget/drivers';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PNL_TYPES: AccountType[] = ['REVENUE', 'COGS', 'OPEX', 'OTHER'];
const CURRENT_YEAR = new Date().getFullYear();
const FISCAL_YEARS = [CURRENT_YEAR + 1, CURRENT_YEAR, CURRENT_YEAR - 1];

const DRIVER_LABELS: Record<DriverType, string> = {
  volume_x_rate: 'Volume × Rate',
  percent_of_revenue: '% of Revenue',
  fixed: 'Fixed Amount',
  growth_rate: 'Growth Rate',
};

interface LocationLite { id: string; name: string; short_code: string }
interface AccountLite { id: string; accountNumber: string; name: string; accountType: string; isActive: boolean; approvalStatus: string }

// A single client-side editable driver. Numbers are held in display units
// (dollars / percent) and converted to the engine's cents/bps at expand time.
interface DriftRow {
  id: string;
  label: string;
  accountId: string;
  driverType: DriverType;
  unitRateDollars: string; // volume_x_rate
  unitsPerMonth: string; // volume_x_rate (applied to all 12)
  percent: string; // percent_of_revenue (e.g. "30")
  annualDollars: string; // fixed
  baseMonthlyDollars: string; // growth_rate
  growthPct: string; // growth_rate (per month)
}

let seq = 0;
const newRow = (): DriftRow => ({
  id: `d${Date.now()}-${seq++}`,
  label: '',
  accountId: '',
  driverType: 'fixed',
  unitRateDollars: '',
  unitsPerMonth: '',
  percent: '',
  annualDollars: '',
  baseMonthlyDollars: '',
  growthPct: '',
});

/** Convert the editable rows into engine drivers (only complete ones). */
function toDrivers(rows: DriftRow[], accountType: (id: string) => AccountType | null): BudgetDriver[] {
  const out: BudgetDriver[] = [];
  for (const r of rows) {
    const type = accountType(r.accountId);
    if (!r.accountId || !type) continue;
    const base = { id: r.id, label: r.label || DRIVER_LABELS[r.driverType], accountId: r.accountId, accountType: type };
    if (r.driverType === 'volume_x_rate') {
      const rate = dollarsToCents(r.unitRateDollars || '0');
      const units = Number(r.unitsPerMonth || '0');
      if (Number.isNaN(rate) || Number.isNaN(units)) continue;
      out.push({ ...base, driverType: 'volume_x_rate', unitRateCents: rate, volumeByMonth: new Array(MONTHS_IN_YEAR).fill(units) });
    } else if (r.driverType === 'percent_of_revenue') {
      const bps = Math.round(Number(r.percent || '0') * 100);
      if (Number.isNaN(bps)) continue;
      out.push({ ...base, driverType: 'percent_of_revenue', percentBps: bps });
    } else if (r.driverType === 'fixed') {
      const cents = dollarsToCents(r.annualDollars || '0');
      if (Number.isNaN(cents)) continue;
      out.push({ ...base, driverType: 'fixed', annualAmountCents: cents });
    } else {
      const baseCents = dollarsToCents(r.baseMonthlyDollars || '0');
      const growthBps = Math.round(Number(r.growthPct || '0') * 100);
      if (Number.isNaN(baseCents) || Number.isNaN(growthBps)) continue;
      out.push({ ...base, driverType: 'growth_rate', baseMonthlyCents: baseCents, monthlyGrowthBps: growthBps });
    }
  }
  return out;
}

export function DriverBuilder() {
  const [locationId, setLocationId] = useState('');
  const [fiscalYear, setFiscalYear] = useState(CURRENT_YEAR + 1);
  const [rows, setRows] = useState<DriftRow[]>([]);
  const [saving, setSaving] = useState(false);

  const { data: locData, isLoading: locLoading } = useQuery<LocationLite[]>('/api/locations');
  const locations = useMemo(() => locData ?? [], [locData]);

  const { data: acctResp, isLoading: acctLoading } = useQuery<{ data: AccountLite[] }>(
    locationId ? '/api/accounts' : null,
    locationId ? { location_id: locationId } : undefined,
  );
  const accounts = useMemo(
    () => (acctResp?.data ?? [])
      .filter((a) => PNL_TYPES.includes(a.accountType as AccountType) && a.isActive && a.approvalStatus === 'APPROVED')
      .sort((a, b) => a.accountNumber.localeCompare(b.accountNumber)),
    [acctResp],
  );
  const accountType = useCallback(
    (id: string): AccountType | null => {
      const a = accounts.find((x) => x.id === id);
      return a ? (a.accountType as AccountType) : null;
    },
    [accounts],
  );
  const accountLabel = useCallback(
    (id: string) => {
      const a = accounts.find((x) => x.id === id);
      return a ? `${a.accountNumber} · ${a.name}` : '—';
    },
    [accounts],
  );

  // Reload any previously-saved driver model for this scope.
  useEffect(() => {
    if (!locationId) { setRows([]); return; }
    let cancelled = false;
    (async () => {
      const res = await api.get<{ model: { drivers: BudgetDriver[] } | null }>(
        '/api/budgets/drivers',
        { location_id: locationId, fiscal_year: String(fiscalYear) },
      );
      if (cancelled) return;
      const saved = res.data?.model?.drivers;
      if (saved && saved.length > 0) {
        setRows(saved.map((d) => hydrate(d)));
      } else {
        setRows([]);
      }
    })();
    return () => { cancelled = true; };
  }, [locationId, fiscalYear]);

  const patchRow = useCallback((id: string, patch: Partial<DriftRow>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }, []);
  const removeRow = useCallback((id: string) => setRows((prev) => prev.filter((r) => r.id !== id)), []);

  // Live preview — pure, instant, deterministic (same engine as the API).
  const drivers = useMemo(() => toDrivers(rows, accountType), [rows, accountType]);
  const expansion = useMemo(() => expandDrivers(drivers), [drivers]);

  const save = useCallback(async () => {
    if (!locationId) { addToast('error', 'Select a company first.'); return; }
    if (drivers.length === 0) { addToast('error', 'Add at least one complete driver (label + account + values).'); return; }
    setSaving(true);
    const res = await api.post<{ saved: number; accounts: number }>('/api/budgets/drivers', {
      location_id: locationId,
      fiscal_year: fiscalYear,
      drivers,
      save: true,
    });
    setSaving(false);
    if (res.error) { addToast('error', `Save failed: ${res.error.error}`); return; }
    addToast('success', `Budget built from ${drivers.length} drivers → ${res.data?.accounts ?? 0} accounts, ${res.data?.saved ?? 0} cells saved.`);
  }, [locationId, fiscalYear, drivers]);

  return (
    <div>
      {/* Scope */}
      <div className="flex items-center gap-2 mb-5 p-3 rounded-xl bg-slate-800/20 border border-slate-800 flex-wrap">
        <Building2 size={13} className="text-slate-500" />
        <select
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
          className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white max-w-[260px]"
        >
          <option value="">Select a company…</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.short_code} · {l.name}</option>)}
        </select>
        <select
          value={fiscalYear}
          onChange={(e) => setFiscalYear(parseInt(e.target.value, 10))}
          className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white font-mono"
        >
          {FISCAL_YEARS.map((y) => <option key={y} value={y}>FY {y}</option>)}
        </select>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setRows((r) => [...r, newRow()])}
            disabled={!locationId}
            className={clsx('flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border',
              locationId ? 'bg-slate-800 border-slate-700 text-slate-300 hover:border-slate-600' : 'bg-slate-800/50 border-slate-800 text-slate-600 cursor-not-allowed')}
          >
            <Plus size={12} /> Add Driver
          </button>
          <button
            onClick={save}
            disabled={saving || drivers.length === 0}
            className={clsx('flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium',
              drivers.length > 0 && !saving ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed')}
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            {saving ? 'Building…' : 'Build Budget'}
          </button>
        </div>
      </div>

      {/* States */}
      {!locationId ? (
        <div className="card p-12 text-center">
          <Calculator size={26} className="mx-auto text-slate-600 mb-3" />
          <p className="text-sm text-slate-300 font-medium">Model a budget from drivers, not static cells</p>
          <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">Select a company, then add drivers (units × price, a cost as % of revenue, a fixed amount, or a growth curve). The engine expands them into monthly budget lines you can save as the plan of record.</p>
        </div>
      ) : locLoading || acctLoading ? (
        <div className="card p-12 flex items-center justify-center"><Loader2 size={24} className="animate-spin text-slate-500" /></div>
      ) : accounts.length === 0 ? (
        <div className="card p-10 text-center">
          <Info size={22} className="mx-auto text-slate-600 mb-2" />
          <p className="text-sm text-slate-400">No approved income-statement accounts for this company.</p>
          <p className="text-xs text-slate-500 mt-1">Approve revenue / COGS / OPEX accounts in the Chart of Accounts first.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
          {/* Driver editor */}
          <div className="space-y-3">
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase text-slate-500">
              <Sparkles size={12} className="text-indigo-400" /> Drivers ({rows.length})
            </div>
            {rows.length === 0 && (
              <div className="card p-8 text-center">
                <p className="text-sm text-slate-400">No drivers yet.</p>
                <button onClick={() => setRows([newRow()])} className="mt-2 text-xs text-emerald-400 hover:text-emerald-300">+ Add your first driver</button>
              </div>
            )}
            {rows.map((r) => (
              <DriverCard
                key={r.id}
                row={r}
                accounts={accounts}
                onChange={(patch) => patchRow(r.id, patch)}
                onRemove={() => removeRow(r.id)}
              />
            ))}
          </div>

          {/* Live preview */}
          <div>
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase text-slate-500 mb-3">
              <Calculator size={12} className="text-emerald-400" /> Expanded monthly budget (preview)
            </div>
            <div className="card overflow-hidden">
              {expansion.lines.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-500">Complete a driver to see its expansion.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-slate-800/50">
                        <th className="px-3 py-2 text-left text-2xs font-semibold uppercase text-slate-500 sticky left-0 bg-slate-950 min-w-[160px]">Account</th>
                        {MONTHS.map((m) => <th key={m} className="px-2 py-2 text-right text-2xs font-semibold uppercase text-slate-500 min-w-[64px]">{m}</th>)}
                        <th className="px-3 py-2 text-right text-2xs font-semibold uppercase text-slate-500 bg-slate-800/20">Annual</th>
                      </tr>
                    </thead>
                    <tbody>
                      {expansion.lines.map((line) => (
                        <tr key={line.accountId} className="hover:bg-slate-800/20">
                          <td className="px-3 py-1.5 text-slate-300 sticky left-0 bg-slate-950 whitespace-nowrap">{accountLabel(line.accountId)}</td>
                          {line.monthlyCents.map((c, i) => (
                            <td key={i} className="px-2 py-1.5 text-right font-mono text-slate-400">{c === 0 ? '—' : formatMoney(c, { compact: true })}</td>
                          ))}
                          <td className="px-3 py-1.5 text-right font-mono font-medium text-slate-200 bg-slate-800/20">{formatMoney(line.annualCents)}</td>
                        </tr>
                      ))}
                      <tr className="border-t border-slate-800 bg-slate-800/20">
                        <td className="px-3 py-2 text-slate-300 font-semibold sticky left-0 bg-slate-900">Revenue base</td>
                        {expansion.revenueByMonth.map((c, i) => (
                          <td key={i} className="px-2 py-2 text-right font-mono text-emerald-400">{c === 0 ? '—' : formatMoney(c, { compact: true })}</td>
                        ))}
                        <td className="px-3 py-2 text-right font-mono font-semibold text-emerald-400 bg-slate-800/30">{formatMoney(expansion.totalRevenueCents)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <p className="text-2xs text-slate-500 mt-2 flex items-center gap-1">
              <Info size={11} /> % of Revenue drivers are applied to the summed revenue base above. Saving writes these cells to the plan-of-record budget.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function DriverCard({ row, accounts, onChange, onRemove }: {
  row: DriftRow;
  accounts: AccountLite[];
  onChange: (patch: Partial<DriftRow>) => void;
  onRemove: () => void;
}) {
  const field = 'w-full px-2 py-1.5 bg-slate-900/60 border border-slate-800 rounded text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500/50';
  return (
    <div className="card p-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <input
          value={row.label}
          placeholder="Driver name (e.g. Widget sales)"
          onChange={(e) => onChange({ label: e.target.value })}
          className={clsx(field, 'flex-1')}
        />
        <button onClick={onRemove} className="p-1.5 rounded text-slate-500 hover:text-red-400 hover:bg-slate-800" title="Remove driver">
          <Trash2 size={13} />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <select value={row.accountId} onChange={(e) => onChange({ accountId: e.target.value })} className={field}>
          <option value="">Select account…</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.accountNumber} · {a.name}</option>)}
        </select>
        <select value={row.driverType} onChange={(e) => onChange({ driverType: e.target.value as DriverType })} className={field}>
          {(Object.keys(DRIVER_LABELS) as DriverType[]).map((t) => <option key={t} value={t}>{DRIVER_LABELS[t]}</option>)}
        </select>
      </div>

      {row.driverType === 'volume_x_rate' && (
        <div className="grid grid-cols-2 gap-2">
          <LabeledInput label="Units / month" value={row.unitsPerMonth} onChange={(v) => onChange({ unitsPerMonth: v })} placeholder="100" />
          <LabeledInput label="Price / unit ($)" value={row.unitRateDollars} onChange={(v) => onChange({ unitRateDollars: v })} placeholder="50.00" />
        </div>
      )}
      {row.driverType === 'percent_of_revenue' && (
        <LabeledInput label="% of revenue" value={row.percent} onChange={(v) => onChange({ percent: v })} placeholder="30" suffix="%" />
      )}
      {row.driverType === 'fixed' && (
        <LabeledInput label="Annual amount ($)" value={row.annualDollars} onChange={(v) => onChange({ annualDollars: v })} placeholder="120,000" />
      )}
      {row.driverType === 'growth_rate' && (
        <div className="grid grid-cols-2 gap-2">
          <LabeledInput label="Jan amount ($)" value={row.baseMonthlyDollars} onChange={(v) => onChange({ baseMonthlyDollars: v })} placeholder="10,000" />
          <LabeledInput label="Growth / month" value={row.growthPct} onChange={(v) => onChange({ growthPct: v })} placeholder="2" suffix="%" />
        </div>
      )}
    </div>
  );
}

function LabeledInput({ label, value, onChange, placeholder, suffix }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; suffix?: string;
}) {
  return (
    <label className="block">
      <span className="block text-2xs uppercase text-slate-500 mb-1">{label}</span>
      <div className="relative">
        <input
          type="text"
          inputMode="decimal"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-2 py-1.5 bg-slate-900/60 border border-slate-800 rounded text-right font-mono text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500/50"
        />
        {suffix && <span className="absolute right-2 top-1.5 text-2xs text-slate-500">{suffix}</span>}
      </div>
    </label>
  );
}

/** Rehydrate a stored engine driver back into an editable row. */
function hydrate(d: BudgetDriver): DriftRow {
  const base = newRow();
  base.id = d.id;
  base.label = d.label;
  base.accountId = d.accountId;
  base.driverType = d.driverType;
  if (d.driverType === 'volume_x_rate') {
    base.unitRateDollars = String(centsToDollars(d.unitRateCents));
    base.unitsPerMonth = String(d.volumeByMonth[0] ?? 0);
  } else if (d.driverType === 'percent_of_revenue') {
    base.percent = String(d.percentBps / 100);
  } else if (d.driverType === 'fixed') {
    base.annualDollars = String(centsToDollars(d.annualAmountCents));
  } else {
    base.baseMonthlyDollars = String(centsToDollars(d.baseMonthlyCents));
    base.growthPct = String(d.monthlyGrowthBps / 100);
  }
  return base;
}
