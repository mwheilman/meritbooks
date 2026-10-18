'use client';

import { useMemo, useState } from 'react';
import {
  Link2, Copy, Check, Trash2, Loader2, ExternalLink, ShieldOff, FileText, Clock,
} from 'lucide-react';
import { useQuery, addToast } from '@/hooks';

/**
 * Admin "Portal access" panel on the vendor detail drawer. Mints / revokes a
 * vendor's self-service upload link, shows the shareable /portal/vendor/<token>
 * URL, and lists what the vendor has submitted (each PENDING human review — a
 * portal upload never changes compliance state). Gated server-side on the
 * `compliance` permission (POST/PATCH 403 without it); this UI is a thin client
 * over that route and never trusts itself for authorization.
 */

type DocKind = 'W9' | 'COI' | 'BANKING';
const DOC_KINDS: { key: DocKind; label: string }[] = [
  { key: 'W9', label: 'W-9' },
  { key: 'COI', label: 'COI' },
  { key: 'BANKING', label: 'Banking' },
];

interface TokenView {
  id: string;
  token: string;
  label: string | null;
  status: 'active' | 'revoked' | 'expired';
  requestedDocs: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}
interface Submission {
  id: string;
  fileName: string;
  docType: string;
  createdAt: string;
  reviewStatus: 'PENDING';
  viewUrl: string | null;
}
interface PortalResponse {
  tokens: TokenView[];
  submissions: Submission[];
}

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : null;

export function VendorPortalAccess({ vendorId }: { vendorId: string }) {
  const { data, isLoading, error, refetch } = useQuery<PortalResponse>(
    `/api/vendor-portal/tokens?vendor_id=${vendorId}`,
    undefined,
    { enabled: !!vendorId, scope: false },
  );

  const [busy, setBusy] = useState<null | 'mint' | string>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expiry, setExpiry] = useState('');
  const [kinds, setKinds] = useState<Record<DocKind, boolean>>({ W9: true, COI: true, BANKING: false });
  const today = new Date().toISOString().slice(0, 10);

  const activeTokens = useMemo(() => (data?.tokens ?? []).filter((t) => t.status === 'active'), [data]);
  const submissions = data?.submissions ?? [];

  const urlFor = (token: string) =>
    typeof window !== 'undefined' ? `${window.location.origin}/portal/vendor/${token}` : `/portal/vendor/${token}`;

  const toggleKind = (k: DocKind) => setKinds((prev) => ({ ...prev, [k]: !prev[k] }));

  const mint = async () => {
    const requested = DOC_KINDS.filter((d) => kinds[d.key]).map((d) => d.key);
    if (requested.length === 0) {
      addToast('error', 'Pick at least one document to request.');
      return;
    }
    setBusy('mint');
    try {
      const res = await fetch('/api/vendor-portal/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vendor_id: vendorId,
          requested_docs: requested,
          expires_in_days: expiry ? Math.max(1, Math.ceil((new Date(expiry).getTime() - Date.now()) / 86400000)) : undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.token) {
        addToast('success', 'Upload link created. Share it directly with the vendor.');
        refetch();
      } else if (res.status === 403) {
        addToast('error', 'You do not have permission to manage portal access.');
      } else {
        addToast('error', body.error ?? 'Could not create the link.');
      }
    } catch {
      addToast('error', 'Could not reach the server. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (tokenId: string) => {
    setBusy(tokenId);
    try {
      const res = await fetch('/api/vendor-portal/tokens', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token_id: tokenId }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok) {
        addToast('success', 'Link revoked. It no longer works.');
        refetch();
      } else if (res.status === 403) {
        addToast('error', 'You do not have permission to manage portal access.');
      } else {
        addToast('error', body.error ?? 'Could not revoke the link.');
      }
    } catch {
      addToast('error', 'Could not reach the server. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const copy = async (token: string) => {
    try {
      await navigator.clipboard.writeText(urlFor(token));
      setCopiedId(token);
      setTimeout(() => setCopiedId(null), 1600);
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
        Send this vendor a secure, no-login link to upload their W-9, COI, and/or banking details.
        Submissions land here as <span className="text-slate-300">pending review</span> — accepting a
        document stays a manual step, so a link can never mark a vendor compliant on its own. The link
        is a secret: share it directly and revoke if it leaks.
      </p>

      {/* Active links */}
      {activeTokens.length > 0 ? (
        <div className="space-y-2">
          {activeTokens.map((t) => (
            <div key={t.id} className="rounded-lg border border-emerald-500/25 bg-emerald-500/[0.06] p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Link2 size={13} className="text-emerald-300" />
                <span className="text-2xs uppercase tracking-wider text-emerald-300 font-semibold">Active upload link</span>
                <span className="ml-auto flex items-center gap-1.5">
                  {t.requestedDocs.map((d) => (
                    <span key={d} className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium text-slate-300">{d}</span>
                  ))}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  readOnly
                  value={urlFor(t.token)}
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label="Portal link URL"
                  className="flex-1 min-w-0 px-2 py-1.5 rounded-md bg-slate-950 border border-slate-700 text-2xs font-mono text-slate-300 focus:outline-none focus:border-emerald-500/50"
                />
                <button
                  onClick={() => copy(t.token)}
                  title="Copy link"
                  className="shrink-0 inline-flex items-center gap-1 px-2 py-1.5 rounded-md text-2xs font-medium bg-slate-800 text-slate-200 hover:bg-slate-700"
                >
                  {copiedId === t.token ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                  {copiedId === t.token ? 'Copied' : 'Copy'}
                </button>
                <a
                  href={urlFor(t.token)}
                  target="_blank"
                  rel="noreferrer"
                  title="Open the portal as the vendor sees it"
                  className="shrink-0 inline-flex items-center px-2 py-1.5 rounded-md text-2xs font-medium bg-slate-800 text-slate-200 hover:bg-slate-700"
                >
                  <ExternalLink size={12} />
                </a>
              </div>
              <div className="flex items-center gap-3 text-2xs text-slate-500">
                {t.expiresAt ? <span className="inline-flex items-center gap-1"><Clock size={10} /> Expires {fmt(t.expiresAt)}</span> : <span>No expiry</span>}
                <span>·</span>
                {t.lastUsedAt ? <span>Last used {fmt(t.lastUsedAt)}</span> : <span>Not used yet</span>}
                <button
                  onClick={() => revoke(t.id)}
                  disabled={busy !== null}
                  className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded-md text-2xs font-medium bg-red-600/90 text-white hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {busy === t.id ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />} Revoke
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-slate-400">
          <ShieldOff size={13} />
          <span className="text-xs">No active upload link.</span>
        </div>
      )}

      {/* Create a new link */}
      <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 space-y-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-2xs text-slate-500 uppercase tracking-wider mr-1">Request</span>
          {DOC_KINDS.map((d) => (
            <button
              key={d.key}
              type="button"
              onClick={() => toggleKind(d.key)}
              aria-pressed={kinds[d.key]}
              className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-2xs font-medium transition-colors ${
                kinds[d.key]
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                  : 'border-slate-700 bg-slate-800/40 text-slate-400 hover:text-slate-200'
              }`}
            >
              {kinds[d.key] && <Check size={11} />} {d.label}
            </button>
          ))}
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
          {busy === 'mint' ? <Loader2 size={12} className="animate-spin" /> : <Link2 size={12} />} Create upload link
        </button>
      </div>

      {/* Submissions — pending review */}
      <div>
        <h4 className="text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-1.5">
          Submitted documents{submissions.length > 0 ? ` (${submissions.length})` : ''}
        </h4>
        {submissions.length === 0 ? (
          <p className="text-2xs text-slate-600">Nothing submitted yet.</p>
        ) : (
          <div className="rounded-lg bg-slate-800/30 divide-y divide-slate-800/50">
            {submissions.map((sub) => (
              <div key={sub.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="inline-flex items-center gap-2 min-w-0 text-sm text-slate-200">
                  <FileText size={13} className="shrink-0 text-slate-500" />
                  <span className="truncate">{sub.fileName}</span>
                </span>
                <span className="flex items-center gap-2 shrink-0">
                  <span className="rounded border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                    Pending review
                  </span>
                  <span className="text-2xs text-slate-500">{fmt(sub.createdAt)}</span>
                  {sub.viewUrl && (
                    <a
                      href={sub.viewUrl}
                      target="_blank"
                      rel="noreferrer"
                      title="View submitted file"
                      className="inline-flex items-center rounded-md bg-slate-800 px-1.5 py-1 text-slate-300 hover:bg-slate-700"
                    >
                      <ExternalLink size={12} />
                    </a>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
