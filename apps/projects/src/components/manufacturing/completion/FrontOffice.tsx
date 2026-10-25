'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Button, ButtonRow, Drawer, Field, InlineNotice, Input, QueueTable, Select, Status, Textarea, count, type QueueColumn } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, centsFrom, day, pctText, qty, useBoard, useDo } from '@/components/dealer/common/depth';
import { m, type Opt } from '@/components/dealer/completion/kit';
import { ParamError, expandProduct, type Coef, type ComponentKind, type ProductDef } from '@/lib/mfg/products';

const FRONT = '/api/mfg/front';

// ── bid board (MFG-03) ────────────────────────────────────────────────────────────────────────────
interface Bid { id: string; customer: string; customer_id: string; status: string; submitted_on: string | null; estimate_id: string | null; amount_cents: number | null }
interface Opp { id: string; number: string; name: string; stage: string; bid_due_on: string | null; overdue: boolean; customer: string | null; probability: number | null; architect: string | null; job_id: string | null; reason_code: string | null; est_value_cents: number | null; bids: Bid[] }
interface BidBoard { opportunities: Opp[]; win_rate: number | null; decided_12m: number; loss_reasons: Record<string, number>; amounts_visible: boolean }
const STAGES = ['LEAD', 'QUALIFIED', 'BIDDING', 'SUBMITTED'] as const;
const REASONS = { PRICE: 'Price', SCHEDULE: 'Schedule', SCOPE: 'Scope', RELATIONSHIP: 'Relationship', CAPACITY: 'Our capacity', NO_DECISION: 'No decision', OTHER: 'Other' } as const;

/** Opportunities from lead to award; one estimate goes to several GCs, the award converts it to the job. */
export function BidBoardView({ companyId, today, customers, estimates }: { companyId: string; today: string; customers: Opt[]; estimates: Opt[] }) {
  const { readOnly } = useShell();
  const b = useBoard<BidBoard>(`${FRONT}?view=bids&company=${companyId}`);
  const { run, busy, error } = useDo(b.reload);
  const [open, setOpen] = useState<Opp | null>(null);
  const [nw, setNw] = useState({ name: '', due: '', value: '', architect: '', customerId: '' });
  const [bid, setBid] = useState({ customerId: '', estimateId: '', amount: '', submitted: today });
  const [lost, setLost] = useState({ code: 'PRICE', reason: '' });
  const cols: QueueColumn<Opp>[] = [
    { id: 'n', header: 'Opportunity', cell: (r) => <><span className="l1">{r.name}</span><span className="l2">{[r.number, r.customer, r.architect && `Arch. ${r.architect}`].filter(Boolean).join(' · ')}</span></> },
    { id: 'd', header: 'Bid due', width: 110, cell: (r) => r.bid_due_on ? <Status kind={r.overdue ? 'overdue' : 'track'} pip="open">{day(r.bid_due_on, today)}</Status> : '—' },
    { id: 's', header: 'Stage', width: 110, cell: (r) => <Status kind={r.stage === 'WON' ? 'ready' : r.stage === 'LOST' || r.stage === 'NO_BID' ? 'blocked' : 'track'} pip="open">{r.stage.toLowerCase().replace('_', ' ')}</Status> },
    { id: 'b', header: 'Bids', numeric: true, width: 70, cell: (r) => count(r.bids.length) },
    { id: 'v', header: 'Value', numeric: true, width: 120, cell: (r) => m(r.est_value_cents) },
  ];
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <BoardState b={b} what="The bid board" />
      {b.data && (
        <>
          <p className="t-cap">Win rate {b.data.win_rate == null ? '—' : pctText(b.data.win_rate, 0)} over {count(b.data.decided_12m)} decided in 12 months{Object.keys(b.data.loss_reasons).length ? ` · lost on ${Object.entries(b.data.loss_reasons).map(([k, n]) => `${REASONS[k as keyof typeof REASONS] ?? k} (${n})`).join(', ')}` : ''}</p>
          {b.data.opportunities.length === 0 ? <Empty title="No opportunities" body="Add the projects you are invited to bid below; bids to several GCs share one estimate." /> :
            <div className="mp-table"><QueueTable aria-label="Opportunities" columns={cols} rows={b.data.opportunities} getRowId={(r) => r.id} onOpen={setOpen} openOnClick rowState={(r) => ({ attn: r.overdue, done: r.stage === 'WON' })} /></div>}
        </>
      )}
      {!readOnly && (
        <Section title="New opportunity">
          <div className="ops-toolbar">
            <Field label="Project"><Input value={nw.name} onChange={(e) => setNw({ ...nw, name: e.target.value })} style={{ minWidth: 240 }} /></Field>
            <Field label="Bid due"><Input type="date" value={nw.due} onChange={(e) => setNw({ ...nw, due: e.target.value })} /></Field>
            <Field label="Value ($)"><Input inputMode="decimal" value={nw.value} onChange={(e) => setNw({ ...nw, value: e.target.value })} style={{ width: 120 }} /></Field>
            <Field label="Architect"><Input value={nw.architect} onChange={(e) => setNw({ ...nw, architect: e.target.value })} /></Field>
            <Field label="Owner / GC"><Select value={nw.customerId} onChange={(e) => setNw({ ...nw, customerId: e.target.value })}><option value="">Not yet</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select></Field>
          </div>
          <Button variant="primary" disabled={!nw.name.trim() || busy === 'new'} onClick={() => void run('new', FRONT, { op: 'save_opportunity', companyId, name: nw.name.trim(), bidDueOn: nw.due || null, estValueCents: centsFrom(nw.value), architect: nw.architect || null, customerId: nw.customerId || null }, 'Opportunity added').then((r) => { if (r) setNw({ name: '', due: '', value: '', architect: '', customerId: '' }); })}>Add it</Button>
        </Section>
      )}
      {open && (
        <Drawer open onClose={() => setOpen(null)} width={560} title={open.name} meta={`${open.number} · ${open.stage.toLowerCase()}`}>
          <div className="stack" style={{ padding: 16 }}>
            {open.job_id && <InlineNotice tone="info" title="Won.">The job is <Link className="nlink" href={`/jobs/${open.job_id}`}>open</Link>; the estimate was accepted as the contract.</InlineNotice>}
            <table className="ops-mini" aria-label="Bids"><thead><tr><th>GC</th><th>Status</th><th className="n">Amount</th><th><span className="sr">Award</span></th></tr></thead>
              <tbody>{open.bids.map((x) => <tr key={x.id}><td>{x.customer}<div className="t-cap">{x.submitted_on ? `submitted ${day(x.submitted_on, today)}` : 'draft'}</div></td><td>{x.status.toLowerCase()}</td><td className="n">{m(x.amount_cents)}</td>
                <td>{!readOnly && !['WON', 'LOST', 'NO_BID'].includes(open.stage) && <Button variant="primary" disabled={busy === x.id} onClick={() => { if (window.confirm(`Award to ${x.customer}? The other bids are lost.`)) void run(x.id, FRONT, { op: 'award_bid', bidId: x.id }, 'Awarded; the job takes the estimate').then(() => setOpen(null)); }}>Award</Button>}</td></tr>)}</tbody></table>
            {!readOnly && !['WON', 'LOST', 'NO_BID'].includes(open.stage) && (
              <>
                <Section title="Add a bid">
                  <div className="ops-toolbar">
                    <Field label="GC"><Select value={bid.customerId} onChange={(e) => setBid({ ...bid, customerId: e.target.value })}><option value="">Pick the GC</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select></Field>
                    <Field label="Estimate"><Select value={bid.estimateId} onChange={(e) => setBid({ ...bid, estimateId: e.target.value })}><option value="">Pick the estimate</option>{estimates.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select></Field>
                    <Field label="Amount ($)"><Input inputMode="decimal" value={bid.amount} onChange={(e) => setBid({ ...bid, amount: e.target.value })} style={{ width: 120 }} /></Field>
                    <Field label="Submitted"><Input type="date" value={bid.submitted} onChange={(e) => setBid({ ...bid, submitted: e.target.value })} /></Field>
                  </div>
                  <Button disabled={!bid.customerId || busy === 'bid'} onClick={() => void run('bid', FRONT, { op: 'save_bid', opportunityId: open.id, customerId: bid.customerId, estimateId: bid.estimateId || null, amountCents: centsFrom(bid.amount), submittedOn: bid.submitted || null }, 'Bid saved').then(() => setOpen(null))}>Save the bid</Button>
                </Section>
                <Section title="Stage">
                  <ButtonRow>{STAGES.filter((s) => s !== open.stage).map((s) => <Button key={s} variant="quiet" disabled={busy === s} onClick={() => void run(s, FRONT, { op: 'move_opportunity', id: open.id, stage: s }, `Moved to ${s.toLowerCase()}`).then(() => setOpen(null))}>{s.toLowerCase()}</Button>)}</ButtonRow>
                  <div className="ops-toolbar">
                    <Field label="Lost on"><Select value={lost.code} onChange={(e) => setLost({ ...lost, code: e.target.value })}>{Object.entries(REASONS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
                    <Field label="Note"><Input value={lost.reason} onChange={(e) => setLost({ ...lost, reason: e.target.value })} /></Field>
                    <Button variant="danger" disabled={busy === 'lost'} onClick={() => void run('lost', FRONT, { op: 'move_opportunity', id: open.id, stage: 'LOST', reasonCode: lost.code, reason: lost.reason || null }, 'Marked lost').then(() => setOpen(null))}>Lost</Button>
                    <Button variant="quiet" disabled={busy === 'lost'} onClick={() => void run('lost', FRONT, { op: 'move_opportunity', id: open.id, stage: 'NO_BID', reasonCode: lost.code, reason: lost.reason || null }, 'No bid').then(() => setOpen(null))}>No bid</Button>
                  </div>
                </Section>
              </>
            )}
          </div>
        </Drawer>
      )}
    </div>
  );
}

// ── parametric product library (MFG-07) ──────────────────────────────────────────────────────────
interface LibProduct { id: string; code: string; name: string; family: string; params: ProductDef['params']; components: ProductDef['components']; price_coef: Coef; markup_pct: number | null; routing_id: string | null; is_active: boolean }
const KINDS: ComponentKind[] = ['SHEET', 'EDGEBAND', 'HARDWARE', 'LUMBER', 'FINISH', 'BUYOUT', 'LABOR', 'INSTALL', 'FREIGHT'];
const FAMILIES = ['BASE', 'WALL', 'TALL', 'VANITY', 'CLOSET', 'PANEL', 'FILLER', 'COUNTERTOP', 'DESK', 'FEATURE_WALL', 'OTHER'];
const COEF_KEYS = ['const', 'w', 'h', 'd', 'wh', 'wd', 'hd', 'doors', 'drawers', 'shelves'] as const;
const coefText = (c: Coef) => COEF_KEYS.filter((k) => c[k]).map((k) => `${c[k]}${k === 'const' ? '' : ` ${k}`}`).join(' + ') || '0';
function parseCoef(s: string): Coef {
  const out: Coef = {};
  for (const term of s.split('+').map((t) => t.trim()).filter(Boolean)) {
    const [n, k] = term.split(/\s+/);
    const v = Number(n);
    if (!Number.isFinite(v)) continue;
    const key = (k ?? 'const') as (typeof COEF_KEYS)[number];
    if (COEF_KEYS.includes(key)) out[key] = (out[key] ?? 0) + v;
  }
  return out;
}

/** Products defined by formula (sizes, doors, drawers): the estimate prices them, the shop gets their parts and minutes. */
export function ProductLibraryView({ companyId, estimates }: { companyId: string; estimates: Opt[] }) {
  const { readOnly } = useShell();
  const b = useBoard<LibProduct[]>(`${FRONT}?view=library&company=${companyId}`);
  const { run, busy, error } = useDo(b.reload);
  const [ed, setEd] = useState<{ code: string; name: string; family: string; params: string; comps: Array<{ kind: ComponentKind; key: string; coef: string; cost: string }>; price: string; markup: string } | null>(null);
  const [preview, setPreview] = useState<Record<string, string>>({ w: '24', qty: '1' });
  const [toEst, setToEst] = useState({ estimateId: estimates[0]?.id ?? '', productId: '' });
  const def: ProductDef | null = useMemo(() => {
    if (!ed) return null;
    const params: ProductDef['params'] = {};
    for (const p of ed.params.split(',').map((x) => x.trim()).filter(Boolean)) { const [k, dv, mn, mx] = p.split(/[:/]/).map((x) => x.trim()); if (k && /^[a-z_]{1,20}$/.test(k)) params[k] = { default: dv ? Number(dv) : undefined, min: mn ? Number(mn) : undefined, max: mx ? Number(mx) : undefined }; }
    return { params, components: ed.comps.filter((c) => c.key.trim()).map((c) => ({ kind: c.kind, key: c.key.trim(), coef: parseCoef(c.coef), unit_cost_cents: centsFrom(c.cost) })), price_coef: parseCoef(ed.price), markup_pct: ed.markup ? Number(ed.markup) / 100 : null };
  }, [ed]);
  let live: ReturnType<typeof expandProduct> | null = null;
  let liveErr: string | null = null;
  if (def) { try { live = expandProduct(def, Object.fromEntries(Object.entries(preview).map(([k, v]) => [k, Number(v)]))); } catch (e) { liveErr = e instanceof ParamError ? e.message : 'Check the formulas.'; } }
  const editOf = (p: LibProduct) => setEd({ code: p.code, name: p.name, family: p.family, params: Object.entries(p.params).map(([k, d]) => `${k}:${d.default ?? ''}/${d.min ?? ''}/${d.max ?? ''}`).join(', '),
    comps: p.components.map((c) => ({ kind: c.kind, key: c.key, coef: coefText(c.coef ?? {}), cost: c.unit_cost_cents != null ? (c.unit_cost_cents / 100).toFixed(2) : '' })), price: coefText(p.price_coef), markup: p.markup_pct != null ? String(p.markup_pct * 100) : '' });
  const cols: QueueColumn<LibProduct>[] = [
    { id: 'n', header: 'Product', cell: (r) => <><span className="l1">{r.code} · {r.name}</span><span className="l2">{r.family.toLowerCase().replace('_', ' ')} · {Object.keys(r.params).join(', ') || 'no parameters'} · {r.components.length} components</span></> },
    { id: 's', header: 'Status', width: 90, cell: (r) => (r.is_active ? 'active' : 'retired') },
  ];
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <BoardState b={b} what="The product library" />
      {b.data && (b.data.length === 0 ? <Empty title="No products yet" body="Define a cabinet once (sheets, edge band, hardware, shop minutes, install hours by size); estimates and takeoffs price it." /> :
        <div className="mp-table"><QueueTable aria-label="Products" columns={cols} rows={b.data} getRowId={(r) => r.id} onOpen={(r) => { editOf(r); setToEst({ ...toEst, productId: r.id }); }} openOnClick /></div>)}
      {!readOnly && !ed && <Button onClick={() => setEd({ code: '', name: '', family: 'BASE', params: 'w:24/9/48, h:34.5, d:24, doors:2', comps: [{ kind: 'SHEET', key: 'MAPLE PLY|18.0', coef: '0.5 + 0.02 w', cost: '' }, { kind: 'LABOR', key: 'assy', coef: '20 + 5 doors', cost: '' }], price: '', markup: '45' })}>New product</Button>}
      {ed && def && (
        <Section title={ed.code || 'New product'} actions={<Button variant="quiet" onClick={() => setEd(null)}>Close</Button>}>
          <div className="ops-toolbar">
            <Field label="Code"><Input disabled={readOnly} value={ed.code} onChange={(e) => setEd({ ...ed, code: e.target.value.toUpperCase() })} style={{ width: 120 }} /></Field>
            <Field label="Name"><Input disabled={readOnly} value={ed.name} onChange={(e) => setEd({ ...ed, name: e.target.value })} /></Field>
            <Field label="Family"><Select disabled={readOnly} value={ed.family} onChange={(e) => setEd({ ...ed, family: e.target.value })}>{FAMILIES.map((f) => <option key={f} value={f}>{f.toLowerCase().replace('_', ' ')}</option>)}</Select></Field>
          </div>
          <Field label="Parameters (name:default/min/max, inches)"><Input disabled={readOnly} value={ed.params} onChange={(e) => setEd({ ...ed, params: e.target.value })} /></Field>
          <table className="ops-mini" aria-label="Components">
            <thead><tr><th>Kind</th><th>Material / work center</th><th>Quantity formula (e.g. 0.5 + 0.02 w + 2 doors)</th><th className="n">Unit cost ($)</th></tr></thead>
            <tbody>{ed.comps.map((c, i) => <tr key={i}>
              <td><Select aria-label="Kind" disabled={readOnly} value={c.kind} onChange={(e) => setEd({ ...ed, comps: ed.comps.map((x, j) => (j === i ? { ...x, kind: e.target.value as ComponentKind } : x)) })}>{KINDS.map((k) => <option key={k} value={k}>{k.toLowerCase()}</option>)}</Select></td>
              <td><Input aria-label="Key" disabled={readOnly} value={c.key} onChange={(e) => setEd({ ...ed, comps: ed.comps.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })} /></td>
              <td><Input aria-label="Formula" disabled={readOnly} value={c.coef} onChange={(e) => setEd({ ...ed, comps: ed.comps.map((x, j) => (j === i ? { ...x, coef: e.target.value } : x)) })} /></td>
              <td className="n"><Input aria-label="Unit cost" disabled={readOnly} inputMode="decimal" value={c.cost} onChange={(e) => setEd({ ...ed, comps: ed.comps.map((x, j) => (j === i ? { ...x, cost: e.target.value } : x)) })} style={{ width: 90 }} /></td></tr>)}</tbody>
          </table>
          {!readOnly && <Button variant="quiet" onClick={() => setEd({ ...ed, comps: [...ed.comps, { kind: 'HARDWARE', key: '', coef: '', cost: '' }] })}>Add a component</Button>}
          <div className="ops-toolbar">
            <Field label="Sell price formula ($ per unit, optional)"><Input disabled={readOnly} value={ed.price} onChange={(e) => setEd({ ...ed, price: e.target.value })} placeholder="200 + 10 w" /></Field>
            <Field label="Or markup on cost (%)"><Input disabled={readOnly} inputMode="decimal" value={ed.markup} onChange={(e) => setEd({ ...ed, markup: e.target.value })} style={{ width: 80 }} /></Field>
          </div>
          <Section title="Try it">
            <div className="ops-toolbar">{[...Object.keys(def.params), 'qty'].map((k) => <Field key={k} label={k}><Input inputMode="decimal" value={preview[k] ?? String(def.params[k]?.default ?? '')} onChange={(e) => setPreview({ ...preview, [k]: e.target.value })} style={{ width: 70 }} /></Field>)}</div>
            {liveErr && <p className="neg t-cap">{liveErr}</p>}
            {live && (
              <table className="ops-mini" aria-label="Expansion"><thead><tr><th>Component</th><th className="n">Qty</th><th className="n">Cost</th></tr></thead>
                <tbody>{live.components.map((c) => <tr key={c.key + c.kind}><td>{c.kind.toLowerCase()} · {c.key}</td><td className="n">{qty(c.qty, c.uom)}</td><td className="n">{m(c.cost_cents)}</td></tr>)}
                  <tr><td><strong>Total</strong> · {qty(live.labor_minutes)} shop min · {qty(live.install_hours)} install h</td><td /><td className="n"><strong>{m(live.cost_cents)}</strong> cost · <strong>{m(live.sell_cents)}</strong> sell</td></tr></tbody></table>
            )}
            <p className="t-cap">Labor without a unit cost uses the work center&apos;s estimating rate when it is saved.</p>
          </Section>
          {!readOnly && (
            <ButtonRow>
              <Button variant="primary" disabled={!/^[A-Z0-9_-]{2,30}$/.test(ed.code) || !ed.name.trim() || busy === 'save'} onClick={() => void run('save', FRONT, { op: 'save_product', companyId, code: ed.code, name: ed.name.trim(), family: ed.family, params: def.params, components: def.components, priceCoef: def.price_coef, markupPct: def.markup_pct }, 'Product saved')}>Save the product</Button>
              {toEst.productId && estimates.length > 0 && <>
                <Select aria-label="Estimate" value={toEst.estimateId} onChange={(e) => setToEst({ ...toEst, estimateId: e.target.value })}>{estimates.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</Select>
                <Button disabled={!toEst.estimateId || busy === 'est'} onClick={() => void run('est', FRONT, { op: 'add_product_line', estimateId: toEst.estimateId, productId: toEst.productId, params: Object.fromEntries(Object.entries(preview).map(([k, v]) => [k, Number(v) || 0])) }, 'Added to the estimate')}>Add to the estimate</Button>
              </>}
            </ButtonRow>
          )}
        </Section>
      )}
    </div>
  );
}

// ── proposals (MFG-11) ────────────────────────────────────────────────────────────────────────────
interface Proposal { id: string; version: number; status: string; title: string; alternates: Array<{ label: string; amount_cents?: number }>; allowances: Array<{ label: string; amount_cents?: number }>; clarifications: string[]; exclusions: string[]; deposit_schedule: Array<{ label: string; pct: number }>; valid_until: string | null; sent_at: string | null; signed_at: string | null; signer_name: string | null; declined_reason: string | null; deposit_request_id: string | null; estimate_total_cents: number | null; estimate_id: string }

/** The proposal on an estimate: alternates, allowances, clarifications, exclusions and the deposit schedule; e-signed, then the first deposit. */
export function ProposalsView({ estimates, today }: { estimates: Array<Opt & { proposalId: string | null }>; today: string }) {
  const { readOnly } = useShell();
  const [eid, setEid] = useState(estimates[0]?.id ?? '');
  const est = estimates.find((e) => e.id === eid);
  const [pid, setPid] = useState<string | null>(est?.proposalId ?? null);
  const p = useBoard<Proposal>(pid ? `${FRONT}?view=proposal&id=${pid}` : null);
  const { run, busy, error } = useDo(p.reload);
  const [f, setF] = useState<{ alt: string; allow: string; clar: string; excl: string; deposit: string; valid: string } | null>(null);
  const [signer, setSigner] = useState({ name: '', email: '' });
  const x = p.data;
  const fv = f ?? { alt: (x?.alternates ?? []).map((a) => `${a.label} | ${a.amount_cents != null ? (a.amount_cents / 100).toFixed(2) : ''}`).join('\n'), allow: (x?.allowances ?? []).map((a) => `${a.label} | ${a.amount_cents != null ? (a.amount_cents / 100).toFixed(2) : ''}`).join('\n'),
    clar: (x?.clarifications ?? ['Dimensions verified in the field before drafting.']).join('\n'), excl: (x?.exclusions ?? ['Countertops', 'Plumbing and electrical']).join('\n'), deposit: (x?.deposit_schedule ?? [{ label: 'Deposit at signing', pct: 0.5 }, { label: 'At delivery', pct: 0.4 }, { label: 'At completion', pct: 0.1 }]).map((d) => `${d.label} | ${Math.round(d.pct * 1000) / 10}`).join('\n'), valid: x?.valid_until ?? '' };
  const pairs = (s: string) => s.split('\n').map((l) => l.split('|').map((t) => t.trim())).filter((r) => r[0]);
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      {estimates.length === 0 ? <Empty title="No estimates" body="Price the job (takeoff → product library) first; the proposal is built on its estimate." /> : (
        <Field label="Estimate"><Select value={eid} onChange={(e) => { setEid(e.target.value); setPid(estimates.find((x2) => x2.id === e.target.value)?.proposalId ?? null); setF(null); }}>{estimates.map((e) => <option key={e.id} value={e.id}>{e.label}{e.sub ? ` · ${e.sub}` : ''}</option>)}</Select></Field>
      )}
      {pid && <BoardState b={p} what="The proposal" />}
      {x && (
        <InlineNotice tone={x.status === 'SIGNED' ? 'info' : x.status === 'DECLINED' ? 'neg' : 'default'} title={`Version ${x.version} · ${x.status.toLowerCase()}`}>
          {x.status === 'SIGNED' ? `Signed by ${x.signer_name ?? 'the client'} ${day(x.signed_at, today)}.` : x.status === 'SENT' ? `Sent ${day(x.sent_at, today)}; waiting on the signature.` : x.declined_reason ?? 'Draft.'}
          {x.estimate_total_cents != null ? ` Estimate total ${m(x.estimate_total_cents)}.` : ''}
        </InlineNotice>
      )}
      {eid && !readOnly && (!x || x.status === 'DRAFT') && (
        <Section title={x ? `Proposal v${x.version}` : 'New proposal'}>
          <Field label="Alternates (label | amount $, one per line)"><Textarea rows={2} value={fv.alt} onChange={(e) => setF({ ...fv, alt: e.target.value })} /></Field>
          <Field label="Allowances (label | amount $)"><Textarea rows={2} value={fv.allow} onChange={(e) => setF({ ...fv, allow: e.target.value })} /></Field>
          <Field label="Clarifications"><Textarea rows={2} value={fv.clar} onChange={(e) => setF({ ...fv, clar: e.target.value })} /></Field>
          <Field label="Exclusions"><Textarea rows={2} value={fv.excl} onChange={(e) => setF({ ...fv, excl: e.target.value })} /></Field>
          <Field label="Deposit schedule (step | %)"><Textarea rows={3} value={fv.deposit} onChange={(e) => setF({ ...fv, deposit: e.target.value })} /></Field>
          <Field label="Valid until"><Input type="date" value={fv.valid} onChange={(e) => setF({ ...fv, valid: e.target.value })} /></Field>
          <Button disabled={busy === 'save'} onClick={() => void run<{ id: string }>('save', FRONT, { op: 'save_proposal', estimateId: eid,
            alternates: pairs(fv.alt).map((r) => ({ label: r[0]!, amount_cents: centsFrom(r[1] ?? '') ?? 0 })), allowances: pairs(fv.allow).map((r) => ({ label: r[0]!, amount_cents: centsFrom(r[1] ?? '') ?? 0 })),
            clarifications: fv.clar.split('\n').map((s) => s.trim()).filter(Boolean), exclusions: fv.excl.split('\n').map((s) => s.trim()).filter(Boolean),
            depositSchedule: pairs(fv.deposit).map((r) => ({ label: r[0]!, pct: Math.min(Math.max((Number(r[1]) || 0) / 100, 0), 1) })), validUntil: fv.valid || null }, 'Proposal saved').then((r) => { if (r) { setPid(r.id); setF(null); } })}>Save</Button>
          {x && (
            <ButtonRow>
              <Input aria-label="Signer name" placeholder="Signer name" value={signer.name} onChange={(e) => setSigner({ ...signer, name: e.target.value })} />
              <Input aria-label="Signer e-mail" placeholder="Signer e-mail" value={signer.email} onChange={(e) => setSigner({ ...signer, email: e.target.value })} />
              <Button variant="primary" disabled={!signer.name.trim() || !/@/.test(signer.email) || busy === 'send'} onClick={() => void run('send', `/api/mfg/proposals/${x.id}/send`, { signers: [{ name: signer.name.trim(), email: signer.email.trim() }] }, 'Sent for signature')}>Send for signature</Button>
            </ButtonRow>
          )}
        </Section>
      )}
      {x?.status === 'SIGNED' && !readOnly && !x.deposit_request_id && (
        <Button variant="primary" disabled={busy === 'dep'} onClick={() => void run<{ amount_cents: number }>('dep', FRONT, { op: 'request_deposit', proposalId: x.id, step: 1 }, (r) => `Deposit ${m(r.amount_cents)} requested; Books invoices it`)}>Request the {x.deposit_schedule[0]?.label.toLowerCase() ?? 'deposit'}</Button>
      )}
    </div>
  );
}
