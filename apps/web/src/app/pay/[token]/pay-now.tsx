'use client';

import { useState, useMemo } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { InlineNotice, Tag } from '@meritbooks/merit-ui';
import type { PaymentMethod } from '@/lib/invoices/resolve-payment-methods';

/**
 * Pay Now on the hosted invoice page (merit-ui, company brand colour via --brand).
 * Pick a method (bank transfer free; card with the fee disclosed and explicitly
 * accepted), then a Stripe PaymentIntent is created as a destination charge to the
 * company's connected account and confirmed via the Stripe Payment Element. The
 * webhook is the source of truth for marking paid. API contract with
 * /api/pay/[token]/intent unchanged.
 */
let _stripePromise: ReturnType<typeof loadStripe> | null = null;
function stripePromiseFor(pk: string) {
  if (!_stripePromise) _stripePromise = loadStripe(pk);
  return _stripePromise;
}

export function PayNow({
  token, accent, balanceLabel, methods, surcharge, surchargePct, payerName, payerEmail, testMode = false,
}: {
  token: string; accent: string; balanceLabel: string;
  methods: PaymentMethod[]; surcharge: boolean; surchargePct: number;
  payerName?: string; payerEmail?: string;
  /** The company's payment connection is in Stripe TEST mode — say so plainly. */
  testMode?: boolean;
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
      setNotice(b.message || 'Online payment isn’t available right now. Please use the payment instructions on this invoice.');
    } catch {
      setNotice('Something went wrong starting the payment. Please try again.');
    } finally { setBusy(false); }
  }

  const stripe = useMemo(() => (pk ? stripePromiseFor(pk) : null), [pk]);

  const testNotice = testMode ? (
    <div style={{ marginBottom: 16 }}>
      <InlineNotice tone="warn" title="Test mode.">This business’s online payments are in test mode. No real money moves.</InlineNotice>
    </div>
  ) : null;

  if (clientSecret && stripe) {
    return (
      <section className="mb-pay-box" aria-label="Payment">
        <h2>Pay {balanceLabel}</h2>
        {testNotice}
        <Elements stripe={stripe} options={{ clientSecret, appearance: { theme: 'flat', variables: { colorPrimary: accent, borderRadius: '0px', fontFamily: 'DM Sans, system-ui, sans-serif' } } }}>
          <CheckoutForm token={token} balanceLabel={balanceLabel} payerName={payerName} payerEmail={payerEmail} />
        </Elements>
        <div className="mb-pay-secure">Card and bank details are entered securely with Stripe and never touch this site.</div>
      </section>
    );
  }

  return (
    <section className="mb-pay-box" aria-label="Pay this invoice">
      <h2>Pay this invoice</h2>
      {testNotice}
      <div className="mb-pay-methods" role="group" aria-label="Payment method">
        {hasACH && (
          <button type="button" className="mb-pay-method" aria-pressed={method === 'ACH'} onClick={() => setMethod('ACH')}>
            <span className="mb-pay-mtop"><span>Bank transfer (ACH)</span><Tag tone="pos">No fee</Tag></span>
            <span className="mb-pay-msub" style={{ display: 'block' }}>Pay directly from your bank account. Clears in 1–2 business days.</span>
          </button>
        )}
        {hasCard && (
          <button type="button" className="mb-pay-method" aria-pressed={method === 'CARD'} onClick={() => setMethod('CARD')}>
            <span className="mb-pay-mtop">
              <span>Credit or debit card</span>
              {surcharge ? <Tag tone="warn">+{surchargePct}% fee</Tag> : <Tag tone="pos">No fee</Tag>}
            </span>
            <span className="mb-pay-msub" style={{ display: 'block' }}>
              {surcharge ? 'Confirms instantly. A card processing fee applies and is shown before you confirm.' : 'Confirms instantly.'}
            </span>
          </button>
        )}
      </div>
      {method === 'CARD' && surcharge && (
        <label className="mb-pay-fee">
          <input type="checkbox" className="check" checked={feeAccepted} onChange={(e) => setFeeAccepted(e.target.checked)} />
          <span>I agree to the {surchargePct}% card processing fee added to my total.</span>
        </label>
      )}
      <button type="button" className="mb-pay-cta" onClick={start} disabled={!canPay || busy}>
        {busy ? 'Starting…' : cardChosenNeedsFee ? 'Accept the fee to continue' : `Continue to pay ${balanceLabel}`}
      </button>
      {notice && <div style={{ marginTop: 16 }}><InlineNotice tone="default" title="Online payment isn’t available.">{notice}</InlineNotice></div>}
    </section>
  );
}

function CheckoutForm({ token, balanceLabel, payerName, payerEmail }: { token: string; balanceLabel: string; payerName?: string; payerEmail?: string }) {
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
      <button type="button" className="mb-pay-cta" onClick={submit} disabled={!stripe || busy} style={{ marginTop: 16 }}>
        {busy ? 'Processing…' : `Pay ${balanceLabel}`}
      </button>
      {err && <div style={{ marginTop: 16 }}><InlineNotice tone="neg" title="The payment didn’t go through.">{err}</InlineNotice></div>}
    </div>
  );
}
