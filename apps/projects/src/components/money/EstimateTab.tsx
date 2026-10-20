'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Button, Check, ConfirmDialog, Field, Input, InlineNotice, KV, MoneyInput, Select, Tag, WidgetState, money, shortDate,
} from '@meritbooks/merit-ui';
import type { CostCodeRow } from '@/lib/pm/types';
import type { EstimateLineRow, EstimateRow } from '@/lib/pm/money/types';
import { estimateLineValues } from '@/lib/pm/money/estimate-lines';
import { estimateTotals } from '@/lib/pm/money/summaries';
import { estimateMark } from '@/lib/pm/money/status';
import { useShell, useVocab } from '@/components/shell/ShellContext';
import { useAction } from '@/components/job/useAction';
import { lower } from '@/lib/pm/vocab';
import { MarkStatus, m, p, parsePct, pctInput } from './common';

export interface EstimateTabProps {
  jobId: string;
  estimates: EstimateRow[];
  lines: EstimateLineRow[];
  costCodes: CostCodeRow[];
  /** The job's revised contract and current budget total (v_project_list), for the accepted notice. */
  contractCents: number;
  budgetCents: number | null;
  booksPresent: boolean;
}

interface AcceptOut { budgetId: string; contractId: string | null; contractCreated: boolean; progressSent: boolean; totalCents: number; costCents: number }

/** The version to open: the open draft, else the one with the customer, else the accepted one, else the newest. */
function pickInitial(es: ReadonlyArray<EstimateRow>): string | null {
  return (es.find((e) => e.status === 'DRAFT') ?? es.find((e) => e.status === 'SENT') ?? es.find((e) => e.status === 'ACCEPTED') ?? es[0])?.id ?? null;
}

export function EstimateTab(p0: EstimateTabProps) {
  const v = useVocab();
  const { readOnly } = useShell();
  const { run, busy } = useAction();
  const [selId, setSelId] = useState<string | null>(pickInitial(p0.estimates));
  const [confirm, setConfirm] = useState<null | 'accept' | 'decline' | 'delete'>(null);
  const [accepted, setAccepted] = useState<AcceptOut | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const sel = p0.estimates.find((e) => e.id === selId) ?? p0.estimates[0] ?? null;
  const lines = useMemo(() => p0.lines.filter((l) => l.estimate_id === sel?.id), [p0.lines, sel?.id]);
  const totals = estimateTotals(lines);
  const codes = useMemo(() => new Map(p0.costCodes.map((c) => [c.id, c])), [p0.costCodes]);
  const open = p0.estimates.some((e) => e.status === 'DRAFT' || e.status === 'SENT');
  const url = sel ? `/api/estimates/${sel.id}` : '';

  const create = async () => {
    const r = await run<{ estimateId: string; number: string }>('create', 'post', `/api/jobs/${p0.jobId}/estimates`, { title: newTitle.trim() || v.estimate }, (d) => `Created ${d.number}`);
    if (r.data) {
      setSelId(r.data.estimateId);
      setNewTitle('');
    }
  };

  if (p0.estimates.length === 0) {
    return (
      <div className="surface">
        <WidgetState
          state={{
            kind: 'empty',
            title: `Price this ${lower(v.job)}`,
            body: `Lines by cost code with quantity, unit cost and markup. When the customer accepts, the cost becomes the original budget and the price becomes the contract.`,
            action: readOnly ? undefined : (
              <form className="row" onSubmit={(e) => { e.preventDefault(); void create(); }}>
                <Input aria-label="Estimate title" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder={`${v.estimate} title`} maxLength={200} style={{ width: 240 }} />
                <Button variant="primary" type="submit" icon="plus" disabled={busy === 'create'}>New {lower(v.estimate)}</Button>
              </form>
            ),
          }}
        />
      </div>
    );
  }

  const mark = sel ? estimateMark(sel.status) : null;
  const draft = sel?.status === 'DRAFT' && !readOnly;
  const canDeleteDraft = sel?.status === 'DRAFT' && (!sel.supersedes_id || p0.estimates.find((e) => e.id === sel.supersedes_id)?.status === 'ACCEPTED');

  return (
    <div className="grid-12" style={{ rowGap: 24, alignItems: 'start' }}>
      <aside style={{ gridColumn: 'span 3' }} aria-label={`${v.estimates} and versions`}>
        <div className="sec">
          <div className="sec-h"><h2 className="t-section">Versions</h2></div>
          <ul className="versions">
            {p0.estimates.map((e) => {
              const mk = estimateMark(e.status);
              return (
                <li key={e.id} className={e.id === sel?.id ? 'is-current' : undefined}>
                  <span className={e.id === sel?.id ? 'code tnum b' : 'code tnum'} aria-hidden="true">v{e.version}</span>
                  <button type="button" className="nlink" style={{ textAlign: 'left', background: 'none', border: 0, padding: 0, cursor: 'pointer', minWidth: 0 }} aria-current={e.id === sel?.id} onClick={() => setSelId(e.id)}>
                    <span className="l1">{e.title}</span>
                    <span className="l2"><span className="code">{e.number}</span> · {mk.word}</span>
                  </button>
                  <span className="tnum">{money(e.total_cents, { decimals: 0 })}</span>
                </li>
              );
            })}
          </ul>
          {!readOnly && !open && (
            <form className="row" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); void create(); }}>
              <Input aria-label="New estimate title" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Title" maxLength={200} />
              <Button type="submit" icon="plus" disabled={busy === 'create'}>New</Button>
            </form>
          )}
        </div>
      </aside>

      {sel && mark && (
        <section style={{ gridColumn: 'span 9' }} className="stack" aria-label={`${sel.number} version ${sel.version}`}>
          <div className="row row--between" style={{ alignItems: 'flex-end' }}>
            <div>
              <div className="row">
                <span className="t-head">{sel.title}</span>
                <MarkStatus mark={mark} />
              </div>
              <p className="t-cap" style={{ marginTop: 4 }}>
                <span className="code">{sel.number}</span> v{sel.version}
                {sel.sent_at ? ` · sent ${shortDate(sel.sent_at.slice(0, 10))}` : ''}
                {sel.valid_until ? ` · valid until ${shortDate(sel.valid_until)}` : ''}
                {sel.retainage_pct != null ? ` · ${p(sel.retainage_pct)} retainage` : ''}
              </p>
            </div>
            {!readOnly && (
              <div className="btn-row">
                {canDeleteDraft && <Button variant="quiet" onClick={() => setConfirm('delete')}>Delete draft</Button>}
                {(sel.status === 'DRAFT' || sel.status === 'SENT') && <Button onClick={() => setConfirm('decline')}>Declined</Button>}
                {sel.status !== 'SUPERSEDED' && sel.status !== 'DRAFT' && (
                  <Button disabled={busy === 'revise'} onClick={() => void run<{ estimateId: string }>('revise', 'post', url, { op: 'revise' }, `Started v${sel.version + 1} with the same lines`).then((r) => r.data && setSelId(r.data.estimateId))}>Revise</Button>
                )}
                {sel.status === 'DRAFT' && (
                  <Button disabled={busy === 'send' || lines.length === 0} onClick={() => void run('send', 'post', url, { op: 'send' }, `Marked ${sel.number} sent to the customer`)}>Mark sent</Button>
                )}
                {(sel.status === 'DRAFT' || sel.status === 'SENT') && (
                  <Button variant="primary" disabled={busy === 'accept' || lines.length === 0 || totals.sell <= 0} onClick={() => setConfirm('accept')}>Accepted</Button>
                )}
              </div>
            )}
          </div>

          <div className="row" style={{ gap: 32, alignItems: 'flex-start' }}>
            <KV items={[
              { term: 'Price', value: m(totals.sell) },
              { term: 'Cost', value: m(totals.cost) },
              { term: 'Margin', value: `${m(totals.margin)} · ${p(totals.marginPct)}` },
            ]} />
            <KV items={[
              { term: 'Allowances in price', value: m(totals.allowances) },
              { term: 'Lines', value: String(lines.length) },
              { term: 'Becomes', value: sel.status === 'ACCEPTED' ? 'Budget and contract' : 'Budget and contract on acceptance' },
            ]} />
          </div>

          {totals.uncoded > 0 && (
            <InlineNotice tone="warn" title={`${totals.uncoded} costed ${totals.uncoded === 1 ? 'line has' : 'lines have'} no cost code.`}>
              The budget is built by cost code, so every line with a cost needs one before the estimate can be accepted.
            </InlineNotice>
          )}

          {(sel.status === 'ACCEPTED' || accepted) && (
            <AcceptedNotice jobId={p0.jobId} estimate={sel} result={accepted?.budgetId === sel.budget_id ? accepted : null} contractCents={p0.contractCents} budgetCents={p0.budgetCents} booksPresent={p0.booksPresent} />
          )}
          {sel.status === 'DECLINED' && (
            <InlineNotice title={`Declined ${sel.declined_at ? shortDate(sel.declined_at.slice(0, 10)) : ''}.`}>
              {sel.decline_reason ? `Reason: ${sel.decline_reason}. ` : ''}Revise it to send the customer a new version.
            </InlineNotice>
          )}

          <LinesTable estimateId={sel.id} lines={lines} codes={codes} costCodes={p0.costCodes} editable={draft} />
          {sel.status === 'SENT' && !readOnly && (
            <p className="t-cap">Sent estimates are locked. Revise to change the lines; the customer then gets a new version.</p>
          )}
        </section>
      )}

      {sel && (
        <>
          <ConfirmDialog
            open={confirm === 'accept'}
            onClose={() => setConfirm(null)}
            title={`${sel.number} v${sel.version} accepted`}
            confirmLabel="Record acceptance"
            onConfirm={async () => {
              const r = await run<AcceptOut>('accept', 'post', url, { op: 'accept' }, (d) =>
                d.contractCreated ? `Accepted. Original budget written and the contract set to ${money(d.totalCents)}` : 'Accepted. Original budget updated; the contract stays as set', { quietError: true });
              if (r.error) throw new Error(r.error.error);
              if (r.data) setAccepted(r.data);
            }}
          >
            The cost by cost code ({money(totals.cost)}) becomes the original budget.{' '}
            {p0.contractCents > 0 ? 'The job already has a contract, so it stays as set; change orders move it from here.' : `The contract is set to the price, ${money(totals.sell)}.`}{' '}
            {p0.booksPresent ? 'Both are sent to Merit Books.' : ''}
          </ConfirmDialog>
          <ConfirmDialog
            open={confirm === 'decline'}
            onClose={() => setConfirm(null)}
            tone="danger"
            title={`${sel.number} declined`}
            confirmLabel="Record decline"
            reason={{ label: 'Why did the customer decline?', placeholder: 'Over budget; went with another contractor', minLength: 0 }}
            onConfirm={async (reason) => {
              const r = await run('decline', 'post', url, { op: 'decline', reason: reason?.trim() || null }, `Recorded ${sel.number} as declined`, { quietError: true });
              if (r.error) throw new Error(r.error.error);
            }}
          >
            Nothing is written to the budget or the contract. You can revise it later.
          </ConfirmDialog>
          <ConfirmDialog
            open={confirm === 'delete'}
            onClose={() => setConfirm(null)}
            tone="danger"
            title={`Delete draft v${sel.version}`}
            confirmLabel="Delete draft"
            onConfirm={async () => {
              const r = await run('delete', 'delete', url, undefined, `Deleted the draft`, { quietError: true });
              if (r.error) throw new Error(r.error.error);
              setSelId(null);
            }}
          >
            {lines.length} {lines.length === 1 ? 'line' : 'lines'} and {money(totals.sell)} of pricing are deleted.
          </ConfirmDialog>
        </>
      )}
    </div>
  );
}

function AcceptedNotice({ jobId, estimate, result, contractCents, budgetCents, booksPresent }: { jobId: string; estimate: EstimateRow; result: AcceptOut | null; contractCents: number; budgetCents: number | null; booksPresent: boolean }) {
  const when = estimate.accepted_at ? shortDate(estimate.accepted_at.slice(0, 10)) : 'today';
  return (
    <InlineNotice tone="info" title={`Accepted ${when}.`} role="status">
      <span style={{ display: 'block' }}>
        Original budget: {money(estimate.cost_total_cents)} by cost code{budgetCents != null && budgetCents !== estimate.cost_total_cents ? ` (the job’s budget is now ${money(budgetCents)} with other lines)` : ''}.{' '}
        <Link className="link" href={`/jobs/${jobId}?tab=budget`}>Open the budget</Link>
      </span>
      <span style={{ display: 'block', marginTop: 4 }}>
        Contract: {result ? (result.contractCreated ? `set to ${money(result.totalCents)}` : 'kept as set') : 'revised contract'} {money(contractCents)}.{' '}
        <Link className="link" href={`/jobs/${jobId}?tab=contract`}>Open the contract</Link>
      </span>
      {booksPresent && <span style={{ display: 'block', marginTop: 4 }} className="t-cap">Sent to Merit Books as the contract value and cost estimate.</span>}
    </InlineNotice>
  );
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

interface Draft { cc: string; desc: string; qty: string; uom: string; unit: number | null; markup: string; allowance: boolean }

const EMPTY: Draft = { cc: '', desc: '', qty: '', uom: '', unit: null, markup: '', allowance: false };

function preview(d: Draft) {
  const mk = d.markup ? parsePct(d.markup) : 0;
  const qty = d.qty.trim() || null;
  if (qty && !/^\d{1,10}(\.\d{1,4})?$/.test(qty)) return null;
  if (mk == null) return null;
  return estimateLineValues({ qty, unitCostCents: qty ? d.unit : null, unitPriceCents: null, markupPct: mk, costCents: qty ? null : d.unit, amountCents: null });
}

function LinesTable({ estimateId, lines, codes, costCodes, editable }: { estimateId: string; lines: EstimateLineRow[]; codes: Map<string, CostCodeRow>; costCodes: CostCodeRow[]; editable: boolean }) {
  const { run, busy } = useAction();
  const url = `/api/estimates/${estimateId}/lines`;
  const active = costCodes.filter((c) => c.is_active);
  const [d, setD] = useState<Draft>({ ...EMPTY, cc: active[0]?.id ?? '' });
  const [err, setErr] = useState<string | null>(null);
  const [remove, setRemove] = useState<EstimateLineRow | null>(null);
  const pv = preview(d);

  const add = async () => {
    if (!d.desc.trim() && !d.cc) return setErr('Pick a cost code or describe the line.');
    if (!pv) return setErr('Check the quantity (up to 4 decimals) and markup (0 to 100).');
    if (d.unit == null) return setErr('Enter the unit cost, or the lump-sum cost when there is no quantity.');
    setErr(null);
    const qty = d.qty.trim() || null;
    const r = await run('add', 'post', url, {
      op: 'add_line', costCodeId: d.cc || null, description: d.desc.trim(), qty, uom: d.uom.trim() || null,
      unitCostCents: qty ? d.unit : null, costCents: qty ? null : d.unit, markupPct: parsePct(d.markup || '0'), isAllowance: d.allowance,
    }, 'Added the line');
    if (!r.error) setD({ ...EMPTY, cc: d.cc });
  };

  if (!editable && lines.length === 0) {
    return <InlineNotice title="No lines.">This version has no lines.</InlineNotice>;
  }

  return (
    <section aria-label="Estimate lines" className="mp-table">
      <table className="tbl tbl-q tbl-q--compact">
        <colgroup>
          <col style={{ width: 220 }} /><col /><col style={{ width: 88 }} /><col style={{ width: 64 }} /><col style={{ width: 128 }} /><col style={{ width: 80 }} />
          <col style={{ width: 128 }} /><col style={{ width: 128 }} /><col style={{ width: 56 }} />{editable && <col style={{ width: 48 }} />}
        </colgroup>
        <thead>
          <tr>
            <th>Cost code</th><th>Description</th><th className="n">Qty</th><th>Unit</th><th className="n">Unit cost</th><th className="n">Markup</th>
            <th className="n">Cost</th><th className="n">Price</th><th>Allow.</th>{editable && <th><span className="sr">Remove</span></th>}
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <LineRow key={l.id} line={l} codes={codes} costCodes={costCodes} editable={editable} onRemove={() => setRemove(l)}
              onSave={(patch, ok) => run(`l:${l.id}`, 'post', url, { op: 'update_line', lineId: l.id, ...patch }, ok)} />
          ))}
          {lines.length > 0 && (
            <tr className="q-row">
              <td colSpan={6} className="b">Total</td>
              <td className="n b">{m(lines.reduce((s, l) => s + (l.cost_cents ?? 0), 0))}</td>
              <td className="n b">{m(lines.reduce((s, l) => s + l.amount_cents, 0))}</td>
              <td />{editable && <td />}
            </tr>
          )}
        </tbody>
      </table>
      {editable && (
        <form className="mp-add" onSubmit={(e) => { e.preventDefault(); void add(); }} aria-label="Add a line">
          <Field label="Cost code">
            <Select value={d.cc} onChange={(e) => setD({ ...d, cc: e.target.value })} style={{ width: 200 }}>
              <option value="">No cost code</option>
              {active.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
            </Select>
          </Field>
          <Field label="Description"><Input value={d.desc} onChange={(e) => setD({ ...d, desc: e.target.value })} placeholder="Base cabinets, shaker" maxLength={200} /></Field>
          <Field label="Qty" help="Blank = lump sum"><Input inputMode="decimal" value={d.qty} onChange={(e) => setD({ ...d, qty: e.target.value })} style={{ width: 80 }} /></Field>
          <Field label="Unit"><Input value={d.uom} onChange={(e) => setD({ ...d, uom: e.target.value })} placeholder="ea" maxLength={16} style={{ width: 64 }} /></Field>
          <Field label={d.qty.trim() ? 'Unit cost' : 'Cost'}><MoneyInput valueCents={d.unit} onChangeCents={(c) => setD({ ...d, unit: c })} placeholder="0.00" style={{ width: 120 }} /></Field>
          <Field label="Markup %"><Input inputMode="decimal" value={d.markup} onChange={(e) => setD({ ...d, markup: e.target.value })} placeholder="0" style={{ width: 72 }} /></Field>
          <Field label="Allowance"><Check aria-label="Allowance line" checked={d.allowance} onChange={(e) => setD({ ...d, allowance: e.target.checked })} /></Field>
          <Field label="Price" error={err ?? undefined}><span className="tnum" style={{ display: 'inline-block', minWidth: 96, lineHeight: '32px' }}>{pv ? m(pv.amount_cents) : '—'}</span></Field>
          <Button type="submit" icon="plus" disabled={busy === 'add'}>Add line</Button>
        </form>
      )}
      <ConfirmDialog
        open={!!remove}
        onClose={() => setRemove(null)}
        tone="danger"
        title="Remove this line"
        confirmLabel="Remove line"
        onConfirm={async () => {
          if (!remove) return;
          const r = await run('remove', 'post', url, { op: 'remove_line', lineId: remove.id }, 'Removed the line', { quietError: true });
          if (r.error) throw new Error(r.error.error);
        }}
      >
        {remove ? `${remove.description || codes.get(remove.cost_code_id ?? '')?.name || 'Line'}, ${money(remove.amount_cents)}.` : null}
      </ConfirmDialog>
    </section>
  );
}

function LineRow({ line, codes, costCodes, editable, onSave, onRemove }: {
  line: EstimateLineRow; codes: Map<string, CostCodeRow>; costCodes: CostCodeRow[]; editable: boolean;
  onSave: (patch: Record<string, unknown>, ok: string) => Promise<unknown>; onRemove: () => void;
}) {
  const lump = line.qty == null;
  const mk = typeof line.ext?.markup_pct === 'number' ? (line.ext.markup_pct as number) : null;
  const [desc, setDesc] = useState(line.description);
  const [qty, setQty] = useState(line.qty != null ? String(line.qty) : '');
  const [unit, setUnit] = useState<number | null>(lump ? line.cost_cents : line.unit_cost_cents);
  const [markup, setMarkup] = useState(pctInput(mk));
  const cc = line.cost_code_id ? codes.get(line.cost_code_id) : null;

  if (!editable) {
    return (
      <tr className="q-row">
        <td>{cc ? <><span className="code">{cc.code}</span> {cc.name}</> : <span className="l2">No cost code</span>}</td>
        <td>{line.description}</td>
        <td className="n">{line.qty ?? '—'}</td>
        <td>{line.uom ?? ''}</td>
        <td className="n">{m(lump ? line.cost_cents : line.unit_cost_cents)}</td>
        <td className="n">{p(mk)}</td>
        <td className="n">{m(line.cost_cents)}</td>
        <td className="n">{m(line.amount_cents)}</td>
        <td>{line.is_allowance ? <Tag>Allowance</Tag> : null}</td>
      </tr>
    );
  }

  const saveQty = () => {
    const t = qty.trim();
    if (t === (line.qty != null ? String(line.qty) : '')) return;
    if (t && !/^\d{1,10}(\.\d{1,4})?$/.test(t)) return;
    void onSave(t ? { qty: t, unitCostCents: unit, costCents: null } : { qty: null, costCents: unit, unitCostCents: null }, 'Saved the quantity');
  };
  return (
    <tr className="q-row">
      <td>
        <Select aria-label="Cost code" value={line.cost_code_id ?? ''} onChange={(e) => void onSave({ costCodeId: e.target.value || null }, 'Changed the cost code')}>
          <option value="">No cost code</option>
          {costCodes.filter((c) => c.is_active || c.id === line.cost_code_id).map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
        </Select>
      </td>
      <td><Input aria-label="Description" value={desc} maxLength={200} onChange={(e) => setDesc(e.target.value)} onBlur={() => desc !== line.description && void onSave({ description: desc }, 'Saved the description')} /></td>
      <td className="n"><Input aria-label="Quantity" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} onBlur={saveQty} /></td>
      <td>{line.uom ?? ''}</td>
      <td className="n">
        <MoneyInput aria-label={lump ? 'Cost' : 'Unit cost'} valueCents={unit} onChangeCents={setUnit}
          onBlur={() => { const was = lump ? line.cost_cents : line.unit_cost_cents; if (unit !== was) void onSave(lump ? { costCents: unit } : { unitCostCents: unit }, 'Saved the cost'); }} />
      </td>
      <td className="n">
        <Input aria-label="Markup percent" inputMode="decimal" value={markup} onChange={(e) => setMarkup(e.target.value)}
          onBlur={() => { const f = parsePct(markup || '0'); if (f != null && f !== (mk ?? 0)) void onSave({ markupPct: f }, 'Saved the markup'); }} />
      </td>
      <td className="n">{m(line.cost_cents)}</td>
      <td className="n">{m(line.amount_cents)}</td>
      <td><Check aria-label="Allowance line" checked={line.is_allowance} onChange={(e) => void onSave({ isAllowance: e.target.checked }, e.target.checked ? 'Marked as an allowance' : 'No longer an allowance')} /></td>
      <td><Button variant="quiet" iconOnly icon="x" aria-label="Remove line" onClick={onRemove} /></td>
    </tr>
  );
}
