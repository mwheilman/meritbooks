'use client';

import { useState } from 'react';
import {
  Button, ButtonLink, Check, ConfirmDialog, Field, Input, MoneyInput, Status, Textarea, money, pct, shortDate,
} from '@meritbooks/merit-ui';
import { DEAL_STAGE, FINANCE_WORDS, checklistMissing, floorMark, outboxMark } from '@/lib/pm/dealer/labels';
import { belowMarginFloor } from '@/lib/pm/dealer/math';
import type { DealTotals, DealStage } from '@/lib/pm/dealer/types';
import type { DealWorkspace } from '@/lib/pm/dealer/deal-queries';
import { roleWords } from '@/lib/pm/dealer/errors';
import { Failure, StatusMark } from '@/components/ops/common/bits';
import type { StoreFailure } from '../common/useStore';

type Act = <T>(key: string, method: 'post', url: string, body: unknown, ok: string | ((d: T) => string | null)) => Promise<{ data: T | null; error: { error: string; code: string } | null }>;

const PATH: ReadonlyArray<DealStage> = ['QUOTE', 'WRITTEN', 'APPROVED', 'FUNDED', 'DELIVERED'];

/** The stage strip across the top of the desk. */
export function StageBar({ stage }: { stage: DealStage }) {
  const at = PATH.indexOf(stage);
  return (
    <div className="dl-stagebar" aria-label={`Stage: ${DEAL_STAGE[stage].word}`}>
      {PATH.map((s, i) => (
        <span key={s} className={s === stage ? 'on' : at > i || stage === 'UNWOUND' ? 'done' : undefined} aria-current={s === stage ? 'step' : undefined}>{['Quote', 'Written', 'Approved', 'Funded', 'Delivered'][i]}</span>
      ))}
      {(stage === 'UNWOUND' || stage === 'LOST') && <span className="on">{DEAL_STAGE[stage].word}</span>}
    </div>
  );
}

function Row({ label, cents, strong, big, muted, rule, preview, negate }: { label: string; cents: number | null; strong?: boolean; big?: boolean; muted?: boolean; rule?: boolean; preview?: number | null; negate?: boolean }) {
  const shown = cents == null ? '—' : money(negate ? -cents : cents);
  return (
    <>
      <li className={[strong && 'strong', big && 'big', muted && 'muted', rule && 'rule'].filter(Boolean).join(' ') || undefined}>
        <span>{label}</span><span className="v">{shown}</span>
      </li>
      {preview != null && preview !== cents && (
        <li className="preview muted"><span>If saved</span><span className="v">{money(negate ? -preview : preview)}</span></li>
      )}
    </>
  );
}

/** Live totals and gross from pm.dealer_deal_totals, with a preview of unsaved edits. */
export function TotalsCard({ totals, preview, floorPct, minFront }: { totals: DealTotals; preview: DealTotals | null; floorPct: number; minFront: number }) {
  const below = belowMarginFloor(totals, { margin_floor_pct: floorPct, min_front_gross_cents: minFront });
  const p = preview;
  return (
    <div className="dl-card">
      <div className="dl-card-h"><h2 className="t-section">Totals and gross</h2><span className="sp" /><span className="t-cap">Operational</span></div>
      <div className="dl-gross">
        <div><span className="l">Front gross</span><span className={totals.front_gross_cents < 0 ? 'v neg' : 'v'}>{money(totals.front_gross_cents)}</span><span className="t-cap">{totals.front_gross_pct == null ? 'no sale yet' : `${pct(totals.front_gross_pct)} of sale`}</span></div>
        <div><span className="l">Back gross</span><span className={totals.back_gross_cents < 0 ? 'v neg' : 'v'}>{money(totals.back_gross_cents)}</span><span className="t-cap">F&amp;I and reserve</span></div>
        <div><span className="l">Total gross</span><span className={totals.total_gross_cents < 0 ? 'v neg' : 'v'}>{money(totals.total_gross_cents)}</span><span className="t-cap">{p && p.total_gross_cents !== totals.total_gross_cents ? `${money(p.total_gross_cents)} if saved` : ' '}</span></div>
      </div>
      <div className="dl-card-b">
        {below && totals.sale_price_cents > 0 && (
          <p className="dl-note" style={{ marginBottom: 8 }}>Front gross is under the {pct(floorPct)} floor{minFront > 0 ? ` or the ${money(minFront, { decimals: 0 })} minimum` : ''}. Approving it needs a floor override and a reason.</p>
        )}
        <ul className="dl-totals">
          <Row label="Units and attachments" cents={totals.merchandise_cents} preview={p?.merchandise_cents} />
          {totals.discount_cents > 0 && <Row label="Discounts" cents={totals.discount_cents} negate preview={p?.discount_cents} />}
          <Row label="Sale price" cents={totals.sale_price_cents} strong preview={p?.sale_price_cents} />
          {totals.fees_cents > 0 && <Row label="Fees" cents={totals.fees_cents} />}
          {totals.fi_price_cents > 0 && <Row label="F&I products" cents={totals.fi_price_cents} />}
          <Row label={totals.tax_exempt ? 'Sales tax (exempt)' : `Sales tax estimate${totals.tax_rate_estimate != null ? ` at ${pct(Number(totals.tax_rate_estimate), { decimals: 2 })}` : ''}`} cents={totals.tax_estimate_cents} muted preview={p?.tax_estimate_cents} />
          <li className="muted"><span className="t-cap">Merit Books calculates the final tax.</span><span /></li>
          {totals.rebates_cents > 0 && <Row label="Customer rebates" cents={totals.rebates_cents} negate />}
          <Row label="Cash price" cents={totals.cash_price_cents} strong rule preview={p?.cash_price_cents} />
          {totals.trade_count > 0 && <Row label="Trade allowance" cents={totals.trade_allowance_cents} negate preview={p?.trade_allowance_cents} />}
          {totals.trade_payoff_cents > 0 && <Row label="Trade payoff" cents={totals.trade_payoff_cents} />}
          {totals.deposits_cents > 0 && <Row label="Deposits" cents={totals.deposits_cents} negate />}
          <Row label="Balance due (estimate)" cents={totals.balance_due_estimate_cents} big rule preview={p?.balance_due_estimate_cents} />
        </ul>
        <ul className="dl-totals" style={{ marginTop: 12 }} aria-label="Gross build-up">
          <Row label="Unit and attachment cost" cents={totals.unit_cost_cents} muted negate />
          {totals.over_allowance_cents > 0 && <Row label="Trade over-allowance" cents={totals.over_allowance_cents} muted negate preview={p?.over_allowance_cents} />}
          {totals.fees_cents > 0 && <Row label="Fee cost" cents={totals.fee_cost_cents} muted negate />}
          {totals.incentives_cents > 0 && <Row label="Dealer incentives" cents={totals.incentives_cents} muted />}
          {totals.fi_cost_cents > 0 && <Row label="F&I cost" cents={totals.fi_cost_cents} muted negate />}
          {totals.finance_reserve_cents > 0 && <Row label="Finance reserve" cents={totals.finance_reserve_cents} muted />}
          {totals.subvention_cents > 0 && <Row label="Subvention" cents={totals.subvention_cents} muted negate />}
        </ul>
      </div>
    </div>
  );
}

/** Stage moves the database will take from here, with the margin floor and the payoff guard in view. */
export function StageActions({ w, url, act, busy, failure, readOnly, today }: { w: DealWorkspace; url: string; act: Act; busy: string | null; failure: StoreFailure | null; readOnly: boolean; today: string }) {
  const d = w.deal;
  const s = w.settings;
  const [validUntil, setValidUntil] = useState('');
  const [reason, setReason] = useState('');
  const [financeRef, setFinanceRef] = useState(d.finance_ref ?? '');
  const [financed, setFinanced] = useState<number | null>(d.amount_financed_cents);
  const [deliveredOn, setDeliveredOn] = useState(today);
  const [ack, setAck] = useState(false);
  const [lostOpen, setLostOpen] = useState(false);
  const [unwindOpen, setUnwindOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [declineOpen, setDeclineOpen] = useState<string | null>(null);
  const [deposit, setDeposit] = useState<number | null>(null);
  const below = belowMarginFloor(w.totals, s) && w.totals.sale_price_cents > 0;
  const openQuote = w.quotes.find((q) => q.status === 'ISSUED') ?? null;
  const unitRows = w.lines.filter((l) => l.line_type === 'UNIT' && l.asset_id).map((l) => w.units[l.asset_id!]).filter((u): u is NonNullable<typeof u> => !!u);
  const payoffDue = unitRows.filter((u) => u.floored && (u.payoff_cents ?? 0) > 0 && !u.payoff_scheduled);
  const missing = checklistMissing(d.delivery_checklist);
  const ackNeeded = payoffDue.length > 0 && s.payoff_guard === 'WARN';
  const blocked = payoffDue.length > 0 && s.payoff_guard === 'BLOCK';
  const canDeposit = d.stage === 'WRITTEN' || d.stage === 'APPROVED' || d.stage === 'FUNDED';
  const live = !readOnly;

  return (
    <div className="dl-card">
      <div className="dl-card-h"><h2 className="t-section">Next step</h2><span className="sp" /><StatusMark mark={DEAL_STAGE[d.stage]} /></div>
      <div className="dl-card-b stack">
        {failure && <Failure text={failure.text} />}
        {d.sot_alert_at && <p className="dl-note neg" role="alert"><b>Sold out of trust.</b> Merit Books reports a unit on this deal sold with the floor-plan lender unpaid. Pay the lender in Merit Books today.</p>}

        {d.stage === 'QUOTE' && live && (
          <>
            {openQuote ? (
              <>
                <p className="t-cap">Quote {openQuote.number} v{openQuote.version} is with the customer{openQuote.valid_until ? ` until ${shortDate(openQuote.valid_until, today)}` : ''}.</p>
                <div className="btn-row">
                  <Button variant="primary" disabled={busy === 'accept'} onClick={() => void act('accept', 'post', url, { op: 'accept_quote', quoteId: openQuote.id }, `Quote ${openQuote.number} accepted; the deal is written`)}>Customer accepted</Button>
                  <Button onClick={() => setDeclineOpen(openQuote.id)}>Declined</Button>
                  <ButtonLink variant="quiet" href={`/deals/${d.id}/quote?q=${openQuote.id}`}>Print</ButtonLink>
                </div>
                <p className="t-cap">Changed the deal since? Issue a new quote; the customer accepts the latest one.</p>
              </>
            ) : null}
            <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <Field label="Quote good until"><Input type="date" value={validUntil} min={today} onChange={(e) => setValidUntil(e.target.value)} style={{ width: 150 }} /></Field>
              <Button disabled={busy === 'quote' || !d.customer_id || w.lines.length === 0} onClick={() => void act<{ quoteId: string }>('quote', 'post', url, { op: 'issue_quote', validUntil: validUntil || null }, 'Issued the quote')}>{openQuote ? 'Issue a new quote' : 'Issue quote'}</Button>
            </div>
            {!d.customer_id && <p className="t-cap">Pick the customer to quote or write the deal.</p>}
            <div className="btn-row">
              <Button variant="primary" disabled={busy === 'write' || !d.customer_id || !w.lines.some((l) => l.line_type === 'UNIT')} onClick={() => void act('write', 'post', url, { op: 'write' }, 'Wrote the deal; the units are on hold')}>Write the deal</Button>
              <Button variant="quiet" onClick={() => setLostOpen(true)}>Mark lost</Button>
            </div>
            <p className="t-cap">Writing it signs the buyer’s order and holds the units for this deal.</p>
          </>
        )}

        {d.stage === 'WRITTEN' && live && (
          <>
            <p className="t-cap">Desk roles: {roleWords(`{${s.desk_roles.join(',')}}`)}. The salesperson and the writer cannot desk their own deal.</p>
            {below && (
              <Field label="Why approve below the floor" help={`Needs ${roleWords(`{${s.floor_override_roles.join(',')}}`)}`}>
                <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Matching a competitor quote on a 2024 aged unit" />
              </Field>
            )}
            <div className="btn-row">
              <Button variant="primary" disabled={busy === 'approve' || (below && !reason.trim())} onClick={() => void act<{ approval: Record<string, unknown> }>('approve', 'post', url, { op: 'approve', overrideReason: below ? reason.trim() : null }, below ? 'Approved below the floor' : 'Approved the deal')}>{below ? 'Approve with override' : 'Approve the deal'}</Button>
              <Button variant="quiet" onClick={() => setLostOpen(true)}>Mark lost</Button>
            </div>
          </>
        )}

        {d.stage === 'APPROVED' && (
          <>
            {d.approval && <p className="t-cap">Approved {d.approved_at ? shortDate(d.approved_at.slice(0, 10), today) : ''}{d.approval.rule === 'FLOOR_OVERRIDE' ? ` below the floor: ${String(d.approval.override_reason ?? '')}` : ' at or above the floor'}.</p>}
            {live && (
              <>
                {d.finance_type !== 'CASH' && (
                  <div className="mp-form-2">
                    <Field label={`${FINANCE_WORDS[d.finance_type]} reference`}><Input value={financeRef} onChange={(e) => setFinanceRef(e.target.value)} maxLength={60} placeholder="Approval number" /></Field>
                    <Field label="Amount financed"><MoneyInput valueCents={financed} onChangeCents={setFinanced} placeholder={money(w.totals.balance_due_estimate_cents)} /></Field>
                  </div>
                )}
                <div className="btn-row">
                  <Button variant="primary" disabled={busy === 'fund'} onClick={() => void act('fund', 'post', url, { op: 'fund', financeRef: financeRef.trim() || null, amountFinancedCents: financed }, 'Marked funded; ready to deliver')}>{d.finance_type === 'CASH' ? 'Cash is in' : 'Financing approved'}</Button>
                  <Button onClick={() => setReopenOpen(true)}>Reopen</Button>
                  <Button variant="quiet" onClick={() => setLostOpen(true)}>Mark lost</Button>
                </div>
              </>
            )}
          </>
        )}

        {d.stage === 'FUNDED' && (
          <>
            {missing.length > 0 ? <p className="dl-note">Still on the checklist: {missing.map((m) => m.label).join('; ')}.</p> : <p className="t-cap">Checklist done.</p>}
            {payoffDue.length > 0 && s.payoff_guard !== 'OFF' && (
              <div className={blocked ? 'dl-note neg' : 'dl-note'}>
                <b>Floor-plan payoff due on delivery.</b>{' '}
                {payoffDue.map((u) => `${u.stock_number ?? u.serial_number}: ${money(u.payoff_cents ?? 0)}${u.payoff_due_on ? ` due ${shortDate(u.payoff_due_on, today)}` : ''}`).join('; ')}.{' '}
                {blocked ? 'Store settings block delivery until the payoff is scheduled in Merit Books.' : 'Merit Books shows the unit sold out of trust until the lender is paid.'}
                {ackNeeded && live && <div style={{ marginTop: 8 }}><Check label={`I acknowledge the payoff (needs ${roleWords(`{${s.payoff_ack_roles.join(',')}}`)})`} checked={ack} onChange={(e) => setAck(e.target.checked)} /></div>}
              </div>
            )}
            {payoffDue.length === 0 && unitRows.some((u) => u.floored) && <p className="t-cap">Floored units: payoff scheduled in Merit Books.</p>}
            {unitRows.map((u) => { const f = floorMark({ ...u, sold_out_of_trust: !!u.sot_alert_at }, today); return u.floor_status ? <div key={u.id}><Status kind={f.kind} pip={f.pip}>{u.stock_number}: {f.word}</Status>{u.floor_status_at ? <span className="t-cap"> as of {shortDate(u.floor_status_at.slice(0, 10), today)}</span> : null}</div> : null; })}
            {live && (
              <>
                <Field label="Delivered on"><Input type="date" value={deliveredOn} onChange={(e) => setDeliveredOn(e.target.value)} style={{ width: 150 }} /></Field>
                <div className="btn-row">
                  <Button variant="primary" disabled={busy === 'deliver' || missing.length > 0 || blocked || (ackNeeded && !ack)}
                    onClick={() => void act('deliver', 'post', url, { op: 'deliver', acknowledgePayoff: ack, deliveredOn: deliveredOn || null }, 'Delivered; sent to Merit Books')}>Deliver</Button>
                  <Button onClick={() => setReopenOpen(true)}>Reopen</Button>
                  <Button variant="quiet" onClick={() => setLostOpen(true)}>Mark lost</Button>
                </div>
                {failure?.code === 'PM_DELIVERY_PAYOFF_DUE' && !ackNeeded && <Check label="I acknowledge the payoff due on delivery" checked={ack} onChange={(e) => setAck(e.target.checked)} />}
              </>
            )}
          </>
        )}

        {d.stage === 'DELIVERED' && (
          <>
            <p className="t-cap">Delivered {d.delivered_on ? shortDate(d.delivered_on, today) : ''}. The units are the customer’s equipment now; trades are in stock as used units.</p>
            {w.finalized && <div><Status kind={outboxMark(w.finalized.status, w.finalized.suppressed_reason).kind} pip={outboxMark(w.finalized.status, w.finalized.suppressed_reason).pip}>{outboxMark(w.finalized.status, w.finalized.suppressed_reason).word}</Status>{w.finalized.invoice_number ? <span className="t-cap"> · invoice {w.finalized.invoice_number}</span> : null}{w.finalized.error_text ? <p className="t-cap neg">{w.finalized.error_text}</p> : null}</div>}
            {live && <div className="btn-row"><Button variant="danger" onClick={() => setUnwindOpen(true)}>Unwind the deal</Button></div>}
          </>
        )}

        {d.stage === 'UNWOUND' && <p className="t-cap">Unwound{d.unwind_reason ? `: ${d.unwind_reason}` : ''}. Merit Books reverses the deal; the units are back in stock and trades went back to the customer.</p>}
        {d.stage === 'LOST' && <p className="t-cap">Lost{d.lost_reason ? `: ${d.lost_reason}` : ''}. Units it held went back to stock.</p>}

        {canDeposit && live && (
          <div className="row" style={{ gap: 8, alignItems: 'flex-end', borderTop: '1px solid var(--line)', paddingTop: 12 }}>
            <Field label="Deposit"><MoneyInput valueCents={deposit} onChangeCents={setDeposit} placeholder="0.00" style={{ width: 130 }} /></Field>
            <Button disabled={busy === 'deposit' || !deposit || deposit <= 0} onClick={() => void act('deposit', 'post', url, { op: 'deposit', amountCents: deposit }, `Requested a ${money(deposit ?? 0)} deposit`).then((r) => { if (r.data) setDeposit(null); })}>Request deposit</Button>
          </div>
        )}
        {canDeposit && <p className="t-cap">Merit Books invoices and holds the deposit, and applies it at delivery.</p>}
      </div>

      <ConfirmDialog open={lostOpen} onClose={() => setLostOpen(false)} tone="danger" title={`Mark ${d.number} lost`} confirmLabel="Mark lost" cancelLabel="Keep the deal"
        reason={{ label: 'Why', placeholder: 'Bought from another dealer', minLength: 0 }}
        onConfirm={async (r) => { const res = await act('cancel', 'post', url, { op: 'cancel', reason: r || null }, `Marked ${d.number} lost`); if (res.error) throw new Error(res.error.error); }}>
        Units the deal holds go back to stock and the open quote expires. Deposits already requested stay in Merit Books to refund.
      </ConfirmDialog>
      <ConfirmDialog open={reopenOpen} onClose={() => setReopenOpen(false)} title={`Reopen ${d.number}`} confirmLabel="Reopen" cancelLabel="Keep it"
        reason={{ label: 'Why', placeholder: 'Customer added a mower deck', minLength: 0 }}
        onConfirm={async (r) => { const res = await act('reopen', 'post', url, { op: 'reopen', reason: r || null }, 'Reopened; the approval was cleared'); if (res.error) throw new Error(res.error.error); }}>
        The deal goes back to written so its lines can change. It needs the desk again.
      </ConfirmDialog>
      <ConfirmDialog open={unwindOpen} onClose={() => setUnwindOpen(false)} tone="danger" title={`Unwind ${d.number}`} confirmLabel="Unwind the deal" cancelLabel="Keep it delivered"
        reason={{ label: 'Why (goes to Merit Books)', placeholder: 'Financing fell through after delivery', minLength: 3 }}
        onConfirm={async (r) => { const res = await act('unwind', 'post', url, { op: 'unwind', reason: r ?? '' }, `Unwound ${d.number}`); if (res.error) throw new Error(res.error.error); }}>
        Units come back into stock, trades go back to the customer, and Merit Books reverses the deal entry. Needs {roleWords(`{${s.unwind_roles.join(',')}}`)}.
      </ConfirmDialog>
      <ConfirmDialog open={!!declineOpen} onClose={() => setDeclineOpen(null)} title="The customer declined the quote" confirmLabel="Record the decline" cancelLabel="Back"
        reason={{ label: 'Why', placeholder: 'Price', minLength: 0 }}
        onConfirm={async (r) => { const res = await act('decline', 'post', url, { op: 'decline_quote', quoteId: declineOpen, reason: r || null }, 'Recorded the decline'); if (res.error) throw new Error(res.error.error); }}>
        The deal stays a quote. Change it and issue a new one, or mark it lost.
      </ConfirmDialog>
    </div>
  );
}
