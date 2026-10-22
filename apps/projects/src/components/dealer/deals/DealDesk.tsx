'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Button, ButtonLink, Check, Field, Input, MoneyInput, Select, Status, Tag, Textarea, WidgetState, money, shortDate,
} from '@meritbooks/merit-ui';
import {
  DEPOSIT_STATUS, FINANCE_WORDS, FI_WORDS, LINE_TYPE_HELP, LINE_TYPE_WORDS, QUOTE_STATUS, TRADE_STATUS, UNIT_STATUS, dealEditable, dealerActivitySentence,
  floorMark, outboxMark, unitTitle,
} from '@/lib/pm/dealer/labels';
import { computeDealTotals, overAllowanceCents, type TotalsInput } from '@/lib/pm/dealer/math';
import { FI_PRODUCT_TYPES, type DealLineRow, type DealLineType, type FiProductType, type FinanceType, type TradeRow, type UnitInventoryRow } from '@/lib/pm/dealer/types';
import type { DealWorkspace } from '@/lib/pm/dealer/deal-queries';
import type { LookupItem } from '@/lib/pm/ops/types';
import { stamp } from '@/lib/time';
import { useShell } from '@/components/shell/ShellContext';
import { CustomerPicker, type CustomerValue } from '@/components/jobs/CustomerPicker';
import { PctInput, StatusMark, parseNum } from '@/components/ops/common/bits';
import { Lookup } from '@/components/ops/common/Lookup';
import { useStore, useStoreDetail } from '../common/useStore';
import { StageActions, StageBar, TotalsCard } from './DeskSide';

export interface DealDeskProps {
  initial: DealWorkspace;
  /** Free units of this company that can go on the deal. */
  stock: UnitInventoryRow[];
  today: string;
}

type Drafts = Record<string, number>;

/**
 * The sales desk: units, attachments, fees, rebates; trades (ACV, allowance, over-allowance, payoff);
 * F&I; deposits; the delivery checklist. Totals and the stage actions stay in view on the right.
 */
export function DealDesk(p: DealDeskProps) {
  const { readOnly } = useShell();
  const url = `/api/dealer/deals/${p.initial.deal.id}`;
  const { act, busy, version, failure } = useStore();
  const { data } = useStoreDetail<DealWorkspace>(version > 0 ? url : null, version);
  const w = data ?? p.initial;
  const d = w.deal;
  const editable = dealEditable(d.stage) && !readOnly;
  const [drafts, setDrafts] = useState<Drafts>({});

  // Preview the totals with unsaved price edits (client parity with pm.dealer_deal_totals).
  const preview = useMemo(() => {
    if (!Object.keys(drafts).length) return null;
    const input: TotalsInput = {
      lines: w.lines.map((l) => (drafts[l.id] != null ? { line_type: l.line_type, qty: l.qty, unit_price_cents: drafts[l.id], cost_cents: l.cost_cents, taxable: l.taxable } : { line_type: l.line_type, amount_cents: l.amount_cents, cost_cents: l.cost_cents, taxable: l.taxable })),
      trades: w.trades.map((t) => ({ status: t.status, acv_cents: drafts[`acv:${t.id}`] ?? t.acv_cents, allowance_cents: drafts[`allow:${t.id}`] ?? t.allowance_cents, payoff_cents: t.payoff_cents })),
      fi: w.fi, deposits: w.deposits, finance_reserve_cents: d.finance_reserve_cents, subvention_cents: d.subvention_cents,
      tax_rate_estimate: d.tax_rate_estimate, tax_exempt: d.tax_exempt, trade_reduces_taxable: w.settings.trade_reduces_taxable,
    };
    return computeDealTotals(input);
  }, [drafts, w, d]);

  const setDraft = (k: string, v: number | null) => setDrafts((x) => { const n = { ...x }; if (v == null) delete n[k]; else n[k] = v; return n; });
  const run = async <T,>(key: string, body: unknown, ok: string | ((x: T) => string | null), clear?: string[]) => {
    const r = await act<T>(key, 'post', url, body, ok);
    if (r.data && clear) setDrafts((x) => { const n = { ...x }; for (const c of clear) delete n[c]; return n; });
    return r;
  };

  const byType = (t: DealLineType) => w.lines.filter((l) => l.line_type === t);
  const freeStock = p.stock.filter((u) => !u.deal_id && !w.lines.some((l) => l.asset_id === u.unit_id) && ['ON_ORDER', 'IN_TRANSIT', 'IN_STOCK', 'PDI', 'DEMO'].includes(u.unit_status));

  return (
    <div className="stack">
      <StageBar stage={d.stage} />
      <div className="dl-desk">
        <div style={{ minWidth: 0 }}>
          <HeaderCard w={w} editable={editable} busy={busy} onSave={(patch, label) => void run('header', { op: 'header', ...patch }, label)} />

          <div className="dl-card">
            <div className="dl-card-h"><h2 className="t-section">Units and lines</h2><span className="sp" /><span className="t-cap">{w.totals.unit_count} unit{w.totals.unit_count === 1 ? '' : 's'}</span></div>
            <div className="dl-card-b flush">
              {w.lines.length === 0 ? (
                <div style={{ padding: 16 }}><WidgetState state={{ kind: 'empty', title: 'No units on the deal yet', body: 'Add a unit from stock below, then attachments, fees and rebates. Unit cost is pinned from the unit, so gross is live.' }} /></div>
              ) : (
                <table className="dl-tbl">
                  <thead><tr><th>Line</th><th className="n">Qty</th><th className="n">Price</th><th className="n">Amount</th><th className="n">Cost</th><th className="n">Gross</th>{editable && <th><span className="sr">Remove</span></th>}</tr></thead>
                  <tbody>
                    {(['UNIT', 'ATTACHMENT', 'FEE', 'DISCOUNT', 'REBATE', 'INCENTIVE'] as DealLineType[]).flatMap((t) => byType(t).map((l) => (
                      <LineRow key={l.id} l={l} w={w} today={p.today} editable={editable} busy={busy} draft={drafts[l.id] ?? null}
                        onDraft={(v) => setDraft(l.id, v)}
                        onSave={(patch, label) => void run('line', { op: 'update_line', lineId: l.id, ...patch }, label, [l.id])}
                        onRemove={() => void run(`rm:${l.id}`, { op: 'remove_line', lineId: l.id }, 'Removed the line', [l.id])} />
                    )))}
                  </tbody>
                </table>
              )}
              {editable && <AddLine stock={freeStock} busy={busy === 'add'} onAdd={(b) => run('add', { op: 'add_line', ...b }, `Added the ${LINE_TYPE_WORDS[b.lineType as DealLineType].toLowerCase()}`)} />}
            </div>
          </div>

          <Trades w={w} editable={editable} busy={busy} drafts={drafts} setDraft={setDraft} run={run} />
          <FiCard w={w} editable={editable} busy={busy} run={run} />
          <Checklist w={w} readOnly={readOnly} busy={busy} today={p.today} run={run} />
          <Quotes w={w} today={p.today} />
          <Deposits w={w} />

          <div className="dl-card">
            <div className="dl-card-h"><h2 className="t-section">Timeline</h2></div>
            <div className="dl-card-b">
              {w.activity.length === 0 ? <p className="t-cap">Quotes, the desk, funding and delivery show here as they happen.</p> : (
                <ul className="feed feed--flush">
                  {w.activity.map((a) => (
                    <li key={a.id}><span className="l1" style={{ fontWeight: 400 }}>{dealerActivitySentence(a)} {a.actor_type === 'SYSTEM' ? <Tag>System</Tag> : null}</span><span className="t">{stamp(a.created_at)}</span></li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>

        <aside className="dl-desk-side" aria-label="Totals and next step">
          <TotalsCard totals={w.totals} preview={preview} floorPct={w.settings.margin_floor_pct} minFront={w.settings.min_front_gross_cents} />
          <StageActions w={w} url={url} act={act} busy={busy} failure={failure} readOnly={readOnly} today={p.today} />
          <div className="dl-noprint"><ButtonLink variant="quiet" href={`/deals/${d.id}/quote`} icon="file-text">Printable quote</ButtonLink></div>
        </aside>
      </div>
    </div>
  );
}

function HeaderCard({ w, editable, busy, onSave }: { w: DealWorkspace; editable: boolean; busy: string | null; onSave: (patch: Record<string, unknown>, label: string) => void }) {
  const d = w.deal;
  const [customer, setCustomer] = useState<CustomerValue>({ id: d.customer_id, name: w.customer ?? '' });
  const [vendor, setVendor] = useState<LookupItem | null>(null);
  const [notes, setNotes] = useState(d.notes ?? '');
  const [reserve, setReserve] = useState<number | null>(d.finance_reserve_cents || null);
  const [subvention, setSubvention] = useState<number | null>(d.subvention_cents || null);
  const [exemptRef, setExemptRef] = useState(d.tax_exempt_ref ?? '');
  if (!editable) {
    return (
      <div className="dl-card">
        <div className="dl-card-h"><h2 className="t-section">Customer and terms</h2></div>
        <div className="dl-card-b dl-kv2">
          <p><span className="t-cap">Customer</span><br />{w.customer ?? 'Not picked'}</p>
          <p><span className="t-cap">Pays by</span><br />{FINANCE_WORDS[d.finance_type]}{d.finance_vendor_id ? ` · ${w.vendors[d.finance_vendor_id] ?? 'finance company'}` : ''}</p>
          <p><span className="t-cap">Tax</span><br />{d.tax_exempt ? `Exempt${d.tax_exempt_ref ? ` (${d.tax_exempt_ref})` : ''}` : d.tax_rate_estimate != null ? `Estimate at ${(d.tax_rate_estimate * 100).toFixed(2)}%` : 'No estimate'}</p>
          {d.notes && <p><span className="t-cap">Notes</span><br />{d.notes}</p>}
        </div>
      </div>
    );
  }
  return (
    <div className="dl-card">
      <div className="dl-card-h"><h2 className="t-section">Customer and terms</h2><span className="sp" />{busy === 'header' && <span className="t-cap">Saving…</span>}</div>
      <div className="dl-card-b mp-form">
        <Field label="Customer"><CustomerPicker value={customer} onChange={(c) => { setCustomer(c); if (c.id && c.id !== d.customer_id) onSave({ customerId: c.id }, `Customer set to ${c.name}`); }} companyId={d.location_id} /></Field>
        <div className="mp-form-2">
          <Field label="Pays by">
            <Select value={d.finance_type} onChange={(e) => onSave({ financeType: e.target.value as FinanceType }, 'Saved how they pay')}>
              {(Object.keys(FINANCE_WORDS) as FinanceType[]).map((f) => <option key={f} value={f}>{FINANCE_WORDS[f]}</option>)}
            </Select>
          </Field>
          {d.finance_type !== 'CASH' ? (
            <Field label="Finance company" help={d.finance_vendor_id ? w.vendors[d.finance_vendor_id] : 'The company that funds the contract'}>
              <Lookup kind="vendors" value={vendor ?? (d.finance_vendor_id ? { id: d.finance_vendor_id, label: w.vendors[d.finance_vendor_id] ?? 'Finance company' } : null)} onChange={(it) => { setVendor(it); if (it) onSave({ financeVendorId: it.id }, `Finance company set to ${it.label}`); }} placeholder="Search vendors" />
            </Field>
          ) : <span />}
        </div>
        {d.finance_type !== 'CASH' && (
          <div className="mp-form-2">
            <Field label="Finance reserve (dealer participation)"><MoneyInput valueCents={reserve} onChangeCents={setReserve} onBlur={() => { if ((reserve ?? 0) !== d.finance_reserve_cents) onSave({ financeReserveCents: reserve ?? 0 }, 'Saved the finance reserve'); }} placeholder="0.00" /></Field>
            <Field label="Subvention (rate buy-down)"><MoneyInput valueCents={subvention} onChangeCents={setSubvention} onBlur={() => { if ((subvention ?? 0) !== d.subvention_cents) onSave({ subventionCents: subvention ?? 0 }, 'Saved the subvention'); }} placeholder="0.00" /></Field>
          </div>
        )}
        <div className="mp-form-2">
          <Field label="Sales tax estimate" help="Merit Books calculates the final tax">
            <PctInput value={d.tax_rate_estimate} max={25} onChange={(v) => { if (v !== d.tax_rate_estimate) onSave({ taxRateEstimate: v }, 'Saved the tax estimate'); }} aria-label="Sales tax estimate" placeholder="7" />
          </Field>
          <Field label="Exemption certificate">
            <div className="row" style={{ gap: 8 }}>
              <Check label="Exempt" checked={d.tax_exempt} onChange={(e) => onSave({ taxExempt: e.target.checked }, e.target.checked ? 'Marked tax exempt' : 'Tax exemption removed')} />
              {d.tax_exempt && <Input value={exemptRef} onChange={(e) => setExemptRef(e.target.value)} onBlur={() => { if (exemptRef !== (d.tax_exempt_ref ?? '')) onSave({ taxExemptRef: exemptRef.trim() || null }, 'Saved the certificate'); }} placeholder="Ag or resale number" maxLength={60} />}
            </div>
          </Field>
        </div>
        <Field label="Notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => { if (notes !== (d.notes ?? '')) onSave({ notes: notes.trim() || null }, 'Saved the notes'); }} maxLength={2000} /></Field>
      </div>
    </div>
  );
}

function LineRow({ l, w, today, editable, busy, draft, onDraft, onSave, onRemove }: {
  l: DealLineRow; w: DealWorkspace; today: string; editable: boolean; busy: string | null; draft: number | null;
  onDraft: (v: number | null) => void; onSave: (patch: Record<string, unknown>, label: string) => void; onRemove: () => void;
}) {
  const unit = l.asset_id ? w.units[l.asset_id] : null;
  const neg = l.line_type === 'DISCOUNT' || l.line_type === 'REBATE';
  const hasCost = l.line_type === 'UNIT' || l.line_type === 'ATTACHMENT';
  const gross = hasCost ? l.amount_cents - l.cost_cents : null;
  const f = unit ? floorMark({ ...unit, sold_out_of_trust: !!unit.sot_alert_at }, today) : null;
  return (
    <tr>
      <td>
        <span className="l1">{l.description || LINE_TYPE_WORDS[l.line_type]}</span>
        <span className="l2">
          {[LINE_TYPE_WORDS[l.line_type], unit?.stock_number, unit?.unit_status ? UNIT_STATUS[unit.unit_status].word : null, l.program_ref ? `program ${l.program_ref}` : null, !l.taxable && !['REBATE', 'INCENTIVE'].includes(l.line_type) ? 'not taxed' : null].filter(Boolean).join(' · ')}
        </span>
        {f && unit?.floor_status && <span className="l2"><Status kind={f.kind} pip={f.pip}>{f.word}</Status></span>}
      </td>
      <td className="n">{l.line_type === 'UNIT' ? '1' : editable ? <Input aria-label="Quantity" inputMode="decimal" defaultValue={String(l.qty)} style={{ width: 64 }} onBlur={(e) => { const q = parseNum(e.target.value); if (q != null && q > 0 && q !== l.qty) onSave({ qty: q }, 'Saved the quantity'); }} /> : l.qty}</td>
      <td className="n">
        {editable ? (
          <MoneyInput aria-label="Price" valueCents={draft ?? l.unit_price_cents} onChangeCents={(v) => onDraft(v === l.unit_price_cents ? null : v)} onBlur={() => { if (draft != null && draft !== l.unit_price_cents) onSave({ unitPriceCents: draft }, 'Saved the price'); }} style={{ width: 120 }} />
        ) : money(l.unit_price_cents)}
      </td>
      <td className="n">{money(neg ? -l.amount_cents : l.amount_cents)}</td>
      <td className="n">{hasCost ? money(l.cost_cents) : '—'}</td>
      <td className="n">{gross == null ? (l.line_type === 'INCENTIVE' ? money(l.amount_cents) : '—') : <span className={gross < 0 ? 'neg' : undefined}>{money(gross)}</span>}</td>
      {editable && <td><Button variant="quiet" iconOnly icon="x" aria-label={`Remove ${l.description || 'the line'}`} disabled={busy === `rm:${l.id}`} onClick={onRemove} /></td>}
    </tr>
  );
}

function AddLine({ stock, busy, onAdd }: { stock: UnitInventoryRow[]; busy: boolean; onAdd: (b: Record<string, unknown>) => Promise<{ data: unknown }> }) {
  const [type, setType] = useState<DealLineType>(stock.length ? 'UNIT' : 'ATTACHMENT');
  const [unitId, setUnitId] = useState('');
  const [desc, setDesc] = useState('');
  const [qty, setQty] = useState('1');
  const [price, setPrice] = useState<number | null>(null);
  const [program, setProgram] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    const q = parseNum(qty);
    if (type === 'UNIT' && !unitId) return setErr('Pick the unit.');
    if (type !== 'UNIT' && !desc.trim()) return setErr('Describe the line.');
    if (type !== 'UNIT' && (q == null || q <= 0)) return setErr('Quantity must be more than 0.');
    if (type !== 'UNIT' && price == null) return setErr('Give the price.');
    setErr(null);
    const r = await onAdd({ lineType: type, unitId: type === 'UNIT' ? unitId : null, description: desc.trim() || null, qty: type === 'UNIT' ? 1 : q, unitPriceCents: type === 'UNIT' ? price : price, programRef: program.trim() || null });
    if (r.data) { setUnitId(''); setDesc(''); setQty('1'); setPrice(null); setProgram(''); }
  };
  return (
    <form className="dl-addrow" style={{ gridTemplateColumns: type === 'UNIT' ? '160px minmax(0,1fr) 130px auto' : '160px minmax(0,2fr) 80px 130px auto' }} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <Field label="Add" help={LINE_TYPE_HELP[type]}>
        <Select value={type} onChange={(e) => setType(e.target.value as DealLineType)}>
          {(['UNIT', 'ATTACHMENT', 'FEE', 'DISCOUNT', 'REBATE', 'INCENTIVE'] as DealLineType[]).map((t) => <option key={t} value={t}>{LINE_TYPE_WORDS[t]}</option>)}
        </Select>
      </Field>
      {type === 'UNIT' ? (
        <Field label="Unit from stock" error={err ?? undefined}>
          <Select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
            <option value="">{stock.length ? 'Pick a unit' : 'No free units in stock'}</option>
            {stock.map((u) => <option key={u.unit_id} value={u.unit_id}>{u.stock_number} · {unitTitle(u)}{u.advertised_price_cents ?? u.retail_price_cents ? ` · ${money((u.advertised_price_cents ?? u.retail_price_cents)!)}` : ''}</option>)}
          </Select>
        </Field>
      ) : (
        <>
          <Field label={type === 'REBATE' || type === 'INCENTIVE' ? 'Program' : 'Description'} error={err ?? undefined}>
            <Input value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={300} placeholder={type === 'FEE' ? 'Documentation fee' : type === 'ATTACHMENT' ? 'LA344 front loader' : type === 'REBATE' ? 'Kubota cash back, Q4' : type === 'INCENTIVE' ? 'Retail sales incentive' : 'Discount'} />
          </Field>
          <Field label="Qty"><Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
        </>
      )}
      <Field label={type === 'UNIT' ? 'Price (blank = advertised)' : 'Price each'}><MoneyInput valueCents={price} onChangeCents={setPrice} placeholder="0.00" /></Field>
      {(type === 'REBATE' || type === 'INCENTIVE') && <Field label="Program code"><Input value={program} onChange={(e) => setProgram(e.target.value)} maxLength={60} /></Field>}
      <div><Button type="submit" icon="plus" disabled={busy}>Add</Button></div>
    </form>
  );
}

type Run = <T>(key: string, body: unknown, ok: string | ((x: T) => string | null), clear?: string[]) => Promise<{ data: T | null }>;

function Trades({ w, editable, busy, drafts, setDraft, run }: { w: DealWorkspace; editable: boolean; busy: string | null; drafts: Drafts; setDraft: (k: string, v: number | null) => void; run: Run }) {
  const [adding, setAdding] = useState(false);
  const live = w.trades.filter((t) => t.status !== 'VOID');
  return (
    <div className="dl-card">
      <div className="dl-card-h"><h2 className="t-section">Trades</h2><span className="sp" />{live.length > 0 && <span className="t-cap">Allowance {money(w.totals.trade_allowance_cents)} · ACV {money(w.totals.trade_acv_cents)}</span>}</div>
      <div className="dl-card-b">
        {live.length === 0 && !adding && <p className="t-cap">No trade-in. Add one with its serial, hours, appraisal (ACV) and the allowance you give.</p>}
        {live.map((t) => <TradeRowView key={t.id} t={t} w={w} editable={editable && t.status === 'APPRAISED'} busy={busy} drafts={drafts} setDraft={setDraft} run={run} />)}
        {editable && (adding ? <TradeForm busy={busy === 'trade'} onCancel={() => setAdding(false)} onSubmit={async (b) => { const r = await run('trade', { op: 'add_trade', ...b }, 'Added the trade'); if (r.data) setAdding(false); }} /> : <Button icon="plus" onClick={() => setAdding(true)}>Add a trade</Button>)}
      </div>
    </div>
  );
}

function TradeRowView({ t, w, editable, busy, drafts, setDraft, run }: { t: TradeRow; w: DealWorkspace; editable: boolean; busy: string | null; drafts: Drafts; setDraft: (k: string, v: number | null) => void; run: Run }) {
  const acv = drafts[`acv:${t.id}`] ?? t.acv_cents;
  const allow = drafts[`allow:${t.id}`] ?? t.allowance_cents;
  const over = overAllowanceCents({ acv_cents: acv, allowance_cents: allow });
  return (
    <div style={{ borderBottom: '1px solid var(--line)', padding: '8px 0' }}>
      <div className="row row--between">
        <span className="b">{[t.model_year, t.make, t.model].filter(Boolean).join(' ') || 'Trade-in'}{t.serial_number ? ` · S/N ${t.serial_number}` : ''}</span>
        <StatusMark mark={TRADE_STATUS[t.status]} />
      </div>
      <p className="t-cap">{[t.meter_reading != null ? `${t.meter_reading} hours` : null, t.condition_notes, t.appraised_at ? `appraised ${shortDate(t.appraised_at.slice(0, 10))}` : 'not appraised yet'].filter(Boolean).join(' · ')}</p>
      <div className="dl-kv2" style={{ marginTop: 8 }}>
        {editable ? (
          <>
            <Field label="ACV (appraisal)"><MoneyInput valueCents={acv} onChangeCents={(v) => setDraft(`acv:${t.id}`, v === t.acv_cents ? null : v)} onBlur={() => { const v = drafts[`acv:${t.id}`]; if (v != null) void run('trade', { op: 'update_trade', tradeId: t.id, acvCents: v }, 'Saved the appraisal', [`acv:${t.id}`]); }} placeholder="Not appraised" /></Field>
            <Field label="Allowance on the deal"><MoneyInput valueCents={allow} onChangeCents={(v) => setDraft(`allow:${t.id}`, v === t.allowance_cents ? null : v)} onBlur={() => { const v = drafts[`allow:${t.id}`]; if (v != null) void run('trade', { op: 'update_trade', tradeId: t.id, allowanceCents: v }, 'Saved the allowance', [`allow:${t.id}`]); }} placeholder="0.00" /></Field>
          </>
        ) : (
          <>
            <p><span className="t-cap">ACV</span><br /><span className="tnum">{t.acv_cents == null ? 'Not appraised' : money(t.acv_cents)}</span></p>
            <p><span className="t-cap">Allowance</span><br /><span className="tnum">{money(t.allowance_cents)}</span></p>
          </>
        )}
      </div>
      <div className="ops-facts" style={{ marginTop: 4 }}>
        <span>Over-allowance <b className={over > 0 ? 'tnum neg' : 'tnum'}>{money(over)}</b></span>
        {t.payoff_cents > 0 && <span>Payoff <b className="tnum">{money(t.payoff_cents)}</b> to {t.lienholder_vendor_id ? w.vendors[t.lienholder_vendor_id] ?? 'the lienholder' : 'the lienholder'}{t.lien_account_ref ? ` (${t.lien_account_ref})` : ''}</span>}
        {t.received_asset_id && <Link className="link" href={`/stock?unit=${t.received_asset_id}`}>Open the used unit</Link>}
      </div>
      {editable && <div style={{ marginTop: 4 }}><Button variant="quiet" disabled={busy === `rmt:${t.id}`} onClick={() => void run(`rmt:${t.id}`, { op: 'remove_trade', tradeId: t.id }, 'Removed the trade')}>Remove trade</Button></div>}
    </div>
  );
}

function TradeForm({ busy, onCancel, onSubmit }: { busy: boolean; onCancel: () => void; onSubmit: (b: Record<string, unknown>) => void }) {
  const [serial, setSerial] = useState('');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState('');
  const [hours, setHours] = useState('');
  const [notes, setNotes] = useState('');
  const [acv, setAcv] = useState<number | null>(null);
  const [allow, setAllow] = useState<number | null>(null);
  const [payoff, setPayoff] = useState<number | null>(null);
  const [lien, setLien] = useState<LookupItem | null>(null);
  const [lienRef, setLienRef] = useState('');
  const [err, setErr] = useState<Record<string, string>>({});
  return (
    <form className="mp-form" style={{ marginTop: 12 }} onSubmit={(e) => {
      e.preventDefault();
      const er: Record<string, string> = {};
      if (!serial.trim()) er.serial = 'Key the serial number.';
      if ((payoff ?? 0) > 0 && !lien) er.lien = 'A payoff needs the lienholder.';
      const y = year.trim() ? parseNum(year) : null;
      if (year.trim() && (y == null || y < 1900 || y > 2200)) er.year = 'Use a four-digit year.';
      setErr(er);
      if (Object.keys(er).length) return;
      onSubmit({ serialNumber: serial.trim(), make: make.trim() || null, model: model.trim() || null, modelYear: y, meterReading: hours.trim() ? parseNum(hours) : null, conditionNotes: notes.trim() || null, acvCents: acv, allowanceCents: allow ?? 0, payoffCents: payoff ?? 0, lienholderVendorId: lien?.id ?? null, lienAccountRef: lienRef.trim() || null });
    }}>
      <div className="mp-form-2">
        <Field label="Serial number" error={err.serial}><Input autoFocus value={serial} onChange={(e) => setSerial(e.target.value)} maxLength={80} /></Field>
        <Field label="Hours"><Input inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} /></Field>
      </div>
      <div className="mp-form-2">
        <Field label="Make"><Input value={make} onChange={(e) => setMake(e.target.value)} maxLength={60} /></Field>
        <Field label="Model"><Input value={model} onChange={(e) => setModel(e.target.value)} maxLength={80} /></Field>
      </div>
      <div className="mp-form-2">
        <Field label="Year" error={err.year}><Input inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value)} maxLength={4} /></Field>
        <Field label="ACV (appraisal)"><MoneyInput valueCents={acv} onChangeCents={setAcv} placeholder="Appraise later" /></Field>
      </div>
      <div className="mp-form-2">
        <Field label="Allowance on the deal"><MoneyInput valueCents={allow} onChangeCents={setAllow} placeholder="0.00" /></Field>
        <Field label="Payoff owed"><MoneyInput valueCents={payoff} onChangeCents={setPayoff} placeholder="0.00" /></Field>
      </div>
      {(payoff ?? 0) > 0 && (
        <div className="mp-form-2">
          <Field label="Lienholder" error={err.lien}><Lookup kind="vendors" value={lien ? { id: lien.id, label: lien.label } : null} onChange={setLien} placeholder="Search vendors" /></Field>
          <Field label="Loan account"><Input value={lienRef} onChange={(e) => setLienRef(e.target.value)} maxLength={60} /></Field>
        </div>
      )}
      <Field label="Condition"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} placeholder="Rear tires at 40%, small hydraulic seep at the loader valve" /></Field>
      <p className="t-cap">Over-allowance (allowance above ACV) comes off front gross. At delivery the trade becomes a used unit in stock at the lower of ACV and allowance; Merit Books books it.</p>
      <div className="btn-row"><Button onClick={onCancel}>Back</Button><Button type="submit" variant="primary" disabled={busy}>Add trade</Button></div>
    </form>
  );
}

function FiCard({ w, editable, busy, run }: { w: DealWorkspace; editable: boolean; busy: string | null; run: Run }) {
  const [type, setType] = useState<FiProductType>('EXTENDED_WARRANTY');
  const [desc, setDesc] = useState('');
  const [price, setPrice] = useState<number | null>(null);
  const [cost, setCost] = useState<number | null>(null);
  const [term, setTerm] = useState('');
  const [provider, setProvider] = useState<LookupItem | null>(null);
  return (
    <div className="dl-card">
      <div className="dl-card-h"><h2 className="t-section">F&amp;I products</h2><span className="sp" />{w.fi.length > 0 && <span className="t-cap">Back gross {money(w.totals.back_gross_cents)}</span>}</div>
      <div className="dl-card-b flush">
        {w.fi.length === 0 ? <p className="t-cap" style={{ padding: '12px 16px' }}>No products. Extended warranty, maintenance plans and protection add back gross.</p> : (
          <table className="dl-tbl">
            <thead><tr><th>Product</th><th className="n">Term</th><th className="n">Price</th><th className="n">Cost</th><th className="n">Gross</th>{editable && <th><span className="sr">Remove</span></th>}</tr></thead>
            <tbody>
              {w.fi.map((f) => (
                <tr key={f.id}>
                  <td><span className="l1">{f.description || FI_WORDS[f.product_type]}</span><span className="l2">{[FI_WORDS[f.product_type], f.provider_vendor_id ? w.vendors[f.provider_vendor_id] : null, f.contract_number].filter(Boolean).join(' · ')}</span></td>
                  <td className="n">{f.term_months ? `${f.term_months} mo` : '—'}</td>
                  <td className="n">{money(f.price_cents)}</td>
                  <td className="n">{money(f.cost_cents)}</td>
                  <td className="n">{money(f.price_cents - f.cost_cents)}</td>
                  {editable && <td><Button variant="quiet" iconOnly icon="x" aria-label={`Remove ${FI_WORDS[f.product_type]}`} disabled={busy === `rmf:${f.id}`} onClick={() => void run(`rmf:${f.id}`, { op: 'remove_fi', fiId: f.id }, 'Removed the product')} /></td>}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {editable && (
          <form className="dl-addrow" style={{ gridTemplateColumns: '170px minmax(0,1fr) 110px 110px 70px auto' }} onSubmit={(e) => {
            e.preventDefault();
            void run('fi', { op: 'add_fi', productType: type, description: desc.trim() || null, priceCents: price ?? 0, costCents: cost ?? 0, termMonths: term.trim() ? parseNum(term) : null, providerVendorId: provider?.id ?? null }, `Added ${FI_WORDS[type].toLowerCase()}`)
              .then((r) => { if (r.data) { setDesc(''); setPrice(null); setCost(null); setTerm(''); } });
          }}>
            <Field label="Product"><Select value={type} onChange={(e) => setType(e.target.value as FiProductType)}>{FI_PRODUCT_TYPES.map((t) => <option key={t} value={t}>{FI_WORDS[t]}</option>)}</Select></Field>
            <Field label="Provider"><Lookup kind="vendors" value={provider ? { id: provider.id, label: provider.label } : null} onChange={setProvider} placeholder="Optional" /></Field>
            <Field label="Price"><MoneyInput valueCents={price} onChangeCents={setPrice} placeholder="0.00" /></Field>
            <Field label="Cost"><MoneyInput valueCents={cost} onChangeCents={setCost} placeholder="0.00" /></Field>
            <Field label="Months"><Input inputMode="numeric" value={term} onChange={(e) => setTerm(e.target.value)} /></Field>
            <div><Button type="submit" icon="plus" disabled={busy === 'fi' || price == null}>Add</Button></div>
          </form>
        )}
      </div>
    </div>
  );
}

function Checklist({ w, readOnly, busy, today, run }: { w: DealWorkspace; readOnly: boolean; busy: string | null; today: string; run: Run }) {
  const d = w.deal;
  const live = !readOnly && !['DELIVERED', 'UNWOUND', 'LOST'].includes(d.stage);
  const units = Object.values(w.units);
  const pdiOpen = units.filter((u) => u.pdi_open);
  const pdiNone = units.filter((u) => u.condition === 'NEW' && !u.pdi_open && !u.pdi_done);
  return (
    <div className="dl-card">
      <div className="dl-card-h"><h2 className="t-section">Delivery checklist</h2><span className="sp" /><span className="t-cap">{d.delivery_checklist.filter((c) => c.done).length} of {d.delivery_checklist.length} done</span></div>
      <div className="dl-card-b">
        {d.delivery_checklist.length === 0 ? <p className="t-cap">No checklist on this deal. Store settings set the steps for new deals.</p> : (
          <ul className="ops-checks">
            {d.delivery_checklist.map((c) => (
              <li key={c.key}>
                <span className={c.done ? 'ok' : 'no'} aria-hidden="true">{c.done ? '✓' : '·'}</span>
                <span>
                  {live ? <Check label={`${c.label}${c.required ? '' : ' (optional)'}`} checked={!!c.done} disabled={busy === `chk:${c.key}`} onChange={(e) => void run(`chk:${c.key}`, { op: 'check', key: c.key, done: e.target.checked }, e.target.checked ? `Checked: ${c.label}` : `Unchecked: ${c.label}`)} /> : <span>{c.label}</span>}
                  {c.done && c.done_at && <span className="l2">{c.done_by === 'system:pdi_closed' ? 'PDI repair order closed' : 'done'} {shortDate(c.done_at.slice(0, 10), today)}</span>}
                </span>
                <span className="t-cap">{c.required ? 'Required' : ''}</span>
              </li>
            ))}
          </ul>
        )}
        {(pdiOpen.length > 0 || pdiNone.length > 0) && (
          <p className="t-cap" style={{ marginTop: 8 }}>
            {pdiOpen.length > 0 && `PDI open on ${pdiOpen.map((u) => u.stock_number).join(', ')}; it ticks itself when the repair order closes. `}
            {pdiNone.length > 0 && `No PDI yet on ${pdiNone.map((u) => u.stock_number).join(', ')}; open one from the unit in Stock.`}
          </p>
        )}
      </div>
    </div>
  );
}

function Quotes({ w, today }: { w: DealWorkspace; today: string }) {
  if (w.quotes.length === 0) return null;
  return (
    <div className="dl-card">
      <div className="dl-card-h"><h2 className="t-section">Quotes</h2></div>
      <div className="dl-card-b flush">
        <table className="dl-tbl">
          <thead><tr><th>Quote</th><th>Status</th><th className="n">Cash price</th><th>Good until</th><th><span className="sr">Print</span></th></tr></thead>
          <tbody>
            {w.quotes.map((q) => (
              <tr key={q.id}>
                <td><span className="l1 code">{q.number}</span><span className="l2">v{q.version} · issued {shortDate(q.issued_at.slice(0, 10), today)}</span></td>
                <td><StatusMark mark={QUOTE_STATUS[q.status]} />{q.decline_reason && <span className="l2">{q.decline_reason}</span>}</td>
                <td className="n">{money(Number(q.totals?.cash_price_cents ?? 0))}</td>
                <td>{q.valid_until ? shortDate(q.valid_until, today) : '—'}</td>
                <td><Link className="link" href={`/deals/${w.deal.id}/quote?q=${q.id}`}>Print</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Deposits({ w }: { w: DealWorkspace }) {
  if (w.deposits.length === 0) return null;
  return (
    <div className="dl-card">
      <div className="dl-card-h"><h2 className="t-section">Deposits</h2><span className="sp" /><span className="t-cap tnum">{money(w.totals.deposits_cents)}</span></div>
      <div className="dl-card-b">
        <ul className="feed feed--flush">
          {w.deposits.map((dp) => {
            const m = w.depositMarks[dp.id];
            return (
              <li key={dp.id}>
                <span><span className="l1" style={{ fontWeight: 400 }}>{money(dp.amount_cents)}{dp.memo ? ` · ${dp.memo}` : ''}</span>{dp.invoice_number && <span className="l2">Invoice {dp.invoice_number}</span>}{dp.error_text && <span className="l2 neg">{dp.error_text}</span>}</span>
                <span className="t">{m ? <Status kind={outboxMark(m.status, m.suppressed_reason).kind} pip={outboxMark(m.status, m.suppressed_reason).pip}>{outboxMark(m.status, m.suppressed_reason).word}</Status> : <StatusMark mark={DEPOSIT_STATUS[dp.status]} />}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
