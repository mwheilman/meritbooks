'use client';

import { useEffect, useState } from 'react';
import {
  Button, ButtonLink, Check, ConfirmDialog, Field, Input, KV, MoneyInput, Panel, PanelSection, Select, Tag, Textarea, shortDate,
} from '@meritbooks/merit-ui';
import { useMoneyText } from '@/components/money/useMoneyText';
import { METHOD_WORDS, SELECTION_STATUS } from '@/lib/pm/ops/labels';
import { lineAmount, markupText, sellFromMarkup, varianceText, varianceTone } from '@/lib/pm/ops/selection-math';
import { APPROVAL_METHODS, type ApprovalMethod, type SelectionOptionRow } from '@/lib/pm/ops/types';
import type { SelectionDetail } from '@/lib/pm/ops/selection-queries';
import { stamp } from '@/lib/time';
import { useShell, useVocab } from '@/components/shell/ShellContext';
import { lower } from '@/lib/pm/vocab';
import { DetailState, Failure, PctInput, StatusMark, parseNum } from '../common/bits';
import { useDetail, useOps } from '../common/useOps';

export interface SelectionPanelProps {
  id: string;
  jobLabel: string | null;
  customerName: string | null;
  today: string;
  onClose: () => void;
  onProcured?: () => void;
}

export function SelectionPanel(p: SelectionPanelProps) {
  const money = useMoneyText('contract');
  const v = useVocab();
  const { readOnly } = useShell();
  const { act, busy, version, error } = useOps();
  const { data, error: loadError, isLoading, refetch } = useDetail<SelectionDetail>(`/api/ops/selections/${p.id}`, version);
  const [mode, setMode] = useState<'none' | 'approve' | 'decline'>('none');
  const [voidOpen, setVoidOpen] = useState(false);
  const url = `/api/ops/selections/${p.id}`;
  useEffect(() => setMode('none'), [p.id]);

  if (!data) return <Panel eyebrow={v.selection} title="Loading" onClose={p.onClose}><PanelSection><DetailState loading={isLoading} error={loadError} onRetry={() => void refetch()} what={v.selection} /></PanelSection></Panel>;
  const s = data.selection;
  const decided = s.status === 'APPROVED' || s.status === 'VOID';
  const latest = data.approvals[0] ?? null;
  const chosen = data.options.find((o) => o.id === s.chosen_option_id) ?? null;
  const allowance = s.allowance_cents;

  return (
    <Panel
      eyebrow={[s.category, SELECTION_STATUS[s.status].word]}
      title={s.title}
      meta={[p.jobLabel, s.due_on ? `due ${shortDate(s.due_on, p.today)}` : null].filter(Boolean).join(' · ')}
      onClose={p.onClose}
      foot={readOnly ? undefined : (
        <div className="btn-row" style={{ width: '100%' }}>
          {!decided && <Button variant="quiet" onClick={() => setVoidOpen(true)}>Void</Button>}
          {s.status === 'PROPOSED' && <Button onClick={() => setMode(mode === 'decline' ? 'none' : 'decline')}>Client declined</Button>}
          <span className="sp" />
          {(s.status === 'OPEN' || s.status === 'REJECTED') && <Button disabled={busy === 'propose' || data.options.length === 0} title={data.options.length === 0 ? 'Add an option first' : undefined} onClick={() => void act('propose', 'post', url, { op: 'propose' }, `Sent ${s.title} to the client`)}>Send to client</Button>}
          {!decided && <Button variant="primary" disabled={data.options.length === 0} onClick={() => setMode('approve')}>Record approval</Button>}
          {s.status === 'APPROVED' && s.chosen_option_id && data.procurementIds.length === 0 && (
            <Button variant="primary" disabled={busy === 'procure'} onClick={() => void act('procure', 'post', url, { op: 'procure' }, 'Added it to purchasing').then((r) => { if (r) p.onProcured?.(); })}>Send to purchasing</Button>
          )}
        </div>
      )}
    >
      <PanelSection>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <StatusMark mark={SELECTION_STATUS[s.status]} />
          {s.due_on && s.due_on < p.today && !decided && <Tag tone="neg">Past due</Tag>}
          <span className="sp" />
          {/* 1119: the full chooser — options side by side, allowance delta, room and install deadline */}
          <ButtonLink href={`/selections/${s.id}`} variant={decided ? 'default' : 'primary'}>{decided ? 'Open' : 'Choose'}</ButtonLink>
        </div>
        <div style={{ marginTop: 12 }}>
          <KV items={[
            { term: 'Allowance', value: allowance == null ? 'None' : money(allowance) },
            ...(s.chosen_total_cents != null ? [{ term: 'Chosen', value: money(s.chosen_total_cents) }] : []),
            ...(s.status === 'APPROVED' ? [{ term: 'Variance', value: <span className={varianceTone(s.variance_cents) === 'neg' ? 'b' : undefined}>{s.variance_cents == null ? '—' : money(s.variance_cents)}</span> }] : []),
          ]} />
        </div>
        {s.status === 'APPROVED' && <p className="t-cap" style={{ marginTop: 6 }}>{varianceText(s.variance_cents)}{s.variance_cents && s.variance_cents > 0 ? `; bill it as an allowance overage or a ${lower(v.change_order)}.` : '.'}</p>}
        {s.description && <p style={{ marginTop: 8 }}>{s.description}</p>}
        {s.void_reason && <p className="t-cap" style={{ marginTop: 8 }}>Void: {s.void_reason}</p>}
        {error && <div style={{ marginTop: 8 }}><Failure text={error} /></div>}
      </PanelSection>

      {latest && (
        <PanelSection title="Client decision on record">
          <div className={latest.decision === 'APPROVED' ? 'ops-record' : 'ops-record neg'}>
            <p className="b">{latest.decision === 'APPROVED' ? 'Approved' : 'Declined'} by {latest.approver_name}</p>
            <p className="t-cap">{METHOD_WORDS[latest.method]} · {stamp(latest.decided_at)}{latest.approver_email ? ` · ${latest.approver_email}` : ''}</p>
            {latest.decision === 'APPROVED' && typeof latest.snapshot.label === 'string' && (
              <p style={{ marginTop: 4 }}>
                {String(latest.snapshot.label)}{latest.amount_cents != null ? `, ${money(latest.amount_cents)}` : ''}
                {typeof latest.snapshot.allowance_cents === 'number' ? ` against a ${money(latest.snapshot.allowance_cents)} allowance` : ''}
              </p>
            )}
            {latest.comment && <p className="t-cap" style={{ marginTop: 4 }}>“{latest.comment}”</p>}
          </div>
          {data.approvals.length > 1 && (
            <ul className="feed feed--flush" style={{ marginTop: 8 }}>
              {data.approvals.slice(1).map((a) => <li key={a.id}><span className="l1" style={{ fontWeight: 400 }}>{a.decision === 'APPROVED' ? 'Approved' : 'Declined'} by {a.approver_name} · {METHOD_WORDS[a.method]}</span><span className="t">{stamp(a.decided_at)}</span></li>)}
            </ul>
          )}
          <p className="t-cap" style={{ marginTop: 8 }}>This record is kept as written; it cannot be edited.</p>
        </PanelSection>
      )}

      {mode === 'approve' && !readOnly && (
        <ApproveForm options={data.options} customerName={p.customerName} allowance={allowance} busy={busy === 'approve'} onCancel={() => setMode('none')}
          onSubmit={async (b) => { const r = await act('approve', 'post', url, { op: 'approve', ...b }, `${b.approverName} approved ${s.title}`); if (r) setMode('none'); }} />
      )}
      {mode === 'decline' && !readOnly && (
        <DeclineForm customerName={p.customerName} busy={busy === 'decline'} onCancel={() => setMode('none')}
          onSubmit={async (b) => { const r = await act('decline', 'post', url, { op: 'reject', ...b }, `Recorded that ${b.approverName} declined`); if (r) setMode('none'); }} />
      )}

      <PanelSection title="Options" meta={data.options.length ? `${data.options.length} for the client to choose from` : undefined}>
        {data.options.length === 0 ? <p className="t-cap">No options yet. Add two or three the client can choose between, with prices.</p> : (
          <table className="ops-mini">
            <thead><tr><th>Option</th><th className="n">Amount</th><th className="n">vs allowance</th>{!decided && !readOnly && <th />}</tr></thead>
            <tbody>
              {data.options.map((o) => {
                const diff = allowance == null ? null : o.amount_cents - allowance;
                return (
                  <tr key={o.id} style={chosen?.id === o.id ? { background: 'var(--sky)' } : undefined}>
                    <td>
                      <span className="l1">{o.label} {o.is_recommended && <Tag tone="pos">Recommended</Tag>} {chosen?.id === o.id && <Tag tone="solid">Chosen</Tag>}</span>
                      <span className="l2">{[`${o.qty} ${o.uom} × ${o.unit_price_cents == null ? '—' : money(o.unit_price_cents)}`, o.vendor_sku, o.markup_pct != null ? `${markupText(o.markup_pct)} markup` : null, o.lead_time_days != null ? `${o.lead_time_days} days lead` : null].filter(Boolean).join(' · ')}</span>
                    </td>
                    <td className="n">{money(o.amount_cents)}</td>
                    <td className="n">{diff == null ? '—' : money(diff)}</td>
                    {!decided && !readOnly && <td><Button variant="quiet" iconOnly icon="x" aria-label={`Remove ${o.label}`} onClick={() => void act('opt', 'post', url, { op: 'remove_option', optionId: o.id }, 'Removed the option')} /></td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {!decided && !readOnly && <AddOptionForm busy={busy === 'opt'} onAdd={(b) => act('opt', 'post', url, { op: 'add_option', ...b }, `Added ${b.label}`)} />}
        <p className="t-cap" style={{ marginTop: 8 }}>Amounts are what the client pays; credits under the allowance show in parentheses.</p>
      </PanelSection>

      {!decided && !readOnly && <EditTerms id={s.id} allowance={allowance} due={s.due_on} busy={busy === 'terms'} onSave={(b) => void act('terms', 'post', url, { op: 'update', ...b }, 'Saved')} />}

      <ConfirmDialog open={voidOpen} onClose={() => setVoidOpen(false)} tone="danger" title={`Void ${s.title}`} confirmLabel="Void it"
        reason={{ label: 'Why', minLength: 2, placeholder: 'Client dropped the powder room from scope' }}
        onConfirm={async (reason) => { const r = await act('void', 'post', url, { op: 'void', reason: reason ?? '' }, 'Voided'); if (!r) throw new Error('Not voided.'); }}>
        A void selection no longer holds up the job’s stage moves or the shop release.
      </ConfirmDialog>
    </Panel>
  );
}

function ApproveForm({ options, customerName, allowance, busy, onCancel, onSubmit }: {
  options: SelectionOptionRow[]; customerName: string | null; allowance: number | null; busy: boolean; onCancel: () => void;
  onSubmit: (b: { optionId: string | null; approverName: string; method: ApprovalMethod; approverEmail: string | null; comment: string | null }) => void;
}) {
  const money = useMoneyText('contract');
  const [optionId, setOptionId] = useState(options.length === 1 ? options[0]!.id : options.find((o) => o.is_recommended)?.id ?? '');
  const [name, setName] = useState(customerName ?? '');
  const [method, setMethod] = useState<ApprovalMethod>('IN_PERSON');
  const [email, setEmail] = useState('');
  const [comment, setComment] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const opt = options.find((o) => o.id === optionId) ?? null;
  return (
    <PanelSection title="Record the client’s approval">
      <form className="mp-form" onSubmit={(e) => {
        e.preventDefault();
        if (!optionId) return setErr('Pick the option the client chose.');
        if (!name.trim()) return setErr('Who approved it? Their name goes on the record.');
        if (email && !/^\S+@\S+\.\S+$/.test(email)) return setErr('That email does not look right.');
        onSubmit({ optionId, approverName: name.trim(), method, approverEmail: email.trim() || null, comment: comment.trim() || null });
      }}>
        <fieldset style={{ border: 0, padding: 0 }}>
          <legend className="field-label">They chose</legend>
          {options.map((o) => (
            <label key={o.id} className="row" style={{ gap: 8, padding: '4px 0', alignItems: 'baseline' }}>
              <input type="radio" name="chosen" value={o.id} checked={optionId === o.id} onChange={() => setOptionId(o.id)} />
              <span style={{ flex: 1 }}>{o.label}</span><span className="tnum">{money(o.amount_cents)}</span>
            </label>
          ))}
        </fieldset>
        {opt && allowance != null && <p className="t-cap">{varianceText(opt.amount_cents - allowance)} ({money(allowance)} allowance).</p>}
        <div className="mp-form-2">
          <Field label="Approved by" error={err ?? undefined}><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Client’s full name" maxLength={200} /></Field>
          <Field label="How"><Select value={method} onChange={(e) => setMethod(e.target.value as ApprovalMethod)}>{APPROVAL_METHODS.map((m) => <option key={m} value={m}>{METHOD_WORDS[m]}</option>)}</Select></Field>
        </div>
        <Field label="Their email" help="Optional, for the record"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} /></Field>
        <Field label="Note"><Textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} placeholder="Approved at the showroom after seeing the slab" /></Field>
        <p className="t-cap">The time is stamped when you record it. The allowance and price are pinned with it.</p>
        <div className="btn-row"><Button onClick={onCancel}>Back</Button><Button type="submit" variant="primary" disabled={busy}>Record approval</Button></div>
      </form>
    </PanelSection>
  );
}

function DeclineForm({ customerName, busy, onCancel, onSubmit }: { customerName: string | null; busy: boolean; onCancel: () => void; onSubmit: (b: { approverName: string; method: ApprovalMethod; comment: string | null }) => void }) {
  const [name, setName] = useState(customerName ?? '');
  const [method, setMethod] = useState<ApprovalMethod>('IN_PERSON');
  const [comment, setComment] = useState('');
  return (
    <PanelSection title="Record that the client declined">
      <form className="mp-form" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSubmit({ approverName: name.trim(), method, comment: comment.trim() || null }); }}>
        <div className="mp-form-2">
          <Field label="Declined by"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={200} /></Field>
          <Field label="How"><Select value={method} onChange={(e) => setMethod(e.target.value as ApprovalMethod)}>{APPROVAL_METHODS.map((m) => <option key={m} value={m}>{METHOD_WORDS[m]}</option>)}</Select></Field>
        </div>
        <Field label="What they want instead"><Textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} /></Field>
        <div className="btn-row"><Button onClick={onCancel}>Back</Button><Button type="submit" variant="primary" disabled={busy || !name.trim()}>Record decline</Button></div>
      </form>
    </PanelSection>
  );
}

function AddOptionForm({ busy, onAdd }: { busy: boolean; onAdd: (b: { label: string; vendorSku: string | null; qty: number; uom: string | null; unitCostCents: number | null; markupPct: number | null; unitPriceCents: number | null; freightCents: number; leadTimeDays: number | null; isRecommended: boolean }) => Promise<unknown> }) {
  const money = useMoneyText('contract');
  const [label, setLabel] = useState('');
  const [sku, setSku] = useState('');
  const [qty, setQty] = useState('1');
  const [uom, setUom] = useState('EA');
  const [cost, setCost] = useState<number | null>(null);
  const [markup, setMarkup] = useState<number | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  const [freight, setFreight] = useState<number | null>(null);
  const [lead, setLead] = useState('');
  const [rec, setRec] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const derived = price ?? sellFromMarkup(cost, markup);
  const q = parseNum(qty);
  return (
    <form className="mp-form" style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 12 }} onSubmit={(e) => {
      e.preventDefault();
      if (!label.trim()) return setErr('Name the option.');
      if (q == null || q <= 0) return setErr('Quantity must be more than 0.');
      if (derived == null) return setErr('Give the price, or the cost and a markup.');
      setErr(null);
      void onAdd({ label: label.trim(), vendorSku: sku.trim() || null, qty: q, uom: uom.trim() || null, unitCostCents: cost, markupPct: markup, unitPriceCents: price, freightCents: freight ?? 0, leadTimeDays: parseNum(lead), isRecommended: rec })
        .then((r) => { if (r) { setLabel(''); setSku(''); setCost(null); setMarkup(null); setPrice(null); setFreight(null); setLead(''); setRec(false); } });
    }}>
      <Field label="New option" error={err ?? undefined}><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Quartz, Calacatta Laza" maxLength={120} /></Field>
      <div className="mp-form-2">
        <Field label="Quantity"><div className="row" style={{ gap: 8 }}><Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} style={{ width: 88 }} /><Input aria-label="Unit" value={uom} onChange={(e) => setUom(e.target.value)} style={{ width: 72 }} maxLength={12} /></div></Field>
        <Field label="Vendor SKU"><Input value={sku} onChange={(e) => setSku(e.target.value)} maxLength={80} /></Field>
      </div>
      <div className="mp-form-2">
        <Field label="Cost each"><MoneyInput valueCents={cost} onChangeCents={setCost} placeholder="0.00" /></Field>
        <Field label="Markup"><PctInput value={markup} onChange={setMarkup} placeholder="35" max={10000} /></Field>
      </div>
      <div className="mp-form-2">
        <Field label="Price each" help={price == null && derived != null ? `From cost and markup: ${money(derived)}` : 'Blank uses cost and markup'}><MoneyInput valueCents={price} onChangeCents={setPrice} placeholder={derived != null ? money(derived) : '0.00'} /></Field>
        <Field label="Freight"><MoneyInput valueCents={freight} onChangeCents={setFreight} placeholder="0.00" /></Field>
      </div>
      <div className="mp-form-2">
        <Field label="Lead time (days)"><Input inputMode="numeric" value={lead} onChange={(e) => setLead(e.target.value)} /></Field>
        <Check label="Recommend it" checked={rec} onChange={(e) => setRec(e.target.checked)} />
      </div>
      {derived != null && q != null && q > 0 && <p className="t-cap">The client pays {money(lineAmount(q, derived))}.</p>}
      <div><Button type="submit" icon="plus" disabled={busy}>Add option</Button></div>
    </form>
  );
}

function EditTerms({ id, allowance, due, busy, onSave }: { id: string; allowance: number | null; due: string | null; busy: boolean; onSave: (b: { allowanceCents?: number | null; dueOn?: string | null }) => void }) {
  const [a, setA] = useState<number | null>(allowance);
  const [d, setD] = useState(due ?? '');
  useEffect(() => { setA(allowance); setD(due ?? ''); }, [id, allowance, due]);
  return (
    <PanelSection title="Allowance and due date">
      <form className="row" style={{ gap: 8, alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); onSave({ allowanceCents: a, dueOn: d || null }); }}>
        <Field label="Allowance"><MoneyInput valueCents={a} onChangeCents={setA} placeholder="None" style={{ width: 140 }} /></Field>
        <Field label="Client decides by"><Input type="date" value={d} onChange={(e) => setD(e.target.value)} /></Field>
        <Button type="submit" disabled={busy || (a === allowance && (d || null) === due)}>Save</Button>
      </form>
    </PanelSection>
  );
}
