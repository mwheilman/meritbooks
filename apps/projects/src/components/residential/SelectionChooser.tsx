'use client';

import { useState } from 'react';
import { AppLink, Button, Check, Dialog, Field, InlineNotice, Input, KV, Select, Tag, WidgetState, money, shortDate } from '@meritbooks/merit-ui';
import type { ChooseResult, SelectionPreview } from '@/lib/residential/types';
import { METHOD_WORDS, allowanceDeltaWords } from '@/lib/residential/labels';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { useOps } from '@/components/ops/common/useOps';

type Option = SelectionPreview['options'][number];

export function SelectionChooser({ preview: s, today, canApprove }: { preview: SelectionPreview; today: string; canApprove: boolean }) {
  const { readOnly } = useShell();
  const [pick, setPick] = useState<Option | null>(null);
  const [result, setResult] = useState<ChooseResult | null>(null);
  const decided = s.status === 'APPROVED' || s.status === 'VOID';
  return (
    <div className="stack">
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        {s.at_risk && !decided && <Tag tone="neg">Decide now — the install date is close</Tag>}
        {s.shared && <Tag>Shares an allowance</Tag>}
        {decided && <Tag tone="pos">{s.status === 'APPROVED' ? 'Decided' : 'Void'}</Tag>}
      </div>
      <Section title="Allowance">
        <KV items={[
          { term: 'Allowance', value: !s.money_visible ? '—' : s.allowance_cents == null ? 'None' : money(s.allowance_cents) },
          ...(s.shared && s.money_visible ? [{ term: 'Used by other choices', value: money(s.used_by_others_cents ?? 0) }, { term: 'Left for this one', value: money(s.remaining_cents ?? 0) }] : []),
          { term: 'Decide by', value: s.needed_by_on ? shortDate(s.needed_by_on, today) : s.due_on ? shortDate(s.due_on, today) : '—' },
          ...(s.room ? [{ term: 'Room', value: s.room }] : []),
        ]} />
        {s.needed_by_on && <p className="t-cap" style={{ marginTop: 6 }}>The date is the install date less the slowest lead time, so the order arrives before the crew does.</p>}
      </Section>
      {result && <ChoiceResult r={result} />}
      {s.options.length === 0 ? (
        <WidgetState state={{ kind: 'empty', title: 'No options to choose from yet', body: 'Add options on the Selections page (vendor, SKU, lead time, price); they show here with what each does to the allowance.', action: <AppLink href={`/selections?selection=${s.selection_id}`}>Open in Selections</AppLink> }} />
      ) : (
        <div className="res-cards" style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
          {s.options.map((o) => {
            const d = allowanceDeltaWords(o, s.money_visible, money);
            const late = !!o.needed_by_on && o.needed_by_on < today;
            return (
              <article key={o.id} className="card" style={{ border: '1px solid var(--line)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {o.image_url && <img src={o.image_url} alt={o.label} loading="lazy" style={{ width: '100%', aspectRatio: '4 / 3', objectFit: 'cover' }} />}
                <div className="row" style={{ gap: 8 }}><h3 className="t-section" style={{ margin: 0 }}>{o.label}</h3>{o.is_recommended && <Tag tone="ai">Recommended</Tag>}</div>
                {o.description && <p className="t-cap" style={{ margin: 0 }}>{o.description}</p>}
                <KV items={[
                  ...(s.money_visible && o.amount_cents != null ? [{ term: 'Price', value: money(o.amount_cents) }] : []),
                  ...(o.finish ? [{ term: 'Finish', value: o.finish }] : []),
                  ...(o.vendor_sku ? [{ term: 'SKU', value: o.vendor_sku }] : []),
                  ...(o.lead_time_days != null ? [{ term: 'Lead time', value: `${o.lead_time_days} days` }] : []),
                  ...(o.needed_by_on ? [{ term: 'Order by', value: <span className={late ? 'neg b' : undefined}>{shortDate(o.needed_by_on, today)}</span> }] : []),
                ]} />
                {d.text && <p className={d.tone === 'neg' ? 'neg b' : 't-cap'} style={{ margin: 0 }}>{d.text}</p>}
                {o.vendor_url && <a href={o.vendor_url} target="_blank" rel="noopener noreferrer" className="t-cap">See it on the supplier’s site</a>}
                <span style={{ flex: 1 }} />
                {!decided && canApprove && !readOnly && <Button variant="primary" onClick={() => setPick(o)}>Choose this</Button>}
              </article>
            );
          })}
        </div>
      )}
      {pick && <ChooseDialog selectionId={s.selection_id} option={pick} moneyVisible={s.money_visible} onClose={() => setPick(null)} onDone={(r) => { setResult(r); setPick(null); }} />}
    </div>
  );
}

function ChooseDialog({ selectionId, option, moneyVisible, onClose, onDone }: { selectionId: string; option: Option; moneyVisible: boolean; onClose: () => void; onDone: (r: ChooseResult) => void }) {
  const { act, busy, error } = useOps();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [method, setMethod] = useState<'IN_PERSON' | 'PORTAL' | 'EMAIL' | 'PHONE'>('IN_PERSON');
  const [billing, setBilling] = useState<'UPFRONT' | 'NEXT_MILESTONE'>('UPFRONT');
  const [po, setPo] = useState(true);
  const over = (option.over_cents ?? 0) > 0;
  const go = async () => {
    if (!name.trim()) return;
    const r = await act<ChooseResult>('choose', 'post', `/api/residential/selections/${selectionId}`, {
      optionId: option.id, approverName: name.trim(), method, approverEmail: email.trim() || null, overageBilling: over ? billing : null, createPo: po,
    }, (d) => (d.change_order_id ? 'Chosen — allowance change order signed' : 'Chosen'));
    if (r) onDone(r);
  };
  return (
    <Dialog open onClose={onClose} title={`Choose ${option.label}`} dismissOnScrim={false}
      footNote={over ? 'The homeowner’s approval here is their signature on the allowance change order.' : undefined}
      actions={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name.trim() || busy === 'choose'} onClick={() => void go()}>Record the choice</Button></>}>
      <div className="mp-form">
        {over && moneyVisible && <InlineNotice tone="warn" title={`${money(option.over_cents ?? 0)} over the allowance`}>Choosing this creates an allowance change order for the difference.</InlineNotice>}
        <Field label="Homeowner who chose it"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoFocus /></Field>
        <div className="mp-form-2">
          <Field label="How"><Select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>{(['IN_PERSON', 'PORTAL', 'EMAIL', 'PHONE'] as const).map((m) => <option key={m} value={m}>{METHOD_WORDS[m]}</option>)}</Select></Field>
          <Field label="Their email (for the record)"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} /></Field>
        </div>
        {over && (
          <Field label="Bill the overage">
            <Select value={billing} onChange={(e) => setBilling(e.target.value as typeof billing)}>
              <option value="UPFRONT">Now — a deposit request before ordering</option>
              <option value="NEXT_MILESTONE">With the next milestone payment</option>
            </Select>
          </Field>
        )}
        <Check checked={po} onChange={(e) => setPo(e.target.checked)} label="Draft the purchase order to the vendor" />
        <Failure text={error} />
      </div>
    </Dialog>
  );
}

function ChoiceResult({ r }: { r: ChooseResult }) {
  const steps = [
    'Approval recorded',
    r.change_order_id ? (r.change_order_state === 'approved' ? 'Allowance change order signed and approved' : 'Allowance change order signed; waiting on internal approval') : null,
    r.deposit_request_id ? 'Deposit requested for the overage' : r.overage_billing === 'NEXT_MILESTONE' ? 'Overage added to the next milestone' : null,
    r.commitment_id ? 'Draft purchase order to the vendor' : null,
    r.procurement_item_id ? 'Added to purchasing' : null,
    r.vendor_deposit_id ? 'Vendor deposit requested (special order)' : null,
    r.delivery_task_id ? 'Delivery placed on the schedule' : null,
  ].filter((x): x is string => !!x);
  return (
    <InlineNotice tone="info" title="Done">
      <ul style={{ margin: '4px 0 0 18px' }}>{steps.map((s) => <li key={s}>{s}</li>)}</ul>
      {r.under_cents > 0 && <p style={{ margin: '6px 0 0' }}>{money(r.under_cents)} under the allowance: credited when the allowance is reconciled.</p>}
      {r.warnings.length > 0 && <ul style={{ margin: '6px 0 0 18px' }}>{r.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
    </InlineNotice>
  );
}
