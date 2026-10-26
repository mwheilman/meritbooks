'use client';

import { useState, type CSSProperties } from 'react';
import { Button, Icon, Input, InlineNotice } from '@meritbooks/merit-ui';
import { useQuery, addToast } from '@/hooks';

/**
 * Admin "Portal access" panel on the customer detail drawer. Mints / revokes /
 * regenerates the customer's self-service portal magic link, and shows the
 * shareable /portal/customer/<token> URL once minted. Gated server-side on the
 * customers permission (the API 403s without customers:edit); this UI is a thin
 * client over that route and never trusts itself for authorization.
 *
 * Presentation: kit classes + inline layout only (renders inside bridged and ported pages).
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

const box: CSSProperties = { padding: '12px 16px', border: '1px solid var(--line)', background: 'var(--white)', display: 'grid', gap: 12 };

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
    <div style={{ display: 'grid', gap: 12 }}>
      <p className="t-cap">
        A self-service link lets this customer view all their invoices, see their balance,
        download a statement and pay open invoices — no login. The link is a secret: anyone
        with it can see this customer&apos;s account, so share it directly and revoke it if it leaks.
      </p>

      {active ? (
        <div style={{ ...box, boxShadow: 'inset 3px 0 var(--electric)' }}>
          <div className="row row--between">
            <span className="mb-sev"><Icon name="plug" /> Active portal link</span>
            {active.expiresAt && <span className="t-cap">Expires {fmt(active.expiresAt)}</span>}
          </div>
          <div className="row">
            <Input
              readOnly
              value={active.url ?? ''}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="Portal link URL"
              style={{ flex: 1, minWidth: 0 }}
            />
            <Button onClick={copy} title="Copy link" icon={copied ? 'check' : undefined}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
            {active.url && (
              <a
                href={active.url}
                target="_blank"
                rel="noreferrer"
                title="Open the portal as the customer sees it"
                aria-label="Open the portal as the customer sees it"
                className="btn btn--quiet btn--icon"
              >
                <Icon name="right" />
              </a>
            )}
          </div>
          <span className="t-cap">{active.lastUsedAt ? `Last opened ${fmt(active.lastUsedAt)}` : 'Not opened yet'}</span>
          <div className="btn-row">
            <Button onClick={mint} disabled={busy !== null} icon="undo" aria-busy={busy === 'mint' || undefined}>
              {busy === 'mint' ? 'Regenerating…' : 'Regenerate'}
            </Button>
            <Button variant="danger" onClick={revoke} disabled={busy !== null} aria-busy={busy === 'revoke' || undefined}>
              {busy === 'revoke' ? 'Revoking…' : 'Revoke'}
            </Button>
          </div>
        </div>
      ) : (
        <div style={box}>
          <span className="row ink-2"><Icon name="lock" /> No active portal link.</span>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <label className="field-label" htmlFor={`cp-expiry-${customerId}`}>Expires (optional)</label>
            <Input
              id={`cp-expiry-${customerId}`}
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
              {busy === 'mint' ? 'Creating…' : 'Create portal link'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
