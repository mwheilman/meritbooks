'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Button, Check, ConfirmDialog, Field, InlineNotice, Input, MoneyInput, Panel, PanelSection, Select, Switch, Tag, WidgetState, api, count, money,
  shortDate, toast,
} from '@meritbooks/merit-ui';
import type { ApprovalObjectType, ApprovalPolicy, ApprovalRuleRow, ExceptionRow, RuleCondition, SizeBucket } from '@/lib/approvals/types';
import { APPROVAL_OBJECT_TYPES } from '@/lib/approvals/types';
import { SIZE_LABELS } from '@/lib/approvals/defaults';
import { CONDITION_WORDS, OBJECT_LABELS, ROLE_TITLES, pct, rolesLine } from '@/lib/approvals/labels';

export interface PolicyViewProps {
  policy: ApprovalPolicy;
  exceptions: ExceptionRow[];
  /** The caller may read the exception report (settings:configure or billing:post). */
  showExceptions: boolean;
  readOnly: boolean;
}

const ROLE_KEYS = Object.keys(ROLE_TITLES);
const SIZES: SizeBucket[] = ['xs', 's', 'm', 'l'];

function band(r: Pick<ApprovalRuleRow, 'min_amount_cents' | 'max_amount_cents'>): string {
  if (r.min_amount_cents === 0 && r.max_amount_cents === null) return 'Any amount';
  if (r.min_amount_cents === 0) return `Up to ${money(r.max_amount_cents ?? 0, { decimals: 0 })}`;
  if (r.max_amount_cents === null) return `Over ${money(r.min_amount_cents - 1, { decimals: 0 })}`;
  return `${money(r.min_amount_cents, { decimals: 0 })} – ${money(r.max_amount_cents, { decimals: 0 })}`;
}

interface Draft {
  id: string | null;
  objectType: ApprovalObjectType;
  label: string;
  min: number | null;
  max: number | null;
  step: number;
  roles: Set<string>;
  capability: string | null;
  condition: RuleCondition | '';
  dueDays: string;
  distinct: boolean;
  active: boolean;
}

function draftOf(r: ApprovalRuleRow): Draft {
  return {
    id: r.id, objectType: r.object_type, label: r.label, min: r.min_amount_cents, max: r.max_amount_cents, step: r.step_order,
    roles: new Set(r.approver_roles), capability: r.approver_capability, condition: r.condition ?? '', dueDays: String(r.due_days),
    distinct: r.require_distinct, active: r.is_active,
  };
}

/**
 * The company's approval policy: size bucket (seeds the default tiers), solo / two-person mode,
 * margin floor, and every rule by object. Editing a default rule makes it a custom rule, which a
 * later size change keeps.
 */
export function PolicyView({ policy, exceptions, showExceptions, readOnly }: PolicyViewProps) {
  const router = useRouter();
  const s = policy.settings;
  const can = policy.can_configure && !readOnly;
  const [size, setSize] = useState<SizeBucket>(s?.size_bucket ?? policy.suggested_size);
  const [solo, setSolo] = useState(s?.solo_mode ?? false);
  const [floor, setFloor] = useState(s ? String(Math.round(s.margin_floor_pct * 1000) / 10) : '15');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [err, setErr] = useState<Record<string, string>>({});
  const [del, setDel] = useState<string | null>(null);

  const byType = useMemo(() => {
    const m = new Map<ApprovalObjectType, ApprovalRuleRow[]>();
    for (const r of policy.rules) m.set(r.object_type, [...(m.get(r.object_type) ?? []), r]);
    return APPROVAL_OBJECT_TYPES.filter((t) => m.has(t)).map((t) => ({ type: t, rules: m.get(t)! }));
  }, [policy.rules]);

  const post = async (body: Record<string, unknown>, ok: string) => {
    setBusy(true);
    const r = await api.post<ApprovalPolicy>('/api/approvals/policies', { companyId: policy.location_id, ...body });
    setBusy(false);
    if (r.error) { toast.error(r.error.error); return false; }
    toast(ok);
    router.refresh();
    return true;
  };

  const saveSettings = async (reseed = false) => {
    const f = Number(floor);
    if (!Number.isFinite(f) || f < 0 || f >= 100) { setErr({ floor: 'A percent from 0 to 99.' }); return; }
    setErr({});
    await post({ op: 'settings', size, solo, marginFloorPct: Math.round(f * 10) / 1000, reseed }, reseed ? 'Reset the default rules' : 'Saved approval settings');
  };

  const saveRule = async () => {
    if (!draft) return;
    const e: Record<string, string> = {};
    const due = Number(draft.dueDays);
    if (!draft.label.trim()) e.label = 'Name the approver ("Project manager").';
    if (!Number.isInteger(due) || due < 1 || due > 60) e.due = 'Whole days, 1 to 60.';
    if (draft.max !== null && draft.min !== null && draft.max < draft.min) e.max = 'The ceiling is at or above the floor.';
    if (draft.roles.size === 0 && !draft.capability) e.roles = 'Pick at least one role.';
    setErr(e);
    if (Object.keys(e).length) return;
    const rule = {
      label: draft.label.trim(), minAmountCents: draft.min ?? 0, maxAmountCents: draft.max, stepOrder: draft.step,
      approverRoles: [...draft.roles], approverCapability: draft.capability, requireDistinct: draft.distinct, dueDays: due,
      condition: draft.condition || null, isActive: draft.active,
    };
    const ok = draft.id
      ? await post({ op: 'update_rule', ruleId: draft.id, rule }, 'Saved the rule')
      : await post({ op: 'add_rule', objectType: draft.objectType, rule }, 'Added the rule');
    if (ok) setDraft(null);
  };

  return (
    <div className="stack">
      <section className="ap-section">
        <div className="ap-section-h"><h2 className="t-section">Company</h2><span className="sp" /><span className="t-cap">{count(policy.people)} people with a Projects role</span></div>
        <form className="ap-form" onSubmit={(e) => { e.preventDefault(); void saveSettings(); }}>
          <div className="ap-form-2">
            <Field label="Company size" help={`Sets the default tiers. ${count(policy.people)} people suggests “${SIZE_LABELS[policy.suggested_size]}”.`}>
              <Select value={size} disabled={!can} onChange={(e) => setSize(e.target.value as SizeBucket)}>
                {SIZES.map((z) => <option key={z} value={z}>{SIZE_LABELS[z]}</option>)}
              </Select>
            </Field>
            <Field label="Margin floor (%)" help="Estimates and change orders under it need a manager." error={err.floor}>
              <Input inputMode="decimal" value={floor} disabled={!can} onChange={(e) => setFloor(e.target.value)} />
            </Field>
          </div>
          <Switch label="One- or two-person company: the preparer may approve with a typed reason (goes on the exception report)" checked={solo} disabled={!can} onChange={(e) => setSolo(e.target.checked)} />
          {s && <p className="ap-sub">Overdue steps also open to: {rolesLine(s.escalation_roles)}. Floor today {pct(s.margin_floor_pct)}.</p>}
          {can && (
            <div className="btn-row">
              <Button type="submit" variant="primary" disabled={busy}>Save settings</Button>
              <Button disabled={busy} onClick={() => void saveSettings(true)}>Reset default rules</Button>
            </div>
          )}
          {!policy.can_configure && <InlineNotice tone="info" title="View only.">An owner with settings access changes approval rules.</InlineNotice>}
        </form>
      </section>

      <section className="ap-section">
        <div className="ap-section-h">
          <h2 className="t-section">Rules</h2><span className="sp" />
          {can && <Button variant="primary" onClick={() => { setErr({}); setDraft({ id: null, objectType: 'commitment', label: 'Approver', min: 0, max: null, step: 1, roles: new Set(['projects_owner']), capability: null, condition: '', dueDays: '2', distinct: true, active: true }); }}>Add rule</Button>}
        </div>
        <div className={draft ? 'ap-split has-panel' : 'ap-split'}>
          <div style={{ minWidth: 0 }}>
            {byType.length === 0 ? (
              <WidgetState state={{ kind: 'empty', title: 'No approval rules yet', body: 'Save the company size to seed the default tiers.' }} />
            ) : byType.map((g) => (
              <div key={g.type} style={{ marginBottom: 24 }}>
                <h3 className="t-cap" style={{ marginBottom: 8 }}>{OBJECT_LABELS[g.type].many}</h3>
                <table className="ap-rules">
                  <thead>
                    <tr><th>Amount</th><th>Step</th><th>Approver</th><th className="ap-hide-sm">When</th><th className="n ap-hide-sm">Due</th><th className="ap-hide-sm">Source</th></tr>
                  </thead>
                  <tbody>
                    {g.rules.map((r) => (
                      <tr
                        key={r.id}
                        className={r.is_active ? undefined : 'off'}
                        role={can ? 'button' : undefined}
                        tabIndex={can ? 0 : undefined}
                        onClick={can ? () => { setErr({}); setDraft(draftOf(r)); } : undefined}
                        onKeyDown={can ? (e) => { if (e.key === 'Enter') { setErr({}); setDraft(draftOf(r)); } } : undefined}
                      >
                        <td>{band(r)}{r.policy_key ? <span className="ap-sub" style={{ display: 'block' }}>{r.policy_key}</span> : null}</td>
                        <td className="ap-num">{r.step_order}</td>
                        <td>{r.label}<span className="ap-sub" style={{ display: 'block' }}>{r.approver_roles.length ? rolesLine(r.approver_roles) : 'Anyone who can approve this'}</span></td>
                        <td className="ap-hide-sm">{r.condition ? CONDITION_WORDS[r.condition] : 'Always'}</td>
                        <td className="n ap-hide-sm">{r.due_days} d</td>
                        <td className="ap-hide-sm"><Tag>{r.is_active ? r.source : 'off'}</Tag></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
          {draft && (
            <Panel
              eyebrow={[draft.id ? 'Edit rule' : 'New rule', OBJECT_LABELS[draft.objectType].many]}
              title={draft.label || 'Approver'}
              onClose={() => setDraft(null)}
              foot={
                <div className="ap-verbs">
                  {draft.id && <Button variant="danger" disabled={busy} onClick={() => setDel(draft.id)}>Delete</Button>}
                  <span className="sp" />
                  <Button onClick={() => setDraft(null)}>Cancel</Button>
                  <Button variant="primary" disabled={busy} onClick={() => void saveRule()}>{draft.id ? 'Save rule' : 'Add rule'}</Button>
                </div>
              }
            >
              <PanelSection>
                <div className="ap-form">
                  {!draft.id && (
                    <Field label="Applies to">
                      <Select value={draft.objectType} onChange={(e) => setDraft({ ...draft, objectType: e.target.value as ApprovalObjectType })}>
                        {APPROVAL_OBJECT_TYPES.filter((t) => t !== 'stage_transition').map((t) => <option key={t} value={t}>{OBJECT_LABELS[t].many}</option>)}
                      </Select>
                    </Field>
                  )}
                  <Field label="Approver name" error={err.label}><Input value={draft.label} maxLength={80} onChange={(e) => setDraft({ ...draft, label: e.target.value })} /></Field>
                  <div className="ap-form-2">
                    <Field label="From"><MoneyInput valueCents={draft.min} onChangeCents={(v) => setDraft({ ...draft, min: v })} placeholder="0.00" /></Field>
                    <Field label="Up to" help="Empty = no ceiling" error={err.max}><MoneyInput valueCents={draft.max} onChangeCents={(v) => setDraft({ ...draft, max: v })} placeholder="No ceiling" /></Field>
                  </div>
                  <div className="ap-form-2">
                    <Field label="Step"><Select value={String(draft.step)} onChange={(e) => setDraft({ ...draft, step: Number(e.target.value) })}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</Select></Field>
                    <Field label="Due in (days)" error={err.due}><Input inputMode="numeric" value={draft.dueDays} onChange={(e) => setDraft({ ...draft, dueDays: e.target.value })} /></Field>
                  </div>
                  <Field label="Only when">
                    <Select value={draft.condition} onChange={(e) => setDraft({ ...draft, condition: e.target.value as RuleCondition | '' })}>
                      <option value="">Always</option>
                      {Object.entries(CONDITION_WORDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </Select>
                  </Field>
                  <Field label="Who may approve" error={err.roles} help={draft.capability ? `Also anyone holding ${draft.capability}` : 'Any of these roles at the company'}>
                    <div className="ap-types">
                      {ROLE_KEYS.map((k) => (
                        <Check key={k} label={ROLE_TITLES[k]} checked={draft.roles.has(k)} onChange={(e) => { const n = new Set(draft.roles); if (e.target.checked) n.add(k); else n.delete(k); setDraft({ ...draft, roles: n }); }} />
                      ))}
                    </div>
                  </Field>
                  <Check label="A different person from earlier steps" checked={draft.distinct} onChange={(e) => setDraft({ ...draft, distinct: e.target.checked })} />
                  <Switch label="Active" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
                </div>
              </PanelSection>
            </Panel>
          )}
        </div>
      </section>

      {showExceptions && (
        <section className="ap-section">
          <div className="ap-section-h"><h2 className="t-section">Exception report</h2><span className="sp" /><span className="t-cap">Self-approvals with their reasons</span></div>
          {exceptions.length === 0 ? (
            <WidgetState state={{ kind: 'done', title: 'No self-approvals', body: 'In one- or two-person companies, approvals of your own items show here with the typed reason.' }} />
          ) : (
            <table className="ap-rules">
              <thead><tr><th>Date</th><th>Item</th><th>By</th><th>Reason</th><th className="n">Amount</th></tr></thead>
              <tbody>
                {exceptions.map((x) => (
                  <tr key={x.action_id}>
                    <td className="ap-num">{shortDate(x.acted_at.slice(0, 10))}</td>
                    <td>{x.href ? <Link className="link" href={x.href}>{x.title}</Link> : x.title}<span className="ap-sub" style={{ display: 'block' }}>{OBJECT_LABELS[x.object_type].one}{x.job_label ? ` · ${x.job_label}` : ''}</span></td>
                    <td>{x.actor ?? '—'}</td>
                    <td>{x.reason ?? '—'}</td>
                    <td className="n">{x.amount_cents === null ? '—' : money(x.amount_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      <ConfirmDialog
        open={!!del}
        onClose={() => setDel(null)}
        tone="danger"
        title="Delete this rule"
        confirmLabel="Delete rule"
        onConfirm={async () => { if (del && (await post({ op: 'delete_rule', ruleId: del }, 'Deleted the rule'))) setDraft(null); }}
      >
        Approvals already in flight keep the chain they started with. New ones follow the remaining rules.
      </ConfirmDialog>
    </div>
  );
}
