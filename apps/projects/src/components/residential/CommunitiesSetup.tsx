'use client';

import { useState, type FormEvent } from 'react';
import { Button, Check, Field, Input, MoneyInput, Select, Tabs, WidgetState, count, money, pct } from '@meritbooks/merit-ui';
import type { BuilderBundle } from '@/lib/residential/queries';
import { useMoneyVis, useShell } from '@/components/shell/ShellContext';
import { Failure, PctInput, PickCompanyNote, Section } from '@/components/ops/common/bits';
import { useOps } from '@/components/ops/common/useOps';

type Tab = 'communities' | 'plans' | 'options' | 'agreements';
const STAGES = ['PRE_START', 'PRE_FRAME', 'PRE_DRYWALL', 'PRE_TRIM', 'ANYTIME'] as const;
const RELEASES = ['START', 'FOUNDATION', 'FRAME', 'MECHANICAL', 'DRYWALL', 'TRIM', 'FINAL'] as const;
const words = (s: string) => s.toLowerCase().replace(/_/g, ' ');
const URL = '/api/residential/builder';

export function CommunitiesSetup({ bundle: b, companyId, vendors, canEdit, canAgreements }: { bundle: BuilderBundle; companyId: string | null; vendors: Array<{ id: string; name: string }>; canEdit: boolean; canAgreements: boolean }) {
  const { readOnly } = useShell();
  const [tab, setTab] = useState<Tab>('communities');
  const edit = canEdit && !readOnly && !!companyId;
  return (
    <div className="stack">
      {!companyId && <PickCompanyNote what="Communities, plans and options" />}
      <Tabs<Tab> aria-label="Builder setup" value={tab} onChange={setTab} items={[
        { value: 'communities', label: 'Communities and lots', count: count(b.communities.length) },
        { value: 'plans', label: 'Plans', count: count(b.plans.length) },
        { value: 'options', label: 'Option price book', count: count(b.options.length) },
        { value: 'agreements', label: 'Trade price agreements' },
      ]} />
      {tab === 'communities' && <Communities b={b} companyId={companyId} edit={edit} />}
      {tab === 'plans' && <Plans b={b} companyId={companyId} edit={edit} />}
      {tab === 'options' && <Options b={b} companyId={companyId} edit={edit} />}
      {tab === 'agreements' && <Agreements b={b} companyId={companyId} vendors={vendors} edit={edit && canAgreements} />}
    </div>
  );
}

function useSubmit() {
  const { act, busy, error } = useOps();
  const submit = (key: string, body: Record<string, unknown>, ok: string, reset?: () => void) => (e: FormEvent) => {
    e.preventDefault();
    void act(key, 'post', URL, body, ok).then((r) => { if (r && reset) reset(); });
  };
  return { submit, busy, error };
}

function Communities({ b, companyId, edit }: { b: BuilderBundle; companyId: string | null; edit: boolean }) {
  const { submit, busy, error } = useSubmit();
  const mv = useMoneyVis();
  const [c, setC] = useState({ code: '', name: '', city: '', state: '' });
  const [lot, setLot] = useState({ communityId: '', lotNumber: '', block: '', premium: null as number | null, isSpec: false, planId: '', list: null as number | null });
  return (
    <div className="stack">
      <Failure text={error} />
      <Section title="Communities">
        {b.communities.length === 0 ? <WidgetState state={{ kind: 'empty', title: 'No communities', body: 'Add the first community, then its lots.' }} /> : (
          <div className="mp-table">
            <table className="tbl tbl-q tbl-q--compact">
              <thead><tr><th>Community</th><th>Where</th><th className="n">Lots</th><th className="n">Under construction</th><th>Status</th></tr></thead>
              <tbody>
                {b.communities.map((x) => {
                  const lots = b.lots.filter((l) => l.community_id === x.id);
                  return <tr key={x.id}><td><span className="l1">{x.name}</span><span className="l2">{x.code}</span></td><td>{[x.city, x.state].filter(Boolean).join(', ') || '—'}</td><td className="n">{count(lots.length)}</td><td className="n">{count(lots.filter((l) => l.status === 'STARTED').length)}</td><td>{words(x.status)}</td></tr>;
                })}
              </tbody>
            </table>
          </div>
        )}
        {edit && (
          <form className="mp-form-2" style={{ marginTop: 12, gridTemplateColumns: '1fr 2fr 1fr 0.5fr auto', alignItems: 'end' }}
            onSubmit={submit('community', { op: 'community', companyId, code: c.code.trim(), name: c.name.trim(), city: c.city.trim() || null, state: c.state.trim().toUpperCase() || null }, `Added ${c.name.trim()}`, () => setC({ code: '', name: '', city: '', state: '' }))}>
            <Field label="Code"><Input value={c.code} onChange={(e) => setC({ ...c, code: e.target.value })} maxLength={24} required /></Field>
            <Field label="Name"><Input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} maxLength={120} required /></Field>
            <Field label="City"><Input value={c.city} onChange={(e) => setC({ ...c, city: e.target.value })} maxLength={80} /></Field>
            <Field label="State"><Input value={c.state} onChange={(e) => setC({ ...c, state: e.target.value })} maxLength={2} /></Field>
            <Button type="submit" disabled={busy === 'community'}>Add</Button>
          </form>
        )}
      </Section>
      {edit && b.communities.length > 0 && (
        <Section title="Add a lot">
          <form className="mp-form" onSubmit={submit('lot', {
            op: 'lot', companyId, communityId: lot.communityId, lotNumber: lot.lotNumber.trim(), block: lot.block.trim() || null, premiumCents: lot.premium ?? 0,
            isSpec: lot.isSpec, planId: lot.planId || null, listPriceCents: lot.isSpec ? lot.list : null,
          }, `Lot ${lot.lotNumber.trim()} added`, () => setLot({ ...lot, lotNumber: '', premium: null, list: null }))}>
            <div className="mp-form-2">
              <Field label="Community"><Select value={lot.communityId} onChange={(e) => setLot({ ...lot, communityId: e.target.value })} required><option value="">Pick one</option>{b.communities.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
              <Field label="Lot number"><Input value={lot.lotNumber} onChange={(e) => setLot({ ...lot, lotNumber: e.target.value })} maxLength={24} required /></Field>
              <Field label="Block"><Input value={lot.block} onChange={(e) => setLot({ ...lot, block: e.target.value })} maxLength={24} /></Field>
              {mv.contract && <Field label="Lot premium"><MoneyInput valueCents={lot.premium} onChangeCents={(v) => setLot({ ...lot, premium: v })} placeholder="0.00" /></Field>}
            </div>
            <Check checked={lot.isSpec} onChange={(e) => setLot({ ...lot, isSpec: e.target.checked })} label="Spec home (we build before a buyer)" />
            {lot.isSpec && (
              <div className="mp-form-2">
                <Field label="Plan"><Select value={lot.planId} onChange={(e) => setLot({ ...lot, planId: e.target.value })}><option value="">—</option>{b.plans.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}</Select></Field>
                {mv.contract && <Field label="List price"><MoneyInput valueCents={lot.list} onChangeCents={(v) => setLot({ ...lot, list: v })} /></Field>}
              </div>
            )}
            <div className="btn-row"><span className="sp" /><Button type="submit" variant="primary" disabled={!lot.communityId || !lot.lotNumber.trim() || busy === 'lot'}>Add lot</Button></div>
          </form>
        </Section>
      )}
    </div>
  );
}

function Plans({ b, companyId, edit }: { b: BuilderBundle; companyId: string | null; edit: boolean }) {
  const { submit, busy, error } = useSubmit();
  const mv = useMoneyVis();
  const [f, setF] = useState({ code: '', name: '', beds: '', baths: '', sqft: '', cost: null as number | null, margin: null as number | null, cycle: '', template: '' });
  const [price, setPrice] = useState({ planId: '', communityId: '', cents: null as number | null });
  const [elev, setElev] = useState({ planId: '', code: '', name: '', premium: null as number | null });
  const n = (s: string) => (s.trim() && Number.isFinite(Number(s)) ? Number(s) : null);
  return (
    <div className="stack">
      <Failure text={error} />
      <Section title="Plans">
        {b.plans.length === 0 ? <WidgetState state={{ kind: 'empty', title: 'No plans', body: 'Add a plan with its base cost, target margin, standard cycle and schedule template; then price it per community.' }} /> : (
          <div className="mp-table">
            <table className="tbl tbl-q tbl-q--compact">
              <thead><tr><th>Plan</th><th>Size</th>{mv.cost && <th className="n">Base cost</th>}{mv.cost && <th className="n">Target margin</th>}<th className="n">Cycle</th></tr></thead>
              <tbody>
                {b.plans.map((x) => (
                  <tr key={x.id}><td><span className="l1">{x.code} · {x.name}</span><span className="l2">{x.schedule_template_key ? `Schedule: ${x.schedule_template_key}` : 'No schedule template'}</span></td>
                    <td>{[x.beds != null ? `${x.beds} bd` : null, x.baths != null ? `${x.baths} ba` : null, x.sqft ? `${x.sqft} sq ft` : null].filter(Boolean).join(' · ') || '—'}</td>
                    {mv.cost && <td className="n">{x.base_cost_cents == null ? '—' : money(x.base_cost_cents)}</td>}
                    {mv.cost && <td className="n">{x.target_margin_pct == null ? '—' : pct(x.target_margin_pct)}</td>}
                    <td className="n">{x.standard_cycle_days ? `${x.standard_cycle_days} d` : '—'}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      {edit && (
        <Section title="Add a plan">
          <form className="mp-form" onSubmit={submit('plan', {
            op: 'plan', companyId, code: f.code.trim(), name: f.name.trim(), beds: n(f.beds), baths: n(f.baths), sqft: n(f.sqft), baseCostCents: f.cost, targetMarginPct: f.margin,
            standardCycleDays: n(f.cycle), scheduleTemplateKey: /^[a-z][a-z0-9_]{1,47}$/.test(f.template.trim()) ? f.template.trim() : null,
          }, `Added ${f.name.trim()}`, () => setF({ code: '', name: '', beds: '', baths: '', sqft: '', cost: null, margin: null, cycle: '', template: '' }))}>
            <div className="mp-form-2">
              <Field label="Code"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} maxLength={24} required /></Field>
              <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={120} required /></Field>
              <Field label="Beds"><Input inputMode="decimal" value={f.beds} onChange={(e) => setF({ ...f, beds: e.target.value })} /></Field>
              <Field label="Baths"><Input inputMode="decimal" value={f.baths} onChange={(e) => setF({ ...f, baths: e.target.value })} /></Field>
              <Field label="Square feet"><Input inputMode="numeric" value={f.sqft} onChange={(e) => setF({ ...f, sqft: e.target.value })} /></Field>
              <Field label="Standard cycle (days)"><Input inputMode="numeric" value={f.cycle} onChange={(e) => setF({ ...f, cycle: e.target.value })} /></Field>
              {mv.cost && <Field label="Base cost"><MoneyInput valueCents={f.cost} onChangeCents={(v) => setF({ ...f, cost: v })} /></Field>}
              {mv.cost && <Field label="Target margin"><PctInput value={f.margin} onChange={(v) => setF({ ...f, margin: v })} /></Field>}
              <Field label="Schedule template key" help="e.g. production_home"><Input value={f.template} onChange={(e) => setF({ ...f, template: e.target.value.toLowerCase() })} maxLength={48} /></Field>
            </div>
            <div className="btn-row"><span className="sp" /><Button type="submit" variant="primary" disabled={busy === 'plan'}>Add plan</Button></div>
          </form>
        </Section>
      )}
      {edit && b.plans.length > 0 && mv.contract && (
        <Section title="Price a plan" meta="Per community (or every community); the newest effective price wins">
          <form className="mp-form-2" style={{ gridTemplateColumns: '1fr 1fr 1fr auto', alignItems: 'end' }} onSubmit={submit('price', { op: 'plan_price', planId: price.planId, communityId: price.communityId || null, basePriceCents: price.cents }, 'Price saved')}>
            <Field label="Plan"><Select value={price.planId} onChange={(e) => setPrice({ ...price, planId: e.target.value })} required><option value="">Pick</option>{b.plans.map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}</Select></Field>
            <Field label="Community"><Select value={price.communityId} onChange={(e) => setPrice({ ...price, communityId: e.target.value })}><option value="">Every community</option>{b.communities.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
            <Field label="Base price"><MoneyInput valueCents={price.cents} onChangeCents={(v) => setPrice({ ...price, cents: v })} /></Field>
            <Button type="submit" disabled={!price.planId || !price.cents || busy === 'price'}>Save</Button>
          </form>
          <form className="mp-form-2" style={{ gridTemplateColumns: '1fr 0.6fr 1fr 1fr auto', alignItems: 'end', marginTop: 12 }} onSubmit={submit('elev', { op: 'elevation', planId: elev.planId, code: elev.code.trim(), name: elev.name.trim(), premiumCents: elev.premium ?? 0 }, 'Elevation added', () => setElev({ ...elev, code: '', name: '', premium: null }))}>
            <Field label="Elevation for"><Select value={elev.planId} onChange={(e) => setElev({ ...elev, planId: e.target.value })} required><option value="">Pick</option>{b.plans.map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}</Select></Field>
            <Field label="Code"><Input value={elev.code} onChange={(e) => setElev({ ...elev, code: e.target.value })} maxLength={12} required /></Field>
            <Field label="Name"><Input value={elev.name} onChange={(e) => setElev({ ...elev, name: e.target.value })} maxLength={80} required /></Field>
            <Field label="Premium"><MoneyInput valueCents={elev.premium} onChangeCents={(v) => setElev({ ...elev, premium: v })} placeholder="0.00" /></Field>
            <Button type="submit" disabled={!elev.planId || busy === 'elev'}>Add</Button>
          </form>
        </Section>
      )}
    </div>
  );
}

function Options({ b, companyId, edit }: { b: BuilderBundle; companyId: string | null; edit: boolean }) {
  const { submit, busy, error } = useSubmit();
  const mv = useMoneyVis();
  const [f, setF] = useState({ code: '', name: '', category: '', cutoff: 'PRE_DRYWALL' as (typeof STAGES)[number], structural: false, cost: null as number | null, price: null as number | null });
  return (
    <div className="stack">
      <Failure text={error} />
      <Section title="Option price book" meta="Structural options lock at their cutoff; others past cutoff carry the late-change fee">
        {b.options.length === 0 ? <WidgetState state={{ kind: 'empty', title: 'No options', body: 'Add options with their design-center cutoff stage and price.' }} /> : (
          <div className="mp-table">
            <table className="tbl tbl-q tbl-q--compact">
              <thead><tr><th>Option</th><th>Cutoff</th><th>Structural</th>{mv.cost && <th className="n">Cost</th>}</tr></thead>
              <tbody>{b.options.map((o) => <tr key={o.id}><td><span className="l1">{o.code} · {o.name}</span>{o.category && <span className="l2">{o.category}</span>}</td><td>{words(o.cutoff_stage)}</td><td>{o.is_structural ? 'Yes' : '—'}</td>{mv.cost && <td className="n">{o.cost_cents == null ? '—' : money(o.cost_cents)}</td>}</tr>)}</tbody>
            </table>
          </div>
        )}
      </Section>
      {edit && (
        <Section title="Add an option">
          <form className="mp-form" onSubmit={submit('option', { op: 'option', companyId, code: f.code.trim(), name: f.name.trim(), category: f.category.trim() || null, cutoffStage: f.cutoff, isStructural: f.structural, costCents: f.cost, priceCents: f.price }, `Added ${f.name.trim()}`, () => setF({ ...f, code: '', name: '', cost: null, price: null }))}>
            <div className="mp-form-2">
              <Field label="Code"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} maxLength={40} required /></Field>
              <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={200} required /></Field>
              <Field label="Category"><Input value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} maxLength={80} placeholder="Kitchen" /></Field>
              <Field label="Cutoff"><Select value={f.cutoff} onChange={(e) => setF({ ...f, cutoff: e.target.value as typeof f.cutoff })}>{STAGES.map((s) => <option key={s} value={s}>{words(s)}</option>)}</Select></Field>
              {mv.cost && <Field label="Cost"><MoneyInput valueCents={f.cost} onChangeCents={(v) => setF({ ...f, cost: v })} /></Field>}
              {mv.contract && <Field label="Price"><MoneyInput valueCents={f.price} onChangeCents={(v) => setF({ ...f, price: v })} /></Field>}
            </div>
            <Check checked={f.structural} onChange={(e) => setF({ ...f, structural: e.target.checked })} label="Structural (cannot change after its cutoff)" />
            <div className="btn-row"><span className="sp" /><Button type="submit" variant="primary" disabled={busy === 'option'}>Add option</Button></div>
          </form>
        </Section>
      )}
    </div>
  );
}

function Agreements({ b, companyId, vendors, edit }: { b: BuilderBundle; companyId: string | null; vendors: Array<{ id: string; name: string }>; edit: boolean }) {
  const { submit, busy, error } = useSubmit();
  const [f, setF] = useState({ vendorId: '', planId: '', optionId: '', communityId: '', scope: '', amount: null as number | null, stage: 'START' as (typeof RELEASES)[number] });
  if (!edit) return <p className="t-cap">Trade price agreements are set by people who manage commitments.</p>;
  return (
    <Section title="Trade price agreement" meta="One per trade × plan (or option): released as a PO at its stage when a lot starts">
      <Failure text={error} />
      <form className="mp-form" onSubmit={submit('pa', { op: 'price_agreement', companyId, vendorId: f.vendorId, planId: f.planId || null, optionId: f.optionId || null, communityId: f.communityId || null, scope: f.scope.trim(), amountCents: f.amount ?? 0, releaseStage: f.stage }, 'Price agreement saved', () => setF({ ...f, scope: '', amount: null }))}>
        <div className="mp-form-2">
          <Field label="Trade"><Select value={f.vendorId} onChange={(e) => setF({ ...f, vendorId: e.target.value })} required><option value="">Pick</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select></Field>
          <Field label="Releases at"><Select value={f.stage} onChange={(e) => setF({ ...f, stage: e.target.value as typeof f.stage })}>{RELEASES.map((s) => <option key={s} value={s}>{words(s)}</option>)}</Select></Field>
          <Field label="Plan"><Select value={f.planId} onChange={(e) => setF({ ...f, planId: e.target.value, optionId: '' })}><option value="">—</option>{b.plans.map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}</Select></Field>
          <Field label="…or an option"><Select value={f.optionId} onChange={(e) => setF({ ...f, optionId: e.target.value, planId: '' })}><option value="">—</option>{b.options.map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}</Select></Field>
          <Field label="Community"><Select value={f.communityId} onChange={(e) => setF({ ...f, communityId: e.target.value })}><option value="">Every community</option>{b.communities.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
          <Field label="Amount"><MoneyInput valueCents={f.amount} onChangeCents={(v) => setF({ ...f, amount: v })} /></Field>
        </div>
        <Field label="Scope"><Input value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })} maxLength={300} required placeholder="Framing labor, plan 2410" /></Field>
        <div className="btn-row"><span className="sp" /><Button type="submit" variant="primary" disabled={!companyId || !f.vendorId || (!f.planId && !f.optionId) || busy === 'pa'}>Save</Button></div>
      </form>
    </Section>
  );
}
