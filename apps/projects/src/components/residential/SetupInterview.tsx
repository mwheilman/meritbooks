'use client';

import { useState, type ReactNode } from 'react';
import { Button, Check, Field, InlineNotice, Input, Select, shortDate } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, PctInput, Section } from '@/components/ops/common/bits';
import { BoardState, pctText, useBoard, useDo } from '@/components/dealer/common/depth';
import { RESIDENTIAL_QUESTIONS, type ResidentialAnswers, type ResidentialPlan } from '@/lib/residential/setup';

const BUSINESS: Array<[ResidentialAnswers['businessKind'], string]> = [['remodel', 'Remodeling'], ['custom', 'Custom homes'], ['production', 'Production homes'], ['hybrid', 'A mix']];
const CONTRACTS: Array<[ResidentialAnswers['contractTypes'][number], string]> = [['FIXED_PRICE', 'Fixed price'], ['COST_PLUS_PCT', 'Cost plus percent'], ['COST_PLUS_FEE', 'Cost plus fee'],
  ['COST_PLUS_GMP', 'Cost plus with a GMP'], ['TIME_MATERIALS', 'Time and materials']];
const BILLING: Array<[ResidentialAnswers['billingMethod'], string]> = [['MILESTONE', 'Milestone payments'], ['PROGRESS', 'Monthly progress'], ['DRAW', 'Construction-loan draws'], ['COST_PLUS', 'Cost-plus invoices'], ['MIXED', 'It depends on the job']];
const PERFORM: Array<[ResidentialAnswers['selfPerform'], string]> = [['SELF_PERFORM', 'Our own crews'], ['SUBCONTRACT', 'Trade partners'], ['MIXED', 'Both']];
const TAX: Array<[ResidentialAnswers['taxForm'], string]> = [['LUMP_SUM_IMPROVEMENT', 'Lump-sum improvement'], ['RETAIL_PLUS_INSTALL', 'Retail sale plus install'], ['EXEMPT', 'Exempt']];

const START: ResidentialAnswers = { businessKind: 'remodel', contractTypes: ['FIXED_PRICE'], billingMethod: 'MILESTONE', selfPerform: 'MIXED', stateCode: null, taxForm: 'LUMP_SUM_IMPROVEMENT',
  depositPct: 0.1, markupPct: 0.25, workmanshipWarrantyMonths: 12, structuralWarrantyYears: 0, usesSelectionsPortal: true };

interface SetupBoard { settings: Record<string, unknown> | null; lastRun: { applied_at: string; answers: ResidentialAnswers } | null }

const help = (k: keyof ResidentialAnswers) => RESIDENTIAL_QUESTIONS.find((q) => q.key === k)!;

/** The residential setup interview (RES-01): eleven answers → a plan shown in full → applied in one step (settings, cost codes, payment template, library, job types, Books map). */
export function SetupInterview({ companyId }: { companyId: string }) {
  const { readOnly } = useShell();
  const url = '/api/residential/setup';
  const b = useBoard<SetupBoard>(`${url}?company=${companyId}`);
  const { run, busy, error } = useDo(b.reload);
  const [a, setA] = useState<ResidentialAnswers>(START);
  const [loaded, setLoaded] = useState(false);
  const [plan, setPlan] = useState<ResidentialPlan | null>(null);
  if (b.data && !loaded) { setLoaded(true); if (b.data.lastRun?.answers) setA({ ...START, ...b.data.lastRun.answers }); }
  const set = <K extends keyof ResidentialAnswers>(k: K, v: ResidentialAnswers[K]) => { setA({ ...a, [k]: v }); setPlan(null); };
  const stateBad = a.stateCode != null && !/^[A-Z]{2}$/.test(a.stateCode);
  const state = <BoardState b={b} what="Setup" />;
  if (!b.data) return state;
  const q = (k: keyof ResidentialAnswers, child: ReactNode) => <Field label={help(k).label} help={help(k).help}>{child}</Field>;
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      {b.data.lastRun && <InlineNotice tone="info" title={`Set up ${shortDate(b.data.lastRun.applied_at)}.`}>Running it again adds what is missing and updates the settings; nothing you have already changed is deleted.</InlineNotice>}
      <Section title="About the business" meta="About ten questions">
        <div className="stack">
          {q('businessKind', <Select value={a.businessKind} disabled={readOnly} onChange={(e) => set('businessKind', e.target.value as ResidentialAnswers['businessKind'])}>{BUSINESS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>)}
          <Field label={help('contractTypes').label} help={help('contractTypes').help} error={a.contractTypes.length === 0 ? 'Pick at least one' : undefined}>
            <span className="btn-row">{CONTRACTS.map(([k, l]) => <Check key={k} disabled={readOnly} checked={a.contractTypes.includes(k)} onChange={(e) => set('contractTypes', e.target.checked ? [...a.contractTypes, k] : a.contractTypes.filter((x) => x !== k))} label={l} />)}</span>
          </Field>
          {q('billingMethod', <Select value={a.billingMethod} disabled={readOnly} onChange={(e) => set('billingMethod', e.target.value as ResidentialAnswers['billingMethod'])}>{BILLING.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>)}
          {q('selfPerform', <Select value={a.selfPerform} disabled={readOnly} onChange={(e) => set('selfPerform', e.target.value as ResidentialAnswers['selfPerform'])}>{PERFORM.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>)}
          <Field label={help('stateCode').label} help={help('stateCode').help} error={stateBad ? 'Two letters, like IA' : undefined}>
            <Input value={a.stateCode ?? ''} disabled={readOnly} maxLength={2} style={{ width: 70 }} onChange={(e) => set('stateCode', e.target.value.trim() ? e.target.value.toUpperCase() : null)} /></Field>
          {q('taxForm', <Select value={a.taxForm} disabled={readOnly} onChange={(e) => set('taxForm', e.target.value as ResidentialAnswers['taxForm'])}>{TAX.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>)}
          <div className="ops-toolbar">
            {q('depositPct', <PctInput value={a.depositPct} max={100} aria-label="Deposit" onChange={(v) => set('depositPct', v ?? 0)} />)}
            {q('markupPct', <PctInput value={a.markupPct} max={1000} aria-label="Markup" onChange={(v) => set('markupPct', v ?? 0)} />)}
            {q('workmanshipWarrantyMonths', <Input inputMode="numeric" disabled={readOnly} style={{ width: 80 }} value={String(a.workmanshipWarrantyMonths)} onChange={(e) => set('workmanshipWarrantyMonths', Math.max(0, Math.min(120, Number(e.target.value.replace(/\D/g, '')) || 0)))} />)}
            {q('structuralWarrantyYears', <Input inputMode="numeric" disabled={readOnly} style={{ width: 80 }} value={String(a.structuralWarrantyYears)} onChange={(e) => set('structuralWarrantyYears', Math.max(0, Math.min(20, Number(e.target.value.replace(/\D/g, '')) || 0)))} />)}
          </div>
          <Check checked={a.usesSelectionsPortal} disabled={readOnly} onChange={(e) => set('usesSelectionsPortal', e.target.checked)} label={help('usesSelectionsPortal').label} />
          {!readOnly && <span className="btn-row"><Button disabled={busy === 'pv' || stateBad || a.contractTypes.length === 0} onClick={async () => {
            const r = await run<{ plan: ResidentialPlan }>('pv', url, { op: 'preview', companyId, answers: a }, null);
            if (r) setPlan(r.plan);
          }}>Show me the setup</Button></span>}
        </div>
      </Section>
      {plan && <PlanView plan={plan} applying={busy === 'ap'} readOnly={readOnly} onApply={() => run('ap', url, { op: 'apply', companyId, answers: a }, 'Setup applied')} />}
    </div>
  );
}

function PlanView({ plan, onApply, applying, readOnly }: { plan: ResidentialPlan; onApply: () => void; applying: boolean; readOnly: boolean }) {
  return (
    <Section title="What setup will do" meta="Nothing is written until you apply"
      actions={readOnly ? null : <Button variant="primary" disabled={applying} onClick={onApply}>Apply the setup</Button>}>
      <div className="ops-split">
        <div>
          <h4 className="l1">{plan.cost_codes.length} cost codes</h4>
          <table className="ops-mini" aria-label="Cost codes"><tbody>{plan.cost_codes.map((c) => <tr key={c.code}><td>{c.code}</td><td>{c.name}</td><td>{c.cost_type.toLowerCase()}</td></tr>)}</tbody></table>
        </div>
        <div className="stack">
          <h4 className="l1">Payment schedule</h4>
          <table className="ops-mini" aria-label="Payment schedule"><tbody>{plan.payment_template.map((p) => <tr key={p.label}><td>{p.label}</td><td className="n">{pctText(p.pct, 1)}</td></tr>)}</tbody></table>
          <h4 className="l1">Books accounts to map</h4>
          <ul className="l2">{Object.values(plan.books_accounts).map((v) => <li key={v}>{v}</li>)}</ul>
          <p className="l2">{plan.selection_library.length} selection templates · {plan.builder_job_types ? 'builder job types' : 'remodel job types'} · portal shows {Object.entries(plan.portal_defaults).filter(([, v]) => v).map(([k]) => k.replace(/_/g, ' ')).join(', ')}</p>
        </div>
      </div>
    </Section>
  );
}
