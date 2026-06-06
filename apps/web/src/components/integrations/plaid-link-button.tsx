'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePlaidLink } from 'react-plaid-link';
import { Landmark, Loader2, CheckCircle2, AlertCircle, RefreshCw } from 'lucide-react';
import { clsx } from 'clsx';

interface PlaidItemStatus {
  id: string;
  plaid_item_id: string;
  institution_name: string | null;
  status: 'active' | 'login_required' | 'error';
  status_detail: string | null;
  last_synced_at: string | null;
}

interface SyncStatus {
  ok: boolean;
  items: PlaidItemStatus[];
  accountCount: number;
  connected: boolean;
}

interface ExchangeResult {
  ok?: boolean;
  error?: string;
  linked?: { institutionName: string | null; accountsLinked: number };
  sync?: { transactionsAdded: number } | null;
}

interface SyncRunResult {
  ok?: boolean;
  error?: string;
  summary?: {
    transactionsAdded: number;
    transactionsModified: number;
    balancesRefreshed: number;
    reauthNeeded: Array<{ institutionName: string | null }>;
    errors: Array<{ message: string }>;
  };
}

/**
 * One button that drives the whole Plaid bank-feed lifecycle:
 *   - if nothing is connected: "Connect a Bank" → opens Plaid Link
 *   - if connected: shows linked institutions + a "Sync now" action and re-auth state
 *
 * `variant="compact"` renders inline (for the cash/reconciliation empty states);
 * `variant="full"` renders the connected-items panel too.
 *
 * On success it calls `onChanged()` so the parent can refetch its data.
 */
export function PlaidLinkButton({
  variant = 'compact',
  onChanged,
}: {
  variant?: 'compact' | 'full';
  onChanged?: () => void;
}) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/integrations/plaid/sync', { method: 'GET' });
      const body = (await res.json()) as SyncStatus;
      if (res.ok) setStatus(body);
    } catch {
      /* status is best-effort */
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // Fetch a fresh link token, then Link opens via the effect below.
  const fetchLinkToken = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/integrations/plaid/link-token', { method: 'POST' });
      const body = (await res.json()) as { link_token?: string; error?: string };
      if (!res.ok || !body.link_token) {
        setMessage({ kind: 'err', text: body.error ?? 'Could not start bank connection.' });
        setBusy(false);
        return;
      }
      setLinkToken(body.link_token);
    } catch {
      setMessage({ kind: 'err', text: 'Network error starting bank connection.' });
      setBusy(false);
    }
  }, []);

  const onPlaidSuccess = useCallback(
    async (publicToken: string) => {
      setBusy(true);
      setMessage(null);
      try {
        const res = await fetch('/api/integrations/plaid/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ public_token: publicToken }),
        });
        const body = (await res.json()) as ExchangeResult;
        if (!res.ok || body.error) {
          setMessage({ kind: 'err', text: body.error ?? 'Failed to link the account.' });
        } else {
          const added = body.sync?.transactionsAdded ?? 0;
          const inst = body.linked?.institutionName ?? 'your bank';
          const n = body.linked?.accountsLinked ?? 0;
          setMessage({
            kind: 'ok',
            text: `Connected ${inst} — ${n} account${n === 1 ? '' : 's'}, ${added} transaction${added === 1 ? '' : 's'} imported.`,
          });
          await loadStatus();
          onChanged?.();
        }
      } catch {
        setMessage({ kind: 'err', text: 'Network error linking the account.' });
      } finally {
        setLinkToken(null);
        setBusy(false);
      }
    },
    [loadStatus, onChanged],
  );

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: (public_token) => {
      void onPlaidSuccess(public_token);
    },
    onExit: () => {
      setLinkToken(null);
      setBusy(false);
    },
  });

  // When we have a token and Link is ready, open it.
  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  const runSync = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/integrations/plaid/sync', { method: 'POST' });
      const body = (await res.json()) as SyncRunResult;
      if (!res.ok || body.error) {
        setMessage({ kind: 'err', text: body.error ?? 'Sync failed.' });
      } else {
        const s = body.summary!;
        if (s.reauthNeeded.length > 0) {
          setMessage({ kind: 'err', text: `${s.reauthNeeded.length} bank login needs to be reconnected.` });
        } else {
          setMessage({ kind: 'ok', text: `Synced — ${s.transactionsAdded} new, ${s.balancesRefreshed} balance${s.balancesRefreshed === 1 ? '' : 's'} updated.` });
        }
        await loadStatus();
        onChanged?.();
      }
    } catch {
      setMessage({ kind: 'err', text: 'Network error during sync.' });
    } finally {
      setBusy(false);
    }
  }, [loadStatus, onChanged]);

  const connected = status?.connected ?? false;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={fetchLinkToken}
          disabled={busy}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-500 text-slate-900 text-sm font-medium hover:bg-emerald-400 disabled:opacity-50 transition-colors"
          aria-label="Connect a bank account with Plaid"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Landmark size={14} />}
          {connected ? 'Connect another bank' : 'Connect a bank'}
        </button>

        {connected && (
          <button
            onClick={runSync}
            disabled={busy}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-700 text-slate-300 text-sm hover:bg-slate-800 disabled:opacity-50 transition-colors"
            aria-label="Sync bank transactions now"
          >
            <RefreshCw size={13} className={clsx(busy && 'animate-spin')} /> Sync now
          </button>
        )}
      </div>

      {message && (
        <div
          className={clsx(
            'flex items-start gap-2 text-xs rounded-lg px-3 py-2',
            message.kind === 'ok' ? 'text-emerald-400 bg-emerald-500/10' : 'text-red-400 bg-red-500/10',
          )}
          role="status"
        >
          {message.kind === 'ok' ? <CheckCircle2 size={14} className="shrink-0 mt-0.5" /> : <AlertCircle size={14} className="shrink-0 mt-0.5" />}
          <span>{message.text}</span>
        </div>
      )}

      {variant === 'full' && connected && status && (
        <div className="space-y-1.5">
          {status.items.map((it) => (
            <div key={it.id} className="flex items-center justify-between text-xs px-3 py-2 rounded-lg bg-slate-800/30 border border-slate-800">
              <div className="flex items-center gap-2">
                <Landmark size={13} className="text-slate-400" />
                <span className="text-slate-300">{it.institution_name ?? 'Bank'}</span>
              </div>
              <div className="flex items-center gap-2">
                {it.status === 'active' && (
                  <span className="flex items-center gap-1 text-emerald-400">
                    <CheckCircle2 size={11} /> Connected
                  </span>
                )}
                {it.status === 'login_required' && (
                  <button onClick={fetchLinkToken} className="flex items-center gap-1 text-amber-400 hover:underline">
                    <AlertCircle size={11} /> Reconnect needed
                  </button>
                )}
                {it.status === 'error' && (
                  <span className="flex items-center gap-1 text-red-400" title={it.status_detail ?? undefined}>
                    <AlertCircle size={11} /> Error
                  </span>
                )}
                {it.last_synced_at && (
                  <span className="text-slate-600">· {new Date(it.last_synced_at).toLocaleString()}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
