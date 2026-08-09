'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { Loader2, AlertCircle, Building2, Calendar, TrendingUp, Info } from 'lucide-react';
import { useQuery } from '@/hooks';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { isSpecificCompany } from '@/lib/company-scope';
import { formatMoney } from '@meritbooks/shared';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CURRENT_YEAR = new Date().getFullYear();
const FISCAL_YEARS = [CURRENT_YEAR + 1, CURRENT_YEAR, CURRENT_YEAR - 1];
const TYPE_LABEL: Record<string, string> = {
  REVENUE: 'Revenue', COGS: 'Cost of Goods Sold', OPEX: 'Operating Expenses', OTHER: 'Other',
};

interface LocationLite { id: string; name: string; short_code: string }

interface MonthCell { month: number; isActual: boolean; actualCents: number; budgetCents: number; reforecastCents: number }
interface AccountRow {
  accountId: string; accountNumber: string; accountName: string; accountType: string;
  actualToDateCents: number; budgetFullYearCents: number; projectedRemainingCents: number;
  reforecastFullYearCents: number; varianceCents: number; variancePct: number; isFavorable: boolean;
  months: MonthCell[];
}
interface Totals { budgetFullYearCents: number; actualToDateCents: number; reforecastFullYearCents: number; varianceCents: number }
interface ReforecastResp {
  fiscalYear: number; method: string; closedThroughPeriod: number;
  accounts: AccountRow[]; totalsByType: Record<string, Totals>; grandTotals: Totals;
}

export function ReforecastView() {
  // Seed from the header's active company so the reforecast opens on the right
  // entity; the dropdown remains switchable (incl. All-Companies consolidated).
  const { activeCompanyId } = useActiveCompany();
  const [locationId, setLocationId] = useState(() =>
    isSpecificCompany(activeCompanyId) ? activeCompanyId : '',
  );
  const [companyTouched, setCompanyTouched] = useState(false);
  const [fiscalYear, setFiscalYear] = useState(CURRENT_YEAR);

  useEffect(() => {
    if (companyTouched) return;
    if (isSpecificCompany(activeCompanyId) && locationId !== activeCompanyId) {
      setLocationId(activeCompanyId);
    }
  }, [activeCompanyId, companyTouched, locationId]);
  const [method, setMethod] = useState<'budget_remaining' | 'run_rate'>('budget_remaining');
  const [closedThrough, setClosedThrough] = useState<number | null>(null); // null => server default
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data: locData } = useQuery<LocationLite[]>('/api/locations');
  const locations = useMemo(() => locData ?? [], [locData]);

  const params = useMemo(() => {
    const p: Record<string, string> = { fiscal_year: String(fiscalYear), method };
    if (locationId) p.location_id = locationId;
    if (closedThrough !== null) p.closed_through = String(closedThrough);
    return p;
  }, [locationId, fiscalYear, method, closedThrough]);

  const { data, isLoading, error } = useQuery<ReforecastResp>('/api/budgets/reforecast', params);

  const closed = data?.closedThroughPeriod ?? 0;

  return (
    <div>
      {/* Controls */}
      <div className="flex items-center gap-2 mb-5 p-3 rounded-xl bg-slate-800/20 border border-slate-800 flex-wrap">
        <div className="flex items-center gap-1.5">
          <Building2 size={13} className="text-slate-500" />
          <select value={locationId} onChange={(e) => { setCompanyTouched(true); setLocationId(e.target.value); }} className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white max-w-[240px]">
            <option value="">All Companies (Consolidated)</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.short_code} · {l.name}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <Calendar size={13} className="text-slate-500" />
          <select value={fiscalYear} onChange={(e) => setFiscalYear(parseInt(e.target.value, 10))} className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white font-mono">
            {FISCAL_YEARS.map((y) => <option key={y} value={y}>FY {y}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-2xs uppercase text-slate-500">Closed through</span>
          <select
            value={closedThrough ?? closed}
            onChange={(e) => setClosedThrough(parseInt(e.target.value, 10))}
            className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white"
          >
            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => (
              <option key={n} value={n}>{n === 0 ? 'None (pure budget)' : MONTHS[n - 1]}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-2xs uppercase text-slate-500">Open months</span>
          <div className="flex rounded-lg overflow-hidden border border-slate-700">
            <MethodTab active={method === 'budget_remaining'} label="Budget" onClick={() => setMethod('budget_remaining')} />
            <MethodTab active={method === 'run_rate'} label="Run-rate" onClick={() => setMethod('run_rate')} />
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="card p-12 flex items-center justify-center"><Loader2 size={24} className="animate-spin text-slate-500" /></div>
      ) : error ? (
        <div className="card p-8 text-center"><AlertCircle size={24} className="mx-auto text-red-400 mb-2" /><p className="text-sm text-red-400">{error}</p></div>
      ) : !data || data.accounts.length === 0 ? (
        <div className="card p-12 text-center">
          <TrendingUp size={26} className="mx-auto text-slate-600 mb-3" />
          <p className="text-sm text-slate-300 font-medium">No budget or actuals for this scope yet</p>
          <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">Author a budget (in Budget Entry or the Driver Builder) and post GL activity, then the rolling reforecast blends actuals-to-date with the remaining projection.</p>
        </div>
      ) : (
        <>
          {/* Summary strip */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
            <SummaryCard label="FY Budget" value={data.grandTotals.budgetFullYearCents} />
            <SummaryCard label={`Actual (thru ${closed > 0 ? MONTHS[closed - 1] : '—'})`} value={data.grandTotals.actualToDateCents} />
            <SummaryCard label="FY Reforecast" value={data.grandTotals.reforecastFullYearCents} accent />
            <SummaryCard label="Variance vs Budget" value={data.grandTotals.varianceCents} variance />
          </div>

          {/* Per-type sections */}
          {(['REVENUE', 'COGS', 'OPEX', 'OTHER'] as const).map((type) => {
            const rows = data.accounts.filter((a) => a.accountType === type);
            if (rows.length === 0) return null;
            const t = data.totalsByType[type];
            return (
              <div key={type} className="card overflow-hidden mb-4">
                <div className="px-4 py-2.5 bg-slate-800/30 flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase text-slate-300">{TYPE_LABEL[type]}</span>
                  <div className="flex items-center gap-5 text-xs font-mono">
                    <span className="text-slate-500">Bdgt {formatMoney(t.budgetFullYearCents, { compact: true })}</span>
                    <span className="text-slate-200">Refcst {formatMoney(t.reforecastFullYearCents, { compact: true })}</span>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-slate-800/50">
                        <th className="px-4 py-2 text-left text-2xs font-semibold uppercase text-slate-500">Account</th>
                        <th className="px-3 py-2 text-right text-2xs font-semibold uppercase text-slate-500">FY Budget</th>
                        <th className="px-3 py-2 text-right text-2xs font-semibold uppercase text-slate-500">Actual to date</th>
                        <th className="px-3 py-2 text-right text-2xs font-semibold uppercase text-slate-500">Proj. remaining</th>
                        <th className="px-3 py-2 text-right text-2xs font-semibold uppercase text-slate-500">FY Reforecast</th>
                        <th className="px-3 py-2 text-right text-2xs font-semibold uppercase text-slate-500">Variance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <Fragment key={r.accountId}>
                          <tr
                            className="hover:bg-slate-800/20 cursor-pointer"
                            onClick={() => setExpanded(expanded === r.accountId ? null : r.accountId)}
                          >
                            <td className="px-4 py-1.5 text-slate-300 whitespace-nowrap">
                              <span className="font-mono text-slate-600 mr-1.5">{r.accountNumber}</span>{r.accountName}
                            </td>
                            <td className="px-3 py-1.5 text-right font-mono text-slate-400">{formatMoney(r.budgetFullYearCents)}</td>
                            <td className="px-3 py-1.5 text-right font-mono text-slate-400">{formatMoney(r.actualToDateCents)}</td>
                            <td className="px-3 py-1.5 text-right font-mono text-slate-400">{formatMoney(r.projectedRemainingCents)}</td>
                            <td className="px-3 py-1.5 text-right font-mono font-medium text-slate-100">{formatMoney(r.reforecastFullYearCents)}</td>
                            <td className={clsx('px-3 py-1.5 text-right font-mono font-medium', r.isFavorable ? 'text-emerald-400' : 'text-red-400')}>
                              {formatMoney(r.varianceCents, { showSign: true })}
                              <span className="text-2xs text-slate-500 ml-1">{r.variancePct > 0 ? '+' : ''}{r.variancePct}%</span>
                            </td>
                          </tr>
                          {expanded === r.accountId && (
                            <tr>
                              <td colSpan={6} className="px-4 py-2 bg-slate-900/40">
                                <MonthlyStrip months={r.months} />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
          <p className="text-2xs text-slate-500 flex items-center gap-1">
            <Info size={11} /> Click a row to see the month-by-month blend. Green months are posted actuals; the rest are projected ({method === 'run_rate' ? 'closed-month run-rate' : 'remaining budget'}). Variance is reforecast vs the original budget.
          </p>
        </>
      )}
    </div>
  );
}

function MethodTab({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className={clsx('px-3 py-1.5 text-xs font-medium', active ? 'bg-emerald-500/15 text-emerald-400' : 'bg-slate-800 text-slate-400 hover:text-white')}>
      {label}
    </button>
  );
}

function SummaryCard({ label, value, accent, variance }: { label: string; value: number; accent?: boolean; variance?: boolean }) {
  const color = variance ? (value >= 0 ? 'text-emerald-400' : 'text-red-400') : accent ? 'text-white' : 'text-slate-200';
  return (
    <div className="card p-3.5">
      <p className="text-2xs uppercase text-slate-500 mb-1">{label}</p>
      <p className={clsx('text-lg font-mono font-semibold', color)}>{formatMoney(value, { showSign: variance })}</p>
    </div>
  );
}

function MonthlyStrip({ months }: { months: MonthCell[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-2xs">
        <thead>
          <tr>
            <th className="px-2 py-1 text-left text-slate-500"></th>
            {months.map((m) => (
              <th key={m.month} className={clsx('px-2 py-1 text-right font-semibold', m.isActual ? 'text-emerald-400' : 'text-slate-500')}>{MONTHS[m.month - 1]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="px-2 py-1 text-slate-500">Budget</td>
            {months.map((m) => <td key={m.month} className="px-2 py-1 text-right font-mono text-slate-500">{m.budgetCents === 0 ? '—' : formatMoney(m.budgetCents, { compact: true })}</td>)}
          </tr>
          <tr>
            <td className="px-2 py-1 text-slate-300 font-medium">Reforecast</td>
            {months.map((m) => (
              <td key={m.month} className={clsx('px-2 py-1 text-right font-mono', m.isActual ? 'text-emerald-400' : 'text-slate-300')}>
                {m.reforecastCents === 0 ? '—' : formatMoney(m.reforecastCents, { compact: true })}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
