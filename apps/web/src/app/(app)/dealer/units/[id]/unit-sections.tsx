'use client';

/**
 * Unit page sections: floor-plan note history and the sale / trade-in summary.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { clsx } from 'clsx';
import { HandCoins, Landmark } from 'lucide-react';
import { NOTE_STATUS, labelOf, toneOf } from '@/lib/dealer/ui/labels';
import { SALE_STATUS } from '@/lib/dealer/ui/unit-deal-labels';
import { dateLabel, relativeDue, todayLocal, daysBetween } from '@/lib/dealer/ui/format';
import { dealerLinks } from '@/lib/dealer/ui/links';
import type { NoteView, SaleView } from '@/lib/dealer/ui/unit-deal-types';
import { DefList, Empty, Money, Pill, Section } from '../../_components/ui';
import { nameOf, useNames } from '../../_lib/use-dealer';

export function NotesHistory({ notes, isConsignment }: { notes: NoteView[]; isConsignment: boolean }) {
  const router = useRouter();
  const lines = useNames('lines', notes.map((n) => n.line_id));
  const today = todayLocal();
  return (
    <Section title="Floor-plan notes" description="Every lender note this unit has been floored on, newest last.">
      {notes.length === 0 ? (
        <Empty
          icon={Landmark}
          title={isConsignment ? 'Consignment — never floored' : 'Not on floor plan'}
          description={isConsignment ? 'The consignor owns this unit; there is no lender note.' : 'This unit is owned outright — no lender is owed for it.'}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-body">
            <caption className="sr-only">Floor-plan notes for this unit</caption>
            <thead>
              <tr className="border-b border-slate-800">
                {[
                  ['Lender invoice #', 'left'],
                  ['Line', 'left'],
                  ['Status', 'left'],
                  ['Floored', 'left'],
                  ['Original', 'right'],
                  ['Balance', 'right'],
                  ['Term ends', 'left'],
                  ['Payoff due', 'left'],
                ].map(([h, a]) => (
                  <th key={h} scope="col" className={clsx('whitespace-nowrap px-4 py-2.5 text-caption font-medium uppercase tracking-caps text-slate-500', a === 'right' ? 'text-right' : 'text-left')}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {notes.map((n) => {
                const overdue = n.status === 'SOLD_UNPAID' && n.payoff_due_date && (daysBetween(n.payoff_due_date, today) ?? 0) > 0;
                return (
                  <tr
                    key={n.id}
                    tabIndex={0}
                    onClick={() => router.push(dealerLinks.note(n.id))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        router.push(dealerLinks.note(n.id));
                      }
                    }}
                    className="row-clickable cursor-pointer focus:outline-none focus-visible:bg-slate-800/40"
                  >
                    <td className="px-4 py-2.5 font-mono tabular-nums text-white">
                      {n.lender_invoice_number}
                      {n.is_opening && <span className="ml-2 font-sans text-xs text-slate-500">opening</span>}
                    </td>
                    <td className="px-4 py-2.5 text-slate-300">{nameOf(lines, n.line_id)}</td>
                    <td className="px-4 py-2.5">
                      <Pill label={labelOf(NOTE_STATUS, n.status)} tone={toneOf(NOTE_STATUS, n.status)} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-body-sm tabular-nums text-slate-400">{dateLabel(n.floored_date)}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right">
                      <Money cents={n.original_principal_cents} muted />
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right">
                      <Money cents={n.principal_balance_cents} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-body-sm tabular-nums text-slate-400">{dateLabel(n.maturity_date)}</td>
                    <td className={clsx('whitespace-nowrap px-4 py-2.5 font-mono text-body-sm tabular-nums', overdue ? 'text-red-300' : 'text-slate-400')}>
                      {n.status === 'SOLD_UNPAID' && n.payoff_due_date ? `${dateLabel(n.payoff_due_date)} (${relativeDue(n.payoff_due_date, today)})` : n.paid_off_date ? `Paid ${dateLabel(n.paid_off_date)}` : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

export function SaleSection({ sale, canRecord, onRecord }: { sale: SaleView | null; canRecord: boolean; onRecord: () => void }) {
  const customers = useNames('customers', [sale?.customer_id]);
  return (
    <Section
      title="Sale"
      actions={
        sale ? (
          <Link href={dealerLinks.deal(sale.id)} className="text-xs font-medium text-slate-300 hover:text-white">
            Open deal recap →
          </Link>
        ) : undefined
      }
    >
      {sale ? (
        <div className="p-5">
          <DefList
            items={[
              { label: 'Status', value: <Pill label={labelOf(SALE_STATUS, sale.status)} tone={toneOf(SALE_STATUS, sale.status)} /> },
              { label: 'Sale date', value: dateLabel(sale.sale_date), mono: true },
              { label: 'Customer', value: nameOf(customers, sale.customer_id) },
              { label: 'Sale price', value: <Money cents={sale.sale_price_cents} /> },
              { label: 'Trade-in', value: sale.trade_in_id ? 'Yes — see the deal' : 'None' },
              { label: 'Salesperson', value: sale.salesperson ?? '—' },
            ]}
          />
        </div>
      ) : (
        <Empty
          icon={HandCoins}
          title="Not sold"
          description={canRecord ? 'Record the deal when the unit sells — the lender payoff is proposed the same day, so it never sits sold-and-unpaid.' : 'This unit can’t be sold in its current status.'}
          action={
            canRecord ? (
              <button type="button" className="btn-secondary btn-sm" onClick={onRecord}>
                Record sale
              </button>
            ) : undefined
          }
        />
      )}
    </Section>
  );
}
