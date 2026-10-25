'use client';

import { approvalOutcome } from '@/lib/approvals/outcome';
import { useEffect, useMemo, useState } from 'react';
import {
  Button, Check, ConfirmDialog, Field, InlineNotice, Input, KV, MoneyInput, Select, Tag, money, pct, shortDate,
} from '@meritbooks/merit-ui';
import { DRAW_STATUS_WORDS, INSPECTION_WORDS, PACKAGE_ITEMS, drawActions, previewApproval } from '@/lib/pm/ops/draw-math';
import type { DrawBudgetLineRow, DrawDetailRow, DrawLineRow, DrawLineStatusRow, DrawScheduleRow, DrawSummaryRow } from '@/lib/pm/ops/types';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, PctInput, Section } from '../common/bits';
import { useOps } from '../common/useOps';

export interface DrawWorkspaceProps {
  draw: DrawSummaryRow;
  detail: DrawDetailRow | null;
  lines: DrawLineRow[];
  schedule: DrawScheduleRow;
  budgetLines: DrawBudgetLineRow[];
  lineStatus: DrawLineStatusRow[];
  /** Equity already applied on other approved/funded draws of this loan. */
  equityUsedElsewhere: number;
  today: string;
}

/** The open draw: lines by loan-budget line, the package checklist, then submit → inspect → approve → fund. */
export function DrawWorkspace(p: DrawWorkspaceProps) {
  const { readOnly } = useShell();
  const { act, busy, error } = useOps();
  const d = p.draw;
  const url = `/api/ops/draws/${d.draw_id}`;
  const actions = drawActions(d.status, d.inspection_status, p.schedule.requires_inspection);
  const editable = actions.includes('edit') && !readOnly;
  const byLine = useMemo(() => new Map(p.lines.map((l) => [l.draw_budget_line_id, l])), [p.lines]);
  const statusOf = useMemo(() => new Map(p.lineStatus.map((l) => [l.draw_budget_line_id, l])), [p.lineStatus]);
  const [req, setReq] = useState<Record<string, { r: number | null; rel: number | null }>>({});
  useEffect(() => setReq(Object.fromEntries(p.budgetLines.map((b) => [b.id, { r: byLine.get(b.id)?.requested_cents ?? null, rel: byLine.get(b.id)?.retainage_released_cents ?? null }]))), [p.budgetLines, byLine]);
  const [approveCuts, setApproveCuts] = useState<Record<string, number | null>>({});
  const [lender, setLender] = useState('');
  const [mode, setMode] = useState<'none' | 'inspect' | 'approve' | 'fund' | 'return'>('none');
  const [cancelOpen, setCancelOpen] = useState(false);
  const missing = new Set(d.package_missing ?? []);
  const pkg = p.detail?.package ?? {};

  const dirty = p.budgetLines.some((b) => (req[b.id]?.r ?? null) !== (byLine.get(b.id)?.requested_cents ?? null) || (req[b.id]?.rel ?? null) !== (byLine.get(b.id)?.retainage_released_cents ?? null));
  const reqTotal = p.budgetLines.reduce((s, b) => s + (req[b.id]?.r ?? 0), 0);
  const preview = previewApproval({
    lines: p.lines.map((l) => ({
      approved: approveCuts[l.id] ?? l.approved_cents ?? l.requested_cents,
      released: l.retainage_released_cents,
      retainageApplies: p.budgetLines.find((b) => b.id === l.draw_budget_line_id)?.retainage_applies ?? false,
    })),
    retainagePct: Number(p.schedule.retainage_pct),
    equityFirst: p.schedule.equity_first,
    equityRequired: p.schedule.equity_required_cents,
    equityUsedOnOtherDraws: p.equityUsedElsewhere,
  });

  const saveLines = () => act('lines', 'post', url, { op: 'set_lines', lines: p.budgetLines.map((b) => ({ budgetLineId: b.id, requestedCents: req[b.id]?.r ?? 0, retainageReleasedCents: req[b.id]?.rel ?? 0 })) }, 'Saved the draw lines');

  return (
    <Section title={`Draw ${d.draw_number}`} meta={`${DRAW_STATUS_WORDS[d.status]} · period ending ${shortDate(d.period_end, p.today)}`}
      actions={readOnly ? undefined : (
        <div className="btn-row ops-noprint">
          {actions.includes('cancel') && <Button variant="quiet" onClick={() => setCancelOpen(true)}>Cancel draw</Button>}
          {actions.includes('return') && <Button onClick={() => setMode(mode === 'return' ? 'none' : 'return')}>Lender returned it</Button>}
          {actions.includes('inspect') && <Button onClick={() => setMode(mode === 'inspect' ? 'none' : 'inspect')}>Record inspection</Button>}
          {actions.includes('submit') && <Button variant="primary" disabled={busy === 'submit' || dirty || p.lines.length === 0} title={dirty ? 'Save the lines first' : undefined} onClick={() => void act<{ approval?: unknown }>('submit', 'post', url, { op: 'submit' }, (r) => approvalOutcome(r?.approval, `Submitted draw ${d.draw_number} to ${p.schedule.lender_name}`, `Draw ${d.draw_number}`))}>Submit to lender</Button>}
          {actions.includes('approve') && <Button variant="primary" onClick={() => setMode(mode === 'approve' ? 'none' : 'approve')}>Lender approved</Button>}
          {actions.includes('fund') && <Button variant="primary" onClick={() => setMode(mode === 'fund' ? 'none' : 'fund')}>Record funding</Button>}
        </div>
      )}>
      <Failure text={error} />
      {d.status === 'RETURNED' && p.detail?.returned_reason && <InlineNotice tone="warn" title="Returned for correction.">{p.detail.returned_reason}</InlineNotice>}

      <div className="cols" style={{ marginTop: 0 }}>
        <div>
          <KV items={[
            { term: 'Requested', value: money(d.requested_cents ?? d.lines_requested_cents) },
            ...(d.approved_cents != null ? [{ term: 'Approved (gross)', value: money(d.approved_cents) }] : []),
            ...(d.retainage_held_cents != null ? [{ term: 'Retainage held', value: money(d.retainage_held_cents) }] : []),
            ...(d.retainage_released_cents ? [{ term: 'Retainage released', value: money(d.retainage_released_cents) }] : []),
            ...(d.equity_applied_cents != null ? [{ term: 'Equity applied', value: money(d.equity_applied_cents) }] : []),
            ...(d.loan_expected_cents != null ? [{ term: 'Loan advance', value: <b>{money(d.loan_expected_cents)}</b> }] : []),
            ...(d.funded_cents != null ? [{ term: 'Funded', value: `${money(d.funded_cents)}${d.funded_on ? ` on ${shortDate(d.funded_on, p.today)}` : ''}` }] : []),
            { term: 'Inspection', value: `${INSPECTION_WORDS[d.inspection_status]}${d.inspector_pct_complete != null ? ` · ${pct(Number(d.inspector_pct_complete))} complete` : ''}` },
            ...(p.detail?.inspector_name ? [{ term: 'Inspector', value: `${p.detail.inspector_name}${p.detail.inspected_on ? `, ${shortDate(p.detail.inspected_on, p.today)}` : ''}` }] : []),
            ...(p.detail?.lender_approver_name ? [{ term: 'Lender approver', value: p.detail.lender_approver_name }] : []),
            ...(p.detail?.wire_ref ? [{ term: 'Wire', value: p.detail.wire_ref }] : []),
          ]} />
        </div>
        <div>
          <p className="t-section" style={{ marginBottom: 8 }}>Draw package</p>
          <ul className="ops-checks">
            {PACKAGE_ITEMS.map((it) => {
              const on = !missing.has(it.key) || pkg[it.key] === true;
              return (
                <li key={it.key} style={{ gridTemplateColumns: '24px minmax(0,1fr)' }}>
                  {editable ? (
                    <Check aria-label={it.label} checked={on} disabled={busy === `pkg:${it.key}`} onChange={() => void act(`pkg:${it.key}`, 'post', url, { op: 'set_package', key: it.key, done: !on }, `${it.label}: ${on ? 'not in the package' : 'in the package'}`)} />
                  ) : <span className={on ? 'ok' : 'no'} aria-hidden="true">{on ? '✓' : '×'}</span>}
                  <span className={on ? undefined : 'ink-2'}>{it.label}</span>
                </li>
              );
            })}
          </ul>
          <p className="t-cap" style={{ marginTop: 6 }}>{missing.size ? `${missing.size} of ${PACKAGE_ITEMS.length} still to gather. The lender reads the summary, cover letter, pay apps and waivers first.` : 'Complete. Reviewable in one sitting.'}</p>
        </div>
      </div>

      {editable && (
        <div className="mp-table" style={{ marginTop: 16 }}>
          <table className="ops-mini">
            <thead><tr><th>Line</th><th className="n">Budget left</th><th className="n">Request this draw</th><th className="n">Release retainage</th></tr></thead>
            <tbody>
              {p.budgetLines.map((b) => {
                const st = statusOf.get(b.id);
                const thisLine = byLine.get(b.id)?.requested_cents ?? 0;
                const left = (st?.remaining_cents ?? 0) + thisLine; // remaining excludes this draw's saved request
                const over = (req[b.id]?.r ?? 0) > left;
                return (
                  <tr key={b.id}>
                    <td><span className="l1">{b.line_no}. {b.description}</span>{st && st.retainage_held_cents > 0 && <span className="l2">{money(st.retainage_held_cents)} retainage held</span>}</td>
                    <td className="n">{money(left)}</td>
                    <td className="n"><MoneyInput aria-label={`Request for ${b.description}`} valueCents={req[b.id]?.r ?? null} onChangeCents={(x) => setReq({ ...req, [b.id]: { r: x, rel: req[b.id]?.rel ?? null } })} invalid={over} placeholder="0.00" style={{ width: 140 }} /></td>
                    <td className="n">{st && st.retainage_held_cents > 0 ? <MoneyInput aria-label={`Retainage release for ${b.description}`} valueCents={req[b.id]?.rel ?? null} onChangeCents={(x) => setReq({ ...req, [b.id]: { r: req[b.id]?.r ?? null, rel: x } })} placeholder="0.00" style={{ width: 120 }} /> : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot><tr><td>Total request</td><td /><td className="n">{money(reqTotal)}</td><td className="n">{money(p.budgetLines.reduce((s, b) => s + (req[b.id]?.rel ?? 0), 0))}</td></tr></tfoot>
          </table>
          <div className="mp-add">
            <span className="t-cap" style={{ flex: 1 }}>A line cannot draw past its loan budget; reallocate it first. Submitting locks the lines and the package.</span>
            <Button variant="primary" disabled={!dirty || busy === 'lines'} onClick={() => void saveLines()}>Save lines</Button>
          </div>
        </div>
      )}

      {mode === 'inspect' && !readOnly && <InspectForm today={p.today} busy={busy === 'inspect'} onCancel={() => setMode('none')} onSubmit={async (b) => { const r = await act('inspect', 'post', url, { op: 'inspect', ...b }, `Inspection ${b.result.toLowerCase()}`); if (r) setMode('none'); }} />}

      {mode === 'approve' && !readOnly && (
        <form className="mp-table" style={{ marginTop: 16, padding: 16 }} onSubmit={(e) => {
          e.preventDefault();
          const cuts = p.lines.filter((l) => approveCuts[l.id] != null && approveCuts[l.id] !== l.requested_cents).map((l) => ({ lineId: l.id, approvedCents: approveCuts[l.id]! }));
          void act('approve', 'post', url, { op: 'approve', lenderApprover: lender.trim() || null, lines: cuts }, `Draw ${d.draw_number} approved`).then((r) => { if (r) setMode('none'); });
        }}>
          <p className="t-section" style={{ marginBottom: 8 }}>What the lender approved</p>
          <table className="ops-mini">
            <thead><tr><th>Line</th><th className="n">Requested</th><th className="n">Approved</th></tr></thead>
            <tbody>
              {p.lines.map((l) => {
                const b = p.budgetLines.find((x) => x.id === l.draw_budget_line_id);
                return (
                  <tr key={l.id}>
                    <td>{b ? `${b.line_no}. ${b.description}` : 'Line'}{b?.retainage_applies ? <span className="l2">retainage {pct(Number(p.schedule.retainage_pct))}</span> : null}</td>
                    <td className="n">{money(l.requested_cents)}</td>
                    <td className="n"><MoneyInput aria-label="Approved" valueCents={approveCuts[l.id] ?? l.requested_cents} onChangeCents={(x) => setApproveCuts({ ...approveCuts, [l.id]: x })} style={{ width: 140 }} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="cols" style={{ marginTop: 12 }}>
            <KV items={[
              { term: 'Approved (gross)', value: money(preview.approved) },
              { term: 'Retainage held', value: money(-preview.held) },
              ...(preview.released ? [{ term: 'Retainage released', value: money(preview.released) }] : []),
              { term: 'Net', value: money(preview.net) },
              ...(p.schedule.equity_first ? [{ term: 'Equity applied first', value: money(-preview.equity) }] : []),
              { term: 'Loan advance', value: <b>{money(preview.loan)}</b> },
            ]} />
            <div className="mp-form">
              <Field label="Lender approver"><Input value={lender} onChange={(e) => setLender(e.target.value)} placeholder="Name at the bank" maxLength={160} /></Field>
              <div className="btn-row"><Button onClick={() => setMode('none')}>Back</Button><Button type="submit" variant="primary" disabled={busy === 'approve'}>Record approval</Button></div>
            </div>
          </div>
          <p className="t-cap" style={{ marginTop: 8 }}>The database pins these figures when you record it; the loan advance cannot exceed the undisbursed commitment.</p>
        </form>
      )}

      {mode === 'fund' && !readOnly && <FundForm expected={d.loan_expected_cents ?? 0} today={p.today} busy={busy === 'fund'} onCancel={() => setMode('none')} onSubmit={async (b) => { const r = await act('fund', 'post', url, { op: 'fund', ...b }, `Draw ${d.draw_number} funded`); if (r) setMode('none'); }} />}
      {mode === 'return' && !readOnly && <ReturnForm busy={busy === 'return'} onCancel={() => setMode('none')} onSubmit={async (reason) => { const r = await act('return', 'post', url, { op: 'return', reason }, `Draw ${d.draw_number} returned for correction`); if (r) setMode('none'); }} />}

      {d.status === 'FUNDED' && <p className="t-cap" style={{ marginTop: 12 }}>Merit Books records the cash and the receivable from {p.schedule.lender_name}; nothing posts from here.</p>}

      <ConfirmDialog open={cancelOpen} onClose={() => setCancelOpen(false)} tone="danger" title={`Cancel draw ${d.draw_number}`} confirmLabel="Cancel draw" reason={{ label: 'Why', minLength: 0 }}
        onConfirm={async (reason) => { const r = await act('cancel', 'post', url, { op: 'cancel', reason: reason || null }, `Cancelled draw ${d.draw_number}`); if (!r) throw new Error('Not cancelled.'); }}>
        Its requested amounts come off the continuation sheet. The next draw keeps the same number sequence.
      </ConfirmDialog>
    </Section>
  );
}

function InspectForm({ today, busy, onCancel, onSubmit }: { today: string; busy: boolean; onCancel: () => void; onSubmit: (b: { result: 'PASSED' | 'CONDITIONAL' | 'FAILED'; pctComplete: number | null; inspector: string | null; inspectedOn: string | null; notes: string | null }) => void }) {
  const [result, setResult] = useState<'PASSED' | 'CONDITIONAL' | 'FAILED'>('PASSED');
  const [pctDone, setPctDone] = useState<number | null>(null);
  const [who, setWho] = useState('');
  const [on, setOn] = useState(today);
  const [notes, setNotes] = useState('');
  return (
    <form className="mp-table mp-form" style={{ marginTop: 16, padding: 16 }} onSubmit={(e) => { e.preventDefault(); onSubmit({ result, pctComplete: pctDone, inspector: who.trim() || null, inspectedOn: on || null, notes: notes.trim() || null }); }}>
      <p className="t-section">Lender’s inspection</p>
      <div className="mp-form-2">
        <Field label="Result"><Select value={result} onChange={(e) => setResult(e.target.value as typeof result)}><option value="PASSED">Passed</option><option value="CONDITIONAL">Passed with conditions</option><option value="FAILED">Failed</option></Select></Field>
        <Field label="Inspector’s percent complete"><PctInput value={pctDone} onChange={setPctDone} placeholder="42" /></Field>
      </div>
      <div className="mp-form-2">
        <Field label="Inspector"><Input value={who} onChange={(e) => setWho(e.target.value)} maxLength={160} /></Field>
        <Field label="Inspected"><Input type="date" value={on} onChange={(e) => setOn(e.target.value)} /></Field>
      </div>
      <Field label="Notes"><Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} /></Field>
      <div className="btn-row"><Button onClick={onCancel}>Back</Button><Button type="submit" variant="primary" disabled={busy}>Record inspection</Button></div>
    </form>
  );
}

function FundForm({ expected, today, busy, onCancel, onSubmit }: { expected: number; today: string; busy: boolean; onCancel: () => void; onSubmit: (b: { fundedOn: string | null; wireRef: string | null; fundedCents: number | null }) => void }) {
  const [on, setOn] = useState(today);
  const [wire, setWire] = useState('');
  const [amt, setAmt] = useState<number | null>(expected);
  return (
    <form className="mp-table mp-form" style={{ marginTop: 16, padding: 16 }} onSubmit={(e) => { e.preventDefault(); onSubmit({ fundedOn: on || null, wireRef: wire.trim() || null, fundedCents: amt }); }}>
      <p className="t-section">Lender’s wire</p>
      <div className="mp-form-2">
        <Field label="Amount" help={`Approved loan advance ${money(expected)}`}><MoneyInput valueCents={amt} onChangeCents={setAmt} /></Field>
        <Field label="Funded on"><Input type="date" value={on} onChange={(e) => setOn(e.target.value)} /></Field>
      </div>
      <Field label="Wire reference"><Input value={wire} onChange={(e) => setWire(e.target.value)} maxLength={120} /></Field>
      <div className="btn-row"><Button onClick={onCancel}>Back</Button><Button type="submit" variant="primary" disabled={busy}>Record funding</Button></div>
    </form>
  );
}

function ReturnForm({ busy, onCancel, onSubmit }: { busy: boolean; onCancel: () => void; onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <form className="mp-table mp-form" style={{ marginTop: 16, padding: 16 }} onSubmit={(e) => { e.preventDefault(); if (reason.trim()) onSubmit(reason.trim()); }}>
      <Field label="What the lender wants corrected"><Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Missing unconditional waiver from Hawkeye Electric" maxLength={500} /></Field>
      <div className="btn-row"><Button onClick={onCancel}>Back</Button><Button type="submit" variant="primary" disabled={busy || !reason.trim()}>Return for correction</Button></div>
    </form>
  );
}

export function DrawStatusTag({ d }: { d: DrawSummaryRow }) {
  return <Tag tone={d.status === 'FUNDED' ? 'pos' : d.status === 'RETURNED' ? 'warn' : 'default'}>{DRAW_STATUS_WORDS[d.status]}</Tag>;
}
