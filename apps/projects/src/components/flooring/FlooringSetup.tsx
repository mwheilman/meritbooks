'use client';

import { useState } from 'react';
import { Button, Check, Field, Input, money } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, PctInput, Section } from '@/components/ops/common/bits';
import { BoardState, centsFrom, useBoard, useDo } from '@/components/dealer/common/depth';
import { FLOORING_MIX, type FlooringAnswers, type FlooringMix, type FlooringPlan } from '@/lib/flooring/setup';

const MIX_LABEL: Record<FlooringMix, string> = { RETAIL_INSTALLED: 'Retail, installed', CASH_AND_CARRY: 'Cash and carry', BUILDER: 'Builder / new construction', MULTI_FAMILY: 'Multi-family turns',
  COMMERCIAL: 'Commercial', INSURANCE: 'Insurance replacement' };

/** Flooring setup (FLR-01): business mix, installer pay, deposit, tax states, measure fee → plan → apply (settings, cost codes, starter labor price list, Books map). */
export function FlooringSetup({ companyId }: { companyId: string }) {
  const { readOnly } = useShell();
  const url = '/api/flooring/ops';
  const b = useBoard<{ rotation: unknown }>(`${url}?company=${companyId}&view=rotation`);
  const { run, busy, error } = useDo(b.reload);
  const [a, setA] = useState<FlooringAnswers>({ mix: ['RETAIL_INSTALLED'], installerPay: 'PIECE_RATE', depositPct: 0.5, taxStates: [], replacing: null, measureFeeCents: 0 });
  const [states, setStates] = useState('');
  const [fee, setFee] = useState('');
  const [plan, setPlan] = useState<FlooringPlan | null>(null);
  const tax = states.split(/[\s,]+/).filter(Boolean);
  const taxBad = tax.some((s) => !/^[A-Za-z]{2}$/.test(s));
  const feeCents = fee.trim() ? centsFrom(fee) : 0;
  const answers: FlooringAnswers = { ...a, taxStates: tax.map((s) => s.toUpperCase()), measureFeeCents: feeCents ?? 0 };
  const set = <K extends keyof FlooringAnswers>(k: K, v: FlooringAnswers[K]) => { setA({ ...a, [k]: v }); setPlan(null); };
  const state = <BoardState b={b} what="Setup" />;
  if (!b.data) return state;
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <Section title="About the store">
        <div className="stack">
          <Field label="What do you sell?" help="Pick every kind of work you do.">
            <span className="btn-row">{FLOORING_MIX.map((m) => <Check key={m} disabled={readOnly} checked={a.mix.includes(m)} label={MIX_LABEL[m]} onChange={(e) => set('mix', e.target.checked ? [...a.mix, m] : a.mix.filter((x) => x !== m))} />)}</span>
          </Field>
          <Field label="How are installers paid?" help="Piece rate by the yard or foot, hourly, or both.">
            <span className="btn-row">{(['PIECE_RATE', 'HOURLY', 'MIXED'] as const).map((p) => <Button key={p} variant={a.installerPay === p ? 'primary' : 'default'} disabled={readOnly} onClick={() => set('installerPay', p)}>{p === 'PIECE_RATE' ? 'Piece rate' : p === 'HOURLY' ? 'Hourly' : 'Both'}</Button>)}</span>
          </Field>
          <div className="ops-toolbar">
            <Field label="Deposit at order"><PctInput value={a.depositPct} aria-label="Deposit" onChange={(v) => set('depositPct', v ?? 0)} /></Field>
            <Field label="Measure fee (credited at sale)" error={fee.trim() && feeCents == null ? 'Dollars, like 75' : undefined}><Input value={fee} disabled={readOnly} style={{ width: 100 }} onChange={(e) => { setFee(e.target.value); setPlan(null); }} /></Field>
            <Field label="States you collect tax in" error={taxBad ? 'Two letters each, like IA, NE' : undefined}><Input value={states} disabled={readOnly} onChange={(e) => { setStates(e.target.value); setPlan(null); }} /></Field>
            <Field label="System you are leaving"><Input value={a.replacing ?? ''} disabled={readOnly} onChange={(e) => set('replacing', e.target.value.trim() ? e.target.value : null)} placeholder="RFMS, QFloors, Measure Square…" /></Field>
          </div>
          {!readOnly && <span className="btn-row"><Button disabled={busy === 'pv' || taxBad || feeCents == null} onClick={async () => {
            const r = await run<{ plan: FlooringPlan }>('pv', url, { op: 'setup_preview', companyId, answers }, null);
            if (r) setPlan(r.plan);
          }}>Show me the setup</Button></span>}
        </div>
      </Section>
      {plan && (
        <Section title="What setup will do" meta="Nothing is written until you apply"
          actions={readOnly ? null : <Button variant="primary" disabled={busy === 'ap'} onClick={() => run('ap', url, { op: 'setup_apply', companyId, answers }, 'Setup applied')}>Apply the setup</Button>}>
          <div className="ops-split">
            <table className="ops-mini" aria-label="Labor price list"><thead><tr><th>Labor</th><th>Unit</th><th className="n">Sell</th><th className="n">Installer pay</th></tr></thead>
              <tbody>{plan.labor_rates.map((r) => <tr key={r.code}><td>{r.description}</td><td>{r.unit}</td><td className="n">{money(r.sell_cents)}</td><td className="n">{money(r.pay_cents)}</td></tr>)}</tbody></table>
            <div className="stack">
              <table className="ops-mini" aria-label="Cost codes"><tbody>{plan.cost_codes.map((c) => <tr key={c.code}><td>{c.code}</td><td>{c.name}</td><td>{c.cost_type.toLowerCase()}</td></tr>)}</tbody></table>
              <ul className="l2">{Object.values(plan.books_accounts).map((v) => <li key={v}>{v}</li>)}</ul>
            </div>
          </div>
        </Section>
      )}
    </div>
  );
}
