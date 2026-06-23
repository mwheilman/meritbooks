'use client';

import { useEffect, useState } from 'react';

export default function PaymentsRefreshPage() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/payments/connect', { method: 'POST' });
        const body = await res.json();
        if (!alive) return;
        if (body.url) { window.location.href = body.url; return; }
        setError(body.error || 'Could not restart onboarding.');
      } catch {
        if (alive) setError('Could not restart onboarding.');
      }
    })();
    return () => { alive = false; };
  }, []);

  return (
    <div style={{ maxWidth: 520, margin: '64px auto', textAlign: 'center', fontFamily: 'system-ui, sans-serif', color: '#94a3b8' }}>
      {error ? <p style={{ color: '#f87171' }}>{error}</p> : <p>Reopening Stripe onboarding…</p>}
    </div>
  );
}
