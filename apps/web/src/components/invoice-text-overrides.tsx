'use client';

import { useState, useEffect, useCallback } from 'react';
import { Loader2, Check } from 'lucide-react';
import { addToast } from '@/hooks';

/**
 * Reusable editor for the invoice text-override cascade. Drop it into any
 * surface with the scope + ref for that level — customer form (scope CUSTOMER,
 * ref customer_id), job form (JOB), the invoice drawer (INVOICE), or an
 * invoice-type manager (INVOICE_TYPE). Leaving a field blank clears the override
 * so it falls back up the cascade (invoice → type → job → customer → entity).
 */
const SLOT_LABELS: { slot: string; label: string; multiline?: boolean }[] = [
  { slot: 'customer_message', label: 'Invoice message', multiline: true },
  { slot: 'footer_text', label: 'Footer' },
  { slot: 'remit_to', label: 'Remit-to', multiline: true },
  { slot: 'terms_note', label: 'Terms note', multiline: true },
  { slot: 'payment_instructions', label: 'Payment instructions', multiline: true },
];

export function InvoiceTextOverrides({ scope, refId, title }: { scope: 'CUSTOMER' | 'JOB' | 'INVOICE_TYPE' | 'INVOICE'; refId: string; title?: string }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [savingSlot, setSavingSlot] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(`/api/invoice-text?scope=${scope}&ref=${encodeURIComponent(refId)}`)
      .then((r) => r.json())
      .then((b) => { if (alive) setValues(b.values ?? {}); })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [scope, refId]);

  const saveSlot = useCallback(async (slot: string) => {
    setSavingSlot(slot);
    try {
      const res = await fetch('/api/invoice-text', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, ref: refId, slot, value: values[slot] ?? '' }),
      });
      const b = await res.json();
      if (!res.ok) { addToast('error', b.error ?? 'Save failed'); return; }
      addToast('success', (values[slot] ?? '').trim() === '' ? 'Reverted to default' : 'Saved');
    } finally { setSavingSlot(null); }
  }, [scope, refId, values]);

  if (loading) return <div className="flex items-center gap-2 text-slate-400 text-sm py-3"><Loader2 size={14} className="animate-spin" /> Loading text…</div>;

  return (
    <div className="space-y-3">
      {title && <div className="text-xs font-medium text-slate-400 uppercase tracking-wide">{title}</div>}
      <p className="text-2xs text-slate-500">Anything set here overrides the default for this {scope.toLowerCase().replace('_', ' ')}. Leave blank to use the inherited text.</p>
      {SLOT_LABELS.map((f) => (
        <div key={f.slot}>
          <label className="block text-2xs text-slate-400 mb-1">{f.label}</label>
          <div className="flex items-start gap-2">
            {f.multiline ? (
              <textarea rows={2} value={values[f.slot] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.slot]: e.target.value }))}
                className="flex-1 px-2.5 py-1.5 rounded-md bg-slate-800 border border-slate-700 text-sm text-white" placeholder="Inherited" />
            ) : (
              <input value={values[f.slot] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.slot]: e.target.value }))}
                className="flex-1 px-2.5 py-1.5 rounded-md bg-slate-800 border border-slate-700 text-sm text-white" placeholder="Inherited" />
            )}
            <button onClick={() => saveSlot(f.slot)} disabled={savingSlot === f.slot}
              className="mt-0.5 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs bg-slate-700 text-slate-200 hover:bg-slate-600">
              {savingSlot === f.slot ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
