'use client';

import { useMemo, useState } from 'react';
import { AppLink, Button, Check, Field, InlineNotice, Input, KV, MoneyInput, Select, Tag, WidgetState, money, pct, shortDate } from '@meritbooks/merit-ui';
import type { LotQuote, OptionRow, PlanRow, PurchaseAgreementRow } from '@/lib/residential/types';
import { cutoffState, type CutoffStage } from '@/lib/residential/pricing';
import { useMoneyVis, useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { useOps } from '@/components/ops/common/useOps';

export interface LotDeskProps {
  lot: { id: string; lot_number: string; block: string | null; status: string; plan_id: string | null; elevation_id: string | null; job_id: string | null; premium_cents: number; is_spec: boolean; current_stage: string | null };
  houseStage: CutoffStage;
  agreement: PurchaseAgreementRow | null;
  paOptions: Array<{ option_id: string; price_cents: number; status: string }>;
  addenda: Array<{ id: string; seq: number; change_cents: number; late_fee_cents: number; status: string }>;
  packageItems: Array<{ id: string; release_stage: string; scope: string; amount_cents: number; status: string; vendor_id: string | null; commitment_id: string | null }>;
  elevations: Array<{ id: string; plan_id: string; code: string; name: string; premium_cents: number }>;
  plans: PlanRow[];
  options: OptionRow[];
  customers: Array<{ id: string; name: string }>;
  vendors: Record<string, string>;
  today: string;
  can: { sell: boolean; release: boolean };
}

const RELEASE_STAGES = ['START', 'FOUNDATION', 'FRAME', 'MECHANICAL', 'DRYWALL', 'TRIM', 'FINAL'] as const;
const words = (s: string) => s.toLowerCase().replace(/_/g, ' ');


export function LotDesk(p: LotDeskProps) {
  const mv = useMoneyVis();
  const { readOnly } = useShell();
  const { act, busy, error } = useOps();
  const url = `/api/residential/lots/${p.lot.id}`;
  const a = p.agreement;
  const [planId, setPlanId] = useState(a?.plan_id ?? p.lot.plan_id ?? '');
  const [elevationId, setElevationId] = useState(a?.elevation_id ?? p.lot.elevation_id ?? '');
  const [picked, setPicked] = useState<Set<string>>(() => new Set(p.paOptions.filter((o) => o.status !== 'REMOVED' && o.status !== 'VOID').map((o) => o.option_id)));
  const [quote, setQuote] = useState<LotQuote | null>(null);
  const [customerId, setCustomerId] = useState(a?.customer_id ?? '');
  const [earnest, setEarnest] = useState<number | null>(a?.earnest_money_cents ?? null);
  const [signer, setSigner] = useState('');
  const [startOn, setStartOn] = useState(p.today);
  const elevations = p.elevations.filter((e) => e.plan_id === planId);
  const forPlan = useMemo(() => p.options.filter((o) => o.is_active), [p.options]);
  const stage = p.lot.current_stage;
  const cut = (o: OptionRow) => cutoffState(p.houseStage, o.cutoff_stage, o.is_structural);
  const signed = a?.status === 'SIGNED';
  const sellable = p.can.sell && !readOnly;
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const runQuote = () => planId && void act<LotQuote>('quote', 'post', url, { op: 'quote', planId, elevationId: elevationId || null, optionIds: [...picked] }, () => null).then((q) => { if (q) setQuote(q); });
  const original = new Set(p.paOptions.filter((o) => o.status !== 'REMOVED' && o.status !== 'VOID').map((o) => o.option_id));
  const add = [...picked].filter((x) => !original.has(x));
  const remove = [...original].filter((x) => !picked.has(x));
  const stagesReleased = new Set(p.packageItems.filter((i) => i.status === 'RELEASED').map((i) => i.release_stage));

  return (
    <div className="stack">
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Tag>{words(p.lot.status)}</Tag>
        {p.lot.is_spec && <Tag>Spec home</Tag>}
        {stage && <Tag tone="ai">Stage: {words(stage)}</Tag>}
        {p.lot.job_id && <AppLink href={`/homes/${p.lot.job_id}`}>Open the home workspace</AppLink>}
      </div>
      <Failure text={error} />

      <Section title={signed ? 'Design center' : 'Plan, elevation and options'} meta={signed ? 'Changes after signing become an addendum; structural options lock at their cutoff stage' : 'Quote first; options without a price for this community are flagged'}>
        <div className="mp-form">
          <div className="mp-form-2">
            <Field label="Plan">
              <Select value={planId} onChange={(e) => { setPlanId(e.target.value); setElevationId(''); setQuote(null); }} disabled={signed}>
                <option value="">Pick a plan</option>{p.plans.filter((x) => x.is_active).map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}{x.sqft ? ` · ${x.sqft} sq ft` : ''}</option>)}
              </Select>
            </Field>
            <Field label="Elevation">
              <Select value={elevationId} onChange={(e) => { setElevationId(e.target.value); setQuote(null); }} disabled={signed || !elevations.length}>
                <option value="">{elevations.length ? 'Standard' : 'No elevations'}</option>{elevations.map((e) => <option key={e.id} value={e.id}>{e.code} · {e.name}{mv.contract && e.premium_cents ? ` · +${money(e.premium_cents)}` : ''}</option>)}
              </Select>
            </Field>
          </div>
          {forPlan.length === 0 ? <p className="t-cap">No options in the price book.</p> : (
            <div className="mp-table">
              <table className="tbl tbl-q tbl-q--compact">
                <thead><tr><th>Option</th><th>Cutoff</th><th aria-label="Chosen" /></tr></thead>
                <tbody>
                  {forPlan.map((o) => {
                    const c = signed ? cut(o) : 'open';
                    const locked = c === 'closed';
                    return (
                      <tr key={o.id}>
                        <td><span className="l1">{o.code} · {o.name}</span><span className="l2">{[o.category, o.is_structural ? 'Structural' : null].filter(Boolean).join(' · ')}</span></td>
                        <td><span className={c === 'closed' ? 'neg' : undefined}>{words(o.cutoff_stage)}{c === 'closed' ? ' — passed, structural' : ''}</span>{c === 'late_fee' && <span className="l2">Past cutoff: late-change fee applies</span>}</td>
                        <td><Check checked={picked.has(o.id)} disabled={locked || !sellable} onChange={() => toggle(o.id)} label={picked.has(o.id) ? 'In' : 'Add'} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {sellable && (
            <div className="btn-row">
              {!signed && <Button disabled={!planId || busy === 'quote'} onClick={runQuote}>Quote</Button>}
              {signed && (add.length > 0 || remove.length > 0) && (
                <Button variant="primary" disabled={busy === 'change'} onClick={() => void act<{ addendum_id?: string; change_cents?: number }>('change', 'post', url, { op: 'options', agreementId: a!.id, add, remove }, (d) => (d.addendum_id ? `Addendum drafted${d.change_cents != null ? `: ${money(Number(d.change_cents))}` : ''}` : 'Nothing changed'))}>
                  Draft addendum ({add.length} in, {remove.length} out)
                </Button>
              )}
            </div>
          )}
          {quote && mv.contract && (
            <div className="stack">
              <KV items={[
                { term: 'Base', value: quote.base_price_cents == null ? 'No price for this community' : money(quote.base_price_cents) },
                { term: 'Elevation', value: money(quote.elevation_cents) }, { term: 'Lot premium', value: money(quote.lot_premium_cents) },
                { term: 'Options', value: money(quote.options_cents) }, { term: 'Total', value: <span className="b">{money(quote.total_cents)}</span> },
                ...(mv.cost && quote.margin_pct != null ? [{ term: 'Margin', value: <span className={quote.below_target ? 'neg b' : undefined}>{pct(quote.margin_pct)}</span> }] : []),
              ]} />
              {quote.issues.length > 0 && <InlineNotice tone="warn" title="Check before selling"><ul style={{ margin: '4px 0 0 18px' }}>{quote.issues.map((i) => <li key={i}>{i}</li>)}</ul></InlineNotice>}
            </div>
          )}
        </div>
      </Section>

      <Section title="Purchase agreement" meta={a ? `${a.number ?? 'Draft'} · ${words(a.status)}${a.signed_at ? ` ${shortDate(a.signed_at.slice(0, 10), p.today)}` : ''}` : 'Not written yet'}>
        {!a ? (
          sellable ? (
            <form className="mp-form" onSubmit={(e) => {
              e.preventDefault();
              if (!customerId || !planId) return;
              void act('pa', 'post', url, { op: 'agreement', customerId, planId, elevationId: elevationId || null, optionIds: [...picked], earnestMoneyCents: earnest ?? 0 }, 'Purchase agreement drafted');
            }}>
              <div className="mp-form-2">
                <Field label="Buyer"><Select value={customerId} onChange={(e) => setCustomerId(e.target.value)}><option value="">Pick the buyer</option>{p.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
                <Field label="Earnest money"><MoneyInput valueCents={earnest} onChangeCents={setEarnest} placeholder="0.00" /></Field>
              </div>
              <div className="btn-row"><span className="sp" /><Button type="submit" variant="primary" disabled={!customerId || !planId || busy === 'pa'}>Draft the agreement</Button></div>
            </form>
          ) : <p className="t-cap">No agreement on this lot.</p>
        ) : (
          <div className="stack">
            {mv.contract && <KV items={[
              { term: 'Base', value: money(a.base_price_cents) }, { term: 'Elevation', value: money(a.elevation_cents) }, { term: 'Lot premium', value: money(a.lot_premium_cents) },
              { term: 'Options', value: money(a.options_cents) }, ...(a.incentives_cents ? [{ term: 'Incentives', value: money(-a.incentives_cents) }] : []),
              { term: 'Total', value: <span className="b">{money(a.total_cents)}</span> }, { term: 'Earnest money', value: `${money(a.earnest_money_cents)}${a.earnest_in_escrow ? ' (escrow)' : ''}` },
            ]} />}
            {a.contingencies.length > 0 && <p className="t-cap">Contingencies: {a.contingencies.map((c) => `${words(c.kind)} ${c.status.toLowerCase()}${c.due_on ? ` by ${shortDate(c.due_on, p.today)}` : ''}`).join(' · ')}</p>}
            {a.status === 'DRAFT' && sellable && (
              <div className="row" style={{ gap: 6 }}>
                <Input aria-label="Buyer name" value={signer} onChange={(e) => setSigner(e.target.value)} placeholder="Buyer who signed" maxLength={200} />
                <Button variant="primary" disabled={!signer.trim() || busy === 'sign'} onClick={() => void act('sign', 'post', url, { op: 'sign', agreementId: a.id, signerName: signer.trim() }, 'Signed — the job, contract and earnest-money request are created')}>Signed</Button>
              </div>
            )}
            {p.addenda.length > 0 && (
              <div className="mp-table">
                <table className="tbl tbl-q tbl-q--compact">
                  <thead><tr><th>Addendum</th><th className="n">Change</th><th className="n">Late fee</th><th>Status</th><th aria-label="Sign" /></tr></thead>
                  <tbody>
                    {p.addenda.map((x) => (
                      <tr key={x.id}>
                        <td>#{x.seq}</td><td className="n">{mv.contract ? money(x.change_cents) : '—'}</td><td className="n">{mv.contract ? money(x.late_fee_cents) : '—'}</td><td>{words(x.status)}</td>
                        <td className="n">{x.status === 'DRAFT' && sellable && <Button variant="quiet" disabled={!signer.trim() || busy === x.id} title={signer.trim() ? undefined : 'Type the buyer’s name above'} onClick={() => void act(x.id, 'post', url, { op: 'sign_addendum', addendumId: x.id, signerName: signer.trim() }, 'Addendum signed')}>Signed</Button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {signed && a.status === 'SIGNED' && sellable && p.addenda.some((x) => x.status === 'DRAFT') && (
              <Input aria-label="Buyer name for the addendum" value={signer} onChange={(e) => setSigner(e.target.value)} placeholder="Buyer who signed the addendum" maxLength={200} />
            )}
          </div>
        )}
      </Section>

      <Section title="Start package" meta="Price agreements become purchase orders, released by stage"
        actions={p.can.release && !readOnly ? (
          !p.lot.job_id || p.packageItems.length === 0 ? (
            <div className="row" style={{ gap: 6 }}>
              <Input type="date" aria-label="Start on" value={startOn} onChange={(e) => setStartOn(e.target.value)} style={{ width: 150 }} />
              <Button variant="primary" disabled={!signed && !p.lot.is_spec || busy === 'release'} title={!signed && !p.lot.is_spec ? 'Sign the purchase agreement (or mark it a spec) first' : undefined}
                onClick={() => void act<{ released: unknown[]; options_without_price_agreement: unknown[] }>('release', 'post', url, { op: 'release', startOn }, (d) => `Released: schedule built, ${Array.isArray(d.released) ? d.released.length : 0} start POs out${Array.isArray(d.options_without_price_agreement) && d.options_without_price_agreement.length ? `, ${d.options_without_price_agreement.length} options without a price agreement` : ''}`)}>Release the lot</Button>
            </div>
          ) : undefined
        ) : undefined}>
        {p.packageItems.length === 0 ? <WidgetState state={{ kind: 'empty', title: 'Nothing released yet', body: 'Releasing builds the schedule from the plan and writes one PO per trade price agreement, released stage by stage.' }} /> : (
          <div className="stack">
            <div className="mp-table">
              <table className="tbl tbl-q tbl-q--compact">
                <thead><tr><th>Stage</th><th>Scope</th><th>Trade</th>{mv.cost && <th className="n">Amount</th>}<th>Status</th></tr></thead>
                <tbody>
                  {p.packageItems.map((i) => (
                    <tr key={i.id}>
                      <td>{words(i.release_stage)}</td><td>{i.commitment_id ? <AppLink href={`/commitments?commitment=${i.commitment_id}`}>{i.scope}</AppLink> : i.scope}</td>
                      <td>{i.vendor_id ? p.vendors[i.vendor_id] ?? 'Trade' : '—'}</td>{mv.cost && <td className="n">{money(i.amount_cents)}</td>}<td>{words(i.status)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {p.can.release && !readOnly && (
              <div className="btn-row">
                {RELEASE_STAGES.filter((s) => s !== 'START' && !stagesReleased.has(s) && p.packageItems.some((i) => i.release_stage === s)).map((s) => (
                  <Button key={s} disabled={busy === s} onClick={() => void act<{ released: unknown[] }>(s, 'post', url, { op: 'release_stage', stage: s }, (d) => `${d.released.length} ${words(s)} POs released`)}>Release {words(s)}</Button>
                ))}
              </div>
            )}
          </div>
        )}
      </Section>
    </div>
  );
}
