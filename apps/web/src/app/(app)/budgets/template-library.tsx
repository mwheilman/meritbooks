'use client';

/**
 * Templates tab (Wave 4B, AC-B14): the recommended department templates and this tenant's own.
 * View a template's lines (how each picks an account, the default driver, KPIs); "Save as my
 * template" copies a recommended one; editing a tenant template saves version n+1 (old versions stay).
 */
import { useEffect, useMemo, useState } from 'react';
import { Button, Field, Input, InlineNotice, Select, Tag, Textarea, api, toast, useQuery } from '@meritbooks/merit-ui';
import {
  DEPARTMENT_KINDS,
  DRIVER_METHODS,
  DRIVER_METHOD_LABEL,
  type BudgetTemplate,
  type DepartmentKind,
  type DriverMethod,
  type TemplateLine,
} from '@/lib/budgets/types';
import { bpsToPctText, errText } from './budget-format';
import { ScopeBar, useBudgetScope } from './budget-scope';
import s from './budgets.module.css';

interface TemplatesResponse { system: BudgetTemplate[]; tenant: BudgetTemplate[]; history: Record<string, number[]>; canEdit: boolean }
const TYPES = ['REVENUE', 'COGS', 'OPEX', 'OTHER'] as const;
type AcctType = (typeof TYPES)[number];

const KIND_LABEL: Record<DepartmentKind, string> = {
  SALES: 'Sales', MARKETING: 'Marketing', OPERATIONS: 'Operations / field', SERVICE: 'Service', PARTS: 'Parts', SHOP: 'Shop / production',
  CONSTRUCTION_PM: 'Construction PM', ADMIN: 'Admin & G&A', EXECUTIVE: 'Executive', FINANCE: 'Finance', OTHER: 'Other',
};

export function selectorText(l: TemplateLine): string {
  const parts = [l.selector.types.join(' / ')];
  if (l.selector.group) parts.push(`group ~ /${l.selector.group}/`);
  if (l.selector.name) parts.push(`name ~ /${l.selector.name}/`);
  if (l.selector.notName) parts.push(`not /${l.selector.notName}/`);
  return parts.join(' · ');
}

function paramText(l: TemplateLine): string {
  return Object.entries(l.params)
    .map(([k, v]) => (/Bps$/.test(k) ? `${k.replace(/Bps$/, '')} ${bpsToPctText(v)}` : /Cents$/.test(k) ? `${k.replace(/Cents$/, '')} $${(v / 100).toLocaleString('en-US')}` : `${k} ${v}`))
    .join(', ');
}

export function TemplateLibrary() {
  const sc = useBudgetScope();
  const q = useQuery<TemplatesResponse>(sc.locationId ? '/api/budgets/templates' : null, { location_id: sc.locationId });
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<BudgetTemplate | null>(null);
  const all = useMemo(() => [...(q.data?.tenant ?? []), ...(q.data?.system ?? [])], [q.data]);
  const current = all.find((t) => t.id === selected) ?? null;
  useEffect(() => {
    if (!selected && all.length) setSelected(all[0].id);
  }, [all, selected]);

  const startEdit = (t: BudgetTemplate) =>
    setDraft({ ...t, lines: t.lines.map((l) => ({ ...l, selector: { ...l.selector, types: [...l.selector.types] }, params: { ...l.params } })), kpis: [...t.kpis] });

  return (
    <div>
      <ScopeBar />
      {!sc.locationId ? (
        <div className={`${s.surface} ${s.state}`}><strong>Choose a company</strong><p>Templates belong to the workspace; the company sets the access check.</p></div>
      ) : q.isLoading && !q.data ? (
        <div className={`${s.surface} ${s.state}`} aria-busy="true">Loading templates…</div>
      ) : q.error ? (
        <InlineNotice tone="neg" title="Couldn’t load templates" className={s.notice}>{q.error}</InlineNotice>
      ) : (
        <div className={s.tplCols}>
          <div>
            {(q.data?.tenant.length ?? 0) > 0 && <div className="t-cap" style={{ margin: '0 0 6px' }}>Your templates</div>}
            {q.data?.tenant.map((t) => (
              <button key={t.id} type="button" className={s.tplPick} aria-pressed={selected === t.id} onClick={() => { setSelected(t.id); setDraft(null); }}>
                <strong>{t.name}</strong> <Tag>v{t.version}</Tag>
                <div className={s.hint}>{KIND_LABEL[t.departmentKind]} · {t.lines.length} lines{t.basedOn ? ` · from ${t.basedOn.replace('system:', '')}` : ''}</div>
              </button>
            ))}
            <div className="t-cap" style={{ margin: '12px 0 6px' }}>Recommended</div>
            {q.data?.system.map((t) => (
              <button key={t.id} type="button" className={s.tplPick} aria-pressed={selected === t.id} onClick={() => { setSelected(t.id); setDraft(null); }}>
                <strong>{t.name}</strong>
                <div className={s.hint}>{t.lines.length} lines · {t.kpis.slice(0, 2).join(', ')}</div>
              </button>
            ))}
          </div>
          <div>
            {draft ? (
              <TemplateEditor
                draft={draft}
                setDraft={setDraft}
                locationId={sc.locationId}
                onSaved={async (saved) => { setDraft(null); await q.refetch(); setSelected(saved.id); }}
              />
            ) : current ? (
              <div className={s.surface}>
                <div className={s.toolbar}>
                  <span className={s.toolbarTitle}>{current.name}{current.scope === 'tenant' ? ` · v${current.version}` : ' · recommended'}</span>
                  {q.data?.canEdit && (current.scope === 'system'
                    ? <Button onClick={() => startEdit({ ...current, id: '', scope: 'tenant', key: '', version: 1, basedOn: current.id, name: `${current.name} (ours)` })}>Save as my template</Button>
                    : <Button onClick={() => startEdit(current)}>Edit (saves v{current.version + 1})</Button>)}
                </div>
                <div style={{ padding: '12px 16px' }}>
                  <p style={{ marginTop: 0 }}>{current.description}</p>
                  {current.scope === 'tenant' && (q.data?.history[current.key]?.length ?? 0) > 1 && (
                    <p className={s.hint}>Versions: {q.data?.history[current.key].map((v) => `v${v}`).join(' · ')} — plans keep the version they started from.</p>
                  )}
                  <p className={s.hint}>KPIs to watch: {current.kpis.join(' · ') || '—'}</p>
                </div>
                <table className={s.table}>
                  <thead><tr><th>Line</th><th>Picks the account by</th><th>Default driver</th><th>Note</th></tr></thead>
                  <tbody>
                    {current.lines.map((l) => (
                      <tr key={l.key}>
                        <td>{l.label}{l.required && <> <Tag tone="warn">Required</Tag></>}</td>
                        <td className={s.hint}>{selectorText(l)}</td>
                        <td>{DRIVER_METHOD_LABEL[l.method]}{paramText(l) && <div className={s.hint}>{paramText(l)}</div>}</td>
                        <td className={s.hint}>{l.note ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className={`${s.surface} ${s.state}`}><p>Pick a template.</p></div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TemplateEditor({ draft, setDraft, locationId, onSaved }: {
  draft: BudgetTemplate; setDraft: (t: BudgetTemplate | null) => void; locationId: string; onSaved: (t: BudgetTemplate) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kpis, setKpis] = useState(draft.kpis.join(', '));
  const setLine = (i: number, patch: Partial<TemplateLine>) => setDraft({ ...draft, lines: draft.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const setSel = (i: number, patch: Partial<TemplateLine['selector']>) => setLine(i, { selector: { ...draft.lines[i].selector, ...patch } });

  const save = async () => {
    setBusy(true);
    setError(null);
    const res = await api.post<{ template: BudgetTemplate }>('/api/budgets/templates', {
      location_id: locationId,
      key: draft.key || null,
      based_on: draft.basedOn,
      name: draft.name,
      department_kind: draft.departmentKind,
      description: draft.description || null,
      kpis: kpis.split(',').map((k) => k.trim()).filter(Boolean),
      lines: draft.lines.map((l, i) => ({
        ...l,
        key: l.key || `line-${i + 1}`,
        selector: { types: l.selector.types, ...(l.selector.group ? { group: l.selector.group } : {}), ...(l.selector.name ? { name: l.selector.name } : {}), ...(l.selector.notName ? { notName: l.selector.notName } : {}) },
      })),
    });
    setBusy(false);
    if (res.error || !res.data) return setError(errText(res.error));
    toast(`Saved ${res.data.template.name} v${res.data.template.version}`);
    onSaved(res.data.template);
  };

  return (
    <div className={s.surface}>
      <div className={s.toolbar}>
        <span className={s.toolbarTitle}>{draft.key ? `Editing ${draft.name} — saves v${draft.version + 1}` : 'New template'}</span>
        <Button variant="quiet" onClick={() => setDraft(null)}>Cancel</Button>
        <Button variant="primary" onClick={save} disabled={busy || !draft.name.trim() || draft.lines.length === 0}>{busy ? 'Saving…' : 'Save template'}</Button>
      </div>
      <div style={{ padding: '12px 16px' }}>
        {error && <InlineNotice tone="neg" className={s.notice}>{error}</InlineNotice>}
        <div className={s.formGrid}>
          <Field label="Name"><Input value={draft.name} maxLength={120} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
          <Field label="Department kind">
            <Select value={draft.departmentKind} onChange={(e) => setDraft({ ...draft, departmentKind: e.target.value as DepartmentKind })}>
              {DEPARTMENT_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </Select>
          </Field>
          <Field label="Description"><Textarea rows={2} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field>
          <Field label="KPIs (comma-separated)"><Input value={kpis} onChange={(e) => setKpis(e.target.value)} /></Field>
        </div>
        <div className="t-cap" style={{ margin: '16px 0 4px' }}>Lines — accounts are picked by type, group and name pattern, never by number. Patterns: words separated by | (any of), * as a wildcard, up to 100 characters.</div>
        {draft.lines.map((l, i) => (
          <div key={i} className={s.lineEdit}>
            <Field label="Line"><Input value={l.label} onChange={(e) => setLine(i, { label: e.target.value })} /></Field>
            <Field label="Type">
              <Select value={l.selector.types[0]} onChange={(e) => setSel(i, { types: [e.target.value as AcctType] })}>
                {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </Select>
            </Field>
            <Field label="Group pattern"><Input maxLength={100} placeholder="e.g. marketing|ads" value={l.selector.group ?? ''} onChange={(e) => setSel(i, { group: e.target.value || undefined })} /></Field>
            <Field label="Name pattern"><Input maxLength={100} placeholder="e.g. salar|wage" value={l.selector.name ?? ''} onChange={(e) => setSel(i, { name: e.target.value || undefined })} /></Field>
            <Field label="Driver">
              <Select value={l.method} onChange={(e) => setLine(i, { method: e.target.value as DriverMethod })}>
                {DRIVER_METHODS.map((m) => <option key={m} value={m}>{DRIVER_METHOD_LABEL[m]}</option>)}
              </Select>
            </Field>
            <Button variant="quiet" aria-label={`Remove ${l.label}`} onClick={() => setDraft({ ...draft, lines: draft.lines.filter((_, j) => j !== i) })}>Remove</Button>
            {(l.method === 'PY_GROWTH' || l.method === 'PRIOR_BUDGET_GROWTH' || l.method === 'PCT_OF_REVENUE') && (
              <Field label={l.method === 'PCT_OF_REVENUE' ? '% of revenue' : 'Growth %'}>
                <Input inputMode="decimal" value={String(((l.method === 'PCT_OF_REVENUE' ? l.params.pctBps : l.params.growthBps) ?? 0) / 100)}
                  onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) setLine(i, { params: { ...l.params, [l.method === 'PCT_OF_REVENUE' ? 'pctBps' : 'growthBps']: Math.round(n * 100) } }); }} />
              </Field>
            )}
            <Field label="Note for owners"><Input value={l.note ?? ''} onChange={(e) => setLine(i, { note: e.target.value || undefined })} /></Field>
            <Field label="Required">
              <Select value={l.required ? 'yes' : 'no'} onChange={(e) => setLine(i, { required: e.target.value === 'yes' })}>
                <option value="no">Optional</option><option value="yes">Required</option>
              </Select>
            </Field>
          </div>
        ))}
        <Button icon="plus" onClick={() => setDraft({ ...draft, lines: [...draft.lines, { key: `line-${draft.lines.length + 1}`, label: 'New line', selector: { types: ['OPEX'] }, method: 'PY_GROWTH', params: { growthBps: 300 } }] })}>Add line</Button>
      </div>
    </div>
  );
}
