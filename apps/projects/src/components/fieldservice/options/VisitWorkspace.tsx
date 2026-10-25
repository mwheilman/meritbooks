'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Button, Check, Dialog, Field, InlineNotice, Input, MoneyInput, Select, Status, Tag, Textarea, WidgetState, api, count, money, pct, shortDate, toast,
} from '@meritbooks/merit-ui';
import { useRouter } from 'next/navigation';
import { useShell } from '@/components/shell/ShellContext';
import { fmtPhone } from '@/lib/fieldservice/booking';
import { optionMoney } from '@/lib/fieldservice/pricing';
import type { VisitData } from '@/lib/fieldservice/queries';
import type { FinancingPlanRow, FsEstimateRow, FsOptionItemRow, FsOptionRow } from '@/lib/fieldservice/types';
import { parseNum } from '@/components/ops/common/bits';

export interface VisitWorkspaceProps {
  workOrderId: string;
  today: string;
  data: VisitData;
  /** Dispatch viewers see who else could take the visit. */
  showEligible: boolean;
  /** projects.billing:create on the job — may request the deposit from Books. */
  canRequestDeposit: boolean;
  /** projects.financials:view — option cost and margin. */
  seesCost: boolean;
}

type Tier = FsOptionRow['tier'];
interface DraftItem { priceBookItemId: string; qty: number; optional: boolean }
interface DraftOption { tier: Tier; name: string; rebateCents: number | null; financingPlanId: string; items: DraftItem[] }

const TIERS: Tier[] = ['GOOD', 'BETTER', 'BEST'];
const TIER_WORD: Record<Tier, string> = { GOOD: 'Good', BETTER: 'Better', BEST: 'Best', OPTION: 'Option' };

/**
 * The technician's visit (FS-27/32/33/34/38/52/53): the pre-job brief, the good/better/best
 * builder from the price book, a customer-facing presentation that hides everything but the
 * option cards (member vs regular price, rebate, monthly payment), sign + deposit, membership on
 * site, and a replacement lead. Sell prices are the price book's; cost shows only with financials.
 */
export function VisitWorkspace(p: VisitWorkspaceProps) {
  const { readOnly } = useShell();
  const router = useRouter();
  const b = p.data.brief;
  const [presenting, setPresenting] = useState<string | null>(null);
  const [building, setBuilding] = useState(p.data.estimates.length === 0);
  const member = !!b?.is_member;

  if (!b) return <WidgetState state={{ kind: 'error', title: 'This visit did not load', body: 'You may not be dispatched on it any more. Check today’s route.' }} />;
  const presented = presenting ? p.data.estimates.find((e) => e.id === presenting) ?? null : null;
  if (presented) {
    return <Presentation estimate={presented} data={p.data} member={member} onExit={() => setPresenting(null)} readOnly={readOnly} canRequestDeposit={p.canRequestDeposit} onSold={() => { setPresenting(null); router.refresh(); }} />;
  }

  return (
    <div className="fs-grid">
      <div className="stack">
        <section className="fs-card" aria-label="Pre-job brief">
          <div className="fs-card-h">
            <h2 className="t-section">01 // Before you go in</h2><span className="sp" />
            {b.is_member ? <Tag tone="pos">Member</Tag> : <Tag>Not a member</Tag>}
            {b.ar?.past_due && <Tag tone="neg">Past-due balance</Tag>}
            {b.work_order.is_callback && <Tag tone="warn">Recall</Tag>}
          </div>
          <div className="fs-card-b">
            <p className="t-head">{b.work_order.summary}</p>
            {b.work_order.complaint && <p className="t-ui">“{b.work_order.complaint}”</p>}
            <p className="t-cap">{b.customer?.name ?? 'Customer'} · {b.site?.address ?? b.customer?.address ?? ''} · {fmtPhone(b.customer?.phone)}</p>
            {(b.site?.gate_code || b.site?.pets || b.site?.access_notes) && (
              <InlineNotice tone="info" title="Access">
                {[b.site.gate_code && `Gate code ${b.site.gate_code}`, b.site.pets && `Pets: ${b.site.pets}`, b.site.access_notes].filter(Boolean).join(' · ')}
              </InlineNotice>
            )}
            {b.summary && <><span className="eyebrow">What was done before</span><p className="t-cap fs-pre">{b.summary}</p></>}
            {b.call && Object.keys(b.call.answers ?? {}).length > 0 && (
              <details><summary className="t-ui">What the caller told us ({b.call.number})</summary>
                <ul className="fs-list">{Object.entries(b.call.answers).map(([k, v]) => <li key={k}><span className="l2">{k.replace(/_/g, ' ')}</span><span className="sp" /><span>{typeof v === 'boolean' ? (v ? 'Yes' : 'No') : v}</span></li>)}</ul>
              </details>
            )}
          </div>
          {(b.equipment ?? []).length > 0 && (
            <ul className="fs-list" aria-label="Equipment">
              {b.equipment!.map((e) => {
                const parts = !!e.parts_warranty_ends_on && e.parts_warranty_ends_on >= p.today;
                const labor = !!e.labor_warranty_ends_on && e.labor_warranty_ends_on >= p.today;
                return (
                  <li key={e.asset_id}>
                    <span><span className="l1">{[e.make, e.model].filter(Boolean).join(' ') || e.type || 'Equipment'} {e.serial ? <span className="code">#{e.serial}</span> : null}</span>
                      <span className="l2">{e.age_years != null ? `${e.age_years} years old` : 'Age unknown'}{e.refrigerant ? ` · ${e.refrigerant}` : ''}</span></span>
                    <span className="sp" />
                    <Status kind={parts ? 'ready' : 'risk'}>{parts ? 'Parts covered' : 'Parts billable'}</Status>
                    <Status kind={labor ? 'ready' : 'risk'}>{labor ? 'Labor covered' : 'Labor billable'}</Status>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="fs-card" aria-label="Options">
          <div className="fs-card-h">
            <h2 className="t-section">02 // Options</h2><span className="sp" />
            {!building && !readOnly && <Button onClick={() => setBuilding(true)}>Build options</Button>}
          </div>
          <div className="fs-card-b">
            {building && !readOnly && <Builder workOrderId={p.workOrderId} data={p.data} member={member} onDone={() => { setBuilding(false); router.refresh(); }} onCancel={p.data.estimates.length ? () => setBuilding(false) : undefined} />}
            {!building && p.data.estimates.length === 0 && <WidgetState state={{ kind: 'empty', title: 'No options yet', body: 'Build good / better / best from the price book; the customer sees the member price beside the regular price.' }} />}
            {p.data.estimates.map((e) => (
              <EstimateSummary key={e.id} estimate={e} data={p.data} member={member} seesCost={p.seesCost} onPresent={() => setPresenting(e.id)} readOnly={readOnly} />
            ))}
          </div>
        </section>
      </div>

      <aside className="stack">
        <LeadCard workOrderId={p.workOrderId} oldest={(b.equipment ?? []).reduce((m, e) => Math.max(m, e.age_years ?? 0), 0)} readOnly={readOnly} />
        {(b.agreements ?? []).length > 0 && (
          <section className="fs-card" aria-label="Membership">
            <div className="fs-card-h"><h2 className="t-section">Membership</h2></div>
            <ul className="fs-list">{b.agreements!.map((a) => <li key={a.agreement_id}><span><span className="l1">{a.plan}{a.tier ? ` · ${a.tier}` : ''}</span><span className="l2">{a.number} · ends {shortDate(a.ends_on, p.today)}{a.discount_pct ? ` · ${pct(Number(a.discount_pct))} off repairs` : ''}</span></span></li>)}</ul>
          </section>
        )}
        {p.showEligible && (
          <section className="fs-card" aria-label="Who can take this">
            <div className="fs-card-h"><h2 className="t-section">Who can take this visit</h2></div>
            {p.data.eligible.length === 0 ? <div className="fs-card-b"><WidgetState state={{ kind: 'empty', title: 'No technicians set up here', body: 'Add technician profiles (zones, business units) on Dispatch → Capacity.' }} /></div> : (
              <ul className="fs-list">
                {p.data.eligible.slice(0, 12).map((t) => (
                  <li key={t.employee_id}>
                    <span><span className="l1">{t.tech_name}</span><span className="l2">{t.eligible ? 'Can take it' : t.reasons.join(' · ')}{t.on_call ? ' · on call' : ''}{!t.in_zone ? ' · outside their zones' : ''} · {count(t.booked_minutes)} min booked that day</span></span>
                    <span className="sp" /><Status kind={t.eligible ? 'ready' : 'blocked'}>{t.eligible ? 'Eligible' : 'Not eligible'}</Status>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        <Link className="link t-cap" href={`/dispatch?wo=${p.workOrderId}`}>Open on the dispatch board</Link>
      </aside>
    </div>
  );
}

function Builder({ workOrderId, data, member, onDone, onCancel }: { workOrderId: string; data: VisitData; member: boolean; onDone: () => void; onCancel?: () => void }) {
  const book = data.pricebook;
  const byId = new Map(book.map((i) => [i.id, i]));
  const defaultPlan = data.plans.find((x) => x.is_default)?.id ?? '';
  const [title, setTitle] = useState('Repair options');
  const [opts, setOpts] = useState<DraftOption[]>(() => TIERS.map((t) => ({
    tier: t, name: TIER_WORD[t], rebateCents: 0, financingPlanId: defaultPlan,
    items: book.filter((i) => i.gbb_tier === t).slice(0, 1).map((i) => ({ priceBookItemId: i.id, qty: 1, optional: false })),
  })));
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? book.filter((i) => i.code.toLowerCase().includes(t) || i.name.toLowerCase().includes(t)).slice(0, 12) : [];
  }, [q, book]);
  const set = (k: number, patch: Partial<DraftOption>) => setOpts(opts.map((o, i) => (i === k ? { ...o, ...patch } : o)));

  async function build() {
    const ready = opts.filter((o) => o.items.length > 0);
    if (!ready.length) { setErr('Add at least one item to an option.'); return; }
    setBusy(true); setErr(null);
    const r = await api.post<{ estimateId: string }>('/api/fieldservice/estimates', {
      workOrderId, title, options: ready.map((o) => ({ tier: o.tier, name: o.name, rebateCents: o.rebateCents ?? 0, financingPlanId: o.financingPlanId || null, items: o.items })),
    });
    setBusy(false);
    if (r.error) { setErr(r.error.error); return; }
    toast(`Built ${ready.length} option(s)`);
    onDone();
  }

  return (
    <div className="stack">
      <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} /></Field>
      <Field label="Find a price-book item" help="Type a code or a word; add it to an option below">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="capacitor, HV-CAP…" />
      </Field>
      {matches.length > 0 && (
        <ul className="fs-list fs-card">
          {matches.map((i) => (
            <li key={i.id}>
              <span><span className="l1"><span className="code">{i.code}</span> {i.name}</span><span className="l2">{money(i.price_cents)}{i.member_price_cents != null ? ` · member ${money(i.member_price_cents)}` : ''}</span></span>
              <span className="sp" />
              {opts.map((o, k) => <Button key={o.tier} variant="quiet" onClick={() => set(k, { items: [...o.items, { priceBookItemId: i.id, qty: 1, optional: false }] })}>+ {o.name}</Button>)}
            </li>
          ))}
        </ul>
      )}
      <div className="fs-opts">
        {opts.map((o, k) => {
          const regular = o.items.filter((x) => !x.optional).reduce((s, x) => s + Math.round((byId.get(x.priceBookItemId)?.price_cents ?? 0) * x.qty), 0);
          const mem = o.items.filter((x) => !x.optional).reduce((s, x) => s + Math.round(((byId.get(x.priceBookItemId)?.member_price_cents ?? byId.get(x.priceBookItemId)?.price_cents) ?? 0) * x.qty), 0);
          return (
            <div key={o.tier} className="fs-opt">
              <div className="fs-opt-h"><Field label={`${TIER_WORD[o.tier]} — name`}><Input value={o.name} onChange={(e) => set(k, { name: e.target.value })} maxLength={120} /></Field></div>
              <div className="fs-opt-b">
                {o.items.length === 0 && <p className="t-cap">No items — this option is skipped.</p>}
                <ul className="fs-list">
                  {o.items.map((x, j) => {
                    const it = byId.get(x.priceBookItemId);
                    return (
                      <li key={`${x.priceBookItemId}-${j}`}>
                        <span><span className="l1">{it?.name ?? 'Item'}</span><span className="l2">{money(it?.price_cents ?? 0)}</span></span><span className="sp" />
                        <Input aria-label="Quantity" style={{ width: 56 }} inputMode="decimal" value={String(x.qty)} onChange={(e) => { const n = parseNum(e.target.value); if (n && n > 0) set(k, { items: o.items.map((y, i2) => (i2 === j ? { ...y, qty: n } : y)) }); }} />
                        <Check label="Add-on" checked={x.optional} onChange={(e) => set(k, { items: o.items.map((y, i2) => (i2 === j ? { ...y, optional: e.target.checked } : y)) })} />
                        <Button variant="quiet" onClick={() => set(k, { items: o.items.filter((_, i2) => i2 !== j) })}>Remove</Button>
                      </li>
                    );
                  })}
                </ul>
                <Field label="Rebate"><MoneyInput valueCents={o.rebateCents} onChangeCents={(c) => set(k, { rebateCents: c })} /></Field>
                <Field label="Financing">
                  <Select value={o.financingPlanId} onChange={(e) => set(k, { financingPlanId: e.target.value })}>
                    <option value="">None</option>
                    {data.plans.map((pl) => <option key={pl.id} value={pl.id}>{pl.name}</option>)}
                  </Select>
                </Field>
              </div>
              <div className="fs-opt-f"><span className="fs-big">{money(member ? mem : regular)}</span>{member ? <span className="t-cap"> member · {money(regular)} regular</span> : <span className="t-cap"> · member {money(mem)}</span>}</div>
            </div>
          );
        })}
      </div>
      <div className="row" style={{ gap: 8 }}>
        <Button variant="primary" disabled={busy} onClick={() => void build()}>Build options</Button>
        {onCancel && <Button variant="quiet" onClick={onCancel}>Cancel</Button>}
      </div>
      {err && <InlineNotice tone="neg" title="Not built.">{err}</InlineNotice>}
    </div>
  );
}

function totalsOf(data: VisitData, optionId: string) {
  return data.totals.find((t) => t.option_id === optionId) ?? { regular_cents: 0, member_cents: 0, rebate_cents: 0 };
}

function planOf(plans: ReadonlyArray<FinancingPlanRow>, id: string | null) {
  const pl = id ? plans.find((x) => x.id === id) : null;
  return pl ? { apr: Number(pl.apr), termMonths: pl.term_months, name: pl.name } : null;
}

function EstimateSummary({ estimate, data, member, seesCost, onPresent, readOnly }: { estimate: FsEstimateRow; data: VisitData; member: boolean; seesCost: boolean; onPresent: () => void; readOnly: boolean }) {
  const options = data.options.filter((o) => o.estimate_id === estimate.id);
  const open = estimate.status === 'DRAFT' || estimate.status === 'PRESENTED';
  return (
    <div className="fs-card" style={{ marginBottom: 16 }}>
      <div className="fs-card-h">
        <span><span className="t-head">{estimate.title}</span><br /><span className="t-cap"><span className="code">{estimate.number}</span> · {estimate.status === 'SOLD' ? `signed by ${estimate.signed_name}` : estimate.status.toLowerCase()}</span></span>
        <span className="sp" />
        {open && !readOnly && <Button variant="primary" onClick={onPresent}>Present to the customer</Button>}
      </div>
      <table className="fs-table">
        <thead><tr><th>Option</th><th className="n">Regular</th><th className="n">Member</th><th className="n">Rebate</th>{seesCost && <th className="n">Margin</th>}<th>Status</th></tr></thead>
        <tbody>
          {options.map((o) => {
            const t = totalsOf(data, o.id);
            const items = data.items.filter((i) => i.option_id === o.id && i.is_selected);
            const cost = items.every((i) => i.unit_cost_cents != null) ? items.reduce((s, i) => s + Math.round(Number(i.unit_cost_cents) * Number(i.qty)), 0) : null;
            const price = member ? t.member_cents : t.regular_cents;
            return (
              <tr key={o.id}>
                <td><span className="l1">{TIER_WORD[o.tier]} · {o.name}</span>{o.dismiss_reason && <span className="l2">{o.dismiss_reason}</span>}</td>
                <td className="n">{money(t.regular_cents)}</td><td className="n">{money(t.member_cents)}</td><td className="n">{o.rebate_cents ? money(o.rebate_cents) : '—'}</td>
                {seesCost && <td className="n">{cost == null || price <= 0 ? '—' : pct((price - cost) / price)}</td>}
                <td><Status kind={o.status === 'SOLD' ? 'ready' : o.status === 'DISMISSED' ? 'blocked' : 'track'}>{o.status === 'SOLD' ? 'Sold' : o.status === 'DISMISSED' ? 'Not chosen' : 'Open'}</Status></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The kitchen-table view: option cards only — no cost, no margin, no internal notes. */
function Presentation({ estimate, data, member, onExit, onSold, readOnly, canRequestDeposit }: {
  estimate: FsEstimateRow; data: VisitData; member: boolean; onExit: () => void; onSold: () => void; readOnly: boolean; canRequestDeposit: boolean;
}) {
  const options = data.options.filter((o) => o.estimate_id === estimate.id && o.status === 'OPEN');
  const [chosen, setChosen] = useState<string | null>(options.find((o) => o.recommended)?.id ?? null);
  const [items, setItems] = useState<FsOptionItemRow[]>(data.items);
  const [joinTpl, setJoinTpl] = useState('');
  const [signing, setSigning] = useState(false);
  const [name, setName] = useState('');
  const [deposit, setDeposit] = useState<number | null>(0);
  const [requestDeposit, setRequestDeposit] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const memberNow = member || !!joinTpl;
  const tpl = data.templates.find((t) => t.id === joinTpl) ?? null;

  const priced = (o: FsOptionRow) => {
    const sel = items.filter((i) => i.option_id === o.id && i.is_selected);
    const regular = sel.reduce((s, i) => s + Math.round(Number(i.unit_price_cents) * Number(i.qty)), 0);
    const mem = sel.reduce((s, i) => s + Math.round(Number(i.member_unit_price_cents ?? i.unit_price_cents) * Number(i.qty)), 0);
    return optionMoney(regular, mem, Number(o.rebate_cents), memberNow, planOf(data.plans, o.financing_plan_id));
  };

  async function toggle(i: FsOptionItemRow) {
    const next = !i.is_selected;
    setItems(items.map((x) => (x.id === i.id ? { ...x, is_selected: next } : x)));
    const r = await api.post(`/api/fieldservice/estimates/${estimate.id}`, { op: 'toggle', itemId: i.id, selected: next });
    if (r.error) { setItems(items); toast.error(r.error.error); }
  }

  async function sell() {
    if (!chosen) return;
    setBusy(true); setErr(null);
    if (estimate.status === 'DRAFT') await api.post(`/api/fieldservice/estimates/${estimate.id}`, { op: 'present' });
    const r = await api.post<{ lines: number; agreementId: string | null }>(`/api/fieldservice/estimates/${estimate.id}`, {
      op: 'sell', optionIds: [chosen], signedName: name, dismissReason: 'Chose another option', joinTemplateId: joinTpl || null,
      depositCents: deposit ?? 0, requestDeposit: requestDeposit && (deposit ?? 0) > 0, financingPlanId: options.find((o) => o.id === chosen)?.financing_plan_id ?? null,
    });
    setBusy(false);
    if (r.error) { setErr(r.error.error); return; }
    toast(`Sold — ${r.data?.lines ?? 0} line(s) added to the visit${r.data?.agreementId ? ' and the membership started' : ''}`);
    onSold();
  }

  async function decline() {
    setBusy(true); setErr(null);
    const r = await api.post(`/api/fieldservice/estimates/${estimate.id}`, { op: 'decline', reason });
    setBusy(false);
    if (r.error) { setErr(r.error.error); return; }
    toast('Recorded the decline');
    onSold();
  }

  return (
    <div className="fs-present" data-hotkeys="off">
      <div className="row" style={{ gap: 8, marginBottom: 24 }}>
        <h2 className="t-title">{estimate.title}</h2><span className="sp" />
        <Button variant="quiet" onClick={onExit}>Back to the visit</Button>
      </div>
      {!member && data.templates.length > 0 && (
        <InlineNotice tone="info" title="Members pay less today.">
          <Select aria-label="Join a membership" value={joinTpl} onChange={(e) => setJoinTpl(e.target.value)}>
            <option value="">Show regular prices</option>
            {data.templates.map((t) => <option key={t.id} value={t.id}>Join {t.plan_name}{t.tier ? ` ${t.tier}` : ''} — {money(t.price_cents)} {t.billing_frequency === 'MONTHLY' ? 'a month' : t.billing_frequency === 'ANNUAL' ? 'a year' : ''}</option>)}
          </Select>
        </InlineNotice>
      )}
      <div className="fs-opts" role="radiogroup" aria-label="Options" style={{ marginTop: 16 }}>
        {options.map((o) => {
          const m = priced(o);
          const save = m.regularCents - m.memberCents;
          return (
            <div key={o.id} className="fs-opt" role="radio" aria-checked={chosen === o.id} tabIndex={0} onClick={() => setChosen(o.id)} onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') setChosen(o.id); }}>
              <div className="fs-opt-h"><span className="eyebrow">{TIER_WORD[o.tier]}{o.recommended ? ' · recommended' : ''}</span><p className="t-head">{o.name}</p>{o.description && <p className="t-cap">{o.description}</p>}</div>
              <div className="fs-opt-b">
                <ul className="fs-list">
                  {items.filter((i) => i.option_id === o.id).map((i) => (
                    <li key={i.id}>
                      {i.is_optional
                        ? <Check label={`${i.description} (+${money(Math.round(Number(memberNow ? i.member_unit_price_cents ?? i.unit_price_cents : i.unit_price_cents) * Number(i.qty)))})`} checked={i.is_selected} onChange={() => void toggle(i)} disabled={readOnly} />
                        : <span className="l1">{i.description}{Number(i.qty) !== 1 ? ` × ${i.qty}` : ''}</span>}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="fs-opt-f">
                <div className="fs-big">{money(m.netCents)}</div>
                {memberNow && save > 0 && <p className="t-cap">Member price · you save {money(save)} (regular {money(m.regularCents)})</p>}
                {!memberNow && save > 0 && <p className="t-cap">Members pay {money(m.memberCents)}</p>}
                {m.rebateCents > 0 && <p className="t-cap">After a {money(m.rebateCents)} rebate</p>}
                {m.monthlyCents != null && <p className="t-ui">or about <b className="tnum">{money(m.monthlyCents)}</b> a month{planOf(data.plans, o.financing_plan_id) ? ` · ${planOf(data.plans, o.financing_plan_id)!.name}` : ''}</p>}
              </div>
            </div>
          );
        })}
      </div>
      {tpl && <p className="t-cap" style={{ marginTop: 8 }}>{tpl.plan_name} {tpl.tier ?? ''}: {count(tpl.visits_per_term)} tune-up(s) a year, {pct(Number(tpl.member_discount_pct))} off repairs{tpl.perks.waive_diagnostic ? ', no diagnostic fee' : ''}{tpl.perks.priority_service ? ', priority service' : ''}.</p>}
      {!readOnly && (
        <div className="row" style={{ gap: 8, marginTop: 24 }}>
          <Button variant="primary" size="lg" disabled={!chosen} onClick={() => setSigning(true)}>Choose and sign</Button>
          <Button size="lg" variant="quiet" onClick={() => setDeclining(true)}>Not today</Button>
        </div>
      )}
      <Dialog open={signing} onClose={() => setSigning(false)} title="Sign to approve" dismissOnScrim={false}
        actions={<><Button variant="quiet" onClick={() => setSigning(false)}>Cancel</Button><Button variant="primary" disabled={busy || name.trim().length < 2} onClick={() => void sell()}>Approve</Button></>}>
        <Field label="Your full name" help="Typing your name is your signature for this work"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
        <Field label="Deposit today"><MoneyInput valueCents={deposit} onChangeCents={setDeposit} /></Field>
        {canRequestDeposit && (deposit ?? 0) > 0 && <Check label="Send the deposit invoice from Books" checked={requestDeposit} onChange={(e) => setRequestDeposit(e.target.checked)} />}
        {err && <InlineNotice tone="neg" title="Not approved.">{err}</InlineNotice>}
      </Dialog>
      <Dialog open={declining} onClose={() => setDeclining(false)} title="Not today"
        actions={<><Button variant="quiet" onClick={() => setDeclining(false)}>Back</Button><Button disabled={busy || reason.trim().length < 3} onClick={() => void decline()}>Record</Button></>}>
        <Field label="Why" help="Price, timing, wants to think, getting other quotes"><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>
        {err && <InlineNotice tone="neg" title="Not recorded.">{err}</InlineNotice>}
      </Dialog>
    </div>
  );
}

function LeadCard({ workOrderId, oldest, readOnly }: { workOrderId: string; oldest: number; readOnly: boolean }) {
  const [reason, setReason] = useState(oldest >= 12 ? `System is ${oldest} years old` : '');
  const [interest, setInterest] = useState<'LOW' | 'MEDIUM' | 'HIGH'>('MEDIUM');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    setBusy(true); setErr(null);
    const r = await api.post('/api/fieldservice/tgl', { workOrderId, reason, interest });
    setBusy(false);
    if (r.error) { setErr(r.error.error); return; }
    toast('Set the replacement lead — the credit is yours when it sells');
    setDone(true);
  }
  return (
    <section className="fs-card" aria-label="Replacement lead">
      <div className="fs-card-h"><h2 className="t-section">Replacement lead</h2>{oldest >= 12 && <Tag tone="ai">{oldest}-year-old unit</Tag>}</div>
      <div className="fs-card-b">
        {done ? <WidgetState state={{ kind: 'done', title: 'Lead set', body: 'A comfort advisor follows up; your lead-set bonus counts when it sells.' }} /> : (
          <>
            <Field label="Why"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} disabled={readOnly} /></Field>
            <Field label="Customer interest"><Select value={interest} onChange={(e) => setInterest(e.target.value as typeof interest)} disabled={readOnly}><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option></Select></Field>
            <Button disabled={busy || readOnly || reason.trim().length < 3} onClick={() => void save()}>Set lead</Button>
            {err && <InlineNotice tone="neg" title="Not set.">{err}</InlineNotice>}
          </>
        )}
      </div>
    </section>
  );
}
