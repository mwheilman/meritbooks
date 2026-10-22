'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Button, Check, Field, Input, MoneyInput, Seg, Select, Status, Switch, WidgetState, count, shortDate } from '@meritbooks/merit-ui';
import { APPROVAL_ROLES, APPROVAL_ROLE_LABELS, type ApprovalRole } from '@meritbooks/industry-packs/src/constants';
import { EVENT_WORDS, outboxMark, subjectHref } from '@/lib/pm/dealer/labels';
import type { OutboxSummary } from '@/lib/pm/dealer/store-queries';
import type { ChecklistItem, DealerSettingsRow, PayoffGuard, StockLocationRow } from '@/lib/pm/dealer/types';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, PctInput } from '@/components/ops/common/bits';
import { useStore } from '../common/useStore';

export interface StoreSettingsProps {
  companies: Array<{ id: string; name: string }>;
  initialCompanyId: string;
  settings: Record<string, DealerSettingsRow>;
  stockLocations: StockLocationRow[];
  outbox: OutboxSummary;
  booksPresent: boolean;
}

const GUARD_HELP: Readonly<Record<PayoffGuard, string>> = {
  OFF: 'Deliver floored units without a payoff check.',
  WARN: 'Warn before delivery when a floored unit’s payoff is not scheduled; a manager acknowledges it.',
  BLOCK: 'Refuse delivery until the payoff is scheduled in Merit Books.',
};

function Roles({ value, onChange, disabled, label }: { value: string[]; onChange: (v: string[]) => void; disabled: boolean; label: string }) {
  return (
    <fieldset style={{ border: 0, padding: 0 }}>
      <legend className="field-label">{label}</legend>
      <div className="dl-roles">
        {APPROVAL_ROLES.map((r) => (
          <Check key={r} label={APPROVAL_ROLE_LABELS[r as ApprovalRole]} checked={value.includes(r)} disabled={disabled}
            onChange={(e) => onChange(e.target.checked ? [...value, r] : value.filter((x) => x !== r))} />
        ))}
      </div>
    </fieldset>
  );
}

/** Store rules for one company (pm.set_dealer_settings) and the state of the Merit Books connection. */
export function StoreSettings(p: StoreSettingsProps) {
  const { readOnly } = useShell();
  const { act, busy, error } = useStore();
  const [companyId, setCompanyId] = useState(p.initialCompanyId);
  const saved = p.settings[companyId]!;
  const [draft, setDraft] = useState<DealerSettingsRow>(saved);
  const [newLoc, setNewLoc] = useState({ code: '', name: '', kind: 'WAREHOUSE' as 'WAREHOUSE' | 'SHOP' | 'STAGING' | 'RECEIVER' });
  const locs = p.stockLocations.filter((s) => s.location_id === companyId);
  const live = !readOnly;
  const set = <K extends keyof DealerSettingsRow>(k: K, v: DealerSettingsRow[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const changes = useMemo(() => {
    const out: Record<string, unknown> = {};
    const pairs: Array<[keyof DealerSettingsRow, string]> = [
      ['margin_floor_pct', 'marginFloorPct'], ['min_front_gross_cents', 'minFrontGrossCents'], ['desk_roles', 'deskRoles'], ['floor_override_roles', 'floorOverrideRoles'],
      ['payoff_guard', 'payoffGuard'], ['payoff_ack_roles', 'payoffAckRoles'], ['unwind_roles', 'unwindRoles'], ['trade_reduces_taxable', 'tradeReducesTaxable'],
      ['default_tax_rate', 'defaultTaxRate'], ['unit_stock_location_id', 'unitStockLocationId'], ['parts_stock_location_id', 'partsStockLocationId'],
      ['allow_negative_parts', 'allowNegativeParts'], ['delivery_checklist', 'deliveryChecklist'],
    ];
    for (const [k, key] of pairs) {
      if (JSON.stringify(draft[k]) !== JSON.stringify(saved[k])) out[key] = k === 'delivery_checklist' ? draft.delivery_checklist.map((c) => ({ key: c.key, label: c.label, required: c.required })) : draft[k];
    }
    return out;
  }, [draft, saved]);
  const dirty = Object.keys(changes).length > 0;
  const rolesOk = draft.desk_roles.length > 0 && draft.floor_override_roles.length > 0 && draft.payoff_ack_roles.length > 0 && draft.unwind_roles.length > 0;

  const setItem = (i: number, patch: Partial<ChecklistItem>) => set('delivery_checklist', draft.delivery_checklist.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  const q = p.outbox.queue.filter((x) => x.location_id === companyId);
  const held = q.filter((x) => x.status === 'HELD');
  const sent = q.filter((x) => x.status === 'RELEASED');
  const rejected = q.filter((x) => x.status === 'REJECTED');

  return (
    <div className="stack">
      {p.companies.length > 1 && (
        <Field label="Store">
          <Select value={companyId} onChange={(e) => { setCompanyId(e.target.value); setDraft(p.settings[e.target.value]!); }} style={{ maxWidth: 320 }}>
            {p.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
      )}
      {error && <Failure text={error} title="Not saved." />}
      <div className="dl-settings">
        <div className="stack">
          <section className="dl-card">
            <div className="dl-card-h"><h2 className="t-section">Sales desk</h2></div>
            <div className="dl-card-b mp-form">
              <div className="mp-form-2">
                <Field label="Margin floor" help="Front gross as a share of the sale price"><PctInput value={draft.margin_floor_pct} onChange={(v) => set('margin_floor_pct', v ?? 0)} aria-label="Margin floor" /></Field>
                <Field label="Minimum front gross"><MoneyInput valueCents={draft.min_front_gross_cents} onChangeCents={(v) => set('min_front_gross_cents', v ?? 0)} disabled={!live} /></Field>
              </div>
              <Roles label="Who desks a deal" value={draft.desk_roles} onChange={(v) => set('desk_roles', v)} disabled={!live} />
              <Roles label="Who approves below the floor (with a reason)" value={draft.floor_override_roles} onChange={(v) => set('floor_override_roles', v)} disabled={!live} />
              <Roles label="Who unwinds a delivered deal" value={draft.unwind_roles} onChange={(v) => set('unwind_roles', v)} disabled={!live} />
              <p className="t-cap">The salesperson and the person who wrote a deal never desk it. Owners and admins satisfy every role.</p>
            </div>
          </section>

          <section className="dl-card">
            <div className="dl-card-h"><h2 className="t-section">Delivery</h2></div>
            <div className="dl-card-b mp-form">
              <Field label="Floor-plan payoff guard" help={GUARD_HELP[draft.payoff_guard]}>
                <Seg<PayoffGuard> aria-label="Payoff guard" value={draft.payoff_guard} onChange={(v) => live && set('payoff_guard', v)} items={[{ value: 'OFF', label: 'Off' }, { value: 'WARN', label: 'Warn' }, { value: 'BLOCK', label: 'Block' }]} />
              </Field>
              {draft.payoff_guard === 'WARN' && <Roles label="Who acknowledges a payoff due" value={draft.payoff_ack_roles} onChange={(v) => set('payoff_ack_roles', v)} disabled={!live} />}
              <div>
                <span className="field-label">Delivery checklist (new deals)</span>
                <ul className="dl-checklist" style={{ listStyle: 'none' }}>
                  {draft.delivery_checklist.map((c, i) => (
                    <li key={`${c.key}:${i}`}>
                      <Input aria-label="Step" value={c.label} disabled={!live} onChange={(e) => setItem(i, { label: e.target.value })} maxLength={120} />
                      <Check label="Required" checked={c.required} disabled={!live} onChange={(e) => setItem(i, { required: e.target.checked })} />
                      {live ? <Button variant="quiet" iconOnly icon="x" aria-label={`Remove ${c.label}`} onClick={() => set('delivery_checklist', draft.delivery_checklist.filter((_, j) => j !== i))} /> : <span />}
                    </li>
                  ))}
                </ul>
                {live && <Button icon="plus" onClick={() => set('delivery_checklist', [...draft.delivery_checklist, { key: `step_${draft.delivery_checklist.length + 1}_${Date.now().toString(36).slice(-4)}`, label: 'New step', required: false }])}>Add a step</Button>}
                <p className="t-cap" style={{ marginTop: 4 }}>Keep the “pdi_complete” step to have a closed PDI repair order tick it, and “warranty_registration” for registration.</p>
              </div>
            </div>
          </section>

          <section className="dl-card">
            <div className="dl-card-h"><h2 className="t-section">Tax estimate</h2></div>
            <div className="dl-card-b mp-form">
              <Field label="Default sales tax estimate" help="Merit Books calculates the final tax"><PctInput value={draft.default_tax_rate} max={25} onChange={(v) => set('default_tax_rate', v)} aria-label="Default tax estimate" placeholder="7" /></Field>
              <Switch label="Trade allowance reduces the taxable amount" checked={draft.trade_reduces_taxable} disabled={!live} onChange={(e) => set('trade_reduces_taxable', e.target.checked)} />
            </div>
          </section>
        </div>

        <div className="stack">
          <section className="dl-card">
            <div className="dl-card-h"><h2 className="t-section">Lots and parts rooms</h2><span className="sp" /><span className="t-cap">{count(locs.length)}</span></div>
            <div className="dl-card-b mp-form">
              {locs.length === 0 ? <p className="t-cap">No stock locations yet. Add the lot units sit on and the parts room the counter sells from.</p> : (
                <table className="dl-tbl"><tbody>{locs.map((l) => <tr key={l.id} className={l.is_active ? undefined : 'void'}><td className="b">{l.code}</td><td>{l.name}</td><td className="t-cap">{l.kind.toLowerCase()}</td></tr>)}</tbody></table>
              )}
              {live && (
                <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <Field label="Code"><Input value={newLoc.code} onChange={(e) => setNewLoc({ ...newLoc, code: e.target.value })} maxLength={24} style={{ width: 90 }} placeholder="LOT" /></Field>
                  <Field label="Name"><Input value={newLoc.name} onChange={(e) => setNewLoc({ ...newLoc, name: e.target.value })} maxLength={80} placeholder="Main lot" /></Field>
                  <Field label="Kind"><Select value={newLoc.kind} onChange={(e) => setNewLoc({ ...newLoc, kind: e.target.value as typeof newLoc.kind })}><option value="WAREHOUSE">Lot or warehouse</option><option value="SHOP">Shop</option><option value="STAGING">Staging</option><option value="RECEIVER">Receiving</option></Select></Field>
                  <Button disabled={!newLoc.code.trim() || !newLoc.name.trim() || busy === 'loc'} onClick={() => void act('loc', 'post', '/api/dealer/stock-locations', { companyId, ...newLoc }, `Added ${newLoc.name}`).then((r) => { if (r.data) setNewLoc({ code: '', name: '', kind: 'WAREHOUSE' }); })}>Add</Button>
                </div>
              )}
              <div className="mp-form-2">
                <Field label="Units arrive at"><Select value={draft.unit_stock_location_id ?? ''} disabled={!live} onChange={(e) => set('unit_stock_location_id', e.target.value || null)}><option value="">Not set</option>{locs.map((l) => <option key={l.id} value={l.id}>{l.code} · {l.name}</option>)}</Select></Field>
                <Field label="Counter sells from"><Select value={draft.parts_stock_location_id ?? ''} disabled={!live} onChange={(e) => set('parts_stock_location_id', e.target.value || null)}><option value="">Not set</option>{locs.map((l) => <option key={l.id} value={l.id}>{l.code} · {l.name}</option>)}</Select></Field>
              </div>
              <Switch label="Let the counter sell past zero on hand" checked={draft.allow_negative_parts} disabled={!live} onChange={(e) => set('allow_negative_parts', e.target.checked)} />
            </div>
          </section>

          <section className="dl-card">
            <div className="dl-card-h"><h2 className="t-section">Rentals</h2></div>
            <div className="dl-card-b">
              <p>Rates are set per unit, model, category or as a company default on <Link className="link" href="/rentals?view=rates">the rate card</Link>.</p>
              <p className="t-cap" style={{ marginTop: 8 }}>Billing rules: 28-day months, 7-day weeks, then days; each tier capped by the next; a 59-minute return grace. Damage waiver is a share of the rent.</p>
            </div>
          </section>

          <section className="dl-card" aria-label="Merit Books connection">
            <div className="dl-card-h"><h2 className="t-section">Books connection</h2><span className="sp" />{!p.booksPresent ? <Status kind="track" pip="closed">Merit Books is not on</Status> : p.outbox.seamOn === false ? <Status kind="track" pip="soft">Dealer posting not on yet</Status> : <Status kind="ready" pip="ready">Taking dealer events</Status>}</div>
            <div className="dl-card-b">
              {!p.booksPresent ? (
                <p className="t-cap">The store runs on its own. Units, deals, parts sales, repair orders and rentals are recorded here; nothing is sent until Merit Books is on for this workspace.</p>
              ) : q.length === 0 && p.outbox.processed30 === 0 ? (
                <WidgetState state={{ kind: 'done', title: 'Nothing waiting on Merit Books', body: 'Receipts, unit costs, delivered deals, counter sales, closed repair orders and rental bills go to Merit Books as they happen.' }} />
              ) : (
                <div className="stack">
                  <ul className="dl-totals">
                    <li><span>Held until Merit Books turns on dealer posting</span><span className="v">{count(held.length)}</span></li>
                    <li><span>Sent, waiting on Merit Books</span><span className="v">{count(sent.length)}</span></li>
                    <li><span>Rejected, fix in Merit Books and resend</span><span className={rejected.length ? 'v neg' : 'v'}>{count(rejected.length)}</span></li>
                    <li className="muted"><span>Posted in the last 30 days</span><span className="v">{count(p.outbox.processed30)}</span></li>
                  </ul>
                  {held.length > 0 && <p className="t-cap">Held events go in order, oldest first, the moment Merit Books switches its dealer consumers on. Nothing needs re-entering.</p>}
                  {rejected.length > 0 && (
                    <ul className="feed feed--flush">
                      {rejected.slice(0, 12).map((x) => {
                        const href = subjectHref(x.subject_table, x.subject_id);
                        const m = outboxMark(x.status);
                        return (
                          <li key={x.outbox_id}>
                            <span style={{ minWidth: 0 }}>
                              <span className="l1" style={{ fontWeight: 400 }}>{EVENT_WORDS[x.event_type]}{href ? <> · <Link className="nlink" href={href}>open</Link></> : null}</span>
                              <span className="l2 neg">{x.error_text ?? m.word}</span>
                              <span className="l2">{shortDate(x.occurred_on)}{x.resent_count ? ` · sent ${x.resent_count + 1} times` : ''}</span>
                            </span>
                            {live && <Button disabled={busy === `rs:${x.outbox_id}`} onClick={() => void act(`rs:${x.outbox_id}`, 'post', `/api/dealer/outbox/${x.outbox_id}`, {}, 'Sent it to Merit Books again')}>Resend</Button>}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {sent.length > 0 && <p className="t-cap">Oldest waiting: {EVENT_WORDS[sent[sent.length - 1]!.event_type]} from {shortDate(sent[sent.length - 1]!.created_at.slice(0, 10))}.</p>}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
      {live && (
        <div className="keybar" style={{ position: 'sticky', bottom: 0 }}>
          <span className="t-cap">{dirty ? `${Object.keys(changes).length} change${Object.keys(changes).length === 1 ? '' : 's'} not saved` : 'Saved'}</span>
          <span className="sp" />
          <Button disabled={!dirty} onClick={() => setDraft(saved)}>Discard</Button>
          <Button variant="primary" chord="mod+s" bindChord={dirty} disabled={!dirty || !rolesOk || busy === 'save'} onClick={() => void act('save', 'post', '/api/dealer/settings', { companyId, ...changes }, 'Saved the store settings')}>Save settings</Button>
        </div>
      )}
      {live && !rolesOk && <p className="field-error">Each approval needs at least one role.</p>}
    </div>
  );
}
