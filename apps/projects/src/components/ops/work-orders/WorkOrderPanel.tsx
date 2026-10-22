'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Button, ButtonLink, Check, ConfirmDialog, Field, Input, KV, MoneyInput, Panel, PanelSection, Select, Tag, Textarea, money, shortDate,
} from '@meritbooks/merit-ui';
import { durationText, localParts, clockOf } from '@/lib/pm/ops/dispatch-math';
import {
  ASSIGNMENT_STATUS, CLAIM_NEXT, CLAIM_STATUS, HISTORY_WORDS, LINE_KIND_WORDS, OUTCOME_WORDS, WO_STATUS, claimOutstanding,
  priorityWord, woKindLabel, woVocab,
} from '@/lib/pm/ops/labels';
import { WO_OUTCOMES, type ClaimStatus, type LineKind, type LookupItem, type WarrantyClaimRow, type WoLineRow, type WoOutcome } from '@/lib/pm/ops/types';
import type { WorkOrderDetail } from '@/lib/pm/ops/field-queries';
import { useShell, useVocab } from '@/components/shell/ShellContext';
import { lower } from '@/lib/pm/vocab';
import { DetailState, Failure, StatusMark, parseNum } from '../common/bits';
import { Lookup } from '../common/Lookup';
import { useDetail, useOps } from '../common/useOps';
import { RoLineEditor } from '@/components/dealer/service/RoLineEditor';

type Detail = WorkOrderDetail & { employees: Record<string, string>; customers: Record<string, string> };

export interface WorkOrderPanelProps {
  id: string;
  jobLabel: string | null;
  customerName: string | null;
  tz: string;
  today: string;
  skillNames: Record<string, string>;
  /** Equipment dealer: show the warranty claim section on every repair order. */
  dealer: boolean;
  onClose: () => void;
}

const LINE_KINDS: LineKind[] = ['SERVICE', 'PART', 'LABOR', 'EQUIPMENT', 'FEE', 'DISCOUNT', 'SUBLET', 'FREIGHT'];

function when(iso: string | null, tz: string, today: string): string | null {
  if (!iso) return null;
  const l = localParts(iso, tz);
  return `${l.day === today ? 'Today' : shortDate(l.day, today)} ${clockOf(l.minutes)}`;
}

export function WorkOrderPanel(p: WorkOrderPanelProps) {
  const v = useVocab();
  const wv = woVocab(v);
  const { readOnly } = useShell();
  const { act, busy, version, error } = useOps();
  const { data, error: loadError, isLoading, refetch } = useDetail<Detail>(`/api/ops/work-orders/${p.id}`, version);
  const [mode, setMode] = useState<'none' | 'complete' | 'hold'>('none');
  const [cancelOpen, setCancelOpen] = useState(false);
  const url = `/api/ops/work-orders/${p.id}`;

  useEffect(() => setMode('none'), [p.id]);

  if (!data) {
    return (
      <Panel eyebrow={wv.one} title="Loading" onClose={p.onClose}>
        <PanelSection><DetailState loading={isLoading} error={loadError} onRetry={() => void refetch()} what={wv.one} /></PanelSection>
      </Panel>
    );
  }
  const o = data.order;
  const st = o.status;
  const open = st !== 'COMPLETE' && st !== 'CLOSED' && st !== 'CANCELLED';
  const linesLocked = st === 'CLOSED' || st === 'CANCELLED';
  const isRo = o.kind === 'REPAIR_ORDER';
  const live = data.assignments.filter((a) => a.status !== 'CANCELLED');
  const techs = [...new Set(live.map((a) => (a.employee_id ? data.employees[a.employee_id] : null)).filter(Boolean))];

  return (
    <Panel
      eyebrow={[o.number ?? wv.one, woKindLabel(o.kind, v)]}
      title={o.summary}
      meta={[p.jobLabel, p.customerName].filter(Boolean).join(' · ')}
      onClose={p.onClose}
      foot={
        readOnly ? undefined : (
          <div className="btn-row" style={{ width: '100%' }}>
            {(st === 'NEW' || st === 'ON_HOLD') && <ButtonLink href={`/dispatch?wo=${o.id}`}>Schedule</ButtonLink>}
            {(st === 'SCHEDULED' || st === 'DISPATCHED') && <ButtonLink href={`/dispatch?wo=${o.id}${o.scheduled_start ? `&day=${localParts(o.scheduled_start, p.tz).day}` : ''}`}>Reschedule</ButtonLink>}
            {(st === 'SCHEDULED' || st === 'DISPATCHED' || st === 'IN_PROGRESS') && <Button onClick={() => setMode(mode === 'hold' ? 'none' : 'hold')}>Hold</Button>}
            {open && <Button variant="quiet" onClick={() => setCancelOpen(true)}>Cancel</Button>}
            <span className="sp" />
            {(st === 'NEW' || st === 'SCHEDULED' || st === 'DISPATCHED' || st === 'ON_HOLD') && (
              <Button disabled={busy === 'start'} onClick={() => void act('start', 'post', url, { op: 'start' }, `Started ${o.number}`)}>Start</Button>
            )}
            {open && <Button variant="primary" onClick={() => setMode('complete')}>Complete</Button>}
            {st === 'COMPLETE' && <Button variant="primary" disabled={busy === 'close'} onClick={() => void act('close', 'post', url, { op: 'close' }, `Closed ${o.number}`)}>Close</Button>}
          </div>
        )
      }
    >
      <PanelSection>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <StatusMark mark={WO_STATUS[st]} />
          {o.is_callback && <Tag tone="warn">Callback</Tag>}
          {o.follow_up_required && <Tag tone="warn">Follow-up needed</Tag>}
          {o.outcome && <Tag>{OUTCOME_WORDS[o.outcome]}</Tag>}
        </div>
        {st === 'ON_HOLD' && o.hold_reason && <p className="t-cap" style={{ marginTop: 8 }}>On hold: {o.hold_reason}</p>}
        <div style={{ marginTop: 12 }}>
          <KV
            items={[
              { term: 'Priority', value: priorityWord(o.priority) },
              ...(o.scheduled_start ? [{ term: 'Scheduled', value: `${when(o.scheduled_start, p.tz, p.today)}${o.scheduled_end ? ` to ${clockOf(localParts(o.scheduled_end, p.tz).minutes)}` : ''}` }] : []),
              ...(techs.length ? [{ term: techs.length > 1 ? 'Technicians' : 'Technician', value: techs.join(', ') }] : []),
              ...(o.requested_start ? [{ term: 'Customer window', value: `${when(o.requested_start, p.tz, p.today)}${o.requested_end ? ` to ${clockOf(localParts(o.requested_end, p.tz).minutes)}` : ''}` }] : []),
              ...(o.due_on ? [{ term: 'Due', value: `${shortDate(o.due_on, p.today)}${o.due_by && o.due_by !== o.due_on ? ` to ${shortDate(o.due_by, p.today)}` : ''}` }] : []),
              ...(o.estimated_minutes ? [{ term: 'Estimate', value: durationText(o.estimated_minutes) }] : []),
              ...(o.required_skills?.length ? [{ term: 'Needs', value: o.required_skills.map((s) => p.skillNames[s] ?? s).join(', ') }] : []),
              ...(o.payer_type !== 'CUSTOMER' ? [{ term: 'Paid by', value: o.payer_type === 'OEM' ? `Manufacturer${o.payer_customer_id ? ` · ${data.customers[o.payer_customer_id] ?? ''}` : ''}` : o.payer_type === 'INTERNAL' ? 'Internal' : 'Third party' }] : []),
              ...(isRo && o.checked_in_at ? [{ term: 'Checked in', value: when(o.checked_in_at, p.tz, p.today) ?? '' }] : []),
              ...(isRo && o.promised_on ? [{ term: 'Promised', value: shortDate(o.promised_on, p.today) }] : []),
              ...(o.meter_in != null ? [{ term: 'Meter in', value: String(o.meter_in) }] : []),
              ...(o.meter_out != null ? [{ term: 'Meter out', value: String(o.meter_out) }] : []),
            ]}
          />
        </div>
        {error && <div style={{ marginTop: 12 }}><Failure text={error} /></div>}
      </PanelSection>

      {mode === 'complete' && !readOnly && <CompleteForm isRo={isRo} busy={busy === 'complete'} onCancel={() => setMode('none')} onSubmit={async (b) => { const r = await act('complete', 'post', url, { op: 'complete', ...b }, `Completed ${o.number}`); if (r) setMode('none'); }} />}
      {mode === 'hold' && !readOnly && <HoldForm busy={busy === 'hold'} onCancel={() => setMode('none')} onSubmit={async (reason) => { const r = await act('hold', 'post', url, { op: 'hold', reason }, `${o.number} on hold`); if (r) setMode('none'); }} />}

      <ThreeCs order={o} readOnly={readOnly || linesLocked} isRo={isRo} onSave={(patch, label) => void act('edit', 'post', url, { op: 'update', ...patch }, label)} />

      {p.dealer && (isRo || o.kind === 'PDI') ? (
        <RoLineEditor workOrderId={o.id} locked={readOnly || linesLocked} onChanged={() => void refetch()} />
      ) : (
      <Lines
        lines={data.lines}
        locked={readOnly || linesLocked}
        companyId={o.location_id}
        isRo={isRo}
        busy={busy}
        onAdd={(b) => act('line', 'post', url, { op: 'add_line', ...b }, b.proposed ? 'Added the option' : 'Added the line')}
        onRemove={(l) => void act(`rm:${l.id}`, 'post', url, { op: 'remove_line', lineId: l.id }, 'Removed the line')}
        onDecide={(approve, decline, customerName) => act('decide', 'post', url, { op: 'decide', approve, decline, customerName }, `Recorded ${customerName || 'the customer'}’s choice`)}
      />
      )}

      {(isRo || p.dealer || o.payer_type === 'OEM' || data.claims.length > 0) && (
        <Claims
          claims={data.claims}
          workOrderId={o.id}
          defaultPayer={o.payer_customer_id ? { id: o.payer_customer_id, label: data.customers[o.payer_customer_id] ?? 'Manufacturer' } : null}
          names={data.customers}
          readOnly={readOnly}
          busy={busy}
          act={act}
        />
      )}

      {data.asset && (
        <PanelSection title="Equipment">
          <p className="b">{[data.asset.make, data.asset.model].filter(Boolean).join(' ') || data.asset.description || 'Equipment'}</p>
          <p className="t-cap">{[data.asset.serial_number ? `Serial ${data.asset.serial_number}` : null, data.asset.installed_on ? `installed ${shortDate(data.asset.installed_on, p.today)}` : null, data.asset.warranty_expires_on ? `warranty to ${shortDate(data.asset.warranty_expires_on, p.today)}` : null].filter(Boolean).join(' · ')}</p>
          {data.history.length > 0 && (
            <ul className="feed feed--flush" style={{ marginTop: 8 }}>
              {data.history.map((h) => (
                <li key={h.history_id}>
                  <span><span className="l1" style={{ fontWeight: 400 }}>{HISTORY_WORDS[h.kind]}{h.summary ? `: ${h.summary}` : ''}</span>{h.work_order_number && <span className="l2">{h.work_order_number}</span>}</span>
                  <span className="t">{shortDate(h.performed_on, p.today)}</span>
                </li>
              ))}
            </ul>
          )}
          <p style={{ marginTop: 8 }}><Link className="link" href={`/assets?asset=${data.asset.id}`}>Full service history</Link></p>
        </PanelSection>
      )}

      {data.assignments.length > 0 && (
        <PanelSection title="Visits on the board">
          <ul className="feed feed--flush">
            {data.assignments.map((a) => (
              <li key={a.id}>
                <span className="l1" style={{ fontWeight: 400 }}>{(a.employee_id && data.employees[a.employee_id]) || 'Crew'} · {ASSIGNMENT_STATUS[a.status].word}</span>
                <span className="t">{a.arrived_at ? `arrived ${when(a.arrived_at, p.tz, p.today)}` : a.dispatched_at ? `dispatched ${when(a.dispatched_at, p.tz, p.today)}` : ''}</span>
              </li>
            ))}
          </ul>
        </PanelSection>
      )}

      <ConfirmDialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        tone="danger"
        title={`Cancel ${o.number ?? lower(wv.one)}`}
        confirmLabel={`Cancel ${o.number ?? lower(wv.one)}`}
        cancelLabel="Keep it"
        reason={{ label: 'Why', placeholder: 'Customer rescheduled with another company', minLength: 0 }}
        onConfirm={async (reason) => {
          const r = await act('cancel', 'post', url, { op: 'cancel', reason: reason || null }, `Cancelled ${o.number}`);
          if (!r) throw new Error('Not cancelled.');
        }}
      >
        Its technicians come off the board. The record stays, marked cancelled.
      </ConfirmDialog>
    </Panel>
  );
}

function CompleteForm({ isRo, busy, onCancel, onSubmit }: { isRo: boolean; busy: boolean; onCancel: () => void; onSubmit: (b: { outcome: WoOutcome; resolution: string | null; isCallback: boolean; followUp: boolean; meterOut: number | null }) => void }) {
  const [outcome, setOutcome] = useState<WoOutcome>('FIXED');
  const [resolution, setResolution] = useState('');
  const [callback, setCallback] = useState(false);
  const [followUp, setFollowUp] = useState(false);
  const [meter, setMeter] = useState('');
  return (
    <PanelSection title="Complete">
      <form className="mp-form" onSubmit={(e) => { e.preventDefault(); onSubmit({ outcome, resolution: resolution.trim() || null, isCallback: callback, followUp: followUp || outcome === 'NEEDS_PARTS' || outcome === 'NEEDS_QUOTE', meterOut: parseNum(meter) }); }}>
        <Field label="Outcome">
          <Select value={outcome} onChange={(e) => setOutcome(e.target.value as WoOutcome)} autoFocus>
            {WO_OUTCOMES.map((x) => <option key={x} value={x}>{OUTCOME_WORDS[x]}</option>)}
          </Select>
        </Field>
        <Field label={isRo ? 'Correction' : 'What was done'}><Textarea value={resolution} onChange={(e) => setResolution(e.target.value)} maxLength={4000} placeholder="Replaced the run capacitor; system cooling at 18° split" /></Field>
        <Check label="This is a callback on earlier work" checked={callback} onChange={(e) => setCallback(e.target.checked)} />
        <Check label="Needs a return visit" checked={followUp} onChange={(e) => setFollowUp(e.target.checked)} />
        {isRo && <Field label="Meter out"><Input inputMode="decimal" value={meter} onChange={(e) => setMeter(e.target.value)} style={{ width: 140 }} /></Field>}
        <p className="t-cap">Callbacks link to the completed visit on the same equipment, job or address from the last 30 days.</p>
        <div className="btn-row"><Button onClick={onCancel}>Back</Button><Button type="submit" variant="primary" disabled={busy}>Mark complete</Button></div>
      </form>
    </PanelSection>
  );
}

function HoldForm({ busy, onCancel, onSubmit }: { busy: boolean; onCancel: () => void; onSubmit: (reason: string | null) => void }) {
  const [reason, setReason] = useState('');
  return (
    <PanelSection title="Put on hold">
      <form className="mp-form" onSubmit={(e) => { e.preventDefault(); onSubmit(reason.trim() || null); }}>
        <Field label="Waiting on"><Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Parts: condenser fan motor" maxLength={300} /></Field>
        <p className="t-cap">It goes back to the unassigned list so it can be rebooked when the reason clears.</p>
        <div className="btn-row"><Button onClick={onCancel}>Back</Button><Button type="submit" variant="primary" disabled={busy}>Put on hold</Button></div>
      </form>
    </PanelSection>
  );
}

function ThreeCs({ order, readOnly, isRo, onSave }: { order: Detail['order']; readOnly: boolean; isRo: boolean; onSave: (patch: Record<string, string | null>, label: string) => void }) {
  const fields: Array<{ key: 'complaint' | 'cause' | 'resolution'; label: string }> = isRo
    ? [{ key: 'complaint', label: 'Complaint' }, { key: 'cause', label: 'Cause' }, { key: 'resolution', label: 'Correction' }]
    : [{ key: 'complaint', label: 'What the customer reported' }, { key: 'resolution', label: 'What was done' }];
  const [vals, setVals] = useState({ complaint: order.complaint ?? '', cause: order.cause ?? '', resolution: order.resolution ?? '' });
  useEffect(() => setVals({ complaint: order.complaint ?? '', cause: order.cause ?? '', resolution: order.resolution ?? '' }), [order.id, order.complaint, order.cause, order.resolution]);
  if (readOnly && !fields.some((f) => order[f.key])) return null;
  return (
    <PanelSection title={isRo ? 'Complaint, cause, correction' : 'Notes'}>
      <div className="mp-form">
        {fields.map((f) =>
          readOnly ? (
            order[f.key] ? <div key={f.key}><span className="t-cap">{f.label}</span><p>{order[f.key]}</p></div> : null
          ) : (
            <Field key={f.key} label={f.label}>
              <Textarea value={vals[f.key]} maxLength={4000} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}
                onBlur={() => { if (vals[f.key] !== (order[f.key] ?? '')) onSave({ [f.key]: vals[f.key].trim() || null }, `Saved the ${f.label.toLowerCase()}`); }} />
            </Field>
          ),
        )}
      </div>
    </PanelSection>
  );
}

interface AddLine { kind: LineKind; priceBookItemId: string | null; description: string | null; qty: number; unitPriceCents: number | null; payType: 'CUSTOMER' | 'WARRANTY' | 'INTERNAL'; optionGroup: string | null; proposed: boolean; flagHours: number | null }

function Lines({ lines, locked, companyId, isRo, busy, onAdd, onRemove, onDecide }: {
  lines: WoLineRow[]; locked: boolean; companyId: string; isRo: boolean; busy: string | null;
  onAdd: (b: AddLine) => Promise<unknown>; onRemove: (l: WoLineRow) => void; onDecide: (approve: string[], decline: string[], customerName: string) => Promise<unknown>;
}) {
  const sold = lines.filter((l) => l.status === 'APPROVED');
  const proposed = lines.filter((l) => l.status === 'PROPOSED');
  const declined = lines.filter((l) => l.status === 'DECLINED');
  const groups = useMemo(() => {
    const m = new Map<string, WoLineRow[]>();
    for (const l of proposed) m.set(l.option_group ?? 'Options', [...(m.get(l.option_group ?? 'Options') ?? []), l]);
    return [...m.entries()];
  }, [proposed]);
  const customerTotal = sold.filter((l) => l.pay_type === 'CUSTOMER').reduce((s, l) => s + l.amount_cents, 0);
  const warrantyTotal = sold.filter((l) => l.pay_type === 'WARRANTY').reduce((s, l) => s + l.amount_cents, 0);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [customer, setCustomer] = useState('');

  return (
    <PanelSection title={isRo ? 'Lines' : 'Price book lines'} meta={`${money(customerTotal)} customer pay${warrantyTotal ? ` · ${money(warrantyTotal)} warranty` : ''}`}>
      {sold.length === 0 && proposed.length === 0 ? (
        <p className="t-cap">No lines yet. Add flat-rate tasks and parts from the price book; prices are pinned when added.</p>
      ) : (
        <table className="ops-mini">
          <thead><tr><th>Line</th><th className="n">Qty</th><th className="n">Amount</th>{!locked && <th><span className="sr">Remove</span></th>}</tr></thead>
          <tbody>
            {sold.map((l) => (
              <tr key={l.id}>
                <td>
                  <span className="l1">{l.description}</span>
                  <span className="l2">{[LINE_KIND_WORDS[l.kind], l.pay_type !== 'CUSTOMER' ? (l.pay_type === 'WARRANTY' ? 'warranty' : 'internal') : null, l.price_overridden ? 'price changed' : null, l.flag_hours ? `${l.flag_hours} flag hours` : null, l.decided_by_name ? `chosen by ${l.decided_by_name}` : null].filter(Boolean).join(' · ')}</span>
                </td>
                <td className="n">{l.qty} {l.uom}</td>
                <td className="n">{money(l.amount_cents)}</td>
                {!locked && <td><Button variant="quiet" iconOnly icon="x" aria-label={`Remove ${l.description}`} disabled={busy === `rm:${l.id}`} onClick={() => onRemove(l)} /></td>}
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td>Sold total</td><td /><td className="n">{money(sold.reduce((s, l) => s + l.amount_cents, 0))}</td>{!locked && <td />}</tr></tfoot>
        </table>
      )}

      {groups.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <p className="t-section" style={{ marginBottom: 8 }}>Options for the customer</p>
          {groups.map(([g, ls]) => (
            <fieldset key={g} style={{ border: '1px solid var(--line)', padding: 12, marginBottom: 8 }}>
              <legend className="b" style={{ padding: '0 4px' }}>{g}</legend>
              {ls.map((l) => (
                <label key={l.id} className="row" style={{ gap: 8, padding: '4px 0', alignItems: 'baseline' }}>
                  <input type="radio" name={`opt-${g}`} value={l.id} checked={pick[g] === l.id} disabled={locked} onChange={() => setPick({ ...pick, [g]: l.id })} />
                  <span style={{ flex: 1 }}>{l.description}</span>
                  <span className="tnum">{money(l.amount_cents)}</span>
                </label>
              ))}
              <label className="row" style={{ gap: 8, padding: '4px 0' }}>
                <input type="radio" name={`opt-${g}`} value="" checked={pick[g] === '-'} disabled={locked} onChange={() => setPick({ ...pick, [g]: '-' })} />
                <span>Customer declined all of these</span>
              </label>
            </fieldset>
          ))}
          {!locked && (
            <form className="row" style={{ gap: 8, alignItems: 'flex-end' }} onSubmit={(e) => {
              e.preventDefault();
              const approve: string[] = [];
              const decline: string[] = [];
              for (const [g, ls] of groups) {
                const choice = pick[g];
                if (!choice) continue;
                for (const l of ls) (l.id === choice ? approve : decline).push(l.id);
              }
              void onDecide(approve, decline, customer.trim()).then((r) => { if (r) { setPick({}); } });
            }}>
              <Field label="Customer name"><Input value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="Who chose" maxLength={200} /></Field>
              <Button type="submit" variant="primary" disabled={busy === 'decide' || Object.keys(pick).length === 0}>Record the choice</Button>
            </form>
          )}
        </div>
      )}
      {declined.length > 0 && <p className="t-cap" style={{ marginTop: 8 }}>{declined.length} declined option{declined.length === 1 ? '' : 's'}: {declined.map((l) => l.description).join(', ')}</p>}

      {!locked && <AddLineForm companyId={companyId} isRo={isRo} busy={busy === 'line'} onAdd={onAdd} />}
    </PanelSection>
  );
}

function AddLineForm({ companyId, isRo, busy, onAdd }: { companyId: string; isRo: boolean; busy: boolean; onAdd: (b: AddLine) => Promise<unknown> }) {
  const [item, setItem] = useState<LookupItem | null>(null);
  const [desc, setDesc] = useState('');
  const [kind, setKind] = useState<LineKind>('SERVICE');
  const [qty, setQty] = useState('1');
  const [price, setPrice] = useState<number | null>(null);
  const [payType, setPayType] = useState<'CUSTOMER' | 'WARRANTY' | 'INTERNAL'>('CUSTOMER');
  const [group, setGroup] = useState('');
  const [flag, setFlag] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    const q = parseNum(qty);
    if (!item && !desc.trim()) return setErr('Pick a price book item or describe the line.');
    if (q == null || q <= 0) return setErr('Quantity must be more than 0.');
    setErr(null);
    const ok = await onAdd({ kind, priceBookItemId: item?.id ?? null, description: desc.trim() || null, qty: q, unitPriceCents: price, payType, optionGroup: group.trim() || null, proposed: !!group.trim(), flagHours: parseNum(flag) });
    if (ok) { setItem(null); setDesc(''); setQty('1'); setPrice(null); setFlag(''); }
  };

  return (
    <form className="mp-form" style={{ marginTop: 16, borderTop: '1px solid var(--line)', paddingTop: 12 }} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <Field label="From the price book" error={err ?? undefined}>
        <Lookup kind="price_book" companyId={companyId} value={item ? { id: item.id, label: item.label } : null} onChange={(it) => { setItem(it); if (it?.priceCents != null) setPrice(null); }} placeholder="Search tasks and parts by name or code" />
      </Field>
      {item ? (
        <p className="t-cap">{item.sub} · {money(item.priceCents ?? 0)} per {item.unit ?? 'each'}{item.laborMinutes ? ` · ${durationText(item.laborMinutes)} labor` : ''}</p>
      ) : (
        <Field label="Or describe it"><Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Diagnostic fee" maxLength={300} /></Field>
      )}
      <div className="mp-form-2">
        <Field label="Kind">
          <Select value={kind} onChange={(e) => setKind(e.target.value as LineKind)}>{LINE_KINDS.map((k) => <option key={k} value={k}>{LINE_KIND_WORDS[k]}</option>)}</Select>
        </Field>
        <Field label="Quantity"><Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
      </div>
      <div className="mp-form-2">
        <Field label={item ? 'Price each (blank keeps the book price)' : 'Price each'}><MoneyInput valueCents={price} onChangeCents={setPrice} allowNegative={kind === 'DISCOUNT'} placeholder={item?.priceCents != null ? money(item.priceCents) : '0.00'} /></Field>
        <Field label="Who pays">
          <Select value={payType} onChange={(e) => setPayType(e.target.value as typeof payType)}>
            <option value="CUSTOMER">Customer</option>
            <option value="WARRANTY">Warranty</option>
            <option value="INTERNAL">Internal</option>
          </Select>
        </Field>
      </div>
      <div className="mp-form-2">
        <Field label="Offer as an option" help="Same group name = good / better / best choices"><Input value={group} onChange={(e) => setGroup(e.target.value)} placeholder="Replace the system" maxLength={60} /></Field>
        {isRo && kind === 'LABOR' ? <Field label="Flag hours"><Input inputMode="decimal" value={flag} onChange={(e) => setFlag(e.target.value)} /></Field> : <span />}
      </div>
      <div><Button type="submit" icon="plus" disabled={busy}>{group.trim() ? 'Add option' : 'Add line'}</Button></div>
    </form>
  );
}

function Claims({ claims, workOrderId, defaultPayer, names, readOnly, busy, act }: {
  claims: WarrantyClaimRow[]; workOrderId: string; defaultPayer: { id: string; label: string } | null; names: Record<string, string>; readOnly: boolean; busy: string | null;
  act: ReturnType<typeof useOps>['act'];
}) {
  const [adding, setAdding] = useState(false);
  const [payer, setPayer] = useState<{ id: string; label: string } | null>(defaultPayer);
  const [labor, setLabor] = useState<number | null>(null);
  const [parts, setParts] = useState<number | null>(null);
  const [other, setOther] = useState<number | null>(null);
  const [failure, setFailure] = useState('');
  const [deadline, setDeadline] = useState('');
  const [amount, setAmount] = useState<Record<string, number | null>>({});
  const outstanding = claims.reduce((s, c) => s + claimOutstanding(c), 0);

  return (
    <PanelSection title="Warranty claims" meta={outstanding ? `${money(outstanding)} outstanding` : claims.length ? 'Nothing outstanding' : undefined}>
      {claims.length === 0 && <p className="t-cap">No claims on this repair order. File one for warranty lines; the manufacturer is billed as a customer in Merit Books.</p>}
      {claims.map((c) => {
        const next = CLAIM_NEXT[c.status];
        const needsAmount = (to: ClaimStatus) => to === 'APPROVED' || to === 'PAID';
        return (
          <div key={c.id} style={{ borderBottom: '1px solid var(--line)', padding: '8px 0' }}>
            <div className="row row--between">
              <span className="b">{c.claim_number ?? 'Claim'} · {names[c.payer_customer_id] ?? 'Manufacturer'}</span>
              <StatusMark mark={CLAIM_STATUS[c.status]} />
            </div>
            <div className="ops-facts" style={{ marginTop: 4 }}>
              <span>Claimed <b className="tnum">{money(c.claimed_cents)}</b></span>
              {c.approved_cents != null && <span>Approved <b className="tnum">{money(c.approved_cents)}</b></span>}
              {c.paid_cents > 0 && <span>Paid <b className="tnum">{money(c.paid_cents)}</b></span>}
              {claimOutstanding(c) > 0 && <span>Outstanding <b className="tnum">{money(claimOutstanding(c))}</b></span>}
              {c.filing_deadline && c.status === 'DRAFT' && <span>File by <b>{shortDate(c.filing_deadline)}</b></span>}
            </div>
            {c.decision_reason && <p className="t-cap">{c.decision_reason}</p>}
            {!readOnly && next.length > 0 && (
              <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                {next.some(needsAmount) && (
                  <Field label="Amount"><MoneyInput valueCents={amount[c.id] ?? null} onChangeCents={(x) => setAmount({ ...amount, [c.id]: x })} placeholder={money(c.approved_cents ?? c.claimed_cents)} style={{ width: 128 }} /></Field>
                )}
                {next.map((to) => (
                  <Button key={to} variant={to === next[0] ? 'primary' : 'default'} disabled={busy === `claim:${c.id}`}
                    onClick={() => void act(`claim:${c.id}`, 'post', `/api/ops/claims/${c.id}`, { op: 'advance', to, amountCents: needsAmount(to) ? amount[c.id] ?? null : null }, `Claim ${CLAIM_STATUS[to].word.toLowerCase()}`)}>
                    {to === 'SUBMITTED' ? (c.status === 'DRAFT' ? 'Submit' : 'Resubmit') : to === 'APPROVED' ? 'Approved' : to === 'PAID' ? 'Paid' : to === 'RETURNED' ? 'Returned' : to === 'REJECTED' ? 'Rejected' : 'Write off'}
                  </Button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {!readOnly && (adding ? (
        <form className="mp-form" style={{ marginTop: 12 }} onSubmit={(e) => {
          e.preventDefault();
          if (!payer) return;
          void act('claim', 'post', '/api/ops/claims', { workOrderId, payerCustomerId: payer.id, failureCode: failure.trim() || null, claimedLaborCents: labor ?? 0, claimedPartsCents: parts ?? 0, claimedOtherCents: other ?? 0, filingDeadline: deadline || null }, 'Started the claim')
            .then((r) => { if (r) { setAdding(false); setLabor(null); setParts(null); setOther(null); setFailure(''); } });
        }}>
          <Field label="Manufacturer (billed in Merit Books)"><Lookup kind="customers" value={payer} onChange={(it) => setPayer(it ? { id: it.id, label: it.label } : null)} placeholder="Search customers" /></Field>
          <div className="mp-form-2">
            <Field label="Labor"><MoneyInput valueCents={labor} onChangeCents={setLabor} placeholder="0.00" /></Field>
            <Field label="Parts"><MoneyInput valueCents={parts} onChangeCents={setParts} placeholder="0.00" /></Field>
          </div>
          <div className="mp-form-2">
            <Field label="Other"><MoneyInput valueCents={other} onChangeCents={setOther} placeholder="0.00" /></Field>
            <Field label="File by"><Input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} /></Field>
          </div>
          <Field label="Failure code"><Input value={failure} onChange={(e) => setFailure(e.target.value)} maxLength={60} /></Field>
          <div className="btn-row"><Button onClick={() => setAdding(false)}>Back</Button><Button type="submit" variant="primary" disabled={!payer || busy === 'claim'}>Start claim</Button></div>
        </form>
      ) : (
        <div style={{ marginTop: 8 }}><Button icon="plus" onClick={() => setAdding(true)}>New warranty claim</Button></div>
      ))}
    </PanelSection>
  );
}
