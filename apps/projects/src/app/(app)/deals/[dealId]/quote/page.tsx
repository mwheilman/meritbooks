import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { ButtonLink, Page, money, pct, shortDate } from '@meritbooks/merit-ui';
import { dealerScope } from '@/lib/pm/dealer/scope';
import { loadDealWorkspace } from '@/lib/pm/dealer/deal-queries';
import { FI_WORDS, LINE_TYPE_WORDS } from '@/lib/pm/dealer/labels';
import type { DealLineType, DealTotals, FiProductType } from '@/lib/pm/dealer/types';
import { todayIso } from '@/lib/time';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { PrintButton } from '@/components/dealer/deals/PrintButton';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Quote' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PrintLine { type: DealLineType; description: string; qty: number; price: number; amount: number }

/** A printable quote: the issued version the customer signs, or the live deal when none is issued yet. */
export default async function QuotePage({ params, searchParams }: { params: { dealId: string }; searchParams: { q?: string } }) {
  if (!UUID.test(params.dealId)) notFound();
  const o = await dealerScope();
  if (!o) return null;
  const { money: mv } = await guardPage('/deals');
  // A quote is the customer's prices: contract_value only.
  if (!mv.contract) redirect(`/deals/${params.dealId}`);
  const w = await loadDealWorkspace(o.db, params.dealId);
  if (!w || !o.companyIds.includes(w.deal.location_id)) notFound();
  const today = todayIso();
  const quote = (searchParams.q && w.quotes.find((q) => q.id === searchParams.q)) || w.quotes.find((q) => q.status === 'ISSUED' || q.status === 'ACCEPTED') || null;
  const lines: PrintLine[] = quote?.snapshot.lines
    ? quote.snapshot.lines.map((l) => ({ type: l.line_type, description: l.description, qty: Number(l.qty), price: Number(l.unit_price_cents), amount: Number(l.amount_cents) }))
    : w.lines.map((l) => ({ type: l.line_type, description: l.description, qty: l.qty, price: l.unit_price_cents, amount: l.amount_cents }));
  const trades = quote?.snapshot.trades
    ? quote.snapshot.trades.map((t) => ({ title: [t.model_year, t.make, t.model].filter(Boolean).join(' ') || 'Trade-in', serial: t.serial_number, allowance: Number(t.allowance_cents), payoff: Number(t.payoff_cents) }))
    : w.trades.filter((t) => t.status !== 'VOID').map((t) => ({ title: [t.model_year, t.make, t.model].filter(Boolean).join(' ') || 'Trade-in', serial: t.serial_number, allowance: t.allowance_cents, payoff: t.payoff_cents }));
  const fi = quote?.snapshot.fi_products
    ? quote.snapshot.fi_products.map((f) => ({ type: f.product_type as FiProductType, description: f.description, price: Number(f.price_cents), term: f.term_months }))
    : w.fi.map((f) => ({ type: f.product_type, description: f.description, price: f.price_cents, term: f.term_months }));
  const t: DealTotals = quote?.totals ?? w.totals;
  const company = o.companyName(w.deal.location_id) ?? '';
  const sign = (type: DealLineType) => (type === 'DISCOUNT' || type === 'REBATE' ? -1 : 1);
  const shown = lines.filter((l) => l.type !== 'INCENTIVE');

  return (
    <>
      <PageCrumbs items={[{ label: 'Deals', href: '/deals' }, { label: w.deal.number, href: `/deals/${w.deal.id}` }, { label: 'Quote' }]} />
      <Page>
        <div className="row dl-noprint" style={{ gap: 8, marginBottom: 16 }}>
          <PrintButton label="Print the quote" />
          <ButtonLink variant="quiet" href={`/deals/${w.deal.id}`}>Back to the desk</ButtonLink>
          {!quote && <span className="t-cap">No quote issued yet; this prints the deal as it stands.</span>}
        </div>
        <article className="dl-quote" aria-label="Quote">
          <div className="hd">
            <div>
              <h1>Quote</h1>
              <p className="b" style={{ marginTop: 8 }}>{company}</p>
            </div>
            <div style={{ textAlign: 'right' }}>
              <p className="b">{quote ? `${quote.number} · version ${quote.version}` : w.deal.number}</p>
              <p className="t-cap">Issued {shortDate((quote?.issued_at ?? new Date().toISOString()).slice(0, 10))}</p>
              {quote?.valid_until && <p className="t-cap">Good until {shortDate(quote.valid_until, today)}</p>}
            </div>
          </div>
          <p><span className="t-cap">Prepared for</span><br /><b>{w.customer ?? 'Customer'}</b></p>

          <table className="dl-tbl" style={{ marginTop: 16 }}>
            <thead><tr><th>Item</th><th className="n">Qty</th><th className="n">Price</th><th className="n">Amount</th></tr></thead>
            <tbody>
              {shown.map((l, i) => (
                <tr key={i}>
                  <td><span className="l1">{l.description || LINE_TYPE_WORDS[l.type]}</span>{l.type !== 'UNIT' && <span className="l2">{LINE_TYPE_WORDS[l.type]}</span>}</td>
                  <td className="n">{l.qty}</td>
                  <td className="n">{money(l.price)}</td>
                  <td className="n">{money(sign(l.type) * l.amount)}</td>
                </tr>
              ))}
              {fi.map((f, i) => (
                <tr key={`fi${i}`}>
                  <td><span className="l1">{f.description || FI_WORDS[f.type]}</span><span className="l2">{FI_WORDS[f.type]}{f.term ? `, ${f.term} months` : ''}</span></td>
                  <td className="n">1</td><td className="n">{money(f.price)}</td><td className="n">{money(f.price)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {trades.length > 0 && (
            <table className="dl-tbl" style={{ marginTop: 16 }}>
              <thead><tr><th>Trade-in</th><th className="n">Allowance</th><th className="n">Payoff</th></tr></thead>
              <tbody>{trades.map((tr, i) => <tr key={i}><td><span className="l1">{tr.title}</span>{tr.serial && <span className="l2">S/N {tr.serial}</span>}</td><td className="n">{money(tr.allowance)}</td><td className="n">{tr.payoff ? money(tr.payoff) : '—'}</td></tr>)}</tbody>
            </table>
          )}

          <table className="dl-tbl" style={{ marginTop: 16, maxWidth: 420, marginLeft: 'auto' }}>
            <tbody>
              <tr><td>Sale price</td><td className="n">{money(t.sale_price_cents)}</td></tr>
              {t.fees_cents > 0 && <tr><td>Fees</td><td className="n">{money(t.fees_cents)}</td></tr>}
              {t.fi_price_cents > 0 && <tr><td>Protection products</td><td className="n">{money(t.fi_price_cents)}</td></tr>}
              <tr><td>{t.tax_exempt ? 'Sales tax (exempt)' : `Sales tax, estimated${t.tax_rate_estimate != null ? ` at ${pct(Number(t.tax_rate_estimate), { decimals: 2 })}` : ''}`}<span className="l2">Merit Books calculates the final tax</span></td><td className="n">{money(t.tax_estimate_cents)}</td></tr>
              {t.rebates_cents > 0 && <tr><td>Manufacturer rebates</td><td className="n">{money(-t.rebates_cents)}</td></tr>}
              <tr className="sub"><td>Cash price</td><td className="n">{money(t.cash_price_cents)}</td></tr>
              {t.trade_allowance_cents > 0 && <tr><td>Trade allowance</td><td className="n">{money(-t.trade_allowance_cents)}</td></tr>}
              {t.trade_payoff_cents > 0 && <tr><td>Payoff on the trade</td><td className="n">{money(t.trade_payoff_cents)}</td></tr>}
              {t.deposits_cents > 0 && <tr><td>Deposits</td><td className="n">{money(-t.deposits_cents)}</td></tr>}
            </tbody>
            <tfoot><tr><td>Balance due</td><td className="n">{money(t.balance_due_estimate_cents)}</td></tr></tfoot>
          </table>

          <p className="t-cap" style={{ marginTop: 16 }}>Prices good until the date above. Taxes and fees are estimated and are finalized on the invoice.</p>
          <div className="sig"><div>Customer signature and date</div><div>Salesperson</div></div>
        </article>
      </Page>
    </>
  );
}
