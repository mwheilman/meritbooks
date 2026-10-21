'use client';

import { useMemo, useState } from 'react';
import {
  Button, Field, Input, InlineNotice, Keybar, MoneyInput, Panel, PanelSection, QueueTable, Seg, Select, Textarea, WidgetState, money,
  useEscapeKey, type QueueColumn,
} from '@meritbooks/merit-ui';
import type { CostCodeRow } from '@/lib/pm/types';
import type {
  CommitmentChangeRow, CommitmentLineRow, CommitmentRow, CommitmentStatusRow, CommitmentType, ComplianceDocRow, ReceiptRow,
} from '@/lib/pm/money/types';
import { commitmentTotals, totalsFor, type CommitmentTotals } from '@/lib/pm/money/summaries';
import { extendCents } from '@/lib/pm/money/aia';
import { commitmentMark } from '@/lib/pm/money/status';
import { useShell, useVocab } from '@/components/shell/ShellContext';
import { useAction } from '@/components/job/useAction';
import { lower } from '@/lib/pm/vocab';
import { MarkStatus, m, parsePct } from './common';
import { VendorPicker, type VendorValue } from './VendorPicker';
import { vendorKindFor } from '@/lib/pm/parties/schemas';
import { CommitmentDetail } from './CommitmentDetail';

export interface OwnerCoOption { id: string; number: string | null; title: string; stage: string }

export interface CommitmentsTabProps {
  jobId: string;
  commitments: CommitmentRow[];
  lines: CommitmentLineRow[];
  status: CommitmentStatusRow[];
  changes: CommitmentChangeRow[];
  receipts: ReceiptRow[];
  compliance: ComplianceDocRow[];
  vendors: Record<string, string>;
  costCodes: CostCodeRow[];
  ownerCos: OwnerCoOption[];
  currentUserId: string;
  booksPresent: boolean;
  today: string;
  /** Budget total by cost code id (for "committed vs budget" in the create panel). */
  budgetByCode: Record<string, number>;
}

export interface CommitmentListRow extends CommitmentRow {
  t: CommitmentTotals;
  vendorName: string | null;
}

type Show = 'open' | 'draft' | 'closed' | 'all';

const TYPE_WORDS: Record<CommitmentType, string> = { PO: 'Purchase order', SUBCONTRACT: 'Subcontract' };

export function CommitmentsTab(p: CommitmentsTabProps) {
  const v = useVocab();
  const { readOnly } = useShell();
  const totals = useMemo(() => commitmentTotals(p.status), [p.status]);
  const rows: CommitmentListRow[] = useMemo(
    () => p.commitments.map((c) => ({ ...c, t: totalsFor(totals, c), vendorName: (c.vendor_id && p.vendors[c.vendor_id]) || totals.get(c.id)?.vendorName || null })),
    [p.commitments, totals, p.vendors],
  );
  const [show, setShow] = useState<Show>('open');
  const [cursorId, setCursorId] = useState<string | null>(rows.find((r) => r.status !== 'VOID' && r.status !== 'CLOSED')?.id ?? rows[0]?.id ?? null);
  const [creating, setCreating] = useState(false);

  const visible = rows.filter((r) =>
    show === 'all' ? true : show === 'draft' ? r.status === 'DRAFT' : show === 'closed' ? r.status === 'CLOSED' || r.status === 'VOID' : r.status === 'APPROVED' || r.status === 'EXECUTED' || r.status === 'DRAFT');
  const cursor = rows.find((r) => r.id === cursorId) ?? null;
  const live = rows.filter((r) => r.status === 'APPROVED' || r.status === 'EXECUTED');
  const sum = (f: (t: CommitmentTotals) => number) => live.reduce((s, r) => s + f(r.t), 0);

  const columns: QueueColumn<CommitmentListRow>[] = [
    { id: 'num', header: 'Number', width: 156, cell: (c) => <span className="code">{c.number}</span> },
    { id: 'who', header: 'Vendor', cell: (c) => <><span className="l1">{c.vendorName ?? 'No vendor yet'}</span><span className="l2">{[TYPE_WORDS[c.commitment_type], c.title].filter(Boolean).join(' · ')}</span></> },
    { id: 'st', header: 'Status', width: 152, cell: (c) => <MarkStatus mark={commitmentMark(c.status, c.t.holdEffective)} /> },
    { id: 'com', header: 'Committed', numeric: true, width: 128, cell: (c) => m(c.t.committed) },
    { id: 'rec', header: 'Received', numeric: true, width: 120, cell: (c) => m(c.t.received) },
    { id: 'bil', header: 'Billed', numeric: true, width: 120, cell: (c) => m(c.t.billed) },
    { id: 'open', header: 'Open', numeric: true, width: 120, cell: (c) => (c.t.overBilled > 0 ? <span className="neg b">({money(c.t.overBilled)}) over</span> : m(c.t.open)) },
  ];

  if (rows.length === 0 && !creating) {
    return (
      <div className="surface">
        <WidgetState
          state={{
            kind: 'empty',
            title: `No ${lower(v.commitments)} on this job yet`,
            body: 'Commit cost to a vendor with a purchase order or a subcontract, by cost code. Merit Books matches the vendor’s bills to it and holds payment when compliance lapses.',
            action: readOnly ? undefined : <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>New {lower(v.commitment)}</Button>,
          }}
        />
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="row row--between" style={{ alignItems: 'flex-end' }}>
        <div className="row" style={{ gap: 24 }}>
          <Seg<Show>
            aria-label="Show"
            value={show}
            onChange={setShow}
            items={[
              { value: 'open', label: 'Open', count: rows.filter((r) => r.status === 'APPROVED' || r.status === 'EXECUTED' || r.status === 'DRAFT').length },
              { value: 'draft', label: 'Drafts', count: rows.filter((r) => r.status === 'DRAFT').length },
              { value: 'closed', label: 'Closed', count: rows.filter((r) => r.status === 'CLOSED' || r.status === 'VOID').length },
              { value: 'all', label: 'All', count: rows.length },
            ]}
          />
          <span className="t-cap tnum">
            Approved: {m(sum((t) => t.committed))} committed · {m(sum((t) => t.received))} received · {m(sum((t) => t.billed))} billed in Merit Books · {m(sum((t) => t.open))} open
          </span>
        </div>
        {!readOnly && <Button variant="primary" icon="plus" chord="c" bindChord={!creating} onClick={() => setCreating(true)}>New {lower(v.commitment)}</Button>}
      </div>

      <div className={creating ? 'mp-split has-panel' : 'mp-split'}>
        <div className="mp-table" style={{ minWidth: 0 }}>
          {visible.length === 0 ? (
            <WidgetState state={{ kind: 'done', title: show === 'draft' ? 'No drafts' : show === 'closed' ? 'Nothing closed yet' : 'Nothing open', body: 'Switch the view above to see the others.' }} />
          ) : (
            <QueueTable
              aria-label={`${v.commitments} on this job`}
              columns={columns}
              rows={visible}
              getRowId={(c) => c.id}
              cursorId={cursorId}
              onCursorChange={(id) => setCursorId(id)}
              onOpen={(c) => { setCursorId(c.id); setCreating(false); }}
              rowState={(c) => ({ done: c.status === 'VOID' || c.status === 'CLOSED', attn: c.t.holdEffective || c.t.overBilled > 0 })}
            />
          )}
        </div>
        {creating && (
          <NewCommitmentPanel jobId={p.jobId} costCodes={p.costCodes} budgetByCode={p.budgetByCode} onClose={() => setCreating(false)} onCreated={(id) => { setCursorId(id); setCreating(false); }} />
        )}
      </div>

      {visible.length > 0 && (
        <Keybar hints={[{ chord: 'j k', label: 'move' }, { chord: 'enter', label: 'open' }, ...(!readOnly ? [{ chord: 'c', label: `new ${lower(v.commitment)}` }] : [])]} note="Approving sends the commitment to Merit Books, which matches the vendor’s bills to it" />
      )}

      {cursor && !creating && (
        <CommitmentDetail
          key={cursor.id}
          row={cursor}
          lines={p.lines.filter((l) => l.commitment_id === cursor.id)}
          status={p.status.filter((s) => s.commitment_id === cursor.id)}
          changes={p.changes.filter((x) => x.commitment_id === cursor.id)}
          receipts={p.receipts.filter((x) => x.commitment_id === cursor.id)}
          compliance={p.compliance.filter((x) => x.commitment_id === cursor.id)}
          costCodes={p.costCodes}
          ownerCos={p.ownerCos}
          currentUserId={p.currentUserId}
          booksPresent={p.booksPresent}
          today={p.today}
          onGone={() => setCursorId(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

interface DraftLine { cc: string; desc: string; qty: string; unit: number | null; amount: number | null }

function NewCommitmentPanel({ jobId, costCodes, budgetByCode, onClose, onCreated }: { jobId: string; costCodes: CostCodeRow[]; budgetByCode: Record<string, number>; onClose: () => void; onCreated: (id: string) => void }) {
  // the job's company (its cost codes are the job company's library + job codes)
  const companyId = costCodes[0]?.location_id ?? null;
  const v = useVocab();
  const { run, busy } = useAction();
  const active = costCodes.filter((c) => c.is_active);
  const [type, setType] = useState<CommitmentType>('SUBCONTRACT');
  const [vendor, setVendor] = useState<VendorValue>({ id: null, name: '' });
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [ret, setRet] = useState('0');
  const [lines, setLines] = useState<DraftLine[]>([{ cc: active[0]?.id ?? '', desc: '', qty: '', unit: null, amount: null }]);
  const [err, setErr] = useState<Record<string, string>>({});
  useEscapeKey(onClose, busy !== 'create', 'New commitment');

  const lineAmount = (l: DraftLine): number | null => {
    if (l.qty.trim() && l.unit != null) {
      if (!/^\d{1,10}(\.\d{1,4})?$/.test(l.qty.trim())) return null;
      return extendCents(l.qty.trim(), l.unit);
    }
    return l.amount;
  };
  const total = lines.reduce((s, l) => s + (lineAmount(l) ?? 0), 0);

  const submit = async () => {
    const e: Record<string, string> = {};
    if (!title.trim()) e.title = 'Name it, like “Plumbing rough and finish”.';
    const r = parsePct(ret || '0');
    if (r == null) e.ret = 'Retainage is 0 to 100 percent.';
    const good = lines.filter((l) => (lineAmount(l) ?? 0) > 0 || l.desc.trim());
    if (good.some((l) => !l.cc)) e.lines = 'Every line needs a cost code before it can be approved.';
    if (good.some((l) => l.qty.trim() && !/^\d{1,10}(\.\d{1,4})?$/.test(l.qty.trim()))) e.lines = 'Quantities take up to 4 decimals, like 12.5.';
    setErr(e);
    if (Object.keys(e).length) return;
    const res = await run<{ commitmentId: string; number: string }>('create', 'post', `/api/jobs/${jobId}/commitments`, {
      type, vendorId: vendor.id, title: title.trim(), description: desc.trim() || null, retainagePct: r ?? 0,
      lines: good.map((l) => ({ costCodeId: l.cc || null, description: l.desc.trim(), qty: l.qty.trim() || null, unitCostCents: l.qty.trim() ? l.unit : null, amountCents: l.qty.trim() ? null : l.amount ?? 0 })),
    }, (d) => `Created ${d.number} as a draft`);
    if (res.data) onCreated(res.data.commitmentId);
  };

  return (
    <Panel
      eyebrow={['New', type === 'PO' ? 'Purchase order' : 'Subcontract']}
      title={title.trim() || `Untitled ${lower(v.commitment)}`}
      meta={`${money(total)} · the number is assigned when you create it`}
      onClose={onClose}
      foot={
        <div className="btn-row" style={{ justifyContent: 'flex-end', width: '100%' }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" chord="mod+enter" bindChord disabled={busy === 'create'} onClick={() => void submit()}>Create draft</Button>
        </div>
      }
    >
      <PanelSection>
        <form className="mp-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <Field label="Kind">
            <Seg<CommitmentType> aria-label="Kind" value={type} onChange={setType} items={[{ value: 'SUBCONTRACT', label: 'Subcontract' }, { value: 'PO', label: 'Purchase order' }]} />
          </Field>
          <Field label="Vendor"><VendorPicker value={vendor} onChange={setVendor} onPick={(o) => setRet(String(Math.round(o.retainagePct * 10000) / 100))} add={{ kind: vendorKindFor(type), companyId }} /></Field>
          <Field label="What it covers" error={err.title}><Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Plumbing rough and finish" maxLength={200} /></Field>
          <Field label="Retainage %" error={err.ret} help="Held back from the vendor’s bills in Merit Books"><Input inputMode="decimal" value={ret} onChange={(e) => setRet(e.target.value)} style={{ width: 96 }} /></Field>
          <Field label="Scope notes"><Textarea value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={2000} /></Field>
          <fieldset className="stack" style={{ border: 0, padding: 0, gap: 12 }}>
            <legend className="field-label">Lines by cost code</legend>
            {lines.map((l, i) => {
              const amt = lineAmount(l);
              const bud = l.cc ? budgetByCode[l.cc] : undefined;
              return (
                <div key={i} className="stack" style={{ gap: 8, paddingBottom: 12, borderBottom: '1px solid var(--line)' }}>
                  <div className="row">
                    <Select aria-label={`Line ${i + 1} cost code`} value={l.cc} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, cc: e.target.value } : x)))} style={{ flex: 1 }}>
                      <option value="">Pick a cost code</option>
                      {active.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
                    </Select>
                    {lines.length > 1 && <Button variant="quiet" iconOnly icon="x" aria-label={`Remove line ${i + 1}`} onClick={() => setLines(lines.filter((_, j) => j !== i))} />}
                  </div>
                  <Input aria-label={`Line ${i + 1} description`} value={l.desc} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, desc: e.target.value } : x)))} placeholder="Description" maxLength={200} />
                  <div className="row">
                    <Input aria-label={`Line ${i + 1} quantity`} inputMode="decimal" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} placeholder="Qty" style={{ width: 72 }} />
                    {l.qty.trim() ? (
                      <MoneyInput aria-label={`Line ${i + 1} unit cost`} valueCents={l.unit} onChangeCents={(c) => setLines(lines.map((x, j) => (j === i ? { ...x, unit: c } : x)))} placeholder="Unit cost" />
                    ) : (
                      <MoneyInput aria-label={`Line ${i + 1} amount`} valueCents={l.amount} onChangeCents={(c) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: c } : x)))} placeholder="Amount" />
                    )}
                    <span className="tnum" style={{ minWidth: 96, textAlign: 'right' }}>{amt == null ? '—' : money(amt)}</span>
                  </div>
                  {bud != null && <span className="t-cap">Budget on this code {money(bud)}</span>}
                </div>
              );
            })}
            {err.lines && <span className="field-error">{err.lines}</span>}
            <div><Button icon="plus" onClick={() => setLines([...lines, { cc: lines[lines.length - 1]?.cc ?? '', desc: '', qty: '', unit: null, amount: null }])}>Add line</Button></div>
          </fieldset>
          {!vendor.id && <InlineNotice title="No vendor yet.">You can save the draft now; it needs a vendor before anyone approves it. A subcontractor or supplier you have not used before can be added from the vendor field: Merit Books will request their W-9 and certificate of insurance.</InlineNotice>}
          <button type="submit" hidden />
        </form>
      </PanelSection>
    </Panel>
  );
}
