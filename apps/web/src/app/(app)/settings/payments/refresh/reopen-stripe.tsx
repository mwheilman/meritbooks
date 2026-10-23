'use client';

import { useState } from 'react';
import { Button, ButtonLink } from '@meritbooks/merit-ui';

/**
 * Stripe sends people here when an onboarding link expired. Minting a fresh link is a
 * state-changing POST, so it happens only when the member clicks — never on page load
 * (a page someone was tricked into opening must not act on their behalf).
 */
export function ReopenStripe({ company }: { company: string | null }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reopen() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/payments/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: company, intent: 'onboard' }),
      });
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (body.url) {
        window.location.href = body.url;
        return;
      }
      setError(body.error || 'Stripe setup could not be reopened.');
    } catch {
      setError('Stripe setup could not be reopened.');
    }
    setBusy(false);
  }

  return (
    <div className="surface wg-state mb-state-block" style={{ maxWidth: 560, margin: '48px auto' }} role={error ? 'alert' : 'status'}>
      {error ? (
        <>
          <span className="tag tag--neg">Not reopened</span>
          <span className="t-head">Stripe setup didn&rsquo;t reopen</span>
          <p>{error}</p>
          <div className="row">
            <Button variant="primary" onClick={reopen} disabled={busy}>{busy ? 'Reopening…' : 'Try again'}</Button>
            <ButtonLink href="/settings/payments">Back to payments</ButtonLink>
          </div>
        </>
      ) : (
        <>
          <span className="t-head">Your Stripe setup link expired</span>
          <p>Stripe links only last a few minutes. Get a fresh one to pick up where you left off.</p>
          <div className="row">
            <Button variant="primary" onClick={reopen} disabled={busy}>{busy ? 'Reopening…' : 'Continue Stripe setup'}</Button>
            <ButtonLink href="/settings/payments">Back to payments</ButtonLink>
          </div>
        </>
      )}
    </div>
  );
}
