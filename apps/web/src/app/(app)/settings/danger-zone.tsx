'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ShieldAlert, Download, Loader2, Trash2, Lock, Check, RefreshCw,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useToast } from '@/hooks';

interface PlanTable {
  key: string;
  schema: string;
  table: string;
  label: string;
  group: string;
  scope: 'transactional' | 'master_data' | 'chart_of_accounts';
  count: number;
  unavailable: boolean;
}

interface PreservedItem {
  label: string;
  detail: string;
}

interface PlanResponse {
  org: { id: string; name: string };
  rpcInstalled: boolean;
  preserved: PreservedItem[];
  tables: PlanTable[];
}

const SCOPE_LABEL: Record<PlanTable['scope'], string> = {
  transactional: 'Transactional & ledger data',
  master_data: 'Master data (customers, vendors, items, jobs, entities)',
  chart_of_accounts: 'Chart of accounts & fiscal periods',
};

function sumScope(tables: PlanTable[], scope: PlanTable['scope']): number {
  return tables.filter((t) => t.scope === scope).reduce((n, t) => n + t.count, 0);
}

export function DangerZone() {
  const { addToast } = useToast();
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState('');

  const [clearMasterData, setClearMasterData] = useState(false);
  const [clearChartOfAccounts, setClearChartOfAccounts] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [acknowledgeExport, setAcknowledgeExport] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [executing, setExecuting] = useState(false);

  const loadPlan = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/tenant-reset/plan', { cache: 'no-store' });
      if (res.status === 403) {
        setForbidden(true);
        setPlan(null);
        return;
      }
      if (!res.ok) {
        setError('Failed to load reset plan.');
        return;
      }
      const data = (await res.json()) as PlanResponse;
      setPlan(data);
      setForbidden(false);
    } catch {
      setError('Failed to load reset plan.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadPlan(); }, [loadPlan]);

  const optionQuery = useMemo(
    () => `clearMasterData=${clearMasterData}&clearChartOfAccounts=${clearChartOfAccounts}`,
    [clearMasterData, clearChartOfAccounts],
  );

  const inScopeTables = useMemo(() => {
    if (!plan) return [];
    return plan.tables.filter(
      (t) =>
        t.scope === 'transactional' ||
        (t.scope === 'master_data' && clearMasterData) ||
        (t.scope === 'chart_of_accounts' && clearChartOfAccounts),
    );
  }, [plan, clearMasterData, clearChartOfAccounts]);

  const totalToClear = useMemo(
    () => inScopeTables.reduce((n, t) => n + t.count, 0),
    [inScopeTables],
  );

  const nameMatches = plan ? confirmation.trim() === plan.org.name.trim() : false;
  const canExecute =
    !!plan && plan.rpcInstalled && nameMatches && acknowledgeExport && !executing;

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const res = await fetch(`/api/tenant-reset/export?${optionQuery}`, { cache: 'no-store' });
      if (!res.ok) {
        addToast('error', 'Export failed.');
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match?.[1] ?? 'meritbooks-reset-export.json';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setAcknowledgeExport(true);
      addToast('success', 'Export downloaded. Keep this file safe.');
    } catch {
      addToast('error', 'Export failed.');
    } finally {
      setExporting(false);
    }
  }, [optionQuery, addToast]);

  const handleExecute = useCallback(async () => {
    if (!canExecute || !plan) return;
    setExecuting(true);
    try {
      const res = await fetch('/api/tenant-reset/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmation: confirmation.trim(),
          clearMasterData,
          clearChartOfAccounts,
          acknowledgeExport: true,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 501) {
        addToast('error', 'Reset is unavailable until the admin RPC is installed.');
        return;
      }
      if (!res.ok) {
        addToast('error', data?.error ?? 'Reset failed.');
        return;
      }
      addToast('success', `Reset complete — cleared ${data.total ?? 0} rows.`);
      setConfirmation('');
      setAcknowledgeExport(false);
      await loadPlan();
    } catch {
      addToast('error', 'Reset failed.');
    } finally {
      setExecuting(false);
    }
  }, [canExecute, plan, confirmation, clearMasterData, clearChartOfAccounts, addToast, loadPlan]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 text-red-400 animate-spin" />
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="card p-6 border border-slate-700/60">
        <div className="flex items-center gap-3">
          <Lock className="w-5 h-5 text-slate-400" />
          <div>
            <h2 className="text-sm font-semibold text-white">Restricted</h2>
            <p className="text-xs text-slate-500 mt-1">
              Resetting a tenant requires a company administrator who is also platform staff.
              You do not have access to this action.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (error || !plan) {
    return (
      <div className="card p-6 border border-red-500/30">
        <div className="flex items-center justify-between">
          <p className="text-sm text-red-400">{error || 'Unable to load.'}</p>
          <button onClick={() => void loadPlan()} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white">
            <RefreshCw size={12} /> Retry
          </button>
        </div>
      </div>
    );
  }

  const inputCls = 'w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white focus:outline-none focus:border-red-500/50';

  return (
    <div className="space-y-5">
      {/* Header banner */}
      <div className="rounded-xl border border-red-500/40 bg-red-500/5 p-5">
        <div className="flex items-start gap-3">
          <ShieldAlert className="w-6 h-6 text-red-400 shrink-0 mt-0.5" />
          <div>
            <h2 className="text-lg font-semibold text-red-300">Danger Zone — Reset Tenant</h2>
            <p className="text-xs text-slate-400 mt-1 leading-relaxed">
              Clears demo/seed and transactional data for <span className="font-semibold text-white">{plan.org.name}</span> so
              you can go live from a clean slate. This is irreversible in the app. The organization,
              its users and memberships are never deleted. Export first — always.
            </p>
          </div>
        </div>
      </div>

      {!plan.rpcInstalled && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
          <p className="text-xs text-amber-300">
            Reset execution is unavailable until the admin database function is installed. You can still
            preview and export below; the reset button stays disabled.
          </p>
        </div>
      )}

      {/* What is preserved */}
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
          <Check className="w-4 h-4 text-emerald-400" /> Always preserved
        </h3>
        <ul className="grid sm:grid-cols-2 gap-2">
          {plan.preserved.map((p) => (
            <li key={p.label} className="text-xs text-slate-400">
              <span className="text-slate-200 font-medium">{p.label}</span>
              <span className="block text-slate-600">{p.detail}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Scope selection + counts */}
      <div className="card p-5 space-y-4">
        <h3 className="text-sm font-semibold text-white">What will be cleared</h3>

        {/* Transactional — always */}
        <ScopeRow
          label={SCOPE_LABEL.transactional}
          count={sumScope(plan.tables, 'transactional')}
          alwaysOn
        />

        {/* Master data — optional */}
        <ScopeRow
          label={SCOPE_LABEL.master_data}
          count={sumScope(plan.tables, 'master_data')}
          checked={clearMasterData}
          onChange={setClearMasterData}
        />

        {/* Chart of accounts — optional */}
        <ScopeRow
          label={SCOPE_LABEL.chart_of_accounts}
          count={sumScope(plan.tables, 'chart_of_accounts')}
          checked={clearChartOfAccounts}
          onChange={setClearChartOfAccounts}
          hint="Off = keep your chart of accounts (recommended for most go-lives)."
        />

        <div className="pt-3 border-t border-slate-800 flex items-center justify-between">
          <span className="text-xs text-slate-500">Total rows to clear (current selection)</span>
          <span className="font-mono text-sm text-red-300">{totalToClear.toLocaleString()}</span>
        </div>

        {/* Per-table detail */}
        <details className="text-xs">
          <summary className="cursor-pointer text-slate-400 hover:text-white select-none">
            Show table-by-table breakdown ({inScopeTables.length} tables)
          </summary>
          <div className="mt-3 max-h-64 overflow-auto rounded-lg border border-slate-800">
            <table className="w-full text-left">
              <thead className="text-[10px] uppercase text-slate-600 bg-slate-900/60 sticky top-0">
                <tr>
                  <th className="px-3 py-1.5 font-medium">Table</th>
                  <th className="px-3 py-1.5 font-medium">Group</th>
                  <th className="px-3 py-1.5 font-medium text-right">Rows</th>
                </tr>
              </thead>
              <tbody>
                {inScopeTables.map((t) => (
                  <tr key={t.key} className="border-t border-slate-800/60">
                    <td className="px-3 py-1.5 text-slate-300">
                      {t.label}
                      <span className="block text-[10px] text-slate-600 font-mono">{t.key}</span>
                    </td>
                    <td className="px-3 py-1.5 text-slate-500">{t.group}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-slate-300">
                      {t.unavailable ? '—' : t.count.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>

      {/* Export */}
      <div className="card p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-white">1. Export a backup first</h3>
            <p className="text-xs text-slate-500 mt-1">
              Download a JSON snapshot of everything the current selection would clear. Required before reset.
            </p>
          </div>
          <button
            onClick={() => void handleExport()}
            disabled={exporting}
            className={clsx(
              'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium shrink-0 transition-colors',
              exporting ? 'bg-slate-700 text-slate-500' : 'bg-slate-700 text-white hover:bg-slate-600',
            )}
          >
            {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            Export data
          </button>
        </div>
        {acknowledgeExport && (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-emerald-400">
            <Check size={12} /> Export downloaded.
          </p>
        )}
      </div>

      {/* Confirm + execute */}
      <div className="rounded-xl border border-red-500/40 bg-red-500/5 p-5 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-red-300">2. Confirm and reset</h3>
          <p className="text-xs text-slate-400 mt-1">
            Type the organization name <span className="font-mono text-white">{plan.org.name}</span> to confirm.
          </p>
        </div>

        <input
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
          placeholder={plan.org.name}
          className={inputCls}
          autoComplete="off"
          spellCheck={false}
        />

        <label className="flex items-start gap-2 text-xs text-slate-400 cursor-pointer">
          <input
            type="checkbox"
            checked={acknowledgeExport}
            onChange={(e) => setAcknowledgeExport(e.target.checked)}
            className="mt-0.5 accent-red-500"
          />
          I have exported a backup and understand this permanently clears the selected data.
        </label>

        <button
          onClick={() => void handleExecute()}
          disabled={!canExecute}
          className={clsx(
            'w-full flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold transition-colors',
            canExecute ? 'bg-red-600 text-white hover:bg-red-500' : 'bg-slate-800 text-slate-600 cursor-not-allowed',
          )}
        >
          {executing ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
          {plan.rpcInstalled ? `Reset ${plan.org.name}` : 'Reset unavailable (admin RPC not installed)'}
        </button>
        {!nameMatches && confirmation.length > 0 && (
          <p className="text-xs text-red-400">Name does not match.</p>
        )}
      </div>
    </div>
  );
}

function ScopeRow({
  label, count, checked, onChange, alwaysOn, hint,
}: {
  label: string;
  count: number;
  checked?: boolean;
  onChange?: (v: boolean) => void;
  alwaysOn?: boolean;
  hint?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-slate-800 bg-slate-900/40 p-3">
      <label className={clsx('flex items-start gap-2.5', alwaysOn ? '' : 'cursor-pointer')}>
        <input
          type="checkbox"
          checked={alwaysOn ? true : !!checked}
          disabled={alwaysOn}
          onChange={(e) => onChange?.(e.target.checked)}
          className="mt-0.5 accent-red-500"
        />
        <span>
          <span className="text-sm text-slate-200">{label}</span>
          {alwaysOn && <span className="ml-2 text-[10px] uppercase text-slate-600">always</span>}
          {hint && <span className="block text-[11px] text-slate-500 mt-0.5">{hint}</span>}
        </span>
      </label>
      <span className="font-mono text-sm text-slate-400 shrink-0">{count.toLocaleString()}</span>
    </div>
  );
}
