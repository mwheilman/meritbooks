'use client';

import { useMemo, useState } from 'react';
import { Button, Field, Input, MoneyInput, PanelSection, Seg, Select, api, count } from '@meritbooks/merit-ui';
import { useSellText } from '@/components/money/useMoneyText';
import { useMoneyVis } from '@/components/shell/ShellContext';
import { PAY_TYPE_HELP, PAY_TYPE_WORDS, RO_EDITOR_KINDS, RO_KIND_WORDS } from '@/lib/pm/dealer/labels';
import { counterLookup, paySplit, splitTotal, type PaySplit } from '@/lib/pm/dealer/math';
import type { CounterSearch } from '@/lib/pm/dealer/parts-queries';
import { RO_PAY_TYPES, type RoLineKind, type RoLineRow, type RoPayType } from '@/lib/pm/dealer/types';
import type { LookupItem } from '@/lib/pm/ops/types';
import { DetailState, Failure, parseNum } from '@/components/ops/common/bits';
import { Lookup } from '@/components/ops/common/Lookup';
import { useStore, useStoreDetail } from '../common/useStore';

interface RoData {
  order: { id: string; location_id: string; number: string | null; kind: string; status: string; payer_customer_id: string | null; asset_id: string | null };
  lines: RoLineRow[];
  partNumbers: Record<string, string>;
  claims: Array<{ id: string; status: string; claimed_cents: number; claim_number: string | null }>;
  payerName: string | null;
}

export interface RoLineEditorProps {
  workOrderId: string;
  /** Closed / cancelled ROs, and the read-only consolidated view. */
  locked: boolean;
  /** Tell the host panel to refetch (claims, totals) after a change here. */
  onChanged?: () => void;
}

/**
 * RO lines by type (labor op, part, sublet, misc), each with a pay type (customer, warranty,
 * internal, policy), and the pay-type split Merit Books receives when the RO closes. Mounted by
 * the repair order panel for dealer companies.
 */
export function RoLineEditor({ workOrderId, locked, onChanged }: RoLineEditorProps) {
  const money = useSellText();
  const url = `/api/dealer/ro/${workOrderId}`;
  const { act, busy, version, error } = useStore();
  const { data, error: loadError, isLoading, refetch } = useStoreDetail<RoData>(url, version);
  const split = useMemo(() => paySplit(data?.lines ?? []), [data?.lines]);

  const run = async (key: string, body: unknown, ok: string) => {
    const r = await act(key, 'post', url, body, ok);
    if (r.data) onChanged?.();
    return r;
  };

  if (!data) return <PanelSection title="Lines"><DetailState loading={isLoading} error={loadError} onRetry={() => void refetch()} what="Lines" /></PanelSection>;
  const approved = data.lines.filter((l) => l.status === 'APPROVED');
  const proposed = data.lines.filter((l) => l.status === 'PROPOSED');
  const total = splitTotal(split);

  return (
    <>
      <PanelSection title="Lines" meta={<span className="tnum b">{money(total)}</span>}>
        {approved.length === 0 ? (
          <p className="t-cap">No lines yet. Add labor ops, parts, sublet and misc below; each carries who pays.</p>
        ) : (
          <table className="dl-tbl">
            <thead><tr><th>Line</th><th>Pays</th><th className="n">Qty</th><th className="n">Amount</th>{!locked && <th><span className="sr">Remove</span></th>}</tr></thead>
            <tbody>
              {approved.map((l) => (
                <tr key={l.id}>
                  <td>
                    <span className="l1">{l.description}</span>
                    <span className="l2">{[RO_KIND_WORDS[l.kind], l.labor_op ? `op ${l.labor_op}` : null, l.part_id ? data.partNumbers[l.part_id] : null, l.flag_hours ? `${l.flag_hours} flag hours` : null, l.unit_price_cents != null ? `${money(l.unit_price_cents)} each` : null, l.issued_move_id ? 'issued from stock' : null].filter(Boolean).join(' · ')}</span>
                  </td>
                  <td>
                    {locked ? PAY_TYPE_WORDS[l.pay_type] : (
                      <Select aria-label={`Who pays for ${l.description}`} value={l.pay_type} disabled={busy === `pt:${l.id}`} onChange={(e) => void run(`pt:${l.id}`, { op: 'update_line', lineId: l.id, payType: e.target.value as RoPayType }, `Now ${PAY_TYPE_WORDS[e.target.value as RoPayType].toLowerCase()} pay`)} style={{ width: 112 }}>
                        {RO_PAY_TYPES.map((t) => <option key={t} value={t}>{PAY_TYPE_WORDS[t]}</option>)}
                      </Select>
                    )}
                  </td>
                  <td className="n">{l.qty} {l.uom}</td>
                  <td className="n">{money(l.amount_cents)}</td>
                  {!locked && <td><Button variant="quiet" iconOnly icon="x" aria-label={`Remove ${l.description}`} disabled={busy === `rm:${l.id}`} onClick={() => void run(`rm:${l.id}`, { op: 'remove_line', lineId: l.id }, 'Removed the line')} /></td>}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {proposed.length > 0 && <p className="t-cap" style={{ marginTop: 8 }}>{count(proposed.length)} option{proposed.length === 1 ? '' : 's'} waiting on the customer: {proposed.map((l) => l.description).join(', ')}.</p>}
        {error && <div style={{ marginTop: 8 }}><Failure text={error} /></div>}
        {!locked && <AddRoLine companyId={data.order.location_id} busy={busy === 'add'} onAdd={(b) => run('add', { op: 'add_line', ...b }, 'Added the line')} />}
      </PanelSection>

      <SplitSummary split={split} />

      {split.WARRANTY.line_count > 0 && (
        <ClaimFromRo data={data} locked={locked} busy={busy === 'claim'} onCreate={(b) => run('claim', { op: 'claim', ...b }, 'Drafted the warranty claim from the warranty lines')} />
      )}
    </>
  );
}

/** Customer / warranty / internal / policy by labor, parts, sublet and misc. */
export function SplitSummary({ split }: { split: PaySplit }) {
  const money = useSellText();
  const used = RO_PAY_TYPES.filter((t) => split[t].line_count > 0);
  if (!used.length) return null;
  const sum = (k: keyof PaySplit['CUSTOMER']) => used.reduce((s, t) => s + split[t][k], 0);
  return (
    <PanelSection title="Who pays">
      <table className="dl-tbl" aria-label="Pay-type split">
        <thead><tr><th>Pay type</th><th className="n">Labor</th><th className="n">Parts</th><th className="n">Sublet</th><th className="n">Misc</th><th className="n">Total</th></tr></thead>
        <tbody>
          {used.map((t) => (
            <tr key={t}>
              <td><span className="l1">{PAY_TYPE_WORDS[t]}</span><span className="l2">{split[t].flag_hours ? `${split[t].flag_hours} flag hours · ` : ''}{PAY_TYPE_HELP[t]}</span></td>
              <td className="n">{money(split[t].labor_cents)}</td>
              <td className="n">{money(split[t].parts_cents)}</td>
              <td className="n">{money(split[t].sublet_cents)}</td>
              <td className="n">{money(split[t].misc_cents)}</td>
              <td className="n b">{money(split[t].total_cents)}</td>
            </tr>
          ))}
        </tbody>
        {used.length > 1 && <tfoot><tr><td>All</td><td className="n">{money(sum('labor_cents'))}</td><td className="n">{money(sum('parts_cents'))}</td><td className="n">{money(sum('sublet_cents'))}</td><td className="n">{money(sum('misc_cents'))}</td><td className="n">{money(sum('total_cents'))}</td></tr></tfoot>}
      </table>
      <p className="t-cap" style={{ marginTop: 8 }}>Merit Books gets this split when the repair order closes: customer pay is invoiced, warranty becomes a claim receivable, internal work on a stock unit becomes unit cost.</p>
    </PanelSection>
  );
}

function AddRoLine({ companyId, busy, onAdd }: { companyId: string; busy: boolean; onAdd: (b: Record<string, unknown>) => Promise<{ data: unknown }> }) {
  const seesCost = useMoneyVis().cost;
  const money = useSellText();
  const [kind, setKind] = useState<RoLineKind>('LABOR');
  const [pay, setPay] = useState<RoPayType>('CUSTOMER');
  const [op, setOp] = useState('');
  const [desc, setDesc] = useState('');
  const [hours, setHours] = useState('');
  const [qty, setQty] = useState('1');
  const [price, setPrice] = useState<number | null>(null);
  const [cost, setCost] = useState<number | null>(null);
  const [pn, setPn] = useState('');
  const [part, setPart] = useState<{ id: string; label: string; price: number | null; note: string | null } | null>(null);
  const [vendor, setVendor] = useState<LookupItem | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const findPart = async () => {
    setErr(null);
    if (!pn.trim()) return;
    const r = await api.get<CounterSearch>('/api/dealer/parts', { companyId, pn: pn.trim() });
    const ms = r.data?.matches ?? [];
    const st = counterLookup(pn, ms);
    if (st.kind === 'found' || st.kind === 'superseded') {
      const m = ms.find((x) => x.resolved.id === st.part.id)!;
      setPart({ id: m.resolved.id, label: `${m.resolved.part_number} ${m.resolved.description}`, price: m.part.price_cents ?? m.part.list_price_cents, note: st.kind === 'superseded' ? st.message : null });
    } else if (st.kind === 'choose') {
      setErr(st.message);
    } else if (st.kind !== 'empty') {
      setErr(st.message);
      setPart(null);
    }
  };

  const reset = () => { setOp(''); setDesc(''); setHours(''); setQty('1'); setPrice(null); setCost(null); setPn(''); setPart(null); setVendor(null); };
  const submit = async () => {
    setErr(null);
    const q = parseNum(qty);
    const h = parseNum(hours);
    if (kind === 'LABOR' && (h == null || h <= 0)) return setErr('Give the flag hours.');
    if (kind === 'LABOR' && price == null) return setErr('Give the labor rate.');
    if (kind === 'PART' && !part) return setErr('Find the part by number first.');
    if (kind !== 'LABOR' && (q == null || q <= 0)) return setErr('Quantity must be more than 0.');
    if ((kind === 'SUBLET' || kind === 'MISC') && !desc.trim()) return setErr('Describe the line.');
    if ((kind === 'SUBLET' || kind === 'MISC') && price == null) return setErr('Give the price.');
    const r = await onAdd({
      kind, payType: pay, description: kind === 'SUBLET' && vendor ? `${desc.trim()} (${vendor.label})` : desc.trim() || null, laborOp: kind === 'LABOR' ? op.trim() || null : null,
      flagHours: kind === 'LABOR' ? h : null, qty: kind === 'LABOR' ? h : q, unitPriceCents: price, unitCostCents: kind === 'SUBLET' ? cost : null, partId: kind === 'PART' ? part?.id : null,
    });
    if (r.data) reset();
  };

  return (
    <form className="mp-form" style={{ marginTop: 16, borderTop: '1px solid var(--line)', paddingTop: 12 }} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <Seg<RoLineKind> aria-label="Line type" value={kind} onChange={(k) => { setKind(k); setErr(null); }} items={RO_EDITOR_KINDS.map((k) => ({ value: k, label: RO_KIND_WORDS[k] }))} />
        <Seg<RoPayType> aria-label="Who pays" value={pay} onChange={setPay} items={RO_PAY_TYPES.map((t) => ({ value: t, label: PAY_TYPE_WORDS[t] }))} />
      </div>
      {kind === 'LABOR' && (
        <>
          <div className="mp-form-2">
            <Field label="Labor op"><Input value={op} onChange={(e) => setOp(e.target.value)} placeholder="Manufacturer op code" maxLength={40} /></Field>
            <Field label="Flag hours"><Input inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="1.5" /></Field>
          </div>
          <div className="mp-form-2">
            <Field label="Description"><Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Replace loader hose, left lift cylinder" maxLength={300} /></Field>
            <Field label={pay === 'WARRANTY' ? 'Warranty labor rate' : 'Labor rate'}><MoneyInput valueCents={price} onChangeCents={setPrice} placeholder="0.00" /></Field>
          </div>
        </>
      )}
      {kind === 'PART' && (
        <>
          <div className="mp-form-2">
            <Field label="Part number" help={part?.note ?? (part ? part.label : 'Enter looks it up; a superseded number becomes its replacement')}>
              <Input value={pn} onChange={(e) => { setPn(e.target.value); setPart(null); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void findPart(); } }} onBlur={() => { if (pn.trim() && !part) void findPart(); }} autoCapitalize="characters" maxLength={40} />
            </Field>
            <Field label="Qty"><Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
          </div>
          <Field label="Price each (blank uses the part’s counter price)"><MoneyInput valueCents={price} onChangeCents={setPrice} placeholder={part?.price != null ? money(part.price) : '0.00'} /></Field>
        </>
      )}
      {kind === 'SUBLET' && (
        <>
          <div className="mp-form-2">
            <Field label="Work"><Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Machine the flywheel" maxLength={240} /></Field>
            <Field label="Sublet vendor"><Lookup kind="vendors" value={vendor ? { id: vendor.id, label: vendor.label } : null} onChange={setVendor} placeholder="Optional" /></Field>
          </div>
          <div className="mp-form-2">
            {seesCost && <Field label="Their cost"><MoneyInput valueCents={cost} onChangeCents={setCost} placeholder="0.00" /></Field>}
            <Field label="Price to the customer"><MoneyInput valueCents={price} onChangeCents={setPrice} placeholder="0.00" /></Field>
          </div>
        </>
      )}
      {kind === 'MISC' && (
        <div className="mp-form-2">
          <Field label="Description"><Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Shop supplies" maxLength={300} /></Field>
          <div className="mp-form-2">
            <Field label="Qty"><Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
            <Field label="Price"><MoneyInput valueCents={price} onChangeCents={setPrice} placeholder="0.00" /></Field>
          </div>
        </div>
      )}
      {err && <span className="field-error" role="alert">{err}</span>}
      <div><Button type="submit" icon="plus" disabled={busy}>Add {RO_KIND_WORDS[kind].toLowerCase()} · {PAY_TYPE_WORDS[pay].toLowerCase()}</Button></div>
    </form>
  );
}

function ClaimFromRo({ data, locked, busy, onCreate }: { data: RoData; locked: boolean; busy: boolean; onCreate: (b: Record<string, unknown>) => Promise<unknown> }) {
  const money = useSellText();
  const [payer, setPayer] = useState<LookupItem | null>(null);
  const [deadline, setDeadline] = useState('');
  const [failure, setFailure] = useState('');
  const [claimNo, setClaimNo] = useState('');
  const drafts = data.claims.filter((c) => c.status === 'DRAFT');
  const effPayer = payer?.id ?? data.order.payer_customer_id;
  return (
    <PanelSection title="Warranty claim from this RO">
      {drafts.length > 0 && <p className="t-cap" style={{ marginBottom: 8 }}>{count(drafts.length)} draft claim{drafts.length === 1 ? '' : 's'} already on this RO ({drafts.map((c) => money(Number(c.claimed_cents))).join(', ')}). Submit it in Warranty claims below, or draft another after changing the lines.</p>}
      {locked ? <p className="t-cap">The repair order is locked.</p> : (
        <form className="mp-form" onSubmit={(e) => { e.preventDefault(); void onCreate({ payerCustomerId: effPayer ?? null, filingDeadline: deadline || null, failureCode: failure.trim() || null, claimNumber: claimNo.trim() || null }); }}>
          {!data.order.payer_customer_id && <Field label="Manufacturer (billed in Merit Books)"><Lookup kind="customers" value={payer ? { id: payer.id, label: payer.label } : null} onChange={setPayer} placeholder="Search customers" /></Field>}
          {data.order.payer_customer_id && <p className="t-cap">Billed to {data.payerName ?? 'the manufacturer on the RO'}.</p>}
          <div className="mp-form-2">
            <Field label="File by"><Input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} /></Field>
            <Field label="Failure code"><Input value={failure} onChange={(e) => setFailure(e.target.value)} maxLength={60} /></Field>
          </div>
          <Field label="Claim number" help="Blank uses the job’s OEM claim number when it has one"><Input value={claimNo} onChange={(e) => setClaimNo(e.target.value)} maxLength={60} /></Field>
          <div><Button type="submit" variant="primary" disabled={busy || !effPayer}>Create warranty claim from RO</Button></div>
          <p className="t-cap">Claims the RO’s warranty lines at their amounts: labor, parts and other, with the flag hours and labor op.</p>
        </form>
      )}
    </PanelSection>
  );
}
