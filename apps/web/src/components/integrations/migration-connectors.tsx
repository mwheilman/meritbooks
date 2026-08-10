'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Loader2, Plug, AlertCircle, Check, Database, ArrowRight, PlayCircle, RefreshCw, ShieldCheck,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, addToast } from '@/hooks';

interface EntityDesc { entity: string; label: string; sourceFields: string[] }
interface MigrationProvider {
  id: string;
  name: string;
  authType: string;
  catalogId: string;
  description: string;
  fixtureAvailable: boolean;
  credentialsConfigured: boolean;
  openingBalanceEntity: string;
  entities: EntityDesc[];
}
interface ProvidersResponse { providers: MigrationProvider[] }
interface Company { id: string; name: string; short_code: string }

interface ImportResponse {
  ok: boolean;
  connected: boolean;
  source: string;
  erpId: string;
  providerName: string;
  reason?: string;
  mapping?: Record<string, string>;
  rows?: Record<string, string>[];
  summary?: {
    openingBalanceEntity: string;
    trialBalanceLines: number;
    totalDebitCents: number;
    totalCreditCents: number;
    balanced: boolean;
    entityCounts: Record<string, number>;
  };
  error?: string;
}

function monogram(name: string): string {
  const parts = name.replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/**
 * MigrationConnectors — the direct-API "migrate your prior books" surface.
 *
 * Lists QuickBooks Online / Xero / Sage as one-time migration sources. Each offers:
 *   • Connect — the OAuth handshake stub (via the existing connector connect route);
 *     honest about needing credentials that aren't configured yet.
 *   • Preview import — pulls the provider's sample (fixture) trial balance, maps it
 *     deterministically, stages the SAME historical-conversion session the CSV path
 *     stages, and opens the review so a person can see the balanced opening entry and
 *     tie it out before anything posts.
 */
export function MigrationConnectors() {
  const router = useRouter();
  const { data, isLoading, error, refetch } = useQuery<ProvidersResponse>('/api/integrations/erp/providers');

  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [asOfDate, setAsOfDate] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/locations')
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setCompanies(Array.isArray(d) ? d : []))
      .catch(() => setCompanies([]));
  }, []);

  const providers = data?.providers ?? [];

  const doConnect = useCallback(async (p: MigrationProvider) => {
    setConnectingId(p.id);
    try {
      const res = await fetch('/api/integrations/erp/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ erpId: p.catalogId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        addToast('error', body.error ?? 'Could not start that connection.');
        return;
      }
      addToast(
        'success',
        p.credentialsConfigured
          ? `${p.name} OAuth is configured — we noted your intent to connect.`
          : `Noted — ${p.name} needs OAuth credentials before a live pull. Use “Preview import” to try the pipeline now.`,
      );
    } catch {
      addToast('error', 'Network error starting that connection.');
    } finally {
      setConnectingId(null);
    }
  }, []);

  const doPreview = useCallback(async (p: MigrationProvider) => {
    if (!companyId) { addToast('error', 'Pick the company to migrate into first.'); return; }
    if (!asOfDate) { addToast('error', 'Pick the opening-balance as-of date first.'); return; }
    setBusyId(p.id);
    try {
      // 1. Pull + deterministically map the provider's trial balance (fixture).
      const impRes = await fetch('/api/integrations/erp/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ erpId: p.id, useFixture: true }),
      });
      const imp = (await impRes.json().catch(() => ({}))) as ImportResponse;
      if (!impRes.ok || !imp.ok) {
        addToast('error', imp.error ?? 'Could not pull the sample data.');
        return;
      }
      if (!imp.connected || !imp.mapping || !imp.rows) {
        addToast('error', imp.reason ?? 'Not connected — add credentials to enable live import.');
        return;
      }

      // 2. Feed the SAME conversion pipeline the CSV path uses (stages the session).
      const convRes = await fetch('/api/onboarding/conversion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, asOfDate, mapping: imp.mapping, rows: imp.rows }),
      });
      const conv = await convRes.json().catch(() => ({}));
      if (!convRes.ok || !conv.id) {
        addToast('error', conv.error ?? 'Could not stage the conversion.');
        return;
      }

      addToast(
        'success',
        `Pulled ${imp.summary?.trialBalanceLines ?? 0} opening-balance lines from ${p.name}. Review and tie out before go-live.`,
      );
      // 3. Open the review — the exact preview + tie-out + post UI (no second importer).
      router.push(`/onboarding/conversion?sessionId=${encodeURIComponent(conv.id)}`);
    } catch {
      addToast('error', 'Network error running the preview import.');
    } finally {
      setBusyId(null);
    }
  }, [companyId, asOfDate, router]);

  return (
    <div className="card p-4 space-y-4">
      <div className="flex items-start gap-2">
        <Database size={18} className="text-brand-400 mt-0.5 shrink-0" />
        <div>
          <p className="text-sm font-semibold text-white">Migrate your prior books (QuickBooks, Xero, Sage)</p>
          <p className="text-xs text-slate-400 mt-0.5 max-w-2xl">
            MeritBooks owns the general ledger — these are one-time migration sources. Connect to pull your prior
            books over the provider&apos;s API, or preview the import now with sample data. Every pull feeds the same
            historical-conversion review: a balanced opening entry that a person ties out before go-live.
          </p>
        </div>
      </div>

      {/* Target company + as-of date (shared by every preview). */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor="migration-company" className="block text-2xs font-medium uppercase tracking-wider text-slate-500 mb-1">Migrate into company</label>
          <select
            id="migration-company"
            value={companyId}
            onChange={(e) => setCompanyId(e.target.value)}
            className="w-full rounded-lg border border-slate-700 bg-surface-900 px-3 py-2 text-sm text-white"
          >
            <option value="">Select a company…</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.short_code})</option>)}
          </select>
          {companies.length === 0 && (
            <p className="text-2xs text-amber-400 mt-1">No companies yet — add a company first.</p>
          )}
        </div>
        <div>
          <label htmlFor="migration-as-of-date" className="block text-2xs font-medium uppercase tracking-wider text-slate-500 mb-1">Opening balances as of</label>
          <input
            id="migration-as-of-date"
            type="date"
            value={asOfDate}
            onChange={(e) => setAsOfDate(e.target.value)}
            className="w-full rounded-lg border border-slate-700 bg-surface-900 px-3 py-2 text-sm text-white"
          />
        </div>
      </div>

      {/* Provider list states. */}
      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-5 h-5 text-brand-400 animate-spin" />
        </div>
      ) : error ? (
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <AlertCircle size={20} className="text-danger-fg" />
          <p className="text-xs text-slate-400">Couldn&apos;t load migration providers.</p>
          <button onClick={() => void refetch()} className="flex items-center gap-1.5 text-xs text-brand-400 hover:text-brand-300">
            <RefreshCw size={12} /> Try again
          </button>
        </div>
      ) : providers.length === 0 ? (
        <p className="text-xs text-slate-500 py-4 text-center">No migration providers available.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {providers.map((p) => (
            <div key={p.id} className="rounded-xl border border-slate-800 bg-surface-900 p-3.5 flex flex-col gap-3">
              <div className="flex items-start gap-2.5">
                <div className="h-9 w-9 shrink-0 rounded-lg bg-surface-950 border border-slate-800 flex items-center justify-center text-[11px] font-semibold font-mono text-slate-300">
                  {monogram(p.name)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-white leading-tight">{p.name}</p>
                  <p className="text-[11px] text-slate-500 mt-0.5 leading-snug">{p.description}</p>
                </div>
              </div>

              {/* Credential status. */}
              <div>
                {p.credentialsConfigured ? (
                  <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border text-brand-300 bg-brand-500/10 border-brand-500/30">
                    <ShieldCheck size={10} /> OAuth configured
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border text-amber-300 bg-amber-500/10 border-amber-500/30">
                    <AlertCircle size={10} /> Not connected — add credentials
                  </span>
                )}
              </div>

              {/* Importable entities. */}
              <div className="flex flex-wrap gap-1">
                {p.entities.map((e) => (
                  <span key={e.entity} className="text-[10px] px-1.5 py-0.5 rounded bg-surface-950 border border-slate-800 text-slate-400">
                    {e.label}
                  </span>
                ))}
              </div>

              {/* Actions. */}
              <div className="mt-auto flex flex-col gap-2 pt-1">
                <button
                  onClick={() => void doConnect(p)}
                  disabled={connectingId === p.id}
                  className={clsx(
                    'w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
                    connectingId === p.id
                      ? 'bg-slate-700 text-slate-500 cursor-not-allowed'
                      : 'bg-surface-950 border border-slate-700 text-slate-200 hover:border-brand-500/40 hover:text-white',
                  )}
                >
                  {connectingId === p.id ? <Loader2 size={12} className="animate-spin" /> : <Plug size={12} />}
                  Connect <ArrowRight size={11} />
                </button>
                {p.fixtureAvailable && (
                  <button
                    onClick={() => void doPreview(p)}
                    disabled={busyId === p.id}
                    className={clsx(
                      'w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
                      busyId === p.id
                        ? 'bg-slate-700 text-slate-500 cursor-not-allowed'
                        : 'bg-brand-500 text-slate-900 hover:bg-brand-400',
                    )}
                  >
                    {busyId === p.id ? <Loader2 size={12} className="animate-spin" /> : <PlayCircle size={12} />}
                    Preview import
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="text-[11px] text-slate-600 flex items-center gap-1.5">
        <Check size={12} className="text-brand-400" />
        Preview import runs the full pipeline on sample data — nothing posts until a person ties out the opening balance.
        {companyId && asOfDate ? '' : ' Pick a company and as-of date to enable it.'}
      </p>
    </div>
  );
}
