export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { Check, Clock, FileText, ArrowRight } from 'lucide-react';
import { createAdminSupabase } from '@/lib/supabase/server';
import { resolvePortalToken } from '@/lib/portal/customer/tokens';
import { loadCustomerPortal, type PortalInvoice } from '@/lib/portal/customer/data';

/**
 * CUSTOMER SELF-SERVICE PORTAL — public, tokenized, no login. A customer opens
 * /portal/customer/<token> and sees ALL of their invoices (open + paid), their
 * account balance, and can pay any open invoice or download a statement.
 *
 * SECURITY (public route): the token is validated server-side with the SERVICE-ROLE
 * client (resolvePortalToken), which resolves org_id + customer_id and rejects
 * revoked/expired tokens. loadCustomerPortal then narrows every read to BOTH that
 * org_id AND customer_id — the visitor never gets a tenant session and can't reach
 * another customer's or tenant's data. Payment reuses the EXISTING /pay/<invoice
 * token> flow (no new money path). Money is bigint cents; formatted once here.
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

const STATUS_LABEL: Record<string, string> = {
  SENT: 'Open', OVERDUE: 'Overdue', PARTIALLY_PAID: 'Partially paid',
  PAID: 'Paid', DRAFT: 'Draft', WRITTEN_OFF: 'Written off',
};

export default async function CustomerPortalPage({ params }: { params: { token: string } }) {
  const admin = createAdminSupabase();
  const resolved = await resolvePortalToken(admin, params.token);

  if (!resolved) {
    return (
      <main style={S.centerWrap}>
        <FontHead />
        <div style={S.centerCard}>
          <h1 style={S.centerTitle}>This link is no longer valid</h1>
          <p style={S.muted}>
            The access link you used has expired or been turned off. Please contact
            the business that sent it to you for an updated link.
          </p>
        </div>
      </main>
    );
  }

  const data = await loadCustomerPortal(admin, resolved.orgId, resolved.customerId);
  if (!data) {
    return (
      <main style={S.centerWrap}>
        <FontHead />
        <div style={S.centerCard}>
          <h1 style={S.centerTitle}>Account unavailable</h1>
          <p style={S.muted}>We couldn&apos;t load this account. Please contact the business that sent you this link.</p>
        </div>
      </main>
    );
  }

  const accent = data.branding.accentColor || '#10b981';
  const onAccent = readable(accent);
  const openInvoices = data.invoices.filter((i) => i.isOpen);
  const historyInvoices = data.invoices.filter((i) => !i.isOpen);
  const statementHref = `/api/portal/customer/${params.token}/statement`;

  return (
    <main style={S.wrap}>
      <FontHead />
      <div style={S.sheet}>
        {/* Branded header band */}
        <header style={{ ...S.band, background: accent, color: onAccent }}>
          <div style={S.bandLeft}>
            {data.branding.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={data.branding.logoUrl} alt="" style={S.logo} />
            ) : (
              <div style={{ ...S.logoFallback, color: accent }}>{(data.entity?.name || 'M').slice(0, 1)}</div>
            )}
            <div>
              <h1 style={S.bandEntity}>{data.entity?.name || 'Customer portal'}</h1>
              <div style={{ ...S.bandSub, color: onAccent, opacity: 0.85 }}>Account for {data.customer.name}</div>
            </div>
          </div>
          <div style={S.bandRight}>
            <div style={{ ...S.bandLabel, color: onAccent, opacity: 0.85 }}>BALANCE DUE</div>
            <div style={S.bandAmount}>{money(data.totalBalanceCents)}</div>
          </div>
        </header>

        <div style={S.body}>
          {/* Summary strip */}
          <section style={S.summary}>
            <SummaryTile label="Balance due" value={money(data.totalBalanceCents)} tone={data.totalBalanceCents > 0 ? '#0f172a' : '#16a34a'} />
            <SummaryTile label="Open invoices" value={String(data.openInvoiceCount)} tone="#0f172a" />
            <SummaryTile label="Paid to date" value={String(data.paidInvoiceCount)} tone="#0f172a" />
            <div style={{ ...S.summaryTile, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <a
                href={statementHref}
                target="_blank"
                rel="noreferrer"
                className="mb-statement-btn"
                aria-label="Download account statement (opens in a new tab)"
                style={{ ...S.statementBtn, borderColor: accent, color: accent }}
              >
                <FileText size={14} aria-hidden="true" /> Download statement
              </a>
            </div>
          </section>

          {/* Open invoices */}
          <section style={{ marginBottom: 28 }}>
            <h2 style={S.sectionTitle}>Open invoices</h2>
            {openInvoices.length === 0 ? (
              <div style={S.emptyCard}>
                <Check size={18} style={{ color: '#16a34a' }} />
                <div>
                  <div style={{ fontWeight: 700, color: '#0f172a' }}>You&apos;re all paid up</div>
                  <div style={S.muted}>There are no open invoices on your account right now.</div>
                </div>
              </div>
            ) : (
              <div style={S.list}>
                {openInvoices.map((inv) => (
                  <InvoiceRow key={inv.id} inv={inv} accent={accent} onAccent={onAccent} />
                ))}
              </div>
            )}
          </section>

          {/* Paid / history */}
          {historyInvoices.length > 0 && (
            <section>
              <h2 style={S.sectionTitle}>Invoice history</h2>
              <div style={{ overflowX: 'auto' }}>
                <table style={S.table}>
                  <thead>
                    <tr>
                      <th scope="col" style={{ ...S.th, textAlign: 'left' }}>Invoice</th>
                      <th scope="col" style={S.th}>Date</th>
                      <th scope="col" style={S.th}>Status</th>
                      <th scope="col" style={{ ...S.th, textAlign: 'right' }}>Amount</th>
                      <th scope="col" style={{ ...S.th, textAlign: 'right' }}>Balance</th>
                      <th scope="col" style={S.th}>
                        <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>View</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyInvoices.map((inv) => (
                      <tr key={inv.id} style={S.tr}>
                        <td style={S.tdMono}>{inv.invoiceNumber}</td>
                        <td style={{ ...S.td, textAlign: 'center' }}>{fmtDate(inv.invoiceDate)}</td>
                        <td style={{ ...S.td, textAlign: 'center' }}>
                          <span style={{ ...S.badge, color: inv.status === 'PAID' || inv.balanceCents <= 0 ? '#16a34a' : '#475569', background: inv.status === 'PAID' || inv.balanceCents <= 0 ? '#dcfce7' : '#f1f5f9' }}>
                            {STATUS_LABEL[inv.status] ?? inv.status}
                          </span>
                        </td>
                        <td style={{ ...S.tdMono, textAlign: 'right' }}>{money(inv.totalCents)}</td>
                        <td style={{ ...S.tdMono, textAlign: 'right' }}>{money(inv.balanceCents)}</td>
                        <td style={{ ...S.td, textAlign: 'right' }}>
                          {inv.payToken ? (
                            <a
                              href={`/pay/${inv.payToken}`}
                              className="mb-view-link"
                              aria-label={`View invoice ${inv.invoiceNumber} (opens in a new tab)`}
                              style={{ ...S.viewLink, color: accent }}
                              target="_blank"
                              rel="noreferrer"
                            >
                              View
                            </a>
                          ) : (
                            <span style={{ color: '#cbd5e1' }} aria-hidden="true">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <footer style={S.footer}>
            {data.entity?.name ? `${data.entity.name} · ` : ''}Statement as of {fmtDate(data.asOf)} · Secure payments powered by Stripe
          </footer>
        </div>
      </div>
    </main>
  );
}

function SummaryTile({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div style={S.summaryTile}>
      <div style={S.summaryLabel}>{label}</div>
      <div style={{ ...S.summaryValue, color: tone }}>{value}</div>
    </div>
  );
}

function InvoiceRow({ inv, accent, onAccent }: { inv: PortalInvoice; accent: string; onAccent: string }) {
  return (
    <div style={S.invoiceRow}>
      <div style={{ minWidth: 0 }}>
        <div style={S.invoiceNum}>Invoice {inv.invoiceNumber}</div>
        <div style={S.invoiceMeta}>
          <span>Issued {fmtDate(inv.invoiceDate)}</span>
          <span style={{ color: inv.overdue ? '#dc2626' : '#64748b' }}>
            {inv.overdue ? 'Overdue · ' : ''}Due {fmtDate(inv.dueDate)}
          </span>
        </div>
      </div>
      <div style={S.invoiceRight}>
        <div style={{ textAlign: 'right' }}>
          <div style={S.invoiceBalance}>{money(inv.balanceCents)}</div>
          {inv.paidCents > 0 && <div style={S.invoiceSub}>of {money(inv.totalCents)}</div>}
        </div>
        {inv.payToken ? (
          <a
            href={`/pay/${inv.payToken}`}
            target="_blank"
            rel="noreferrer"
            className="mb-pay-btn"
            aria-label={`Pay invoice ${inv.invoiceNumber} (opens in a new tab)`}
            style={{ ...S.payBtn, background: accent, color: onAccent }}
          >
            Pay <ArrowRight size={14} aria-hidden="true" />
          </a>
        ) : (
          <span style={{ ...S.payBtn, background: '#f1f5f9', color: '#94a3b8', cursor: 'default' }}>
            <Clock size={13} aria-hidden="true" /> Unavailable
          </span>
        )}
      </div>
    </div>
  );
}

function FontHead() {
  return (
    <style dangerouslySetInnerHTML={{ __html: `
      @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');
      * { box-sizing: border-box; }
      body { margin: 0; }
      a:focus-visible, button:focus-visible { outline: 2px solid #0f172a; outline-offset: 2px; border-radius: 6px; }
      .mb-pay-btn:hover { filter: brightness(0.94); }
      .mb-statement-btn:hover { background: rgba(15,23,42,0.04); }
      .mb-view-link:hover { text-decoration: underline; }
    ` }} />
  );
}

const SANS = "'Plus Jakarta Sans', system-ui, -apple-system, Segoe UI, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

const S: Record<string, React.CSSProperties> = {
  wrap: { minHeight: '100vh', background: '#f1f5f9', padding: '40px 16px', fontFamily: SANS, color: '#0f172a' },
  sheet: { maxWidth: 820, margin: '0 auto', background: '#fff', borderRadius: 16, overflow: 'hidden', boxShadow: '0 10px 40px rgba(15,23,42,0.10)' },
  band: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, padding: '28px 36px', flexWrap: 'wrap' },
  bandLeft: { display: 'flex', alignItems: 'center', gap: 16 },
  logo: { height: 48, maxWidth: 170, objectFit: 'contain', background: '#fff', borderRadius: 8, padding: 6 },
  logoFallback: { height: 48, width: 48, borderRadius: 10, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 22 },
  bandEntity: { fontSize: 19, fontWeight: 700, letterSpacing: -0.2 },
  bandSub: { fontSize: 13, marginTop: 2 },
  bandRight: { textAlign: 'right' },
  bandLabel: { fontSize: 11, fontWeight: 600, letterSpacing: 1.5 },
  bandAmount: { fontSize: 24, fontWeight: 800, fontFamily: MONO, marginTop: 2 },
  body: { padding: 36 },
  summary: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 32 },
  summaryTile: { border: '1px solid #e2e8f0', borderRadius: 12, padding: '14px 16px' },
  summaryLabel: { fontSize: 11, fontWeight: 700, letterSpacing: 1, color: '#94a3b8', textTransform: 'uppercase', marginBottom: 6 },
  summaryValue: { fontSize: 22, fontWeight: 800, fontFamily: MONO, letterSpacing: -0.5, fontVariantNumeric: 'tabular-nums' },
  statementBtn: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, border: '1.5px solid', borderRadius: 10, padding: '10px 12px', fontSize: 13, fontWeight: 700, textDecoration: 'none' },
  sectionTitle: { fontSize: 13, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: '#64748b', marginBottom: 12 },
  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  invoiceRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, border: '1px solid #e2e8f0', borderRadius: 12, padding: '14px 16px', flexWrap: 'wrap' },
  invoiceNum: { fontSize: 15, fontWeight: 700, color: '#0f172a' },
  invoiceMeta: { display: 'flex', gap: 12, fontSize: 12.5, color: '#64748b', marginTop: 3, flexWrap: 'wrap' },
  invoiceRight: { display: 'flex', alignItems: 'center', gap: 16 },
  invoiceBalance: { fontSize: 18, fontWeight: 800, fontFamily: MONO, fontVariantNumeric: 'tabular-nums' },
  invoiceSub: { fontSize: 12, color: '#94a3b8', fontFamily: MONO },
  payBtn: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '10px 18px', borderRadius: 10, fontSize: 14, fontWeight: 700, textDecoration: 'none' },
  emptyCard: { display: 'flex', alignItems: 'center', gap: 12, border: '1px solid #e2e8f0', borderRadius: 12, padding: '18px 20px', background: '#f8fafc' },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: { fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6, padding: '0 8px 10px', textAlign: 'center', color: '#94a3b8', borderBottom: '2px solid #eef2f7', fontWeight: 700 },
  tr: { borderBottom: '1px solid #f1f5f9' },
  td: { padding: '12px 8px', fontSize: 13.5, color: '#334155' },
  tdMono: { padding: '12px 8px', fontSize: 13.5, color: '#334155', fontFamily: MONO, fontVariantNumeric: 'tabular-nums' },
  badge: { fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 999 },
  viewLink: { fontSize: 13, fontWeight: 700, textDecoration: 'none' },
  footer: { marginTop: 28, paddingTop: 18, borderTop: '1px solid #eef2f7', textAlign: 'center', color: '#94a3b8', fontSize: 12.5 },
  centerWrap: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f1f5f9', fontFamily: SANS, padding: 16 },
  centerCard: { background: '#fff', padding: 44, borderRadius: 16, textAlign: 'center', maxWidth: 460, boxShadow: '0 10px 40px rgba(15,23,42,0.10)' },
  centerTitle: { fontSize: 20, marginBottom: 10, color: '#0f172a' },
  muted: { color: '#94a3b8', fontSize: 13.5, lineHeight: 1.55 },
};
