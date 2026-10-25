'use client';

import { useState } from 'react';
import { Button, Check, Field, Input, Select, money } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, PctInput, Section } from '@/components/ops/common/bits';
import { BoardState, centsFrom, useBoard, useDo } from '@/components/dealer/common/depth';
import { FEE_MODELS, FIRM_TYPES, type DesignAnswers, type DesignPlan, type FeeModel, type FirmType } from '@/lib/design/setup';

const FIRM: Record<FirmType, string> = { RESIDENTIAL_FULL_SERVICE: 'Residential, full service', E_DESIGN: 'E-design', COMMERCIAL_FFE: 'Commercial FF&E', DESIGN_BUILD: 'Design-build' };
const FEE: Record<FeeModel, string> = { HOURLY: 'Hourly', FLAT_BY_PHASE: 'Flat fee by phase', PCT_OF_BUDGET: 'Percent of budget', COST_PLUS: 'Cost plus on product',
  PROCUREMENT_FEE: 'Procurement fee', HYBRID: 'Hybrid' };

/** Interior design firm setup (ID-01): firm type, fee models, markup, deposits and retainer, receivers, tax → plan → apply. */
export function DesignSetup({ companyId }: { companyId: string }) {
  const { readOnly } = useShell();
  const url = '/api/design/ops';
  const b = useBoard<{ settings: Record<string, unknown> | null }>(`${url}?company=${companyId}&view=settings`);
  const { run, busy, error } = useDo(b.reload);
  const [a, setA] = useState<Omit<DesignAnswers, 'retainerCents' | 'taxStates'>>({ firmType: 'RESIDENTIAL_FULL_SERVICE', feeModels: ['HOURLY', 'COST_PLUS'], markupPct: 0.35, productDepositPct: 0.5,
    retainerEvergreen: false, showCostToClients: false, receivers: [{ name: '', address: '' }], replacing: null });
  const [retainer, setRetainer] = useState('');
  const [states, setStates] = useState('');
  const [plan, setPlan] = useState<DesignPlan | null>(null);
  const retainerCents = retainer.trim() ? centsFrom(retainer) : 0;
  const tax = states.split(/[\s,]+/).filter(Boolean);
  const taxBad = tax.some((s) => !/^[A-Za-z]{2}$/.test(s));
  const answers: DesignAnswers = { ...a, retainerCents: retainerCents ?? 0, taxStates: tax.map((s) => s.toUpperCase()), receivers: a.receivers.filter((r) => r.name.trim()) };
  const set = <K extends keyof typeof a>(k: K, v: (typeof a)[K]) => { setA({ ...a, [k]: v }); setPlan(null); };
  const state = <BoardState b={b} what="Setup" />;
  if (!b.data) return state;
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <Section title="About the firm" meta={b.data.settings ? 'Already set up — applying again updates it' : 'Not set up yet'}>
        <div className="stack">
          <Field label="What kind of firm?"><Select value={a.firmType} disabled={readOnly} onChange={(e) => set('firmType', e.target.value as FirmType)}>{FIRM_TYPES.map((f) => <option key={f} value={f}>{FIRM[f]}</option>)}</Select></Field>
          <Field label="How do you charge?" help="Pick every fee model you use.">
            <span className="btn-row">{FEE_MODELS.map((f) => <Check key={f} disabled={readOnly} checked={a.feeModels.includes(f)} label={FEE[f]} onChange={(e) => set('feeModels', e.target.checked ? [...a.feeModels, f] : a.feeModels.filter((x) => x !== f))} />)}</span>
          </Field>
          <div className="ops-toolbar">
            <Field label="Markup on trade cost"><PctInput value={a.markupPct} max={1000} aria-label="Markup" onChange={(v) => set('markupPct', v ?? 0)} /></Field>
            <Field label="Client deposit on product"><PctInput value={a.productDepositPct} aria-label="Product deposit" onChange={(v) => set('productDepositPct', v ?? 0)} /></Field>
            <Field label="Design retainer" error={retainer.trim() && retainerCents == null ? 'Dollars, like 2,500' : undefined}><Input value={retainer} disabled={readOnly} style={{ width: 110 }} onChange={(e) => { setRetainer(e.target.value); setPlan(null); }} /></Field>
            <Field label="Tax states" error={taxBad ? 'Two letters each' : undefined}><Input value={states} disabled={readOnly} onChange={(e) => { setStates(e.target.value); setPlan(null); }} /></Field>
          </div>
          <span className="btn-row">
            <Check checked={a.retainerEvergreen} disabled={readOnly} onChange={(e) => set('retainerEvergreen', e.target.checked)} label="Evergreen retainer (top it back up)" />
            <Check checked={a.showCostToClients} disabled={readOnly} onChange={(e) => set('showCostToClients', e.target.checked)} label="Show trade cost to clients" />
          </span>
          <Field label="Receivers (warehouses that accept deliveries for you)">
            <div className="stack">{a.receivers.map((r, i) => <div key={i} className="ops-toolbar">
              <Input aria-label="Receiver name" placeholder="Name" value={r.name} disabled={readOnly} onChange={(e) => set('receivers', a.receivers.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
              <Input aria-label="Receiver address" placeholder="Address" value={r.address} disabled={readOnly} onChange={(e) => set('receivers', a.receivers.map((x, k) => (k === i ? { ...x, address: e.target.value } : x)))} />
            </div>)}
              {!readOnly && a.receivers.length < 20 && <span><Button onClick={() => set('receivers', [...a.receivers, { name: '', address: '' }])}>Add a receiver</Button></span>}</div>
          </Field>
          <Field label="Tool you are leaving"><Input value={a.replacing ?? ''} disabled={readOnly} placeholder="Studio Designer, Mydoma, DesignFiles…" onChange={(e) => set('replacing', e.target.value.trim() ? e.target.value : null)} /></Field>
          {!readOnly && <span className="btn-row"><Button disabled={busy === 'pv' || taxBad || retainerCents == null} onClick={async () => {
            const r = await run<{ plan: DesignPlan }>('pv', url, { op: 'setup_preview', companyId, answers }, null);
            if (r) setPlan(r.plan);
          }}>Show me the setup</Button></span>}
        </div>
      </Section>
      {plan && (
        <Section title="What setup will do" meta="Nothing is written until you apply"
          actions={readOnly ? null : <Button variant="primary" disabled={busy === 'ap'} onClick={() => run('ap', url, { op: 'setup_apply', companyId, answers }, 'Setup applied')}>Apply the setup</Button>}>
          <div className="ops-split">
            <table className="ops-mini" aria-label="Cost codes"><tbody>{plan.cost_codes.map((c) => <tr key={c.code}><td>{c.code}</td><td>{c.name}</td><td>{c.cost_type.toLowerCase()}</td></tr>)}</tbody></table>
            <div className="stack">
              <p className="l2">Retainer {money(Number(plan.settings.retainer_cents ?? 0))} · {plan.receivers.length} receiver(s)</p>
              <ul className="l2">{Object.values(plan.books_accounts).map((v) => <li key={v}>{v}</li>)}</ul>
            </div>
          </div>
        </Section>
      )}
    </div>
  );
}
