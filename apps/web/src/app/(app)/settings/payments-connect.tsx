'use client';

import { useState, useEffect, useCallback } from 'react';
import { Loader2, CreditCard, Check, AlertTriangle, ExternalLink } from 'lucide-react';

interface Status {
  configured: boolean;
  connected?: boolean;
  status?: 'not_started' | 'pending' | 'active' | 'error';
  chargesEnabled?: boolean;
  payoutsEnabled?: boolean;
  message?: string;
}

export function PaymentsConnect() {
  const [s, setS] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/payments/connect');
      setS(await res.json());
    } catch {
      setS({ configured: false, message: 'Could not load status.' });
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const start = useCallback(async () => {
    setStarting(true);
    try {
      const res = await fetch('/api/payments/connect', { method: 'POST' });
      const body = await res.json();
      if (body.url) { window.location.href = body.url; return; }
      setS((prev) => ({ ...(prev ?? { configured: true }), message: body.error || 'Could not start onboarding.' }));
    } finally { setStarting(false); }
  }, []);

  if (loading) return <div className="flex items-center gap-2 text-slate-400 p-6"><Loader2 size={16} className="animate-spin" /> Loading…</div>;

  const card = 'rounded-xl border border-slate-700 bg-slate-900/40 p-6 max-w-xl';

  if (!s?.configured) {
    return (
      <div className={card}>
        <div className="flex items-center gap-2 text-amber-400 mb-2"><AlertTriangle size={18} /> Stripe not configured</div>
        <p className="text-sm text-slate-400">{s?.message || 'Set STRIPE_SECRET_KEY in the server environment to enable payments.'}</p>
      </div>
    );
  }

  const active = s.status === 'active';
  const pending = s.status === 'pending';

  return (
    <div className={card}>
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400"><CreditCard size={20} /></div>
        <div>
          <h2 className="text-base font-semibold text-white">Accept card &amp; ACH payments</h2>
          <p className="text-xs text-slate-400">Powered by Stripe. Funds settle to your own bank account.</p>
        </div>
      </div>

      {active && (
        <div className="flex items-center gap-2 text-emerald-400 text-sm mb-4"><Check size={16} /> Connected — payments are live{s.payoutsEnabled ? ' and payouts are enabled' : ''}.</div>
      )}
      {pending && (
        <div className="flex items-center gap-2 text-amber-400 text-sm mb-4"><Loader2 size={16} className="animate-spin" /> Onboarding submitted — Stripe is verifying. Finish any remaining steps to go live.</div>
      )}
      {s.status === 'not_started' && (
        <p className="text-sm text-slate-400 mb-4">Connect your business with Stripe to start collecting invoice payments online.</p>
      )}
      {s.status === 'error' && (
        <p className="text-sm text-red-400 mb-4">{s.message || 'There was a problem reading your Stripe status.'}</p>
      )}
      {s.message && s.status !== 'error' && <p className="text-sm text-red-400 mb-4">{s.message}</p>}

      <button onClick={start} disabled={starting}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium bg-emerald-500 text-white hover:bg-emerald-400 disabled:opacity-50">
        {starting ? <Loader2 size={14} className="animate-spin" /> : <ExternalLink size={14} />}
        {active ? 'Manage on Stripe' : pending ? 'Continue onboarding' : 'Connect with Stripe'}
      </button>
    </div>
  );
}
