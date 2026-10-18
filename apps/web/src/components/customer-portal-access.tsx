'use client';

import { useState } from 'react';
import { Link2, Copy, Check, RefreshCw, Trash2, Loader2, ExternalLink, ShieldOff } from 'lucide-react';
import { useQuery, addToast } from '@/hooks';

/**
 * Admin "Portal access" panel on the customer detail drawer. Mints / revokes /
 * regenerates the customer's self-service portal magic link, and shows the
 * shareable /portal/customer/<token> URL once minted. Gated server-side on the
 * customers permission (the API 403s without customers:edit); this UI is a thin
 * client over that route and never trusts itself for authorization.
 */

interface TokenView {
  id: string;
  label: string | null;
  status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  url: string | null;
  token: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}
interface PortalTokensResponse {
  active: TokenView | null;
  tokens: TokenView[];
}

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : null;

export function CustomerPortalAccess({ customerId }: { customerId: string }) {
  const { data, isLoading, error, refetch } = useQuery<PortalTokensResponse>(
    `/api/customers/${customerId}/portal`,
    undefined,
    { enabled: !!customerId, scope: false },
  );

  const [busy, setBusy] = useState<null | 'mint' | 'revoke'>(null);
  const [copied, setCopied] = useState(false);
  const [expiry, setExpiry] = useState('');
  const today = new Date().toISOString().slice(0, 10);

  const active = data?.active ?? null;

  const mint = async () => {
    setBusy('mint');
    try {
      const res = await fetch(`/api/customers/${customerId}/portal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresAt: expiry || null }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.active) {
        addToast('success', active ? 'Portal link regenerated. The old link is now dead.' : 'Portal link created.');
        refetch();
      } else if (res.status === 403) {
        addToast('error', 'You do not have permission to manage portal access.');
      } else {
        addToast('error', body.error ?? 'Could not create the portal link.');
      }
    } catch {
      addToast('error', 'Could not reach the server. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const revoke = async () => {
    setBusy('revoke');
    try {
      const res = await fetch(`/api/customers/${customerId}/portal`, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok) {
        addToast('success', 'Portal access revoked. The link no longer works.');
        refetch();
      } else if (res.status === 403) {
        addToast('error', 'You do not have permission to manage portal access.');
      } else {
        addToast('error', body.error ?? 'Could not revoke access.');
      }
    } catch {
      addToast('error', 'Could not reach the server. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    if (!active?.url) return;
    try {
      await navigator.clipboard.writeText(active.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      addToast('error', 'Could not copy. Select the link and copy manually.');
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <Loader2 size={13} className="animate-spin" /> Loading portal access…
      </div>
    );
  }
  if (error) {
    return <p className="text-xs text-slate-500">Portal access unavailable.</p>;
  }

  return (
    <div className="space-y-3">
      <p className="text-2xs text-slate-500 leading-relaxed">
        A self-service link lets this customer view all their invoices, see their balance,
        download a statement, and pay open invoices — no login. The link is a secret: anyone
        with it can see this customer&apos;s account, so share it directly and revoke if it leaks.
      </p>

      {active ? (
        <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/[0.06] p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Link2 size={13} className="text-emerald-300" />
            <span className="text-2xs uppercase tracking-wider text-emerald-300 font-semibold">Active portal link</span>
            {active.expiresAt && (
              <span className="ml-auto text-2xs text-slate-500">Expires {fmt(active.expiresAt)}</span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <input
              readOnly
              value={active.url ?? ''}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="Portal link URL"
              className="flex-1 min-w-0 px-2 py-1.5 rounded-md bg-slate-950 border border-slate-700 text-2xs font-mono text-slate-300 focus:outline-none focus:border-emerald-500/50"
            />
            <button
              onClick={copy}
              title="Copy link"
              className="shrink-0 inline-flex items-center gap-1 px-2 py-1.5 rounded-md text-2xs font-medium bg-slate-800 text-slate-200 hover:bg-slate-700"
            >
              {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            {active.url && (
              <a
                href={active.url}
                target="_blank"
                rel="noreferrer"
                title="Open the portal as the customer sees it"
                className="shrink-0 inline-flex items-center px-2 py-1.5 rounded-md text-2xs font-medium bg-slate-800 text-slate-200 hover:bg-slate-700"
              >
                <ExternalLink size={12} />
              </a>
            )}
          </div>
          <div className="flex items-center gap-2 text-2xs text-slate-500">
            {active.lastUsedAt ? <span>Last opened {fmt(active.lastUsedAt)}</span> : <span>Not opened yet</span>}
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={mint}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-slate-800 text-slate-200 hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy === 'mint' ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Regenerate
            </button>
            <button
              onClick={revoke}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-red-600/90 text-white hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy === 'revoke' ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} Revoke
            </button>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 space-y-2.5">
          <div className="flex items-center gap-2 text-slate-400">
            <ShieldOff size={13} />
            <span className="text-xs">No active portal link.</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-2xs text-slate-500 uppercase tracking-wider">Expires (optional)</span>
            <input
              type="date"
              min={today}
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              aria-label="Link expiration date (optional)"
              className="px-2 py-1 rounded-md bg-slate-900 border border-slate-700 text-xs text-slate-200 focus:outline-none focus:border-emerald-500/50"
            />
          </div>
          <button
            onClick={mint}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy === 'mint' ? <Loader2 size={12} className="animate-spin" /> : <Link2 size={12} />} Create portal link
          </button>
        </div>
      )}
    </div>
  );
}
