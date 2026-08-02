'use client';

import { useState, useCallback } from 'react';
import {
  Plus, Receipt, CreditCard, AlertTriangle, Check, X, Send, Wallet,
  Loader2, Inbox, FileText, ChevronRight, Trash2,
} from 'lucide-react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { useQuery, useMutation, addToast } from '@/hooks';
import { StatusBadge, EmptyState, TableSkeleton, MetricCard } from '@/components/ui';
import { DetailDrawer, DetailSection, DetailField } from '@/components/detail-drawer';

type Scope = 'mine' | 'queue';
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
  created_at: string;
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
}

const TABS: { key: Scope; label: string; icon: typeof Receipt }[] = [
  { key: 'mine', label: 'My Reports', icon: FileText },
  { key: 'queue', label: 'Approver Queue', icon: Inbox },
];

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
      {/* Metric strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard label="Draft" value={String(counts.DRAFT ?? 0)} icon={FileText} />
        <MetricCard label="Awaiting approval" value={String(counts.SUBMITTED ?? 0)} icon={Inbox} />
        <MetricCard label="Approved" value={String(counts.APPROVED ?? 0)} icon={Check} />
        <MetricCard label="Reimbursed" value={String(counts.REIMBURSED ?? 0)} icon={Wallet} />
      </div>

      {/* Tabs + create */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="inline-flex rounded-lg bg-slate-900 border border-slate-800 p-0.5">
          {TABS.map((t) => {
            const Icon = t.icon;
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
              </button>
            );
          })}
        </div>
        <button onClick={() => setShowCreate(true)} className="btn-primary btn-sm inline-flex items-center gap-1.5">
          <Plus size={14} /> New report
        </button>
      </div>

      {/* List */}
      {isLoading ? (
        <TableSkeleton />
      ) : error ? (
        <EmptyState icon={AlertTriangle} title="Couldn’t load expense reports" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={scope === 'queue' ? Inbox : Receipt}
          title={scope === 'queue' ? 'Nothing awaiting your approval' : 'No expense reports yet'}
          description={scope === 'queue'
            ? 'Submitted reports from your team will appear here for review.'
            : 'Create a report from captured receipts, add out-of-pocket or card expenses, then submit for approval.'}
          action={scope === 'mine' ? { label: 'New report', onClick: () => setShowCreate(true) } : undefined}
        />
      ) : (
        <div className="card divide-y divide-slate-800/70">
          {rows.map((r) => (
            <button
              key={r.id}
              onClick={() => setSelectedId(r.id)}
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
      // status changed — a queue item may leave the list; close if it left this scope
      if (scope === 'queue') onClose();
    }
  }

  const report = data?.report;
  const lines = data?.lines ?? [];
  const editable = report?.status === 'DRAFT' || report?.status === 'REJECTED';

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

          {report.policy_flag_count > 0 && (
            <div className="flex items-center gap-2 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
              <AlertTriangle size={14} />
              {report.policy_flag_count} line{report.policy_flag_count === 1 ? '' : 's'} flagged for policy review
            </div>
          )}

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
                  disabled={busy !== null}
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
        <input value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="Merchant" className="input input-sm" />
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="input input-sm" />
        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount (e.g. 42.50)" inputMode="decimal" className="input input-sm" />
        <select value={source} onChange={(e) => setSource(e.target.value as typeof source)} className="input input-sm">
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

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div className="pointer-events-auto w-full max-w-lg rounded-xl bg-slate-900 border border-slate-800 shadow-2xl flex flex-col max-h-[85vh]">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
            <h2 className="text-base font-semibold text-white">New expense report</h2>
            <button onClick={onClose} className="p-1 text-slate-500 hover:text-slate-200"><X size={18} /></button>
          </div>
          <div className="p-4 space-y-3 overflow-auto">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Report title (e.g. August client travel)" className="input w-full" />
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
