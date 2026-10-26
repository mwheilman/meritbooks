'use client';

import { useState, useEffect, useCallback, type CSSProperties } from 'react';
import { Button, Field, InlineNotice, Input, Textarea } from '@meritbooks/merit-ui';
import { addToast } from '@/hooks';

/**
 * Reusable editor for the invoice text-override cascade. Drop it into any
 * surface with the scope + ref for that level — customer form (scope CUSTOMER,
 * ref customer_id), job form (JOB), the invoice drawer (INVOICE), or an
 * invoice-type manager (INVOICE_TYPE). Leaving a field blank clears the override
 * so it falls back up the cascade (invoice → type → job → customer → entity).
 *
 * merit-ui (kit classes + inline layout only): this component renders on ported and
 * still-bridged pages alike, so it carries no Tailwind utilities.
 */
const SLOT_LABELS: { slot: string; label: string; multiline?: boolean }[] = [
  { slot: 'customer_message', label: 'Invoice message', multiline: true },
  { slot: 'footer_text', label: 'Footer' },
  { slot: 'remit_to', label: 'Remit-to', multiline: true },
  { slot: 'terms_note', label: 'Terms note', multiline: true },
  { slot: 'payment_instructions', label: 'Payment instructions', multiline: true },
];

const ROW: CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 32px', gap: 8, alignItems: 'end' };

export function InvoiceTextOverrides({ scope, refId, title }: { scope: 'CUSTOMER' | 'JOB' | 'INVOICE_TYPE' | 'INVOICE'; refId: string; title?: string }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [savingSlot, setSavingSlot] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    fetch(`/api/invoice-text?scope=${scope}&ref=${encodeURIComponent(refId)}`)
      .then(async (r) => {
        const b = await r.json().catch(() => ({}));
        if (!alive) return;
        if (!r.ok) { setLoadError(b.error ?? 'The saved text could not be loaded.'); return; }
        setValues(b.values ?? {});
      })
      .catch(() => { if (alive) setLoadError('Network error while loading the text.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [scope, refId, attempt]);

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

  if (loading) {
    return (
      <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 0' }}>
        <span className="mb-skel" style={{ width: '40%' }} aria-hidden="true" />
        <span className="mb-skel" style={{ width: '100%', height: 32 }} aria-hidden="true" />
        <span className="mb-skel" style={{ width: '100%', height: 32 }} aria-hidden="true" />
        <span className="sr" role="status">Loading text…</span>
      </div>
    );
  }

  if (loadError) {
    return (
      <InlineNotice tone="neg" title="Couldn't load the invoice text.">
        {loadError} <Button variant="quiet" onClick={() => setAttempt((a) => a + 1)}>Try again</Button>
      </InlineNotice>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {title && <div className="eyebrow">{title}</div>}
      <p className="t-cap">Anything set here overrides the default for this {scope.toLowerCase().replace('_', ' ')}. Leave blank to use the inherited text.</p>
      {SLOT_LABELS.map((f) => (
        <div key={f.slot} style={ROW}>
          <Field label={f.label}>
            {f.multiline ? (
              <Textarea rows={2} value={values[f.slot] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.slot]: e.target.value }))} placeholder="Inherited" />
            ) : (
              <Input value={values[f.slot] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.slot]: e.target.value }))} placeholder="Inherited" />
            )}
          </Field>
          <Button
            iconOnly
            icon="check"
            onClick={() => saveSlot(f.slot)}
            disabled={savingSlot === f.slot}
            aria-busy={savingSlot === f.slot || undefined}
            aria-label={`Save ${f.label.toLowerCase()}`}
            title={`Save ${f.label.toLowerCase()}`}
          />
        </div>
      ))}
    </div>
  );
}
