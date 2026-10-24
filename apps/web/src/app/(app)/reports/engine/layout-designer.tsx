'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Button, ConfirmDialog, Field, InlineNotice, Input, Select, Check, toast, api } from '@meritbooks/merit-ui';
import { PageHeader } from '@/components/ui';
import { validateLayout } from '@/lib/reports/engine/layout';
import type { AccountType, LayoutRowDef } from '@/lib/reports/engine/types';
import type { LayoutSummary } from '@/lib/reports/engine/layouts-store';
import { useEngineMeta } from './use-engine';
import s from './engine.module.css';

const TYPES: AccountType[] = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'COGS', 'OPEX', 'OTHER'];
const TYPE_LABEL: Record<AccountType, string> = { ASSET: 'Assets', LIABILITY: 'Liabilities', EQUITY: 'Equity', REVENUE: 'Revenue', COGS: 'Cost of sales', OPEX: 'Operating expenses', OTHER: 'Other income / expense' };
const KIND_LABEL: Record<LayoutRowDef['kind'], string> = { header: 'Heading', accounts: 'Accounts', subtotal: 'Subtotal', formula: 'Formula', spacer: 'Spacer' };

export function templateRows(statement: 'PNL' | 'BS'): LayoutRowDef[] {
  if (statement === 'PNL') {
    return [
      { id: 'rev_h', kind: 'header', label: 'Revenue' },
      { id: 'rev', kind: 'accounts', label: 'Total revenue', select: { types: ['REVENUE'] }, sign: -1, expand: 'groups' },
      { id: 'cogs', kind: 'accounts', label: 'Total cost of sales', select: { types: ['COGS'] }, sign: 1, expand: 'groups' },
      { id: 'gp', kind: 'subtotal', label: 'Gross profit', of: [{ id: 'rev', sign: 1 }, { id: 'cogs', sign: -1 }], emphasis: 'sub' },
      { id: 'gm', kind: 'formula', label: 'Gross margin', expr: '{gp} / {rev} * 100', format: 'percent' },
      { id: 'opex', kind: 'accounts', label: 'Total operating expenses', select: { types: ['OPEX'] }, sign: 1, expand: 'groups' },
      { id: 'op', kind: 'subtotal', label: 'Operating income', of: [{ id: 'gp', sign: 1 }, { id: 'opex', sign: -1 }], emphasis: 'sub' },
      { id: 'oi', kind: 'accounts', label: 'Other income', select: { types: ['OTHER'], subTypes: ['OTHER_INCOME'] }, sign: -1, expand: 'accounts' },
      { id: 'oe', kind: 'accounts', label: 'Other expense', select: { types: ['OTHER'], subTypes: ['OTHER_EXPENSE'] }, sign: 1, expand: 'accounts' },
      { id: 'ni', kind: 'subtotal', label: 'Net income', of: [{ id: 'op', sign: 1 }, { id: 'oi', sign: 1 }, { id: 'oe', sign: -1 }], emphasis: 'grand' },
    ];
  }
  return [
    { id: 'ca', kind: 'accounts', label: 'Total current assets', select: { types: ['ASSET'], subTypes: ['CURRENT_ASSET'] }, sign: 1, expand: 'groups' },
    { id: 'nca', kind: 'accounts', label: 'Total non-current assets', select: { types: ['ASSET'], subTypes: ['FIXED_ASSET', 'OTHER_ASSET'] }, sign: 1, expand: 'groups' },
    { id: 'ta', kind: 'subtotal', label: 'Total assets', of: [{ id: 'ca', sign: 1 }, { id: 'nca', sign: 1 }], emphasis: 'grand' },
    { id: 'cl', kind: 'accounts', label: 'Total current liabilities', select: { types: ['LIABILITY'], subTypes: ['CURRENT_LIABILITY'] }, sign: -1, expand: 'groups' },
    { id: 'ltl', kind: 'accounts', label: 'Total long-term liabilities', select: { types: ['LIABILITY'], subTypes: ['LONG_TERM_LIABILITY'] }, sign: -1, expand: 'groups' },
    { id: 'eq', kind: 'accounts', label: 'Total equity', select: { types: ['EQUITY'], synthetic: ['re_prior', 'ni_current'] }, sign: -1, expand: 'accounts' },
    { id: 'tle', kind: 'subtotal', label: 'Total liabilities and equity', of: [{ id: 'cl', sign: 1 }, { id: 'ltl', sign: 1 }, { id: 'eq', sign: 1 }], emphasis: 'grand' },
  ];
}

/** "rev, -cogs" ⇄ [{id:'rev',sign:1},{id:'cogs',sign:-1}] */
export function parseOf(text: string): Array<{ id: string; sign: 1 | -1 }> {
  return text.split(',').map((x) => x.trim()).filter(Boolean).map((x) => (x.startsWith('-') ? { id: x.slice(1).trim(), sign: -1 as const } : { id: x.replace(/^\+/, '').trim(), sign: 1 as const }));
}
export function formatOf(of: Array<{ id: string; sign: 1 | -1 }>): string {
  return of.map((o) => (o.sign === -1 ? `-${o.id}` : o.id)).join(', ');
}
function parseRanges(text: string): Array<{ from: string; to: string }> {
  return text.split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const [from, to] = x.split(/\s*[-–]\s*/);
    return { from: (from ?? '').trim(), to: (to ?? from ?? '').trim() };
  });
}
const formatRanges = (r?: Array<{ from: string; to: string }>) => (r ?? []).map((x) => (x.from === x.to ? x.from : `${x.from}-${x.to}`)).join(', ');

let seq = 0;
const newId = (kind: string) => `${kind.slice(0, 3)}_${Date.now().toString(36).slice(-4)}${seq++}`;

/** Custom statement layouts (row designer MVP, FPB A-3A AC3A.24). */
export function LayoutDesigner() {
  const meta = useEngineMeta();
  const [editing, setEditing] = useState<{ id?: string; name: string; statement: 'PNL' | 'BS'; rows: LayoutRowDef[] } | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<LayoutSummary | null>(null);
  const issues = useMemo(() => (editing ? validateLayout(editing.rows, editing.statement) : []), [editing]);
  const layouts = meta.data?.layouts ?? [];

  const patchRow = (i: number, row: LayoutRowDef) => setEditing((e) => (e ? { ...e, rows: e.rows.map((r, j) => (j === i ? row : r)) } : e));
  const move = (i: number, d: number) => setEditing((e) => {
    if (!e) return e;
    const rows = [...e.rows];
    const j = i + d;
    if (j < 0 || j >= rows.length) return e;
    [rows[i], rows[j]] = [rows[j], rows[i]];
    return { ...e, rows };
  });
  const remove = (i: number) => setEditing((e) => (e ? { ...e, rows: e.rows.filter((_, j) => j !== i) } : e));
  const add = (kind: LayoutRowDef['kind']) => setEditing((e) => {
    if (!e) return e;
    const id = newId(kind);
    const row: LayoutRowDef =
      kind === 'header' ? { id, kind, label: 'New heading' }
      : kind === 'accounts' ? { id, kind, label: 'New line', select: { types: [e.statement === 'PNL' ? 'OPEX' : 'ASSET'] }, sign: e.statement === 'PNL' ? 1 : 1, expand: 'accounts' }
      : kind === 'subtotal' ? { id, kind, label: 'New subtotal', of: e.rows.filter((r) => r.kind === 'accounts').slice(0, 1).map((r) => ({ id: r.id, sign: 1 as const })) }
      : kind === 'formula' ? { id, kind, label: 'New ratio', expr: '{' + (e.rows.find((r) => r.kind !== 'spacer' && r.kind !== 'header')?.id ?? 'rev') + '} * 1', format: 'amount' }
      : { id, kind: 'spacer' };
    setActive(id);
    return { ...e, rows: [...e.rows, row] };
  });

  const save = async () => {
    if (!editing || issues.length) return;
    setBusy(true);
    const body = { name: editing.name.trim(), statement: editing.statement, rows: editing.rows };
    const r = editing.id ? await api.patch(`/api/reports/engine/layouts/${editing.id}`, body) : await api.post('/api/reports/engine/layouts', body);
    setBusy(false);
    if (r.error) { toast.error(r.error.error); return; }
    toast(`Saved “${body.name}”. Choose it under Layout on any ${editing.statement === 'PNL' ? 'P&L' : 'balance sheet'}.`);
    setEditing(null);
    meta.reload();
  };

  const archive = async (l: LayoutSummary) => {
    const r = await api.delete(`/api/reports/engine/layouts/${l.id}`);
    setConfirm(null);
    if (r.error) { toast.error(r.error.error); return; }
    toast(`Archived “${l.name}”.`);
    meta.reload();
  };

  const rowEditor = (r: LayoutRowDef, i: number) => {
    const issue = issues.find((x) => x.rowId === r.id);
    return (
      <div key={r.id + i} className={s.dRow} data-active={active === r.id} onFocus={() => setActive(r.id)}>
        <div className={s.dRowKind}>{KIND_LABEL[r.kind]}<div className="t-cap" style={{ textTransform: 'none', letterSpacing: 0 }}>{r.id}</div></div>
        <div>
          <div className={s.dFields}>
            {r.kind !== 'spacer' && <Field label="Label"><Input value={r.label} onChange={(e) => patchRow(i, { ...r, label: e.target.value })} /></Field>}
            {r.kind !== 'spacer' && <Field label="Row id (for subtotals and formulas)"><Input value={r.id} onChange={(e) => patchRow(i, { ...r, id: e.target.value.toLowerCase() } as LayoutRowDef)} /></Field>}
            {r.kind === 'accounts' && (
              <>
                <Field label="Sign"><Select value={String(r.sign)} onChange={(e) => patchRow(i, { ...r, sign: Number(e.target.value) as 1 | -1 })}><option value="-1">Credit positive (revenue, liabilities, equity)</option><option value="1">Debit positive (assets, costs)</option></Select></Field>
                <Field label="Show"><Select value={r.expand ?? 'groups'} onChange={(e) => patchRow(i, { ...r, expand: e.target.value as 'accounts' | 'groups' | 'none' })}><option value="groups">Groups, then accounts</option><option value="accounts">Each account</option><option value="none">One line</option></Select></Field>
                <Field label="Account numbers (e.g. 6000-6499, 6810)"><Input value={formatRanges(r.select.ranges)} onChange={(e) => patchRow(i, { ...r, select: { ...r.select, ranges: e.target.value ? parseRanges(e.target.value) : undefined } })} /></Field>
                <Field label="Account roles">
                  <Select multiple value={r.select.roles ?? []} onChange={(e) => patchRow(i, { ...r, select: { ...r.select, roles: Array.from(e.target.selectedOptions).map((o) => o.value) } })} style={{ height: 88 }}>
                    {(meta.data?.roles ?? []).map((x) => <option key={x} value={x}>{x.toLowerCase().replace(/_/g, ' ')}</option>)}
                  </Select>
                </Field>
                <Field label="Account groups">
                  <Select multiple value={r.select.groupIds ?? []} onChange={(e) => patchRow(i, { ...r, select: { ...r.select, groupIds: Array.from(e.target.selectedOptions).map((o) => o.value) } })} style={{ height: 88 }}>
                    {(meta.data?.accountGroups ?? []).filter((g) => (editing?.statement === 'PNL') === ['REVENUE', 'COGS', 'OPEX', 'OTHER'].includes(g.type)).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </Select>
                </Field>
              </>
            )}
            {r.kind === 'subtotal' && <Field label="Adds rows (use − to subtract: rev, -cogs)"><Input value={formatOf(r.of)} onChange={(e) => patchRow(i, { ...r, of: parseOf(e.target.value) })} /></Field>}
            {r.kind === 'subtotal' && <Field label="Weight"><Select value={r.emphasis ?? 'sub'} onChange={(e) => patchRow(i, { ...r, emphasis: e.target.value as 'sub' | 'grand' })}><option value="sub">Subtotal</option><option value="grand">Grand total</option></Select></Field>}
            {r.kind === 'formula' && <Field label="Formula ({row} + − × ÷ numbers)"><Input value={r.expr} onChange={(e) => patchRow(i, { ...r, expr: e.target.value })} /></Field>}
            {r.kind === 'formula' && <Field label="Shown as"><Select value={r.format} onChange={(e) => patchRow(i, { ...r, format: e.target.value as 'amount' | 'percent' })}><option value="amount">Amount</option><option value="percent">Percent</option></Select></Field>}
          </div>
          {r.kind === 'accounts' && (
            <div className={s.toggles} style={{ marginTop: 8 }}>
              {TYPES.filter((t) => (editing?.statement === 'PNL') === ['REVENUE', 'COGS', 'OPEX', 'OTHER'].includes(t)).map((t) => (
                <Check key={t} label={TYPE_LABEL[t]} checked={(r.select.types ?? []).includes(t)} onChange={(e) => patchRow(i, { ...r, select: { ...r.select, types: e.target.checked ? [...(r.select.types ?? []), t] : (r.select.types ?? []).filter((x) => x !== t) } })} />
              ))}
              {editing?.statement === 'BS' && (
                <Check label="Earnings not yet closed" checked={!!r.select.synthetic?.length} onChange={(e) => patchRow(i, { ...r, select: { ...r.select, synthetic: e.target.checked ? ['re_prior', 'ni_current'] : undefined } })} />
              )}
            </div>
          )}
          {issue && <p className={s.issue}>{issue.message}</p>}
        </div>
        <div className={s.dBtns}>
          <Button variant="quiet" iconOnly icon="up" aria-label="Move up" onClick={() => move(i, -1)} disabled={i === 0} />
          <Button variant="quiet" iconOnly icon="down" aria-label="Move down" onClick={() => move(i, 1)} disabled={i === (editing?.rows.length ?? 0) - 1} />
          <Button variant="quiet" iconOnly icon="x" aria-label="Remove row" onClick={() => remove(i)} />
        </div>
      </div>
    );
  };

  return (
    <div>
      <Link href="/reports" className="btn btn--quiet" style={{ marginBottom: 8 }}>← Report library</Link>
      <PageHeader eyebrow={['Reports', 'Statement layouts']} title="Statement layouts" description="Design your own P&L or balance sheet: choose the rows, the accounts each row pulls, subtotals and ratios. Use it on any statement, any period, any company." />
      {meta.error && <InlineNotice tone="neg" title="Couldn't load layouts.">{meta.error} <Button variant="quiet" onClick={meta.reload}>Try again</Button></InlineNotice>}
      <div className={s.designer}>
        <aside className={s.side}>
          <div className={s.sideSec}>
            <h2 className="eyebrow" style={{ margin: 0 }}>Your layouts</h2>
            {meta.loading && !meta.data ? <p className={s.empty}>Loading…</p> : layouts.length === 0 ? <p className={s.empty}>No custom layouts yet.</p> : (
              <ul className={s.sideList}>
                {layouts.map((l) => (
                  <li key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <button type="button" className={s.sideLink} onClick={() => setEditing({ id: l.id, name: l.name, statement: l.statement, rows: l.rows })}><span>{l.name}</span><span>{l.statement === 'PNL' ? 'P&L' : 'Balance sheet'}</span></button>
                    <Button variant="quiet" iconOnly icon="x" aria-label={`Archive ${l.name}`} onClick={() => setConfirm(l)} />
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className={s.sideSec}>
            <Button onClick={() => setEditing({ name: 'My P&L', statement: 'PNL', rows: templateRows('PNL') })} icon="plus">New P&L layout</Button>
            <div style={{ height: 8 }} />
            <Button onClick={() => setEditing({ name: 'My balance sheet', statement: 'BS', rows: templateRows('BS') })} icon="plus">New balance sheet layout</Button>
          </div>
        </aside>
        <section>
          {!editing ? (
            <div className={s.stateBox}>
              <h2 className="t-section">Choose a layout or start a new one</h2>
              <p>New layouts start from the standard statement. Rows pull accounts by type, group, role or number range; an account appears in the first row that selects it, and any account with activity that no row selects is flagged on the statement — nothing is dropped silently.</p>
            </div>
          ) : (
            <>
              <div className={s.toolbar}>
                <Field label="Name"><Input value={editing.name} maxLength={120} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
                <span className="t-cap">{editing.statement === 'PNL' ? 'Profit and loss layout' : 'Balance sheet layout'} · {editing.rows.length} rows</span>
                <div className={s.tGrow} />
                {(['header', 'accounts', 'subtotal', 'formula', 'spacer'] as const).map((k) => <Button key={k} variant="quiet" icon="plus" onClick={() => add(k)}>{KIND_LABEL[k]}</Button>)}
                <Button variant="quiet" onClick={() => setEditing(null)}>Cancel</Button>
                <Button variant="primary" disabled={busy || issues.length > 0 || !editing.name.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save layout'}</Button>
              </div>
              {issues.length > 0 && <InlineNotice className={s.notice} tone="warn" title={`${issues.length} thing${issues.length === 1 ? '' : 's'} to fix before saving.`}>{issues[0].message}</InlineNotice>}
              <div className={s.dRows}>{editing.rows.map(rowEditor)}</div>
              {editing.id && <p className="t-cap" style={{ marginTop: 8 }}>Preview: <Link href={`/reports?report=${editing.statement === 'PNL' ? 'pnl' : 'bs'}&p=year&asof=${new Date().toISOString().slice(0, 10)}&cols=single&r=units&layout=${editing.id}`}>open a {editing.statement === 'PNL' ? 'P&L' : 'balance sheet'} with this layout</Link> (save first to see changes).</p>}
            </>
          )}
        </section>
      </div>
      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={`Archive “${confirm?.name ?? ''}”?`}
        confirmLabel="Archive layout"
        onConfirm={() => { if (confirm) return archive(confirm); }}
      >
        Statements and saved views using it fall back to the standard layout.
      </ConfirmDialog>
    </div>
  );
}
