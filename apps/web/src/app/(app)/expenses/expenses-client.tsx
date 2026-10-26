'use client';

import { useState, useCallback, useMemo } from 'react';
import {
  Button,
  ButtonLink,
  ButtonRow,
  Check,
  ConfirmDialog,
  Dialog,
  Eyebrow,
  Field,
  Icon,
  InlineNotice,
  Input,
  Keybar,
  QueueTable,
  Search,
  Seg,
  Select,
  Status,
  Tabs,
  Tag,
  cx,
  type QueueColumn,
  type StatusKind,
  type TagTone,
} from '@meritbooks/merit-ui';
import { formatMoney } from '@meritbooks/shared';
import { useQuery, useMutation, addToast, useDebounce } from '@/hooks';
import { api } from '@/lib/api-client';
import { useMe } from '@/lib/hooks/use-me';
import { StatusBadge, EmptyState, TableSkeleton } from '@/components/ui';
import { DetailDrawer, DetailSection, DetailField } from '@/components/detail-drawer';
import { useShellLine } from '@/components/layout/shell-context';
import {
  summarizeViolations, agingLabel, agingTone,
  type LineViolationsInput, type AgingTone,
} from '@/lib/expenses/queue-summary';
import s from './expenses.module.css';

type Scope = 'mine' | 'queue' | 'batch';
type ReportStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REIMBURSED' | 'REJECTED';

interface ReportRow {
  id: string;
  title: string | null;
  status: ReportStatus;
  total_cents: number;
  reimbursable_cents: number;
  card_cents: number;
  policy_flag_count: number;
  submitted_by: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  created_at: string;
  // Enriched (queue / batch scopes only)
  employee_name?: string | null;
  block_count?: number;
  warn_count?: number;
  info_count?: number;
  aging_days?: number | null;
}
interface ListResponse {
  data: ReportRow[];
  counts: Record<string, number>;
  scope: Scope;
}

interface PolicyReason { code: string; message: string; severity: 'info' | 'warn' | 'block' }
interface LineRow {
  id: string;
  line_number: number;
  expense_date: string;
  merchant: string | null;
  description: string | null;
  amount_cents: number;
  payment_source: 'OUT_OF_POCKET' | 'CORPORATE_CARD';
  has_receipt: boolean;
  policy_flag: boolean;
  policy_reasons: PolicyReason[];
  bank_transaction_id: string | null;
  billable: boolean;
  account: { id: string; account_number: string; name: string } | null;
}
interface DetailResponse {
  report: ReportRow & { employee_name: string | null; location_id: string | null };
  lines: LineRow[];
  policy: {
    active: { name: string; version: number } | null;
    requiredApprovalTier: string | null;
    blockCount: number;
    warnCount: number;
  } | null;
}

const TABS: { key: Scope; label: string }[] = [
  { key: 'mine', label: 'My reports' },
  { key: 'queue', label: 'Approver queue' },
  { key: 'batch', label: 'Reimbursement batch' },
];

/** Waiting-time tone → kit status (pip shape + word; never colour alone). */
const AGING_STATUS: Record<AgingTone, StatusKind> = {
  fresh: 'track',
  aging: 'risk',
  stale: 'overdue',
};

const SEVERITY_TONE: Record<string, TagTone> = { info: 'default', warn: 'warn', block: 'neg' };
const SEVERITY_WORD: Record<string, string> = { info: 'Note', warn: 'Warn', block: 'Block' };

type PolicyFilter = 'all' | 'block' | 'warn' | 'clean';

const SOD_TITLE = 'You submitted this report — a different approver must review it (segregation of duties)';

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function ExpensesClient() {
  const me = useMe();
  const [scope, setScope] = useState<Scope>('mine');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [search, setSearch] = useState('');
  const q = useDebounce(search, 250).trim().toLowerCase();
  const [policyFilter, setPolicyFilter] = useState<PolicyFilter>('all');
  const [cursor, setCursor] = useState<string | null>(null);
  const [queueSel, setQueueSel] = useState<Set<string>>(new Set());
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [rejecting, setRejecting] = useState<ReportRow[] | null>(null);

  const { data, isLoading, error, refetch } = useQuery<ListResponse>(
    '/api/expenses',
    { scope },
    { key: `${scope}:${refreshKey}` },
  );

  const bump = useCallback(() => {
    setRefreshKey((k) => k + 1);
    refetch();
  }, [refetch]);

  const counts = useMemo(() => data?.counts ?? {}, [data]);
  const rows = useMemo(() => data?.data ?? [], [data]);

  const changeScope = (next: Scope) => {
    setScope(next);
    setCursor(null);
    setQueueSel(new Set());
  };

  // Context line: the org-wide status counts (stable across tabs).
  useShellLine(
    data
      ? [
          { label: `${plural(counts.SUBMITTED ?? 0, 'report')} awaiting approval`, strong: (counts.SUBMITTED ?? 0) > 0 },
          `${counts.APPROVED ?? 0} ready to reimburse`,
          `${counts.DRAFT ?? 0} draft`,
          `${counts.REIMBURSED ?? 0} reimbursed`,
        ]
      : null,
    data ? `${counts.SUBMITTED ?? 0}:${counts.APPROVED ?? 0}:${counts.DRAFT ?? 0}:${counts.REIMBURSED ?? 0}` : 'none',
  );

  // Client-side search + policy filter over the loaded scope.
  const visible = useMemo(() => {
    return rows.filter((r) => {
      if (q) {
        const hay = `${r.title ?? ''} ${r.employee_name ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (scope === 'queue' && policyFilter !== 'all') {
        const b = r.block_count ?? 0;
        const w = r.warn_count ?? 0;
        if (policyFilter === 'block' && b === 0) return false;
        if (policyFilter === 'warn' && (w === 0 || b > 0)) return false;
        if (policyFilter === 'clean' && (b > 0 || w > 0)) return false;
      }
      return true;
    });
  }, [rows, q, scope, policyFilter]);

  const policyCounts = useMemo(() => {
    let block = 0, warn = 0, clean = 0;
    for (const r of rows) {
      const b = r.block_count ?? 0, w = r.warn_count ?? 0;
      if (b > 0) block++;
      else if (w > 0) warn++;
      else clean++;
    }
    return { block, warn, clean };
  }, [rows]);

  // ── Approver actions (row buttons, A / R keys, bulk bar) ─────────────────
  const isMine = useCallback(
    (r: ReportRow) => !!me.user?.clerkId && r.submitted_by === me.user.clerkId,
    [me.user?.clerkId],
  );

  const setBusy = (ids: string[], on: boolean) =>
    setBusyIds((prev) => {
      const n = new Set(prev);
      ids.forEach((id) => (on ? n.add(id) : n.delete(id)));
      return n;
    });

  const approveMany = useCallback(
    async (targets: ReportRow[]) => {
      // Segregation of duties: the submitter cannot approve their own report. The
      // server enforces this too (403); we skip those rows to avoid a dead-end.
      const own = targets.filter(isMine);
      const list = targets.filter((r) => !isMine(r));
      if (list.length === 0) {
        if (own.length > 0) addToast('error', 'You submitted these reports — a different approver must review them.');
        return;
      }
      const ids = list.map((r) => r.id);
      setBusy(ids, true);
      let ok = 0;
      let firstError: string | null = null;
      for (const r of list) {
        const res = await api.post(`/api/expenses/${r.id}/approve`, {});
        if (res.error) firstError = firstError ?? res.error.error;
        else ok++;
      }
      setBusy(ids, false);
      const failed = list.length - ok;
      if (list.length === 1) {
        if (failed) addToast('error', firstError ?? 'Failed to approve');
        else addToast('success', 'Report approved');
      } else if (failed) {
        addToast(ok > 0 ? 'success' : 'error', `Approved ${ok}, ${failed} failed${firstError ? ` — ${firstError}` : ''}`);
      } else {
        addToast('success', `Approved ${ok} reports`);
      }
      if (own.length > 0) addToast('error', `Skipped ${plural(own.length, 'report')} you submitted (segregation of duties).`);
      setQueueSel(new Set());
      bump();
    },
    [isMine, bump],
  );

  const rejectMany = useCallback(
    async (targets: ReportRow[], reason: string) => {
      const ids = targets.map((r) => r.id);
      setBusy(ids, true);
      let ok = 0;
      let firstError: string | null = null;
      for (const r of targets) {
        const res = await api.post(`/api/expenses/${r.id}/reject`, { reason });
        if (res.error) firstError = firstError ?? res.error.error;
        else ok++;
      }
      setBusy(ids, false);
      const failed = targets.length - ok;
      if (targets.length === 1) {
        if (failed) addToast('error', firstError ?? 'Failed to reject');
        else addToast('success', 'Report rejected');
      } else if (failed) {
        addToast(ok > 0 ? 'success' : 'error', `Rejected ${ok}, ${failed} failed${firstError ? ` — ${firstError}` : ''}`);
      } else {
        addToast('success', `Rejected ${ok} reports`);
      }
      setQueueSel(new Set());
      bump();
    },
    [bump],
  );

  // ── Columns ───────────────────────────────────────────────────────────────
  const mineColumns = useMemo<QueueColumn<ReportRow>[]>(
    () => [
      {
        id: 'report',
        header: 'Report',
        cell: (r) => (
          <>
            <span className="l1">{r.title ?? 'Expense report'}</span>
            <span className="l2">
              {new Date(r.created_at).toLocaleDateString()} · Out-of-pocket {formatMoney(r.reimbursable_cents)}
              {r.card_cents > 0 ? ` · Card ${formatMoney(r.card_cents)}` : ''}
            </span>
          </>
        ),
      },
      {
        id: 'flags',
        header: 'Policy',
        width: 140,
        cell: (r) =>
          r.policy_flag_count > 0 ? (
            <Tag tone="warn" title="Lines flagged by the expense policy">{plural(r.policy_flag_count, 'flag')}</Tag>
          ) : (
            <span className="ink-3">None</span>
          ),
      },
      { id: 'total', header: 'Total', width: 128, numeric: true, cell: (r) => <span className="tnum">{formatMoney(r.total_cents)}</span> },
      { id: 'status', header: 'Status', width: 140, cell: (r) => <StatusBadge status={r.status} /> },
      { id: 'go', header: <span className="sr">Open</span>, width: 48, numeric: true, cell: () => <span className="ink-3" aria-hidden="true"><Icon name="right" /></span> },
    ],
    [],
  );

  const queueColumns = useMemo<QueueColumn<ReportRow>[]>(
    () => [
      {
        id: 'report',
        header: 'Report',
        cell: (r) => (
          <>
            <span className="l1">{r.title ?? 'Expense report'}</span>
            <span className="l2">
              {[r.employee_name, `Out-of-pocket ${formatMoney(r.reimbursable_cents)}`].filter(Boolean).join(' · ')}
            </span>
          </>
        ),
      },
      { id: 'policy', header: 'Policy', width: 176, cell: (r) => <ViolationTags block={r.block_count} warn={r.warn_count} info={r.info_count} /> },
      {
        id: 'waiting',
        header: 'Waiting',
        width: 132,
        cell: (r) => (
          <Status kind={AGING_STATUS[agingTone(r.aging_days ?? null)]}>{agingLabel(r.aging_days ?? null)}</Status>
        ),
      },
      { id: 'total', header: 'Total', width: 120, numeric: true, cell: (r) => <span className="tnum">{formatMoney(r.total_cents)}</span> },
      {
        id: 'acts',
        header: <span className="sr">Actions</span>,
        width: 200,
        numeric: true,
        cell: (r) => {
          const mine = isMine(r);
          const busy = busyIds.has(r.id);
          return (
            <span className={s.rowActs}>
              <Button
                onClick={() => void approveMany([r])}
                disabled={busy || mine}
                title={mine ? SOD_TITLE : 'Approve'}
              >
                {busy ? 'Working…' : 'Approve'}
              </Button>
              <Button variant="quiet" onClick={() => setRejecting([r])} disabled={busy} title="Reject with a reason">
                Reject
              </Button>
            </span>
          );
        },
      },
    ],
    [busyIds, isMine, approveMany],
  );

  const filtered = !!q || (scope === 'queue' && policyFilter !== 'all');
  const loadingFirst = isLoading && !data;

  const figures: ReadonlyArray<{ label: string; key: ReportStatus; caption: string; to: Scope; link: string }> = [
    { label: 'Draft', key: 'DRAFT', caption: 'not yet submitted', to: 'mine', link: 'My reports' },
    { label: 'Awaiting approval', key: 'SUBMITTED', caption: 'submitted, not reviewed', to: 'queue', link: 'Review queue' },
    { label: 'Ready to reimburse', key: 'APPROVED', caption: 'approved, not yet paid out', to: 'batch', link: 'Open batch' },
    { label: 'Reimbursed', key: 'REIMBURSED', caption: 'posted to Accounts Payable', to: 'mine', link: 'My reports' },
  ];

  return (
    <div className={s.stack}>
      {/* Figure strip — stable across tabs (server returns org-wide status counts). */}
      <div className={s.figs}>
        {figures.map((f) => (
          <div key={f.key} className="fig">
            <span className="fig-l">{f.label}</span>
            {loadingFirst ? (
              <span className={cx('mb-skel', s.figSkel)} aria-hidden="true" />
            ) : (
              <span className="fig-v fig-v--dense tnum">{counts[f.key] ?? 0}</span>
            )}
            <span className="fig-vs"><span>{f.caption}</span></span>
            <button type="button" className={s.figLink} onClick={() => changeScope(f.to)} aria-pressed={scope === f.to}>
              {f.link}
            </button>
          </div>
        ))}
      </div>

      <Tabs<Scope>
        aria-label="Expense reports"
        value={scope}
        onChange={changeScope}
        items={TABS.map((t) => ({
          value: t.key,
          label: t.label,
          count:
            t.key === 'queue' ? (counts.SUBMITTED ? counts.SUBMITTED : undefined)
              : t.key === 'batch' ? (counts.APPROVED ? counts.APPROVED : undefined)
                : undefined,
        }))}
      />

      {/* Toolbar: filter · search · verbs */}
      <div className={s.toolbar}>
        {scope === 'queue' && (
          <Seg<PolicyFilter>
            aria-label="Policy result"
            value={policyFilter}
            onChange={setPolicyFilter}
            items={[
              { value: 'all', label: 'All', count: rows.length },
              { value: 'block', label: 'Blocking', count: policyCounts.block },
              { value: 'warn', label: 'Warnings', count: policyCounts.warn },
              { value: 'clean', label: 'Clean', count: policyCounts.clean },
            ]}
          />
        )}
        <Search
          aria-label="Search reports by title or employee"
          className={s.searchBox}
          placeholder="Search title or employee"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          slashToFocus
        />
        <div className={s.grow} />
        <ButtonLink href="/expenses/policy" variant="quiet">Expense policy</ButtonLink>
        <Button variant="primary" icon="plus" onClick={() => setShowCreate(true)}>
          New report
        </Button>
      </div>

      {/* Body */}
      {loadingFirst ? (
        <TableSkeleton rows={6} cols={5} />
      ) : error ? (
        <div className={s.state} role="alert">
          <Tag tone="neg">Not loaded</Tag>
          <p className="t-head">Couldn&apos;t load expense reports.</p>
          <p className="ink-2">{error}</p>
          <Button onClick={() => void refetch()}>Try again</Button>
        </div>
      ) : filtered && rows.length > 0 && visible.length === 0 ? (
        <EmptyState
          title="No reports match"
          description="Try another policy filter or clear the search."
          action={{ label: 'Clear filters', onClick: () => { setSearch(''); setPolicyFilter('all'); } }}
        />
      ) : scope === 'batch' ? (
        <BatchView rows={visible} onOpen={setSelectedId} onChanged={bump} hotkeys={!selectedId && !showCreate} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={scope === 'queue' ? 'Nothing awaiting your approval' : 'No expense reports yet'}
          description={scope === 'queue'
            ? 'Submitted reports from your team appear here for review, with their policy results and approve / reject.'
            : 'Create a report from captured receipts, add out-of-pocket or card expenses, then submit it for approval.'}
          action={scope === 'mine' ? { label: 'New report', onClick: () => setShowCreate(true) } : undefined}
        />
      ) : scope === 'queue' ? (
        <div>
          <div className={s.tableWrap}>
            <QueueTable<ReportRow>
              aria-label="Expense reports awaiting approval"
              columns={queueColumns}
              rows={visible}
              getRowId={(r) => r.id}
              rowState={(r) => ({ attn: (r.block_count ?? 0) > 0 })}
              selectable
              selected={queueSel}
              onSelectedChange={setQueueSel}
              cursorId={cursor}
              onCursorChange={(id) => setCursor(id)}
              onOpen={(r) => setSelectedId(r.id)}
              openOnClick
              hotkeys={!selectedId && !showCreate && !rejecting}
              actions={[
                { key: 'a', label: 'Approve', run: (rs) => void approveMany(rs) },
                { key: 'r', label: 'Reject', run: (rs) => setRejecting(rs) },
              ]}
              bulkSummary={(rs) => [<span key="t" className="tnum">{formatMoney(rs.reduce((n, r) => n + r.total_cents, 0))}</span>]}
              bulkActions={(rs) => (
                <>
                  <Button variant="primary" onClick={() => void approveMany(rs)} disabled={rs.some((r) => busyIds.has(r.id))}>
                    Approve {rs.length}
                  </Button>
                  <Button onClick={() => setRejecting(rs)}>Reject {rs.length}</Button>
                </>
              )}
            />
          </div>
          <Keybar
            className={s.keybar}
            hints={[
              { chord: 'j k', label: 'Move' },
              { chord: 'x', label: 'Select' },
              { chord: 'a', label: 'Approve' },
              { chord: 'r', label: 'Reject' },
              { chord: 'enter', label: 'Open' },
            ]}
            note="You can’t approve a report you submitted."
          />
        </div>
      ) : (
        <div>
          <div className={s.tableWrap}>
            <QueueTable<ReportRow>
              aria-label="My expense reports"
              columns={mineColumns}
              rows={visible}
              getRowId={(r) => r.id}
              rowState={(r) => ({ attn: r.status === 'REJECTED' })}
              cursorId={cursor}
              onCursorChange={(id) => setCursor(id)}
              onOpen={(r) => setSelectedId(r.id)}
              openOnClick
              hotkeys={!selectedId && !showCreate}
            />
          </div>
          <Keybar
            className={s.keybar}
            hints={[
              { chord: 'j k', label: 'Move' },
              { chord: 'enter', label: 'Open report' },
              { chord: '/', label: 'Search' },
            ]}
          />
        </div>
      )}

      <ConfirmDialog
        open={!!rejecting}
        onClose={() => setRejecting(null)}
        title={rejecting && rejecting.length > 1 ? `Reject ${rejecting.length} reports` : 'Reject this report'}
        confirmLabel={rejecting && rejecting.length > 1 ? `Reject ${rejecting.length}` : 'Reject report'}
        tone="danger"
        reason={{ label: 'Reason for rejecting', help: 'The submitter sees this reason and can fix and resubmit.', placeholder: 'e.g. Missing receipt for the hotel line' }}
        onConfirm={async (reason) => {
          const targets = rejecting ?? [];
          if (!reason || targets.length === 0) return;
          await rejectMany(targets, reason);
        }}
      >
        {rejecting && rejecting.length === 1
          ? `${rejecting[0]?.title ?? 'Expense report'}${rejecting[0]?.employee_name ? ` · ${rejecting[0].employee_name}` : ''} · ${formatMoney(rejecting[0]?.total_cents ?? 0)}`
          : rejecting
            ? `${rejecting.length} reports · ${formatMoney(rejecting.reduce((n, r) => n + r.total_cents, 0))}`
            : null}
      </ConfirmDialog>

      {selectedId && (
        <ReportDrawer
          reportId={selectedId}
          scope={scope}
          onClose={() => setSelectedId(null)}
          onChanged={bump}
        />
      )}
      {showCreate && (
        <CreateReportModal
          onClose={() => setShowCreate(false)}
          onCreated={(id) => { setShowCreate(false); bump(); setSelectedId(id); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row parts
// ---------------------------------------------------------------------------

function ViolationTags({ block, warn, info }: { block?: number; warn?: number; info?: number }) {
  const b = block ?? 0, w = warn ?? 0, i = info ?? 0;
  if (b + w + i === 0) return <span className="ink-3">Clean</span>;
  return (
    <span className={s.tags}>
      {b > 0 && <Tag tone="neg" title="Blocking violations">{b} blocking</Tag>}
      {w > 0 && <Tag tone="warn" title="Warnings">{plural(w, 'warning')}</Tag>}
      {b === 0 && w === 0 && i > 0 && <Tag title="Informational">{plural(i, 'note')}</Tag>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Reimbursement batch
// ---------------------------------------------------------------------------

interface BatchResult { id: string; ok: boolean; error?: string; reimbursed_cents?: number }
interface BatchResponse { results: BatchResult[]; totalReimbursedCents: number; successCount: number; failCount: number }

function BatchView({ rows, onOpen, onChanged, hotkeys }: { rows: ReportRow[]; onOpen: (id: string) => void; onChanged: () => void; hotkeys: boolean }) {
  const me = useMe();
  // Only reports with an out-of-pocket balance actually produce a payout JE.
  const payable = useMemo(() => rows.filter((r) => r.reimbursable_cents > 0), [rows]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const batch = useMutation<{ report_ids: string[] }, BatchResponse>('/api/expenses/batch');

  const canPost = me.can('payments', 'run');

  const selectedTotal = useMemo(
    () => payable.filter((r) => selected.has(r.id)).reduce((sum, r) => sum + r.reimbursable_cents, 0),
    [payable, selected],
  );
  const payableTotal = useMemo(() => payable.reduce((sum, r) => sum + r.reimbursable_cents, 0), [payable]);

  async function run() {
    const ids = Array.from(selected);
    const res = await batch.mutate({ report_ids: ids });
    setConfirming(false);
    if (!res) { addToast('error', batch.error ?? 'Batch reimbursement failed'); return; }
    if (res.failCount > 0) {
      addToast(res.successCount > 0 ? 'success' : 'error',
        `${res.successCount} reimbursed, ${res.failCount} failed — ${formatMoney(res.totalReimbursedCents)} to AP`);
    } else {
      addToast('success', `${res.successCount} report(s) reimbursed — ${formatMoney(res.totalReimbursedCents)} posted to AP`);
    }
    setSelected(new Set());
    onChanged();
  }

  const columns = useMemo<QueueColumn<ReportRow>[]>(
    () => [
      {
        id: 'report',
        header: 'Report',
        cell: (r) => (
          <>
            <span className="l1">{r.title ?? 'Expense report'}</span>
            <span className="l2">
              {[r.employee_name, `approved ${agingLabel(r.aging_days ?? null)} ago`, r.card_cents > 0 ? `Card ${formatMoney(r.card_cents)} (not reimbursed)` : null]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </>
        ),
      },
      { id: 'policy', header: 'Policy', width: 176, cell: (r) => <ViolationTags block={r.block_count} warn={r.warn_count} info={r.info_count} /> },
      { id: 'oop', header: 'Out-of-pocket', width: 144, numeric: true, cell: (r) => <span className="tnum">{formatMoney(r.reimbursable_cents)}</span> },
    ],
    [],
  );

  if (payable.length === 0) {
    return (
      <EmptyState
        title="Nothing to reimburse"
        description="Approved reports with an out-of-pocket balance appear here, grouped for a single payout run. Corporate-card lines are settled through the card feed and never reimbursed."
      />
    );
  }

  return (
    <div className={s.stack}>
      <div className={s.batchBar}>
        <span>
          <b className="tnum">{plural(payable.length, 'report')}</b> ready <span className="ink-3">·</span>{' '}
          <span className="tnum">{formatMoney(payableTotal)}</span> out-of-pocket
        </span>
        <span className="t-cap">Select reports (X, or the box in the header for all), then reimburse them in one run.</span>
      </div>
      {!canPost && (
        <InlineNotice tone="warn" title="You can review this batch but not post it.">
          Posting reimbursements needs the payments permission.
        </InlineNotice>
      )}

      <div>
        <div className={s.tableWrap}>
          <QueueTable<ReportRow>
            aria-label="Approved reports ready to reimburse"
            columns={columns}
            rows={payable}
            getRowId={(r) => r.id}
            selectable
            selected={selected}
            onSelectedChange={setSelected}
            cursorId={cursor}
            onCursorChange={(id) => setCursor(id)}
            onOpen={(r) => onOpen(r.id)}
            openOnClick
            hotkeys={hotkeys && !confirming}
            bulkSummary={() => [<span key="t" className="tnum">{formatMoney(selectedTotal)}</span>]}
            bulkActions={() => (
              <Button
                variant="primary"
                onClick={() => setConfirming(true)}
                disabled={selected.size === 0 || batch.isLoading || !canPost}
                title={!canPost ? 'You do not have permission to post reimbursements' : undefined}
              >
                {batch.isLoading ? 'Posting…' : `Reimburse ${selected.size} · ${formatMoney(selectedTotal)}`}
              </Button>
            )}
          />
        </div>
        <Keybar
          className={s.keybar}
          hints={[
            { chord: 'j k', label: 'Move' },
            { chord: 'x', label: 'Select' },
            { chord: 'enter', label: 'Open report' },
          ]}
          note="Posts DR expense / CR Accounts Payable for out-of-pocket lines only."
        />
      </div>

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Post reimbursement batch"
        confirmLabel="Post reimbursements"
        onConfirm={run}
      >
        Post <b className="tnum">{formatMoney(selectedTotal)}</b> across{' '}
        <b className="tnum">{selected.size}</b> report{selected.size === 1 ? '' : 's'} to the general ledger
        (DR expense / CR Accounts Payable). Each report settles through the normal AP payment path. This posts to the
        ledger and can&apos;t be undone here.
      </ConfirmDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------

function ReportDrawer({ reportId, scope, onClose, onChanged }: {
  reportId: string; scope: Scope; onClose: () => void; onChanged: () => void;
}) {
  const me = useMe();
  const [refreshKey, setRefreshKey] = useState(0);
  const { data, isLoading, error, refetch } = useQuery<DetailResponse>(
    `/api/expenses/${reportId}`, undefined, { key: `${reportId}:${refreshKey}` },
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);

  const submit = useMutation(`/api/expenses/${reportId}/submit`);
  const approve = useMutation(`/api/expenses/${reportId}/approve`);
  const reimburse = useMutation(`/api/expenses/${reportId}/reimburse`);
  const reject = useMutation(`/api/expenses/${reportId}/reject`);

  const reload = useCallback(() => { setRefreshKey((k) => k + 1); refetch(); onChanged(); }, [refetch, onChanged]);

  async function act(kind: string, fn: () => Promise<unknown | null>, err: ReturnType<typeof useMutation>['error']) {
    setBusy(kind);
    const res = await fn();
    setBusy(null);
    if (res === null) { addToast('error', err ?? 'Action failed'); return; }
    addToast('success', `${kind} complete`);
    reload();
    if (kind === 'Reimburse' || kind === 'Approve' || kind === 'Reject' || kind === 'Submit') {
      // status changed — a queue/batch item may leave the list; close if it left this scope
      if (scope === 'queue' || scope === 'batch') onClose();
    }
  }

  const report = data?.report;
  const lines = data?.lines ?? [];
  const policy = data?.policy ?? null;
  const editable = report?.status === 'DRAFT' || report?.status === 'REJECTED';

  // SoD: an approver who is the submitter cannot approve their own report.
  const iSubmitted = !!me.user?.clerkId && !!report?.submitted_by && report.submitted_by === me.user.clerkId;

  const violationInput: LineViolationsInput[] = lines.map((l) => ({
    lineNumber: l.line_number,
    merchant: l.merchant,
    description: l.description,
    amountCents: l.amount_cents,
    reasons: l.policy_reasons ?? [],
  }));
  const summary = summarizeViolations(violationInput);

  return (
    <DetailDrawer
      open
      onClose={onClose}
      width="lg"
      title={report?.title ?? 'Expense report'}
      subtitle={report ? `${report.employee_name ?? 'Employee'} · ${lines.length} line${lines.length === 1 ? '' : 's'}` : null}
      isLoading={isLoading && !data}
      error={error}
      headerRight={report ? <StatusBadge status={report.status} /> : undefined}
    >
      {report && (
        <div className={s.drawerStack}>
          {/* Totals */}
          <div className={s.tiles}>
            <SummaryTile label="Total" value={formatMoney(report.total_cents)} />
            <SummaryTile label="Out-of-pocket" value={formatMoney(report.reimbursable_cents)} />
            <SummaryTile label="On card" value={formatMoney(report.card_cents)} />
          </div>

          {/* Policy-violation summary — which lines tripped which rule, WARN vs BLOCK */}
          <PolicyViolationSummary summary={summary} policy={policy} />

          {/* Lines */}
          <section className="panel-sec">
            <div className="panel-sec-h">
              <h3>Lines</h3>
              <span className="t-cap tnum">{lines.length}</span>
            </div>
            {lines.length === 0 ? (
              <p className="ink-3">No lines yet.{editable ? ' Add the first one below.' : ''}</p>
            ) : (
              <ul className={s.lines}>
                {lines.map((l) => (
                  <li key={l.id}>
                    <LineCard line={l} editable={!!editable} onChanged={reload} />
                  </li>
                ))}
              </ul>
            )}
            {editable && <AddLineForm reportId={reportId} onAdded={reload} defaultLocationId={report.location_id} />}
          </section>

          <DetailSection title="Details">
            <DetailField label="Status" value={<StatusBadge status={report.status} />} />
            {report.employee_name && <DetailField label="Submitted for" value={report.employee_name} />}
            {report.submitted_at && <DetailField label="Submitted" value={new Date(report.submitted_at).toLocaleString()} />}
            {report.approved_at && <DetailField label="Approved" value={new Date(report.approved_at).toLocaleString()} />}
            <DetailField label="Created" value={new Date(report.created_at).toLocaleString()} />
          </DetailSection>

          {/* Actions */}
          <ButtonRow>
            {editable && (
              <Button
                variant="primary"
                icon="check"
                disabled={busy !== null || lines.length === 0}
                title={lines.length === 0 ? 'Add at least one line first' : undefined}
                onClick={() => act('Submit', () => submit.mutate({}), submit.error)}
              >
                {busy === 'Submit' ? 'Submitting…' : 'Submit for approval'}
              </Button>
            )}
            {report.status === 'SUBMITTED' && (
              <>
                <Button
                  variant="primary"
                  icon="check"
                  disabled={busy !== null || iSubmitted}
                  title={iSubmitted ? SOD_TITLE : undefined}
                  onClick={() => act('Approve', () => approve.mutate({}), approve.error)}
                >
                  {busy === 'Approve' ? 'Approving…' : 'Approve'}
                </Button>
                <Button variant="danger" disabled={busy !== null} onClick={() => setRejectOpen(true)}>
                  {busy === 'Reject' ? 'Rejecting…' : 'Reject'}
                </Button>
              </>
            )}
            {report.status === 'APPROVED' && (
              <Button
                variant="primary"
                disabled={busy !== null}
                onClick={() => act('Reimburse', () => reimburse.mutate({}), reimburse.error)}
              >
                {busy === 'Reimburse' ? 'Posting…' : 'Post reimbursement'}
              </Button>
            )}
          </ButtonRow>
          {iSubmitted && report.status === 'SUBMITTED' && (
            <InlineNotice tone="warn" title="You submitted this report.">
              Segregation of duties requires a different approver.
            </InlineNotice>
          )}
          {report.status === 'APPROVED' && (
            <p className="t-cap">
              Posts DR expense / CR Accounts Payable for out-of-pocket lines only. Corporate-card lines are booked through the card feed and are not reimbursed here.
            </p>
          )}

          <ConfirmDialog
            open={rejectOpen}
            onClose={() => setRejectOpen(false)}
            title="Reject this report"
            confirmLabel="Reject report"
            tone="danger"
            reason={{ label: 'Reason for rejecting', help: 'The submitter sees this reason and can fix and resubmit.' }}
            onConfirm={async (reason) => {
              if (!reason) return;
              await act('Reject', () => reject.mutate({ reason }), reject.error);
            }}
          >
            {`${report.title ?? 'Expense report'} · ${formatMoney(report.total_cents)}`}
          </ConfirmDialog>
        </div>
      )}
    </DetailDrawer>
  );
}

function PolicyViolationSummary({
  summary, policy,
}: {
  summary: ReturnType<typeof summarizeViolations>;
  policy: DetailResponse['policy'];
}) {
  const hasViolations = summary.groups.length > 0;
  const tier = policy?.requiredApprovalTier ?? null;

  if (!hasViolations && !tier && !policy?.active) return null;

  return (
    <section className={s.policy} aria-label="Policy check">
      <div className={s.policyHead}>
        <Eyebrow as="span">Policy check</Eyebrow>
        <span className={s.tags}>
          {summary.blockCount > 0 && <Tag tone="neg">{summary.blockCount} blocking</Tag>}
          {summary.warnCount > 0 && <Tag tone="warn">{plural(summary.warnCount, 'warning')}</Tag>}
          {summary.blockCount === 0 && summary.warnCount === 0 && <Status kind="ready">Clean</Status>}
        </span>
      </div>

      <div className={s.policyBody}>
        {(policy?.active || tier) && (
          <p className={cx('t-cap', s.cellRow)}>
            {policy?.active && <span>Policy: <b>{policy.active.name} v{policy.active.version}</b></span>}
            {tier && <Tag tone="ai">Needs {tier} approval</Tag>}
          </p>
        )}

        {hasViolations ? (
          summary.groups.map((g) => (
            <div key={g.code} className={s.violation}>
              <span><Tag tone={SEVERITY_TONE[g.severity] ?? 'warn'}>{SEVERITY_WORD[g.severity] ?? 'Warn'}</Tag></span>
              <div style={{ minWidth: 0 }}>
                <p>{g.message}</p>
                <p className="t-cap">
                  {g.count > 1 ? `${g.count} lines` : 'Line'} {g.lineNumbers.map((n) => `#${n}`).join(', ')}
                </p>
              </div>
            </div>
          ))
        ) : (
          <p className="t-cap">No policy violations on this report.</p>
        )}
      </div>
    </section>
  );
}

function SummaryTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="fig">
      <span className="fig-l">{label}</span>
      <span className="fig-v fig-v--dense tnum">{value}</span>
    </div>
  );
}

function LineCard({ line, editable, onChanged }: { line: LineRow; editable: boolean; onChanged: () => void }) {
  const [showCardPicker, setShowCardPicker] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const del = useMutation(`/api/expenses/lines/${line.id}`, 'delete');

  async function remove() {
    const res = await del.mutate(undefined as never);
    if (res === null) addToast('error', del.error ?? 'Failed to delete line');
    else { addToast('success', 'Line removed'); onChanged(); }
  }

  const name = line.merchant ?? line.description ?? 'Expense';

  return (
    <div>
      <div className={s.line}>
        <div style={{ minWidth: 0 }}>
          <div className={s.lineHead}>
            <span className="t-cap tnum">#{line.line_number}</span>
            <span className="l1">{name}</span>
            {line.payment_source === 'CORPORATE_CARD' ? <Tag tone="ai">Card</Tag> : <Tag>Out-of-pocket</Tag>}
            {!line.has_receipt && <Tag tone="warn">No receipt</Tag>}
          </div>
          <p className="t-cap">
            <span className="tnum">{line.expense_date}</span> · {line.account ? `${line.account.account_number} ${line.account.name}` : 'Uncoded'}
            {line.billable ? ' · billable' : ''}
          </p>
          {line.policy_reasons?.length > 0 && (
            <div className={s.reasons}>
              {line.policy_reasons.map((f, i) => (
                <Tag key={i} tone={SEVERITY_TONE[f.severity] ?? 'warn'} title={SEVERITY_WORD[f.severity]}>
                  {SEVERITY_WORD[f.severity] ?? 'Warn'}: {f.message}
                </Tag>
              ))}
            </div>
          )}
        </div>
        <div className={s.lineRight}>
          <span className="tnum b">{formatMoney(line.amount_cents)}</span>
          {editable && (
            <span className={s.rowActs}>
              {line.payment_source === 'OUT_OF_POCKET' && (
                <Button variant="quiet" onClick={() => setShowCardPicker((v) => !v)} aria-expanded={showCardPicker}>
                  On card?
                </Button>
              )}
              <Button variant="quiet" iconOnly icon="x" aria-label={`Remove line ${line.line_number}`} onClick={() => setConfirmRemove(true)} disabled={del.isLoading} />
            </span>
          )}
        </div>
      </div>
      {showCardPicker && <CardMatchPicker lineId={line.id} onMatched={() => { setShowCardPicker(false); onChanged(); }} />}
      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title="Remove this line"
        confirmLabel="Remove line"
        tone="danger"
        onConfirm={remove}
      >
        {`#${line.line_number} ${name} · ${formatMoney(line.amount_cents)} comes off this report.`}
      </ConfirmDialog>
    </div>
  );
}

interface CardTxn { id: string; description: string; amount_cents: number; transaction_date: string }
function CardMatchPicker({ lineId, onMatched }: { lineId: string; onMatched: () => void }) {
  const { data, isLoading, error, refetch } = useQuery<{ data: CardTxn[] }>('/api/credit-cards', { per_page: '25' });
  const match = useMutation(`/api/expenses/lines/${lineId}/match-card`);

  async function pick(txnId: string) {
    const res = await match.mutate({ bank_transaction_id: txnId });
    if (res === null) addToast('error', match.error ?? 'Failed to match');
    else { addToast('success', 'Matched to card charge'); onMatched(); }
  }

  const txns = data?.data ?? [];

  return (
    <div className={s.picker}>
      <p className="t-cap">Match to a corporate-card charge:</p>
      {isLoading && !data ? (
        <p className="t-cap" role="status">Loading corporate-card charges…</p>
      ) : error ? (
        <p className="t-cap" role="alert">
          Couldn&apos;t load card charges. <button type="button" className="link" onClick={() => void refetch()}>Try again</button>
        </p>
      ) : txns.length === 0 ? (
        <p className="t-cap">Nothing on the corporate-card feed yet. Import it, then match this line.</p>
      ) : (
        <ul className={s.pickList}>
          {txns.map((t) => (
            <li key={t.id}>
              <button type="button" onClick={() => pick(t.id)} disabled={match.isLoading} className={s.pickBtn}>
                <span className="mb-trunc"><span className="tnum">{t.transaction_date}</span> · {t.description}</span>
                <span className="tnum">{formatMoney(Math.abs(t.amount_cents))}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AddLineForm({ reportId, onAdded, defaultLocationId }: { reportId: string; onAdded: () => void; defaultLocationId: string | null }) {
  const [open, setOpen] = useState(false);
  const [merchant, setMerchant] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState('');
  const [source, setSource] = useState<'OUT_OF_POCKET' | 'CORPORATE_CARD'>('OUT_OF_POCKET');
  const add = useMutation(`/api/expenses/${reportId}/lines`);

  async function save() {
    const cents = Math.round(parseFloat(amount || '0') * 100);
    if (!Number.isFinite(cents) || cents < 0) { addToast('error', 'Enter a valid amount'); return; }
    const res = await add.mutate({
      expense_date: date,
      merchant: merchant || null,
      amount_cents: cents,
      payment_source: source,
      location_id: defaultLocationId ?? undefined,
    });
    if (res === null) { addToast('error', add.error ?? 'Failed to add line'); return; }
    setMerchant(''); setAmount(''); setOpen(false);
    addToast('success', 'Line added');
    onAdded();
  }

  if (!open) {
    return (
      <div className={s.addLine}>
        <Button icon="plus" onClick={() => setOpen(true)}>Add a line</Button>
      </div>
    );
  }
  return (
    <div className={s.addForm}>
      <div className={s.two}>
        <Field label="Merchant">
          <Input value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="e.g. Delta Air Lines" data-autofocus />
        </Field>
        <Field label="Expense date">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Amount ($)">
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="42.50" inputMode="decimal" className="tnum" />
        </Field>
        <Field label="Paid with">
          <Select value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
            <option value="OUT_OF_POCKET">Out-of-pocket</option>
            <option value="CORPORATE_CARD">Corporate card</option>
          </Select>
        </Field>
      </div>
      <div className={s.formFoot}>
        <Button variant="quiet" onClick={() => setOpen(false)}>Cancel</Button>
        <Button onClick={save} disabled={add.isLoading}>
          {add.isLoading ? 'Adding…' : 'Add line'}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create-from-receipts dialog
// ---------------------------------------------------------------------------

interface ReceiptPick { id: string; vendor_name: string | null; amount_cents: number | null; receipt_date: string | null; account: { account_number: string; name: string } | null }
function CreateReportModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { data, isLoading, error, refetch } = useQuery<{ data: ReceiptPick[] }>('/api/receipts', { status: 'all', per_page: '50' });
  const create = useMutation<{ title: string; receipt_ids: string[] }, { report_id: string }>('/api/expenses');

  function toggle(id: string) {
    setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  async function submit() {
    const res = await create.mutate({ title: title || 'Expense report', receipt_ids: Array.from(selected) });
    if (!res) { addToast('error', create.error ?? 'Failed to create report'); return; }
    addToast('success', 'Report created');
    onCreated(res.report_id);
  }

  const receipts = data?.data ?? [];
  const selectedTotal = receipts.filter((r) => selected.has(r.id)).reduce((n, r) => n + Math.abs(r.amount_cents ?? 0), 0);

  return (
    <Dialog
      open
      onClose={onClose}
      title="New expense report"
      width={600}
      footNote={selected.size > 0 ? `${plural(selected.size, 'receipt')} · ${formatMoney(selectedTotal)}` : 'No receipts picked — you can add lines by hand.'}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="plus" onClick={submit} disabled={create.isLoading}>
            {create.isLoading ? 'Creating…' : 'Create report'}
          </Button>
        </>
      }
    >
      <div className={s.dialogStack}>
        <Field label="Report title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. August client travel" data-autofocus />
        </Field>
        <div>
          <Eyebrow>{['Build from captured receipts', ...(selected.size > 0 ? [`${selected.size} selected`] : [])]}</Eyebrow>
          {isLoading && !data ? (
            <p className="t-cap" role="status" style={{ marginTop: 8 }}>Loading receipts…</p>
          ) : error ? (
            <div style={{ marginTop: 8 }}>
              <InlineNotice tone="neg" title="Couldn’t load receipts.">
                {error}{' '}
                <button type="button" className="link" onClick={() => void refetch()}>Try again</button>
              </InlineNotice>
            </div>
          ) : receipts.length === 0 ? (
            <p className="t-cap" style={{ marginTop: 8 }}>No captured receipts. Create an empty report and add lines by hand.</p>
          ) : (
            <ul className={s.receipts}>
              {receipts.map((r) => (
                <li key={r.id}>
                  <Check
                    checked={selected.has(r.id)}
                    onChange={() => toggle(r.id)}
                    aria-label={`Include ${r.vendor_name ?? 'receipt'}`}
                  />
                  <span className="mb-trunc">
                    {r.vendor_name ?? 'Receipt'}
                    {r.receipt_date && <span className="t-cap"> · {r.receipt_date}</span>}
                  </span>
                  <span className="t-cap">{r.account ? r.account.account_number : 'Uncoded'}</span>
                  <span className="tnum">{formatMoney(Math.abs(r.amount_cents ?? 0))}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Dialog>
  );
}
