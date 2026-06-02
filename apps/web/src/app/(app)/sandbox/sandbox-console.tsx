'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Database, Play, RotateCcw, Loader2, CheckCircle2, XCircle, AlertCircle,
  Building2, Network, Users, Package, Briefcase, CalendarClock, ListChecks,
} from 'lucide-react';
import { clsx } from 'clsx';
import { addToast } from '@/hooks';

// ── Types mirrored from the sandbox service responses ──
interface SandboxEntity {
  id: string;
  name: string;
  short_code: string;
  fiscal_year_start_month: number;
}
interface SandboxStatus {
  hasOrg: boolean;
  orgId: string | null;
  orgName: string | null;
  accountCount: number;
  entities: SandboxEntity[];
  departmentCount: number;
  customerCount: number;
  vendorCount: number;
  itemCount: number;
  employeeCount: number;
  jobCount: number;
  openPeriods: number;
  closedPeriods: number;
  seeded: boolean;
}
interface SeedStep { step: string; detail: string }
interface RoundTripPath {
  path: 'cost' | 'recognition' | 'billing' | 'rejection' | 'pos_recognition' | 'idempotency' | 'missing_account' | 'dept_invoice' | 'dept_invoice_rejection';
  label: string;
  pass: boolean;
  detail: string;
}
interface RoundTripResult { asOf: string; paths: RoundTripPath[]; allPassed: boolean }

type Action = 'seed' | 'reset' | 'verify' | null;

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function SandboxConsole() {
  const [status, setStatus] = useState<SandboxStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Action>(null);
  const [resetBeforeRun, setResetBeforeRun] = useState(true);
  const [steps, setSteps] = useState<SeedStep[] | null>(null);
  const [roundTrip, setRoundTrip] = useState<RoundTripResult | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/sandbox', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) { setLoadError(body.error ?? 'Failed to load status'); setStatus(null); }
      else setStatus(body.status as SandboxStatus);
    } catch {
      setLoadError('Network error while loading status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const run = useCallback(async (action: Exclude<Action, null>) => {
    if (busy) return;
    setBusy(action);
    if (action !== 'verify') setRoundTrip(null);
    try {
      const res = await fetch('/api/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, resetFirst: action === 'verify' ? resetBeforeRun : false }),
      });
      const body = await res.json();
      if (!res.ok) { addToast('error', body.error ?? `${action} failed`); return; }

      if (action === 'verify') {
        const rt = body.roundTrip as RoundTripResult;
        setRoundTrip(rt);
        addToast(rt.allPassed ? 'success' : 'error', rt.allPassed ? `All ${rt.paths.length} checks passed` : 'Some checks did not pass — see results');
      } else {
        setSteps((body.steps as SeedStep[]) ?? null);
        addToast('success', action === 'reset' ? 'Sandbox reset and re-seeded' : 'Sandbox seeded');
      }
      if (body.status) setStatus(body.status as SandboxStatus);
      else await loadStatus();
    } catch {
      addToast('error', 'Network error');
    } finally {
      setBusy(null);
    }
  }, [busy, loadStatus, resetBeforeRun]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-slate-400 text-sm py-12 justify-center">
        <Loader2 size={16} className="animate-spin" /> Loading sandbox status…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-6 text-center">
        <AlertCircle className="mx-auto mb-2 text-red-400" size={22} />
        <p className="text-sm text-red-300">{loadError}</p>
        <button onClick={loadStatus} className="mt-3 text-xs px-3 py-1.5 rounded-md border border-slate-700 text-slate-300 hover:bg-slate-800 transition-colors">
          Retry
        </button>
      </div>
    );
  }

  const s = status;
  const seeded = !!s?.seeded;

  return (
    <div className="space-y-6">
      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-3">
        <ActionButton
          onClick={() => run('seed')}
          busy={busy === 'seed'}
          disabled={!!busy}
          icon={Database}
          variant="primary"
          label={seeded ? 'Re-seed / Repair' : 'Seed sandbox'}
        />
        <ActionButton
          onClick={() => run('verify')}
          busy={busy === 'verify'}
          disabled={!!busy || !seeded}
          icon={Play}
          variant="emerald"
          label="Run round-trip"
        />
        <label className="inline-flex items-center gap-2 text-xs text-slate-400 select-none cursor-pointer">
          <input
            type="checkbox"
            checked={resetBeforeRun}
            onChange={(e) => setResetBeforeRun(e.target.checked)}
            disabled={!!busy}
            className="h-3.5 w-3.5 rounded border-slate-600 bg-slate-800 text-emerald-500 focus:ring-emerald-500/40"
          />
          Reset before run
        </label>
        <ActionButton
          onClick={() => {
            if (confirm('Reset will clear all transactional and master data for this tenant, then re-seed. The chart of accounts, entities, and fiscal periods are preserved. Continue?')) run('reset');
          }}
          busy={busy === 'reset'}
          disabled={!!busy || !s?.hasOrg}
          icon={RotateCcw}
          variant="danger"
          label="Reset & re-seed"
        />
        <span className="text-2xs text-slate-500 ml-auto">
          The round-trip is read-through-real-services: it drives JOB_PROGRESS, JOB_BILLING and JOB_COST through the deployed consumers.
        </span>
      </div>

      {/* Status tiles */}
      {!s?.hasOrg ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-8 text-center">
          <Database className="mx-auto mb-3 text-slate-600" size={28} />
          <p className="text-sm text-slate-300">No tenant exists yet.</p>
          <p className="text-xs text-slate-500 mt-1">Seed the sandbox to create a COA-complete test tenant.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <Tile icon={Building2} label="Entities" value={s.entities.length} />
          <Tile icon={ListChecks} label="Accounts" value={s.accountCount} />
          <Tile icon={Network} label="Departments" value={s.departmentCount} />
          <Tile icon={Briefcase} label="Jobs" value={s.jobCount} />
          <Tile icon={Users} label="Customers" value={s.customerCount} />
          <Tile icon={Package} label="Items" value={s.itemCount} />
        </div>
      )}

      {/* Entities + periods */}
      {s?.hasOrg && s.entities.length > 0 && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800 flex items-center gap-2">
            <Building2 size={14} className="text-slate-400" />
            <h2 className="text-sm font-medium text-slate-200">Entities</h2>
            <span className="ml-auto text-2xs text-slate-500 flex items-center gap-1">
              <CalendarClock size={12} /> {s.openPeriods} open · {s.closedPeriods} hard-closed periods
            </span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-2xs uppercase tracking-wide text-slate-500 border-b border-slate-800/70">
                <th className="text-left font-medium px-4 py-2">Company</th>
                <th className="text-left font-medium px-4 py-2">Code</th>
                <th className="text-left font-medium px-4 py-2">Fiscal year start</th>
              </tr>
            </thead>
            <tbody>
              {s.entities.map((e) => (
                <tr key={e.id} className="border-b border-slate-800/50 last:border-0">
                  <td className="px-4 py-2.5 text-slate-200">{e.name}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-400">{e.short_code}</td>
                  <td className="px-4 py-2.5 text-slate-300">{MONTHS[e.fiscal_year_start_month] ?? e.fiscal_year_start_month}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Round-trip results */}
      {roundTrip && (
        <div className={clsx(
          'rounded-xl border overflow-hidden',
          roundTrip.allPassed ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-amber-500/30 bg-amber-500/5',
        )}>
          <div className="px-4 py-3 border-b border-slate-800/70 flex items-center gap-2">
            {roundTrip.allPassed
              ? <CheckCircle2 size={15} className="text-emerald-400" />
              : <AlertCircle size={15} className="text-amber-400" />}
            <h2 className="text-sm font-medium text-slate-200">
              Cross-module round-trip {roundTrip.allPassed ? '— all paths passed' : '— review results'}
            </h2>
            <span className="ml-auto text-2xs text-slate-500">as of {roundTrip.asOf}</span>
          </div>
          <ul className="divide-y divide-slate-800/50">
            {roundTrip.paths.map((p) => (
              <li key={p.path} className="px-4 py-3 flex items-start gap-3">
                {p.pass
                  ? <CheckCircle2 size={16} className="text-emerald-400 shrink-0 mt-0.5" />
                  : <XCircle size={16} className="text-red-400 shrink-0 mt-0.5" />}
                <div className="min-w-0">
                  <p className={clsx('text-sm font-medium', p.pass ? 'text-slate-200' : 'text-red-300')}>{p.label}</p>
                  <p className="text-xs text-slate-400 mt-0.5">{p.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Seed log */}
      {steps && steps.length > 0 && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800">
            <h2 className="text-sm font-medium text-slate-200">Last seed log</h2>
          </div>
          <ul className="divide-y divide-slate-800/50">
            {steps.map((st, i) => (
              <li key={i} className="px-4 py-2.5 flex items-baseline gap-3">
                <span className="text-2xs font-mono uppercase tracking-wide text-emerald-400/80 w-40 shrink-0">{st.step}</span>
                <span className="text-xs text-slate-300">{st.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Tile({ icon: Icon, label, value }: { icon: typeof Database; label: string; value: number }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
      <div className="flex items-center gap-1.5 text-slate-500">
        <Icon size={13} />
        <span className="text-2xs uppercase tracking-wide">{label}</span>
      </div>
      <p className="mt-1 text-xl font-semibold text-white font-mono tabular-nums">{value}</p>
    </div>
  );
}

function ActionButton({
  onClick, busy, disabled, icon: Icon, label, variant,
}: {
  onClick: () => void;
  busy: boolean;
  disabled: boolean;
  icon: typeof Database;
  label: string;
  variant: 'primary' | 'emerald' | 'danger';
}) {
  const styles: Record<string, string> = {
    primary: 'border-slate-700 bg-slate-800/60 text-slate-100 hover:bg-slate-800',
    emerald: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25',
    danger: 'border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20',
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border text-sm font-medium transition-colors',
        styles[variant],
        disabled && 'opacity-50 cursor-not-allowed',
      )}
    >
      {busy ? <Loader2 size={15} className="animate-spin" /> : <Icon size={15} />}
      {label}
    </button>
  );
}
