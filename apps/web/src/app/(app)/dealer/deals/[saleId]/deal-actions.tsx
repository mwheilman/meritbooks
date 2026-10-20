'use client';

/**
 * Deal actions: approve the trade appraisal, post the sale, void it (unposted
 * only), and the trade lien payoff (propose → a different person releases).
 * Every step confirms and says exactly what will happen; refusals (permission,
 * separation of duties, state) are shown in plain English inside the dialog.
 */

import { useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import type { DealerSettings } from '@/lib/dealer/types';
import type { DealerApiError } from '@/lib/dealer/ui/errors';
import { money, todayLocal } from '@/lib/dealer/ui/format';
import { tradeNeedsApproval } from '@/lib/dealer/ui/deal-math';
import type { DealDetailView, PostSaleResultView } from '@/lib/dealer/ui/unit-deal-types';
import { ConfirmDialog } from '../../_components/forms';
import { ErrorPanel } from '../../_components/ui';
import { dealerMutate, nameOf, useNames } from '../../_lib/use-dealer';

type Step = null | 'approve' | 'post' | 'void' | 'lien-propose' | 'lien-release';

/** Why a proposed sale can't post yet (mirrors the D1 postSale refusals). Pure. */
export function dealGates(detail: DealDetailView, settings: DealerSettings | null, enabled: boolean) {
  const { sale, trade, proposedCostCount } = detail;
  const approvalNeeded = !!trade && trade.status === 'DRAFT' && tradeNeedsApproval(trade.acv_cents, settings?.trade_acv_approval_threshold_cents ?? 0);
  const blockers: string[] = [];
  if (sale.status === 'PROPOSED') {
    if (!enabled) blockers.push('The dealer pack is off for this client — switch it on in settings.');
    if (proposedCostCount > 0) blockers.push(`The unit has ${proposedCostCount} cost row${proposedCostCount === 1 ? '' : 's'} waiting to be posted — post or void them on the unit page.`);
    if (approvalNeeded) blockers.push('The trade appraisal needs a sales manager’s approval.');
    if (sale.posting_mode === 'DEAL' && !sale.customer_id) blockers.push('The deal has no customer.');
  }
  return { approvalNeeded, blockers };
}

export function DealActions({
  detail,
  settings,
  enabled,
  locationId,
  onDone,
  onPosted,
}: {
  detail: DealDetailView;
  settings: DealerSettings | null;
  enabled: boolean;
  locationId: string;
  onDone: () => void;
  onPosted: (r: PostSaleResultView) => void;
}) {
  const { userId } = useAuth();
  const { sale, trade, unit, notes } = detail;
  const [step, setStep] = useState<Step>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<DealerApiError | null>(null);
  const names = useNames('customers', [sale.customer_id]);
  const lienholders = useNames('vendors', [trade?.lienholder_vendor_id]);
  const { approvalNeeded, blockers } = dealGates(detail, settings, enabled);
  const liveNote = notes.find((n) => n.status === 'OPEN' || n.status === 'IN_DEFAULT') ?? null;

  const open = (s: Step) => {
    setErr(null);
    setStep(s);
  };
  const close = () => !busy && setStep(null);

  async function call<T>(path: string, body: Record<string, unknown>, ok: string): Promise<T | null> {
    setBusy(true);
    setErr(null);
    const r = await dealerMutate<T>('post', path, locationId, body, ok);
    setBusy(false);
    if (r.error) {
      setErr(r.error);
      return null;
    }
    setStep(null);
    return r.data;
  }

  const customer = nameOf(names, sale.customer_id, 'the customer');
  const receivable = sale.sale_price_cents + sale.tax_cents - (trade?.allowance_cents ?? 0) + (trade?.lien_payoff_cents ?? 0) - sale.retail_rebate_cents;
  const errorBlock = err ? <ErrorPanel error={err} compact /> : null;
  const selfProposedLien = !!trade?.lien_proposed_by && trade.lien_proposed_by === userId;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {trade && trade.status === 'DRAFT' && sale.status === 'PROPOSED' && (
        <button type="button" className="btn-secondary btn-sm" onClick={() => open('approve')}>
          Approve trade appraisal
        </button>
      )}
      {trade?.status === 'POSTED' && trade.lien_status === 'OWED' && (
        <button type="button" className="btn-secondary btn-sm" onClick={() => open('lien-propose')}>
          Propose lien payoff
        </button>
      )}
      {trade?.lien_status === 'PROPOSED' && (
        <button
          type="button"
          className="btn-secondary btn-sm"
          onClick={() => open('lien-release')}
          disabled={selfProposedLien || !enabled}
          title={selfProposedLien ? 'You proposed this payoff — a colleague with payment rights must release it.' : !enabled ? 'Switch the dealer pack on first' : undefined}
        >
          Release lien payoff
        </button>
      )}
      {sale.status === 'PROPOSED' && (
        <>
          <button type="button" className="btn-ghost btn-sm text-red-300" onClick={() => open('void')}>
            Void deal
          </button>
          <button
            type="button"
            className="btn-primary btn-sm"
            onClick={() => open('post')}
            disabled={blockers.length > 0}
            title={blockers.length > 0 ? blockers.join(' ') : undefined}
          >
            Post sale
          </button>
        </>
      )}

      <ConfirmDialog
        open={step === 'approve'}
        onClose={close}
        busy={busy}
        title="Approve the trade appraisal"
        confirmLabel="Approve appraisal"
        error={errorBlock}
        body={
          trade && (
            <div className="space-y-2">
              <p>
                Allowance <span className="font-mono tabular-nums text-white">{money(trade.allowance_cents)}</span> against an appraised value of{' '}
                <span className="font-mono tabular-nums text-white">{money(trade.acv_cents)}</span>. The trade goes on the books at{' '}
                <span className="font-mono tabular-nums text-white">{money(trade.recorded_value_cents)}</span>
                {trade.over_allowance_cents > 0 && (
                  <>
                    {' '}
                    with <span className="font-mono tabular-nums text-amber-300">{money(trade.over_allowance_cents)}</span> over-allowance, which reduces the
                    gross on this deal
                  </>
                )}
                .
              </p>
              <p className="text-xs text-slate-400">
                Only a sales manager with approval rights can approve. The person who appraised the trade shouldn’t approve it too.
              </p>
            </div>
          )
        }
        onConfirm={() => void call('/api/dealer/trade-ins/approve', { tradeId: trade?.id }, 'Trade appraisal approved').then((r) => r && onDone())}
      />

      <ConfirmDialog
        open={step === 'post'}
        onClose={close}
        busy={busy}
        title="Post this sale?"
        confirmLabel="Post sale"
        error={errorBlock}
        body={
          <div className="space-y-2">
            <p>Posting does all of this in one step:</p>
            <ul className="list-disc space-y-1.5 pl-5 text-body-sm">
              {sale.posting_mode === 'DEAL' ? (
                <li>
                  A Books invoice is created for {customer} for <span className="font-mono tabular-nums text-white">{money(receivable)}</span> and the deal’s
                  journal entry posts (sale, tax, trade-in, rebate, cost of sale).
                </li>
              ) : (
                <li>The existing invoice already booked the sale; only the unit’s cost moves to cost of sales.</li>
              )}
              <li>
                Unit <span className="font-mono tabular-nums">{unit.serial_number}</span> is marked sold; its cost of{' '}
                <span className="font-mono tabular-nums text-white">{money(unit.cost_cents)}</span> moves to cost of sales.
              </li>
              {liveNote && (
                <li>
                  The floor-plan note (owed <span className="font-mono tabular-nums text-white">{money(liveNote.principal_balance_cents)}</span>) becomes
                  “sold — payoff owed” and a payoff to the lender is <span className="text-white">proposed</span>. Money never leaves automatically —
                  someone releases the payoff.
                </li>
              )}
              {trade && (
                <li>
                  The trade-in is added to used inventory at <span className="font-mono tabular-nums text-white">{money(trade.recorded_value_cents)}</span>
                  {trade.lien_payoff_cents > 0 && <> and its lien payoff of {money(trade.lien_payoff_cents)} becomes owed</>}.
                </li>
              )}
              {sale.deposit_applied_cents > 0 && (
                <li>
                  The customer’s deposit of <span className="font-mono tabular-nums text-white">{money(sale.deposit_applied_cents)}</span> is applied to the
                  invoice.
                </li>
              )}
            </ul>
            <p className="text-xs text-slate-500">A posted sale can’t be voided here — correct it through the invoice and a correcting entry.</p>
          </div>
        }
        onConfirm={() =>
          void call<PostSaleResultView>('/api/dealer/sales/post', { saleId: sale.id }, 'Sale posted').then((r) => {
            if (r) {
              onPosted(r);
              onDone();
            }
          })
        }
      />

      <ConfirmDialog
        open={step === 'void'}
        onClose={close}
        busy={busy}
        danger
        title="Void this deal?"
        confirmLabel="Void deal"
        error={errorBlock}
        reason={{ label: 'Why is it being voided?', required: true, placeholder: 'e.g. Customer backed out; entered on the wrong unit' }}
        body={<p>Nothing has posted, so no entry changes. The unit stays in stock, ready for another deal{trade ? ' and the trade-in is voided' : ''}. This can’t be undone.</p>}
        onConfirm={({ reason }) => void call('/api/dealer/sales/void', { saleId: sale.id, reason }, 'Deal voided').then((r) => r && onDone())}
      />

      <ConfirmDialog
        open={step === 'lien-propose'}
        onClose={close}
        busy={busy}
        title="Propose the lien payoff"
        confirmLabel="Propose payoff"
        error={errorBlock}
        body={
          trade && (
            <p>
              Proposes paying <span className="font-mono tabular-nums text-white">{money(trade.lien_payoff_cents)}</span> to{' '}
              {nameOf(lienholders, trade.lienholder_vendor_id, 'the lienholder')} to clear the lien on trade-in{' '}
              <span className="font-mono tabular-nums">{trade.serial_number}</span>. Nothing is paid yet — a different person releases it.
            </p>
          )
        }
        onConfirm={() => void call('/api/dealer/trade-ins/lien', { tradeId: trade?.id, action: 'propose' }, 'Lien payoff proposed').then((r) => r && onDone())}
      />

      <ConfirmDialog
        open={step === 'lien-release'}
        onClose={close}
        busy={busy}
        danger
        title="Release the lien payoff"
        confirmLabel="Release payment"
        error={errorBlock}
        date={{ label: 'Paid date', initial: todayLocal() }}
        body={
          trade && (
            <div className="space-y-2">
              <p>
                <span className="text-white">Money leaves the bank:</span> posts the payment of{' '}
                <span className="font-mono tabular-nums text-white">{money(trade.lien_payoff_cents)}</span> to{' '}
                {nameOf(lienholders, trade.lienholder_vendor_id, 'the lienholder')} from the operating bank.
              </p>
              <p className="text-xs text-slate-400">A different person than the one who proposed it must release it, and they need payment rights.</p>
            </div>
          )
        }
        onConfirm={({ date }) => void call('/api/dealer/trade-ins/lien', { tradeId: trade?.id, action: 'release', paidDate: date }, 'Lien payoff released').then((r) => r && onDone())}
      />
      {approvalNeeded && sale.status === 'PROPOSED' && <span className="sr-only">The trade appraisal needs approval before posting.</span>}
    </div>
  );
}
