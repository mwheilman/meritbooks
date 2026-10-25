'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button, Check, ConfirmDialog, Field, Keybar, QueueTable, Search, Select, Status, Tabs, WidgetState, api, count, money, toast,
  useDebounce, type QueueColumn, type QueueGroup,
} from '@meritbooks/merit-ui';
import type { ApprovalCounts, ApprovalItem, ApprovalObjectType, ApprovalTab, BulkResult, DecideResult } from '@/lib/approvals/types';
import { OBJECT_LABELS, decideToast, dueText, itemStatus } from '@/lib/approvals/labels';
import { bulkAllowed, filterItems, groupByDue, typeCounts, visibleTotal } from '@/lib/approvals/filter';
import { ApprovalPanel } from './ApprovalPanel';

export interface ApprovalInboxProps {
  tab: ApprovalTab;
  items: ApprovalItem[];
  counts: ApprovalCounts;
  /** Show the "All open" tab (management / settings owners). */
  showAll: boolean;
  readOnly: boolean;
  where: string;
}

const GROUP_TITLES = { overdue: 'Overdue', today: 'Due today', later: 'Later' } as const;
const TAB_EMPTY: Readonly<Record<ApprovalTab, { kind: 'done' | 'empty'; title: string; body: string }>> = {
  mine: { kind: 'done', title: 'Nothing waits on you', body: 'Change orders, POs, billing, draws, time and budget moves that need your approval land here.' },
  waiting: { kind: 'done', title: 'Nothing you sent is waiting', body: 'Items you prepared show here until the last approver decides.' },
  decided: { kind: 'empty', title: 'No decisions in the last 60 days', body: 'Items you approved, sent back or sent for approval show here.' },
  all: { kind: 'done', title: 'No open approvals', body: 'Every open approval in the companies you oversee shows here.' },
};

type Dialog =
  | { kind: 'reject'; rows: ApprovalItem[] }
  | { kind: 'self'; row: ApprovalItem }
  | { kind: 'reason'; row: ApprovalItem }
  | null;

/**
 * One queue across every approvable object (BP-30). Sorted by due date, then dollar impact;
 * J/K move, A approves, R sends back with a reason, X selects for a bulk approve where the type
 * allows it, ↵ opens the decision panel (a full-screen sheet on a phone).
 */
export function ApprovalInbox(p: ApprovalInboxProps) {
  const router = useRouter();
  const [text, setText] = useState('');
  const needle = useDebounce(text, 150);
  const [type, setType] = useState<ApprovalObjectType | ''>('');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [cursorId, setCursorId] = useState<string | null>(p.items[0]?.id ?? null);
  const [open, setOpen] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [done, setDone] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);

  const visible = useMemo(
    () => filterItems(p.items, { types: type ? [type] : [], text: needle, overdueOnly }),
    [p.items, type, needle, overdueOnly],
  );
  const types = useMemo(() => typeCounts(p.items), [p.items]);
  const actable = p.tab === 'mine' && !p.readOnly;
  const openItem = p.items.find((i) => i.id === open) ?? null;

  const finish = useCallback((ids: ReadonlyArray<string>) => {
    setDone((d) => new Set([...d, ...ids]));
    setSelected(new Set());
    router.refresh();
  }, [router]);

  const approve = useCallback(async (row: ApprovalItem, body: { reason?: string; selfReason?: string } = {}) => {
    if (!row.can_act || done.has(row.id)) return;
    if (row.self_approval && !body.selfReason) { setDialog({ kind: 'self', row }); return; }
    if (row.needs_reason && !body.reason) { setDialog({ kind: 'reason', row }); return; }
    setBusy(true);
    const r = await api.post<DecideResult>(`/api/approvals/${row.id}/approve`, { ...body, channel: 'web' });
    setBusy(false);
    if (r.error) { toast.error(r.error.error); return; }
    if (r.data) toast(decideToast(r.data));
    finish([row.id]);
  }, [done, finish]);

  const reject = useCallback(async (rows: ApprovalItem[], reason: string) => {
    setBusy(true);
    if (rows.length === 1) {
      const r = await api.post<DecideResult>(`/api/approvals/${rows[0]!.id}/reject`, { reason, channel: 'web' });
      setBusy(false);
      if (r.error) throw new Error(r.error.error);
      toast(decideToast(r.data ?? { status: 'rejected', waiting_on: null, title: rows[0]!.title, message: null }));
      finish([rows[0]!.id]);
      return;
    }
    const r = await api.post<BulkResult>('/api/approvals/bulk', { ids: rows.map((x) => x.id), decision: 'reject', reason, channel: 'web' });
    setBusy(false);
    if (r.error) throw new Error(r.error.error);
    toast(`Sent back ${count(r.data?.done ?? 0)}${r.data?.refused ? ` · ${count(r.data.refused)} refused` : ''}`);
    finish(rows.map((x) => x.id));
  }, [finish]);

  const bulkApprove = useCallback(async (rows: ApprovalItem[]) => {
    if (!bulkAllowed(rows)) { toast.error('Some of these need to be opened and approved on their own.'); return; }
    setBusy(true);
    const r = await api.post<BulkResult>('/api/approvals/bulk', { ids: rows.map((x) => x.id), decision: 'approve', channel: 'web' });
    setBusy(false);
    if (r.error || !r.data) { toast.error(r.error?.error ?? 'Nothing was approved.'); return; }
    const refused = r.data.results.filter((x) => !x.ok);
    toast(`Approved ${count(r.data.done)}${refused.length ? ` · ${count(refused.length)} refused: ${refused[0]!.error ?? ''}` : ''}`);
    finish(r.data.results.filter((x) => x.ok).map((x) => x.id));
  }, [finish]);

  const columns: QueueColumn<ApprovalItem>[] = [
    {
      id: 'item',
      header: 'Item',
      cell: (i) => (
        <>
          <span className="l1">{i.title}</span>
          <span className="l2">{[OBJECT_LABELS[i.object_type].one, i.job_label ?? i.summary, i.company].filter(Boolean).join(' · ')}</span>
        </>
      ),
    },
    { id: 'amt', header: 'Amount', numeric: true, width: 128, cell: (i) => (i.amount_cents === null ? '—' : money(i.amount_cents)) },
    {
      id: 'state',
      header: 'Where it is',
      width: 200,
      cell: (i) => {
        const s = itemStatus(i);
        return (
          <>
            <Status kind={s.kind}>{s.word}</Status>
            <span className="l2">{i.status === 'PENDING' ? `${i.step_label ?? 'Approver'}${i.on_behalf_of ? ` · for ${i.on_behalf_of}` : ''}` : i.decided_by ?? ' '}</span>
          </>
        );
      },
    },
    { id: 'due', header: 'Due', width: 128, className: 'ap-hide-sm', cell: (i) => <span className="l2">{i.status === 'PENDING' ? dueText(i.due_at) : '—'}</span> },
    { id: 'from', header: 'From', width: 160, className: 'ap-hide-sm', cell: (i) => <span className="l2">{i.prepared_by ?? i.submitted_by ?? '—'}</span> },
  ];

  const groups: QueueGroup<ApprovalItem>[] | undefined = p.tab === 'decided'
    ? undefined
    : groupByDue(visible).map((g) => {
      const t = visibleTotal(g.rows);
      return { id: g.id, title: GROUP_TITLES[g.id], rows: g.rows, caption: t.cents ? money(t.cents, { decimals: 0 }) : undefined };
    });

  const tabItems = [
    { value: 'mine' as const, label: 'Needs me', count: count(p.counts.mine) },
    { value: 'waiting' as const, label: 'Waiting on others', count: count(p.counts.waiting) },
    { value: 'decided' as const, label: 'Decided' },
    ...(p.showAll ? [{ value: 'all' as const, label: 'All open' }] : []),
  ];

  return (
    <div className="stack">
      <Tabs<ApprovalTab> aria-label="Approvals" items={tabItems} value={p.tab} onChange={(t) => router.push(`/approvals?tab=${t}`)} />

      <div className="ap-toolbar">
        <Search aria-label="Search approvals" slashToFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Job, vendor, number, person" />
        <Field label="Type">
          <Select value={type} onChange={(e) => setType(e.target.value as ApprovalObjectType | '')}>
            <option value="">Everything ({count(p.items.length)})</option>
            {types.map((t) => <option key={t.type} value={t.type}>{OBJECT_LABELS[t.type].many} ({count(t.count)})</option>)}
          </Select>
        </Field>
        {p.tab !== 'decided' && <Check label={`Overdue only${p.counts.mine_overdue ? ` (${count(p.counts.mine_overdue)} need you)` : ''}`} checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} />}
        <span className="sp" />
      </div>

      <div className={openItem ? 'ap-split has-panel' : 'ap-split'}>
        <div className="ap-table" style={{ minWidth: 0 }}>
          {visible.length === 0 ? (
            <WidgetState state={p.items.length === 0 ? TAB_EMPTY[p.tab] : { kind: 'done', title: 'Nothing matches these filters', body: 'Clear the search or pick another type.' }} />
          ) : (
            <QueueTable
              aria-label={`${p.where}, approvals`}
              columns={columns}
              rows={groups ? undefined : visible}
              groups={groups}
              getRowId={(i) => i.id}
              rowState={(i) => ({ done: done.has(i.id), attn: i.overdue || i.escalated })}
              cursorId={cursorId}
              onCursorChange={(id) => setCursorId(id)}
              openOnClick
              onOpen={(i) => { setCursorId(i.id); setOpen(i.id); }}
              selectable={actable}
              selected={selected}
              onSelectedChange={setSelected}
              actions={actable ? [
                { key: 'a', label: 'approve', run: (rs) => { if (rs.length > 1) void bulkApprove(rs); else if (rs[0]) void approve(rs[0]); } },
                { key: 'r', label: 'send back', run: (rs) => { const act = rs.filter((x) => x.can_act); if (act.length) setDialog({ kind: 'reject', rows: act }); } },
              ] : []}
              bulkSummary={(rs) => {
                const t = visibleTotal(rs);
                return [`${count(rs.length)} selected`, ...(t.cents ? [money(t.cents)] : []), ...(bulkAllowed(rs) ? [] : ['some need their own look'])];
              }}
              bulkActions={(rs) => (
                <>
                  <Button disabled={busy} onClick={() => setDialog({ kind: 'reject', rows: rs })}>Send back {count(rs.length)}</Button>
                  <Button variant="primary" disabled={busy || !bulkAllowed(rs)} onClick={() => void bulkApprove(rs)}>Approve {count(rs.length)}</Button>
                </>
              )}
            />
          )}
        </div>
        {openItem && (
          <ApprovalPanel
            key={openItem.id}
            item={openItem}
            busy={busy}
            canAct={actable && openItem.can_act && !done.has(openItem.id)}
            onClose={() => setOpen(null)}
            onApprove={() => void approve(openItem)}
            onReject={() => setDialog({ kind: 'reject', rows: [openItem] })}
            onChanged={() => { setOpen(null); router.refresh(); }}
          />
        )}
      </div>

      {visible.length > 0 && (
        <Keybar
          hints={[{ chord: 'j k', label: 'move' }, { chord: 'enter', label: 'open' }, ...(actable ? [{ chord: 'x', label: 'select' }, { chord: 'a', label: 'approve' }, { chord: 'r', label: 'send back' }] : []), { chord: '/', label: 'search' }]}
          note="Nobody approves what they prepared; every decision is logged with who, when and why"
        />
      )}

      <ConfirmDialog
        open={dialog?.kind === 'reject'}
        onClose={() => setDialog(null)}
        tone="danger"
        title={dialog?.kind === 'reject' && dialog.rows.length > 1 ? `Send back ${dialog.rows.length} items` : `Send back ${dialog?.kind === 'reject' ? dialog.rows[0]?.title ?? '' : ''}`}
        confirmLabel={dialog?.kind === 'reject' && dialog.rows.length > 1 ? `Send back ${dialog.rows.length}` : 'Send back'}
        reason={{ label: 'Why', minLength: 3, placeholder: 'Wrong cost code — use 03 30 00' }}
        onConfirm={async (reason) => { if (dialog?.kind === 'reject') await reject(dialog.rows, reason ?? ''); }}
      >
        The person who sent it sees your reason and can fix it and send it again.
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog?.kind === 'self'}
        onClose={() => setDialog(null)}
        title={`Approve your own ${dialog?.kind === 'self' ? OBJECT_LABELS[dialog.row.object_type].one.toLowerCase() : 'item'}`}
        confirmLabel="Approve with reason"
        reason={{ label: 'Why you are approving it yourself', minLength: 5, placeholder: 'I am the only person here who approves' }}
        footNote="It goes on the controller's exception report."
        onConfirm={async (reason) => { if (dialog?.kind === 'self') { const row = dialog.row; setDialog(null); await approve(row, { selfReason: reason ?? '' }); } }}
      >
        You prepared this. In a one- or two-person company you may approve it yourself with a typed reason.
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog?.kind === 'reason'}
        onClose={() => setDialog(null)}
        title={`Approve ${dialog?.kind === 'reason' ? dialog.row.title : ''} below the floor`}
        confirmLabel="Approve with reason"
        reason={{ label: 'Why it is fine below the floor', minLength: 3, placeholder: 'Matching a competitor quote on a repeat customer' }}
        onConfirm={async (reason) => { if (dialog?.kind === 'reason') { const row = dialog.row; setDialog(null); await approve(row, { reason: reason ?? '' }); } }}
      >
        The gross on this deal is below the margin floor, so the approval needs a reason.
      </ConfirmDialog>
    </div>
  );
}
