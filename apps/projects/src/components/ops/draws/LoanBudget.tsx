'use client';

import { useState } from 'react';
import { Button, Check, Field, Input, MoneyInput, Select, money, shortDate } from '@meritbooks/merit-ui';
import { CATEGORY_WORDS } from '@/lib/pm/ops/draw-math';
import { DRAW_CATEGORIES, type DrawBudgetLineRow, type DrawCategory, type DrawLineStatusRow, type DrawScheduleRow } from '@/lib/pm/ops/types';
import type { DrawRevision } from '@/lib/pm/ops/development-queries';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '../common/bits';
import { useOps } from '../common/useOps';

/**
 * The loan budget: editable line by line while DRAFT, then reallocated only with a reason
 * (pm.revise_draw_budget_line keeps the audit the lender asks for).
 */
export function LoanBudget({ schedule, lines, status, revisions, today }: { schedule: DrawScheduleRow; lines: DrawBudgetLineRow[]; status: DrawLineStatusRow[]; revisions: DrawRevision[]; today: string }) {
  const { readOnly } = useShell();
  const { act, busy, error } = useOps();
  const url = `/api/ops/draw-schedules/${schedule.id}`;
  const draft = schedule.status === 'DRAFT';
  const [desc, setDesc] = useState('');
  const [cat, setCat] = useState<DrawCategory>('HARD');
  const [amt, setAmt] = useState<number | null>(null);
  const [revising, setRevising] = useState<string | null>(null);
  const [revAmt, setRevAmt] = useState<number | null>(null);
  const [revWhy, setRevWhy] = useState('');
  const total = lines.reduce((s, l) => s + (l.revised_cents ?? l.original_cents), 0);
  const drawnOf = new Map(status.map((s) => [s.draw_budget_line_id, s]));
  const nameOf = new Map(lines.map((l) => [l.id, `${l.line_no}. ${l.description}`]));
  const sources = schedule.loan_commitment_cents + schedule.equity_required_cents;

  if (readOnly && !draft && revisions.length === 0) return null;
  return (
    <Section title={draft ? 'Loan budget (draft)' : 'Reallocations'} meta={draft ? `${money(total)} budget · ${money(sources)} loan plus equity` : `${revisions.length} recorded`}
      actions={draft && !readOnly ? <Button variant="primary" disabled={!lines.length || busy === 'activate'} onClick={() => void act('activate', 'post', url, { op: 'activate' }, `Activated the loan budget with ${schedule.lender_name}`)}>Activate</Button> : undefined}>
      <Failure text={error} />
      {draft && total !== sources && lines.length > 0 && <p className="t-cap" style={{ marginBottom: 8 }}>The budget is {money(total - sources)} {total > sources ? 'more' : 'less'} than loan plus equity. Lenders expect uses to equal sources at closing.</p>}
      <div className="mp-table">
        <table className="ops-mini">
          <thead><tr><th>#</th><th>Line</th><th>Category</th><th className="n">{draft ? 'Amount' : 'Revised'}</th>{!draft && <th className="n">Drawn</th>}<th>{draft ? 'Retainage' : ''}</th>{!readOnly && <th />}</tr></thead>
          <tbody>
            {lines.length === 0 && <tr><td colSpan={7} className="t-cap">No lines yet. Add land, hard cost, soft cost, financing, interest reserve and contingency lines.</td></tr>}
            {lines.map((l) => {
              const st = drawnOf.get(l.id);
              return (
                <tr key={l.id}>
                  <td className="ops-num">{l.line_no}</td>
                  <td>{l.description}</td>
                  <td>{draft && !readOnly ? (
                    <Select aria-label={`Category of ${l.description}`} value={l.category} onChange={(e) => void act('line', 'post', url, { op: 'update_line', lineId: l.id, category: e.target.value }, 'Saved the category')}>
                      {DRAW_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_WORDS[c]}</option>)}
                    </Select>
                  ) : CATEGORY_WORDS[l.category]}</td>
                  <td className="n">{draft && !readOnly ? (
                    <AmountCell label={`Amount of ${l.description}`} value={l.original_cents} onSave={(c) => void act('line', 'post', url, { op: 'update_line', lineId: l.id, originalCents: c }, 'Saved the amount')} />
                  ) : money(l.revised_cents ?? l.original_cents)}</td>
                  {!draft && <td className="n">{st ? money(st.drawn_cents) : '—'}</td>}
                  <td>{draft ? (
                    readOnly ? (l.retainage_applies ? 'Held' : '—') : <Check aria-label={`Lender holds retainage on ${l.description}`} checked={!!l.retainage_applies} onChange={(e) => void act('line', 'post', url, { op: 'update_line', lineId: l.id, retainageApplies: e.target.checked }, 'Saved')} />
                  ) : null}</td>
                  {!readOnly && (
                    <td>{draft
                      ? <Button variant="quiet" iconOnly icon="x" aria-label={`Remove ${l.description}`} onClick={() => void act('line', 'post', url, { op: 'remove_line', lineId: l.id }, 'Removed the line')} />
                      : <Button variant="quiet" onClick={() => { setRevising(l.id); setRevAmt(l.revised_cents ?? l.original_cents); setRevWhy(''); }}>Reallocate</Button>}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
          {lines.length > 0 && <tfoot><tr><td /><td>Total</td><td /><td className="n">{money(total)}</td>{!draft && <td className="n">{money(status.reduce((s, x) => s + x.drawn_cents, 0))}</td>}<td />{!readOnly && <td />}</tr></tfoot>}
        </table>
        {draft && !readOnly && (
          <form className="mp-add" onSubmit={(e) => { e.preventDefault(); if (desc.trim() && amt != null) void act('line', 'post', url, { op: 'add_line', description: desc.trim(), category: cat, originalCents: amt }, `Added ${desc.trim()}`).then((r) => { if (r) { setDesc(''); setAmt(null); } }); }}>
            <Field label="New line"><Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Site work" maxLength={200} style={{ width: 240 }} /></Field>
            <Field label="Category"><Select value={cat} onChange={(e) => setCat(e.target.value as DrawCategory)}>{DRAW_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_WORDS[c]}</option>)}</Select></Field>
            <Field label="Amount"><MoneyInput valueCents={amt} onChangeCents={setAmt} placeholder="0.00" style={{ width: 150 }} /></Field>
            <Button type="submit" icon="plus" disabled={!desc.trim() || amt == null || busy === 'line'}>Add line</Button>
          </form>
        )}
        {revising && !readOnly && (
          <form className="mp-add" onSubmit={(e) => { e.preventDefault(); if (revAmt != null && revWhy.trim()) void act('rev', 'post', url, { op: 'revise_line', lineId: revising, revisedCents: revAmt, reason: revWhy.trim() }, 'Reallocated the line').then((r) => { if (r) setRevising(null); }); }}>
            <span className="b" style={{ alignSelf: 'center' }}>{nameOf.get(revising)}</span>
            <Field label="New amount"><MoneyInput autoFocus valueCents={revAmt} onChangeCents={setRevAmt} style={{ width: 150 }} /></Field>
            <Field label="Reason (the lender sees it)"><Input value={revWhy} onChange={(e) => setRevWhy(e.target.value)} placeholder="Move 18,000 from contingency to framing per CO-3" maxLength={500} style={{ width: 320 }} /></Field>
            <Button onClick={() => setRevising(null)}>Back</Button>
            <Button type="submit" variant="primary" disabled={revAmt == null || !revWhy.trim() || busy === 'rev'}>Reallocate</Button>
          </form>
        )}
      </div>
      {!draft && revisions.length > 0 && (
        <ul className="feed" style={{ marginTop: 12, border: '1px solid var(--line)', background: 'var(--white)' }}>
          {revisions.map((r) => (
            <li key={r.id}>
              <span><span className="l1" style={{ fontWeight: 400 }}>{nameOf.get(r.draw_budget_line_id) ?? 'Line'}: {money(r.from_cents)} to {money(r.to_cents)} ({money(r.to_cents - r.from_cents)})</span><span className="l2">{r.reason}</span></span>
              <span className="t">{shortDate(r.created_at.slice(0, 10), today)}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function AmountCell({ label, value, onSave }: { label: string; value: number; onSave: (cents: number) => void }) {
  const [v, setV] = useState<number | null>(value);
  return <MoneyInput aria-label={label} valueCents={v} onChangeCents={setV} onBlur={() => { if (v != null && v >= 0 && v !== value) onSave(v); }} style={{ width: 150 }} />;
}
