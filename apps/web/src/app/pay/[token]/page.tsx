export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { createAdminSupabase } from '@/lib/supabase/server';
import { loadInvoiceDocByToken } from '@/lib/invoices/invoice-doc';
import { recordInvoiceEvent } from '@/lib/invoices/invoice-events';
import {
  resolvePaymentMethods,
  resolveSurchargeEnabled,
  type PaymentProviderId,
} from '@/lib/invoices/resolve-payment-methods';
import { PayNow } from './pay-now';

/**
 * Hosted customer invoice view (FPB §3/§8). Public, tokenized, no login.
 * Renders the branded document, offers a PDF download, and (once the payments
 * package lands) the Pay Now surface. Opening the page records a VIEWED event
 * so the issuer sees "opened N times, last on…".
 *
 * Pay Now is intentionally a disabled placeholder here — the PaymentProvider
 * adapter + Stripe credentials arrive in the next package; the resolved,
 * provider-supported methods are already computed so the UI is correct the day
 * the adapter turns on.
 */

const money = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const fmtDate = (d: string) =>
  d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '';

export default async function HostedInvoicePage({ params }: { params: { token: string } }) {
  const supabase = createAdminSupabase();
  const loaded = await loadInvoiceDocByToken(supabase, params.token);

  if (!loaded) {
    return (
      <main style={S.notFoundWrap}>
        <div style={S.notFoundCard}>
          <h1 style={S.notFoundTitle}>Invoice not found</h1>
          <p style={S.muted}>This link may have expired or is incorrect. Contact the sender for an updated link.</p>
        </div>
      </main>
    );
  }

  const { doc, orgId } = loaded;

  // Record the view (best-effort; never blocks the render).
  await recordInvoiceEvent(supabase, { orgId, invoiceId: doc.id, type: 'VIEWED', actor: 'customer' });

  // Resolve which methods Pay Now WILL offer. The full cascade (invoice → job →
  // customer → entity) is wired in the payments package where Pay Now turns on;
  // here we show the resolved default so the note is accurate today.
  const provider: PaymentProviderId = 'STRIPE';
  const methods = resolvePaymentMethods({ invoice: doc.payment_methods_allowed ?? null }, provider);
  const surcharge = resolveSurchargeEnabled({ invoice: doc.card_surcharge_enabled ?? null });

  const accent = doc.template?.accent_color || '#10b981';
  const paid = doc.status === 'PAID' || doc.balance_cents <= 0;
  const overdue = !paid && new Date(doc.due_date + 'T00:00:00') < new Date();

  return (
    <main style={S.wrap}>
      <div style={S.sheet}>
        <header style={S.head}>
          <div>
            <div style={S.entity}>{doc.entity?.name || 'Invoice'}</div>
            <div style={S.muted}>Invoice {doc.invoice_number}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ ...S.statusPill, background: paid ? '#16a34a' : overdue ? '#dc2626' : accent }}>
              {paid ? 'Paid' : overdue ? 'Overdue' : doc.status === 'SENT' ? 'Due' : doc.status}
            </div>
            <div style={{ ...S.muted, marginTop: 6 }}>Due {fmtDate(doc.due_date)}</div>
          </div>
        </header>

        <section style={S.balanceRow}>
          <div>
            <div style={S.muted}>Balance due</div>
            <div style={{ ...S.balance, color: accent }}>{money(doc.balance_cents)}</div>
          </div>
          <div style={S.actions}>
            <a href={`/api/invoices/${doc.id}/pdf`} style={S.secondaryBtn} target="_blank" rel="noreferrer">Download PDF</a>
          </div>
        </section>

        {!paid && methods.length > 0 && (
          <PayNow
            token={doc.public_token}
            accent={accent}
            balanceLabel={money(doc.balance_cents)}
            methods={methods}
            surcharge={surcharge}
            surchargePct={3}
          />
        )}
        {paid && (
          <div style={{ ...S.paidBanner, color: '#16a34a' }}>Paid in full — thank you.</div>
        )}

        <table style={S.table}>
          <thead>
            <tr style={{ background: accent }}>
              <th style={{ ...S.th, textAlign: 'left' }}>Description</th>
              <th style={S.th}>Qty</th>
              <th style={{ ...S.th, textAlign: 'right' }}>Rate</th>
              <th style={{ ...S.th, textAlign: 'right' }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {doc.lines.map((l, i) => (
              <tr key={i} style={S.tr}>
                <td style={S.td}>{l.description}</td>
                <td style={{ ...S.td, textAlign: 'center' }}>{l.quantity}</td>
                <td style={{ ...S.td, textAlign: 'right' }}>{money(l.unit_price_cents)}</td>
                <td style={{ ...S.td, textAlign: 'right' }}>{money(l.amount_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={S.totals}>
          <Row label="Subtotal" value={money(doc.subtotal_cents)} />
          {doc.discount_cents > 0 && <Row label="Discount" value={`-${money(doc.discount_cents)}`} />}
          {doc.tax_cents > 0 && <Row label="Tax" value={money(doc.tax_cents)} />}
          {doc.retainage_cents > 0 && <Row label="Retainage withheld" value={`-${money(doc.retainage_cents)}`} />}
          <Row label="Total" value={money(doc.total_cents)} bold />
          {doc.amount_paid_cents > 0 && <Row label="Paid" value={`-${money(doc.amount_paid_cents)}`} />}
        </div>

        {doc.customer_message && <p style={S.message}>{doc.customer_message}</p>}
        <footer style={S.footer}>{doc.template?.footer_text || `${doc.entity?.name ?? ''} · ${doc.invoice_number}`}</footer>
      </div>
    </main>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontWeight: bold ? 700 : 400, borderTop: bold ? '1.5px solid #111' : 'none', marginTop: bold ? 6 : 0, paddingTop: bold ? 8 : 4 }}>
      <span style={{ color: bold ? '#111' : '#555' }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: { minHeight: '100vh', background: '#f3f4f6', padding: '40px 16px', fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif', color: '#1a1a1a' },
  sheet: { maxWidth: 720, margin: '0 auto', background: '#fff', borderRadius: 12, boxShadow: '0 4px 24px rgba(0,0,0,0.08)', padding: 40 },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 },
  entity: { fontSize: 20, fontWeight: 700 },
  muted: { color: '#888', fontSize: 13 },
  statusPill: { display: 'inline-block', color: '#fff', fontSize: 12, fontWeight: 600, padding: '4px 12px', borderRadius: 999, textTransform: 'uppercase', letterSpacing: 0.4 },
  balanceRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 0', borderTop: '1px solid #eee', borderBottom: '1px solid #eee', marginBottom: 20 },
  balance: { fontSize: 30, fontWeight: 700, fontVariantNumeric: 'tabular-nums' },
  actions: { display: 'flex', gap: 10, alignItems: 'center' },
  secondaryBtn: { padding: '10px 16px', borderRadius: 8, border: '1px solid #d1d5db', color: '#374151', textDecoration: 'none', fontSize: 14, fontWeight: 500 },
  payBtn: { padding: '10px 20px', borderRadius: 8, border: 'none', color: '#fff', fontSize: 14, fontWeight: 600 },
  payNote: { fontSize: 12.5, color: '#777', marginTop: -8, marginBottom: 20 },
  paidBanner: { padding: 14, borderRadius: 10, background: '#f0fdf4', textAlign: 'center', fontWeight: 600, marginBottom: 24 },
  table: { width: '100%', borderCollapse: 'collapse', marginBottom: 8 },
  th: { color: '#fff', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, padding: '8px 10px', textAlign: 'center' },
  tr: { borderBottom: '1px solid #eee' },
  td: { padding: '10px', fontSize: 14 },
  totals: { maxWidth: 280, marginLeft: 'auto', marginTop: 8 },
  message: { marginTop: 24, paddingTop: 16, borderTop: '1px solid #eee', color: '#555', fontSize: 14, lineHeight: 1.5 },
  footer: { marginTop: 28, paddingTop: 14, borderTop: '1px solid #eee', textAlign: 'center', color: '#aaa', fontSize: 12 },
  notFoundWrap: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f3f4f6', fontFamily: 'system-ui, sans-serif' },
  notFoundCard: { background: '#fff', padding: 40, borderRadius: 12, textAlign: 'center', maxWidth: 420 },
  notFoundTitle: { fontSize: 20, marginBottom: 8 },
};
