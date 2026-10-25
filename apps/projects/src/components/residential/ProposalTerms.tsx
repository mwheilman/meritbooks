'use client';

import { useState } from 'react';
import { Button, Check, Field, Input, MoneyInput, Select, Tag, Textarea, WidgetState, money } from '@meritbooks/merit-ui';
import type { PaymentScheduleRow, ProposalLineRow, ProposalOptionRow, ProposalRow } from '@/lib/residential/types';
import { CONTRACT_SHORT, PAYMENT_STATUS, TAX_FORM_WORDS, scheduleShare } from '@/lib/residential/labels';
import { useMoneyVis } from '@/components/shell/ShellContext';
import { Failure, PctInput, Section, StatusMark } from '@/components/ops/common/bits';
import { useOps } from '@/components/ops/common/useOps';

// ------------------------------------------------------------------ options

export function ProposalOptions({ proposal: p, options, lines, editable, canChoose }: { proposal: ProposalRow; options: ProposalOptionRow[]; lines: ProposalLineRow[]; editable: boolean; canChoose: boolean }) {
  const mv = useMoneyVis();
  const { act, busy, error } = useOps();
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<'ALTERNATE' | 'ADD_ON'>('ADD_ON');
  const [label, setLabel] = useState('');
  const [group, setGroup] = useState('');
  const [tier, setTier] = useState<'' | 'GOOD' | 'BETTER' | 'BEST'>('');
  const [desc, setDesc] = useState('');
  const price = (o: ProposalOptionRow) => lines.filter((l) => l.option_id === o.id).reduce((s, l) => s + l.price_cents, 0);
  const chosen = new Set(options.filter((o) => o.is_selected).map((o) => o.id));
  const toggle = (o: ProposalOptionRow) => {
    const next = new Set(chosen);
    if (next.has(o.id)) next.delete(o.id);
    else {
      if (o.kind === 'ALTERNATE' && o.group_key) for (const x of options) if (x.group_key === o.group_key) next.delete(x.id);
      next.add(o.id);
    }
    void act(`opt-${o.id}`, 'post', `/api/residential/proposals/${p.id}`, { op: 'options', optionIds: [...next] }, next.has(o.id) ? `Chose ${o.label}` : `Dropped ${o.label}`);
  };
  const add = async () => {
    if (!label.trim()) return;
    if (kind === 'ALTERNATE' && !group.trim()) return;
    const r = await act('add-opt', 'post', `/api/residential/proposals/${p.id}/options`, {
      kind, label: label.trim(), groupKey: kind === 'ALTERNATE' ? group.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-') : null, tier: tier || null, description: desc.trim() || null,
    }, `Added ${label.trim()}`);
    if (r) { setAdding(false); setLabel(''); setDesc(''); }
  };
  return (
    <div className="stack">
      {editable && <div className="btn-row"><Button icon="plus" variant={adding ? 'primary' : 'default'} onClick={() => setAdding(!adding)}>Option</Button></div>}
      {adding && (
        <Section title="New option" meta="Add its lines from the Scope tab, choosing this option">
          <form className="mp-form" onSubmit={(e) => { e.preventDefault(); void add(); }}>
            <Field label="Kind">
              <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                <option value="ADD_ON">Add-on (any number)</option>
                <option value="ALTERNATE">Alternate — pick one of a group (good / better / best)</option>
              </Select>
            </Field>
            <Field label="Name"><Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} autoFocus placeholder="Upgrade to quartz" /></Field>
            {kind === 'ALTERNATE' && (
              <div className="mp-form-2">
                <Field label="Group" error={!group.trim() ? 'Alternates need a group' : undefined}><Input value={group} onChange={(e) => setGroup(e.target.value)} maxLength={40} placeholder="countertops" /></Field>
                <Field label="Tier"><Select value={tier} onChange={(e) => setTier(e.target.value as typeof tier)}><option value="">—</option><option value="GOOD">Good</option><option value="BETTER">Better</option><option value="BEST">Best</option></Select></Field>
              </div>
            )}
            <Field label="Description for the homeowner"><Textarea value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={4000} /></Field>
            <div className="btn-row"><Button onClick={() => setAdding(false)}>Cancel</Button><Button type="submit" variant="primary" disabled={busy === 'add-opt'}>Add option</Button></div>
          </form>
        </Section>
      )}
      <Failure text={error} />
      {options.length === 0 ? (
        <WidgetState state={{ kind: 'empty', title: 'No options', body: 'Offer good / better / best alternates or add-ons. The homeowner’s picks change the price on the proposal before signing.' }} />
      ) : (
        <div className="mp-table">
          <table className="tbl tbl-q tbl-q--compact">
            <thead><tr><th>Option</th><th>Kind</th>{mv.contract && <th className="n">Price</th>}<th>Chosen</th>{editable && <th aria-label="Remove" />}</tr></thead>
            <tbody>
              {options.map((o) => (
                <tr key={o.id}>
                  <td><span className="l1">{o.label}</span>{o.description && <span className="l2">{o.description}</span>}</td>
                  <td>{o.kind === 'ALTERNATE' ? <>Pick one · {o.group_key}{o.tier ? <> <Tag>{o.tier.toLowerCase()}</Tag></> : null}</> : 'Add-on'}</td>
                  {mv.contract && <td className="n">{money(price(o))}</td>}
                  <td>{canChoose ? <Check checked={o.is_selected} disabled={busy === `opt-${o.id}`} onChange={() => toggle(o)} label={o.is_selected ? 'Chosen' : 'Choose'} /> : o.is_selected ? 'Yes' : '—'}</td>
                  {editable && <td className="n"><Button variant="quiet" disabled={busy === `del-${o.id}`} onClick={() => void act(`del-${o.id}`, 'delete', `/api/residential/proposals/${p.id}/options?optionId=${o.id}`, undefined, `Removed ${o.label}`)}>Remove</Button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ payment schedule

interface RowDraft { label: string; kind: 'DEPOSIT' | 'MILESTONE' | 'FINAL'; pct: number | null; amountCents: number | null; triggerRef: string; requiresPhoto: boolean; requiresChecklist: boolean }

const toDraft = (r: PaymentScheduleRow): RowDraft => ({ label: r.label, kind: r.kind, pct: r.pct, amountCents: r.pct == null ? r.amount_cents : null, triggerRef: r.trigger_ref ?? '', requiresPhoto: r.requires_photo, requiresChecklist: r.requires_checklist });

export function ProposalPayments({ proposal: p, schedule, editable }: { proposal: ProposalRow; schedule: PaymentScheduleRow[]; editable: boolean }) {
  const mv = useMoneyVis();
  const { act, busy, error } = useOps();
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<RowDraft[]>(() => schedule.map(toDraft));
  const set = (i: number, patch: Partial<RowDraft>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const pctSum = rows.reduce((s, r) => s + (r.pct ?? 0), 0);
  const balanceRow = rows.some((r) => r.kind === 'FINAL' && r.pct == null && r.amountCents == null);
  const ok = rows.length > 0 && rows.every((r) => r.label.trim()) && (balanceRow ? pctSum <= 1 : Math.abs(pctSum - 1) < 0.0001 || rows.some((r) => r.amountCents != null));
  const save = async () => {
    const r = await act('schedule', 'post', `/api/residential/proposals/${p.id}`, { op: 'schedule', rows: rows.map((x) => ({
      label: x.label.trim(), kind: x.kind, pct: x.pct, amountCents: x.amountCents, triggerRef: x.triggerRef.trim() || null, requiresPhoto: x.requiresPhoto, requiresChecklist: x.requiresChecklist,
    })) }, 'Payment schedule saved');
    if (r) setEditing(false);
  };
  if (!mv.contract) return <p className="t-cap">The payment schedule is contract money; it is hidden for your role.</p>;
  if (editing) {
    return (
      <Section title="Payment schedule" meta={balanceRow ? `${Math.round(pctSum * 10000) / 100}% fixed · the final payment takes the balance` : `${Math.round(pctSum * 10000) / 100}% of the contract`}>
        <div className="stack">
          {rows.map((r, i) => (
            <div key={i} className="mp-form-2" style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr auto', alignItems: 'end' }}>
              <Field label={i === 0 ? 'Payment' : ''}><Input aria-label="Payment name" value={r.label} onChange={(e) => set(i, { label: e.target.value })} maxLength={120} /></Field>
              <Field label={i === 0 ? 'When' : ''}>
                <Select aria-label="When" value={r.kind} onChange={(e) => set(i, { kind: e.target.value as RowDraft['kind'] })}>
                  <option value="DEPOSIT">At signing</option><option value="MILESTONE">At a milestone</option><option value="FINAL">At completion</option>
                </Select>
              </Field>
              <Field label={i === 0 ? 'Share' : ''}><PctInput aria-label="Percent of contract" value={r.pct} onChange={(v) => set(i, { pct: v, amountCents: null })} placeholder={r.kind === 'FINAL' ? 'Balance' : '%'} /></Field>
              <Field label={i === 0 ? 'Milestone task key' : ''} help={r.kind === 'MILESTONE' ? 'e.g. demolition, cabinets' : undefined}>
                <Input aria-label="Milestone task key" value={r.triggerRef} onChange={(e) => set(i, { triggerRef: e.target.value.toLowerCase() })} disabled={r.kind !== 'MILESTONE'} maxLength={48} />
              </Field>
              <Button variant="quiet" aria-label={`Remove ${r.label}`} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>Remove</Button>
              {r.kind !== 'DEPOSIT' && (
                <div className="row" style={{ gridColumn: '1 / -1', gap: 16 }}>
                  <Check checked={r.requiresPhoto} onChange={(e) => set(i, { requiresPhoto: e.target.checked })} label="Needs a completion photo" />
                  <Check checked={r.requiresChecklist} onChange={(e) => set(i, { requiresChecklist: e.target.checked })} label="Needs the checklist done" />
                </div>
              )}
            </div>
          ))}
          <div className="btn-row">
            <Button icon="plus" variant="quiet" onClick={() => setRows((rs) => [...rs, { label: '', kind: 'MILESTONE', pct: null, amountCents: null, triggerRef: '', requiresPhoto: false, requiresChecklist: false }])}>Payment</Button>
            <span className="sp" />
            <Button onClick={() => { setRows(schedule.map(toDraft)); setEditing(false); }}>Cancel</Button>
            <Button variant="primary" disabled={!ok || busy === 'schedule'} title={ok ? undefined : 'The shares must add to 100% (or leave the final payment as the balance)'} onClick={() => void save()}>Save schedule</Button>
          </div>
          <Failure text={error} />
        </div>
      </Section>
    );
  }
  return (
    <Section title="Payment schedule" meta="Milestones sit on schedule tasks after acceptance; finishing the task drafts the bill" actions={editable ? <Button onClick={() => { setRows(schedule.map(toDraft)); setEditing(true); }}>Edit</Button> : undefined}>
      {schedule.length === 0 ? <p className="t-cap">No schedule yet — it is written from the job type’s template when the proposal is created.</p> : (
        <div className="mp-table">
          <table className="tbl tbl-q tbl-q--compact">
            <thead><tr><th>Payment</th><th>When</th><th className="n">Share</th><th>Status</th></tr></thead>
            <tbody>
              {schedule.map((s) => (
                <tr key={s.id}>
                  <td><span className="l1">{s.label}</span><span className="l2">{[s.requires_photo ? 'Photo required' : null, s.requires_checklist ? 'Checklist required' : null, s.hold_reason].filter(Boolean).join(' · ')}</span></td>
                  <td>{s.kind === 'DEPOSIT' ? 'At signing' : s.kind === 'FINAL' ? 'At completion' : s.trigger_ref ? `When “${s.trigger_ref.replace(/_/g, ' ')}” is done` : 'At a milestone'}</td>
                  <td className="n">{scheduleShare(s, money)}</td>
                  <td><StatusMark mark={PAYMENT_STATUS[s.status]} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ terms

export function ProposalTerms({ proposal: p, editable }: { proposal: ProposalRow; editable: boolean }) {
  const mv = useMoneyVis();
  const { act, busy, error } = useOps();
  const [f, setF] = useState({
    title: p.title, contractType: p.contract_type, feePct: p.fee_pct, feeCents: p.fee_cents, gmpCents: p.gmp_cents, taxForm: p.tax_contract_form, taxRate: p.tax_rate,
    stateCode: p.state_code ?? '', depositPct: p.deposit_pct, depositCents: p.deposit_cents, contingencyPct: p.contingency_pct, validUntil: p.valid_until ?? '', plannedStart: p.planned_start ?? '',
    scopeNarrative: p.scope_narrative ?? '', inclusions: p.inclusions.join('\n'), exclusions: p.exclusions.join('\n'), terms: p.terms ?? '', depositRefundable: p.deposit_refundable,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 60);
  const save = () => void act('terms', 'patch', `/api/residential/proposals/${p.id}`, {
    title: f.title.trim() || undefined, contractType: f.contractType, feePct: f.feePct, feeCents: f.feeCents, gmpCents: f.gmpCents, taxForm: f.taxForm, taxRate: f.taxRate ?? 0,
    stateCode: /^[A-Z]{2}$/.test(f.stateCode) ? f.stateCode : null, depositPct: f.depositPct, depositCents: f.depositCents, contingencyPct: f.contingencyPct,
    validUntil: f.validUntil || null, plannedStart: f.plannedStart || null, scopeNarrative: f.scopeNarrative.trim() || null, inclusions: lines(f.inclusions), exclusions: lines(f.exclusions),
    terms: f.terms.trim() || null, depositRefundable: f.depositRefundable,
  }, 'Saved');
  const ro = !editable;
  const cp = f.contractType.startsWith('COST_PLUS');
  return (
    <Section title="Terms" meta={ro ? 'Revise the proposal to change a sent version' : 'Totals and the state notice follow when you save'} actions={editable ? <Button variant="primary" disabled={busy === 'terms'} onClick={save}>Save</Button> : undefined}>
      <form className="mp-form" onSubmit={(e) => { e.preventDefault(); if (editable) save(); }}>
        <fieldset disabled={ro} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
          <Field label="Title"><Input value={f.title} onChange={(e) => set('title', e.target.value)} maxLength={200} /></Field>
          <div className="mp-form-2">
            <Field label="Contract form">
              <Select value={f.contractType} onChange={(e) => set('contractType', e.target.value as ProposalRow['contract_type'])}>
                {(['FIXED_PRICE', 'COST_PLUS_PCT', 'COST_PLUS_FEE', 'COST_PLUS_GMP', 'TIME_MATERIALS', 'DESIGN_AGREEMENT'] as const).map((k) => <option key={k} value={k}>{CONTRACT_SHORT[k]}</option>)}
              </Select>
            </Field>
            <Field label="Sales tax form" help="Decides who collects tax and on what">
              <Select value={f.taxForm} onChange={(e) => set('taxForm', e.target.value as ProposalRow['tax_contract_form'])}>
                {(Object.keys(TAX_FORM_WORDS) as Array<ProposalRow['tax_contract_form']>).map((k) => <option key={k} value={k}>{TAX_FORM_WORDS[k]}</option>)}
              </Select>
            </Field>
          </div>
          {cp && mv.contract && (
            <div className="mp-form-2">
              {f.contractType !== 'COST_PLUS_FEE' ? <Field label="Fee"><PctInput value={f.feePct} onChange={(v) => set('feePct', v)} /></Field> : <Field label="Fixed fee"><MoneyInput valueCents={f.feeCents} onChangeCents={(v) => set('feeCents', v)} /></Field>}
              {f.contractType === 'COST_PLUS_GMP' && <Field label="Guaranteed maximum"><MoneyInput valueCents={f.gmpCents} onChangeCents={(v) => set('gmpCents', v)} /></Field>}
            </div>
          )}
          <div className="mp-form-2">
            <Field label="State" help="Sets the cancellation notice and deposit cap"><Input value={f.stateCode} onChange={(e) => set('stateCode', e.target.value.toUpperCase().slice(0, 2))} placeholder="IA" maxLength={2} /></Field>
            <Field label="Tax rate"><PctInput value={f.taxRate} onChange={(v) => set('taxRate', v ?? 0)} max={50} placeholder="0" /></Field>
          </div>
          {mv.contract && (
            <div className="mp-form-2">
              <Field label="Deposit" help="Capped by the state rule"><PctInput value={f.depositPct} onChange={(v) => { set('depositPct', v); if (v != null) set('depositCents', null); }} placeholder="%" /></Field>
              <Field label="…or a fixed deposit"><MoneyInput valueCents={f.depositCents} onChangeCents={(v) => { set('depositCents', v); if (v != null) set('depositPct', null); }} placeholder="None" /></Field>
            </div>
          )}
          <Check checked={f.depositRefundable} onChange={(e) => set('depositRefundable', e.target.checked)} label="Deposit is refundable" />
          <div className="mp-form-2">
            <Field label="Contingency" help="Of the scope, before allowances"><PctInput value={f.contingencyPct} onChange={(v) => set('contingencyPct', v)} max={50} placeholder="None" /></Field>
            <Field label="Valid until"><Input type="date" value={f.validUntil} onChange={(e) => set('validUntil', e.target.value)} /></Field>
          </div>
          <Field label="Planned start" help="The schedule is built from this date on acceptance"><Input type="date" value={f.plannedStart} onChange={(e) => set('plannedStart', e.target.value)} /></Field>
          <Field label="Scope of work"><Textarea value={f.scopeNarrative} onChange={(e) => set('scopeNarrative', e.target.value)} rows={5} maxLength={20000} /></Field>
          <div className="mp-form-2">
            <Field label="Included" help="One per line"><Textarea value={f.inclusions} onChange={(e) => set('inclusions', e.target.value)} rows={5} /></Field>
            <Field label="Not included" help="One per line"><Textarea value={f.exclusions} onChange={(e) => set('exclusions', e.target.value)} rows={5} /></Field>
          </div>
          <Field label="Terms and conditions"><Textarea value={f.terms} onChange={(e) => set('terms', e.target.value)} rows={6} maxLength={20000} /></Field>
        </fieldset>
        <Failure text={error} />
      </form>
    </Section>
  );
}
