'use client';

import { useMemo, useState, type CSSProperties } from 'react';
import { Button, Icon, Input, InlineNotice, Tag } from '@meritbooks/merit-ui';
import { useQuery, addToast } from '@/hooks';

/**
 * Admin "Portal access" panel on the vendor detail drawer. Mints / revokes a
 * vendor's self-service upload link, shows the shareable /portal/vendor/<token>
 * URL, and lists what the vendor has submitted (each PENDING human review — a
 * portal upload never changes compliance state). Gated server-side on the
 * `compliance` permission (GET view, POST/PATCH manage); this UI is a thin client
 * over that route and never trusts itself for authorization.
 *
 * The link is a bearer credential: the list shows only its last four characters. The
 * full link is shown ONCE, right after it is created (copy it then). A W-9 image shows
 * the vendor's full TIN, so it opens only through a logged reveal with a reason.
 *
 * Presentation: kit classes + inline layout only (renders inside bridged and ported pages).
 */

type DocKind = 'W9' | 'COI' | 'BANKING';
const DOC_KINDS: { key: DocKind; label: string }[] = [
  { key: 'W9', label: 'W-9' },
  { key: 'COI', label: 'COI' },
  { key: 'BANKING', label: 'Banking' },
];

interface TokenView {
  id: string;
  tokenLast4: string;
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
  reviewStatus: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  viewUrl: string | null;
  requiresReveal: boolean;
}
interface PortalResponse {
  tokens: TokenView[];
  submissions: Submission[];
}

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : null;

const box: CSSProperties = { padding: '12px 16px', border: '1px solid var(--line)', background: 'var(--white)' };
const stack: CSSProperties = { display: 'grid', gap: 12 };

export function VendorPortalAccess({ vendorId }: { vendorId: string }) {
  const { data, isLoading, error, refetch } = useQuery<PortalResponse>(
    `/api/vendor-portal/tokens?vendor_id=${vendorId}`,
    undefined,
    { enabled: !!vendorId, scope: false },
  );

  const [busy, setBusy] = useState<null | 'mint' | string>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // The full token exists in this browser only between create and leaving the drawer.
  const [fresh, setFresh] = useState<{ id: string; token: string } | null>(null);
  const [revealFor, setRevealFor] = useState<string | null>(null);
  const [revealReason, setRevealReason] = useState('');
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
        setFresh({ id: String(body.id), token: String(body.token) });
        addToast('success', 'Upload link created. Copy it now — for security it is shown only once.');
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

  const openW9 = async (docId: string) => {
    if (revealReason.trim().length < 3) {
      addToast('error', 'Say why you are opening this W-9 (it is logged).');
      return;
    }
    setBusy(docId);
    try {
      const res = await fetch('/api/vendor-portal/tokens/document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document_id: docId, reason: revealReason.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && typeof body.url === 'string') {
        window.open(body.url, '_blank', 'noopener,noreferrer');
        setRevealFor(null);
        setRevealReason('');
      } else {
        addToast('error', body.error ?? 'Could not open the W-9.');
      }
    } catch {
      addToast('error', 'Could not reach the server. Try again.');
    } finally {
      setBusy(null);
    }
  };

  if (isLoading) {
    return (
      <div className="wg-loading" aria-busy="true" style={{ display: 'grid', gap: 10, padding: '8px 0' }}>
        <span className="bar-l" style={{ width: '70%' }} aria-hidden="true" />
        <span className="bar-l" style={{ width: '45%' }} aria-hidden="true" />
        <span className="t-cap" role="status">Loading portal access…</span>
      </div>
    );
  }
  if (error) {
    return (
      <InlineNotice tone="neg" title="Portal access didn’t load.">
        <span>{error}</span>{' '}
        <Button variant="quiet" onClick={() => refetch()}>Try again</Button>
      </InlineNotice>
    );
  }

  return (
    <div style={stack}>
      <p className="t-cap">
        Send this vendor a secure, no-login link to upload their W-9, COI and/or banking details.
        Submissions land here as <b className="ink-2">pending review</b> — accepting a document stays a
        manual step, so a link can never mark a vendor compliant on its own. The link is a secret:
        share it directly and revoke it if it leaks.
      </p>

      {/* Active links */}
      {activeTokens.length > 0 ? (
        <div style={{ display: 'grid', gap: 8 }}>
          {activeTokens.map((t) => (
            <div key={t.id} style={{ ...box, boxShadow: 'inset 3px 0 var(--electric)', display: 'grid', gap: 8 }}>
              <div className="row row--between">
                <span className="mb-sev"><Icon name="plug" /> Active upload link</span>
                <span className="row" style={{ gap: 4 }}>
                  {t.requestedDocs.map((d) => <Tag key={d}>{d}</Tag>)}
                </span>
              </div>
              {fresh && fresh.id === t.id ? (
                <div style={{ display: 'grid', gap: 6 }}>
                  <div className="row">
                    <Input
                      readOnly
                      value={urlFor(fresh.token)}
                      onFocus={(e) => e.currentTarget.select()}
                      aria-label="Portal link URL"
                      style={{ flex: 1, minWidth: 0 }}
                    />
                    <Button onClick={() => copy(fresh.token)} title="Copy link" icon={copiedId === fresh.token ? 'check' : undefined}>
                      {copiedId === fresh.token ? 'Copied' : 'Copy'}
                    </Button>
                    <a
                      href={urlFor(fresh.token)}
                      target="_blank"
                      rel="noreferrer"
                      title="Open the portal as the vendor sees it"
                      aria-label="Open the portal as the vendor sees it"
                      className="btn btn--quiet btn--icon"
                    >
                      <Icon name="right" />
                    </a>
                  </div>
                  <InlineNotice tone="warn" title="Copy this link now.">
                    For security it won’t be shown again — create a new link if you lose it.
                  </InlineNotice>
                </div>
              ) : (
                <p className="ink-2">
                  Link ending <span className="tnum">…{t.tokenLast4}</span>. The full link was shown once when it was created; create a new one if you need to resend it.
                </p>
              )}
              <div className="row t-cap" style={{ flexWrap: 'wrap' }}>
                {t.expiresAt ? <span className="row" style={{ gap: 4 }}><Icon name="clock" /> Expires {fmt(t.expiresAt)}</span> : <span>No expiry</span>}
                <span aria-hidden="true">·</span>
                {t.lastUsedAt ? <span>Last used {fmt(t.lastUsedAt)}</span> : <span>Not used yet</span>}
                <span style={{ flex: 1 }} />
                <Button variant="danger" onClick={() => revoke(t.id)} disabled={busy !== null} aria-busy={busy === t.id || undefined}>
                  {busy === t.id ? 'Revoking…' : 'Revoke'}
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="row ink-2" style={{ ...box, borderStyle: 'dashed', borderColor: 'var(--line-2)' }}>
          <Icon name="lock" />
          <span>No active upload link.</span>
        </div>
      )}

      {/* Create a new link */}
      <div style={{ ...box, display: 'grid', gap: 12 }}>
        <div className="row" style={{ flexWrap: 'wrap' }} role="group" aria-label="Documents to request">
          <span className="eyebrow" style={{ marginRight: 4 }}>Request</span>
          {DOC_KINDS.map((d) => (
            <Button
              key={d.key}
              variant={kinds[d.key] ? 'default' : 'quiet'}
              icon={kinds[d.key] ? 'check' : undefined}
              onClick={() => toggleKind(d.key)}
              aria-pressed={kinds[d.key]}
            >
              {d.label}
            </Button>
          ))}
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <label className="field-label" htmlFor={`vp-expiry-${vendorId}`}>Expires (default 45 days)</label>
          <Input
            id={`vp-expiry-${vendorId}`}
            type="date"
            min={today}
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
            aria-label="Link expiration date (optional)"
            style={{ width: 168 }}
          />
        </div>
        <div>
          <Button onClick={mint} disabled={busy !== null} icon="plug" aria-busy={busy === 'mint' || undefined}>
            {busy === 'mint' ? 'Creating…' : 'Create upload link'}
          </Button>
        </div>
      </div>

      {/* Submissions — pending review */}
      <div>
        <h4 className="eyebrow" style={{ marginBottom: 8 }}>
          Submitted documents{submissions.length > 0 ? ` (${submissions.length})` : ''}
        </h4>
        {submissions.length === 0 ? (
          <p className="t-cap">Nothing submitted yet. Uploads through the link appear here for review.</p>
        ) : (
          <ul style={{ listStyle: 'none', border: '1px solid var(--line)' }}>
            {submissions.map((sub, i) => (
              <li key={sub.id} style={{ borderTop: i === 0 ? 0 : '1px solid var(--line)', padding: '8px 12px' }}>
                <div className="row row--between" style={{ minWidth: 0 }}>
                  <span className="row" style={{ minWidth: 0 }}>
                    <Icon name="file-text" />
                    <span className="mb-trunc">{sub.fileName}</span>
                  </span>
                  <span className="row" style={{ flex: 'none' }}>
                    <Tag tone="warn">Pending review</Tag>
                    <span className="t-cap">{fmt(sub.createdAt)}</span>
                    {sub.viewUrl && (
                      <a
                        href={sub.viewUrl}
                        rel="noreferrer"
                        title="Download submitted file"
                        aria-label={`Download ${sub.fileName}`}
                        className="btn btn--quiet btn--icon"
                      >
                        <Icon name="down" />
                      </a>
                    )}
                    {sub.requiresReveal && revealFor !== sub.id && (
                      <Button
                        variant="quiet"
                        icon="eye"
                        onClick={() => { setRevealFor(sub.id); setRevealReason(''); }}
                        title="This W-9 shows the full taxpayer ID — opening it is logged"
                      >
                        Open W-9
                      </Button>
                    )}
                  </span>
                </div>
                {revealFor === sub.id && (
                  <div className="row" style={{ marginTop: 8 }}>
                    <Input
                      value={revealReason}
                      onChange={(e) => setRevealReason(e.target.value)}
                      placeholder="Why are you opening it? (logged)"
                      aria-label="Reason for opening the W-9"
                      style={{ flex: 1, minWidth: 0 }}
                      autoFocus
                    />
                    <Button
                      onClick={() => void openW9(sub.id)}
                      disabled={busy !== null || revealReason.trim().length < 3}
                    >
                      {busy === sub.id ? 'Opening…' : 'Open'}
                    </Button>
                    <Button variant="quiet" onClick={() => setRevealFor(null)}>
                      Cancel
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
