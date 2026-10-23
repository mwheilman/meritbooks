export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import type { CSSProperties } from 'react';
import { InlineNotice, Status } from '@meritbooks/merit-ui';
import { createAdminSupabase } from '@/lib/supabase/server';
import { loadInvoiceDocByToken } from '@/lib/invoices/invoice-doc';
import { recordInvoiceEvent } from '@/lib/invoices/invoice-events';
import { resolveSurchargeEnabled } from '@/lib/invoices/resolve-payment-methods';
import { buildLineTable } from '@/lib/invoices/templates/columns';
import { getPaymentIntentStatus } from '@/lib/money/providers/stripe';
import { loadInvoicePaymentTerms } from '@/lib/money/payment-terms';
import { resolveMerchantFeeSchedule } from '@/lib/money/fees';
import { PayNow } from './pay-now';
import './pay.css';

/**
 * Hosted customer invoice view — public, tokenized, no login (merit-ui, Slice 1B).
 * The issuing company's branding (logo, brand colour) on the Merit kit: square
 * geometry, hairline rules, DM Sans, tabular figures. The line table follows the
 * invoice's design template (same columns as the PDF), and NO internal GL account
 * numbers or codes ever appear. Pay Now shows only when the invoice can really be
 * paid online (pay-link.ts); otherwise the template's payment instructions do.
 * Opening records a VIEWED event for the issuer's open tracking.
 */

export const metadata = { title: 'Invoice', robots: { index: false, follow: false } };

const money = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const fmtDate = (d: string) =>
  d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '';

function onColor(hex: string): string {
  const h = hex.replace('#', '');
  if (h.length !== 6) return '#FFFFFF';
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#0A1628' : '#FFFFFF';
}

function addressLines(bill: Record<string, unknown> | null): string[] {
  const out: string[] = [];
  if (bill) {
    for (const k of ['attn', 'line1', 'line2', 'street', 'city_state_zip', 'city', 'state', 'zip']) {
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
      <main className="mb-pay">
        <div className="mb-pay-missing">
          <h1 className="t-section">Invoice not found</h1>
          <p className="t-body" style={{ color: 'var(--ink-2)', marginTop: 8 }}>
            This link may have expired or is incorrect. Contact the business that sent it for an updated link.
          </p>
        </div>
      </main>
    );
  }

  const { doc, orgId } = loaded;
  await recordInvoiceEvent(supabase, { orgId, invoiceId: doc.id, type: 'VIEWED', actor: 'customer' });

  // Back from Stripe: resolve the real outcome so the customer sees a clear confirmation.
  let returnBanner: { tone: 'info' | 'warn' | 'neg'; title: string; text: string } | null = null;
  if (searchParams?.payment_intent) {
    const st = await getPaymentIntentStatus(searchParams.payment_intent);
    if (st === 'succeeded') returnBanner = { tone: 'info', title: 'Payment received. Thank you.', text: 'A receipt is on its way.' };
    else if (st === 'processing' || searchParams.redirect_status === 'processing') {
      returnBanner = { tone: 'info', title: 'Payment submitted.', text: 'Bank transfers take 1–2 business days to clear. This invoice updates automatically once it settles.' };
    } else if (st === 'requires_payment_method' || st === 'canceled') {
      returnBanner = { tone: 'neg', title: 'That payment didn’t go through.', text: 'You can try again below.' };
    }
  }

  const t = doc.template;
  const brand = t.accent_color;
  const vars = { '--brand': brand, '--on-brand': onColor(brand) } as CSSProperties;
  const paid = doc.status === 'PAID' || doc.balance_cents <= 0;
  const closed = doc.status === 'VOIDED' || doc.status === 'WRITTEN_OFF';
  const overdue = !paid && !closed && new Date(doc.due_date + 'T00:00:00') < new Date();
  // Company / customer / job payment settings (slice 1A) decide which online methods show
  // and whether the card fee is passed through; the % comes from the merchant fee schedule.
  const { data: invRow } = await supabase
    .from('invoices')
    .select('org_id, location_id, customer_id, job_id, payment_methods_allowed, card_surcharge_enabled')
    .eq('org_id', orgId)
    .eq('id', doc.id)
    .maybeSingle<{
      org_id: string; location_id: string | null; customer_id: string | null; job_id: string | null;
      payment_methods_allowed: string[] | null; card_surcharge_enabled: boolean | null;
    }>();
  const terms = invRow ? await loadInvoicePaymentTerms(supabase, invRow) : null;
  const feeSchedule = await resolveMerchantFeeSchedule(supabase, orgId).catch(() => null);
  const surcharge = terms ? terms.cardPassThrough : resolveSurchargeEnabled({ invoice: doc.card_surcharge_enabled ?? null });
  const surchargePct = feeSchedule ? feeSchedule.cardFeeBps / 100 : 3;
  const onlineMethods = terms
    ? doc.pay.methods.filter((m) => (terms.online as string[]).includes(m))
    : doc.pay.methods;
  const canPayOnline = doc.pay.payable && onlineMethods.length > 0 && t.show_pay_button && returnBanner?.title !== 'Payment received. Thank you.';
  const table = buildLineTable(doc.lines, t, { jobLabel: doc.job_label });
  const billTo = addressLines(doc.bill_to);
  const headerFields = t.custom_fields.filter((f) => f.placement === 'HEADER' && f.value.trim());
  const footerFields = t.custom_fields.filter((f) => f.placement === 'FOOTER' && f.value.trim());

  return (
    <main className="mb-pay" style={vars}>
      <div className="mb-pay-sheet">
        <header className="mb-pay-head">
          <div className="mb-pay-brand">
            {t.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={t.logo_url} alt={doc.entity?.name ?? ''} className="mb-pay-logo" />
            ) : (
              <div className="mb-pay-mark" aria-hidden="true">{(doc.entity?.name || 'I').slice(0, 1)}</div>
            )}
            <div style={{ minWidth: 0 }}>
              <div className="mb-pay-co">{doc.entity?.name}</div>
              <div className="t-cap">Invoice {doc.invoice_number}</div>
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="mb-pay-kicker">Invoice</div>
            <a className="btn" href={`/api/pay/${doc.public_token}/pdf`} target="_blank" rel="noreferrer" style={{ marginTop: 8 }}>
              Download PDF
            </a>
          </div>
        </header>

        <div className="mb-pay-body">
          {returnBanner && (
            <div className="mb-pay-banner">
              <InlineNotice tone={returnBanner.tone} title={returnBanner.title}>{returnBanner.text}</InlineNotice>
            </div>
          )}

          <section className="mb-pay-hero" aria-label="Amount due">
            <div>
              {paid ? <Status kind="ready">Paid in full</Status>
                : closed ? <Status kind="track" pip="closed">{doc.status === 'VOIDED' ? 'Voided' : 'Closed'}</Status>
                : overdue ? <Status kind="overdue">Overdue · was due {fmtDate(doc.due_date)}</Status>
                : <Status kind="track" pip="open">Due {fmtDate(doc.due_date)}</Status>}
              <div className="mb-pay-balance">{money(paid ? 0 : doc.balance_cents)}</div>
            </div>
            <div className="t-cap" style={{ textAlign: 'right' }}>
              Total {money(doc.total_cents)}{doc.amount_paid_cents > 0 ? <><br />Paid {money(doc.amount_paid_cents)}</> : null}
            </div>
          </section>

          {!paid && !closed && canPayOnline && (
            <PayNow
              token={doc.public_token}
              accent={brand}
              balanceLabel={money(doc.balance_cents)}
              methods={onlineMethods}
              surcharge={surcharge}
              surchargePct={surchargePct}
              payerName={doc.customer?.name ?? ''}
              payerEmail={doc.customer?.email ?? ''}
              testMode={doc.pay.mode === 'test'}
            />
          )}

          {!paid && !closed && (t.payment_instructions || (!canPayOnline && t.remit_to)) && (
            <div className="mb-pay-box">
              <h2>{canPayOnline ? 'Other ways to pay' : 'How to pay'}</h2>
              <div style={{ whiteSpace: 'pre-line', color: 'var(--ink-2)' }}>
                {t.payment_instructions ?? `Mail a check to:\n${t.remit_to}`}
              </div>
            </div>
          )}

          <section className="mb-pay-parties">
            <div className="mb-pay-party">
              <span className="t-cap">From</span>
              <b>{doc.entity?.name}</b>
              {t.remit_to?.split('\n').map((l, i) => <span key={i}>{l}</span>)}
            </div>
            <div className="mb-pay-party">
              <span className="t-cap">Bill to</span>
              <b>{doc.customer?.name}</b>
              {billTo.map((l, i) => <span key={i}>{l}</span>)}
            </div>
            <div className="mb-pay-party">
              <span className="t-cap">Details</span>
              <div className="mb-pay-kv"><span>Issued</span><span>{fmtDate(doc.invoice_date)}</span></div>
              <div className="mb-pay-kv"><span>Due</span><span>{fmtDate(doc.due_date)}</span></div>
              {doc.terms_label && <div className="mb-pay-kv"><span>Terms</span><span>{doc.terms_label}</span></div>}
              {doc.po_number && <div className="mb-pay-kv"><span>PO</span><span>{doc.po_number}</span></div>}
              {headerFields.map((f, i) => <div key={i} className="mb-pay-kv"><span>{f.label}</span><span>{f.value}</span></div>)}
            </div>
          </section>

          <div className="mb-pay-tablewrap">
            <table className="mb-pay-table">
              <thead>
                <tr>{table.columns.map((c) => <th key={c.key} className={c.align === 'right' ? 'r' : undefined}>{c.label}</th>)}</tr>
              </thead>
              <tbody>
                {table.rows.map((r, i) => (
                  <tr key={i}>{table.columns.map((c) => <td key={c.key} className={c.align === 'right' ? 'r' : undefined}>{r.cells[c.key]}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mb-pay-totals">
            <div><span>Subtotal</span><span>{money(doc.subtotal_cents)}</span></div>
            {doc.discount_cents > 0 && <div><span>Discount</span><span>-{money(doc.discount_cents)}</span></div>}
            {doc.tax_cents > 0 && <div><span>Sales tax</span><span>{money(doc.tax_cents)}</span></div>}
            {doc.retainage_cents > 0 && <div><span>Retainage withheld</span><span>-{money(doc.retainage_cents)}</span></div>}
            <div className="grand"><span>Total</span><span>{money(doc.total_cents)}</span></div>
            {doc.amount_paid_cents > 0 && <div><span>Paid</span><span>-{money(doc.amount_paid_cents)}</span></div>}
            {doc.amount_paid_cents > 0 && <div className="grand"><span>Balance due</span><span>{money(doc.balance_cents)}</span></div>}
          </div>

          {t.terms_text && (
            <div className="mb-pay-block"><span className="t-cap">Terms</span>{t.terms_text}</div>
          )}
          {doc.customer_message && <div className="mb-pay-block">{doc.customer_message}</div>}

          <footer className="mb-pay-foot">
            {footerFields.length > 0 && <div>{footerFields.map((f) => `${f.label}: ${f.value}`).join(' · ')}</div>}
            <div>{t.footer_text || `${doc.entity?.name ?? ''} · Invoice ${doc.invoice_number}`}</div>
          </footer>
        </div>
      </div>
      {canPayOnline && <div className="mb-pay-powered">Secure payments by Stripe</div>}
    </main>
  );
}
