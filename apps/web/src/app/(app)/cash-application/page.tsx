'use client';

import { useMemo, useState } from 'react';
import {
  Loader2,
  AlertCircle,
  CheckCircle2,
  Banknote,
  Scale,
  Sparkles,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { clsx } from 'clsx';
import { formatMoney, dollarsToCents, centsToDollars } from '@meritbooks/shared';
import { useQuery, addToast } from '@/hooks';
import { api } from '@/lib/api-client';
import { PageHeader } from '@/components/ui';

// ── Types (mirror the API routes) ──────────────────────────────────────────────

interface InvoiceCandidate {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  balanceCents: number;
}

interface Proposal {
  id: string;
  confidence: number | null;
  reasoning: string | null;
  title: string | null;
  kind: 'single' | 'sum_to_total';
  customerId: string | null;
  customerName: string;
  deposit: { id: string; date: string; amountCents: number; description: string | null; posted: boolean } | null;
  proposedInvoiceIds: string[];
  candidateInvoices: InvoiceCandidate[];
  createdAt: string;
}

interface ProposalsResponse {
  data: Proposal[];
  counts: { total: number };
}

interface TieOut {
  subledgerCents: number;
  glControlCents: number | null;
  varianceCents: number | null;
  tiesOut: boolean;
  arAccountNumber: string | null;
  note?: string;
  reconcilingItem?: { label: string; amountCents: number } | null;
  asOf: string;
}

interface ApplyResult {
  appliedCents: number;
  unappliedCents: number;
  invoiceIds: string[];
}

function confidenceClass(c: number): string {
  if (c >= 0.9) return 'bg-emerald-500/10 text-emerald-400';
  if (c >= 0.7) return 'bg-amber-500/10 text-amber-400';
  return 'bg-red-500/10 text-red-400';
}

// ── AR tie-out card ─────────────────────────────────────────────────────────────

function TieOutCard() {
  const { data, isLoading, error } = useQuery<{ data: TieOut }>('/api/cash-application/tie-out');
  const tie = data?.data;

  return (
    <div className="card p-5">
      <div className="flex items-center gap-2">
        <Scale size={16} className="text-indigo-400" />
        <h2 className="text-sm font-semibold text-white">AR subledger ↔ GL control tie-out</h2>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        The sum of open invoice balances should equal the AR control account in the general ledger.
      </p>

      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-emerald-400" />
        </div>
      ) : error ? (
        <p className="mt-4 text-sm text-red-400">{error}</p>
      ) : !tie ? null : (
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-lg bg-slate-800/40 p-3">
            <p className="text-[11px] uppercase tracking-wide text-slate-500">AR subledger</p>
            <p className="mt-1 font-mono text-lg text-slate-100">{formatMoney(tie.subledgerCents)}</p>
            <p className="mt-0.5 text-[11px] text-slate-500">Σ open invoice balances</p>
          </div>
          <div className="rounded-lg bg-slate-800/40 p-3">
            <p className="text-[11px] uppercase tracking-wide text-slate-500">
              GL control{tie.arAccountNumber ? ` · ${tie.arAccountNumber}` : ''}
            </p>
            <p className="mt-1 font-mono text-lg text-slate-100">
              {tie.glControlCents === null ? '—' : formatMoney(tie.glControlCents)}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-500">AR account GL balance</p>
          </div>
          <div
            className={clsx(
              'rounded-lg p-3',
              tie.tiesOut ? 'bg-emerald-500/10' : 'bg-amber-500/10',
            )}
          >
            <p className="text-[11px] uppercase tracking-wide text-slate-400">Variance</p>
            <p
              className={clsx(
                'mt-1 font-mono text-lg',
                tie.tiesOut ? 'text-emerald-400' : 'text-amber-400',
              )}
            >
              {tie.varianceCents === null ? '—' : formatMoney(tie.varianceCents)}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-400">
              {tie.tiesOut ? 'Ties out — no reconciling items' : tie.note ?? tie.reconcilingItem?.label ?? 'Reconciling item'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── One proposal (approve / adjust / apply) ──────────────────────────────────────

interface LineState {
  selected: boolean;
  amountDollars: string;
}

function ProposalCard({ proposal, onApplied }: { proposal: Proposal; onApplied: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [applying, setApplying] = useState(false);
  const [touched, setTouched] = useState(false);

  const proposedSet = useMemo(() => new Set(proposal.proposedInvoiceIds), [proposal.proposedInvoiceIds]);

  const [lines, setLines] = useState<Record<string, LineState>>(() => {
    const init: Record<string, LineState> = {};
    for (const inv of proposal.candidateInvoices) {
      const selected = proposedSet.has(inv.id);
      init[inv.id] = { selected, amountDollars: selected ? String(centsToDollars(inv.balanceCents)) : '' };
    }
    return init;
  });

  const depositCents = proposal.deposit?.amountCents ?? 0;

  const appliedCents = useMemo(() => {
    let total = 0;
    for (const inv of proposal.candidateInvoices) {
      const st = lines[inv.id];
      if (st?.selected && st.amountDollars.trim() !== '') {
        const c = dollarsToCents(st.amountDollars);
        if (Number.isFinite(c) && c > 0) total += c;
      }
    }
    return total;
  }, [lines, proposal.candidateInvoices]);

  const remainderCents = depositCents - appliedCents;
  const overApplied = remainderCents < 0;

  function toggle(inv: InvoiceCandidate) {
    setTouched(true);
    setLines((prev) => {
      const cur = prev[inv.id] ?? { selected: false, amountDollars: '' };
      const nowSelected = !cur.selected;
      return {
        ...prev,
        [inv.id]: {
          selected: nowSelected,
          amountDollars: nowSelected && cur.amountDollars.trim() === '' ? String(centsToDollars(inv.balanceCents)) : cur.amountDollars,
        },
      };
    });
  }

  function setAmount(id: string, value: string) {
    setTouched(true);
    setLines((prev) => ({ ...prev, [id]: { selected: true, amountDollars: value } }));
  }

  async function apply() {
    const selected = proposal.candidateInvoices.filter((inv) => lines[inv.id]?.selected);
    if (selected.length === 0) {
      addToast('error', 'Select at least one invoice to apply.');
      return;
    }
    if (overApplied) {
      addToast('error', 'Applied total exceeds the deposit.');
      return;
    }

    setApplying(true);
    // Send explicit applications only when the human adjusted the proposal; otherwise
    // apply as proposed (server applies each proposed invoice at its full balance).
    const isDefault =
      !touched &&
      selected.length === proposal.proposedInvoiceIds.length &&
      selected.every((inv) => proposedSet.has(inv.id));

    const body = isDefault
      ? { proposal_id: proposal.id }
      : {
          proposal_id: proposal.id,
          applications: selected.map((inv) => ({
            invoice_id: inv.id,
            amount_cents: dollarsToCents(lines[inv.id].amountDollars || '0'),
          })),
        };

    const res = await api.post<{ data: ApplyResult }>('/api/cash-application/apply', body);
    setApplying(false);

    if (res.error) {
      addToast('error', res.error.error || 'Could not apply payment');
      return;
    }
    const applied = res.data?.data.appliedCents ?? appliedCents;
    addToast('success', `Applied ${formatMoney(applied)} — DR Cash / CR AR posted`);
    onApplied();
  }

  return (
    <div className="card overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-slate-800/30"
      >
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10">
          <Banknote size={16} className="text-indigo-400" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium text-white">{proposal.customerName}</p>
            <span className="inline-flex shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-slate-300 ring-1 ring-inset ring-slate-600/40">
              {proposal.kind === 'single' ? 'Single invoice' : 'Lump remittance'}
            </span>
            {proposal.confidence !== null && (
              <span
                className={clsx(
                  'inline-flex shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-medium',
                  confidenceClass(proposal.confidence),
                )}
              >
                {Math.round(proposal.confidence * 100)}%
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-slate-500">
            {proposal.reasoning ?? proposal.title ?? 'Proposed cash application'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="font-mono text-sm text-slate-200">{formatMoney(depositCents)}</span>
          {expanded ? (
            <ChevronDown size={16} className="text-slate-500" />
          ) : (
            <ChevronRight size={16} className="text-slate-500" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-slate-800/60 px-4 py-4">
          <div className="mb-2 flex items-center gap-2 text-xs text-slate-400">
            <Sparkles size={12} className="text-indigo-400" />
            AI proposed the highlighted invoice(s). Adjust the selection or amounts if the match is
            wrong, then apply.
          </div>

          {proposal.candidateInvoices.length === 0 ? (
            <p className="py-4 text-sm text-slate-500">No open invoices remain for this customer.</p>
          ) : (
            <div className="divide-y divide-slate-800/40 rounded-lg border border-slate-800/60">
              {proposal.candidateInvoices.map((inv) => {
                const st = lines[inv.id] ?? { selected: false, amountDollars: '' };
                const isProposed = proposedSet.has(inv.id);
                return (
                  <div
                    key={inv.id}
                    className={clsx(
                      'flex items-center gap-3 px-3 py-2.5',
                      isProposed && 'bg-indigo-500/[0.04]',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={st.selected}
                      onChange={() => toggle(inv)}
                      className="h-4 w-4 shrink-0 rounded border-slate-600 bg-slate-800 text-emerald-500 focus:ring-emerald-500/40"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate font-mono text-xs text-slate-200">{inv.invoiceNumber}</p>
                        {isProposed && (
                          <span className="rounded bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-medium text-indigo-300">
                            proposed
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-500">
                        Due {inv.dueDate} · balance {formatMoney(inv.balanceCents)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <span className="text-xs text-slate-500">$</span>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        disabled={!st.selected}
                        value={st.amountDollars}
                        onChange={(e) => setAmount(inv.id, e.target.value)}
                        className="w-28 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-right font-mono text-xs text-slate-100 disabled:opacity-40 focus:border-emerald-500/40 focus:outline-none"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Applied / remainder summary */}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-4">
              <span className="text-slate-400">
                Applied <span className="font-mono text-slate-200">{formatMoney(appliedCents)}</span>
              </span>
              <span
                className={clsx(
                  overApplied ? 'text-red-400' : remainderCents > 0 ? 'text-amber-400' : 'text-emerald-400',
                )}
              >
                {overApplied
                  ? `Over by ${formatMoney(-remainderCents)}`
                  : remainderCents > 0
                    ? `${formatMoney(remainderCents)} left on account`
                    : 'Fully applied'}
              </span>
            </div>
            <button
              type="button"
              disabled={applying || overApplied}
              onClick={apply}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-medium transition-colors',
                'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              {applying ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
              Approve &amp; apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CashApplicationPage() {
  const { data, isLoading, error, refetch } = useQuery<ProposalsResponse>('/api/cash-application/proposals');
  const proposals = useMemo(() => data?.data ?? [], [data]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cash application"
        description="Match incoming deposits to open invoices, then approve to post the receipt (DR Cash / CR AR)."
      />

      <TieOutCard />

      {isLoading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-6 w-6 animate-spin text-emerald-400" />
        </div>
      ) : error ? (
        <div className="card p-10 text-center">
          <AlertCircle className="mx-auto mb-3 h-8 w-8 text-red-400" />
          <p className="text-sm text-red-400">{error}</p>
          <button
            onClick={() => refetch()}
            className="mt-4 rounded-lg bg-slate-800 px-3.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
          >
            Try again
          </button>
        </div>
      ) : proposals.length === 0 ? (
        <div className="card p-16 text-center">
          <CheckCircle2 className="mx-auto mb-3 h-10 w-10 text-emerald-500/70" />
          <p className="text-sm font-medium text-white">No deposits waiting to be applied</p>
          <p className="mt-1 text-xs text-slate-500">
            When the AI matches an unapplied deposit to open invoices, it will appear here for your
            approval.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {proposals.map((p) => (
            <ProposalCard key={p.id} proposal={p} onApplied={refetch} />
          ))}
        </div>
      )}
    </div>
  );
}
