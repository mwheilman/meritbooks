'use client';

import { useState } from 'react';
import type { PaymentMethod } from '@/lib/invoices/resolve-payment-methods';

/**
 * Pay Now surface on the hosted invoice page (FPB §11a). Lets the customer pick
 * an authorized method. ACH is presented free; card is presented only with the
 * processing fee disclosed, and the card option requires an explicit fee
 * acceptance before any charge is created. The actual charge call goes through
 * /api/pay/[token]/intent, which is provider-backed (Stripe Connect) and returns
 * a not-enabled state until the tenant's payment account is connected — so the
 * function is fully visible now and only the final charge is gated on credentials.
 */
export function PayNow({
  token, accent, balanceLabel, methods, surcharge, surchargePct,
}: {
  token: string; accent: string; balanceLabel: string;
  methods: PaymentMethod[]; surcharge: boolean; surchargePct: number;
}) {
  const hasACH = methods.includes('ACH');
  const hasCard = methods.includes('CARD');
  const [method, setMethod] = useState<PaymentMethod>(hasACH ? 'ACH' : 'CARD');
  const [feeAccepted, setFeeAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const cardChosenNeedsFee = method === 'CARD' && surcharge && !feeAccepted;
  const canPay = method === 'ACH' || !cardChosenNeedsFee;

  async function pay() {
    setBusy(true); setNotice(null);
    try {
      const res = await fetch(`/api/pay/${token}/intent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, accept_fee: feeAccepted }),
      });
      const body = await res.json().catch(() => ({}));
      if (body.enabled && body.redirect_url) { window.location.href = body.redirect_url; return; }
      if (body.enabled && body.client_secret) { setNotice('Opening secure payment…'); /* Stripe Elements mounts here once wired */ return; }
      setNotice(body.message || 'Online payment isn’t available yet. Please use the remit-to details on this invoice.');
    } catch {
      setNotice('Something went wrong starting the payment. Please try again or use the remit-to details.');
    } finally { setBusy(false); }
  }

  return (
    <div style={W.box}>
      <div style={W.title}>Pay this invoice</div>
      <div style={W.methods}>
        {hasACH && (
          <button onClick={() => setMethod('ACH')} style={{ ...W.method, ...(method === 'ACH' ? { borderColor: accent, background: '#f0fdf9' } : {}) }}>
            <div style={W.mTop}>
              <span style={W.mName}>Bank transfer (ACH)</span>
              <span style={{ ...W.badge, color: '#16a34a', background: '#dcfce7' }}>No fee</span>
            </div>
            <div style={W.mSub}>Pay directly from your bank account.</div>
          </button>
        )}
        {hasCard && (
          <button onClick={() => setMethod('CARD')} style={{ ...W.method, ...(method === 'CARD' ? { borderColor: accent, background: '#f0fdf9' } : {}) }}>
            <div style={W.mTop}>
              <span style={W.mName}>Credit or debit card</span>
              {surcharge ? <span style={{ ...W.badge, color: '#b45309', background: '#fef3c7' }}>+{surchargePct}% fee</span> : <span style={{ ...W.badge, color: '#16a34a', background: '#dcfce7' }}>No fee</span>}
            </div>
            <div style={W.mSub}>{surcharge ? 'A card processing fee applies and is shown before you confirm.' : 'Pay by card.'}</div>
          </button>
        )}
      </div>

      {method === 'CARD' && surcharge && (
        <label style={W.feeRow}>
          <input type="checkbox" checked={feeAccepted} onChange={(e) => setFeeAccepted(e.target.checked)} />
          <span>I agree to the {surchargePct}% card processing fee added to my total.</span>
        </label>
      )}

      <button onClick={pay} disabled={!canPay || busy}
        style={{ ...W.payBtn, background: accent, opacity: (!canPay || busy) ? 0.5 : 1, cursor: (!canPay || busy) ? 'not-allowed' : 'pointer' }}>
        {busy ? 'Starting…' : cardChosenNeedsFee ? 'Accept the fee to continue' : `Pay ${balanceLabel}`}
      </button>

      {notice && <div style={W.notice}>{notice}</div>}
      <div style={W.secure}>🔒 Payments are processed securely. Your card details never touch this site.</div>
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
