'use client';

import { useMemo, useState } from 'react';
import { Button, Field, Input, Select, Seg, Tag, WidgetState } from '@meritbooks/merit-ui';
import { COST_TYPE_LABELS } from '@/lib/packs';
import type { CostCodeRow, CostType } from '@/lib/pm/types';
import { useAction } from '@/components/job/useAction';
import { useShell } from '@/components/shell/ShellContext';

const TYPES: CostType[] = ['LABOR', 'MATERIALS', 'SUBCONTRACTOR', 'EQUIPMENT', 'OTHER'];

/** The company cost-code library: pack codes read-only; your codes can be renamed or deactivated. */
export function CostCodesEditor({ companyId, codes }: { companyId: string; codes: CostCodeRow[] }) {
  const { readOnly } = useShell();
  const { run, busy } = useAction();
  const [show, setShow] = useState<'active' | 'all'>('active');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<CostType>('MATERIALS');
  const [err, setErr] = useState<Record<string, string>>({});
  const visible = useMemo(() => codes.filter((c) => show === 'all' || c.is_active), [codes, show]);
  const yours = codes.filter((c) => !c.install_id).length;

  const add = async () => {
    const e: Record<string, string> = {};
    if (!code.trim()) e.code = 'Give it a code.';
    if (!name.trim()) e.name = 'Give it a name.';
    if (codes.some((c) => c.code.toLowerCase() === code.trim().toLowerCase())) e.code = 'That code is already in the library.';
    setErr(e);
    if (Object.keys(e).length) return;
    const r = await run('add', 'post', '/api/cost-codes', { companyId, code: code.trim(), name: name.trim(), costType: type }, `Added ${code.trim()} ${name.trim()}`);
    if (!r.error) { setCode(''); setName(''); }
  };

  return (
    <div className="stack">
      <div className="row row--between">
        <span className="t-cap">{codes.filter((c) => c.is_active).length} active · {yours} added by you · pack codes change with Change setup</span>
        <Seg<'active' | 'all'> aria-label="Show" value={show} onChange={setShow} items={[{ value: 'active', label: 'Active' }, { value: 'all', label: 'All', count: codes.length }]} />
      </div>
      <div className="mp-table">
        {visible.length === 0 ? (
          <WidgetState state={{ kind: 'empty', title: 'The library is empty', body: 'Industry setup normally adds cost codes. Add your own below.' }} />
        ) : (
          <table className="tbl tbl-q tbl-q--compact">
            <colgroup><col style={{ width: 112 }} /><col /><col style={{ width: 144 }} /><col style={{ width: 104 }} /><col style={{ width: 136 }} /></colgroup>
            <thead><tr><th>Code</th><th>Name</th><th>Cost type</th><th>Source</th><th><span className="sr">Actions</span></th></tr></thead>
            <tbody>
              {visible.map((c) => (
                <CodeRow key={c.id} c={c} readOnly={readOnly} busy={busy === `c:${c.id}`} onSave={(patch, ok) => run(`c:${c.id}`, 'patch', `/api/cost-codes/${c.id}`, patch, ok)} />
              ))}
            </tbody>
          </table>
        )}
        {!readOnly && (
          <form className="mp-add" onSubmit={(e) => { e.preventDefault(); void add(); }}>
            <Field label="Code" error={err.code}><Input value={code} onChange={(e) => setCode(e.target.value)} maxLength={24} placeholder="09-100" style={{ width: 120 }} /></Field>
            <Field label="Name" error={err.name}><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Drywall labor" style={{ width: 240 }} /></Field>
            <Field label="Cost type">
              <Select value={type} onChange={(e) => setType(e.target.value as CostType)}>
                {TYPES.map((t) => <option key={t} value={t}>{COST_TYPE_LABELS[t]}</option>)}
              </Select>
            </Field>
            <Button type="submit" icon="plus" disabled={busy === 'add'}>Add cost code</Button>
          </form>
        )}
      </div>
    </div>
  );
}

function CodeRow({ c, readOnly, busy, onSave }: { c: CostCodeRow; readOnly: boolean; busy: boolean; onSave: (patch: Record<string, unknown>, ok: string) => Promise<unknown> }) {
  const [name, setName] = useState(c.name);
  const mine = !c.install_id;
  return (
    <tr className={c.is_active ? 'q-row' : 'q-row is-done'}>
      <td><span className="code">{c.code}</span></td>
      <td>
        {mine && !readOnly ? (
          <Input aria-label={`Name of ${c.code}`} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onBlur={() => { if (name.trim() && name !== c.name) void onSave({ name: name.trim() }, `Renamed ${c.code}`); }} />
        ) : (
          <span className="l1" style={{ fontWeight: 400 }}>{c.name}</span>
        )}
      </td>
      <td>{COST_TYPE_LABELS[c.cost_type]}</td>
      <td>{mine ? <Tag>Yours</Tag> : <Tag tone="ai">Pack</Tag>}</td>
      <td className="n">
        {mine && !readOnly ? (
          <Button variant="quiet" disabled={busy} onClick={() => void onSave({ isActive: !c.is_active }, c.is_active ? `Deactivated ${c.code}` : `Reactivated ${c.code}`)}>
            {c.is_active ? 'Deactivate' : 'Reactivate'}
          </Button>
        ) : !c.is_active ? (
          <span className="t-cap">Inactive</span>
        ) : null}
      </td>
    </tr>
  );
}
