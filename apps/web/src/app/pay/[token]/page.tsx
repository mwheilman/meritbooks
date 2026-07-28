export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { Check, Clock, AlertTriangle } from 'lucide-react';
import { createAdminSupabase } from '@/lib/supabase/server';
import { loadInvoiceDocByToken } from '@/lib/invoices/invoice-doc';
import { recordInvoiceEvent } from '@/lib/invoices/invoice-events';
import {
  resolvePaymentMethods,
  resolveSurchargeEnabled,
  onlineMethods,
  type PaymentProviderId,
} from '@/lib/invoices/resolve-payment-methods';
import { PayNow } from './pay-now';
import { getPaymentIntentStatus } from '@/lib/money/providers/stripe';

/**
 * Hosted customer invoice view — public, tokenized, no login. A branded,
 * invoice-styled document (tenant logo + accent + clean typography) with Pay Now
 * embedded as the primary action, so the customer lands on something that looks
 * like their actual invoice rather than a generic form. Opening records a VIEWED
 * event for the issuer's open tracking.
 */

const money = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const fmtDate = (d: string) =>
  d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '';

function readable(hex: string): string {
  const h = hex.replace('#', '');
  if (h.length !== 6) return '#ffffff';
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#0f172a' : '#ffffff';
}

function billToLines(bill: Record<string, unknown> | null, fallbackName?: string): string[] {
  const out: string[] = [];
  if (fallbackName) out.push(fallbackName);
  if (bill) {
    for (const k of ['attn', 'line1', 'line2', 'street', 'address', 'city_state_zip', 'city', 'state', 'zip', 'email']) {
      const v = bill[k];
      if (typeof v === 'string' && v.trim() && !out.includes(v.trim())) out.push(v.trim());
    }
  }
  return out;
}

export default async function HostedInvoicePage(
  { params, searchParams }: { params: { token: string }; searchParams: { payment_intent?: string; redirect_status?: string } },
) {
  const supabase = createAdminSupabase();
  const loaded = await loadInvoiceDocByToken(supabase, params.token);

  if (!loaded) {
    return (
      <main style={S.notFoundWrap}>
        <FontHead />
        <div style={S.notFoundCard}>
          <h1 style={S.notFoundTitle}>Invoice not found</h1>
          <p style={S.muted}>This link may have expired or is incorrect. Contact the sender for an updated link.</p>
        </div>
      </main>
    );
  }

  const { doc, orgId } = loaded;
  await recordInvoiceEvent(supabase, { orgId, invoiceId: doc.id, type: 'VIEWED', actor: 'customer' });

  // If the customer was redirected back from Stripe, resolve the real outcome so
  // we can show a clear confirmation instead of looking like nothing happened.
  let returnBanner: { tone: 'ok' | 'pending' | 'fail'; text: string } | null = null;
  if (searchParams?.payment_intent) {
    const st = await getPaymentIntentStatus(searchParams.payment_intent);
    if (st === 'succeeded') returnBanner = { tone: 'ok', text: 'Payment received — thank you. A receipt is on its way.' };
    else if (st === 'processing') returnBanner = { tone: 'pending', text: 'Payment submitted. Bank transfers take 1–2 business days to clear; this invoice updates automatically once it settles.' };
    else if (st === 'requires_payment_method' || st === 'canceled') returnBanner = { tone: 'fail', text: 'That payment didn’t go through. You can try again below.' };
    else if (searchParams.redirect_status === 'processing') returnBanner = { tone: 'pending', text: 'Payment submitted and processing. This invoice will update automatically once it clears.' };
  }

  const provider: PaymentProviderId = 'STRIPE';
  const methods = resolvePaymentMethods({ invoice: doc.payment_methods_allowed ?? null }, provider);
  const surcharge = resolveSurchargeEnabled({ invoice: doc.card_surcharge_enabled ?? null });
  const online = onlineMethods(methods);

  const accent = doc.template?.accent_color || '#10b981';
  const onAccent = readable(accent);
  const paid = doc.status === 'PAID' || doc.balance_cents <= 0;
  const overdue = !paid && new Date(doc.due_date + 'T00:00:00') < new Date();
  const statusLabel = paid ? 'Paid' : overdue ? 'Overdue' : doc.status === 'SENT' ? 'Amount due' : doc.status;
  const billTo = billToLines(doc.bill_to, doc.customer?.name);

  return (
    <main style={S.wrap}>
      <FontHead />
      <div style={S.sheet}>
        {/* Branded header band */}
        <header style={{ ...S.band, background: accent, color: onAccent }}>
          <div style={S.bandLeft}>
            {doc.template?.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={doc.template.logo_url} alt="" style={S.logo} />
            ) : (
              <div style={{ ...S.logoFallback, color: accent }}>{(doc.entity?.name || 'M').slice(0, 1)}</div>
            )}
            <div>
              <div style={S.bandEntity}>{doc.entity?.name || 'Invoice'}</div>
              <div style={{ ...S.bandSub, color: onAccent, opacity: 0.85 }}>Invoice {doc.invoice_number}</div>
            </div>
          </div>
          <div style={S.bandRight}>
            <div style={{ ...S.bandLabel, color: onAccent, opacity: 0.85 }}>INVOICE</div>
            <div style={S.bandAmount}>{money(doc.total_cents)}</div>
          </div>
        </header>

        <div style={S.body}>
          {returnBanner && (
            <div style={{
              ...S.returnBanner,
              background: returnBanner.tone === 'ok' ? '#ecfdf5' : returnBanner.tone === 'pending' ? '#eff6ff' : '#fef2f2',
              color: returnBanner.tone === 'ok' ? '#15803d' : returnBanner.tone === 'pending' ? '#1d4ed8' : '#b91c1c',
              borderColor: returnBanner.tone === 'ok' ? '#a7f3d0' : returnBanner.tone === 'pending' ? '#bfdbfe' : '#fecaca',
            }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                {returnBanner.tone === 'ok' ? <Check size={16} /> : returnBanner.tone === 'pending' ? <Clock size={16} /> : <AlertTriangle size={16} />}
                <span>{returnBanner.text}</span>
              </span>
            </div>
          )}
          {/* Hero: balance + primary pay action */}
          <section style={S.hero}>
            <div>
              <div style={{ ...S.heroStatus, color: paid ? '#16a34a' : overdue ? '#dc2626' : '#475569' }}>
                {statusLabel}{!paid && doc.due_date ? ` · due ${fmtDate(doc.due_date)}` : ''}
              </div>
              <div style={S.heroBalance}>{money(doc.balance_cents)}</div>
            </div>
            {/* Token-scoped, not id-scoped: /api/invoices/[id]/pdf is behind Clerk
                and 404s for customers, who never have a session. */}
            <a href={`/api/pay/${doc.public_token}/pdf`} style={S.pdfLink} target="_blank" rel="noreferrer">↓ PDF</a>
          </section>

          {!paid && online.length > 0 && returnBanner?.tone !== 'ok' && (
            <PayNow
              token={doc.public_token}
              accent={accent}
              balanceLabel={money(doc.balance_cents)}
              methods={online}
              surcharge={surcharge}
              surchargePct={3}
              payerName={doc.customer?.name ?? ''}
              payerEmail={doc.customer?.email ?? ''}
            />
          )}
          {!paid && methods.includes('CHECK') && doc.template?.remit_to && (
            <div style={S.remitCard}>
              <div style={S.remitTitle}>Prefer to mail a check?</div>
              <div style={{ whiteSpace: 'pre-line', color: '#475569', fontSize: 13.5, marginTop: 4 }}>{doc.template.remit_to}</div>
            </div>
          )}
          {paid && (
            <div style={{ ...S.paidBanner, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              <Check size={16} /> Paid in full — thank you.
            </div>
          )}

          {/* From / Bill to */}
          <section style={S.parties}>
            <div style={S.party}>
              <div style={S.partyLabel}>From</div>
              <div style={S.partyName}>{doc.entity?.name}</div>
            </div>
            <div style={S.party}>
              <div style={S.partyLabel}>Bill to</div>
              {billTo.map((l, i) => (
                <div key={i} style={i === 0 ? S.partyName : S.partyLine}>{l}</div>
              ))}
            </div>
            <div style={S.party}>
              <div style={S.partyLabel}>Details</div>
              <div style={S.metaRow}><span style={S.metaK}>Issued</span><span>{fmtDate(doc.invoice_date)}</span></div>
              <div style={S.metaRow}><span style={S.metaK}>Due</span><span>{fmtDate(doc.due_date)}</span></div>
              {doc.terms && <div style={S.metaRow}><span style={S.metaK}>Terms</span><span>{doc.terms}</span></div>}
            </div>
          </section>

          {/* Line items */}
          <table style={S.table}>
            <thead>
              <tr>
                <th style={{ ...S.th, textAlign: 'left' }}>Description</th>
                <th style={S.th}>Qty</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Rate</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {doc.lines.map((l, i) => (
                <tr key={i} style={S.tr}>
                  <td style={S.tdDesc}>{l.description}</td>
                  <td style={{ ...S.td, textAlign: 'center' }}>{l.quantity}</td>
                  <td style={{ ...S.td, textAlign: 'right', fontFamily: MONO }}>{money(l.unit_price_cents)}</td>
                  <td style={{ ...S.td, textAlign: 'right', fontFamily: MONO }}>{money(l.amount_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={S.totals}>
            <Row label="Subtotal" value={money(doc.subtotal_cents)} />
            {doc.discount_cents > 0 && <Row label="Discount" value={`-${money(doc.discount_cents)}`} />}
            {doc.tax_cents > 0 && <Row label="Tax" value={money(doc.tax_cents)} />}
            {doc.retainage_cents > 0 && <Row label="Retainage withheld" value={`-${money(doc.retainage_cents)}`} />}
            <Row label="Total" value={money(doc.total_cents)} bold accent={accent} />
            {doc.amount_paid_cents > 0 && <Row label="Paid" value={`-${money(doc.amount_paid_cents)}`} />}
            {doc.amount_paid_cents > 0 && <Row label="Balance due" value={money(doc.balance_cents)} bold accent={accent} />}
          </div>

          {doc.customer_message && <p style={S.message}>{doc.customer_message}</p>}
          <footer style={S.footer}>{doc.template?.footer_text || `${doc.entity?.name ?? ''} · ${doc.invoice_number}`}</footer>
        </div>
      </div>
      <div style={S.poweredBy}>Secure payments powered by Stripe</div>
    </main>
  );
}

function Row({ label, value, bold, accent }: { label: string; value: string; bold?: boolean; accent?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: bold ? '8px 0' : '4px 0', fontWeight: bold ? 700 : 400, borderTop: bold ? `2px solid ${accent || '#0f172a'}` : 'none', marginTop: bold ? 4 : 0 }}>
      <span style={{ color: bold ? '#0f172a' : '#64748b', fontSize: bold ? 15 : 13.5 }}>{label}</span>
      <span style={{ fontFamily: MONO, color: bold ? (accent || '#0f172a') : '#334155', fontSize: bold ? 16 : 13.5 }}>{value}</span>
    </div>
  );
}

function FontHead() {
  return (
    <style dangerouslySetInnerHTML={{ __html: `
      @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');
      * { box-sizing: border-box; }
      body { margin: 0; }
    ` }} />
  );
}

const SANS = "'Plus Jakarta Sans', system-ui, -apple-system, Segoe UI, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

const S: Record<string, React.CSSProperties> = {
  wrap: { minHeight: '100vh', background: '#f1f5f9', padding: '40px 16px', fontFamily: SANS, color: '#0f172a' },
  sheet: { maxWidth: 760, margin: '0 auto', background: '#fff', borderRadius: 16, overflow: 'hidden', boxShadow: '0 10px 40px rgba(15,23,42,0.10)' },
  band: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '28px 36px' },
  bandLeft: { display: 'flex', alignItems: 'center', gap: 16 },
  logo: { height: 48, maxWidth: 170, objectFit: 'contain', background: '#fff', borderRadius: 8, padding: 6 },
  logoFallback: { height: 48, width: 48, borderRadius: 10, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 22 },
  bandEntity: { fontSize: 19, fontWeight: 700, letterSpacing: -0.2 },
  bandSub: { fontSize: 13, fontFamily: MONO, marginTop: 2 },
  bandRight: { textAlign: 'right' },
  bandLabel: { fontSize: 11, fontWeight: 600, letterSpacing: 1.5 },
  bandAmount: { fontSize: 24, fontWeight: 800, fontFamily: MONO, marginTop: 2 },
  body: { padding: 36 },
  returnBanner: { padding: '14px 16px', borderRadius: 12, border: '1px solid', fontSize: 14, fontWeight: 600, lineHeight: 1.5, marginBottom: 22 },
  hero: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', paddingBottom: 22, marginBottom: 22, borderBottom: '1px solid #eef2f7' },
  heroStatus: { fontSize: 13, fontWeight: 600, textTransform: 'capitalize' },
  heroBalance: { fontSize: 38, fontWeight: 800, fontFamily: MONO, letterSpacing: -1, marginTop: 4 },
  pdfLink: { fontSize: 13, fontWeight: 600, color: '#475569', textDecoration: 'none', border: '1px solid #e2e8f0', borderRadius: 8, padding: '8px 14px' },
  remitCard: { border: '1px solid #e2e8f0', borderRadius: 12, padding: 16, marginBottom: 24 },
  remitTitle: { fontWeight: 600, fontSize: 14 },
  paidBanner: { padding: 16, borderRadius: 12, background: '#ecfdf5', color: '#16a34a', textAlign: 'center', fontWeight: 700, marginBottom: 24 },
  parties: { display: 'flex', gap: 28, flexWrap: 'wrap', marginBottom: 28 },
  party: { flex: '1 1 180px', minWidth: 160 },
  partyLabel: { fontSize: 11, fontWeight: 700, letterSpacing: 1, color: '#94a3b8', textTransform: 'uppercase', marginBottom: 6 },
  partyName: { fontSize: 14.5, fontWeight: 600, color: '#0f172a' },
  partyLine: { fontSize: 13.5, color: '#475569', marginTop: 2 },
  metaRow: { display: 'flex', justifyContent: 'space-between', fontSize: 13.5, color: '#475569', padding: '2px 0' },
  metaK: { color: '#94a3b8' },
  table: { width: '100%', borderCollapse: 'collapse', marginBottom: 12 },
  th: { fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6, padding: '0 8px 10px', textAlign: 'center', color: '#94a3b8', borderBottom: '2px solid #eef2f7', fontWeight: 700 },
  tr: { borderBottom: '1px solid #f1f5f9' },
  tdDesc: { padding: '12px 8px', fontSize: 14, fontWeight: 500, color: '#0f172a' },
  td: { padding: '12px 8px', fontSize: 14, color: '#334155' },
  totals: { maxWidth: 300, marginLeft: 'auto', marginTop: 12 },
  message: { marginTop: 28, paddingTop: 18, borderTop: '1px solid #eef2f7', color: '#475569', fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-line' },
  footer: { marginTop: 24, paddingTop: 16, borderTop: '1px solid #eef2f7', textAlign: 'center', color: '#94a3b8', fontSize: 12.5 },
  poweredBy: { textAlign: 'center', color: '#94a3b8', fontSize: 12, marginTop: 20 },
  notFoundWrap: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f1f5f9', fontFamily: SANS },
  notFoundCard: { background: '#fff', padding: 44, borderRadius: 16, textAlign: 'center', maxWidth: 440, boxShadow: '0 10px 40px rgba(15,23,42,0.10)' },
  notFoundTitle: { fontSize: 20, marginBottom: 8 },
  muted: { color: '#94a3b8', fontSize: 13.5, lineHeight: 1.5 },
};
