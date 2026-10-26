'use client';

import { useState, useEffect, useCallback, type ChangeEvent } from 'react';
import { Button, Check, Field, Input, InlineNotice, Radio } from '@meritbooks/merit-ui';
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
 *
 * Presentation: kit classes + inline layout only (renders inside bridged and ported pages).
 */
const SURCHARGE_PCT = 3;

export function EntityInvoiceSettings({ scope, id }: { scope: 'CUSTOMER' | 'JOB' | 'LOCATION'; id: string }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [check, setCheck] = useState(true);
  const [ach, setAch] = useState(true);
  const [card, setCard] = useState(false);
  const [feePassed, setFeePassed] = useState(true); // true = pass to customer, false = absorb
  const [usingDefaults, setUsingDefaults] = useState(true);
  const [retainage, setRetainage] = useState(false);
  const [retPct, setRetPct] = useState('');

  useEffect(() => {
    let alive = true; setLoading(true); setLoadError(null);
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
    }).catch(() => { if (alive) setLoadError('Could not load the saved settings.'); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [scope, id, reloadKey]);

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
    } catch {
      addToast('error', 'Could not reach the server. Try again.');
    } finally { setSaving(false); }
  }, [scope, id, check, ach, card, feePassed, retainage, retPct]);

  if (loading) {
    return (
      <div className="wg-loading" aria-busy="true" style={{ display: 'grid', gap: 10, padding: '8px 0' }}>
        <span className="bar-l" style={{ width: '50%' }} aria-hidden="true" />
        <span className="bar-l" style={{ width: '35%' }} aria-hidden="true" />
        <span className="t-cap" role="status">Loading invoice settings…</span>
      </div>
    );
  }

  if (loadError) {
    return (
      <InlineNotice tone="neg" title="Invoice settings didn’t load.">
        <span>{loadError}</span>{' '}
        <Button variant="quiet" onClick={() => setReloadKey((k) => k + 1)}>Try again</Button>
      </InlineNotice>
    );
  }

  const pick = (set: (v: boolean) => void) => (e: ChangeEvent<HTMLInputElement>) => { set(e.target.checked); setUsingDefaults(false); };
  const whose = scope === 'LOCATION' ? 'company’s' : scope.toLowerCase() + '’s';

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 4 }}>
        <legend className="field-label" style={{ marginBottom: 4 }}>
          Allowed payment methods{usingDefaults && <span className="t-cap"> · showing company defaults</span>}
        </legend>
        <Check checked={check} onChange={pick(setCheck)} label="Check (mail to remit-to address)" />
        <Check checked={ach} onChange={pick(setAch)} label="Bank transfer (ACH)" />
        <Check checked={card} onChange={pick(setCard)} label="Credit / debit card" />
      </fieldset>

      {card && (
        <fieldset style={{ border: 0, margin: 0, padding: '0 0 0 16px', boxShadow: 'inset 2px 0 var(--line-2)', display: 'grid', gap: 4 }}>
          <legend className="field-label" style={{ marginBottom: 4 }}>Card processing fee (~{SURCHARGE_PCT}%)</legend>
          <Radio
            name={`fee-${scope}-${id}`}
            checked={feePassed}
            onChange={() => setFeePassed(true)}
            label={<>Pass {SURCHARGE_PCT}% to the customer <span className="t-cap">(added when they pay, not to the invoice)</span></>}
          />
          <Radio
            name={`fee-${scope}-${id}`}
            checked={!feePassed}
            onChange={() => setFeePassed(false)}
            label={<>We absorb it <span className="t-cap">(customer pays the invoice amount)</span></>}
          />
        </fieldset>
      )}

      <div style={{ display: 'grid', gap: 8 }}>
        <Check
          checked={retainage}
          onChange={(e) => setRetainage(e.target.checked)}
          label={`Withhold retainage on this ${whose} invoices`}
        />
        {retainage && (
          <div style={{ paddingLeft: 24, width: 160 }}>
            <Field label="Default %">
              <Input value={retPct} onChange={(e) => setRetPct(e.target.value)} inputMode="decimal" placeholder="10" className="tnum" />
            </Field>
          </div>
        )}
      </div>

      <div>
        <Button onClick={save} disabled={saving} icon="check" aria-busy={saving || undefined}>
          {saving ? 'Saving…' : 'Save settings'}
        </Button>
      </div>
    </div>
  );
}
