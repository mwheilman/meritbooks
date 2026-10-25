'use client';

import { useState } from 'react';
import { Button, Check, Drawer, Field, InlineNotice, Input, Select, Switch, Tag, WidgetState, count } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import type { FormTemplateRow } from '@/lib/fieldservice/completion-types';
import type { FormField, FormFieldType } from '@/lib/fieldservice/rules';
import { useAction, words } from '../common/useAction';

export interface FormTemplatesProps {
  templates: FormTemplateRow[];
  error: string | null;
  canEdit: boolean;
}

const TYPES: ReadonlyArray<[FormFieldType, string]> = [
  ['reading', 'Reading (with unit)'], ['number', 'Number'], ['pass_fail', 'Pass / fail'], ['check', 'Checkbox'], ['choice', 'Choice'], ['text', 'Text'], ['photo', 'Photo'],
];
const typeLabel = (t: FormFieldType | undefined) => TYPES.find(([k]) => k === t)?.[1] ?? 'Text';

function rangeText(f: FormField): string {
  const u = f.unit ? ` ${f.unit}` : '';
  if (f.min != null && f.max != null) return `${f.min}–${f.max}${u}`;
  if (f.min != null) return `≥ ${f.min}${u}`;
  if (f.max != null) return `≤ ${f.max}${u}`;
  return f.unit ?? '';
}

/**
 * Checklists and forms (FS-29): which forms techs fill on which visits, their required readings
 * with the accepted range, and the red-tag rules. A tech can't finish the visit until the required
 * readings are in; an out-of-range or failed red-tag item needs the customer's signature.
 */
export function FormTemplates(p: FormTemplatesProps) {
  const { readOnly } = useShell();
  const { run, busy, error } = useAction();
  const [open, setOpen] = useState<string | null>(null);
  const editable = p.canEdit && !readOnly;
  if (p.error) return <WidgetState state={{ kind: 'error', title: 'Checklists did not load', body: p.error }} />;
  if (p.templates.length === 0) {
    return <WidgetState state={{ kind: 'empty', title: 'No checklists yet', body: 'Load the starter setup on the Go-live screen to get maintenance, install-commissioning and safety checklists, then adjust them here.' }} />;
  }
  const current = p.templates.find((t) => t.id === open) ?? null;
  return (
    <div className="stack">
      {error && <InlineNotice tone="neg" title="Not saved.">{error}</InlineNotice>}
      <section className="fs-card" aria-label="Checklists">
        <table className="fs-table">
          <thead><tr><th>Checklist</th><th>Kind</th><th>Used on</th><th className="n">Fields</th><th className="n">Required</th><th>Signature</th><th>Active</th></tr></thead>
          <tbody>{p.templates.map((t) => (
            <tr key={t.id} data-click tabIndex={0} onClick={() => setOpen(t.id)} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(t.id); }}>
              <td><b>{t.name}</b><div className="t-cap">{`v${t.version}`}</div></td>
              <td>{words(t.kind)}</td>
              <td><span className="fs-flags">{[...t.wo_kinds, ...t.job_type_keys].slice(0, 4).map((k) => <Tag key={k}>{words(k)}</Tag>)}
                {t.wo_kinds.length + t.job_type_keys.length === 0 && <span className="t-cap">Any visit</span>}</span></td>
              <td className="n">{count(t.fields.length)}</td>
              <td className="n">{count(t.fields.filter((f) => f.required).length)}</td>
              <td>{t.requires_signature ? 'Required' : '—'}</td>
              <td onClick={(e) => e.stopPropagation()}>
                <Switch aria-label={`${t.name} active`} checked={t.is_active} disabled={!editable || busy === t.id}
                  onChange={(e) => void run(t.id, '/api/fieldservice/forms', { op: 'active', templateId: t.id, active: e.target.checked }, e.target.checked ? 'Checklist on' : 'Checklist off')} />
              </td>
            </tr>
          ))}</tbody>
        </table>
      </section>
      {current && <TemplateDrawer key={`${current.id}:${current.version}`} t={current} editable={editable} onClose={() => setOpen(null)} />}
    </div>
  );
}

function TemplateDrawer({ t, editable, onClose }: { t: FormTemplateRow; editable: boolean; onClose: () => void }) {
  const { run, busy, error } = useAction();
  const [fields, setFields] = useState<FormField[]>(t.fields);
  const [sig, setSig] = useState(t.requires_signature);
  const [editing, setEditing] = useState(false);
  const set = (i: number, patch: Partial<FormField>) => setFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const num = (s: string): number | undefined => (s.trim() === '' || Number.isNaN(Number(s)) ? undefined : Number(s));
  const keyOk = (k: string) => /^[a-z][a-z0-9_]{1,47}$/.test(k);
  const keys = fields.map((f) => f.key);
  const valid = fields.length > 0 && fields.every((f) => keyOk(f.key) && (f.label ?? '').trim().length > 0 && (f.min == null || f.max == null || f.min <= f.max))
    && new Set(keys).size === keys.length;
  const save = () => run<{ id: string; version: number }>('save', '/api/fieldservice/forms', { op: 'fields', templateId: t.id, fields, requiresSignature: sig },
    (r) => `Saved as version ${r.version}`).then((r) => { if (r) setEditing(false); });
  const add = () => setFields((fs) => [...fs, { key: `field_${fs.length + 1}`, label: '', type: 'reading', required: true }]);

  return (
    <Drawer open onClose={onClose} width={760} eyebrow={['Checklist', `v${t.version}`]} title={t.name} aria-label={t.name}>
      <div className="stack">
        {error && <InlineNotice tone="neg" title="Not saved.">{error}</InlineNotice>}
        {!editing ? (
          <>
            <ul className="fs-list">{t.fields.map((f) => (
              <li key={f.key}>
                <b>{f.label ?? f.key}</b>
                <span className="t-cap">{typeLabel(f.type)}</span>
                <span className="sp" />
                {rangeText(f) && <span className="fs-mono">{rangeText(f)}</span>}
                {f.required && <Tag tone="solid">Required</Tag>}
                {(f.red_tag_on_fail || f.red_tag_above != null || f.red_tag_below != null) && <Tag tone="neg">Red tag</Tag>}
              </li>
            ))}</ul>
            <p className="t-cap">{t.requires_signature ? 'Customer signature required at the end.' : 'No customer signature unless a red-tag item fails.'}</p>
            {editable && <div className="fs-toolbar"><span className="sp" style={{ flex: 1 }} /><Button onClick={() => setEditing(true)}>Edit fields</Button></div>}
          </>
        ) : (
          <>
            <p className="t-cap">Saving creates a new version. Forms already filled keep the version they were filled on.</p>
            <table className="fs-table">
              <thead><tr><th>Label</th><th>Key</th><th>Type</th><th>Unit</th><th>Min</th><th>Max</th><th>Required</th><th aria-label="Remove" /></tr></thead>
              <tbody>{fields.map((f, i) => (
                <tr key={i}>
                  <td><Input aria-label="Label" value={f.label ?? ''} onChange={(e) => set(i, { label: e.target.value })} /></td>
                  <td><Input aria-label="Key" value={f.key} invalid={!keyOk(f.key) || keys.indexOf(f.key) !== i} onChange={(e) => set(i, { key: e.target.value.toLowerCase() })} /></td>
                  <td><Select aria-label="Type" value={f.type ?? 'text'} onChange={(e) => set(i, { type: e.target.value as FormFieldType })}>
                    {TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></td>
                  <td><Input aria-label="Unit" value={f.unit ?? ''} onChange={(e) => set(i, { unit: e.target.value || undefined })} /></td>
                  <td><Input aria-label="Min" inputMode="decimal" value={f.min ?? ''} onChange={(e) => set(i, { min: num(e.target.value) })} /></td>
                  <td><Input aria-label="Max" inputMode="decimal" value={f.max ?? ''} onChange={(e) => set(i, { max: num(e.target.value) })} /></td>
                  <td><Check aria-label="Required" checked={!!f.required} onChange={(e) => set(i, { required: e.target.checked })} /></td>
                  <td><Button variant="quiet" aria-label={`Remove ${f.label || f.key}`} onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))}>Remove</Button></td>
                </tr>
              ))}</tbody>
            </table>
            <div className="fs-toolbar">
              <Button variant="quiet" onClick={add}>Add a field</Button>
              <Check label="Customer signature required" checked={sig} onChange={(e) => setSig(e.target.checked)} />
              <span className="sp" style={{ flex: 1 }} />
              <Button variant="quiet" onClick={() => { setFields(t.fields); setSig(t.requires_signature); setEditing(false); }}>Cancel</Button>
              <Button variant="primary" disabled={!valid || busy === 'save'} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save new version'}</Button>
            </div>
            {!valid && <p className="t-cap">Each field needs a label and a unique key (lowercase letters, digits, underscores), and min must not exceed max.</p>}
          </>
        )}
      </div>
    </Drawer>
  );
}
