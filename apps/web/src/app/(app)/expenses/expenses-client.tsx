'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import {
  Plus, Receipt, CreditCard, AlertTriangle, Check, X, Send, Wallet,
  Loader2, Inbox, FileText, ChevronRight, Trash2, ShieldCheck, ShieldAlert,
  Clock, UserRound, ListChecks, Gavel,
} from 'lucide-react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { useQuery, useMutation, addToast } from '@/hooks';
import { useMe } from '@/lib/hooks/use-me';
import { StatusBadge, EmptyState, TableSkeleton, MetricCard } from '@/components/ui';
import { DetailDrawer, DetailSection, DetailField } from '@/components/detail-drawer';
import {
  summarizeViolations, agingLabel, agingTone,
  type LineViolationsInput, type AgingTone,
} from '@/lib/expenses/queue-summary';

type Scope = 'mine' | 'queue' | 'batch';
type Status = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REIMBURSED' | 'REJECTED';

interface ReportRow {
  id: string;
  title: string | null;
  status: Status;
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

const TABS: { key: Scope; label: string; icon: typeof Receipt }[] = [
  { key: 'mine', label: 'My Reports', icon: FileText },
  { key: 'queue', label: 'Approver Queue', icon: Inbox },
  { key: 'batch', label: 'Reimbursement Batch', icon: Wallet },
];

const AGING_TONE_CLASS: Record<AgingTone, string> = {
  fresh: 'text-slate-400',
  aging: 'text-amber-400',
  stale: 'text-red-400',
};

export function ExpensesClient() {
  const [scope, setScope] = useState<Scope>('mine');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const { data, isLoading, error, refetch } = useQuery<ListResponse>(
    '/api/expenses',
    { scope },
    { key: `${scope}:${refreshKey}` },
  );

  const bump = useCallback(() => {
    setRefreshKey((k) => k + 1);
    refetch();
  }, [refetch]);

  const counts = data?.counts ?? {};
  const rows = data?.data ?? [];

  return (
    <div className="space-y-5">
      {/* Metric strip — stable across tabs (server returns org-wide status counts) */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard label="Draft" value={String(counts.DRAFT ?? 0)} icon={FileText} />
        <MetricCard label="Awaiting approval" value={String(counts.SUBMITTED ?? 0)} icon={Inbox} />
        <MetricCard label="Ready to reimburse" value={String(counts.APPROVED ?? 0)} icon={Wallet} />
        <MetricCard label="Reimbursed" value={String(counts.REIMBURSED ?? 0)} icon={Check} />
      </div>

      {/* Tabs + create */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="inline-flex rounded-lg bg-slate-900 border border-slate-800 p-0.5">
          {TABS.map((t) => {
            const Icon = t.icon;
            const badge =
              t.key === 'queue' ? counts.SUBMITTED ?? 0 : t.key === 'batch' ? counts.APPROVED ?? 0 : 0;
            return (
              <button
                key={t.key}
                onClick={() => { setScope(t.key); }}
                className={clsx(
                  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
                  scope === t.key ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200',
                )}
              >
                <Icon size={14} /> {t.label}
                {badge > 0 && (
                  <span className={clsx(
                    'ml-0.5 inline-flex min-w-[18px] items-center justify-center rounded-full px-1 text-2xs font-semibold',
                    scope === t.key ? 'bg-brand-500/20 text-brand-300' : 'bg-slate-700 text-slate-300',
                  )}>
                    {badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <a href="/expenses/policy" className="btn-ghost btn-sm inline-flex items-center gap-1.5">
            <ShieldCheck size={14} /> Policy
          </a>
          <button onClick={() => setShowCreate(true)} className="btn-primary btn-sm inline-flex items-center gap-1.5">
            <Plus size={14} /> New report
          </button>
        </div>
      </div>

      {/* Body */}
      {isLoading ? (
        <TableSkeleton />
      ) : error ? (
        <EmptyState icon={AlertTriangle} title="Couldn’t load expense reports" description={error} />
      ) : scope === 'batch' ? (
        <BatchView rows={rows} onOpen={setSelectedId} onChanged={bump} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={scope === 'queue' ? Inbox : Receipt}
          title={scope === 'queue' ? 'Nothing awaiting your approval' : 'No expense reports yet'}
          description={scope === 'queue'
            ? 'Submitted reports from your team will appear here for review, with policy-violation badges and one-click approve/reject.'
            : 'Create a report from captured receipts, add out-of-pocket or card expenses, then submit for approval.'}
          action={scope === 'mine' ? { label: 'New report', onClick: () => setShowCreate(true) } : undefined}
        />
      ) : scope === 'queue' ? (
        <div className="card divide-y divide-slate-800/70">
          {rows.map((r) => (
            <QueueRow key={r.id} report={r} onOpen={() => setSelectedId(r.id)} onChanged={bump} />
          ))}
        </div>
      ) : (
        <div className="card divide-y divide-slate-800/70">
          {rows.map((r) => (
            <MineRow key={r.id} report={r} onOpen={() => setSelectedId(r.id)} />
          ))}
        </div>
      )}

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
// List rows
// ---------------------------------------------------------------------------

function ViolationBadges({ block, warn, info }: { block?: number; warn?: number; info?: number }) {
  const b = block ?? 0, w = warn ?? 0, i = info ?? 0;
  if (b + w + i === 0) return null;
  return (
    <div className="flex items-center gap-1">
      {b > 0 && (
        <span className="inline-flex items-center gap-1 text-2xs text-red-300 bg-red-500/10 px-1.5 py-0.5 rounded" title="Blocking violations">
          <ShieldAlert size={10} /> {b} block
        </span>
      )}
      {w > 0 && (
        <span className="inline-flex items-center gap-1 text-2xs text-amber-300 bg-amber-500/10 px-1.5 py-0.5 rounded" title="Warnings">
          <AlertTriangle size={10} /> {w} warn
        </span>
      )}
      {b === 0 && w === 0 && i > 0 && (
        <span className="inline-flex items-center gap-1 text-2xs text-blue-300 bg-blue-500/10 px-1.5 py-0.5 rounded" title="Informational">
          {i} note{i === 1 ? '' : 's'}
        </span>
      )}
    </div>
  );
}

function MineRow({ report: r, onOpen }: { report: ReportRow; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="w-full flex items-center gap-4 px-4 py-3 text-left hover:bg-white/[0.02] transition-colors"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-white truncate">{r.title ?? 'Expense report'}</span>
          {r.policy_flag_count > 0 && (
            <span className="inline-flex items-center gap-1 text-2xs text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded">
              <AlertTriangle size={10} /> {r.policy_flag_count}
            </span>
          )}
        </div>
        <p className="text-2xs text-slate-500 mt-0.5">
          {new Date(r.created_at).toLocaleDateString()} · Out-of-pocket {formatMoney(r.reimbursable_cents)}
          {r.card_cents > 0 ? ` · Card ${formatMoney(r.card_cents)}` : ''}
        </p>
      </div>
      <span className="text-sm font-mono tabular-nums text-slate-200">{formatMoney(r.total_cents)}</span>
      <StatusBadge status={r.status} />
      <ChevronRight size={16} className="text-slate-600 shrink-0" />
    </button>
  );
}

function QueueRow({ report: r, onOpen, onChanged }: { report: ReportRow; onOpen: () => void; onChanged: () => void }) {
  const me = useMe();
  const approve = useMutation(`/api/expenses/${r.id}/approve`);
  const reject = useMutation(`/api/expenses/${r.id}/reject`);
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);

  // Segregation of duties: the submitter cannot approve their own report. The
  // server enforces this too (403); we disable the control to avoid a dead-end.
  const iSubmitted = !!me.user?.clerkId && r.submitted_by === me.user.clerkId;
  const tone = agingTone(r.aging_days ?? null);

  async function doApprove(e: React.MouseEvent) {
    e.stopPropagation();
    setBusy('approve');
    const res = await approve.mutate({});
    setBusy(null);
    if (res === null) { addToast('error', approve.error ?? 'Failed to approve'); return; }
    addToast('success', 'Report approved');
    onChanged();
  }
  async function doReject(e: React.MouseEvent) {
    e.stopPropagation();
    const reason = window.prompt('Reason for rejecting this report?');
    if (!reason) return;
    setBusy('reject');
    const res = await reject.mutate({ reason });
    setBusy(null);
    if (res === null) { addToast('error', reject.error ?? 'Failed to reject'); return; }
    addToast('success', 'Report rejected');
    onChanged();
  }

  return (
    <div className="flex items-center gap-4 px-4 py-3 hover:bg-white/[0.02] transition-colors">
      <button onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-white truncate">{r.title ?? 'Expense report'}</span>
          <ViolationBadges block={r.block_count} warn={r.warn_count} info={r.info_count} />
        </div>
        <p className="text-2xs text-slate-500 mt-0.5 flex items-center gap-2 flex-wrap">
          {r.employee_name && (
            <span className="inline-flex items-center gap-1"><UserRound size={10} /> {r.employee_name}</span>
          )}
          <span className={clsx('inline-flex items-center gap-1', AGING_TONE_CLASS[tone])}>
            <Clock size={10} /> waiting {agingLabel(r.aging_days ?? null)}
          </span>
          <span>Out-of-pocket {formatMoney(r.reimbursable_cents)}</span>
        </p>
      </button>
      <span className="text-sm font-mono tabular-nums text-slate-200 shrink-0">{formatMoney(r.total_cents)}</span>
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          onClick={doApprove}
          disabled={busy !== null || iSubmitted}
          title={iSubmitted ? 'You submitted this report — a different approver must review it (segregation of duties)' : 'Approve'}
          className="btn-primary btn-sm inline-flex items-center gap-1 disabled:opacity-40"
        >
          {busy === 'approve' ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Approve
        </button>
        <button
          onClick={doReject}
          disabled={busy !== null}
          title="Reject with a reason"
          className="btn-ghost btn-sm inline-flex items-center gap-1 text-red-400 disabled:opacity-40"
        >
          {busy === 'reject' ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reimbursement batch
// ---------------------------------------------------------------------------

interface BatchResult { id: string; ok: boolean; error?: string; reimbursed_cents?: number }
interface BatchResponse { results: BatchResult[]; totalReimbursedCents: number; successCount: number; failCount: number }

function BatchView({ rows, onOpen, onChanged }: { rows: ReportRow[]; onOpen: (id: string) => void; onChanged: () => void }) {
  const me = useMe();
  // Only reports with an out-of-pocket balance actually produce a payout JE.
  const payable = useMemo(() => rows.filter((r) => r.reimbursable_cents > 0), [rows]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const batch = useMutation<{ report_ids: string[] }, BatchResponse>('/api/expenses/batch');

  const canPost = me.can('payments', 'run');

  const allSelected = payable.length > 0 && payable.every((r) => selected.has(r.id));
  const selectedTotal = useMemo(
    () => payable.filter((r) => selected.has(r.id)).reduce((s, r) => s + r.reimbursable_cents, 0),
    [payable, selected],
  );

  function toggle(id: string) {
    setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(payable.map((r) => r.id)));
  }

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

  if (payable.length === 0) {
    return (
      <EmptyState
        icon={Wallet}
        title="Nothing to reimburse"
        description="Approved reports with an out-of-pocket balance appear here, grouped for a single payout run. Corporate-card lines are settled via the card feed and never reimbursed."
      />
    );
  }

  return (
    <div className="space-y-3">
      {/* Batch action bar */}
      <div className="flex items-center justify-between gap-3 flex-wrap rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-3">
        <label className="inline-flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
          <input type="checkbox" checked={allSelected} onChange={toggleAll} className="accent-brand-500" aria-label="Select all payable reports" />
          <ListChecks size={15} className="text-slate-500" />
          {selected.size > 0 ? `${selected.size} selected · ${formatMoney(selectedTotal)}` : `${payable.length} report${payable.length === 1 ? '' : 's'} ready`}
        </label>
        <button
          onClick={() => setConfirming(true)}
          disabled={selected.size === 0 || batch.isLoading || !canPost}
          title={!canPost ? 'You do not have permission to post reimbursements' : undefined}
          className="btn-primary btn-sm inline-flex items-center gap-1.5 disabled:opacity-40"
        >
          {batch.isLoading ? <Loader2 size={14} className="animate-spin" /> : <Wallet size={14} />}
          Reimburse {selected.size > 0 ? `${selected.size} · ${formatMoney(selectedTotal)}` : 'selected'}
        </button>
      </div>

      <div className="card divide-y divide-slate-800/70">
        {payable.map((r) => (
          <div key={r.id} className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.02] transition-colors">
            <input
              type="checkbox"
              checked={selected.has(r.id)}
              onChange={() => toggle(r.id)}
              className="accent-brand-500"
              aria-label={`Select ${r.title ?? 'report'} for reimbursement`}
            />
            <button onClick={() => onOpen(r.id)} className="min-w-0 flex-1 text-left">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-white truncate">{r.title ?? 'Expense report'}</span>
                <ViolationBadges block={r.block_count} warn={r.warn_count} info={r.info_count} />
              </div>
              <p className="text-2xs text-slate-500 mt-0.5 flex items-center gap-2 flex-wrap">
                {r.employee_name && (
                  <span className="inline-flex items-center gap-1"><UserRound size={10} /> {r.employee_name}</span>
                )}
                <span className="inline-flex items-center gap-1 text-slate-400">
                  <Clock size={10} /> approved {agingLabel(r.aging_days ?? null)} ago
                </span>
                {r.card_cents > 0 && <span>Card {formatMoney(r.card_cents)} (not reimbursed)</span>}
              </p>
            </button>
            <div className="text-right shrink-0">
              <p className="text-2xs text-slate-500">Out-of-pocket</p>
              <span className="text-sm font-mono tabular-nums text-emerald-400">{formatMoney(r.reimbursable_cents)}</span>
            </div>
          </div>
        ))}
      </div>

      {confirming && (
        <ConfirmDialog
          title="Post reimbursement batch"
          body={
            <>
              Post <span className="text-white font-semibold">{formatMoney(selectedTotal)}</span> across{' '}
              <span className="text-white font-semibold">{selected.size}</span> report{selected.size === 1 ? '' : 's'} to the
              general ledger (DR expense / CR Accounts Payable). Each report settles through the normal AP payment path.
              This posts to the ledger and cannot be undone here.
            </>
          }
          confirmLabel="Post reimbursements"
          busy={batch.isLoading}
          onConfirm={run}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

function ConfirmDialog({ title, body, confirmLabel, busy, onConfirm, onCancel }: {
  title: string; body: React.ReactNode; confirmLabel: string; busy: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onCancel(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onCancel} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div role="dialog" aria-modal="true" aria-label={title} className="pointer-events-auto w-full max-w-md rounded-xl bg-slate-900 border border-slate-800 shadow-2xl">
          <div className="px-4 py-3 border-b border-slate-800">
            <h2 className="text-base font-semibold text-white">{title}</h2>
          </div>
          <div className="p-4 text-sm text-slate-300 leading-relaxed">{body}</div>
          <div className="flex justify-end gap-2 px-4 py-3 border-t border-slate-800">
            <button onClick={onCancel} className="btn-ghost btn-sm">Cancel</button>
            <button onClick={onConfirm} disabled={busy} className="btn-primary btn-sm inline-flex items-center gap-1.5 disabled:opacity-50">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Wallet size={14} />} {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------

const SEVERITY_STYLE: Record<string, string> = {
  info: 'text-blue-400 bg-blue-500/10',
  warn: 'text-amber-400 bg-amber-500/10',
  block: 'text-red-400 bg-red-500/10',
};

function ReportDrawer({ reportId, scope, onClose, onChanged }: {
  reportId: string; scope: Scope; onClose: () => void; onChanged: () => void;
}) {
  const me = useMe();
  const [refreshKey, setRefreshKey] = useState(0);
  const { data, isLoading, error, refetch } = useQuery<DetailResponse>(
    `/api/expenses/${reportId}`, undefined, { key: `${reportId}:${refreshKey}` },
  );
  const [busy, setBusy] = useState<string | null>(null);

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
      isLoading={isLoading}
      error={error}
      headerRight={report ? <StatusBadge status={report.status} /> : undefined}
    >
      {report && (
        <div className="space-y-5">
          {/* Totals */}
          <div className="grid grid-cols-3 gap-2">
            <SummaryTile label="Total" value={formatMoney(report.total_cents)} />
            <SummaryTile label="Out-of-pocket" value={formatMoney(report.reimbursable_cents)} accent="emerald" />
            <SummaryTile label="On card" value={formatMoney(report.card_cents)} accent="indigo" />
          </div>

          {/* Policy-violation summary — which lines tripped which rule, WARN vs BLOCK */}
          <PolicyViolationSummary summary={summary} policy={policy} />

          {/* Lines */}
          <DetailSection title="Lines">
            <div className="space-y-2">
              {lines.length === 0 && <p className="text-sm text-slate-500">No lines yet.</p>}
              {lines.map((l) => (
                <LineCard key={l.id} line={l} editable={!!editable} onChanged={reload} />
              ))}
            </div>
            {editable && <AddLineForm reportId={reportId} onAdded={reload} defaultLocationId={report.location_id} />}
          </DetailSection>

          <DetailSection title="Details">
            <DetailField label="Status" value={<StatusBadge status={report.status} />} />
            {report.employee_name && <DetailField label="Submitted for" value={report.employee_name} />}
            {report.submitted_at && <DetailField label="Submitted" value={new Date(report.submitted_at).toLocaleString()} />}
            {report.approved_at && <DetailField label="Approved" value={new Date(report.approved_at).toLocaleString()} />}
            <DetailField label="Created" value={new Date(report.created_at).toLocaleString()} />
          </DetailSection>

          {/* Actions */}
          <div className="flex flex-wrap gap-2 pt-1">
            {editable && (
              <button
                disabled={busy !== null || lines.length === 0}
                onClick={() => act('Submit', () => submit.mutate({}), submit.error)}
                className="btn-primary btn-sm inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                {busy === 'Submit' ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Submit for approval
              </button>
            )}
            {report.status === 'SUBMITTED' && (
              <>
                <button
                  disabled={busy !== null || iSubmitted}
                  title={iSubmitted ? 'You submitted this report — a different approver must review it (segregation of duties)' : undefined}
                  onClick={() => act('Approve', () => approve.mutate({}), approve.error)}
                  className="btn-primary btn-sm inline-flex items-center gap-1.5 disabled:opacity-50"
                >
                  {busy === 'Approve' ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Approve
                </button>
                <button
                  disabled={busy !== null}
                  onClick={() => {
                    const reason = window.prompt('Reason for rejecting this report?');
                    if (!reason) return;
                    act('Reject', () => reject.mutate({ reason }), reject.error);
                  }}
                  className="btn-ghost btn-sm inline-flex items-center gap-1.5 text-red-400 disabled:opacity-50"
                >
                  <X size={14} /> Reject
                </button>
              </>
            )}
            {report.status === 'APPROVED' && (
              <button
                disabled={busy !== null}
                onClick={() => act('Reimburse', () => reimburse.mutate({}), reimburse.error)}
                className="btn-primary btn-sm inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                {busy === 'Reimburse' ? <Loader2 size={14} className="animate-spin" /> : <Wallet size={14} />} Post reimbursement
              </button>
            )}
          </div>
          {iSubmitted && report.status === 'SUBMITTED' && (
            <p className="text-2xs text-amber-400/80 flex items-center gap-1">
              <ShieldAlert size={12} /> You submitted this report — segregation of duties requires a different approver.
            </p>
          )}
          {report.status === 'APPROVED' && (
            <p className="text-2xs text-slate-500">
              Posts DR expense / CR Accounts Payable for out-of-pocket lines only. Corporate-card lines are booked via the card feed and are not reimbursed here.
            </p>
          )}
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
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <Gavel size={14} className="text-slate-400" />
          <span className="text-xs font-semibold text-slate-200 uppercase tracking-wider">Policy check</span>
        </div>
        <div className="flex items-center gap-1.5">
          {summary.blockCount > 0 && (
            <span className="inline-flex items-center gap-1 text-2xs text-red-300 bg-red-500/10 px-1.5 py-0.5 rounded">
              <ShieldAlert size={10} /> {summary.blockCount} block
            </span>
          )}
          {summary.warnCount > 0 && (
            <span className="inline-flex items-center gap-1 text-2xs text-amber-300 bg-amber-500/10 px-1.5 py-0.5 rounded">
              <AlertTriangle size={10} /> {summary.warnCount} warn
            </span>
          )}
          {summary.blockCount === 0 && summary.warnCount === 0 && (
            <span className="inline-flex items-center gap-1 text-2xs text-emerald-300 bg-emerald-500/10 px-1.5 py-0.5 rounded">
              <ShieldCheck size={10} /> Clean
            </span>
          )}
        </div>
      </div>

      <div className="px-3 py-2.5 space-y-2">
        {(policy?.active || tier) && (
          <p className="text-2xs text-slate-500 flex items-center gap-2 flex-wrap">
            {policy?.active && <span>Policy: <span className="text-slate-300">{policy.active.name} v{policy.active.version}</span></span>}
            {tier && (
              <span className="inline-flex items-center gap-1 text-indigo-300 bg-indigo-500/10 px-1.5 py-0.5 rounded">
                Requires <span className="font-semibold">{tier}</span> approval
              </span>
            )}
          </p>
        )}

        {hasViolations ? (
          <div className="space-y-1.5">
            {summary.groups.map((g) => (
              <div key={g.code} className="flex items-start gap-2">
                <span className={clsx('mt-0.5 inline-flex items-center gap-1 text-2xs px-1.5 py-0.5 rounded shrink-0', SEVERITY_STYLE[g.severity] ?? SEVERITY_STYLE.warn)}>
                  {g.severity === 'block' ? <ShieldAlert size={9} /> : <AlertTriangle size={9} />}
                  {g.severity.toUpperCase()}
                </span>
                <div className="min-w-0">
                  <p className="text-xs text-slate-200">{g.message}</p>
                  <p className="text-2xs text-slate-500">
                    {g.count > 1 ? `${g.count} lines` : 'Line'} {g.lineNumbers.map((n) => `#${n}`).join(', ')}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-2xs text-slate-500">No policy violations on this report.</p>
        )}
      </div>
    </div>
  );
}

function SummaryTile({ label, value, accent }: { label: string; value: string; accent?: 'emerald' | 'indigo' }) {
  return (
    <div className="rounded-lg bg-slate-900 border border-slate-800 px-3 py-2">
      <p className="text-2xs text-slate-500">{label}</p>
      <p className={clsx('mt-0.5 text-sm font-mono tabular-nums font-semibold',
        accent === 'emerald' ? 'text-emerald-400' : accent === 'indigo' ? 'text-indigo-300' : 'text-white')}>
        {value}
      </p>
    </div>
  );
}

function LineCard({ line, editable, onChanged }: { line: LineRow; editable: boolean; onChanged: () => void }) {
  const [showCardPicker, setShowCardPicker] = useState(false);
  const del = useMutation(`/api/expenses/lines/${line.id}`, 'delete');

  async function remove() {
    const res = await del.mutate(undefined as never);
    if (res === null) addToast('error', del.error ?? 'Failed to delete line');
    else { addToast('success', 'Line removed'); onChanged(); }
  }

  return (
    <div className="rounded-lg bg-slate-900 border border-slate-800 px-3 py-2.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-2xs font-mono text-slate-600">#{line.line_number}</span>
            <span className="text-sm text-white truncate">{line.merchant ?? line.description ?? 'Expense'}</span>
            {line.payment_source === 'CORPORATE_CARD' ? (
              <span className="inline-flex items-center gap-1 text-2xs text-indigo-300 bg-indigo-500/10 px-1.5 py-0.5 rounded"><CreditCard size={10} /> Card</span>
            ) : (
              <span className="inline-flex items-center gap-1 text-2xs text-emerald-300 bg-emerald-500/10 px-1.5 py-0.5 rounded"><Wallet size={10} /> Out-of-pocket</span>
            )}
            {!line.has_receipt && <span className="text-2xs text-slate-500">no receipt</span>}
          </div>
          <p className="text-2xs text-slate-500 mt-0.5">
            {line.expense_date} · {line.account ? `${line.account.account_number} ${line.account.name}` : 'Uncoded'}
            {line.billable ? ' · billable' : ''}
          </p>
          {line.policy_reasons?.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {line.policy_reasons.map((f, i) => (
                <span key={i} className={clsx('inline-flex items-center gap-1 text-2xs px-1.5 py-0.5 rounded', SEVERITY_STYLE[f.severity] ?? SEVERITY_STYLE.warn)}>
                  <AlertTriangle size={9} /> {f.message}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="text-right shrink-0">
          <span className="text-sm font-mono tabular-nums text-slate-200">{formatMoney(line.amount_cents)}</span>
          {editable && (
            <div className="mt-1 flex items-center justify-end gap-2">
              {line.payment_source === 'OUT_OF_POCKET' && (
                <button onClick={() => setShowCardPicker((v) => !v)} className="text-2xs text-indigo-300 hover:text-indigo-200">On card?</button>
              )}
              <button onClick={remove} className="text-slate-600 hover:text-red-400" aria-label="Remove line"><Trash2 size={13} /></button>
            </div>
          )}
        </div>
      </div>
      {showCardPicker && <CardMatchPicker lineId={line.id} onMatched={() => { setShowCardPicker(false); onChanged(); }} />}
    </div>
  );
}

interface CardTxn { id: string; description: string; amount_cents: number; transaction_date: string }
function CardMatchPicker({ lineId, onMatched }: { lineId: string; onMatched: () => void }) {
  const { data, isLoading } = useQuery<{ data: CardTxn[] }>('/api/credit-cards', { per_page: '25' });
  const match = useMutation(`/api/expenses/lines/${lineId}/match-card`);

  async function pick(txnId: string) {
    const res = await match.mutate({ bank_transaction_id: txnId });
    if (res === null) addToast('error', match.error ?? 'Failed to match');
    else { addToast('success', 'Matched to card charge'); onMatched(); }
  }

  return (
    <div className="mt-2 rounded-lg bg-slate-950 border border-slate-800 p-2 max-h-48 overflow-auto">
      <p className="text-2xs text-slate-500 mb-1.5">Match to a corporate-card charge:</p>
      {isLoading ? (
        <p className="text-2xs text-slate-500">Loading card feed…</p>
      ) : (data?.data ?? []).length === 0 ? (
        <p className="text-2xs text-slate-500">No card charges found.</p>
      ) : (
        <div className="space-y-1">
          {(data?.data ?? []).map((t) => (
            <button key={t.id} onClick={() => pick(t.id)} className="w-full flex items-center justify-between gap-2 px-2 py-1 rounded hover:bg-white/[0.04] text-left">
              <span className="text-2xs text-slate-300 truncate">{t.transaction_date} · {t.description}</span>
              <span className="text-2xs font-mono text-slate-400">{formatMoney(Math.abs(t.amount_cents))}</span>
            </button>
          ))}
        </div>
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
      <button onClick={() => setOpen(true)} className="mt-2 inline-flex items-center gap-1.5 text-xs text-brand-400 hover:text-brand-300">
        <Plus size={13} /> Add a line
      </button>
    );
  }
  return (
    <div className="mt-2 rounded-lg bg-slate-950 border border-slate-800 p-3 space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <input value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="Merchant" aria-label="Merchant" className="input input-sm" />
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Expense date" className="input input-sm" />
        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount (e.g. 42.50)" aria-label="Amount" inputMode="decimal" className="input input-sm" />
        <select value={source} onChange={(e) => setSource(e.target.value as typeof source)} aria-label="Payment source" className="input input-sm">
          <option value="OUT_OF_POCKET">Out-of-pocket</option>
          <option value="CORPORATE_CARD">Corporate card</option>
        </select>
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={() => setOpen(false)} className="btn-ghost btn-sm">Cancel</button>
        <button onClick={save} disabled={add.isLoading} className="btn-primary btn-sm disabled:opacity-50">
          {add.isLoading ? <Loader2 size={14} className="animate-spin" /> : 'Add'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create-from-receipts modal
// ---------------------------------------------------------------------------

interface ReceiptPick { id: string; vendor_name: string | null; amount_cents: number | null; receipt_date: string | null; account: { account_number: string; name: string } | null }
function CreateReportModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { data, isLoading } = useQuery<{ data: ReceiptPick[] }>('/api/receipts', { status: 'all', per_page: '50' });
  const create = useMutation<{ title: string; receipt_ids: string[] }, { report_id: string }>('/api/expenses');

  function toggle(id: string) {
    setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  async function submit() {
    const res = await create.mutate({ title: title || 'Expense report', receipt_ids: Array.from(selected) });
    if (!res) { addToast('error', create.error ?? 'Failed to create report'); return; }
    addToast('success', 'Report created');
    onCreated(res.report_id);
  }

  const receipts = data?.data ?? [];

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-report-title"
          className="pointer-events-auto w-full max-w-lg rounded-xl bg-slate-900 border border-slate-800 shadow-2xl flex flex-col max-h-[85vh]"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
            <h2 id="create-report-title" className="text-base font-semibold text-white">New expense report</h2>
            <button onClick={onClose} aria-label="Close" className="p-1 text-slate-500 hover:text-slate-200"><X size={18} /></button>
          </div>
          <div className="p-4 space-y-3 overflow-auto">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Report title (e.g. August client travel)" aria-label="Report title" className="input w-full" />
            <div>
              <p className="text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-2">
                Build from captured receipts {selected.size > 0 ? `· ${selected.size} selected` : ''}
              </p>
              {isLoading ? (
                <p className="text-sm text-slate-500">Loading receipts…</p>
              ) : receipts.length === 0 ? (
                <p className="text-sm text-slate-500">No captured receipts. You can create an empty report and add lines manually.</p>
              ) : (
                <div className="space-y-1 max-h-64 overflow-auto">
                  {receipts.map((r) => (
                    <label key={r.id} className="flex items-center gap-3 px-2 py-1.5 rounded hover:bg-white/[0.03] cursor-pointer">
                      <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} className="accent-brand-500" />
                      <span className="min-w-0 flex-1 text-sm text-slate-200 truncate">{r.vendor_name ?? 'Receipt'}</span>
                      <span className="text-2xs text-slate-500">{r.account ? r.account.account_number : 'uncoded'}</span>
                      <span className="text-sm font-mono tabular-nums text-slate-300">{formatMoney(Math.abs(r.amount_cents ?? 0))}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="flex justify-end gap-2 px-4 py-3 border-t border-slate-800">
            <button onClick={onClose} className="btn-ghost btn-sm">Cancel</button>
            <button onClick={submit} disabled={create.isLoading} className="btn-primary btn-sm inline-flex items-center gap-1.5 disabled:opacity-50">
              {create.isLoading ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Create report
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
