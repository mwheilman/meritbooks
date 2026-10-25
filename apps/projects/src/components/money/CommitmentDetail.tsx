'use client';

import { PortalPayApps } from '@/components/job/tabs/PortalTab';
import { approvalOutcome, chainPending } from '@/lib/approvals/outcome';
import { useState } from 'react';
import {
  Button, Check, ConfirmDialog, Field, Input, InlineNotice, KV, MoneyInput, Select, Switch, Tabs, Tag, Textarea, money, shortDate,
} from '@meritbooks/merit-ui';
import type { CostCodeRow } from '@/lib/pm/types';
import type {
  CommitmentChangeRow, CommitmentLineRow, CommitmentStatusRow, ComplianceDocRow, ComplianceDocType, ReceiptRow,
} from '@/lib/pm/money/types';
import { COMPLIANCE_DOC_LABELS, commitmentMark, complianceMark } from '@/lib/pm/money/status';
import { extendCents } from '@/lib/pm/money/aia';
import { useShell } from '@/components/shell/ShellContext';
import { useAction } from '@/components/job/useAction';
import { MarkStatus, m, p } from './common';
import type { CommitmentListRow, OwnerCoOption } from './CommitmentsTab';
import { VendorPicker, type VendorAdd } from './VendorPicker';
import { vendorKindFor } from '@/lib/pm/parties/schemas';

type Section = 'lines' | 'changes' | 'receipts' | 'compliance' | 'pay-apps';

export interface CommitmentDetailProps {
  row: CommitmentListRow;
  lines: CommitmentLineRow[];
  status: CommitmentStatusRow[];
  changes: CommitmentChangeRow[];
  receipts: ReceiptRow[];
  compliance: ComplianceDocRow[];
  costCodes: CostCodeRow[];
  ownerCos: OwnerCoOption[];
  currentUserId: string;
  booksPresent: boolean;
  today: string;
  onGone: () => void;
}

const DOC_TYPES: ComplianceDocType[] = ['COI', 'LIEN_WAIVER_CONDITIONAL', 'LIEN_WAIVER_UNCONDITIONAL', 'LIEN_WAIVER_FINAL', 'W9', 'CERTIFIED_PAYROLL', 'OTHER'];

/** One commitment: state moves, payment hold, then its lines, changes, receipts and compliance documents. */
export function CommitmentDetail(p0: CommitmentDetailProps) {
  const { readOnly } = useShell();
  const { run, busy } = useAction();
  const c = p0.row;
  const url = `/api/commitments/${c.id}`;
  const [section, setSection] = useState<Section>('lines');
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | 'void' | 'close' | 'delete'>(null);
  const mine = c.created_by === p0.currentUserId;
  const open = c.status === 'APPROVED' || c.status === 'EXECUTED';
  const codes = new Map(p0.costCodes.map((x) => [x.id, x]));
  const missing = p0.compliance.filter((d) => d.required && !complianceMark(d, p0.today).ok);

  const act = async (key: string, body: Record<string, unknown>, ok: string) => {
    const r = await run<{ approval?: unknown }>(key, 'post', url, body, (d) => approvalOutcome(d?.approval, ok, c.number), { quietError: true });
    setNotice(r.error ? r.error.error : chainPending(r.data?.approval) ? approvalOutcome(r.data?.approval, '', c.number) : null);
    return r;
  };

  const sentNote = p0.booksPresent ? ' and sent it to Merit Books' : '';

  return (
    <section className="sec" aria-label={`${c.number} detail`}>
      <div className="sec-h">
        <h2 className="t-section"><span className="code">{c.number}</span> · {c.vendorName ?? 'No vendor yet'}</h2>
        <MarkStatus mark={commitmentMark(c.status, c.t.holdEffective)} />
        <span className="sp" />
        {!readOnly && (
          <div className="btn-row">
            {c.status === 'DRAFT' && <Button variant="quiet" onClick={() => setConfirm('delete')}>Delete draft</Button>}
            {(c.status === 'DRAFT' || open) && <Button variant="danger" disabled={c.t.billed > 0} title={c.t.billed > 0 ? 'Merit Books has bills against it; close it instead' : undefined} onClick={() => setConfirm('void')}>Void</Button>}
            {open && <Button onClick={() => setConfirm('close')}>Close</Button>}
            {c.status === 'APPROVED' && <Button disabled={busy === 'exec'} onClick={() => void act('exec', { op: 'execute' }, `Marked ${c.number} signed${sentNote}`)}>Mark signed</Button>}
            {c.status === 'DRAFT' && (
              <Button variant="primary" chord="a" bindChord disabled={busy === 'approve' || mine} title={mine ? 'You prepared this commitment' : undefined}
                onClick={() => void act('approve', { op: 'approve' }, `Approved ${c.number}${sentNote}`)}>
                Approve
              </Button>
            )}
          </div>
        )}
      </div>

      {notice && <InlineNotice tone="neg" title="Not changed." role="alert">{notice}</InlineNotice>}
      {c.status === 'DRAFT' && mine && (
        <InlineNotice tone="info" title="You prepared this one.">Someone else approves it; that keeps preparer and approver apart. Approval tiers by amount come from your approval policy in Settings.</InlineNotice>
      )}
      {c.status === 'DRAFT' && !c.vendor_id && <InlineNotice tone="warn" title="No vendor yet.">Pick the vendor below before anyone approves it.</InlineNotice>}

      <div className="grid-12" style={{ rowGap: 16, alignItems: 'start', marginTop: 12 }}>
        <div style={{ gridColumn: 'span 4' }}>
          <KV items={[
            { term: 'Original', value: m(c.t.original || c.t.committed) },
            { term: 'Approved changes', value: m(c.t.changes) },
            { term: 'Committed', value: m(c.t.committed) },
            { term: 'Received', value: m(c.t.received) },
            { term: 'Billed in Merit Books', value: m(c.t.billed) },
            { term: 'Open', value: m(c.t.open) },
            { term: 'Retainage', value: p(c.retainage_pct) },
            ...(c.executed_on ? [{ term: 'Signed', value: shortDate(c.executed_on) }] : []),
            ...(c.approved_at ? [{ term: 'Approved', value: shortDate(c.approved_at.slice(0, 10)) }] : []),
          ]} />
          {c.t.receivedNotBilled > 0 && <p className="t-cap" style={{ marginTop: 8 }}>{money(c.t.receivedNotBilled)} received and not billed yet; Merit Books carries it as received, not invoiced.</p>}
        </div>
        <div style={{ gridColumn: 'span 8' }}>
          {c.status === 'DRAFT' && !readOnly ? <DraftHeader row={c} /> : <HoldControl row={c} missing={missing} booksPresent={p0.booksPresent} readOnly={readOnly} />}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <Tabs<Section>
          aria-label={`${c.number} sections`}
          value={section}
          onChange={setSection}
          items={[
            { value: 'lines', label: 'Lines', count: p0.lines.length || undefined, panelId: 'cmt-panel' },
            { value: 'changes', label: 'Changes', count: p0.changes.filter((x) => x.status === 'DRAFT').length || undefined, panelId: 'cmt-panel' },
            { value: 'receipts', label: 'Receipts', count: p0.receipts.length || undefined, panelId: 'cmt-panel' },
            { value: 'compliance', label: 'Compliance', count: missing.length || undefined, panelId: 'cmt-panel' },
            ...(c.vendor_id ? [{ value: 'pay-apps' as Section, label: 'Pay apps from the portal', panelId: 'cmt-panel' }] : []),
          ]}
        />
      </div>
      <div id="cmt-panel" role="tabpanel" style={{ marginTop: 12 }}>
        {section === 'lines' && <LinesSection row={c} lines={p0.lines} status={p0.status} codes={codes} costCodes={p0.costCodes} readOnly={readOnly} />}
        {section === 'changes' && <ChangesSection row={c} lines={p0.lines} changes={p0.changes} codes={codes} costCodes={p0.costCodes} ownerCos={p0.ownerCos} currentUserId={p0.currentUserId} readOnly={readOnly} />}
        {section === 'receipts' && <ReceiptsSection row={c} lines={p0.lines} receipts={p0.receipts} today={p0.today} readOnly={readOnly} />}
        {section === 'compliance' && <ComplianceSection row={c} docs={p0.compliance} today={p0.today} readOnly={readOnly} />}
        {section === 'pay-apps' && <PortalPayApps filter={{ commitmentId: c.id }} />}
      </div>

      <ConfirmDialog
        open={confirm === 'void'}
        onClose={() => setConfirm(null)}
        tone="danger"
        title={`Void ${c.number}`}
        confirmLabel={`Void ${c.number}`}
        reason={c.status === 'DRAFT' ? undefined : { label: 'Why is it void?', placeholder: 'Scope moved to another vendor' }}
        onConfirm={async (reason) => {
          const r = await run('void', 'post', url, { op: 'void', reason: reason ?? null }, `Voided ${c.number}`, { quietError: true });
          if (r.error) throw new Error(r.error.error);
        }}
      >
        {c.status === 'DRAFT' ? 'The draft is kept as void for the record.' : `${money(c.t.committed)} leaves committed cost${p0.booksPresent ? ', and Merit Books stops matching bills to it' : ''}.`}
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'close'}
        onClose={() => setConfirm(null)}
        title={`Close ${c.number}`}
        confirmLabel={`Close ${c.number}`}
        onConfirm={async () => {
          const r = await run('close', 'post', url, { op: 'close' }, `Closed ${c.number}`, { quietError: true });
          if (r.error) throw new Error(r.error.error);
        }}
      >
        No more bills are expected. Committed cost drops to what has been billed ({money(c.t.billed)}), and the {money(c.t.open)} open amount comes off the projection.
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'delete'}
        onClose={() => setConfirm(null)}
        tone="danger"
        title={`Delete draft ${c.number}`}
        confirmLabel="Delete draft"
        onConfirm={async () => {
          const r = await run('delete', 'post', url, { op: 'delete' }, `Deleted ${c.number}`, { quietError: true });
          if (r.error) throw new Error(r.error.error);
          p0.onGone();
        }}
      >
        The draft and its {p0.lines.length} {p0.lines.length === 1 ? 'line' : 'lines'} are deleted. Nothing was sent to Merit Books.
      </ConfirmDialog>
    </section>
  );
}

function DraftHeader({ row }: { row: CommitmentListRow }) {
  const { run, busy } = useAction();
  const [vendor, setVendor] = useState({ id: row.vendor_id, name: row.vendorName ?? '' });
  const [title, setTitle] = useState(row.title ?? '');
  const [ret, setRet] = useState(String(Math.round(row.retainage_pct * 10000) / 100));
  const url = `/api/commitments/${row.id}`;
  return (
    <div className="mp-form-2">
      <Field label="Vendor">
        <VendorField value={vendor} onPick={(id, name, pctDefault) => { setVendor({ id, name }); setRet(String(Math.round(pctDefault * 10000) / 100)); void run('vendor', 'post', url, { op: 'update', vendorId: id, retainagePct: pctDefault }, `Vendor set to ${name}`); }} onChange={(v) => setVendor(v)}
          add={{ kind: vendorKindFor(row.commitment_type), companyId: row.location_id }} />
      </Field>
      <Field label="What it covers">
        <Input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} onBlur={() => title.trim() && title !== row.title && void run('title', 'post', url, { op: 'update', title: title.trim() }, 'Saved the name')} />
      </Field>
      <Field label="Retainage %" help="Held back from the vendor’s bills in Merit Books">
        <Input inputMode="decimal" value={ret} onChange={(e) => setRet(e.target.value)} disabled={busy === 'ret'} style={{ width: 96 }}
          onBlur={() => { const t = ret.trim(); const n = /^\d{1,3}(\.\d{1,2})?$/.test(t) ? Number(t) / 100 : null; if (n != null && n <= 1 && n !== row.retainage_pct) void run('ret', 'post', url, { op: 'update', retainagePct: Math.round(n * 10000) / 10000 }, 'Saved the retainage'); }} />
      </Field>
      <Field label="Kind">
        <Select value={row.commitment_type} onChange={(e) => void run('type', 'post', url, { op: 'update', type: e.target.value }, 'Changed the kind')}>
          <option value="SUBCONTRACT">Subcontract</option>
          <option value="PO">Purchase order</option>
        </Select>
      </Field>
    </div>
  );
}

function VendorField({ value, onChange, onPick, add }: { value: { id: string | null; name: string }; onChange: (v: { id: string | null; name: string }) => void; onPick: (id: string, name: string, retainagePct: number) => void; add?: VendorAdd }) {
  return <VendorPicker value={value} onChange={onChange} onPick={(o) => onPick(o.id, o.name, o.retainagePct)} add={add} />;
}

/** The payment hold, with what it does in Merit Books. */
function HoldControl({ row, missing, booksPresent, readOnly }: { row: CommitmentListRow; missing: ComplianceDocRow[]; booksPresent: boolean; readOnly: boolean }) {
  const { run, busy } = useAction();
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState(row.hold_reason ?? '');
  const [err, setErr] = useState<string | null>(null);
  const url = `/api/commitments/${row.id}`;
  const canHold = !readOnly && row.status !== 'VOID';

  const set = async (hold: boolean) => {
    if (hold && !reason.trim()) return setErr('Give a reason; Merit Books shows it to whoever runs payments.');
    setErr(null);
    const r = await run('hold', 'post', url, { op: 'hold', hold, reason: hold ? reason.trim() : null }, hold ? `Payment hold set on ${row.number}` : `Payment hold released on ${row.number}`, { quietError: true });
    if (r.error) setErr(r.error.error);
    else setEditing(false);
  };

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row">
        <Switch
          label="Payment hold"
          checked={row.payment_hold || editing}
          disabled={!canHold || busy === 'hold'}
          onChange={(e) => { if (e.target.checked) setEditing(true); else if (row.payment_hold) void set(false); else setEditing(false); }}
        />
        {row.t.holdEffective && <Tag tone="neg">Payment held</Tag>}
      </div>
      <p className="t-cap" style={{ maxWidth: '64ch' }}>
        {booksPresent
          ? 'A hold tells Merit Books not to pay this vendor’s bills on this commitment. Bills still post to the job; payment runs skip them until the hold is released.'
          : 'A hold is recorded here. With Merit Books on, payment runs skip the vendor’s bills on this commitment until it is released.'}{' '}
        A required certificate or lien waiver that is missing, unverified or expired holds payment on its own.
      </p>
      {row.payment_hold && !editing && row.hold_reason && <p className="t-cap">Manual hold: {row.hold_reason}</p>}
      {missing.length > 0 && (
        <InlineNotice tone="warn" title="Held for compliance.">
          {missing.map((d) => COMPLIANCE_DOC_LABELS[d.doc_type]).join(', ')} {missing.length === 1 ? 'is' : 'are'} not current. Verify {missing.length === 1 ? 'it' : 'them'} on the Compliance tab to release the hold.
        </InlineNotice>
      )}
      {editing && !row.payment_hold && (
        <form className="row" style={{ alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); void set(true); }}>
          <Field label="Reason for the hold" error={err ?? undefined}><Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Punch list open on level 2" maxLength={200} style={{ width: 320 }} /></Field>
          <Button type="submit" variant="primary" disabled={busy === 'hold'}>Hold payment</Button>
          <Button onClick={() => setEditing(false)}>Cancel</Button>
        </form>
      )}
      {!editing && err && <span className="field-error">{err}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

function LinesSection({ row, lines, status, codes, costCodes, readOnly }: { row: CommitmentListRow; lines: CommitmentLineRow[]; status: CommitmentStatusRow[]; codes: Map<string, CostCodeRow>; costCodes: CostCodeRow[]; readOnly: boolean }) {
  const { run, busy } = useAction();
  const url = `/api/commitments/${row.id}`;
  const draft = row.status === 'DRAFT' && !readOnly;
  const active = costCodes.filter((c) => c.is_active);
  const [cc, setCc] = useState(active[0]?.id ?? '');
  const [desc, setDesc] = useState('');
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState<number | null>(null);
  const [amt, setAmt] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const byLine = new Map(status.map((s) => [s.commitment_line_id, s]));

  const add = async () => {
    if (!cc) return setErr('Pick a cost code.');
    const q = qty.trim();
    if (q && !/^\d{1,10}(\.\d{1,4})?$/.test(q)) return setErr('Quantities take up to 4 decimals.');
    if (q ? unit == null : amt == null) return setErr(q ? 'Enter the unit cost.' : 'Enter the amount.');
    setErr(null);
    const r = await run('add', 'post', url, { op: 'add_line', line: { costCodeId: cc, description: desc.trim(), qty: q || null, unitCostCents: q ? unit : null, amountCents: q ? null : amt } }, 'Added the line');
    if (!r.error) { setDesc(''); setQty(''); setUnit(null); setAmt(null); }
  };

  return (
    <div className="mp-table">
      {lines.length === 0 ? (
        <p className="t-cap" style={{ padding: 16 }}>No lines yet. Add cost-coded lines below; approval needs at least one line above zero.</p>
      ) : (
        <table className="tbl tbl-q tbl-q--compact">
          <colgroup><col style={{ width: 48 }} /><col style={{ width: 200 }} /><col /><col style={{ width: 120 }} /><col style={{ width: 120 }} /><col style={{ width: 120 }} /><col style={{ width: 120 }} /><col style={{ width: 120 }} />{draft && <col style={{ width: 48 }} />}</colgroup>
          <thead><tr><th className="n">#</th><th>Cost code</th><th>Description</th><th className="n">Original</th><th className="n">Revised</th><th className="n">Received</th><th className="n">Billed</th><th className="n">Open</th>{draft && <th><span className="sr">Remove</span></th>}</tr></thead>
          <tbody>
            {lines.map((l) => {
              const s = byLine.get(l.id);
              const code = l.cost_code_id ? codes.get(l.cost_code_id) : null;
              return (
                <tr key={l.id} className="q-row">
                  <td className="n">{l.line_no}</td>
                  <td>{code ? <><span className="code">{code.code}</span> {code.name}</> : <span className="neg">No cost code</span>}</td>
                  <td>{l.description}{l.qty != null ? <span className="l2">{l.qty} {l.uom ?? ''} × {m(l.unit_cost_cents)}</span> : null}</td>
                  <td className="n">{m(l.original_amount_cents ?? l.amount_cents)}</td>
                  <td className="n">{m(l.amount_cents)}</td>
                  <td className="n">{m(l.received_cents)}</td>
                  <td className="n">{m(l.billed_cents)}</td>
                  <td className="n">{s ? (s.over_billed_cents > 0 ? <span className="neg b">({money(s.over_billed_cents)})</span> : m(s.open_cents)) : '—'}</td>
                  {draft && <td><Button variant="quiet" iconOnly icon="x" aria-label={`Remove line ${l.line_no}`} disabled={busy === `rm:${l.id}`} onClick={() => void run(`rm:${l.id}`, 'post', url, { op: 'remove_line', lineId: l.id }, 'Removed the line')} /></td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {draft && (
        <form className="mp-add" onSubmit={(e) => { e.preventDefault(); void add(); }} aria-label="Add a commitment line">
          <Field label="Cost code"><Select value={cc} onChange={(e) => setCc(e.target.value)} style={{ width: 220 }}>{active.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</Select></Field>
          <Field label="Description"><Input value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={200} /></Field>
          <Field label="Qty" help="Blank = lump sum"><Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} style={{ width: 80 }} /></Field>
          {qty.trim() ? (
            <Field label="Unit cost"><MoneyInput valueCents={unit} onChangeCents={setUnit} placeholder="0.00" style={{ width: 120 }} /></Field>
          ) : (
            <Field label="Amount"><MoneyInput valueCents={amt} onChangeCents={setAmt} placeholder="0.00" style={{ width: 120 }} /></Field>
          )}
          <Field label="Line total" error={err ?? undefined}>
            <span className="tnum" style={{ display: 'inline-block', minWidth: 96, lineHeight: '32px' }}>
              {qty.trim() && unit != null && /^\d{1,10}(\.\d{1,4})?$/.test(qty.trim()) ? money(extendCents(qty.trim(), unit)) : amt != null && !qty.trim() ? money(amt) : '—'}
            </span>
          </Field>
          <Button type="submit" icon="plus" disabled={busy === 'add'}>Add line</Button>
        </form>
      )}
      {!draft && row.status !== 'VOID' && row.status !== 'CLOSED' && <p className="t-cap" style={{ padding: '8px 16px' }}>Approved lines are locked. Change them with a change on the commitment.</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Commitment changes
// ---------------------------------------------------------------------------

function ChangesSection({ row, lines, changes, codes, costCodes, ownerCos, currentUserId, readOnly }: {
  row: CommitmentListRow; lines: CommitmentLineRow[]; changes: CommitmentChangeRow[]; codes: Map<string, CostCodeRow>; costCodes: CostCodeRow[];
  ownerCos: OwnerCoOption[]; currentUserId: string; readOnly: boolean;
}) {
  const { run, busy } = useAction();
  const url = `/api/commitments/${row.id}/changes`;
  const canAdd = !readOnly && (row.status === 'APPROVED' || row.status === 'EXECUTED');
  const [lineId, setLineId] = useState<string>(lines[0]?.id ?? 'new');
  const [cc, setCc] = useState(costCodes.find((c) => c.is_active)?.id ?? '');
  const [desc, setDesc] = useState('');
  const [reason, setReason] = useState('');
  const [amt, setAmt] = useState<number | null>(null);
  const [owner, setOwner] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState<{ id: string; text: string } | null>(null);
  const [reject, setReject] = useState<CommitmentChangeRow | null>(null);

  const add = async () => {
    if (!desc.trim()) return setErr('Describe the change.');
    if (amt == null || amt === 0) return setErr('Enter the change amount; a credit is negative.');
    if (lineId === 'new' && (!cc || amt <= 0)) return setErr('A new line needs a cost code and an amount above zero.');
    setErr(null);
    const r = await run<{ number: string }>('cco', 'post', url, {
      op: 'create', lineId: lineId === 'new' ? null : lineId, costCodeId: lineId === 'new' ? cc : null, description: desc.trim(), reason: reason.trim() || null, amountCents: amt, ownerCoId: owner || null,
    }, (d) => `Drafted ${d.number}`);
    if (!r.error) { setDesc(''); setReason(''); setAmt(null); setOwner(''); }
  };
  const approve = async (x: CommitmentChangeRow) => {
    const r = await run<{ approval?: unknown }>(`a:${x.id}`, 'post', url, { op: 'approve', changeId: x.id }, (d) => approvalOutcome(d?.approval, `Approved ${x.number}`, x.number), { quietError: true });
    setRowErr(r.error ? { id: x.id, text: r.error.error } : null);
  };

  return (
    <div className="stack">
      <div className="mp-table">
        {changes.length === 0 ? (
          <p className="t-cap" style={{ padding: 16 }}>{canAdd ? 'No changes yet. A change adds to a line, credits it, or adds a new cost-coded line; approving re-sends the commitment.' : 'Changes apply once the commitment is approved.'}</p>
        ) : (
          <table className="tbl tbl-q tbl-q--compact">
            <colgroup><col style={{ width: 200 }} /><col /><col style={{ width: 128 }} /><col style={{ width: 120 }} /><col style={{ width: 220 }} /></colgroup>
            <thead><tr><th>Number</th><th>Change</th><th className="n">Amount</th><th>Status</th><th><span className="sr">Actions</span></th></tr></thead>
            <tbody>
              {changes.map((x) => {
                const line = lines.find((l) => l.id === (x.commitment_line_id ?? x.applied_line_id));
                const target = line ? `Line ${line.line_no}` : x.cost_code_id ? `New line · ${codes.get(x.cost_code_id)?.code ?? ''}` : 'New line';
                const mine = x.created_by === currentUserId;
                return (
                  <tr key={x.id} className="q-row">
                    <td><span className="code">{x.number}</span></td>
                    <td>
                      <span className="l1">{x.description}</span>
                      <span className="l2">{[target, x.reason, x.owner_co_id ? `for ${ownerCos.find((o) => o.id === x.owner_co_id)?.number ?? 'a change order'}` : null].filter(Boolean).join(' · ')}</span>
                      {rowErr?.id === x.id && <span className="field-error" style={{ display: 'block' }}>{rowErr.text}</span>}
                      {x.status === 'REJECTED' && x.reject_reason && <span className="l2">Rejected: {x.reject_reason}</span>}
                    </td>
                    <td className="n">{money(x.amount_cents)}</td>
                    <td>{x.status === 'DRAFT' ? <Tag tone="warn">Draft</Tag> : x.status === 'APPROVED' ? <Tag tone="pos">Approved</Tag> : <Tag>{x.status === 'REJECTED' ? 'Rejected' : 'Void'}</Tag>}</td>
                    <td>
                      {x.status === 'DRAFT' && !readOnly && (
                        <div className="btn-row">
                          <Button variant="quiet" disabled={busy === `d:${x.id}`} onClick={() => void run(`d:${x.id}`, 'post', url, { op: 'delete', changeId: x.id }, `Deleted ${x.number}`)}>Delete</Button>
                          <Button disabled={busy === `a:${x.id}`} onClick={() => setReject(x)}>Reject</Button>
                          <Button variant="primary" disabled={busy === `a:${x.id}` || mine} title={mine ? 'You prepared this change' : undefined} onClick={() => void approve(x)}>Approve</Button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {canAdd && (
          <form className="mp-add" onSubmit={(e) => { e.preventDefault(); void add(); }} aria-label="Draft a commitment change">
            <Field label="Applies to">
              <Select value={lineId} onChange={(e) => setLineId(e.target.value)} style={{ width: 200 }}>
                {lines.map((l) => <option key={l.id} value={l.id}>Line {l.line_no} · {l.description || codes.get(l.cost_code_id ?? '')?.name || 'line'}</option>)}
                <option value="new">A new line</option>
              </Select>
            </Field>
            {lineId === 'new' && (
              <Field label="Cost code"><Select value={cc} onChange={(e) => setCc(e.target.value)} style={{ width: 200 }}>{costCodes.filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</Select></Field>
            )}
            <Field label="Change"><Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Add two floor drains" maxLength={200} /></Field>
            <Field label="Amount" help="Negative for a credit"><MoneyInput valueCents={amt} onChangeCents={setAmt} allowNegative placeholder="0.00" style={{ width: 128 }} /></Field>
            <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} style={{ width: 160 }} /></Field>
            {ownerCos.length > 0 && (
              <Field label="Owner change order" error={err ?? undefined}>
                <Select value={owner} onChange={(e) => setOwner(e.target.value)} style={{ width: 180 }}>
                  <option value="">None</option>
                  {ownerCos.map((o) => <option key={o.id} value={o.id}>{o.number ?? 'CO'} · {o.title}</option>)}
                </Select>
              </Field>
            )}
            {ownerCos.length === 0 && err && <span className="field-error">{err}</span>}
            <Button type="submit" icon="plus" disabled={busy === 'cco'}>Draft change</Button>
          </form>
        )}
      </div>
      <ConfirmDialog
        open={!!reject}
        onClose={() => setReject(null)}
        tone="danger"
        title={`Reject ${reject?.number ?? ''}`}
        confirmLabel="Reject change"
        reason={{ label: 'Why?', placeholder: 'Priced above the agreed unit rate', minLength: 0 }}
        onConfirm={async (why) => {
          if (!reject) return;
          const r = await run(`a:${reject.id}`, 'post', url, { op: 'reject', changeId: reject.id, reason: why?.trim() || null }, `Rejected ${reject.number}`, { quietError: true });
          if (r.error) throw new Error(r.error.error);
        }}
      >
        The commitment stays as it is.
      </ConfirmDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

function ReceiptsSection({ row, lines, receipts, today, readOnly }: { row: CommitmentListRow; lines: CommitmentLineRow[]; receipts: ReceiptRow[]; today: string; readOnly: boolean }) {
  const { run, busy } = useAction();
  const can = !readOnly && (row.status === 'APPROVED' || row.status === 'EXECUTED');
  const [lineId, setLineId] = useState(lines[0]?.id ?? '');
  const [qty, setQty] = useState('');
  const [amt, setAmt] = useState<number | null>(null);
  const [on, setOn] = useState(today);
  const [slip, setSlip] = useState('');
  const [memo, setMemo] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const line = lines.find((l) => l.id === lineId);

  const add = async () => {
    const q = qty.trim();
    if (q && !/^\d{1,10}(\.\d{1,4})?$/.test(q)) return setErr('Quantities take up to 4 decimals.');
    if (!q && (amt == null || amt <= 0)) return setErr('Enter the quantity or the amount received.');
    if (q && line?.unit_cost_cents == null && (amt == null || amt <= 0)) return setErr('This line has no unit cost; enter the amount received too.');
    setErr(null);
    const r = await run<{ amountCents: number | null; overReceipt: boolean }>('rcv', 'post', `/api/commitments/${row.id}/receipts`, {
      lineId, qty: q || null, amountCents: amt, receivedOn: on || null, packingSlip: slip.trim() || null, memo: memo.trim() || null,
    }, (d) => `Received ${d.amountCents != null ? money(d.amountCents) : ''}${d.overReceipt ? ', more than the line; check the commitment' : ''}`);
    if (!r.error) { setQty(''); setAmt(null); setSlip(''); setMemo(''); }
  };

  return (
    <div className="mp-table">
      {receipts.length === 0 ? (
        <p className="t-cap" style={{ padding: 16 }}>{can ? 'Nothing received yet. Record deliveries or work in place; Merit Books uses received to date to match bills.' : 'Receipts are recorded against approved or signed commitments.'}</p>
      ) : (
        <table className="tbl tbl-q tbl-q--compact">
          <colgroup><col style={{ width: 96 }} /><col style={{ width: 96 }} /><col /><col style={{ width: 96 }} /><col style={{ width: 128 }} /></colgroup>
          <thead><tr><th>Received</th><th>Line</th><th>Packing slip · note</th><th className="n">Qty</th><th className="n">Amount</th></tr></thead>
          <tbody>
            {receipts.map((x) => {
              const l = lines.find((y) => y.id === x.commitment_line_id);
              return (
                <tr key={x.id} className="q-row">
                  <td>{shortDate(x.received_on)}</td>
                  <td>Line {l?.line_no ?? '?'}</td>
                  <td>{[x.packing_slip, x.memo].filter(Boolean).join(' · ') || ' '}{x.over_receipt && <Tag tone="warn" style={{ marginLeft: 8 }}>Over the line</Tag>}</td>
                  <td className="n">{x.qty ?? '—'}</td>
                  <td className="n">{money(x.amount_cents)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {can && lines.length > 0 && (
        <form className="mp-add" onSubmit={(e) => { e.preventDefault(); void add(); }} aria-label="Record a receipt">
          <Field label="Line"><Select value={lineId} onChange={(e) => setLineId(e.target.value)} style={{ width: 200 }}>{lines.map((l) => <option key={l.id} value={l.id}>Line {l.line_no} · {l.description || 'line'}</option>)}</Select></Field>
          <Field label="Qty" help={line?.unit_cost_cents != null ? `× ${money(line.unit_cost_cents)}` : 'No unit cost'}><Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} style={{ width: 80 }} /></Field>
          <Field label="Amount" help="Leave blank to use qty × unit cost"><MoneyInput valueCents={amt} onChangeCents={setAmt} placeholder="0.00" style={{ width: 128 }} /></Field>
          <Field label="Received on"><Input type="date" value={on} onChange={(e) => setOn(e.target.value)} /></Field>
          <Field label="Packing slip"><Input value={slip} onChange={(e) => setSlip(e.target.value)} maxLength={80} style={{ width: 120 }} /></Field>
          <Field label="Note" error={err ?? undefined}><Input value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={200} /></Field>
          <Button type="submit" icon="plus" disabled={busy === 'rcv'}>Record receipt</Button>
        </form>
      )}
      {line && can && <p className="t-cap" style={{ padding: '8px 16px' }}>Line {line.line_no}: {money(line.received_cents)} received of {money(line.amount_cents)}{line.qty != null ? ` · ${line.received_qty} of ${line.qty} ${line.uom ?? ''}` : ''}.</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compliance documents
// ---------------------------------------------------------------------------

function ComplianceSection({ row, docs, today, readOnly }: { row: CommitmentListRow; docs: ComplianceDocRow[]; today: string; readOnly: boolean }) {
  const { run, busy } = useAction();
  const url = `/api/commitments/${row.id}/compliance`;
  const can = !readOnly && row.status !== 'VOID';
  const [type, setType] = useState<ComplianceDocType>('COI');
  const [required, setRequired] = useState(true);
  const [expires, setExpires] = useState('');
  const [received, setReceived] = useState(true);
  const [notes, setNotes] = useState('');
  const [verify, setVerify] = useState<{ id: string; expires: string } | null>(null);
  const [rowErr, setRowErr] = useState<{ id: string; text: string } | null>(null);

  const add = async () => {
    await run('doc', 'post', url, { op: 'add', docType: type, required, expiresOn: expires || null, status: received ? 'RECEIVED' : 'MISSING', notes: notes.trim() || null }, `Added the ${COMPLIANCE_DOC_LABELS[type].toLowerCase()}`);
    setExpires('');
    setNotes('');
  };
  const doVerify = async (id: string, exp: string) => {
    const r = await run(`v:${id}`, 'post', url, { op: 'verify', docId: id, expiresOn: exp || null }, 'Verified. Merit Books is told when this releases a hold', { quietError: true });
    setRowErr(r.error ? { id, text: r.error.error } : null);
    if (!r.error) setVerify(null);
  };

  return (
    <div className="mp-table">
      {docs.length === 0 ? (
        <p className="t-cap" style={{ padding: 16 }}>No documents on file. Add the certificate of insurance and lien waivers you require; required documents that lapse hold payment in Merit Books.</p>
      ) : (
        <table className="tbl tbl-q tbl-q--compact">
          <colgroup><col /><col style={{ width: 168 }} /><col style={{ width: 104 }} /><col style={{ width: 88 }} /><col style={{ width: 300 }} /></colgroup>
          <thead><tr><th>Document</th><th>Status</th><th>Expires</th><th>Required</th><th><span className="sr">Actions</span></th></tr></thead>
          <tbody>
            {docs.map((d) => {
              const mk = complianceMark(d, today);
              return (
                <tr key={d.id} className="q-row">
                  <td>
                    <span className="l1">{COMPLIANCE_DOC_LABELS[d.doc_type]}</span>
                    <span className="l2">{[d.notes, d.amount_cents != null ? money(d.amount_cents) : null, d.verified_at ? `verified ${shortDate(d.verified_at.slice(0, 10))}` : null].filter(Boolean).join(' · ') || ' '}</span>
                    {rowErr?.id === d.id && <span className="field-error" style={{ display: 'block' }}>{rowErr.text}</span>}
                  </td>
                  <td><MarkStatus mark={mk} /></td>
                  <td>{d.expires_on ? shortDate(d.expires_on) : '—'}</td>
                  <td>{d.required ? 'Yes' : 'No'}</td>
                  <td>
                    {can && (
                      verify?.id === d.id ? (
                        <form className="row" onSubmit={(e) => { e.preventDefault(); void doVerify(d.id, verify.expires); }}>
                          <Input type="date" aria-label="Expires on" value={verify.expires} onChange={(e) => setVerify({ id: d.id, expires: e.target.value })} />
                          <Button type="submit" variant="primary" disabled={busy === `v:${d.id}`}>Verify</Button>
                          <Button onClick={() => setVerify(null)}>Cancel</Button>
                        </form>
                      ) : (
                        <div className="btn-row">
                          {d.status !== 'VERIFIED' && d.status !== 'RECEIVED' && <Button variant="quiet" disabled={busy === `r:${d.id}`} onClick={() => void run(`r:${d.id}`, 'post', url, { op: 'update', docId: d.id, status: 'RECEIVED' }, 'Marked received')}>Received</Button>}
                          {d.status !== 'VERIFIED' && <Button variant="quiet" disabled={busy === `x:${d.id}`} onClick={() => void run(`x:${d.id}`, 'post', url, { op: 'remove', docId: d.id }, 'Removed the document')}>Remove</Button>}
                          {(d.status !== 'VERIFIED' || mk.word === 'Expired') && (
                            <Button disabled={busy === `v:${d.id}`} onClick={() => setVerify({ id: d.id, expires: d.expires_on ?? '' })}>{d.status === 'VERIFIED' ? 'Re-verify' : 'Verify'}</Button>
                          )}
                        </div>
                      )
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {can && (
        <form className="mp-add" onSubmit={(e) => { e.preventDefault(); void add(); }} aria-label="Add a compliance document">
          <Field label="Document"><Select value={type} onChange={(e) => setType(e.target.value as ComplianceDocType)} style={{ width: 220 }}>{DOC_TYPES.map((t) => <option key={t} value={t}>{COMPLIANCE_DOC_LABELS[t]}</option>)}</Select></Field>
          <Field label="Expires on"><Input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></Field>
          <Field label="Notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={1} maxLength={2000} style={{ minHeight: 32 }} /></Field>
          <Field label="Required"><Check aria-label="Required to pay" checked={required} onChange={(e) => setRequired(e.target.checked)} /></Field>
          <Field label="In hand"><Check aria-label="Received" checked={received} onChange={(e) => setReceived(e.target.checked)} /></Field>
          <Button type="submit" icon="plus" disabled={busy === 'doc'}>Add document</Button>
        </form>
      )}
    </div>
  );
}
