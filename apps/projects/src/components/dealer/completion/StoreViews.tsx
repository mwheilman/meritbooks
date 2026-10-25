'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Button, ButtonRow, Field, InlineNotice, Input, QueueTable, Search, Select, Status, Textarea, count, useDebounce, type QueueColumn } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, centsFrom, day, pctText, qty, useBoard, useDo } from '@/components/dealer/common/depth';
import { m, type Opt } from './kit';

const API = '/api/dealer/store-desk';

// ── customer 360 (DLR-70) ─────────────────────────────────────────────────────────────────────────
interface C360 {
  customer: { id: string; name: string; email: string | null; phone: string | null; address_line1: string | null; city: string | null; state: string | null; tax_exempt: boolean; terms_days: number | null };
  contacts: Array<{ id: string; name: string; title: string | null; phone: string | null; email: string | null; is_primary: boolean; sms_consent: boolean }>;
  units: Array<{ id: string; make: string | null; model: string | null; serial_number: string | null; meter: number | null; warranty_expires_on: string | null; last_service_on: string | null }>;
  repair_orders: Array<{ id: string; number: string; status: string; stage: string | null; summary: string; unit: string; opened: string }>;
  deals: Array<{ id: string; number: string; stage: string; delivered_on: string | null; created_at: string }>;
  rentals: Array<{ id: string; number: string; status: string; unit: string; from: string; to: string }>;
  special_orders: Array<{ id: string; number: string; status: string; part_number: string; qty: number }>;
  texts: Array<{ kind: string; status: string; body: string; at: string }>;
  ar: { available: boolean; open_invoices?: number; credit_hold?: boolean; past_due_90?: boolean; balance_cents?: number | null; credit_limit_cents?: number | null; aging?: { current_30: number; d31_60: number; d61_90: number; over_90: number } | null };
  amounts_visible: boolean;
}

/** One customer across the store: units, ROs, deals, rentals, special orders, texts, and Books AR with the credit hold. */
export function Customer360View({ companyId, today, customers, initial }: { companyId: string; today: string; customers: Opt[]; initial: string | null }) {
  const [q, setQ] = useState('');
  const [pick, setPick] = useState<string | null>(initial);
  const t = useDebounce(q.trim().toLowerCase(), 200);
  const list = useMemo(() => (t ? customers.filter((c) => c.label.toLowerCase().includes(t) || (c.sub ?? '').toLowerCase().includes(t)) : customers).slice(0, 50), [customers, t]);
  const c = useBoard<C360>(pick ? `${API}?view=customer&company=${companyId}&customer=${pick}` : null);
  const x = c.data;
  return (
    <div className="stack">
      <div className="ops-toolbar">
        <Search aria-label="Find a customer" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, phone or account" style={{ minWidth: 280 }} />
      </div>
      {!pick && (list.length === 0 ? <Empty title="No customer matches" body="Try part of the name or the phone number." /> : (
        <div className="mp-table"><QueueTable aria-label="Customers" columns={[{ id: 'n', header: 'Customer', cell: (r: Opt) => <><span className="l1">{r.label}</span><span className="l2">{r.sub}</span></> }]} rows={list} getRowId={(r) => r.id} onOpen={(r) => setPick(r.id)} openOnClick /></div>
      ))}
      {pick && <ButtonRow><Button variant="quiet" onClick={() => setPick(null)}>Back to the list</Button></ButtonRow>}
      {pick && <BoardState b={c} what="The customer" />}
      {x && (
        <>
          <Section title={x.customer.name} meta={[x.customer.phone, x.customer.email, [x.customer.city, x.customer.state].filter(Boolean).join(', '), x.customer.tax_exempt ? 'tax exempt' : null].filter(Boolean).join(' · ')}>
            {x.ar.available && x.ar.credit_hold && <InlineNotice tone="neg" title="Credit hold.">Open invoices are over the credit limit. Collect before releasing equipment or taking a charge sale.</InlineNotice>}
            {x.ar.available && x.ar.past_due_90 && !x.ar.credit_hold && <InlineNotice tone="warn" title="Over 90 days past due.">Books shows an invoice more than 90 days late.</InlineNotice>}
            {x.ar.available ? (
              <p className="t-cap">{count(x.ar.open_invoices ?? 0)} open invoice(s){x.amounts_visible ? ` · ${m(x.ar.balance_cents)} owed${x.ar.credit_limit_cents != null ? ` of a ${m(x.ar.credit_limit_cents)} limit` : ''}` : ''}{x.ar.aging ? ` · 0–30 ${m(x.ar.aging.current_30)} · 31–60 ${m(x.ar.aging.d31_60)} · 61–90 ${m(x.ar.aging.d61_90)} · 90+ ${m(x.ar.aging.over_90)}` : ''}</p>
            ) : <p className="t-cap">Receivables show once Merit Books is connected.</p>}
            {x.contacts.length > 0 && <ul className="t-cap">{x.contacts.map((k) => <li key={k.id}>{k.name}{k.title ? `, ${k.title}` : ''} · {k.phone ?? k.email ?? ''}{k.is_primary ? ' · primary' : ''}{k.sms_consent ? ' · texts OK' : ''}</li>)}</ul>}
          </Section>
          <Section title="Equipment" meta={`${count(x.units.length)} units`}>
            {x.units.length === 0 ? <p className="t-cap">No equipment on file.</p> : <table className="ops-mini" aria-label="Customer equipment"><thead><tr><th>Unit</th><th>Serial</th><th className="n">Hours</th><th>Warranty</th><th>Last service</th></tr></thead>
              <tbody>{x.units.map((u) => <tr key={u.id}><td><Link className="nlink" href={`/stock/units/${u.id}/timeline`}>{[u.make, u.model].filter(Boolean).join(' ')}</Link></td><td>{u.serial_number}</td><td className="n">{qty(u.meter)}</td><td>{u.warranty_expires_on ? (u.warranty_expires_on >= today ? `to ${day(u.warranty_expires_on, today)}` : 'expired') : '—'}</td><td>{day(u.last_service_on, today)}</td></tr>)}</tbody></table>}
          </Section>
          <Section title="Service">
            {x.repair_orders.length === 0 ? <p className="t-cap">No repair orders.</p> : <ul>{x.repair_orders.map((r) => <li key={r.id}><Link className="nlink" href={`/work-orders/service?wo=${r.id}`}>{r.number}</Link> · {r.unit} · {r.summary} · <span className="t-cap">{(r.stage ?? r.status).toLowerCase().replace('_', ' ')} · {day(r.opened, today)}</span></li>)}</ul>}
          </Section>
          <Section title="Deals, rentals, special orders">
            <ul>
              {x.deals.map((d) => <li key={d.id}><Link className="nlink" href={`/deals/${d.id}`}>Deal {d.number}</Link> · {d.stage.toLowerCase()}{d.delivered_on ? ` · delivered ${day(d.delivered_on, today)}` : ''}</li>)}
              {x.rentals.map((r) => <li key={r.id}><Link className="nlink" href={`/rentals?contract=${r.id}`}>Rental {r.number}</Link> · {r.unit} · {r.status.toLowerCase()} · {day(r.from, today)}–{day(r.to, today)}</li>)}
              {x.special_orders.map((o) => <li key={o.id}>Special order {o.number} · {qty(o.qty)} × {o.part_number} · {o.status.toLowerCase()}</li>)}
              {x.deals.length + x.rentals.length + x.special_orders.length === 0 && <li className="t-cap">None.</li>}
            </ul>
          </Section>
          {x.texts.length > 0 && <Section title="Texts"><ul className="t-cap">{x.texts.map((t2, i) => <li key={i}>{day(t2.at, today)} · {t2.kind.toLowerCase()} · {t2.status}: {t2.body}</li>)}</ul></Section>}
        </>
      )}
    </div>
  );
}

// ── registers + drawer close (DLR-71) ─────────────────────────────────────────────────────────────
interface TenderVar { variance_cents: number; flagged: boolean }
interface DrawerBoard { day: string; blind_count: boolean; registers: Array<{ id: string; code: string; name: string; is_active: boolean; open_session: { id: string; opened_at: string; opened_by: string; opening_cash_cents: number; entries: number } | null }>; closed: Array<{ id: string; register: string; closed_at: string; variance_cents: number; flagged: boolean; by_tender: { cash: TenderVar; check: TenderVar; card: TenderVar; threshold_cents: number } | null; note: string | null; batch: { id: string; cash_cents: number; check_cents: number; card_cents: number; status: string } | null }>; entries: Array<{ id: string; session_id: string; source_kind: string; tender: string; amount_cents: number | null; blind: boolean; reference: string | null; note: string | null; at: string }> }
const DENOMS: Array<[string, number]> = [['100', 10000], ['50', 5000], ['20', 2000], ['10', 1000], ['5', 500], ['1', 100], ['Coins', 1]];

/** Open the drawer, take payments, count it out by denomination, and hand Books the deposit batch. */
export function DrawerView({ companyId, today }: { companyId: string; today: string }) {
  const { readOnly } = useShell();
  const [d, setD] = useState(today);
  const b = useBoard<DrawerBoard>(`${API}?view=drawer&company=${companyId}&day=${d}`);
  const { run, busy, error } = useDo(b.reload);
  const [openCash, setOpenCash] = useState('200.00');
  const [pay, setPay] = useState({ kind: 'REPAIR_ORDER', tender: 'CASH', amount: '', ref: '', note: '', number: '' });
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [other, setOther] = useState({ check: '', card: '', keep: '200.00', note: '' });
  const [reg, setReg] = useState({ code: '', name: '' });
  const [explain, setExplain] = useState<Record<string, string>>({});
  const cashCount = DENOMS.reduce((s, [k, v]) => s + (k === 'Coins' ? centsFrom(counts[k] ?? '') ?? 0 : (Number(counts[k]) || 0) * v), 0);
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <div className="ops-toolbar"><Field label="Business day"><Input type="date" value={d} max={today} onChange={(e) => setD(e.target.value)} /></Field></div>
      <BoardState b={b} what="Registers" />
      {b.data && (b.data.registers.length === 0 ? <Empty title="No registers" body="Add the counter's register below; each register has one open drawer at a time." /> : b.data.registers.map((r) => {
        const s = r.open_session;
        return (
          <Section key={r.id} title={`${r.code} · ${r.name}`} meta={s ? `Open since ${day(s.opened_at, today)} · ${count(s.entries)} payments` : 'Closed'}>
            {!s && !readOnly && d === today && <ButtonRow><Field label="Starting cash ($)"><Input inputMode="decimal" value={openCash} onChange={(e) => setOpenCash(e.target.value)} style={{ width: 110 }} /></Field><Button variant="primary" disabled={busy === r.id} onClick={() => void run(r.id, API, { op: 'open_drawer', registerId: r.id, openingCashCents: centsFrom(openCash) ?? 0 }, 'Drawer open')}>Open the drawer</Button></ButtonRow>}
            {s && (
              <>
                <p className="t-cap">Blind count: count the drawer first. What it should hold, and any variance by tender, shows once it is closed.</p>
                {!readOnly && (
                  <div className="ops-toolbar">
                    <Field label="For"><Select value={pay.kind} onChange={(e) => setPay({ ...pay, kind: e.target.value })}><option value="REPAIR_ORDER">RO</option><option value="DEAL_DEPOSIT">Deal deposit</option><option value="RENTAL">Rental</option><option value="SPECIAL_ORDER">Special order</option><option value="OTHER">Other</option><option value="PAYOUT">Paid out (cash)</option></Select></Field>
                    {['REPAIR_ORDER', 'DEAL_DEPOSIT', 'RENTAL', 'SPECIAL_ORDER'].includes(pay.kind) && <Field label="Number"><Input value={pay.number} onChange={(e) => setPay({ ...pay, number: e.target.value })} style={{ width: 130 }} placeholder="RO-2026-00012" /></Field>}
                    <Field label="Tender"><Select value={pay.tender} onChange={(e) => setPay({ ...pay, tender: e.target.value })}><option value="CASH">Cash</option><option value="CHECK">Check</option><option value="CARD">Card</option><option value="OTHER">Other</option></Select></Field>
                    <Field label="Amount ($)"><Input inputMode="decimal" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} style={{ width: 100 }} /></Field>
                    <Field label="Reference"><Input value={pay.ref} onChange={(e) => setPay({ ...pay, ref: e.target.value })} style={{ width: 120 }} /></Field>
                    <Field label="Note"><Input value={pay.note} onChange={(e) => setPay({ ...pay, note: e.target.value })} /></Field>
                    <Button disabled={!centsFrom(pay.amount) || busy === 'pay'} onClick={() => { const c = centsFrom(pay.amount) ?? 0; void run('pay', API, { op: 'payment', sessionId: s.id, sourceKind: pay.kind, tender: pay.tender, amountCents: pay.kind === 'PAYOUT' ? -Math.abs(c) : c, reference: pay.ref || null, note: pay.note || null, sourceNumber: pay.number.trim() || null }, 'Recorded').then((x) => { if (x) setPay({ ...pay, amount: '', ref: '', note: '', number: '' }); }); }}>Record</Button>
                  </div>
                )}
                {!readOnly && (
                  <div className="stack">
                    <div className="ops-toolbar">{DENOMS.map(([k]) => <Field key={k} label={k === 'Coins' ? 'Coins ($)' : `$${k} bills`}><Input inputMode="decimal" value={counts[k] ?? ''} onChange={(e) => setCounts({ ...counts, [k]: e.target.value })} style={{ width: 70 }} /></Field>)}</div>
                    <div className="ops-toolbar">
                      <Field label="Checks ($)"><Input inputMode="decimal" value={other.check} onChange={(e) => setOther({ ...other, check: e.target.value })} style={{ width: 100 }} /></Field>
                      <Field label="Card slips ($)"><Input inputMode="decimal" value={other.card} onChange={(e) => setOther({ ...other, card: e.target.value })} style={{ width: 100 }} /></Field>
                      <Field label="Keep in the drawer ($)"><Input inputMode="decimal" value={other.keep} onChange={(e) => setOther({ ...other, keep: e.target.value })} style={{ width: 110 }} /></Field>
                    </div>
                    <p className="t-cap">Counted cash {m(cashCount)}</p>
                    <Field label="Variance note (if the drawer is off; the first count is final)"><Textarea rows={2} value={other.note} onChange={(e) => setOther({ ...other, note: e.target.value })} /></Field>
                    <Button variant="primary" disabled={busy === 'close'} onClick={() => void run<{ deposit_cash_cents: number; flagged: boolean; note_required: boolean }>('close', API, { op: 'close_drawer', sessionId: s.id, cashCents: cashCount, checkCents: centsFrom(other.check) ?? 0, cardCents: centsFrom(other.card) ?? 0, keepFloatCents: centsFrom(other.keep), note: other.note || null,
                      denominations: Object.fromEntries(DENOMS.map(([k]) => [k, Number(counts[k]) || 0])) }, (x) => `Closed; deposit ${m(x.deposit_cash_cents)} cash ready for Books${x.flagged ? (x.note_required ? ' (variance flagged: explain it under Closed drawers)' : ' (variance flagged)') : ''}`).then((x) => { if (x) { setCounts({}); setOther({ check: '', card: '', keep: other.keep, note: '' }); } })}>Close the drawer</Button>
                  </div>
                )}
              </>
            )}
          </Section>
        );
      }))}
      {b.data && b.data.closed.length > 0 && (
        <Section title="Closed drawers" meta="Each close hands Books a deposit batch (cash over the float + checks); Books records the bank deposit">
          <table className="ops-mini" aria-label="Closed drawers"><thead><tr><th>Register</th><th>Closed</th><th className="n">Variance</th><th className="n">Deposit</th><th>Batch</th></tr></thead>
            <tbody>{b.data.closed.map((x) => <tr key={x.id}><td>{x.register}</td><td>{day(x.closed_at, today)}</td><td className="n">{x.flagged ? <Status kind="risk" pip="open">{m(x.variance_cents)}</Status> : m(x.variance_cents)}{x.by_tender && <div className="t-cap">cash {m(x.by_tender.cash.variance_cents)} · checks {m(x.by_tender.check.variance_cents)} · cards {m(x.by_tender.card.variance_cents)}</div>}{x.note ? <div className="t-cap">{x.note}</div> : x.flagged && !readOnly && <ButtonRow><Input aria-label="Explain the variance" placeholder="Explain the variance" value={explain[x.id] ?? ''} onChange={(e) => setExplain({ ...explain, [x.id]: e.target.value })} /><Button disabled={(explain[x.id] ?? '').trim().length < 5 || busy === x.id} onClick={() => void run(x.id, API, { op: 'note_variance', sessionId: x.id, note: explain[x.id] }, 'Explanation saved')}>Save</Button></ButtonRow>}</td><td className="n">{x.batch ? m(Number(x.batch.cash_cents) + Number(x.batch.check_cents)) : '—'}</td><td>{x.batch?.status.toLowerCase().replace('_', ' ') ?? '—'}</td></tr>)}</tbody></table>
        </Section>
      )}
      {b.data && b.data.entries.length > 0 && (
        <Section title="Payments today"><table className="ops-mini" aria-label="Payments"><thead><tr><th>When</th><th>For</th><th>Tender</th><th className="n">Amount</th></tr></thead>
          <tbody>{b.data.entries.map((e) => <tr key={e.id}><td>{day(e.at, today)}</td><td>{e.source_kind.toLowerCase().replace('_', ' ')}{e.reference ? ` · ${e.reference}` : ''}{e.note ? <div className="t-cap">{e.note}</div> : null}</td><td>{e.tender.toLowerCase()}</td><td className="n">{e.blind || e.amount_cents == null ? <span className="t-cap">after close</span> : m(e.amount_cents)}</td></tr>)}</tbody></table></Section>
      )}
      {!readOnly && (
        <Section title="Add a register">
          <ButtonRow>
            <Field label="Code"><Input value={reg.code} onChange={(e) => setReg({ ...reg, code: e.target.value.toUpperCase() })} style={{ width: 80 }} /></Field>
            <Field label="Name"><Input value={reg.name} onChange={(e) => setReg({ ...reg, name: e.target.value })} /></Field>
            <Button disabled={!reg.code || !reg.name || busy === 'reg'} onClick={() => void run('reg', API, { op: 'save_register', companyId, code: reg.code, name: reg.name }, 'Register saved').then(() => setReg({ code: '', name: '' }))}>Save</Button>
          </ButtonRow>
        </Section>
      )}
    </div>
  );
}

// ── price limits + overrides + PIN (DLR-77) ───────────────────────────────────────────────────────
interface Override { id: string; status: string; source_kind: string; parent_id: string; description: string | null; base_price_cents: number; requested_price_cents: number; discount_pct: number; below_cost: boolean; cost_cents: number | null; reason: string; requester: string | null; decided_by: string | null; method: string | null; decided_at: string | null; decision_note: string | null; created_at: string }
interface Pricing { limits: Array<{ role_key: string; max_discount_pct: number; allow_below_cost: boolean }>; overrides: Override[]; patterns: Array<{ person: string; overrides: number; avg_discount_pct: number; unusual: boolean }>; amounts_visible: boolean }
const ROLE_WORDS: Record<string, string> = { default: 'Everyone else', projects_owner: 'Owner', projects_gm: 'General manager', projects_pm: 'Project manager', projects_supervisor: 'Supervisor', projects_labor: 'Field', projects_dispatcher: 'Dispatcher', projects_accountant: 'Accounting' };

/** Discount limits by role; overrides over the limit wait for another manager (or their PIN at the counter). */
export function PricingView({ companyId, today, managers }: { companyId: string; today: string; managers: Opt[] }) {
  const { readOnly } = useShell();
  const b = useBoard<Pricing>(`${API}?view=pricing&company=${companyId}`);
  const { run, busy, error } = useDo(b.reload);
  const [lim, setLim] = useState<Record<string, { pct: string; below: boolean }> | null>(null);
  const [pinFor, setPinFor] = useState<{ id: string; manager: string; pin: string } | null>(null);
  const [myPin, setMyPin] = useState('');
  const rows = b.data?.limits ?? [];
  const cur = lim ?? Object.fromEntries((rows.length ? rows : [{ role_key: 'default', max_discount_pct: 0.05, allow_below_cost: false }]).map((r) => [r.role_key, { pct: String(Math.round(Number(r.max_discount_pct) * 1000) / 10), below: r.allow_below_cost }]));
  const cols: QueueColumn<Override>[] = [
    { id: 'l', header: 'Line', cell: (r) => <><span className="l1">{r.description ?? 'Line'}</span><span className="l2">{r.requester ?? 'Someone'} · {r.reason}</span></> },
    { id: 'p', header: 'Price', numeric: true, width: 150, cell: (r) => <>{m(r.requested_price_cents)}<div className="t-cap">list {m(r.base_price_cents)} · {pctText(r.discount_pct)} off{r.below_cost ? ' · below cost' : ''}</div></> },
    { id: 's', header: 'Status', width: 150, cell: (r) => <Status kind={r.status === 'PENDING' ? 'risk' : r.status === 'REJECTED' ? 'blocked' : 'ready'} pip="open">{r.status.toLowerCase().replace('_', ' ')}{r.method ? ` · ${r.method.toLowerCase()}` : ''}</Status> },
    ...(readOnly ? [] : [{ id: 'a', header: <span className="sr">Decide</span>, width: 260, cell: (r: Override) => r.status !== 'PENDING' ? <span className="t-cap">{r.decided_by ?? ''} {day(r.decided_at, today)}</span> : (
      <ButtonRow>
        <Button disabled={busy === r.id} onClick={() => void run(r.id, API, { op: 'decide_override', overrideId: r.id, decision: 'APPROVE' }, 'Approved; the price is on the line')}>Approve</Button>
        <Button variant="quiet" disabled={busy === r.id} onClick={() => { const why = window.prompt('Why is the price refused?'); if (why) void run(r.id, API, { op: 'decide_override', overrideId: r.id, decision: 'REJECT', note: why }, 'Refused'); }}>Refuse</Button>
        <Button variant="quiet" onClick={() => setPinFor({ id: r.id, manager: managers[0]?.id ?? '', pin: '' })}>Manager PIN</Button>
      </ButtonRow>) } satisfies QueueColumn<Override>]),
  ];
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <BoardState b={b} what="Pricing controls" />
      {b.data && (
        <>
          <Section title="Overrides" meta={`${count(b.data.overrides.filter((o) => o.status === 'PENDING').length)} waiting`}>
            {b.data.overrides.length === 0 ? <Empty title="No overrides" body="A counter or RO price below the person's limit asks for an override with a reason; it shows here." /> :
              <div className="mp-table"><QueueTable aria-label="Price overrides" columns={cols} rows={b.data.overrides} getRowId={(r) => r.id} onOpen={(r) => { window.location.assign(r.source_kind === 'RO_LINE' ? `/work-orders/service?wo=${r.parent_id}` : `/parts/counter?ticket=${r.parent_id}`); }} openOnClick rowState={(r) => ({ attn: r.status === 'PENDING' })} /></div>}
            {pinFor && (
              <ButtonRow>
                <Field label="Manager"><Select value={pinFor.manager} onChange={(e) => setPinFor({ ...pinFor, manager: e.target.value })}>{managers.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</Select></Field>
                <Field label="PIN"><Input type="password" inputMode="numeric" autoComplete="off" value={pinFor.pin} onChange={(e) => setPinFor({ ...pinFor, pin: e.target.value })} style={{ width: 100 }} /></Field>
                <Button variant="primary" disabled={!/^\d{6,12}$/.test(pinFor.pin) || busy === 'pin'} onClick={() => void run<{ status: string; error?: string }>('pin', API, { op: 'approve_pin', overrideId: pinFor.id, managerId: pinFor.manager, pin: pinFor.pin }, (x) => x.error === 'PIN_MISMATCH' ? 'That PIN does not match' : 'Approved with the manager PIN').then(() => setPinFor(null))}>Approve</Button>
                <Button variant="quiet" onClick={() => setPinFor(null)}>Cancel</Button>
              </ButtonRow>
            )}
          </Section>
          {b.data.patterns.length > 0 && (
            <Section title="Discounting by person (30 days)">
              <table className="ops-mini" aria-label="Discount patterns"><thead><tr><th>Person</th><th className="n">Overrides</th><th className="n">Average off</th></tr></thead>
                <tbody>{b.data.patterns.map((p) => <tr key={p.person}><td>{p.person}{p.unusual ? <div className="neg t-cap">well above the store</div> : null}</td><td className="n">{count(p.overrides)}</td><td className="n">{pctText(p.avg_discount_pct)}</td></tr>)}</tbody></table>
            </Section>
          )}
          {!readOnly && (
            <Section title="Discount limits by role" meta="No limits = no controls; the database refuses a price under the person's limit without an override">
              {Object.entries(cur).map(([k, v]) => <ButtonRow key={k}><span className="l1" style={{ minWidth: 180 }}>{ROLE_WORDS[k] ?? k}</span><Field label="Max % off"><Input inputMode="decimal" value={v.pct} onChange={(e) => setLim({ ...cur, [k]: { ...v, pct: e.target.value } })} style={{ width: 70 }} /></Field>
                <Field label="Below cost"><Select value={v.below ? 'y' : 'n'} onChange={(e) => setLim({ ...cur, [k]: { ...v, below: e.target.value === 'y' } })}><option value="n">Not allowed</option><option value="y">Allowed</option></Select></Field></ButtonRow>)}
              <ButtonRow>
                <Select aria-label="Add a role" value="" onChange={(e) => e.target.value && setLim({ ...cur, [e.target.value]: { pct: '10', below: false } })}><option value="">Add a role…</option>{Object.keys(ROLE_WORDS).filter((k) => !(k in cur)).map((k) => <option key={k} value={k}>{ROLE_WORDS[k]}</option>)}</Select>
                <Button variant="primary" disabled={busy === 'lim'} onClick={() => void run('lim', API, { op: 'price_limits', companyId, rows: Object.entries(cur).map(([role_key, v]) => ({ role_key, max_discount_pct: Math.min(Math.max((Number(v.pct) || 0) / 100, 0), 1), allow_below_cost: v.below })) }, 'Limits saved').then(() => setLim(null))}>Save limits</Button>
                <Button variant="quiet" disabled={busy === 'lim'} onClick={() => { if (window.confirm('Turn pricing controls off at this store?')) void run('lim', API, { op: 'price_limits', companyId, rows: [] }, 'Controls off').then(() => setLim(null)); }}>Turn controls off</Button>
              </ButtonRow>
              <ButtonRow>
                <Field label="My manager PIN (6–12 digits, not a run or repeat)"><Input type="password" inputMode="numeric" autoComplete="new-password" value={myPin} onChange={(e) => setMyPin(e.target.value)} style={{ width: 120 }} /></Field>
                <Button disabled={!/^\d{6,12}$/.test(myPin) || busy === 'mypin'} onClick={() => void run('mypin', API, { op: 'set_pin', pin: myPin }, 'PIN saved').then(() => setMyPin(''))}>Save my PIN</Button>
              </ButtonRow>
            </Section>
          )}
        </>
      )}
    </div>
  );
}

// ── day / month store close (DLR-80) ──────────────────────────────────────────────────────────────
interface CloseItem { key: string; label: string; count: number; ok: boolean; link: string }
interface CloseList { kind: string; date: string; items: CloseItem[]; open: number; books_period: { available: boolean; status: string; month_start: string; month_end: string }; signed: { by: string; at: string; note: string | null; open_count: number } | null }

export function StoreCloseView({ companyId, today }: { companyId: string; today: string }) {
  const { readOnly } = useShell();
  const [kind, setKind] = useState<'DAY' | 'MONTH'>('DAY');
  const [d, setD] = useState(today);
  const b = useBoard<CloseList>(`${API}?view=close&company=${companyId}&kind=${kind}&date=${d}`);
  const { run, busy, error } = useDo(b.reload);
  const [note, setNote] = useState('');
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <div className="ops-toolbar">
        <Field label="Close"><Select value={kind} onChange={(e) => setKind(e.target.value as 'DAY' | 'MONTH')}><option value="DAY">Day end</option><option value="MONTH">Month end</option></Select></Field>
        <Field label="Date"><Input type="date" value={d} max={today} onChange={(e) => setD(e.target.value)} /></Field>
      </div>
      <BoardState b={b} what="The close checklist" />
      {b.data && (
        <Section title={kind === 'DAY' ? `Day end ${day(b.data.date, today)}` : `Month end ${day(b.data.books_period.month_end, today)}`} meta={b.data.signed ? `Signed by ${b.data.signed.by} ${day(b.data.signed.at, today)}` : `${count(b.data.open)} open item(s)`}>
          <table className="ops-mini" aria-label="Close checklist"><thead><tr><th>Check</th><th className="n">Open</th><th><span className="sr">Go</span></th></tr></thead>
            <tbody>{b.data.items.map((i) => <tr key={i.key}><td><Status kind={i.ok ? 'ready' : 'risk'} pip="open">{i.label}</Status></td><td className="n">{count(i.count)}</td><td>{!i.ok && <Link className="nlink" href={i.link}>Open</Link>}</td></tr>)}</tbody></table>
          <p className="t-cap">Books period: {b.data.books_period.available ? b.data.books_period.status.toLowerCase().replace('_', ' ') : 'not connected'}. Books owns the close of the books; this is the store&apos;s own sign-off.</p>
          {!readOnly && (
            <>
              <Field label="Note (required to sign with items open)"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
              <Button variant="primary" disabled={busy === 'sign'} onClick={() => void run('sign', API, { op: 'sign_close', companyId, kind, date: d, note: note || null }, 'Signed off').then(() => setNote(''))}>Sign the {kind === 'DAY' ? 'day' : 'month'} close</Button>
            </>
          )}
        </Section>
      )}
    </div>
  );
}

// ── completion settings ───────────────────────────────────────────────────────────────────────────
interface Cfg { settings: Record<string, unknown>; capacity: Record<string, number>; fee_rules: Array<{ id: string; code: string; label: string; kind: string; basis: string; pct: number; amount_cents: number; min_cents: number; cap_cents: number | null; is_active: boolean }> }
const WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function CompletionSettingsView({ companyId }: { companyId: string }) {
  const { readOnly } = useShell();
  const b = useBoard<Cfg>(`${API}?view=config&company=${companyId}`);
  const { run, busy, error } = useDo(b.reload);
  const [s, setS] = useState<Record<string, string | boolean> | null>(null);
  const [cap, setCap] = useState<Record<string, string> | null>(null);
  const [fee, setFee] = useState({ code: 'SHOP', label: 'Shop supplies', basis: 'PCT_LABOR', pct: '10', min: '', cap: '' });
  if (!b.data) return <BoardState b={b} what="Settings" />;
  const st = b.data.settings;
  const v = s ?? { lot_lat: String(st.lot_lat ?? ''), lot_lng: String(st.lot_lng ?? ''), lot_radius_m: String(st.lot_radius_m ?? 400), recon_required: Boolean(st.recon_required), qc_required: Boolean(st.qc_required),
    internal_route_required: Boolean(st.internal_route_required), special_order_text: Boolean(st.special_order_text), storage_free_days: String(st.storage_free_days ?? 3), storage_daily: String(Number(st.storage_daily_cents ?? 0) / 100),
    lien_notice_days: String(st.lien_notice_days ?? 30), rerent_inspection_required: Boolean(st.rerent_inspection_required), cit_stale_days: String(st.cit_stale_days ?? 10), cycle_days: String(st.cycle_days ?? 28),
    drawer_variance: String(Number(st.drawer_variance_cents ?? 500) / 100), service_job_type_key: String(st.service_job_type_key ?? 'customer_repair'),
    labor_rate: st.labor_rate_cents == null ? '' : String(Number(st.labor_rate_cents) / 100),
    paper: ((st.rental_out_requires as string[] | undefined) ?? []).join(',') };
  const c = cap ?? Object.fromEntries(WEEK.map((_, i) => [String(i), String(b.data!.capacity[String(i)] ?? (i === 0 || i === 6 ? 0 : Number(st.daily_tech_hours ?? 32)))]));
  const bool = (k: string, label: string) => <Field label={label}><Select disabled={readOnly} value={v[k] ? 'y' : 'n'} onChange={(e) => setS({ ...v, [k]: e.target.value === 'y' })}><option value="y">On</option><option value="n">Off</option></Select></Field>;
  const txt = (k: string, label: string, w = 90) => <Field label={label}><Input disabled={readOnly} value={String(v[k] ?? '')} onChange={(e) => setS({ ...v, [k]: e.target.value })} style={{ width: w }} /></Field>;
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <Section title="Store rules">
        <div className="ops-toolbar">{txt('lot_lat', 'Lot latitude', 110)}{txt('lot_lng', 'Lot longitude', 110)}{txt('lot_radius_m', 'Lot radius (m)')}{txt('service_job_type_key', 'Service job type', 140)}</div>
        <div className="ops-toolbar">{bool('recon_required', 'Recon on trade-ins')}{bool('qc_required', 'QC before ready')}{bool('internal_route_required', 'Route internal lines')}{bool('special_order_text', 'Text special orders')}{bool('rerent_inspection_required', 'Re-rent inspection')}</div>
        <div className="ops-toolbar">{txt('storage_free_days', 'Free storage days')}{txt('storage_daily', 'Storage per day ($)')}{txt('lien_notice_days', 'Lien notice after (days)')}{txt('cit_stale_days', 'Contracts in transit limit (days)')}{txt('cycle_days', 'Rental cycle (days)')}{txt('drawer_variance', 'Drawer variance flag ($)')}</div>
        <div className="ops-toolbar">{txt('labor_rate', 'Posted labor rate ($/h)', 110)}</div>
        {txt('paper', 'Rental paperwork required (license, coi, card_hold, waiver, safety_briefing, signature)', 420)}
        {!readOnly && <Button variant="primary" disabled={busy === 'set'} onClick={() => {
          const n = (k: string) => (String(v[k]).trim() === '' ? null : Number(v[k]));
          void run('set', API, { op: 'settings', companyId, patch: {
            lot_lat: n('lot_lat'), lot_lng: n('lot_lng'), lot_radius_m: Number(v.lot_radius_m) || 400, recon_required: Boolean(v.recon_required), qc_required: Boolean(v.qc_required), internal_route_required: Boolean(v.internal_route_required),
            special_order_text: Boolean(v.special_order_text), rerent_inspection_required: Boolean(v.rerent_inspection_required), storage_free_days: Number(v.storage_free_days) || 0, storage_daily_cents: centsFrom(String(v.storage_daily)) ?? 0,
            lien_notice_days: Number(v.lien_notice_days) || 30, cit_stale_days: Number(v.cit_stale_days) || 10, cycle_days: Number(v.cycle_days) || 28, drawer_variance_cents: centsFrom(String(v.drawer_variance)) ?? 500, labor_rate_cents: String(v.labor_rate).trim() === '' ? null : centsFrom(String(v.labor_rate)),
            service_job_type_key: String(v.service_job_type_key), rental_out_requires: String(v.paper).split(',').map((x) => x.trim()).filter(Boolean),
          } }, 'Settings saved').then(() => setS(null));
        }}>Save the rules</Button>}
      </Section>
      <Section title="Shop capacity" meta="Tech hours you can sell each weekday (the appointment book fills against these)">
        <div className="ops-toolbar">{WEEK.map((w, i) => <Field key={w} label={w}><Input disabled={readOnly} inputMode="decimal" value={c[String(i)] ?? ''} onChange={(e) => setCap({ ...c, [String(i)]: e.target.value })} style={{ width: 64 }} /></Field>)}</div>
        {!readOnly && <Button disabled={busy === 'cap'} onClick={() => void run('cap', '/api/dealer/service-desk', { op: 'set_capacity', companyId, weekdays: Object.fromEntries(Object.entries(c).map(([k, x]) => [k, Number(x) || 0])) }, 'Capacity saved').then(() => setCap(null))}>Save capacity</Button>}
      </Section>
      <Section title="Shop fees" meta="Shop supplies, environmental and disposal fees added to customer ROs by rule">
        {b.data.fee_rules.length === 0 ? <p className="t-cap">No fee rules.</p> : <table className="ops-mini" aria-label="Fee rules"><thead><tr><th>Fee</th><th>Basis</th><th className="n">Min / cap</th></tr></thead>
          <tbody>{b.data.fee_rules.map((r) => <tr key={r.id}><td>{r.label}<div className="t-cap">{r.code}{r.is_active ? '' : ' · off'}</div></td><td>{r.basis === 'FLAT' ? `${m(r.amount_cents)} flat` : `${pctText(r.pct)} of ${r.basis === 'PCT_LABOR' ? 'labor' : 'parts'}`}</td><td className="n">{m(r.min_cents)} / {r.cap_cents == null ? 'none' : m(r.cap_cents)}</td></tr>)}</tbody></table>}
        {!readOnly && (
          <div className="ops-toolbar">
            <Field label="Code"><Input value={fee.code} onChange={(e) => setFee({ ...fee, code: e.target.value.toUpperCase() })} style={{ width: 90 }} /></Field>
            <Field label="Label"><Input value={fee.label} onChange={(e) => setFee({ ...fee, label: e.target.value })} /></Field>
            <Field label="Basis"><Select value={fee.basis} onChange={(e) => setFee({ ...fee, basis: e.target.value })}><option value="PCT_LABOR">% of labor</option><option value="PCT_PARTS">% of parts</option><option value="FLAT">Flat</option></Select></Field>
            <Field label={fee.basis === 'FLAT' ? 'Amount ($)' : 'Percent'}><Input inputMode="decimal" value={fee.pct} onChange={(e) => setFee({ ...fee, pct: e.target.value })} style={{ width: 80 }} /></Field>
            <Field label="Min ($)"><Input inputMode="decimal" value={fee.min} onChange={(e) => setFee({ ...fee, min: e.target.value })} style={{ width: 80 }} /></Field>
            <Field label="Cap ($)"><Input inputMode="decimal" value={fee.cap} onChange={(e) => setFee({ ...fee, cap: e.target.value })} style={{ width: 80 }} /></Field>
            <Button disabled={!/^[A-Z0-9_]{2,24}$/.test(fee.code) || busy === 'fee'} onClick={() => void run('fee', API, { op: 'fee_rule', companyId, code: fee.code, label: fee.label, kind: fee.code.includes('ENV') ? 'ENVIRONMENTAL' : 'SHOP_SUPPLIES', basis: fee.basis,
              pct: fee.basis === 'FLAT' ? 0 : (Number(fee.pct) || 0) / 100, amountCents: fee.basis === 'FLAT' ? centsFrom(fee.pct) ?? 0 : 0, minCents: centsFrom(fee.min) ?? 0, capCents: centsFrom(fee.cap) }, 'Fee rule saved')}>Save the fee</Button>
          </div>
        )}
      </Section>
    </div>
  );
}
