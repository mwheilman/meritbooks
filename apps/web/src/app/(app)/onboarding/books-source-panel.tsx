'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  AlertCircle, AlertTriangle, ArrowRight, CalendarDays, CircleCheck, Info, Loader2, Plug, RefreshCw, Upload,
} from 'lucide-react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { cutoverExplanation, isIsoDate } from '@/lib/onboarding/conversion';
import type { PreflightFinding } from '@/lib/integrations/erp/quickbooks/preflight';
import type { QboCompanyProfile } from '@/lib/integrations/erp/quickbooks/company-info';
import { qboReturnMessage, type QboReturnCode } from '@/lib/integrations/erp/quickbooks/return-codes';
import { TrialBalanceExportSteps, type ExportSystem } from './conversion/export-steps';

export { isQboReturnCode, type QboReturnCode } from '@/lib/integrations/erp/quickbooks/return-codes';

/**
 * The wizard's "Where do your books live?" follow-through for QuickBooks / Xero / Sage
 * (FPB B2 — never a dead "not connected"):
 *
 *   QuickBooks, platform configured → Connect (full-page OAuth round-trip) → "Bring in
 *     my books" pulls the TB as of the cutover, shows the pre-flight findings in plain
 *     English, then stages it through the ONE conversion pipeline and hands the session
 *     to the Opening review. Nothing is posted here.
 *   QuickBooks not configured / Xero / Sage → the guided 60-second export → upload.
 */

export const QBO_STATUS_URL = '/api/integrations/erp/quickbooks/status';
export const QBO_PULL_URL = '/api/integrations/erp/quickbooks/pull';
const QBO_DISCONNECT_URL = '/api/integrations/erp/quickbooks/disconnect';

/** Full-page navigation target that starts the OAuth flow and comes back to `returnTo`. */
export function qboConnectHref(returnTo = '/onboarding'): string {
  return `/api/integrations/erp/quickbooks/connect?returnTo=${encodeURIComponent(returnTo)}`;
}

interface QboStatus {
  configured: boolean;
  connected: boolean;
  status: 'connected' | 'error' | 'not_connected';
  companyName?: string | null;
  lastSyncAt?: string | null;
  message?: string | null;
  error?: string;
}

interface QboPullConnected {
  ok: true;
  connected: true;
  asOfDate: string;
  company: QboCompanyProfile | null;
  mapping: Record<string, string>;
  rows: Record<string, string>[];
  summary: {
    trialBalanceLines: number;
    totalDebitCents: number;
    totalCreditCents: number;
    balanced: boolean;
    entityCounts: { accounts: number; customers: number; vendors: number; open_ar: number; open_ap: number };
  };
  preflight: PreflightFinding[];
  preflightError: string | null;
}
interface QboPullNotConnected { ok: true; connected: false; reason: string }
type QboPullResponse = QboPullConnected | QboPullNotConnected;

const TONE_CLS: Record<'success' | 'info' | 'warning' | 'danger', string> = {
  success: 'border-brand-500/30 bg-brand-500/10 text-brand-300',
  info: 'border-blue-500/25 bg-blue-500/5 text-blue-200',
  warning: 'border-warning/30 bg-warning/5 text-warning-fg',
  danger: 'border-danger/30 bg-danger/10 text-danger-fg',
};

function Banner({ tone, children, onDismiss }: { tone: keyof typeof TONE_CLS; children: ReactNode; onDismiss?: () => void }) {
  return (
    <div className={clsx('flex items-start gap-2 rounded-lg border px-4 py-2.5 text-sm', TONE_CLS[tone])} role={tone === 'danger' ? 'alert' : 'status'}>
      {tone === 'success' ? <CircleCheck size={15} className="mt-0.5 shrink-0" /> : tone === 'danger' ? <AlertCircle size={15} className="mt-0.5 shrink-0" /> : <Info size={15} className="mt-0.5 shrink-0" />}
      <span className="flex-1">{children}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="shrink-0 text-xs underline hover:no-underline">Dismiss</button>
      )}
    </div>
  );
}

// ── Guided export (QuickBooks not configured, Xero, Sage) ─────────────────────
export function GuidedExportPanel({
  system, cutoverDate, onUpload, hasCompany,
}: {
  system: ExportSystem;
  cutoverDate: string;
  onUpload: () => void;
  hasCompany: boolean;
}) {
  const name = system === 'quickbooks' ? 'QuickBooks' : system === 'xero' ? 'Xero' : 'Sage';
  return (
    <div className="card p-5 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
          <Upload size={15} className="text-brand-400" /> Export from {name} in 60 seconds
        </h3>
        <p className="text-xs text-slate-500 mt-1">
          One report is all we need to set your opening balances — your trial balance as of the day before MeritBooks
          takes over. Export it, then drop it in the next step. You review every number before anything posts.
        </p>
      </div>
      <TrialBalanceExportSteps asOfDate={cutoverDate} initialSystem={system} showSwitcher={false} />
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-slate-500">{hasCompany ? 'Got the file? Upload it next.' : 'Create your company above first.'}</p>
        <button
          type="button"
          onClick={onUpload}
          disabled={!hasCompany}
          className={clsx('shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
            hasCompany ? 'bg-brand-500 text-slate-900 hover:bg-brand-400' : 'bg-slate-700 text-slate-500 cursor-not-allowed')}
        >
          Upload my trial balance <ArrowRight size={14} />
        </button>
      </div>
    </div>
  );
}

// ── QuickBooks connect + live pull ────────────────────────────────────────────
export function QuickBooksConnectPanel({
  companyId, companyName, defaultCutoverDate, returnCode, returnReason, onDismissReturn, onStaged, onUpload,
}: {
  companyId: string | null;
  companyName: string | null;
  defaultCutoverDate: string;
  returnCode: QboReturnCode | null;
  returnReason: string | null;
  onDismissReturn: () => void;
  /** A conversion session was staged from the live pull — open the Opening review. */
  onStaged: (sessionId: string) => void;
  /** Fall back to the upload path (guided export). */
  onUpload: () => void;
}) {
  const [status, setStatus] = useState<QboStatus | null>(null);
  const [statusState, setStatusState] = useState<'loading' | 'ready' | 'error' | 'forbidden'>('loading');
  const [asOfDate, setAsOfDate] = useState(defaultCutoverDate);
  const [pull, setPull] = useState<QboPullConnected | null>(null);
  const [pulling, setPulling] = useState(false);
  const [staging, setStaging] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<{ message: string; details?: string[] } | null>(null);
  const [notConnectedReason, setNotConnectedReason] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setStatusState('loading');
    try {
      const res = await fetch(QBO_STATUS_URL);
      if (res.status === 401 || res.status === 403) { setStatusState('forbidden'); return; }
      const body = (await res.json()) as Partial<QboStatus>;
      if (typeof body.configured !== 'boolean') throw new Error(body.error ?? 'status failed');
      setStatus({
        configured: body.configured,
        connected: body.connected === true,
        status: body.status ?? 'not_connected',
        companyName: body.companyName ?? null,
        lastSyncAt: body.lastSyncAt ?? null,
        message: body.message ?? null,
      });
      setStatusState('ready');
    } catch {
      setStatusState('error');
    }
  }, []);
  useEffect(() => { void loadStatus(); }, [loadStatus]);

  const bringInBooks = useCallback(async () => {
    if (!isIsoDate(asOfDate)) { setError({ message: 'Choose the date your opening balances are as of.' }); return; }
    setPulling(true); setError(null); setPull(null); setNotConnectedReason(null);
    try {
      const res = await fetch(QBO_PULL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asOfDate }),
      });
      if (res.status === 403) {
        setError({ message: 'Bringing books in from QuickBooks needs someone who can manage integrations (usually the company admin).' });
        return;
      }
      const body = (await res.json()) as QboPullResponse & { error?: string };
      if (!res.ok) { setError({ message: body.error ?? 'We couldn’t read your QuickBooks books. Please try again.' }); return; }
      if (!body.connected) { setNotConnectedReason(body.reason); await loadStatus(); return; }
      if (body.rows.length === 0) {
        setError({ message: 'QuickBooks returned no account balances for that date. Try a later date, or export the trial balance instead.' });
        return;
      }
      setPull(body);
    } catch {
      setError({ message: 'We couldn’t reach QuickBooks. Check your connection and try again.' });
    } finally {
      setPulling(false);
    }
  }, [asOfDate, loadStatus]);

  const stage = useCallback(async () => {
    if (!pull || !companyId) return;
    setStaging(true); setError(null);
    try {
      const res = await fetch('/api/onboarding/conversion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId,
          asOfDate: pull.asOfDate,
          mapping: pull.mapping,
          rows: pull.rows,
          fileName: `QuickBooks Online${pull.company?.companyName ? ` — ${pull.company.companyName}` : ''} (live)`,
        }),
      });
      const body = (await res.json()) as { id?: string; error?: string; errors?: { row: number; message: string }[] };
      if (res.status === 403) { setError({ message: 'Preparing opening balances needs permission to create journal entries. Ask your admin, or invite your bookkeeper.' }); return; }
      if (!res.ok || !body.id) {
        setError({
          message: body.error ?? 'We couldn’t match your QuickBooks accounts.',
          details: body.errors?.slice(0, 8).map((e) => `Row ${e.row}: ${e.message}`),
        });
        return;
      }
      onStaged(body.id);
    } catch {
      setError({ message: 'We couldn’t match your accounts. Check your connection and try again.' });
    } finally {
      setStaging(false);
    }
  }, [pull, companyId, onStaged]);

  const disconnect = useCallback(async () => {
    if (!window.confirm('Disconnect QuickBooks? Anything already brought into MeritBooks stays.')) return;
    setDisconnecting(true);
    try {
      await fetch(QBO_DISCONNECT_URL, { method: 'POST' });
    } finally {
      setDisconnecting(false);
      setPull(null);
      await loadStatus();
    }
  }, [loadStatus]);

  const returnMsg = returnCode ? qboReturnMessage(returnCode, returnReason) : null;

  // ── Render ────────────────────────────────────────────────────────────────
  if (statusState === 'loading') {
    return (
      <div className="card p-5 flex items-center gap-2 text-sm text-slate-400" aria-busy="true">
        <Loader2 size={15} className="animate-spin text-brand-400" /> Checking your QuickBooks connection…
      </div>
    );
  }

  const configured = statusState === 'ready' && status?.configured === true;
  const connected = configured && status?.connected === true;

  // Not configured on this deployment (or status unreadable for this user) → guided export.
  if (!configured) {
    return (
      <div className="space-y-3">
        {returnMsg && <Banner tone={returnMsg.tone} onDismiss={onDismissReturn}>{returnMsg.text}</Banner>}
        {statusState === 'error' && (
          <Banner tone="warning">
            We couldn&apos;t check for a QuickBooks connection right now.{' '}
            <button type="button" onClick={() => void loadStatus()} className="underline hover:no-underline">Try again</button>, or use the export below.
          </Banner>
        )}
        {statusState === 'forbidden' && (
          <Banner tone="info">Connecting QuickBooks directly needs your company admin. The one-minute export below works for anyone.</Banner>
        )}
        <GuidedExportPanel system="quickbooks" cutoverDate={asOfDate} onUpload={onUpload} hasCompany={!!companyId} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {returnMsg && <Banner tone={returnMsg.tone} onDismiss={onDismissReturn}>{returnMsg.text}</Banner>}

      <div className="card p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <Plug size={15} className="text-brand-400" /> QuickBooks Online
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              {connected
                ? <>Connected{status?.companyName ? <> to <span className="text-slate-300">{status.companyName}</span></> : ''}. We only read — we never change anything in QuickBooks.</>
                : 'Sign in to QuickBooks and approve read-only access. You’ll come straight back here.'}
            </p>
          </div>
          {connected && (
            <button type="button" onClick={() => void disconnect()} disabled={disconnecting}
              className="shrink-0 text-2xs text-slate-500 hover:text-slate-300 underline-offset-2 hover:underline disabled:opacity-50">
              {disconnecting ? 'Disconnecting…' : 'Disconnect'}
            </button>
          )}
        </div>

        {status?.status === 'error' && (
          <Banner tone="warning">{status.message ?? 'The QuickBooks connection needs attention.'} Click “Reconnect QuickBooks” to link it again.</Banner>
        )}
        {notConnectedReason && <Banner tone="warning">{notConnectedReason}</Banner>}

        {!connected ? (
          <div className="flex flex-wrap items-center gap-3">
            <a
              href={qboConnectHref('/onboarding')}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-brand-500 text-slate-900 hover:bg-brand-400 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60"
            >
              <Plug size={14} /> {status?.status === 'error' ? 'Reconnect QuickBooks' : 'Connect QuickBooks'}
            </a>
            <button type="button" onClick={onUpload} className="text-xs text-slate-400 hover:text-slate-200 underline-offset-2 hover:underline">
              Rather export a file? Upload it instead
            </button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
              <div>
                <label htmlFor="qbo-asof" className="block text-xs text-slate-500 mb-1.5 font-medium">Opening balances as of</label>
                <div className="relative">
                  <CalendarDays size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                  <input id="qbo-asof" type="date" value={asOfDate}
                    onChange={(e) => { setAsOfDate(e.target.value); setPull(null); }}
                    className="w-full rounded-lg border border-slate-700 bg-surface-900 pl-9 pr-3 py-2 text-sm text-white" />
                </div>
              </div>
              <button
                type="button"
                onClick={() => void bringInBooks()}
                disabled={pulling || !companyId || !isIsoDate(asOfDate)}
                className={clsx('flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                  pulling || !companyId || !isIsoDate(asOfDate) ? 'bg-slate-700 text-slate-500 cursor-not-allowed' : 'bg-brand-500 text-slate-900 hover:bg-brand-400')}
              >
                {pulling ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                {pulling ? 'Reading your books…' : pull ? 'Read again' : 'Bring in my books'}
              </button>
            </div>
            {isIsoDate(asOfDate) && <p className="text-2xs text-slate-400 -mt-2">{cutoverExplanation(asOfDate)}</p>}
            {!companyId && <p className="text-2xs text-warning-fg">Create your company above first — that&apos;s where your books will live.</p>}
          </>
        )}

        {error && (
          <div role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-2.5 text-sm text-danger-fg">
            <p className="flex items-start gap-2"><AlertCircle size={15} className="mt-0.5 shrink-0" /> {error.message}</p>
            {error.details && error.details.length > 0 && (
              <ul className="mt-1.5 list-disc pl-6 space-y-0.5 text-xs">{error.details.map((d) => <li key={d}>{d}</li>)}</ul>
            )}
          </div>
        )}

        {pull && (
          <PullPreview pull={pull} companyName={companyName} staging={staging} onContinue={() => void stage()} canContinue={!!companyId} />
        )}
      </div>
    </div>
  );
}

function PullPreview({
  pull, companyName, staging, canContinue, onContinue,
}: {
  pull: QboPullConnected;
  companyName: string | null;
  staging: boolean;
  canContinue: boolean;
  onContinue: () => void;
}) {
  const { summary } = pull;
  const blockers = pull.preflight.filter((f) => f.severity === 'blocker');
  const others = pull.preflight.filter((f) => f.severity !== 'blocker');
  const counts = summary.entityCounts;

  return (
    <div className="space-y-3 border-t border-slate-800 pt-4" aria-live="polite">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="Accounts with balances" value={String(summary.trialBalanceLines)} />
        <Stat label="Total debits" value={formatMoney(summary.totalDebitCents)} mono />
        <Stat label="Total credits" value={formatMoney(summary.totalCreditCents)} mono />
        <Stat label="Balanced?" value={summary.balanced ? 'Yes' : 'No'} tone={summary.balanced ? 'good' : 'bad'} />
      </div>
      <p className="text-2xs text-slate-500">
        Also found in QuickBooks: {counts.customers} customers, {counts.vendors} vendors, {counts.open_ar} open invoices,{' '}
        {counts.open_ap} unpaid bills. You can bring those in from the setup board after your opening balances.
      </p>

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Before you continue — what we noticed in QuickBooks</p>
        {pull.preflightError && (
          <Banner tone="info">We couldn&apos;t run every check ({pull.preflightError}). The review screen still checks that everything ties out.</Banner>
        )}
        {pull.preflight.length === 0 && !pull.preflightError && (
          <Banner tone="success">Nothing to clean up — your QuickBooks file looks tidy.</Banner>
        )}
        {[...blockers, ...others].map((f) => (
          <div key={f.id}
            className={clsx('rounded-lg border px-4 py-2.5 text-sm',
              f.severity === 'blocker' ? 'border-danger/30 bg-danger/5' : f.severity === 'warning' ? 'border-warning/30 bg-warning/5' : 'border-slate-800 bg-surface-900')}>
            <p className="flex items-start gap-2 font-medium text-white">
              {f.severity === 'blocker'
                ? <AlertCircle size={15} className="mt-0.5 shrink-0 text-danger-fg" />
                : <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning-fg" />}
              <span className="flex-1">{f.title}</span>
              {f.amountCents > 0 && <span className="font-mono tabular-nums text-slate-300">{formatMoney(f.amountCents)}</span>}
            </p>
            <p className="text-xs text-slate-400 mt-1 pl-6">{f.plainEnglishMessage}</p>
          </div>
        ))}
        {blockers.length > 0 && (
          <p className="text-2xs text-slate-500">
            You can still continue. Nothing posts until the review shows every number ties out — and you approve it.
          </p>
        )}
      </div>

      <div className="flex items-center justify-end gap-3 pt-1">
        <button
          type="button"
          onClick={onContinue}
          disabled={staging || !canContinue}
          className={clsx('flex items-center gap-1.5 px-5 py-2 rounded-lg text-sm font-medium transition-colors',
            staging || !canContinue ? 'bg-slate-700 text-slate-500 cursor-not-allowed' : 'bg-brand-500 text-slate-900 hover:bg-brand-400')}
        >
          {staging ? <Loader2 size={14} className="animate-spin" /> : null}
          {staging ? 'Matching your accounts…' : `Continue — match accounts${companyName ? ` for ${companyName}` : ''}`}
          {!staging && <ArrowRight size={14} />}
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value, mono, tone }: { label: string; value: string; mono?: boolean; tone?: 'good' | 'bad' }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-surface-950 px-3 py-2">
      <p className="text-2xs text-slate-500">{label}</p>
      <p className={clsx('text-sm mt-0.5', mono && 'font-mono tabular-nums',
        tone === 'good' ? 'text-brand-300' : tone === 'bad' ? 'text-danger-fg' : 'text-white')}>{value}</p>
    </div>
  );
}
