'use client';

/**
 * Deal recap view — GET /api/dealer/deal-detail?id=<saleId>. Left: the recap
 * (customer owes, trade valuation, estimated gross). Right: unit, customer,
 * Books invoice, journal entry, lender payoff, trade-in + lien. DL-11 warnings
 * (over-allowance, lien unpaid) are shown in place.
 */

import { useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowLeft, CheckCircle2, HandCoins } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { LIEN_STATUS, NOTE_STATUS, ROW_STATUS, SALE_SOURCE, TRADE_STATUS, labelOf, toneOf } from '@/lib/dealer/ui/labels';
import { SALE_STATUS } from '@/lib/dealer/ui/unit-deal-labels';
import { dateLabel, money, todayLocal } from '@/lib/dealer/ui/format';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { dealRecap, lienUnpaid } from '@/lib/dealer/ui/deal-math';
import type { DealDetailView, PostSaleResultView } from '@/lib/dealer/ui/unit-deal-types';
import { useDealerPack } from '../../_components/dealer-shell';
import { DefList, Empty, ErrorPanel, Mono, Notice, Pill, Section } from '../../_components/ui';
import { nameOf, useDealerQuery, useNames } from '../../_lib/use-dealer';
import { DealRecapView } from '../_components/deal-recap';
import { DealActions, dealGates } from './deal-actions';

function Skeleton() {
  return (
    <div aria-hidden>
      <div className="mb-6 h-8 w-72 animate-pulse rounded bg-slate-800" />
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="card h-96 animate-pulse" />
        <div className="card h-96 animate-pulse" />
      </div>
    </div>
  );
}

export function DealView({ saleId }: { saleId: string }) {
  const pack = useDealerPack();
  const q = useDealerQuery<DealDetailView>('/api/dealer/deal-detail', { id: saleId });
  const [result, setResult] = useState<PostSaleResultView | null>(null);
  const d = q.data;
  const customers = useNames('customers', [d?.sale.customer_id]);
  const vendors = useNames('vendors', [d?.unit.make_vendor_id, d?.trade?.lienholder_vendor_id, d?.trade?.make_vendor_id]);
  const today = todayLocal();

  if (q.isLoading && !d) return <Skeleton />;
  if (q.error) {
    return (
      <div className="card">
        {q.error.code === 'NOT_FOUND' ? (
          <Empty
            icon={HandCoins}
            title="Deal not found"
            description="This deal doesn’t exist for the selected client — it may belong to another client."
            action={
              <Link href={dealerLinks.deals()} className="btn-secondary btn-sm">
                Back to deals
              </Link>
            }
          />
        ) : (
          <ErrorPanel error={q.error} onRetry={() => void q.refetch()} />
        )}
      </div>
    );
  }
  if (!d || !pack.locationId) return <Skeleton />;

  const { sale, trade, unit, notes, invoice, payoffs } = d;
  const gates = dealGates(d, pack.settings, pack.enabled);
  const posted = sale.status === 'POSTED';
  const unitCost = posted && sale.cogs_cents !== null ? sale.cogs_cents : unit.cost_cents;
  const policy = trade?.valuation_policy ?? pack.settings?.trade_valuation_policy ?? 'LOWER_OF_ACV_AND_ALLOWANCE';
  const warnBps = pack.settings?.over_allowance_warn_bps ?? 2000;
  const recap = dealRecap(
    {
      salePriceCents: sale.sale_price_cents,
      taxCents: sale.tax_cents,
      retailRebateCents: sale.retail_rebate_cents,
      depositAppliedCents: sale.deposit_applied_cents,
      unitCostCents: unitCost,
      trade: trade ? { allowanceCents: trade.allowance_cents, acvCents: trade.acv_cents, lienPayoffCents: trade.lien_payoff_cents } : null,
    },
    policy,
    warnBps,
  );
  const lienClock = trade ? lienUnpaid(trade.lien_status, (sale.posted_at ?? sale.sale_date).slice(0, 10), today, pack.settings?.lien_unpaid_days ?? 10) : null;
  const note = notes.find((n) => n.status === 'SOLD_UNPAID' || n.status === 'OPEN' || n.status === 'IN_DEFAULT') ?? notes[notes.length - 1] ?? null;
  const payoff = payoffs.filter((p) => p.status !== 'VOID').slice(-1)[0] ?? null;
  const unitTitle = [nameOf(vendors, unit.make_vendor_id, ''), unit.model, unit.model_year].filter(Boolean).join(' ');

  return (
    <div>
      <PageHeader
        title={`Deal — unit ${unit.serial_number}`}
        breadcrumbs={[{ label: 'Deals & trade-ins', href: dealerLinks.deals() }, { label: unit.serial_number }]}
        actions={<DealActions detail={d} settings={pack.settings} enabled={pack.enabled} locationId={pack.locationId} onDone={() => void q.refetch()} onPosted={setResult} />}
      />

      {result && (
        <Notice
          tone={result.warnings.length > 0 ? 'warning' : 'info'}
          action={
            <div className="flex flex-wrap gap-3 text-xs font-medium">
              {result.invoiceId && (
                <Link href={`/invoices?id=${result.invoiceId}`} className="text-slate-200 hover:text-white">
                  Open invoice →
                </Link>
              )}
              <Link href={dealerLinks.journalEntry(result.glEntryId)} className="text-slate-200 hover:text-white">
                View entry →
              </Link>
              {result.payoffProposalId && (
                <Link href={dealerLinks.floorPlan('payoffs')} className="text-slate-200 hover:text-white">
                  Release the payoff →
                </Link>
              )}
              {result.usedUnitId && (
                <Link href={dealerLinks.unit(result.usedUnitId)} className="text-slate-200 hover:text-white">
                  Trade-in unit →
                </Link>
              )}
            </div>
          }
        >
          <p className="font-medium">Sale posted.</p>
          {result.payoffProposalId && <p className="text-body-sm">The lender payoff is proposed — release it from the floor plan’s payoffs so the unit doesn’t go sold out of trust.</p>}
          {result.warnings.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-body-sm">
              {result.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </Notice>
      )}

      {sale.status === 'PROPOSED' && gates.blockers.length > 0 && (
        <Notice tone="warning">
          <p className="font-medium">Before this sale can post:</p>
          <ul className="mt-1 list-disc pl-5 text-body-sm">
            {gates.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </Notice>
      )}

      {lienClock?.overdue && (
        <Notice tone="warning">
          <span className="inline-flex items-start gap-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-400" />
            <span>
              The trade-in lien has been unpaid for <Mono>{lienClock.days}</Mono> days (this client’s limit is{' '}
              <Mono>{pack.settings?.lien_unpaid_days ?? 10}</Mono>). The dealer can’t get clean title to the trade until it’s paid.
            </span>
          </span>
        </Notice>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div>
          <section aria-label="Deal summary" className="card mb-6 overflow-hidden">
            <div className="flex flex-wrap items-start justify-between gap-6 border-b border-slate-800 p-6">
              <div>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Pill label={labelOf(SALE_STATUS, sale.status)} tone={toneOf(SALE_STATUS, sale.status)} />
                  <span className="text-xs text-slate-500">{labelOf(SALE_SOURCE, sale.source)}</span>
                </div>
                <h2 className="text-heading text-white">{nameOf(customers, sale.customer_id, 'No customer')}</h2>
                <p className="mt-1 text-body-sm text-slate-400">
                  Sold <Mono className="text-slate-200">{dateLabel(sale.sale_date)}</Mono>
                  {sale.salesperson && <> · {sale.salesperson}</>}
                  {sale.external_deal_ref && (
                    <>
                      {' '}
                      · Deal <Mono className="text-slate-200">{sale.external_deal_ref}</Mono>
                    </>
                  )}
                </p>
              </div>
              <div className="text-right">
                <div className="text-caption uppercase tracking-caps text-slate-500">Customer owes</div>
                <div className="text-display font-mono tabular-nums text-white">{money(recap.receivableCents)}</div>
                {sale.deposit_applied_cents > 0 && <div className="font-mono text-xs tabular-nums text-slate-400">{money(recap.dueAfterDepositCents)} after deposit</div>}
              </div>
            </div>
            <div className="p-6">
              <DealRecapView
                salePriceCents={sale.sale_price_cents}
                taxCents={sale.tax_cents}
                retailRebateCents={sale.retail_rebate_cents}
                depositAppliedCents={sale.deposit_applied_cents}
                allowanceCents={trade ? trade.allowance_cents : null}
                acvCents={trade ? trade.acv_cents : null}
                unitCostCents={unitCost}
                policy={policy}
                recap={recap}
                overAllowanceWarnBps={warnBps}
                costIsEstimate={!posted && d.proposedCostCount > 0}
              />
            </div>
          </section>
        </div>

        <aside className="space-y-6">
          <Section title="Unit">
            <div className="p-5">
              <Link href={dealerLinks.unit(unit.id)} className="font-mono tabular-nums text-white hover:underline">
                {unit.serial_number}
              </Link>
              {unitTitle && <p className="text-body-sm text-slate-400">{unitTitle}</p>}
              <div className="mt-3">
                <DefList
                  items={[
                    { label: posted ? 'Cost of sale' : 'Unit cost', value: money(unitCost), mono: true },
                    { label: 'Floor-plan note', value: note ? <Pill label={labelOf(NOTE_STATUS, note.status)} tone={toneOf(NOTE_STATUS, note.status)} /> : 'Not floored' },
                    ...(note && note.status === 'SOLD_UNPAID' ? [{ label: 'Payoff due', value: dateLabel(note.payoff_due_date), mono: true }] : []),
                    ...(payoff ? [{ label: 'Lender payoff', value: <Pill label={labelOf(ROW_STATUS, payoff.status)} tone={toneOf(ROW_STATUS, payoff.status)} /> }] : []),
                  ]}
                />
              </div>
              {note && (
                <Link href={dealerLinks.note(note.id)} className="mt-3 inline-block text-xs text-slate-400 hover:text-slate-200">
                  Floor-plan note →
                </Link>
              )}
            </div>
          </Section>

          <Section title="Books records">
            <div className="space-y-3 p-5 text-body-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-400">Invoice</span>
                {invoice ? (
                  <Link href={`/invoices?id=${invoice.id}`} className="font-mono tabular-nums text-slate-200 hover:underline">
                    {invoice.invoice_number} · {money(invoice.balance_cents)} open
                  </Link>
                ) : (
                  <span className="text-slate-500">{posted ? '—' : 'Created when the sale posts'}</span>
                )}
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-400">Journal entry</span>
                {sale.gl_entry_id ? (
                  <Link href={dealerLinks.journalEntry(sale.gl_entry_id)} className="text-slate-200 hover:underline">
                    View entry
                  </Link>
                ) : (
                  <span className="text-slate-500">Not posted</span>
                )}
              </div>
              {posted && (
                <p className="flex items-center gap-1.5 text-xs text-slate-500">
                  <CheckCircle2 size={12} /> Posted {sale.posted_at ? dateLabel(sale.posted_at.slice(0, 10)) : ''}
                </p>
              )}
            </div>
          </Section>

          {trade && (
            <Section title="Trade-in">
              <div className="p-5">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <Pill label={labelOf(TRADE_STATUS, trade.status)} tone={toneOf(TRADE_STATUS, trade.status)} />
                  <Pill label={labelOf(LIEN_STATUS, trade.lien_status)} tone={toneOf(LIEN_STATUS, trade.lien_status)} />
                </div>
                <DefList
                  items={[
                    { label: 'Serial', value: trade.used_unit_id ? <Link href={dealerLinks.unit(trade.used_unit_id)} className="hover:underline">{trade.serial_number}</Link> : trade.serial_number ?? '—', mono: true },
                    { label: 'Unit', value: [nameOf(vendors, trade.make_vendor_id, ''), trade.model, trade.model_year].filter(Boolean).join(' ') || '—' },
                    { label: 'Allowance', value: money(trade.allowance_cents), mono: true },
                    { label: 'Appraised (ACV)', value: money(trade.acv_cents), mono: true },
                    { label: 'Lien payoff', value: trade.lien_payoff_cents > 0 ? money(trade.lien_payoff_cents) : 'None', mono: true },
                    { label: 'Lienholder', value: trade.lienholder_vendor_id ? nameOf(vendors, trade.lienholder_vendor_id) : '—' },
                    ...(trade.lien_paid_date ? [{ label: 'Lien paid', value: dateLabel(trade.lien_paid_date), mono: true }] : []),
                    { label: 'Appraisal', value: trade.approved_by ? `Approved ${trade.approved_at ? dateLabel(trade.approved_at.slice(0, 10)) : ''}` : 'Not approved yet' },
                  ]}
                />
                {trade.lien_gl_entry_id && (
                  <Link href={dealerLinks.journalEntry(trade.lien_gl_entry_id)} className="mt-3 inline-block text-xs text-slate-400 hover:text-slate-200">
                    Lien payment entry →
                  </Link>
                )}
              </div>
            </Section>
          )}
        </aside>
      </div>

      <p className="mt-2">
        <Link href={dealerLinks.deals()} className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200">
          <ArrowLeft size={12} /> Back to deals
        </Link>
      </p>
    </div>
  );
}
