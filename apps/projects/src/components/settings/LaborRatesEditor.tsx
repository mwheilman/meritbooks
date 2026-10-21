'use client';

import { useMemo, useState } from 'react';
import { Button, Field, InlineNotice, Input, KV, MoneyInput, Select, Seg, Tag, WidgetState, money } from '@meritbooks/merit-ui';
import type { EmployeeCardRow, LaborRateRow, LaborSettingsRow } from '@/lib/pm/labor/types';
import { LABOR_COST_RULE, effectivePct, fractionToPercentText, laborRates, percentTextToFraction } from '@/lib/pm/labor/math';
import { useAction } from '@/components/job/useAction';
import { useShell } from '@/components/shell/ShellContext';

export interface LaborRatesEditorProps {
  companyId: string;
  settings: LaborSettingsRow | null;
  rates: LaborRateRow[];
  employees: Array<{ id: string; name: string }>;
  employeeCards: EmployeeCardRow[];
}

const pctText = (f: number | null | undefined) => (f == null ? '—' : `${fractionToPercentText(f)}%`);

/**
 * Settings → Labor rates. Company defaults (payroll burden; overhead for estimating only) and
 * one rate card per trade or role, each showing the job-cost rate next to the estimating rate.
 */
export function LaborRatesEditor(p: LaborRatesEditorProps) {
  const { readOnly } = useShell();
  const { run, busy } = useAction();
  const [burden, setBurden] = useState(fractionToPercentText(p.settings?.default_burden_pct ?? 0));
  const [overhead, setOverhead] = useState(fractionToPercentText(p.settings?.default_overhead_pct ?? 0));
  const [err, setErr] = useState<Record<string, string>>({});
  const [show, setShow] = useState<'active' | 'all'>('active');
  const visible = useMemo(() => p.rates.filter((r) => show === 'all' || r.is_active), [p.rates, show]);
  const defB = p.settings?.default_burden_pct ?? 0;
  const defO = p.settings?.default_overhead_pct ?? 0;

  const saveDefaults = async () => {
    const b = percentTextToFraction(burden || '0');
    const o = percentTextToFraction(overhead || '0');
    const e: Record<string, string> = {};
    if (b == null) e.burden = 'A percent from 0 to 500, like 28.5.';
    if (o == null) e.overhead = 'A percent from 0 to 500, like 15.';
    setErr(e);
    if (Object.keys(e).length) return;
    await run('defaults', 'post', '/api/labor/settings', { companyId: p.companyId, burdenPct: b, overheadPct: o }, 'Saved the labor defaults');
  };

  return (
    <div className="stack">
      <InlineNotice tone="info" title="Two rates, one rule.">{LABOR_COST_RULE}</InlineNotice>

      <section className="sec" aria-labelledby="lr-defaults">
        <div className="sec-h"><h3 className="t-head" id="lr-defaults">Company defaults</h3></div>
        {readOnly ? (
          <KV items={[{ term: 'Payroll burden', value: pctText(defB) }, { term: 'Overhead (estimating only)', value: pctText(defO) }]} />
        ) : (
          <form className="mp-add" onSubmit={(e) => { e.preventDefault(); void saveDefaults(); }} aria-label="Company labor defaults">
            <Field label="Payroll burden %" error={err.burden} help="Employer taxes, workers’ comp and benefits on top of pay. Part of job cost.">
              <Input inputMode="decimal" value={burden} onChange={(e) => setBurden(e.target.value)} style={{ width: 96 }} />
            </Field>
            <Field label="Overhead %" error={err.overhead} help="Estimating only: added to bids so they recover overhead. Never charged to a job.">
              <Input inputMode="decimal" value={overhead} onChange={(e) => setOverhead(e.target.value)} style={{ width: 96 }} />
            </Field>
            <Button type="submit" disabled={busy === 'defaults'}>Save defaults</Button>
          </form>
        )}
        {!p.settings && <p className="t-cap">Not saved yet: until then burden and overhead count as 0%.</p>}
      </section>

      <section className="sec" aria-labelledby="lr-cards">
        <div className="sec-h">
          <h3 className="t-head" id="lr-cards">Rate cards</h3>
          <span className="sp" />
          <Seg<'active' | 'all'> aria-label="Show" value={show} onChange={setShow} items={[{ value: 'active', label: 'Active' }, { value: 'all', label: 'All', count: p.rates.length }]} />
        </div>
        <div className="mp-table">
          {visible.length === 0 ? (
            <WidgetState state={{ kind: 'empty', title: 'No rate cards yet', body: 'Add one per trade or role, like Carpenter or Apprentice electrician. A card without a base rate uses each person’s own pay rate from Merit Books.' }} />
          ) : (
            <table className="tbl tbl-q tbl-q--compact">
              <colgroup><col /><col style={{ width: 104 }} /><col style={{ width: 88 }} /><col style={{ width: 88 }} /><col style={{ width: 120 }} /><col style={{ width: 132 }} /><col style={{ width: 96 }} /><col style={{ width: 88 }} /><col style={{ width: 112 }} /></colgroup>
              <thead>
                <tr>
                  <th>Trade or role</th><th className="n">Base pay</th><th className="n">Burden</th><th className="n">Overhead</th>
                  <th className="n">Cost rate<span className="l2">job cost</span></th><th className="n">Estimating rate<span className="l2">bids</span></th>
                  <th className="n">Bill rate</th><th className="n">People</th><th><span className="sr">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => <CardRow key={r.rate_card_id} r={r} defB={defB} defO={defO} readOnly={readOnly} />)}
              </tbody>
            </table>
          )}
          {!readOnly && <NewCard companyId={p.companyId} defB={defB} defO={defO} />}
        </div>
      </section>

      {p.rates.some((r) => r.is_active) && p.employees.length > 0 && (
        <EmployeeCards companyId={p.companyId} rates={p.rates.filter((r) => r.is_active)} employees={p.employees} cards={p.employeeCards} readOnly={readOnly} />
      )}
    </div>
  );
}

/** Cost rate | estimating rate, with the overhead component spelled out. */
function RatePair({ base, burden, overhead }: { base: number | null; burden: number; overhead: number }) {
  if (base == null) {
    return (
      <>
        <td className="n"><span className="l1" style={{ fontWeight: 400 }}>pay + {pctText(burden)}</span><span className="l2">each person’s rate</span></td>
        <td className="n"><span className="l1" style={{ fontWeight: 400 }}>+ {pctText(overhead)} overhead</span><span className="l2">set a base to bid</span></td>
      </>
    );
  }
  const x = laborRates(base, burden, overhead);
  return (
    <>
      <td className="n" title="Pay + burden: what job cost uses"><span className="l1">{money(x.costRateCents)}</span><span className="l2">per hour</span></td>
      <td className="n" title={`Cost rate ${money(x.costRateCents)} + overhead ${money(x.overheadRateCents)}`}><span className="l1">{money(x.estimatingRateCents)}</span><span className="l2">incl. {money(x.overheadRateCents)} overhead</span></td>
    </>
  );
}

function CardRow({ r, defB, defO, readOnly }: { r: LaborRateRow; defB: number; defO: number; readOnly: boolean }) {
  const { run, busy } = useAction();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(r.label);
  const [base, setBase] = useState<number | null>(r.base_rate_cents);
  const [burden, setBurden] = useState(r.card_burden_pct == null ? '' : fractionToPercentText(r.card_burden_pct));
  const [overhead, setOverhead] = useState(r.card_overhead_pct == null ? '' : fractionToPercentText(r.card_overhead_pct));
  const [bill, setBill] = useState<number | null>(r.bill_rate_cents);
  const [err, setErr] = useState<string | null>(null);
  const b = burden.trim() ? percentTextToFraction(burden) : null;
  const o = overhead.trim() ? percentTextToFraction(overhead) : null;

  const save = async (isActive = r.is_active) => {
    if (!label.trim()) return setErr('Name the trade or role.');
    if ((burden.trim() && b == null) || (overhead.trim() && o == null)) return setErr('Percents from 0 to 500, like 28.5. Leave blank to use the company default.');
    setErr(null);
    const res = await run(`card:${r.rate_card_id}`, 'patch', `/api/labor/rate-cards/${r.rate_card_id}`, {
      label: label.trim(), baseRateCents: base, burdenPct: b, overheadPct: o, billRateCents: bill, isActive,
    }, isActive === r.is_active ? `Saved ${label.trim()}` : isActive ? `Reactivated ${label.trim()}` : `Deactivated ${label.trim()}`);
    if (!res.error) setEditing(false);
  };

  if (editing) {
    return (
      <tr className="q-row">
        <td><Input aria-label="Trade or role" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} />{err && <span className="field-error">{err}</span>}</td>
        <td className="n"><MoneyInput aria-label="Base pay per hour" valueCents={base} onChangeCents={setBase} placeholder="Own rate" /></td>
        <td className="n"><Input aria-label="Burden percent" inputMode="decimal" value={burden} onChange={(e) => setBurden(e.target.value)} placeholder={fractionToPercentText(defB)} /></td>
        <td className="n"><Input aria-label="Overhead percent" inputMode="decimal" value={overhead} onChange={(e) => setOverhead(e.target.value)} placeholder={fractionToPercentText(defO)} /></td>
        <RatePair base={base} burden={effectivePct(b, defB)} overhead={effectivePct(o, defO)} />
        <td className="n"><MoneyInput aria-label="Bill rate per hour" valueCents={bill} onChangeCents={setBill} placeholder="None" /></td>
        <td className="n">{r.employee_count}</td>
        <td className="n"><div className="btn-row"><Button variant="primary" disabled={busy === `card:${r.rate_card_id}`} onClick={() => void save()}>Save</Button><Button variant="quiet" onClick={() => setEditing(false)}>Cancel</Button></div></td>
      </tr>
    );
  }
  return (
    <tr className={r.is_active ? 'q-row' : 'q-row is-done'}>
      <td><span className="l1">{r.label}</span><span className="l2"><span className="code">{r.key}</span> · since {r.effective_from}</span></td>
      <td className="n">{r.base_rate_cents == null ? <span className="l2">Own rate</span> : money(r.base_rate_cents)}</td>
      <td className="n">{pctText(r.burden_pct)}{r.burden_inherited ? <span className="l2">default</span> : null}</td>
      <td className="n">{pctText(r.overhead_pct)}{r.overhead_inherited ? <span className="l2">default</span> : null}</td>
      <RatePair base={r.base_rate_cents} burden={r.burden_pct} overhead={r.overhead_pct} />
      <td className="n">{r.bill_rate_cents == null ? '—' : money(r.bill_rate_cents)}</td>
      <td className="n">{r.employee_count}</td>
      <td className="n">
        {!readOnly && (
          <div className="btn-row">
            <Button variant="quiet" onClick={() => setEditing(true)}>Edit</Button>
            <Button variant="quiet" disabled={busy === `card:${r.rate_card_id}`} onClick={() => void save(!r.is_active)}>{r.is_active ? 'Deactivate' : 'Reactivate'}</Button>
          </div>
        )}
        {!r.is_active && readOnly && <Tag>Inactive</Tag>}
      </td>
    </tr>
  );
}

function NewCard({ companyId, defB, defO }: { companyId: string; defB: number; defO: number }) {
  const { run, busy } = useAction();
  const [label, setLabel] = useState('');
  const [base, setBase] = useState<number | null>(null);
  const [burden, setBurden] = useState('');
  const [overhead, setOverhead] = useState('');
  const [bill, setBill] = useState<number | null>(null);
  const [err, setErr] = useState<Record<string, string>>({});
  const b = burden.trim() ? percentTextToFraction(burden) : null;
  const o = overhead.trim() ? percentTextToFraction(overhead) : null;
  const preview = base != null ? laborRates(base, effectivePct(b, defB), effectivePct(o, defO)) : null;

  const add = async () => {
    const e: Record<string, string> = {};
    if (!label.trim()) e.label = 'Name the trade or role.';
    if (burden.trim() && b == null) e.burden = 'A percent from 0 to 500.';
    if (overhead.trim() && o == null) e.overhead = 'A percent from 0 to 500.';
    setErr(e);
    if (Object.keys(e).length) return;
    const r = await run('card:new', 'post', '/api/labor/rate-cards', { companyId, label: label.trim(), baseRateCents: base, burdenPct: b, overheadPct: o, billRateCents: bill }, `Added ${label.trim()}`);
    if (!r.error) { setLabel(''); setBase(null); setBurden(''); setOverhead(''); setBill(null); }
  };

  return (
    <form className="mp-add" onSubmit={(e) => { e.preventDefault(); void add(); }} aria-label="Add a rate card">
      <Field label="Trade or role" error={err.label}><Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder="Carpenter" style={{ width: 180 }} /></Field>
      <Field label="Base pay / h" help="Blank = each person’s rate"><MoneyInput valueCents={base} onChangeCents={setBase} placeholder="30.00" style={{ width: 112 }} /></Field>
      <Field label="Burden %" error={err.burden}><Input inputMode="decimal" value={burden} onChange={(e) => setBurden(e.target.value)} placeholder={fractionToPercentText(defB)} style={{ width: 80 }} /></Field>
      <Field label="Overhead %" error={err.overhead}><Input inputMode="decimal" value={overhead} onChange={(e) => setOverhead(e.target.value)} placeholder={fractionToPercentText(defO)} style={{ width: 80 }} /></Field>
      <Field label="Bill rate / h" help="Optional, for T&M"><MoneyInput valueCents={bill} onChangeCents={setBill} placeholder="None" style={{ width: 112 }} /></Field>
      <Field label="Cost / estimating">
        <span className="tnum" style={{ display: 'inline-block', minWidth: 160, lineHeight: '32px' }}>
          {preview ? `${money(preview.costRateCents)} / ${money(preview.estimatingRateCents)}` : '—'}
        </span>
      </Field>
      <Button type="submit" icon="plus" disabled={busy === 'card:new'}>Add rate card</Button>
    </form>
  );
}

function EmployeeCards({ companyId, rates, employees, cards, readOnly }: { companyId: string; rates: LaborRateRow[]; employees: Array<{ id: string; name: string }>; cards: EmployeeCardRow[]; readOnly: boolean }) {
  const { run, busy } = useAction();
  const byEmp = new Map(cards.map((c) => [c.employee_id, c.rate_card_id]));
  const names = new Map(rates.map((r) => [r.rate_card_id, r.label]));
  return (
    <section className="sec" aria-labelledby="lr-people">
      <div className="sec-h"><h3 className="t-head" id="lr-people">Who is on which card</h3></div>
      <p className="t-cap">Approved time uses the person’s card: its base pay (else their pay rate in Merit Books) and burden. People without a card use their own pay rate and the company burden.</p>
      <ul style={{ listStyle: 'none' }}>
        {employees.map((e) => (
          <li key={e.id} className="row row--between" style={{ minHeight: 40, borderBottom: '1px solid var(--line)' }}>
            <span>{e.name}</span>
            {readOnly ? (
              <span className="t-cap">{names.get(byEmp.get(e.id) ?? '') ?? 'Own rate'}</span>
            ) : (
              <Select aria-label={`Rate card for ${e.name}`} value={byEmp.get(e.id) ?? ''} disabled={busy === `emp:${e.id}`} style={{ width: 220 }}
                onChange={(ev) => void run(`emp:${e.id}`, 'post', '/api/labor/employee-cards', { companyId, employeeId: e.id, rateCardId: ev.target.value || null },
                  ev.target.value ? `${e.name} is on ${names.get(ev.target.value)}` : `${e.name} uses their own rate`)}>
                <option value="">Own rate, company burden</option>
                {rates.map((r) => <option key={r.rate_card_id} value={r.rate_card_id}>{r.label}</option>)}
              </Select>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
