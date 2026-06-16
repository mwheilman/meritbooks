'use client';

import { useState, useEffect, useCallback } from 'react';
import { Loader2, Check } from 'lucide-react';
import { clsx } from 'clsx';
import { addToast } from '@/hooks';

/**
 * Self-saving panel for the invoice cascade settings at one scope
 * (CUSTOMER / JOB / LOCATION): authorized payment methods, card-surcharge
 * posture, and retainage opt-in. "Inherit" leaves the field null so it falls
 * through the cascade (invoice → job → customer → entity → default). Drops into
 * the customer drawer, job detail, and the entity branding screen.
 */
type Tri = 'INHERIT' | 'ON' | 'OFF';
const triToBool = (t: Tri): boolean | null => (t === 'ON' ? true : t === 'OFF' ? false : null);
const boolToTri = (b: boolean | null | undefined): Tri => (b === true ? 'ON' : b === false ? 'OFF' : 'INHERIT');

export function EntityInvoiceSettings({ scope, id }: { scope: 'CUSTOMER' | 'JOB' | 'LOCATION'; id: string }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [methodsMode, setMethodsMode] = useState<'INHERIT' | 'CUSTOM'>('INHERIT');
  const [ach, setAch] = useState(true);
  const [card, setCard] = useState(false);
  const [surcharge, setSurcharge] = useState<Tri>('INHERIT');
  const [retainage, setRetainage] = useState<Tri>('INHERIT');
  const [retPct, setRetPct] = useState<string>('');

  useEffect(() => {
    let alive = true; setLoading(true);
    fetch(`/api/entity-invoice-settings?scope=${scope}&id=${id}`).then((r) => r.json()).then((b) => {
      if (!alive) return;
      if (Array.isArray(b.paymentMethods)) {
        setMethodsMode('CUSTOM');
        setAch(b.paymentMethods.includes('ACH'));
        setCard(b.paymentMethods.includes('CARD'));
      } else { setMethodsMode('INHERIT'); }
      setSurcharge(boolToTri(b.cardSurcharge));
      setRetainage(boolToTri(b.retainageEnabled));
      setRetPct(b.retainagePct != null ? String(b.retainagePct) : '');
    }).catch(() => {}).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [scope, id]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const methods = methodsMode === 'INHERIT' ? null : [...(ach ? ['ACH'] : []), ...(card ? ['CARD'] : [])];
      const res = await fetch('/api/entity-invoice-settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope, id,
          payment_methods_allowed: methods,
          card_surcharge_enabled: triToBool(surcharge),
          retainage_enabled: triToBool(retainage),
          default_retainage_pct: retPct.trim() === '' ? null : Number(retPct),
        }),
      });
      const b = await res.json();
      if (!res.ok) { addToast('error', b.error ?? 'Save failed'); return; }
      addToast('success', 'Invoice settings saved');
    } finally { setSaving(false); }
  }, [scope, id, methodsMode, ach, card, surcharge, retainage, retPct]);

  if (loading) return <div className="flex items-center gap-2 text-slate-400 text-sm py-2"><Loader2 size={14} className="animate-spin" /> Loading…</div>;

  const seg = (val: Tri, set: (t: Tri) => void) => (
    <div className="inline-flex rounded-md overflow-hidden border border-slate-700">
      {(['INHERIT', 'ON', 'OFF'] as Tri[]).map((t) => (
        <button key={t} onClick={() => set(t)}
          className={clsx('px-2.5 py-1 text-xs', val === t ? 'bg-emerald-500/15 text-emerald-300' : 'text-slate-400 hover:text-white')}>
          {t === 'INHERIT' ? 'Inherit' : t === 'ON' ? 'On' : 'Off'}
        </button>
      ))}
    </div>
  );

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="text-slate-400">Payment methods</span>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-slate-300">
            <input type="radio" checked={methodsMode === 'INHERIT'} onChange={() => setMethodsMode('INHERIT')} /> Inherit
          </label>
          <label className="flex items-center gap-1.5 text-xs text-slate-300">
            <input type="radio" checked={methodsMode === 'CUSTOM'} onChange={() => setMethodsMode('CUSTOM')} /> Custom
          </label>
        </div>
      </div>
      {methodsMode === 'CUSTOM' && (
        <div className="flex items-center gap-4 pl-1">
          <label className="flex items-center gap-1.5 text-xs text-slate-300"><input type="checkbox" checked={ach} onChange={(e) => setAch(e.target.checked)} /> Bank transfer (ACH)</label>
          <label className="flex items-center gap-1.5 text-xs text-slate-300"><input type="checkbox" checked={card} onChange={(e) => setCard(e.target.checked)} /> Card</label>
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <span className="text-slate-400">Card surcharge</span>{seg(surcharge, setSurcharge)}
      </div>

      <div className="flex items-center justify-between gap-3">
        <span className="text-slate-400">Retainage</span>{seg(retainage, setRetainage)}
      </div>
      {retainage === 'ON' && (
        <div className="flex items-center justify-between gap-3 pl-1">
          <span className="text-xs text-slate-400">Default retainage %</span>
          <input value={retPct} onChange={(e) => setRetPct(e.target.value)} inputMode="decimal" placeholder="e.g. 10"
            className="w-24 px-2 py-1 rounded bg-slate-800 border border-slate-700 text-sm text-white font-mono" />
        </div>
      )}

      <button onClick={save} disabled={saving}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-emerald-500 text-white hover:bg-emerald-400 disabled:opacity-50">
        {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Save settings
      </button>
    </div>
  );
}
