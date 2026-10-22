'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Button, ButtonLink, Check, Field, Input, InlineNotice, Keybar, MoneyInput, Select, WidgetState, api, count, money, useHotkey,
} from '@meritbooks/merit-ui';
import { PAYMENT_WORDS, TICKET_STATUS } from '@/lib/pm/dealer/labels';
import { counterLookup, fillPlan, parseCounterEntry, ticketTotals, type CounterLookup } from '@/lib/pm/dealer/math';
import type { CounterSearch, TicketDetail } from '@/lib/pm/dealer/parts-queries';
import { PAYMENT_METHODS, type PartOnHandRow, type PaymentMethod, type StockLocationRow, type TicketRow } from '@/lib/pm/dealer/types';
import { useShell } from '@/components/shell/ShellContext';
import { CustomerPicker, type CustomerValue } from '@/components/jobs/CustomerPicker';
import { Failure, StatusMark, parseNum } from '@/components/ops/common/bits';
import { useStore, useStoreDetail } from '../common/useStore';

export interface CounterViewProps {
  companyId: string | null;
  stockLocations: StockLocationRow[];
  defaultStockLocationId: string | null;
  allowNegative: boolean;
  defaultTaxRate: number | null;
  tickets: TicketRow[];
  customers: Record<string, string>;
  focusTicketId: string | null;
  today: string;
}

type Match = CounterSearch['matches'][number];
interface Pending { match: Match; qty: number; onHand: number; bin: string | null }

/**
 * The parts counter, built for speed: key a number (or "3*AM125172") and Enter. A superseded
 * number becomes its replacement on the ticket and says so; a short line offers a special order
 * for the rest. Close with the payment method; Merit Books gets the sale and computes the tax.
 */
export function CounterView(p: CounterViewProps) {
  const { readOnly } = useShell();
  const { act, busy, version, error } = useStore();
  const [ticketId, setTicketId] = useState<string | null>(p.focusTicketId);
  const { data: ticket, isLoading, error: loadError, refetch } = useStoreDetail<TicketDetail>(ticketId ? `/api/dealer/tickets/${ticketId}` : null, version);
  const [sl, setSl] = useState(p.defaultStockLocationId ?? p.stockLocations[0]?.id ?? '');
  const [entry, setEntry] = useState('');
  const [qtyText, setQtyText] = useState('1');
  const [lookup, setLookup] = useState<CounterLookup>({ kind: 'empty' });
  const [matches, setMatches] = useState<Match[]>([]);
  const [suggest, setSuggest] = useState<CounterSearch['suggestions']>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [searching, setSearching] = useState(false);
  const [customer, setCustomer] = useState<CustomerValue>({ id: null, name: '' });
  const [pay, setPay] = useState<PaymentMethod>('CASH');
  const [closed, setClosed] = useState<{ number: string; totalCents: number; outbox: boolean } | null>(null);
  const keyRef = useRef<HTMLInputElement>(null);

  const t = ticket?.ticket ?? null;
  const open = !!t && t.status === 'OPEN' && !readOnly;
  useEffect(() => {
    if (ticket?.ticket) {
      setCustomer({ id: ticket.ticket.customer_id, name: ticket.customer ?? '' });
      setSl(ticket.ticket.stock_location_id);
    }
  }, [ticket?.ticket?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const focusKey = useCallback(() => setTimeout(() => keyRef.current?.focus(), 0), []);
  const totals = useMemo(() => ticketTotals(ticket?.lines ?? [], t?.tax_rate_estimate ?? p.defaultTaxRate, t?.tax_exempt ?? false), [ticket?.lines, t, p.defaultTaxRate]);

  const ensureTicket = async (): Promise<string | null> => {
    if (ticketId && t?.status === 'OPEN') return ticketId;
    if (!p.companyId) return null;
    const r = await act<{ ticketId: string; number: string | null }>('open', 'post', '/api/dealer/tickets', { companyId: p.companyId, customerId: customer.id, stockLocationId: sl || null }, (d) => `Opened ${d.number ?? 'a ticket'}`);
    if (!r.data) return null;
    setTicketId(r.data.ticketId);
    setClosed(null);
    return r.data.ticketId;
  };

  const addLine = async (m: Match, qty: number, filled: number, special: number) => {
    const id = await ensureTicket();
    if (!id) return;
    const r = await act('line', 'post', `/api/dealer/tickets/${id}`, { op: 'add_line', partId: m.resolved.id, qty, qtyFilled: filled, qtySpecialOrder: special }, special > 0 ? `Added ${m.resolved.part_number}; ${special} on special order` : `Added ${count(qty)} × ${m.resolved.part_number}`);
    if (!r.error) {
      setEntry(''); setQtyText('1'); setPending(null); setMatches([]); setSuggest([]);
      setLookup((l) => (l.kind === 'superseded' ? l : { kind: 'empty' }));
      void refetch();
      focusKey();
    }
  };

  const onHandAt = (m: Match): { qty: number; bin: string | null } => {
    const row = m.onHand.find((o: PartOnHandRow) => o.stock_location_id === (t?.stock_location_id ?? sl));
    return { qty: row?.qty_on_hand ?? 0, bin: row?.bin ?? null };
  };

  const take = (m: Match, qty: number) => {
    const oh = onHandAt(m);
    const plan = fillPlan(qty, oh.qty, p.allowNegative);
    if (plan.short > 0) { setPending({ match: m, qty, onHand: oh.qty, bin: oh.bin }); return; }
    void addLine(m, qty, plan.filled, 0);
  };

  const keyed = async () => {
    const parsed = parseCounterEntry(entry);
    if (!parsed || !p.companyId) return;
    const qty = parsed.qty !== 1 ? parsed.qty : parseNum(qtyText) ?? 1;
    if (qty <= 0) return;
    setSearching(true);
    const r = await api.get<CounterSearch>('/api/dealer/parts', { companyId: p.companyId, pn: parsed.pn });
    setSearching(false);
    if (r.error) { setLookup({ kind: 'not_found', keyed: parsed.pn, message: r.error.error }); return; }
    const ms = r.data?.matches ?? [];
    setMatches(ms);
    setSuggest(r.data?.suggestions ?? []);
    const state = counterLookup(parsed.pn, ms);
    setLookup(state);
    if (state.kind === 'found' || state.kind === 'superseded') {
      const m = ms.find((x) => x.resolved.id === state.part.id)!;
      setQtyText(String(qty));
      take(m, qty);
    }
  };

  useHotkey('mod+enter', () => { if (open && ticket?.lines.length) void closeTicket(); }, { description: 'Close the ticket', enabled: open, allowInInputs: true });
  useHotkey('escape', () => { if (pending) { setPending(null); focusKey(); return; } setLookup({ kind: 'empty' }); }, { enabled: !!pending || lookup.kind !== 'empty' });

  const closeTicket = async () => {
    if (!t) return;
    const r = await act<{ outboxId: string | null; ticket: { number: string; totals: Record<string, number> | null } | null }>('close', 'post', `/api/dealer/tickets/${t.id}`, { op: 'close', paymentMethod: pay }, `Closed ${t.number}`);
    if (r.data) {
      const tt = r.data.ticket?.totals ?? {};
      setClosed({ number: r.data.ticket?.number ?? t.number, totalCents: Number(tt.parts_cents ?? 0) + Number(tt.core_charges_cents ?? 0) + Number(tt.tax_estimate_cents ?? 0), outbox: !!r.data.outboxId });
      setTicketId(null); setCustomer({ id: null, name: '' }); setPay('CASH'); setLookup({ kind: 'empty' });
      focusKey();
    }
  };

  const newTicket = () => { setTicketId(null); setClosed(null); setCustomer({ id: null, name: '' }); setLookup({ kind: 'empty' }); setEntry(''); focusKey(); };
  useHotkey('n', newTicket, { description: 'New counter ticket', enabled: !!closed });

  if (!p.stockLocations.length) {
    return <InlineNotice tone="info" title="Add a parts stock location first.">The counter sells from a stock location (the parts room). Add one in <Link className="link" href="/stock/settings">Store settings</Link>.</InlineNotice>;
  }

  return (
    <div className="dl-counter">
      <div style={{ minWidth: 0 }} className="stack">
        {!readOnly && p.companyId && (
          <form className="dl-key" onSubmit={(e) => { e.preventDefault(); void keyed(); }}>
            <Field label="Qty"><Input inputMode="decimal" value={qtyText} onChange={(e) => setQtyText(e.target.value)} aria-label="Quantity" /></Field>
            <Field label="Part number" help={'Enter adds it. "3*AM125172" sets the quantity.'}>
              <Input ref={keyRef} autoFocus value={entry} onChange={(e) => { setEntry(e.target.value); if (lookup.kind !== 'superseded') setLookup({ kind: 'empty' }); }} placeholder="Key or scan a part number" autoComplete="off" autoCapitalize="characters" spellCheck={false} aria-label="Part number" />
            </Field>
            <Button type="submit" variant="primary" disabled={searching || !entry.trim()}>{searching ? 'Looking…' : 'Add'}</Button>
          </form>
        )}
        <LookupResult lookup={lookup} matches={matches} suggest={suggest} pending={pending} hasCustomer={!!customer.id || !!t?.customer_id} busy={busy === 'line'}
          onPick={(m) => take(m, parseNum(qtyText) ?? 1)}
          onFillShort={(pd) => void addLine(pd.match, pd.qty, Math.max(0, Math.min(pd.qty, pd.onHand)), 0)}
          onSpecial={(pd) => void addLine(pd.match, pd.qty, Math.max(0, Math.min(pd.qty, pd.onHand)), Math.round((pd.qty - Math.max(0, Math.min(pd.qty, pd.onHand))) * 10_000) / 10_000)}
          onCancel={() => { setPending(null); focusKey(); }} />

        {closed && !ticketId && (
          <WidgetState state={{ kind: 'done', title: `Closed ${closed.number}`, body: `${money(closed.totalCents)} with the tax estimate. ${closed.outbox ? 'Merit Books gets the sale and computes the final tax.' : 'Nothing left the shelf, so no sale went to Merit Books.'}`, action: <Button variant="primary" chord="n" onClick={newTicket}>New ticket</Button> }} />
        )}

        {ticketId && !ticket && <WidgetState state={loadError ? { kind: 'error', title: 'The ticket did not load', body: loadError, onRetry: () => void refetch(), retryLabel: 'Try again' } : { kind: 'loading', label: 'Loading the ticket…', lines: 3 }} />}

        {ticket && (
          <table className="dl-lines" aria-label={`Lines on ${ticket.ticket.number}`}>
            <thead><tr><th>Part</th><th>Bin</th><th className="n">Asked</th><th className="n">Sold</th><th className="n">Special order</th><th className="n">Price</th><th className="n">Amount</th>{open && <th><span className="sr">Remove</span></th>}</tr></thead>
            <tbody>
              {ticket.lines.length === 0 && <tr><td colSpan={open ? 8 : 7} className="t-cap">No lines yet. Key the first part number above.</td></tr>}
              {ticket.lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    <span className="l1 b">{l.part_number}{l.manufacturer ? <span className="ink-3"> · {l.manufacturer}</span> : null}</span>
                    <span className="l2">{l.description}{l.requested_number ? ` · keyed ${l.requested_number} (superseded)` : ''}{l.core_charge_cents ? ` · core ${money(l.core_charge_cents)}` : ''}</span>
                  </td>
                  <td>{l.bin ?? '—'}<span className="l2">{count(l.on_hand)} on hand</span></td>
                  <td className="n">{open ? <Input aria-label={`Quantity asked for ${l.part_number}`} inputMode="decimal" defaultValue={String(l.qty_requested)} onBlur={(e) => { const q = parseNum(e.target.value); if (q != null && q > 0 && q !== l.qty_requested) { const plan = fillPlan(q, l.on_hand + 0, p.allowNegative); void act('upd', 'post', `/api/dealer/tickets/${ticket.ticket.id}`, { op: 'update_line', lineId: l.id, qty: q, qtyFilled: plan.filled, qtySpecialOrder: Math.min(l.qty_special_order, plan.short) }, 'Saved the quantity'); } }} /> : l.qty_requested}</td>
                  <td className="n">{l.qty_filled}</td>
                  <td className="n">{l.qty_special_order || '—'}</td>
                  <td className="n">{open ? <PriceCell label={`Price for ${l.part_number}`} cents={l.unit_price_cents} onCommit={(v) => void act('upd', 'post', `/api/dealer/tickets/${ticket.ticket.id}`, { op: 'update_line', lineId: l.id, unitPriceCents: v }, 'Saved the price')} /> : money(l.unit_price_cents)}</td>
                  <td className="n">{money(l.amount_cents)}</td>
                  {open && <td><Button variant="quiet" iconOnly icon="x" aria-label={`Remove ${l.part_number}`} disabled={busy === `rm:${l.id}`} onClick={() => void act(`rm:${l.id}`, 'post', `/api/dealer/tickets/${ticket.ticket.id}`, { op: 'remove_line', lineId: l.id }, `Removed ${l.part_number}`)} /></td>}
                </tr>
              ))}
            </tbody>
            {ticket.lines.length > 0 && <tfoot><tr><td colSpan={6}>Parts</td><td className="n">{money(totals.parts_cents)}</td>{open && <td />}</tr></tfoot>}
          </table>
        )}
        {error && <Failure text={error} />}
        <Keybar hints={[{ chord: 'enter', label: 'add the part' }, { chord: 'mod+enter', label: 'close the ticket' }, { chord: 'escape', label: 'clear' }, ...(closed ? [{ chord: 'n', label: 'new ticket' }] : [])]} note="On-hand is a count; Merit Books values the parts inventory" />
      </div>

      <aside className="stack" aria-label="Ticket">
        <div className="dl-card">
          <div className="dl-card-h"><h2 className="t-section">{t ? t.number : 'New ticket'}</h2><span className="sp" />{t && <StatusMark mark={TICKET_STATUS[t.status]} />}</div>
          <div className="dl-card-b mp-form">
            <Field label="Customer" help="Blank is a cash sale. Charge and special orders need one.">
              <CustomerPicker value={customer} companyId={p.companyId} onChange={(c) => { setCustomer(c); if (t && c.id && c.id !== t.customer_id) void act('cust', 'post', `/api/dealer/tickets/${t.id}`, { op: 'header', customerId: c.id }, `Customer set to ${c.name}`); }} />
            </Field>
            {!t && p.stockLocations.length > 1 && (
              <Field label="Sell from">
                <Select value={sl} onChange={(e) => setSl(e.target.value)}>{p.stockLocations.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}</Select>
              </Field>
            )}
            {t && open && (
              <div className="mp-form-2">
                <Field label="PO number"><Input defaultValue={t.po_number ?? ''} maxLength={40} onBlur={(e) => { if (e.target.value.trim() !== (t.po_number ?? '')) void act('po', 'post', `/api/dealer/tickets/${t.id}`, { op: 'header', poNumber: e.target.value.trim() || null }, 'Saved the PO number'); }} /></Field>
                <Field label="Tax"><Check label="Exempt" checked={t.tax_exempt} onChange={(e) => void act('tax', 'post', `/api/dealer/tickets/${t.id}`, { op: 'header', taxExempt: e.target.checked }, e.target.checked ? 'Marked tax exempt' : 'Tax exemption removed')} /></Field>
              </div>
            )}
            <ul className="dl-totals">
              <li><span>Parts</span><span className="v">{money(totals.parts_cents)}</span></li>
              {totals.core_charges_cents > 0 && <li><span>Core charges</span><span className="v">{money(totals.core_charges_cents)}</span></li>}
              <li className="muted"><span>Sales tax estimate</span><span className="v">{money(totals.tax_estimate_cents)}</span></li>
              <li className="muted"><span className="t-cap">Merit Books calculates the final tax.</span><span /></li>
            </ul>
            <div className="dl-total-big"><span>Total</span><span className="v">{money(totals.total_estimate_cents)}</span></div>
            {open && (
              <>
                <div className="dl-pay" role="group" aria-label="Payment method">
                  {PAYMENT_METHODS.map((m) => <Button key={m} aria-pressed={pay === m} onClick={() => setPay(m)} disabled={m === 'CHARGE' && !customer.id && !t?.customer_id}>{PAYMENT_WORDS[m]}</Button>)}
                </div>
                <Button variant="primary" size="lg" chord="mod+enter" disabled={busy === 'close' || !ticket?.lines.length || (pay === 'CHARGE' && !t?.customer_id)} onClick={() => void closeTicket()}>Close ticket · {PAYMENT_WORDS[pay].toLowerCase()}</Button>
                <Button variant="quiet" disabled={busy === 'void'} onClick={() => void act('void', 'post', `/api/dealer/tickets/${t!.id}`, { op: 'void', reason: null }, `Voided ${t!.number}`).then((r) => { if (r.data) newTicket(); })}>Void ticket</Button>
              </>
            )}
            {isLoading && ticketId && <span className="t-cap">Refreshing…</span>}
          </div>
        </div>
        <OpenTickets tickets={p.tickets} customers={p.customers} current={ticketId} onResume={(id) => { setTicketId(id); setClosed(null); focusKey(); }} />
        {!p.companyId && <p className="t-cap">Switch to one store to ring up a ticket.</p>}
        <ButtonLink variant="quiet" href="/parts?tab=catalog">Parts catalog</ButtonLink>
      </aside>
    </div>
  );
}

function LookupResult({ lookup, matches, suggest, pending, hasCustomer, busy, onPick, onFillShort, onSpecial, onCancel }: {
  lookup: CounterLookup; matches: Match[]; suggest: CounterSearch['suggestions']; pending: Pending | null; hasCustomer: boolean; busy: boolean;
  onPick: (m: Match) => void; onFillShort: (p: Pending) => void; onSpecial: (p: Pending) => void; onCancel: () => void;
}) {
  if (pending) {
    const short = Math.round((pending.qty - Math.max(0, Math.min(pending.qty, pending.onHand))) * 10_000) / 10_000;
    return (
      <div className="dl-found" role="alert">
        <span className="pn">{pending.match.resolved.part_number}</span> <span className="ink-3">{pending.match.resolved.description}</span>
        <p style={{ marginTop: 8 }}><b>Short {count(short)}.</b> {count(Math.max(0, pending.onHand))} on hand{pending.bin ? ` in ${pending.bin}` : ''}, {count(pending.qty)} asked for.</p>
        <div className="btn-row" style={{ marginTop: 8 }}>
          <Button variant="primary" autoFocus disabled={busy || !hasCustomer} onClick={() => onSpecial(pending)}>Special order {count(short)}</Button>
          {pending.onHand > 0 && <Button disabled={busy} onClick={() => onFillShort(pending)}>Sell the {count(pending.onHand)} on hand</Button>}
          <Button variant="quiet" onClick={onCancel}>Cancel</Button>
        </div>
        {!hasCustomer && <p className="t-cap" style={{ marginTop: 4 }}>A special order needs the customer. Pick them on the right first.</p>}
      </div>
    );
  }
  switch (lookup.kind) {
    case 'empty':
    case 'found':
      return null;
    case 'superseded':
      return <div className="dl-found"><p className="dl-note info">{lookup.message}</p></div>;
    case 'obsolete':
      return <div className="dl-found"><p className="dl-note">{lookup.message}</p></div>;
    case 'not_found':
      return (
        <div className="dl-found">
          <p className="dl-note">{lookup.message}</p>
          {suggest.length > 0 && (
            <ul className="feed feed--flush" style={{ marginTop: 8 }}>
              {suggest.map((s) => <li key={s.id}><span className="l1" style={{ fontWeight: 400 }}><b>{s.part_number}</b> {s.description}</span><span className="t">{s.manufacturer ?? ''}</span></li>)}
            </ul>
          )}
          <p style={{ marginTop: 8 }}><Link className="link" href={`/parts?tab=catalog&new=${encodeURIComponent(lookup.keyed)}`}>Add {lookup.keyed} to the catalog</Link></p>
        </div>
      );
    case 'choose':
      return (
        <div className="dl-found">
          <p>{lookup.message}</p>
          <div className="btn-row" style={{ marginTop: 8 }}>
            {lookup.options.map((o, i) => { const m = matches.find((x) => x.resolved.id === o.id)!; return <Button key={o.id} autoFocus={i === 0} onClick={() => onPick(m)}>{o.manufacturer ?? 'No line'} · {o.part_number}</Button>; })}
          </div>
        </div>
      );
  }
}

/** A price that saves when the field loses focus. */
function PriceCell({ label, cents, onCommit }: { label: string; cents: number; onCommit: (cents: number) => void }) {
  const [v, setV] = useState<number | null>(cents);
  useEffect(() => setV(cents), [cents]);
  return <MoneyInput aria-label={label} valueCents={v} onChangeCents={setV} onBlur={() => { if (v != null && v !== cents) onCommit(v); }} style={{ width: 110 }} />;
}

function OpenTickets({ tickets, customers, current, onResume }: { tickets: TicketRow[]; customers: Record<string, string>; current: string | null; onResume: (id: string) => void }) {
  const open = tickets.filter((t) => t.status === 'OPEN' && t.id !== current);
  const closed = tickets.filter((t) => t.status === 'CLOSED').slice(0, 5);
  if (!open.length && !closed.length) return null;
  return (
    <div className="dl-card">
      <div className="dl-card-h"><h2 className="t-section">Tickets</h2><span className="sp" /><span className="t-cap">{count(open.length)} open</span></div>
      <div className="dl-card-b">
        <ul className="feed feed--flush">
          {open.map((t) => (
            <li key={t.id}>
              <button type="button" className="nlink" style={{ background: 'none', border: 0, padding: 0, textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit' }} onClick={() => onResume(t.id)}>
                <span className="l1">{t.number}</span><span className="l2">{t.customer_id ? customers[t.customer_id] ?? 'Customer' : 'Cash sale'} · resume</span>
              </button>
              <span className="t">Open</span>
            </li>
          ))}
          {closed.map((t) => (
            <li key={t.id}>
              <span><span className="l1" style={{ fontWeight: 400 }}>{t.number}</span><span className="l2">{t.customer_id ? customers[t.customer_id] ?? 'Customer' : 'Cash sale'}{t.payment_method ? ` · ${PAYMENT_WORDS[t.payment_method].toLowerCase()}` : ''}</span></span>
              <span className="t tnum">{money(Number(t.totals?.parts_cents ?? 0))}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
