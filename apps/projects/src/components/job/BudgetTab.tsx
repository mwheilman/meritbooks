'use client';

import { useMemo, useState } from 'react';
import {
  Button, ConfirmDialog, Field, Input, InlineNotice, MoneyInput, Select, StatementTable, Tag, WidgetState, money, pct, ratio,
  type StatementColumn, type StatementRow,
} from '@meritbooks/merit-ui';
import { COST_TYPE_LABELS } from '@/lib/packs';
import type { BudgetLineRow, BudgetRow, CostCodeRow, CostType } from '@/lib/pm/types';
import { useShell, useMoneyVis } from '@/components/shell/ShellContext';
import { useAction } from './useAction';

export interface BudgetTabProps {
  jobId: string;
  budgets: BudgetRow[];
  lines: BudgetLineRow[];
  currentId: string | null;
  effectiveId: string | null;
  draftId: string | null;
  costCodes: CostCodeRow[];
  contractCents: number;
  booksPresent: boolean;
}

const TYPES: CostType[] = ['LABOR', 'MATERIALS', 'SUBCONTRACTOR', 'EQUIPMENT', 'OTHER'];
const BOOKS_MSG = { sent: 'Sent the new cost estimate to Merit Books', no_books: 'Merit Books is not on, so it stays in Merit Projects', no_contract: 'Not sent to Merit Books yet: set the contract first' } as const;

function statement(lines: ReadonlyArray<BudgetLineRow>, base: ReadonlyArray<BudgetLineRow> | null, codes: Map<string, CostCodeRow>): StatementRow[] {
  const rows: StatementRow[] = [];
  const subs: string[] = [];
  const byCode = (ls: ReadonlyArray<BudgetLineRow>, ccId: string) => ls.filter((l) => l.cost_code_id === ccId).reduce((s, l) => s + l.amount_cents, 0);
  for (const t of TYPES) {
    const ccIds = [...new Set([...lines, ...(base ?? [])].map((l) => l.cost_code_id))].filter((id) => (codes.get(id)?.cost_type ?? 'OTHER') === t);
    if (!ccIds.length) continue;
    ccIds.sort((a, b) => (codes.get(a)?.code ?? '').localeCompare(codes.get(b)?.code ?? ''));
    rows.push({ kind: 'head', label: COST_TYPE_LABELS[t] });
    const ids: string[] = [];
    for (const cc of ccIds) {
      const c = codes.get(cc);
      const id = `${t}:${cc}`;
      ids.push(id);
      const now = byCode(lines, cc);
      const was = base ? byCode(base, cc) : null;
      rows.push({
        kind: 'line', id,
        label: <><span className="code">{c?.code}</span>{c?.name}</>,
        values: base ? [now, was, now - (was ?? 0)] : [now],
        bold: base && now !== was ? [2] : undefined,
      });
    }
    const sub = `${t}:sub`;
    subs.push(sub);
    const subNow = rows.filter((r) => 'id' in r && r.id && ids.includes(r.id)).reduce((s, r) => s + ((r as { values: ReadonlyArray<number | null> }).values[0] ?? 0), 0);
    const subWas = base ? rows.filter((r) => 'id' in r && r.id && ids.includes(r.id)).reduce((s, r) => s + ((r as { values: ReadonlyArray<number | null> }).values[1] ?? 0), 0) : 0;
    rows.push({ kind: 'sub', id: sub, label: `${COST_TYPE_LABELS[t]} total`, sumOf: ids, values: base ? [subNow, subWas, subNow - subWas] : [subNow] });
  }
  const total = lines.reduce((s, l) => s + l.amount_cents, 0);
  const totalWas = base ? base.reduce((s, l) => s + l.amount_cents, 0) : 0;
  rows.push({ kind: 'grand', label: 'Budget total', sumOf: subs, values: base ? [total, totalWas, total - totalWas] : [total] });
  return rows;
}

export function BudgetTab(p: BudgetTabProps) {
  // Cost-side tab (financials); the contract comparison needs contract_value too.
  const mv = useMoneyVis();
  const { readOnly } = useShell();
  const { run, busy } = useAction();
  const codes = useMemo(() => new Map(p.costCodes.map((c) => [c.id, c])), [p.costCodes]);
  const current = p.budgets.find((b) => b.id === p.currentId) ?? null;
  const effective = p.budgets.find((b) => b.id === p.effectiveId) ?? null;
  const draft = p.budgets.find((b) => b.id === p.draftId) ?? null;
  const lines = p.lines.filter((l) => l.budget_id === current?.id);
  const baseLines = draft?.kind === 'REVISED' && effective ? p.lines.filter((l) => l.budget_id === effective.id) : null;
  const [discardOpen, setDiscardOpen] = useState(false);
  const [removeLine, setRemoveLine] = useState<BudgetLineRow | null>(null);
  const url = `/api/jobs/${p.jobId}/budget`;

  if (!current) {
    return (
      <div className="surface">
        <WidgetState
          state={{
            kind: 'empty',
            title: 'Build the original budget',
            body: 'Budget by cost code from your company library. It becomes the cost estimate sent to Merit Books when you approve it.',
            action: readOnly ? undefined : (
              <Button variant="primary" disabled={busy === 'create'} onClick={() => void run('create', 'post', url, { op: 'create_original' }, 'Created the original budget')}>
                Create original budget
              </Button>
            ),
          }}
        />
      </div>
    );
  }

  const columns: StatementColumn[] = baseLines
    ? [
        { id: 'now', header: current.label ?? 'Revision', current: true, width: 136 },
        { id: 'was', header: 'Approved', width: 136 },
        { id: 'chg', header: 'Change', width: 120 },
      ]
    : [{ id: 'now', header: current.status === 'DRAFT' ? 'Draft' : 'Budget', current: true, width: 144 }];
  const total = lines.reduce((s, l) => s + l.amount_cents, 0);
  const share = ratio(total, p.contractCents);
  const editable = current.status === 'DRAFT' && !readOnly;

  return (
    <div className="stack">
      <div className="row row--between">
        <div className="row">
          <span className="t-head">{current.label ?? (current.kind === 'ORIGINAL' ? 'Original budget' : `Revision ${current.version}`)}</span>
          <Tag tone={current.status === 'DRAFT' ? 'warn' : 'pos'}>{current.status === 'DRAFT' ? 'Draft' : 'Approved'}</Tag>
          {current.as_of && <span className="t-cap">as of {current.as_of}</span>}
        </div>
        {!readOnly && (
          <div className="btn-row">
            {current.status === 'DRAFT' && current.kind === 'ORIGINAL' && (
              <Button variant="primary" disabled={busy === 'approve' || lines.length === 0} onClick={() => void run<{ books: keyof typeof BOOKS_MSG }>('approve', 'post', url, { op: 'approve_original', budgetId: current.id }, (d) => `Approved the budget. ${BOOKS_MSG[d.books]}`)}>
                Approve budget
              </Button>
            )}
            {current.status === 'DRAFT' && current.kind === 'REVISED' && (
              <>
                <Button onClick={() => setDiscardOpen(true)}>Discard revision</Button>
                <Button variant="primary" disabled={busy === 'save'} onClick={() => void run<{ books: keyof typeof BOOKS_MSG }>('save', 'post', `${url}/revise`, { op: 'save', budgetId: current.id }, (d) => `Saved ${current.label ?? 'the revision'}. ${BOOKS_MSG[d.books]}`)}>
                  Save revision
                </Button>
              </>
            )}
            {current.status === 'APPROVED' && (
              <Button variant="primary" disabled={busy === 'revise'} onClick={() => void run('revise', 'post', `${url}/revise`, { op: 'start' }, 'Started a revision with the approved lines')}>
                Revise budget
              </Button>
            )}
          </div>
        )}
      </div>

      {lines.length === 0 ? (
        <InlineNotice title="No lines yet.">Add the first cost codes below. Totals tie to the job’s cost estimate.</InlineNotice>
      ) : (
        <StatementTable
          aria-label="Budget by cost code"
          unitLabel="Cost code · in US dollars"
          columns={columns}
          rows={statement(lines, baseLines, codes)}
          caption={
            !mv.contract
              ? 'Totals tie.'
              : p.contractCents > 0
              ? `Budget is ${Number.isFinite(share) ? pct(share) : '—'} of the revised contract (${money(p.contractCents)}). Totals tie.`
              : 'Set the contract to compare the budget with it. Totals tie.'
          }
        />
      )}

      {editable ? (
        <LinesEditor jobId={p.jobId} budgetId={current.id} lines={lines} codes={p.costCodes} onRemove={setRemoveLine} />
      ) : current.status === 'APPROVED' && !readOnly ? (
        <p className="t-cap">Approved budgets are locked. Revise budget copies these lines into a draft you can change; saving it sends the new estimate to Merit Books.</p>
      ) : null}

      <ConfirmDialog
        open={discardOpen}
        onClose={() => setDiscardOpen(false)}
        tone="danger"
        title="Discard this revision"
        confirmLabel="Discard revision"
        onConfirm={async () => {
          const r = await run('discard', 'post', `${url}/revise`, { op: 'discard', budgetId: current.id }, 'Discarded the revision', { quietError: true });
          if (r.error) throw new Error(r.error.error);
        }}
      >
        The approved budget stays as it is. Changes in this draft are lost.
      </ConfirmDialog>
      <ConfirmDialog
        open={!!removeLine}
        onClose={() => setRemoveLine(null)}
        tone="danger"
        title="Remove this line"
        confirmLabel="Remove line"
        onConfirm={async () => {
          if (!removeLine) return;
          const r = await run('remove', 'post', url, { op: 'remove_line', lineId: removeLine.id }, 'Removed the line', { quietError: true });
          if (r.error) throw new Error(r.error.error);
        }}
      >
        {removeLine ? `${codes.get(removeLine.cost_code_id)?.code ?? ''} ${codes.get(removeLine.cost_code_id)?.name ?? ''}, ${money(removeLine.amount_cents)}.` : null}
      </ConfirmDialog>
    </div>
  );
}

function LinesEditor({ jobId, budgetId, lines, codes, onRemove }: { jobId: string; budgetId: string; lines: BudgetLineRow[]; codes: CostCodeRow[]; onRemove: (l: BudgetLineRow) => void }) {
  const { run, busy } = useAction();
  const url = `/api/jobs/${jobId}/budget`;
  const active = codes.filter((c) => c.is_active);
  const [cc, setCc] = useState(active[0]?.id ?? '');
  const [desc, setDesc] = useState('');
  const [amt, setAmt] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const add = async () => {
    if (!cc) return setErr('Pick a cost code.');
    if (amt == null) return setErr('Enter an amount.');
    setErr(null);
    const r = await run('add', 'post', url, { op: 'add_line', budgetId, costCodeId: cc, description: desc || null, amountCents: amt }, 'Added the line');
    if (!r.error) {
      setDesc('');
      setAmt(null);
    }
  };

  return (
    <section aria-label="Edit lines" className="mp-table">
      <table className="tbl tbl-q tbl-q--compact">
        <colgroup><col style={{ width: 280 }} /><col /><col style={{ width: 160 }} /><col style={{ width: 56 }} /></colgroup>
        <thead>
          <tr><th>Cost code</th><th>Description</th><th className="n">Amount</th><th><span className="sr">Remove</span></th></tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <LineRow key={l.id} line={l} codes={codes} onSave={(patch, ok) => run(`l:${l.id}`, 'post', url, { op: 'update_line', lineId: l.id, ...patch }, ok)} onRemove={() => onRemove(l)} />
          ))}
        </tbody>
      </table>
      <form className="mp-add" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <Field label="Cost code">
          <Select value={cc} onChange={(e) => setCc(e.target.value)} style={{ width: 260 }}>
            {active.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
          </Select>
        </Field>
        <Field label="Description"><Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Optional" maxLength={200} /></Field>
        <Field label="Amount" error={err ?? undefined}><MoneyInput valueCents={amt} onChangeCents={setAmt} allowNegative placeholder="0.00" style={{ width: 144 }} /></Field>
        <Button type="submit" icon="plus" disabled={busy === 'add'}>Add line</Button>
      </form>
    </section>
  );
}

function LineRow({ line, codes, onSave, onRemove }: { line: BudgetLineRow; codes: CostCodeRow[]; onSave: (patch: Record<string, unknown>, ok: string) => Promise<unknown>; onRemove: () => void }) {
  const [desc, setDesc] = useState(line.description ?? '');
  const [amt, setAmt] = useState<number | null>(line.amount_cents);
  return (
    <tr className="q-row">
      <td>
        <Select aria-label="Cost code" value={line.cost_code_id} onChange={(e) => void onSave({ costCodeId: e.target.value }, 'Changed the cost code')}>
          {codes.filter((c) => c.is_active || c.id === line.cost_code_id).map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
        </Select>
      </td>
      <td>
        <Input aria-label="Description" value={desc} maxLength={200} onChange={(e) => setDesc(e.target.value)} onBlur={() => { if (desc !== (line.description ?? '')) void onSave({ description: desc || null }, 'Saved the description'); }} />
      </td>
      <td className="n">
        <MoneyInput aria-label="Amount" valueCents={amt} allowNegative onChangeCents={setAmt} onBlur={() => { if (amt != null && amt !== line.amount_cents) void onSave({ amountCents: amt }, 'Saved the amount'); }} />
      </td>
      <td>
        <Button variant="quiet" iconOnly icon="x" aria-label="Remove line" onClick={onRemove} />
      </td>
    </tr>
  );
}
