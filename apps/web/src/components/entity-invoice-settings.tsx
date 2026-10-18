'use client';

import { useState, useEffect, useCallback } from 'react';
import { Loader2, Check } from 'lucide-react';
import { clsx } from 'clsx';
import { addToast } from '@/hooks';

/**
 * Invoice payment & retainage settings for one scope (CUSTOMER / JOB / LOCATION).
 * Plain and explicit: pick which methods are allowed (Check, Bank transfer (ACH),
 * Credit card). If card is on, choose whether the ~3% processing fee is absorbed
 * by the business or passed to the customer at payment. Self-saving.
 *
 * The selection is stored on this record and overrides less-specific levels
 * (invoice overrides job overrides customer overrides entity). When nothing has
 * been saved yet, the company defaults (Check + ACH) are shown pre-checked.
 */
const SURCHARGE_PCT = 3;

export function EntityInvoiceSettings({ scope, id }: { scope: 'CUSTOMER' | 'JOB' | 'LOCATION'; id: string }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [check, setCheck] = useState(true);
  const [ach, setAch] = useState(true);
  const [card, setCard] = useState(false);
  const [feePassed, setFeePassed] = useState(true); // true = pass to customer, false = absorb
  const [usingDefaults, setUsingDefaults] = useState(true);
  const [retainage, setRetainage] = useState(false);
  const [retPct, setRetPct] = useState('');

  useEffect(() => {
    let alive = true; setLoading(true);
    fetch(`/api/entity-invoice-settings?scope=${scope}&id=${id}`).then((r) => r.json()).then((b) => {
      if (!alive) return;
      if (Array.isArray(b.paymentMethods)) {
        setUsingDefaults(false);
        setCheck(b.paymentMethods.includes('CHECK'));
        setAch(b.paymentMethods.includes('ACH'));
        setCard(b.paymentMethods.includes('CARD'));
      } else {
        setUsingDefaults(true); setCheck(true); setAch(true); setCard(false);
      }
      if (typeof b.cardSurcharge === 'boolean') setFeePassed(b.cardSurcharge);
      setRetainage(b.retainageEnabled === true);
      setRetPct(b.retainagePct != null ? String(b.retainagePct) : '');
    }).catch(() => {}).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [scope, id]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const methods = [...(check ? ['CHECK'] : []), ...(ach ? ['ACH'] : []), ...(card ? ['CARD'] : [])];
      const res = await fetch('/api/entity-invoice-settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope, id,
          payment_methods_allowed: methods,
          card_surcharge_enabled: card ? feePassed : null,
          retainage_enabled: retainage,
          default_retainage_pct: retainage && retPct.trim() !== '' ? Number(retPct) : null,
        }),
      });
      const b = await res.json();
      if (!res.ok) { addToast('error', b.error ?? 'Save failed'); return; }
      setUsingDefaults(false);
      addToast('success', 'Invoice settings saved');
    } finally { setSaving(false); }
  }, [scope, id, check, ach, card, feePassed, retainage, retPct]);

  if (loading) return <div className="flex items-center gap-2 text-slate-400 text-sm py-2"><Loader2 size={14} className="animate-spin" /> Loading…</div>;

  const Box = ({ on, set, label }: { on: boolean; set: (v: boolean) => void; label: string }) => (
    <label className="flex items-center gap-2 text-sm text-slate-200 cursor-pointer">
      <input type="checkbox" checked={on} onChange={(e) => { set(e.target.checked); setUsingDefaults(false); }} /> {label}
    </label>
  );

  return (
    <div className="space-y-4 text-sm">
      <div>
        <div className="text-slate-400 mb-2">Allowed payment methods{usingDefaults && <span className="text-2xs text-slate-500"> · showing company defaults</span>}</div>
        <div className="flex flex-col gap-2 pl-0.5">
          <Box on={check} set={setCheck} label="Check (mail to remit-to address)" />
          <Box on={ach} set={setAch} label="Bank transfer (ACH)" />
          <Box on={card} set={setCard} label="Credit / debit card" />
        </div>
      </div>

      {card && (
        <div className="pl-1 border-l-2 border-slate-700 ml-1 py-1">
          <div className="text-slate-400 mb-1.5 text-xs">Card processing fee (~{SURCHARGE_PCT}%)</div>
          <div className="flex flex-col gap-1.5 pl-2">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="radio" checked={feePassed} onChange={() => setFeePassed(true)} />
              Pass {SURCHARGE_PCT}% to the customer <span className="text-2xs text-slate-500">(added at card payment, not to the invoice)</span>
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="radio" checked={!feePassed} onChange={() => setFeePassed(false)} />
              We absorb it <span className="text-2xs text-slate-500">(customer pays the invoice amount)</span>
            </label>
          </div>
        </div>
      )}

      <div className="pt-1">
        <label className="flex items-center gap-2 text-sm text-slate-200 cursor-pointer">
          <input type="checkbox" checked={retainage} onChange={(e) => setRetainage(e.target.checked)} /> Withhold retainage on this {scope === 'LOCATION' ? 'entity’s' : scope.toLowerCase() + '’s'} invoices
        </label>
        {retainage && (
          <div className="flex items-center gap-2 mt-2 pl-6">
            <span className="text-xs text-slate-400">Default %</span>
            <input value={retPct} onChange={(e) => setRetPct(e.target.value)} inputMode="decimal" placeholder="10"
              className="w-20 px-2 py-1 rounded bg-slate-800 border border-slate-700 text-sm text-white font-mono" />
          </div>
        )}
      </div>

      <button onClick={save} disabled={saving}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-emerald-500 text-white hover:bg-emerald-400 disabled:opacity-50">
        {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Save settings
      </button>
    </div>
  );
}
