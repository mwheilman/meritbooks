'use client';

import { useState, useMemo } from 'react';
import { Lock } from 'lucide-react';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import type { PaymentMethod } from '@/lib/invoices/resolve-payment-methods';

/**
 * Pay Now on the hosted invoice page. Pick a method (ACH free; card with the fee
 * disclosed and explicitly accepted), then a Stripe PaymentIntent is created as a
 * destination charge to the tenant's connected account and confirmed via the
 * Stripe Payment Element. The webhook is the source of truth for marking paid.
 */
let _stripePromise: ReturnType<typeof loadStripe> | null = null;
function stripePromiseFor(pk: string) {
  if (!_stripePromise) _stripePromise = loadStripe(pk);
  return _stripePromise;
}

export function PayNow({
  token, accent, balanceLabel, methods, surcharge, surchargePct, payerName, payerEmail,
}: {
  token: string; accent: string; balanceLabel: string;
  methods: PaymentMethod[]; surcharge: boolean; surchargePct: number;
  payerName?: string; payerEmail?: string;
}) {
  const hasACH = methods.includes('ACH');
  const hasCard = methods.includes('CARD');
  const [method, setMethod] = useState<PaymentMethod>(hasACH ? 'ACH' : 'CARD');
  const [feeAccepted, setFeeAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [pk, setPk] = useState<string>('');

  const cardChosenNeedsFee = method === 'CARD' && surcharge && !feeAccepted;
  const canPay = method === 'ACH' || !cardChosenNeedsFee;

  async function start() {
    setBusy(true); setNotice(null);
    try {
      const res = await fetch(`/api/pay/${token}/intent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, accept_fee: feeAccepted }),
      });
      const b = await res.json().catch(() => ({}));
      if (b.enabled && b.client_secret && b.publishable_key) {
        setPk(b.publishable_key); setClientSecret(b.client_secret); return;
      }
      setNotice(b.message || 'Online payment isn’t available yet. Please use the remit-to details on this invoice.');
    } catch {
      setNotice('Something went wrong starting the payment. Please try again.');
    } finally { setBusy(false); }
  }

  const stripe = useMemo(() => (pk ? stripePromiseFor(pk) : null), [pk]);

  if (clientSecret && stripe) {
    return (
      <div style={W.box}>
        <div style={W.title}>Pay {balanceLabel}</div>
        <Elements stripe={stripe} options={{ clientSecret, appearance: { theme: 'flat', variables: { colorPrimary: accent } } }}>
          <CheckoutForm token={token} accent={accent} balanceLabel={balanceLabel} payerName={payerName} payerEmail={payerEmail} />
        </Elements>
        <div style={{ ...W.secure, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}><Lock size={12} /> Card details are entered securely on Stripe and never touch this site.</div>
      </div>
    );
  }

  return (
    <div style={W.box}>
      <div style={W.title}>Pay this invoice</div>
      <div style={W.methods}>
        {hasACH && (
          <button onClick={() => setMethod('ACH')} style={{ ...W.method, ...(method === 'ACH' ? { borderColor: accent, background: '#f0fdf9' } : {}) }}>
            <div style={W.mTop}><span style={W.mName}>Bank transfer (ACH)</span><span style={{ ...W.badge, color: '#16a34a', background: '#dcfce7' }}>No fee</span></div>
            <div style={W.mSub}>Pay directly from your bank account. Clears in 1–2 business days.</div>
          </button>
        )}
        {hasCard && (
          <button onClick={() => setMethod('CARD')} style={{ ...W.method, ...(method === 'CARD' ? { borderColor: accent, background: '#f0fdf9' } : {}) }}>
            <div style={W.mTop}><span style={W.mName}>Credit or debit card</span>{surcharge ? <span style={{ ...W.badge, color: '#b45309', background: '#fef3c7' }}>+{surchargePct}% fee</span> : <span style={{ ...W.badge, color: '#16a34a', background: '#dcfce7' }}>No fee</span>}</div>
            <div style={W.mSub}>{surcharge ? 'Confirms instantly. A card processing fee applies and is shown before you confirm.' : 'Confirms instantly.'}</div>
          </button>
        )}
      </div>
      {method === 'CARD' && surcharge && (
        <label style={W.feeRow}>
          <input type="checkbox" checked={feeAccepted} onChange={(e) => setFeeAccepted(e.target.checked)} />
          <span>I agree to the {surchargePct}% card processing fee added to my total.</span>
        </label>
      )}
      <button onClick={start} disabled={!canPay || busy} style={{ ...W.payBtn, background: accent, opacity: (!canPay || busy) ? 0.5 : 1, cursor: (!canPay || busy) ? 'not-allowed' : 'pointer' }}>
        {busy ? 'Starting…' : cardChosenNeedsFee ? 'Accept the fee to continue' : `Continue to pay ${balanceLabel}`}
      </button>
      {notice && <div style={W.notice}>{notice}</div>}
    </div>
  );
}

function CheckoutForm({ token, accent, balanceLabel, payerName, payerEmail }: { token: string; accent: string; balanceLabel: string; payerName?: string; payerEmail?: string }) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!stripe || !elements) return;
    setBusy(true); setErr(null);
    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: `${window.location.origin}/pay/${token}` },
    });
    if (error) { setErr(error.message ?? 'Payment failed.'); setBusy(false); }
  }

  const defaultValues = (payerName || payerEmail)
    ? { billingDetails: { name: payerName || undefined, email: payerEmail || undefined } }
    : undefined;

  return (
    <div>
      <PaymentElement options={defaultValues ? { defaultValues } : undefined} />
      <button onClick={submit} disabled={!stripe || busy} style={{ ...W.payBtn, background: accent, marginTop: 16, opacity: busy ? 0.5 : 1, cursor: busy ? 'not-allowed' : 'pointer' }}>
        {busy ? 'Processing…' : `Pay ${balanceLabel}`}
      </button>
      {err && <div style={W.notice}>{err}</div>}
    </div>
  );
}

const W: Record<string, React.CSSProperties> = {
  box: { border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, marginBottom: 24, background: '#fff' },
  title: { fontSize: 15, fontWeight: 700, marginBottom: 12 },
  methods: { display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 },
  method: { textAlign: 'left', border: '1.5px solid #e5e7eb', borderRadius: 10, padding: '12px 14px', background: '#fff', cursor: 'pointer' },
  mTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  mName: { fontWeight: 600, fontSize: 14 },
  mSub: { fontSize: 12.5, color: '#6b7280', marginTop: 3 },
  badge: { fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999 },
  feeRow: { display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, color: '#444', marginBottom: 12, lineHeight: 1.4 },
  payBtn: { width: '100%', padding: '13px', borderRadius: 10, border: 'none', color: '#fff', fontSize: 15, fontWeight: 700 },
  notice: { marginTop: 12, padding: 10, borderRadius: 8, background: '#f9fafb', color: '#555', fontSize: 13, lineHeight: 1.45 },
  secure: { marginTop: 12, fontSize: 11.5, color: '#9ca3af', textAlign: 'center' },
};
