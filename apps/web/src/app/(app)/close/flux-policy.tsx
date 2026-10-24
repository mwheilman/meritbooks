'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button, Check, Dialog, Field, InlineNotice, Input, MoneyInput, Select, Seg, api, toast, useQuery } from '@meritbooks/merit-ui';
import {
  BASIS_LABEL,
  COMPARISON_BASES,
  FLUX_DIMENSIONS,
  MODE_LABEL,
  THRESHOLD_MODES,
  type ComparisonBasis,
  type FluxDimension,
  type FluxPolicy,
  type MaterialityOverride,
  type OverrideScope,
  type ThresholdMode,
} from '@/lib/close/flux/types';
import s from './flux.module.css';

interface PolicyResponse {
  tenant: FluxPolicy;
  company: FluxPolicy | null;
  effective: FluxPolicy;
  accounts: { id: string; number: string; name: string; type: string; groupId: string | null; groupName: string | null }[];
  groups: { id: string; name: string }[];
}

type Scope = 'company' | 'tenant';

const DIM_LABEL: Record<FluxDimension, string> = {
  ACCOUNT: 'By account',
  ACCOUNT_DEPARTMENT: 'By account × department',
  ACCOUNT_CLASS: 'By account × class',
};
const TYPES = ['REVENUE', 'COGS', 'OPEX', 'OTHER', 'ASSET', 'LIABILITY', 'EQUITY'];

interface Draft {
  reviewRequired: boolean;
  thresholdMode: ThresholdMode;
  absThresholdCents: number;
  pctThresholdBps: number;
  comparisonBasis: ComparisonBasis;
  dimension: FluxDimension;
  includePnl: boolean;
  includeBalanceSheet: boolean;
  overrides: MaterialityOverride[];
  excludedAccountIds: string[];
}

const toDraft = (p: FluxPolicy): Draft => ({
  reviewRequired: p.reviewRequired,
  thresholdMode: p.thresholdMode,
  absThresholdCents: p.absThresholdCents,
  pctThresholdBps: p.pctThresholdBps,
  comparisonBasis: p.comparisonBasis,
  dimension: p.dimension,
  includePnl: p.includePnl,
  includeBalanceSheet: p.includeBalanceSheet,
  overrides: p.overrides,
  excludedAccountIds: p.excludedAccountIds,
});

/** Materiality policy editor: this company (or inherit) and the organization default. */
export function FluxPolicyDialog({ locationId, canEdit, onClose, onSaved }: { locationId: string; canEdit: boolean; onClose: () => void; onSaved: () => void }) {
  const { data, error, isLoading } = useQuery<PolicyResponse>('/api/close/flux/policy', { location_id: locationId }, { scope: false });
  const [scope, setScope] = useState<Scope>('company');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setDraft(toDraft(scope === 'company' ? data.company ?? data.tenant : data.tenant));
  }, [data, scope]);

  const acctLabel = useMemo(() => new Map((data?.accounts ?? []).map((a) => [a.id, `${a.number} ${a.name}`])), [data]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const setOv = (i: number, patch: Partial<MaterialityOverride>) =>
    setDraft((d) => (d ? { ...d, overrides: d.overrides.map((o, j) => (j === i ? { ...o, ...patch } : o)) } : d));

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setErr(null);
    const res = await api.put<{ ok: boolean }>('/api/close/flux/policy', {
      location_id: scope === 'company' ? locationId : null,
      review_required: draft.reviewRequired,
      threshold_mode: draft.thresholdMode,
      abs_threshold_cents: draft.absThresholdCents,
      pct_threshold_bps: draft.pctThresholdBps,
      comparison_basis: draft.comparisonBasis,
      dimension: draft.dimension,
      include_pnl: draft.includePnl,
      include_balance_sheet: draft.includeBalanceSheet,
      overrides: draft.overrides.filter((o) => o.key),
      excluded_account_ids: draft.excludedAccountIds,
    });
    setBusy(false);
    if (res.error) { setErr(res.error.error); return; }
    toast('Materiality policy saved.');
    onSaved();
  };

  const reset = async () => {
    setBusy(true);
    const res = await api.delete<{ ok: boolean }>(`/api/close/flux/policy?location_id=${locationId}`);
    setBusy(false);
    if (res.error) { setErr(res.error.error); return; }
    toast('This company now uses the organization default.');
    onSaved();
  };

  const keyOptions = (scopeKind: OverrideScope) =>
    scopeKind === 'TYPE'
      ? TYPES.map((t) => ({ value: t, label: t.charAt(0) + t.slice(1).toLowerCase() }))
      : scopeKind === 'GROUP'
        ? (data?.groups ?? []).map((g) => ({ value: g.id, label: g.name }))
        : (data?.accounts ?? []).map((a) => ({ value: a.id, label: `${a.number} ${a.name}` }));

  return (
    <Dialog
      open
      onClose={onClose}
      width={760}
      dismissOnScrim={false}
      title="Flux materiality"
      footNote={canEdit ? 'Changes apply to the next load of the flux list and the close gate.' : 'Only a controller can change the policy.'}
      actions={
        <>
          {scope === 'company' && data?.company && canEdit && <Button variant="quiet" onClick={() => void reset()} disabled={busy}>Use organization default</Button>}
          <Button onClick={onClose} disabled={busy}>{canEdit ? 'Cancel' : 'Close'}</Button>
          {canEdit && <Button variant="primary" onClick={() => void save()} disabled={busy || !draft}>{busy ? 'Saving…' : 'Save policy'}</Button>}
        </>
      }
    >
      <Seg<Scope>
        aria-label="Policy scope"
        value={scope}
        onChange={setScope}
        items={[{ value: 'company', label: data?.company ? 'This company' : 'This company (inherits)' }, { value: 'tenant', label: 'Organization default' }]}
      />
      {isLoading && !data ? (
        <div className="wg-loading" style={{ height: 200, marginTop: 16 }} aria-busy="true"><span className="bar-l" style={{ width: '50%' }} /></div>
      ) : error ? (
        <InlineNotice tone="neg" title="Couldn't load the policy.">{error}</InlineNotice>
      ) : draft ? (
        <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: '16px 0 0' }}>
          {scope === 'company' && !data?.company && (
            <p className="t-cap" style={{ marginBottom: 12 }}>This company uses the organization default. Saving here gives it its own policy.</p>
          )}
          {err && <InlineNotice tone="neg" title="Not saved.">{err}</InlineNotice>}
          <Check label="Require a flux review before hard close" checked={draft.reviewRequired} onChange={(e) => set('reviewRequired', e.target.checked)} />
          <div className={s.policyGrid} style={{ marginTop: 12 }}>
            <Field label="Material when the change is over">
              <MoneyInput valueCents={draft.absThresholdCents} onChangeCents={(c) => set('absThresholdCents', c ?? 0)} aria-label="Dollar threshold" />
            </Field>
            <Field label="… and / or over (%)">
              <Input type="number" min={0} step={0.5} value={String(draft.pctThresholdBps / 100)} onChange={(e) => set('pctThresholdBps', Math.round(Number(e.target.value || 0) * 100))} />
            </Field>
            <Field label="Test">
              <Select value={draft.thresholdMode} onChange={(e) => set('thresholdMode', e.target.value as ThresholdMode)}>
                {THRESHOLD_MODES.map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
              </Select>
            </Field>
            <Field label="Compare against">
              <Select value={draft.comparisonBasis} onChange={(e) => set('comparisonBasis', e.target.value as ComparisonBasis)}>
                {COMPARISON_BASES.map((b) => <option key={b} value={b}>{BASIS_LABEL[b]}</option>)}
              </Select>
            </Field>
            <Field label="Lines">
              <Select value={draft.dimension} onChange={(e) => set('dimension', e.target.value as FluxDimension)}>
                {FLUX_DIMENSIONS.map((d) => <option key={d} value={d}>{DIM_LABEL[d]}</option>)}
              </Select>
            </Field>
            <Field label="Statements">
              <div className={s.row}>
                <Check label="P&L" checked={draft.includePnl} onChange={(e) => set('includePnl', e.target.checked)} />
                <Check label="Balance sheet" checked={draft.includeBalanceSheet} onChange={(e) => set('includeBalanceSheet', e.target.checked)} />
              </div>
            </Field>
          </div>

          <h3 className="t-head" style={{ margin: '16px 0 8px' }}>Overrides</h3>
          <p className="t-cap" style={{ marginBottom: 8 }}>Most specific wins: account, then account group, then account type.</p>
          {draft.overrides.map((o, i) => (
            <div key={i} className={s.ovRow}>
              <Select aria-label="Override applies to" value={o.scope} onChange={(e) => setOv(i, { scope: e.target.value as OverrideScope, key: '' })}>
                <option value="TYPE">Type</option>
                <option value="GROUP">Group</option>
                <option value="ACCOUNT">Account</option>
              </Select>
              <Select aria-label="Which" value={o.key} onChange={(e) => setOv(i, { key: e.target.value })}>
                <option value="">Choose…</option>
                {keyOptions(o.scope).map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </Select>
              <MoneyInput aria-label="Dollar threshold" valueCents={o.absThresholdCents ?? null} onChangeCents={(c) => setOv(i, { absThresholdCents: c })} placeholder="Policy $" />
              <Input aria-label="Percent threshold" type="number" min={0} step={0.5} placeholder="%" value={o.pctThresholdBps == null ? '' : String(o.pctThresholdBps / 100)} onChange={(e) => setOv(i, { pctThresholdBps: e.target.value === '' ? null : Math.round(Number(e.target.value) * 100) })} />
              <Select aria-label="Test" value={o.mode ?? ''} onChange={(e) => setOv(i, { mode: (e.target.value || null) as ThresholdMode | null })}>
                <option value="">Policy test</option>
                {THRESHOLD_MODES.map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
              </Select>
              <Check label="Exclude" checked={o.excluded === true} onChange={(e) => setOv(i, { excluded: e.target.checked ? true : null })} />
              <Button variant="quiet" iconOnly icon="x" aria-label="Remove override" onClick={() => set('overrides', draft.overrides.filter((_, j) => j !== i))} />
            </div>
          ))}
          <Button variant="quiet" onClick={() => set('overrides', [...draft.overrides, { scope: 'TYPE', key: '', absThresholdCents: null, pctThresholdBps: null, mode: null, excluded: null }])} disabled={draft.overrides.length >= 100}>
            Add override
          </Button>

          <h3 className="t-head" style={{ margin: '16px 0 8px' }}>Excluded accounts</h3>
          <div className={s.row}>
            {draft.excludedAccountIds.map((id) => (
              <Button key={id} variant="quiet" onClick={() => set('excludedAccountIds', draft.excludedAccountIds.filter((x) => x !== id))} aria-label={`Stop excluding ${acctLabel.get(id) ?? 'account'}`}>
                {acctLabel.get(id) ?? 'Account'} ×
              </Button>
            ))}
            <Select aria-label="Exclude an account" value="" onChange={(e) => e.target.value && set('excludedAccountIds', [...draft.excludedAccountIds, e.target.value])}>
              <option value="">Exclude an account…</option>
              {(data?.accounts ?? []).filter((a) => !draft.excludedAccountIds.includes(a.id)).map((a) => <option key={a.id} value={a.id}>{a.number} {a.name}</option>)}
            </Select>
          </div>
        </fieldset>
      ) : null}
    </Dialog>
  );
}
