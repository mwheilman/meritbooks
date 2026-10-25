'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, ButtonRow, Drawer, Field, InlineNotice, Input, QueueTable, Select, Status, Textarea, count, type QueueColumn } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, FilePick, centsFrom, day, pctText, useBoard, useDo } from '@/components/dealer/common/depth';
import { splitCsv } from '@/lib/dealer/oem-shipment';
import { m } from './kit';

// ── payment menu (DLR-13) ─────────────────────────────────────────────────────────────────────────
interface Scenario { kind: string; code: string; name: string; apr?: number; term_months?: number; monthly_cents?: number | null; amount_financed_cents?: number | null; amount_due_cents?: number; cash_due_cents?: number; rebate_cents?: number; total_of_payments_cents?: number; dealer_net_front_cents?: number | null; subvention_cents?: number | null }
interface MenuRow { down_cents: number; balance_due_cents: number; scenarios: Scenario[]; lowest_monthly_code: string | null; best_dealer_net_code: string | null; rebate_vs_rate: { rebate_code: string; rebate_total_cents: number; promo_code: string; promo_total_cents: number; better: string; difference_cents: number } | null }
interface Menu { deal_id: string; downs: MenuRow[]; amounts_visible: boolean }
interface Eligible { incentive_id: string; code: string; name: string; kind: string; payee: string; claim_deadline_days: number | null; ends_on: string | null; applied: boolean; amount_cents: number | null }

/** Side-by-side payments at up to four down payments, the incentives that apply, and pinning the menu on the quote. */
export function PaymentMenuView({ dealId, quoteId, today }: { dealId: string; quoteId: string | null; today: string }) {
  const { readOnly } = useShell();
  const [downs, setDowns] = useState(['0', '1000', '2500']);
  const cents = downs.map((d) => centsFrom(d) ?? 0).filter((v, i, a) => a.indexOf(v) === i).slice(0, 4);
  const menu = useBoard<Menu>(`/api/dealer/deal-desk?view=menu&deal=${dealId}&downs=${cents.join(',') || '0'}`);
  const el = useBoard<Eligible[]>(`/api/dealer/deal-desk?view=eligible&deal=${dealId}`);
  const { run, busy, error } = useDo(() => { menu.reload(); el.reload(); });
  const [chosen, setChosen] = useState<string>('');
  const codes = menu.data?.downs[0]?.scenarios.map((s) => s.code) ?? [];
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <div className="ops-toolbar">
        {downs.map((d, i) => <Field key={i} label={`Down payment ${i + 1}`}><Input inputMode="decimal" value={d} onChange={(e) => setDowns(downs.map((x, j) => (j === i ? e.target.value : x)))} style={{ width: 110 }} /></Field>)}
        {downs.length < 4 && <Button variant="quiet" onClick={() => setDowns([...downs, ''])}>Add a column</Button>}
      </div>
      <BoardState b={menu} what="The payment menu" />
      {menu.data && (
        <Section title="Payment options" meta="Every program the deal qualifies for today; the lowest payment is marked">
          {codes.length === 0 ? <Empty title="No programs apply" body="Add finance programs on Programs and interfaces; cash is always an option." /> : (
            <div className="mp-table" style={{ overflowX: 'auto' }}>
              <table className="ops-mini" aria-label="Payment menu">
                <thead><tr><th>Program</th>{menu.data.downs.map((r) => <th key={r.down_cents} className="n">{m(r.down_cents)} down</th>)}</tr></thead>
                <tbody>{codes.map((code) => {
                  const first = menu.data!.downs[0]!.scenarios.find((s) => s.code === code)!;
                  return (
                    <tr key={code}>
                      <td><span className="l1">{first.name}</span><div className="t-cap">{first.kind === 'CASH' ? 'Pay in full' : first.kind === 'CASH_REBATE' ? `${m(first.rebate_cents)} cash back${first.apr != null ? ` at ${pctText(first.apr, 2)}` : ''}` : `${pctText(first.apr, 2)} for ${first.term_months} months`}</div></td>
                      {menu.data!.downs.map((r) => {
                        const s = r.scenarios.find((x) => x.code === code);
                        return <td key={r.down_cents} className="n">{!s ? '—' : s.kind === 'CASH' ? m(Math.max(Number(s.amount_due_cents ?? 0) - r.down_cents, 0)) : s.monthly_cents == null ? '—' : <><strong>{m(s.monthly_cents)}</strong>/mo{r.lowest_monthly_code === code && <div className="t-cap">lowest</div>}{menu.data!.amounts_visible && s.dealer_net_front_cents != null && <div className="t-cap">net {m(s.dealer_net_front_cents)}{r.best_dealer_net_code === code ? ' · best' : ''}</div>}</>}</td>;
                      })}
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          )}
          {menu.data.downs.map((r) => r.rebate_vs_rate && (
            <p key={r.down_cents} className="t-cap">At {m(r.down_cents)} down: {r.rebate_vs_rate.better === 'REBATE' ? 'the cash rebate' : r.rebate_vs_rate.better === 'PROMO_RATE' ? 'the low rate' : 'either'} costs the customer {m(r.rebate_vs_rate.difference_cents)} less over the term.</p>
          ))}
          {!readOnly && quoteId && (
            <ButtonRow>
              <Field label="The customer chose"><Select value={chosen} onChange={(e) => setChosen(e.target.value)}><option value="">Not chosen yet</option>{codes.map((c) => <option key={c} value={c}>{c}</option>)}</Select></Field>
              <Button variant="primary" disabled={busy === 'pin'} onClick={() => void run('pin', '/api/dealer/deal-desk', { op: 'attach_menu', quoteId, downs: cents.length ? cents : [0], chosen: chosen || null }, 'The menu is on the quote')}>Put this menu on the quote</Button>
            </ButtonRow>
          )}
          {!quoteId && <p className="t-cap">Issue a quote from the deal desk to pin this menu on it.</p>}
        </Section>
      )}
      <Section title="Incentives that apply" meta="Dealer cash, spiffs and OEM programs; claims open at delivery with their deadline">
        <BoardState b={el} what="Incentives" />
        {el.data && (el.data.length === 0 ? <Empty title="No incentives apply" body="Load the OEM bulletin on the incentive library; programs match by brand, model and category." /> : (
          <table className="ops-mini" aria-label="Eligible incentives">
            <thead><tr><th>Program</th><th>Payee</th><th>Claim within</th><th className="n">Amount</th><th><span className="sr">Apply</span></th></tr></thead>
            <tbody>{el.data.map((x) => <tr key={x.incentive_id}><td>{x.name}<div className="t-cap">{x.code}{x.ends_on ? ` · ends ${day(x.ends_on, today)}` : ''}</div></td><td>{x.payee.toLowerCase()}</td><td>{x.claim_deadline_days == null ? '—' : `${x.claim_deadline_days} days`}</td><td className="n">{m(x.amount_cents)}</td>
              <td>{readOnly ? null : <Button variant={x.applied ? 'quiet' : 'default'} disabled={busy === x.incentive_id} onClick={() => void run(x.incentive_id, '/api/dealer/deal-desk', { op: 'apply_incentive', dealId, incentiveId: x.incentive_id, remove: x.applied }, x.applied ? 'Removed' : 'Applied to the deal')}>{x.applied ? 'Remove' : 'Apply'}</Button>}</td></tr>)}</tbody>
          </table>
        ))}
      </Section>
    </div>
  );
}

// ── incentive library + claims (DLR-14) ───────────────────────────────────────────────────────────
interface Claim { id: string; deal_id: string; deal_number: string; program_code: string; kind: string; payee: string; status: string; earned_on: string; claim_by: string | null; claim_ref: string | null; oem: string | null; due: string | null; amount_cents: number | null; paid_cents: number | null; denied_reason: string | null }
interface LibRow { id: string; code: string; name: string; kind: string; brand: string | null; model_pattern: string | null; starts_on: string | null; ends_on: string | null; payee: string; claim_deadline_days: number | null; is_active: boolean; amount_cents: number | null; pct_of_price: number | null }
interface IncBoard { library: LibRow[]; claims: Claim[]; outstanding_by_oem: Array<{ oem: string; claims: number; amount_cents: number }> | null; amounts_visible: boolean }

const DUE_KIND: Record<string, 'overdue' | 'risk' | 'track'> = { OVERDUE: 'overdue', DUE_7: 'risk', DUE_30: 'track' };

export function IncentivesView({ companyId, today }: { companyId: string; today: string }) {
  const { readOnly } = useShell();
  const b = useBoard<IncBoard>(`/api/dealer/deal-desk?view=incentives&company=${companyId}`);
  const { run, busy, error } = useDo(b.reload);
  const [claim, setClaim] = useState<Claim | null>(null);
  const [form, setForm] = useState({ ref: '', paid: '', reason: '' });
  const cols: QueueColumn<Claim>[] = [
    { id: 'p', header: 'Claim', cell: (r) => <><span className="l1">{r.program_code} · {r.kind.replace('_', ' ').toLowerCase()}</span><span className="l2"><Link className="nlink" href={`/deals/${r.deal_id}`}>Deal {r.deal_number}</Link>{r.oem ? ` · ${r.oem}` : ''}</span></> },
    { id: 'b', header: 'Claim by', width: 130, cell: (r) => r.claim_by ? <Status kind={r.due ? DUE_KIND[r.due] ?? 'track' : 'track'} pip="open">{day(r.claim_by, today)}</Status> : '—' },
    { id: 's', header: 'Status', width: 120, cell: (r) => r.status.toLowerCase() },
    { id: 'a', header: 'Amount', numeric: true, width: 120, cell: (r) => m(r.status === 'PAID' ? r.paid_cents : r.amount_cents) },
  ];
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <BoardState b={b} what="Incentives" />
      {b.data && (
        <>
          {b.data.outstanding_by_oem && b.data.outstanding_by_oem.length > 0 && (
            <Section title="Owed by the OEMs" meta="Due and submitted claims">
              <table className="ops-mini" aria-label="Outstanding by OEM"><thead><tr><th>OEM</th><th className="n">Claims</th><th className="n">Amount</th></tr></thead>
                <tbody>{b.data.outstanding_by_oem.map((o) => <tr key={o.oem}><td>{o.oem}</td><td className="n">{count(o.claims)}</td><td className="n">{m(o.amount_cents)}</td></tr>)}</tbody></table>
            </Section>
          )}
          <Section title="Claims" meta={`${count(b.data.claims.filter((c) => c.due === 'OVERDUE').length)} past the claim deadline`}>
            {b.data.claims.length === 0 ? <Empty title="No claims yet" body="A delivered deal with an OEM rebate or dealer incentive opens its claim here, with the deadline from the program." /> :
              <div className="mp-table"><QueueTable aria-label="Incentive claims" columns={cols} rows={b.data.claims} getRowId={(r) => r.id} onOpen={(r) => { setClaim(r); setForm({ ref: r.claim_ref ?? '', paid: '', reason: '' }); }} openOnClick rowState={(r) => ({ attn: r.due === 'OVERDUE' || r.due === 'DUE_7', done: r.status === 'PAID' })} /></div>}
          </Section>
          <Section title="Program library" meta="From the OEM bulletins: brand, model pattern, dates, amount, claim deadline">
            {b.data.library.length === 0 ? <Empty title="No programs loaded" body="Load a bulletin CSV (code, name, kind, brand, model, starts, ends, amount, claim days) below." /> : (
              <table className="ops-mini" aria-label="Programs">
                <thead><tr><th>Program</th><th>Applies to</th><th>Dates</th><th>Claim within</th><th className="n">Amount</th></tr></thead>
                <tbody>{b.data.library.map((r) => <tr key={r.id} className={r.is_active ? undefined : 't-cap'}><td>{r.name}<div className="t-cap">{r.code} · {r.kind.toLowerCase().replace('_', ' ')} · to {r.payee.toLowerCase()}</div></td><td>{[r.brand, r.model_pattern].filter(Boolean).join(' ') || 'Any unit'}</td><td>{r.starts_on ? day(r.starts_on, today) : 'now'} – {r.ends_on ? day(r.ends_on, today) : 'open'}</td><td>{r.claim_deadline_days == null ? '—' : `${r.claim_deadline_days} days`}</td><td className="n">{r.amount_cents ? m(r.amount_cents) : r.pct_of_price ? pctText(r.pct_of_price) : '—'}</td></tr>)}</tbody>
              </table>
            )}
            {!readOnly && <FilePick label="Load a bulletin CSV" accept=".csv,.txt" onText={(_n, text) => {
              const rows = text.split(/\r?\n/).filter((l) => l.trim());
              const head = splitCsv(rows[0] ?? '').map((h) => h.toLowerCase());
              const at = (r: string[], k: string) => { const i = head.indexOf(k); return i >= 0 ? r[i] ?? '' : ''; };
              const out = rows.slice(1).map((l) => splitCsv(l)).map((r) => ({
                code: at(r, 'code'), name: at(r, 'name') || at(r, 'code'), kind: (at(r, 'kind') || 'DEALER_CASH').toUpperCase(), brand: at(r, 'brand') || null, model_pattern: at(r, 'model') || null,
                starts_on: at(r, 'starts') || null, ends_on: at(r, 'ends') || null, amount_cents: centsFrom(at(r, 'amount')) ?? 0, claim_deadline_days: at(r, 'claim days') ? Number(at(r, 'claim days')) : null,
                payee: (at(r, 'payee') || 'DEALER').toUpperCase(), bulletin_ref: at(r, 'bulletin') || null,
              })).filter((r) => r.code);
              void run('lib', '/api/dealer/deal-desk', { op: 'save_incentives', companyId, rows: out }, (d: { saved: number }) => `${d.saved} programs saved`);
            }} />}
          </Section>
        </>
      )}
      {claim && (
        <Drawer open onClose={() => setClaim(null)} title={`Claim ${claim.program_code}`} meta={`Deal ${claim.deal_number} · ${claim.status.toLowerCase()}`}>
          <div className="stack" style={{ padding: 16 }}>
            <p className="t-cap">Earned {day(claim.earned_on, today)}{claim.claim_by ? ` · claim by ${day(claim.claim_by, today)}` : ''} · {m(claim.amount_cents)}</p>
            {claim.denied_reason && <InlineNotice tone="neg" title="Denied.">{claim.denied_reason}</InlineNotice>}
            {!readOnly && (
              <>
                <Field label="OEM claim number"><Input value={form.ref} onChange={(e) => setForm({ ...form, ref: e.target.value })} /></Field>
                {(claim.status === 'DUE' || claim.status === 'DENIED') && <Button variant="primary" disabled={busy === claim.id} onClick={() => void run(claim.id, '/api/dealer/deal-desk', { op: 'update_claim', claimId: claim.id, status: 'SUBMITTED', claimRef: form.ref || null }, 'Marked submitted').then(() => setClaim(null))}>Mark submitted</Button>}
                {claim.status === 'SUBMITTED' && (
                  <>
                    <Field label="Paid amount ($)"><Input inputMode="decimal" value={form.paid} onChange={(e) => setForm({ ...form, paid: e.target.value })} /></Field>
                    <Button variant="primary" disabled={busy === claim.id} onClick={() => void run(claim.id, '/api/dealer/deal-desk', { op: 'update_claim', claimId: claim.id, status: 'PAID', paidCents: centsFrom(form.paid) }, 'Marked paid').then(() => setClaim(null))}>Mark paid</Button>
                  </>
                )}
                {(claim.status === 'DUE' || claim.status === 'SUBMITTED') && (
                  <>
                    <Field label="Denial reason"><Textarea rows={2} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
                    <Button variant="danger" disabled={!form.reason.trim() || busy === claim.id} onClick={() => void run(claim.id, '/api/dealer/deal-desk', { op: 'update_claim', claimId: claim.id, status: 'DENIED', reason: form.reason }, 'Marked denied').then(() => setClaim(null))}>Mark denied</Button>
                  </>
                )}
              </>
            )}
          </div>
        </Drawer>
      )}
    </div>
  );
}

// ── contracts in transit + unwind (DLR-24 / DLR-25) ───────────────────────────────────────────────
interface Cit { deal_id: string; number: string; customer: string | null; stage: string; lender: string | null; lender_status: string; conditions: string | null; since: string; days_out: number; stale: boolean; missing_stips: Array<{ key: string; label: string }>; amount_financed_cents: number | null }
const LENDER_STEPS = ['NOT_SUBMITTED', 'SUBMITTED', 'CONDITIONED', 'APPROVED', 'FUNDED', 'REJECTED'] as const;

export function FundingView({ companyId, today }: { companyId: string; today: string }) {
  const { readOnly } = useShell();
  const b = useBoard<Cit[]>(`/api/dealer/deal-desk?view=cit&company=${companyId}`);
  const { run, busy, error } = useDo(b.reload);
  const [open, setOpen] = useState<Cit | null>(null);
  const [cond, setCond] = useState('');
  const [unwind, setUnwind] = useState({ reason: '', code: 'FINANCING_DECLINED', deposit: 'HOLD' });
  const cols: QueueColumn<Cit>[] = [
    { id: 'd', header: 'Deal', cell: (r) => <><span className="l1">{r.number} · {r.customer ?? 'Customer'}</span><span className="l2">{r.lender ?? 'Lender'} · {r.stage.toLowerCase()}</span></> },
    { id: 'o', header: 'Days out', numeric: true, width: 100, cell: (r) => <Status kind={r.stale ? 'overdue' : 'track'} pip="open">{count(r.days_out)}</Status> },
    { id: 'l', header: 'Lender', width: 140, cell: (r) => r.lender_status.toLowerCase().replace('_', ' ') },
    { id: 's', header: 'Missing', width: 220, cell: (r) => r.missing_stips.length ? r.missing_stips.map((s) => s.label).join(', ') : <span className="t-cap">All stips in</span> },
    { id: 'a', header: 'Financed', numeric: true, width: 120, cell: (r) => m(r.amount_financed_cents) },
  ];
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <BoardState b={b} what="Contracts in transit" />
      {b.data && (b.data.length === 0 ? <Empty title="Nothing in transit" body="Financed deals the lender has not funded show here with their missing stipulations and days outstanding." /> :
        <div className="mp-table"><QueueTable aria-label="Contracts in transit" columns={cols} rows={b.data} getRowId={(r) => r.deal_id} onOpen={(r) => { setOpen(r); setCond(r.conditions ?? ''); }} openOnClick rowState={(r) => ({ attn: r.stale })} /></div>)}
      {open && (
        <Drawer open onClose={() => setOpen(null)} title={`Deal ${open.number}`} meta={`${open.lender ?? 'Lender'} · out ${count(open.days_out)} days since ${day(open.since, today)}`} width={520}>
          <div className="stack" style={{ padding: 16 }}>
            <Section title="Stipulations">
              {open.missing_stips.length === 0 ? <p className="t-cap">Everything the lender asked for is in.</p> : open.missing_stips.map((s) => (
                <ButtonRow key={s.key}><span className="l1" style={{ minWidth: 220 }}>{s.label}</span>{!readOnly && <Button disabled={busy === s.key} onClick={() => void run(s.key, '/api/dealer/deal-desk', { op: 'set_stip', dealId: open.deal_id, key: s.key, received: true }, 'Received').then(() => setOpen({ ...open, missing_stips: open.missing_stips.filter((x) => x.key !== s.key) }))}>Received</Button>}</ButtonRow>
              ))}
            </Section>
            {!readOnly && (
              <Section title="Lender status" meta={open.lender_status.toLowerCase().replace('_', ' ')}>
                <Field label="Conditions"><Textarea rows={2} value={cond} onChange={(e) => setCond(e.target.value)} /></Field>
                <ButtonRow>{LENDER_STEPS.filter((s) => s !== open.lender_status).map((s) => <Button key={s} variant={s === 'FUNDED' ? 'primary' : 'quiet'} disabled={busy === s} onClick={() => void run(s, '/api/dealer/deal-desk', { op: 'lender_status', dealId: open.deal_id, status: s, conditions: cond || null }, `Lender: ${s.toLowerCase().replace('_', ' ')}`).then(() => setOpen(null))}>{s.toLowerCase().replace('_', ' ')}</Button>)}</ButtonRow>
              </Section>
            )}
            {!readOnly && open.stage === 'DELIVERED' && (
              <Section title="Unwind" meta="The units return to stock, trades come back, open claims are voided; Books reverses the sale">
                <Field label="Why"><Select value={unwind.code} onChange={(e) => setUnwind({ ...unwind, code: e.target.value })}><option value="FINANCING_DECLINED">Financing declined</option><option value="BUYER_REMORSE">Buyer changed their mind</option><option value="UNIT_DEFECT">Unit defect</option><option value="PAPERWORK">Paperwork</option><option value="OTHER">Other</option></Select></Field>
                <Field label="What happens to the deposit"><Select value={unwind.deposit} onChange={(e) => setUnwind({ ...unwind, deposit: e.target.value })}><option value="HOLD">Hold it on the customer</option><option value="REFUND">Refund it</option><option value="APPLY_TO_NEW_DEAL">Apply it to a new deal</option><option value="NONE">No deposit</option></Select></Field>
                <Field label="Notes"><Textarea rows={2} value={unwind.reason} onChange={(e) => setUnwind({ ...unwind, reason: e.target.value })} /></Field>
                <Button variant="danger" disabled={!unwind.reason.trim() || busy === 'unwind'} onClick={() => { if (window.confirm('Unwind this delivered deal?')) void run('unwind', '/api/dealer/deal-desk', { op: 'unwind', dealId: open.deal_id, reason: unwind.reason, reasonCode: unwind.code, depositAction: unwind.deposit }, 'Deal unwound').then(() => setOpen(null)); }}>Unwind the deal</Button>
              </Section>
            )}
          </div>
        </Drawer>
      )}
    </div>
  );
}
