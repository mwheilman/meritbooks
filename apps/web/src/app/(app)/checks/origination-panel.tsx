'use client';

import { useCallback, useState } from 'react';
import {
  Loader2,
  Landmark,
  Send,
  RefreshCw,
  CheckCircle2,
  Clock,
  AlertTriangle,
  AlertCircle,
  XCircle,
  PlusCircle,
  ChevronDown,
  ChevronRight,
  FlaskConical,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, addToast } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';

type BatchStatus = 'CREATED' | 'SUBMITTED' | 'SETTLED' | 'FAILED' | 'RETURNED' | 'CANCELED';
type ItemStatus = 'PENDING' | 'SUBMITTED' | 'SETTLED' | 'FAILED' | 'RETURNED';

interface OrigItem {
  id: string;
  batchId: string;
  approvalId: string | null;
  billPaymentId: string | null;
  vendorId: string | null;
  vendorName: string | null;
  amountCents: number;
  status: ItemStatus;
  returnCode: string | null;
}
interface OrigBatch {
  id: string;
  provider: string;
  rail: 'ACH' | 'WIRE';
  status: BatchStatus;
  providerBatchRef: string | null;
  totalCents: number;
  itemCount: number;
  effectiveDate: string | null;
  submittedBy: string | null;
  submittedAt: string | null;
  settledAt: string | null;
  createdAt: string;
  items: OrigItem[];
}
interface ListResponse {
  batches: OrigBatch[];
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const BATCH_TONE: Record<BatchStatus, { label: string; cls: string; Icon: typeof Clock }> = {
  CREATED: { label: 'Created', cls: 'bg-slate-600/25 text-slate-300', Icon: Clock },
  SUBMITTED: { label: 'Submitted', cls: 'bg-blue-500/15 text-blue-300', Icon: Send },
  SETTLED: { label: 'Settled', cls: 'bg-emerald-600/15 text-emerald-300', Icon: CheckCircle2 },
  RETURNED: { label: 'Returned', cls: 'bg-red-500/15 text-red-300', Icon: AlertTriangle },
  FAILED: { label: 'Failed', cls: 'bg-red-500/15 text-red-300', Icon: XCircle },
  CANCELED: { label: 'Canceled', cls: 'bg-slate-600/25 text-slate-400', Icon: XCircle },
};

const ITEM_TONE: Record<ItemStatus, string> = {
  PENDING: 'text-slate-400',
  SUBMITTED: 'text-blue-300',
  SETTLED: 'text-emerald-300',
  FAILED: 'text-red-300',
  RETURNED: 'text-red-300',
};

/**
 * Money-out ORIGINATION panel (migration 143). Shows the provider-agnostic rail
 * hand-off for already-released (already-posted) AP disbursements: create a batch,
 * submit it to the rail, refresh its lifecycle, and see per-payee status + ACH
 * return codes. SANDBOX only — no live rail; nothing here posts to the GL or moves
 * money (release already posted DR A/P / CR Cash). A returned item is FLAGGED for a
 * human — never auto-reversed.
 */
export function OriginationPanel() {
  const { data, isLoading, error, refetch } = useQuery<ListResponse>('/api/ap/origination/list');
  const [creating, setCreating] = useState(false);
  const [busyBatch, setBusyBatch] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const batches = data?.batches ?? [];

  const create = useCallback(async () => {
    setCreating(true);
    try {
      const res = await fetch('/api/ap/origination/create-from-approved-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rail: 'ACH' }),
      });
      const result = (await res.json()) as { batch?: OrigBatch; error?: string; code?: string };
      if (!res.ok) {
        addToast(result.code === 'NOTHING_TO_ORIGINATE' ? 'info' : 'error', result.error ?? 'Failed to create batch');
        return;
      }
      addToast('success', `Created origination batch: ${result.batch?.itemCount ?? 0} payment(s)`);
      await refetch();
    } catch {
      addToast('error', 'Network error');
    } finally {
      setCreating(false);
    }
  }, [refetch]);

  const submit = useCallback(
    async (batchId: string) => {
      setBusyBatch(batchId);
      try {
        const res = await fetch('/api/ap/origination/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ batchId }),
        });
        const result = (await res.json()) as { submitted?: boolean; error?: string };
        if (!res.ok) {
          addToast('error', result.error ?? 'Submit failed');
          return;
        }
        addToast(result.submitted ? 'success' : 'info', result.submitted ? 'Submitted to SANDBOX rail' : 'Already submitted');
        await refetch();
      } catch {
        addToast('error', 'Network error');
      } finally {
        setBusyBatch(null);
      }
    },
    [refetch],
  );

  const refresh = useCallback(
    async (batchId: string, simulate?: { returns?: Array<{ itemId: string; returnCode: string }> }) => {
      setBusyBatch(batchId);
      try {
        const res = await fetch('/api/ap/origination/refresh-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ batchId, simulate }),
        });
        const result = (await res.json()) as { batch?: OrigBatch; error?: string };
        if (!res.ok) {
          addToast('error', result.error ?? 'Refresh failed');
          return;
        }
        const s = result.batch?.status;
        addToast(s === 'RETURNED' || s === 'FAILED' ? 'info' : 'success', `Status: ${s ?? 'updated'}`);
        await refetch();
      } catch {
        addToast('error', 'Network error');
      } finally {
        setBusyBatch(null);
      }
    },
    [refetch],
  );

  const simulateReturn = useCallback(
    (batch: OrigBatch) => {
      const first = batch.items[0];
      if (!first) return;
      void refresh(batch.id, { returns: [{ itemId: first.id, returnCode: 'R01' }] });
    },
    [refresh],
  );

  return (
    <div className="card p-4 space-y-4 border border-indigo-900/40">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <Landmark size={15} className="text-indigo-400" /> Payment origination
          </h2>
          <p className="text-2xs text-slate-500 mt-0.5 max-w-2xl">
            Hand already-released (already-posted) disbursements to a payment rail and track submission → settlement.
            This does NOT post to the GL — release already did — and does NOT move money on its own.
          </p>
        </div>
        <button
          onClick={create}
          disabled={creating}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-40 transition-colors"
        >
          {creating ? <Loader2 size={12} className="animate-spin" /> : <PlusCircle size={12} />} Originate released payments
        </button>
      </div>

      {/* SANDBOX notice — required labeling */}
      <div className="rounded-lg border border-amber-900/50 bg-amber-950/20 px-3 py-2 flex items-start gap-2">
        <FlaskConical size={13} className="text-amber-300 mt-0.5 shrink-0" />
        <p className="text-2xs text-amber-200/80">
          <span className="font-semibold text-amber-300">SANDBOX — no live rail.</span> Submissions are simulated
          deterministically (no network, no money moved). Connect a provider to originate real ACH/wire payments. A
          returned item is flagged for review — it is never auto-reversed in the ledger.
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-5 h-5 text-indigo-400 animate-spin" />
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-900/50 bg-red-950/20 p-3 text-center">
          <AlertCircle className="mx-auto text-red-400 mb-1" size={18} />
          <p className="text-xs text-red-400">{error}</p>
        </div>
      ) : batches.length === 0 ? (
        <div className="rounded-lg border border-slate-800 bg-surface-950 p-6 text-center">
          <Landmark className="mx-auto text-slate-600 mb-2" size={20} />
          <p className="text-xs text-slate-400">
            No origination batches yet. Release a pay run above, then click{' '}
            <span className="text-slate-300 font-medium">Originate released payments</span> to hand the posted
            disbursements to the SANDBOX rail.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {batches.map((b) => {
            const tone = BATCH_TONE[b.status];
            const isOpen = expanded[b.id] ?? false;
            const busy = busyBatch === b.id;
            const returnedCount = b.items.filter((i) => i.status === 'RETURNED' || i.status === 'FAILED').length;
            return (
              <div key={b.id} className="rounded-lg border border-slate-800 overflow-hidden">
                <div className="px-3 py-2.5 flex items-center justify-between gap-3 bg-surface-950">
                  <button
                    onClick={() => setExpanded((e) => ({ ...e, [b.id]: !isOpen }))}
                    className="flex items-center gap-2 min-w-0 text-left"
                    aria-expanded={isOpen}
                  >
                    {isOpen ? (
                      <ChevronDown size={14} className="text-slate-500 shrink-0" />
                    ) : (
                      <ChevronRight size={14} className="text-slate-500 shrink-0" />
                    )}
                    <StatusBadge tone={tone} />
                    <span className="text-xs text-slate-300">
                      <span className="font-mono text-slate-200">{b.rail}</span> · {b.itemCount} payment(s) ·{' '}
                      <span className="font-mono tabular-nums text-slate-200">{formatMoney(b.totalCents)}</span>
                    </span>
                    <span className="text-2xs text-slate-600 hidden md:inline">{b.provider}</span>
                  </button>
                  <div className="flex items-center gap-2 shrink-0">
                    {b.status === 'CREATED' && (
                      <ActionBtn onClick={() => submit(b.id)} busy={busy} Icon={Send} label="Submit" />
                    )}
                    {b.status === 'SUBMITTED' && (
                      <>
                        <ActionBtn onClick={() => refresh(b.id)} busy={busy} Icon={RefreshCw} label="Refresh" />
                        <button
                          onClick={() => simulateReturn(b)}
                          disabled={busy}
                          title="SANDBOX only: simulate an ACH return (R01) on the first item"
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-2xs font-medium bg-surface-900 border border-amber-800/40 text-amber-300 hover:bg-amber-950/30 disabled:opacity-40 transition-colors"
                        >
                          <FlaskConical size={11} /> Simulate return
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {returnedCount > 0 && (
                  <div className="px-3 py-1.5 bg-red-950/20 border-t border-red-900/40">
                    <p className="text-2xs text-red-300 flex items-center gap-1.5">
                      <AlertTriangle size={11} /> {returnedCount} item(s) returned/failed — review and post a reversing
                      entry manually. No GL reversal was made automatically.
                    </p>
                  </div>
                )}

                {isOpen && (
                  <div className="divide-y divide-slate-800/40 border-t border-slate-800">
                    <div className="px-3 py-1.5 flex items-center justify-between text-2xs text-slate-600">
                      <span>
                        Ref: <span className="font-mono text-slate-500">{b.providerBatchRef ?? '—'}</span>
                      </span>
                      <span>
                        Submitted {fmtDateTime(b.submittedAt)}
                        {b.settledAt ? ` · Settled ${fmtDateTime(b.settledAt)}` : ''}
                      </span>
                    </div>
                    {b.items.map((it) => (
                      <div key={it.id} className="px-3 py-2 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <span className="text-xs text-slate-200 truncate max-w-[200px] inline-block align-middle">
                            {it.vendorName ?? 'Vendor'}
                          </span>
                          {it.returnCode && (
                            <span className="text-2xs font-mono text-red-300 ml-2 rounded bg-red-500/10 px-1.5 py-0.5">
                              {it.returnCode}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <span className={clsx('text-2xs font-medium uppercase tracking-wide', ITEM_TONE[it.status])}>
                            {it.status}
                          </span>
                          <span className="text-xs font-mono tabular-nums text-slate-300">{formatMoney(it.amountCents)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ tone }: { tone: { label: string; cls: string; Icon: typeof Clock } }) {
  const { label, cls, Icon } = tone;
  return (
    <span className={clsx('inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs font-semibold', cls)}>
      <Icon size={11} /> {label}
    </span>
  );
}

function ActionBtn({
  onClick,
  busy,
  Icon,
  label,
}: {
  onClick: () => void;
  busy: boolean;
  Icon: typeof Send;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-2xs font-medium bg-indigo-600/90 text-white hover:bg-indigo-500 disabled:opacity-40 transition-colors"
    >
      {busy ? <Loader2 size={11} className="animate-spin" /> : <Icon size={11} />} {label}
    </button>
  );
}
