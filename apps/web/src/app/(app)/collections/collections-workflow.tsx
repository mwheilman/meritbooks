'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, addToast } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import {
  ArrowLeft, AlertCircle, Loader2, Send, Sparkles, ChevronDown, ChevronRight,
  Building2, Wallet, Clock, HandCoins, ShieldAlert, X, FileText, PhoneCall,
  CalendarClock, CheckCircle2, Ban, RefreshCw, TrendingUp, Target,
} from 'lucide-react';

// ─── Types (mirror /api/collections/worklist) ──────────────────────────────

type RiskLevel = 'low' | 'medium' | 'high';
type StageKey = 'FIRST_NOTICE' | 'SECOND_NOTICE' | 'THIRD_NOTICE' | 'FINAL_NOTICE';
type ActionKind =
  | 'AWAIT_PROMISE' | 'CALL_BROKEN_PROMISE' | 'SEND_FIRST_NOTICE' | 'SEND_SECOND_NOTICE'
  | 'SEND_THIRD_NOTICE' | 'SEND_FINAL_NOTICE' | 'ESCALATE' | 'MONITOR';

type PredConfidence = 'low' | 'medium' | 'high';
type PredBasis = 'history_median' | 'history_avg' | 'terms_default';
interface PayPrediction {
  predictedPayDate: string; predictedDaysToPay: number; predictedDaysLate: number;
  basis: PredBasis; confidence: PredConfidence; confidenceScore: number;
  isOverdueBeyondPrediction: boolean; rationale: string;
}
interface NextStep {
  stage: { key: StageKey; label: string; tone: string };
  scheduledDate: string; daysUntil: number; isDueNow: boolean;
  kind: 'first-contact' | 'escalation' | 're-nudge'; reason: string;
}
interface WlInvoice {
  id: string; invoiceNumber: string; invoiceDate?: string; dueDate: string; balanceCents: number;
  daysOverdue: number; lastStageSent: StageKey | null; lastReminderAt: string | null; reminderCount: number;
  prediction: PayPrediction | null; nextStep: NextStep | null;
}
interface WlPromise {
  id: string; customerId: string; invoiceId: string | null; amountCents: number;
  promiseDate: string; note: string | null; createdAt: string;
  status: 'PENDING' | 'KEPT' | 'BROKEN'; daysPastPromise: number;
}
interface RecommendedAction { kind: ActionKind; label: string; reason: string; stage: StageKey | null }
interface WlAccount {
  customerId: string | null; customerName: string; customerEmail: string | null;
  riskLevel: RiskLevel; riskFlags: string[]; riskSummary: string;
  openBalanceCents: number; overdueBalanceCents: number; overdueInvoiceCount: number;
  maxDaysOverdue: number; focusInvoiceId: string | null;
  hasBrokenPromise: boolean; hasPendingPromise: boolean; pendingPromise: WlPromise | null;
  brokenPromiseCount: number; currentStage: StageKey | null; reminderDue: boolean;
  recommendedAction: RecommendedAction; priorityScore: number;
  expectedValueAtRiskCents: number; focusPrediction: PayPrediction | null; nextStep: NextStep | null;
  invoices: WlInvoice[]; promises: WlPromise[];
}
interface WorklistPayload {
  asOf: string;
  accounts: WlAccount[];
  kpis: {
    totalOverdueCents: number; totalOpenCents: number; accountsInWorklist: number;
    brokenPromiseCount: number; remindersDueCount: number;
    totalExpectedValueAtRiskCents: number; predictedLateCount: number;
  };
}
interface LocationOption { id: string; name: string; short_code: string }

// ─── Style maps ─────────────────────────────────────────────────────────────

const RISK_BADGE: Record<RiskLevel, string> = {
  low: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
  medium: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  high: 'bg-red-500/10 text-red-300 border-red-500/30',
};
const STAGE_LABEL: Record<StageKey, string> = {
  FIRST_NOTICE: 'First notice', SECOND_NOTICE: 'Second notice', THIRD_NOTICE: 'Third notice', FINAL_NOTICE: 'Final notice',
};
const STAGE_TEXT: Record<StageKey, string> = {
  FIRST_NOTICE: 'text-emerald-300', SECOND_NOTICE: 'text-amber-300', THIRD_NOTICE: 'text-orange-300', FINAL_NOTICE: 'text-red-300',
};
function actionStyle(kind: ActionKind): { cls: string; Icon: React.ComponentType<{ className?: string }> } {
  switch (kind) {
    case 'AWAIT_PROMISE': return { cls: 'bg-blue-500/10 text-blue-300 border-blue-500/30', Icon: CalendarClock };
    case 'CALL_BROKEN_PROMISE': return { cls: 'bg-amber-500/10 text-amber-300 border-amber-500/30', Icon: PhoneCall };
    case 'ESCALATE': return { cls: 'bg-red-500/10 text-red-300 border-red-500/30', Icon: ShieldAlert };
    case 'MONITOR': return { cls: 'bg-slate-600/20 text-slate-300 border-slate-600/40', Icon: Clock };
    default: return { cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30', Icon: Send };
  }
}
const fmtWhen = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null;

const CONF_STYLE: Record<PredConfidence, { cls: string; label: string }> = {
  high: { cls: 'text-emerald-300', label: 'high' },
  medium: { cls: 'text-amber-300', label: 'med' },
  low: { cls: 'text-slate-400', label: 'low' },
};
function latenessChip(daysLate: number): { cls: string; text: string } {
  if (daysLate > 0) return { cls: 'text-red-300', text: `~${daysLate}d late` };
  if (daysLate === 0) return { cls: 'text-amber-300', text: 'on the wire' };
  return { cls: 'text-emerald-300', text: `~${-daysLate}d early` };
}

// ─── Draft + Promise modal state ─────────────────────────────────────────────

interface DraftState {
  invoiceId: string; account: WlAccount; loading: boolean; sending: boolean;
  stage: StageKey | null; stageLabel: string; tone: string; daysOverdue: number;
  balanceCents: number; customerName: string; customerEmail: string | null;
  subject: string; body: string; aiUsed: boolean;
  fallback: { subject: string; body: string } | null;
}
interface PromiseModalState { account: WlAccount; invoiceId: string | null; amount: string; date: string; note: string; saving: boolean }

// ─── Main ─────────────────────────────────────────────────────────────────────

export function CollectionsWorkflow({ embedded = false }: { embedded?: boolean } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const [locationId, setLocationId] = useState('');
  const [asOf, setAsOf] = useState(today);
  const [reloadKey, setReloadKey] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [promiseModal, setPromiseModal] = useState<PromiseModalState | null>(null);

  const params = new URLSearchParams();
  if (locationId) params.set('location_id', locationId);
  if (asOf) params.set('as_of', asOf);

  const { data, isLoading, error, refetch } = useQuery<WorklistPayload>(
    `/api/collections/worklist?${params.toString()}`, undefined, { key: String(reloadKey) },
  );
  const { data: locData } = useQuery<{ data: LocationOption[] }>('/api/locations');
  const locations = locData?.data ?? [];

  const reload = () => { setReloadKey((k) => k + 1); refetch(); };

  // ── Draft a reminder for a specific invoice ──────────────────────────────
  async function openDraft(account: WlAccount, invoiceId: string, stage: StageKey | null) {
    setDraft({
      invoiceId, account, loading: true, sending: false, stage, stageLabel: '', tone: '',
      daysOverdue: 0, balanceCents: 0, customerName: account.customerName,
      customerEmail: account.customerEmail, subject: '', body: '', aiUsed: false, fallback: null,
    });
    try {
      const res = await fetch('/api/collections/draft', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId, stage, as_of: asOf }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) { addToast('error', b.error ?? 'Could not draft the reminder.'); setDraft(null); return; }
      setDraft((d) => d && {
        ...d, loading: false, stage: b.stage, stageLabel: b.stageLabel, tone: b.tone,
        daysOverdue: b.daysOverdue, balanceCents: b.balanceCents, customerName: b.customerName,
        customerEmail: b.customerEmail, subject: b.subject, body: b.body, aiUsed: b.aiUsed, fallback: b.fallback ?? null,
      });
    } catch {
      addToast('error', 'Could not reach the drafting service.'); setDraft(null);
    }
  }

  async function sendDraft() {
    if (!draft) return;
    setDraft((d) => d && { ...d, sending: true });
    try {
      const res = await fetch('/api/collections/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId: draft.invoiceId, subject: draft.subject, body: draft.body, stage: draft.stage, aiDrafted: draft.aiUsed }),
      });
      const b = await res.json().catch(() => ({}));
      if (res.ok && b.sent) { addToast('success', `${draft.stageLabel || 'Reminder'} sent to ${b.to}`); setDraft(null); reload(); }
      else { addToast('error', b.error ?? 'Could not send the reminder.'); setDraft((d) => d && { ...d, sending: false }); }
    } catch {
      addToast('error', 'Could not reach the send service.'); setDraft((d) => d && { ...d, sending: false });
    }
  }

  async function savePromise() {
    if (!promiseModal) return;
    const amountCents = Math.round(parseFloat(promiseModal.amount) * 100);
    if (!(amountCents > 0)) { addToast('error', 'Enter a positive promised amount.'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(promiseModal.date)) { addToast('error', 'Enter a valid promise date.'); return; }
    setPromiseModal((p) => p && { ...p, saving: true });
    try {
      const res = await fetch('/api/collections/promise', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId: promiseModal.account.customerId, invoiceId: promiseModal.invoiceId,
          amountCents, promiseDate: promiseModal.date, note: promiseModal.note || null,
        }),
      });
      const b = await res.json().catch(() => ({}));
      if (res.ok && b.ok) { addToast('success', 'Promise to pay logged.'); setPromiseModal(null); reload(); }
      else { addToast('error', b.error ?? 'Could not log the promise.'); setPromiseModal((p) => p && { ...p, saving: false }); }
    } catch {
      addToast('error', 'Could not reach the service.'); setPromiseModal((p) => p && { ...p, saving: false });
    }
  }

  return (
    <div className={embedded ? '' : 'p-6'}>
      {/* Header — hidden when embedded in the Collections tab shell (which owns the page chrome). */}
      {!embedded && (
        <div className="mb-6">
          <Link href="/invoices" className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300 mb-1">
            <ArrowLeft className="w-3.5 h-3.5" /> Invoices &amp; AR
          </Link>
          <h1 className="text-2xl font-semibold text-white">Collections workflow</h1>
          <p className="text-sm text-slate-400 mt-1">Prioritized worklist, dunning cadence, and promise-to-pay tracking. AI drafts; you approve every send.</p>
        </div>
      )}

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <div className="relative">
          <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)}
            className="pl-9 pr-8 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white appearance-none cursor-pointer">
            <option value="">All companies</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none" />
        </div>
        <label className="inline-flex items-center gap-2 text-xs text-slate-400">
          As of
          <input type="date" value={asOf} max={today} onChange={(e) => setAsOf(e.target.value)}
            className="px-2.5 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white" />
        </label>
        {!embedded && (
          <Link href="/collections?tab=aging" className="text-xs text-slate-400 hover:text-emerald-300 ml-auto inline-flex items-center gap-1.5">
            View aging &amp; DSO <ChevronRight className="w-3.5 h-3.5" />
          </Link>
        )}
      </div>

      {error && (
        <div className="p-8 text-center">
          <AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" />
          <p className="text-red-400">Failed to load the collections worklist</p>
          <p className="text-sm text-slate-500 mt-1">{error}</p>
        </div>
      )}

      {isLoading && !data && (
        <div className="flex items-center justify-center py-24"><Loader2 className="w-6 h-6 text-emerald-400 animate-spin" /></div>
      )}

      {data && (
        <>
          {/* KPI strip */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-6">
            <Kpi icon={Wallet} color="text-red-400" label="Overdue AR" value={formatMoney(data.kpis.totalOverdueCents)} sub={`${data.kpis.accountsInWorklist} accounts`} />
            <Kpi icon={Target} color="text-indigo-300" label="Expected at-risk" value={formatMoney(data.kpis.totalExpectedValueAtRiskCents)} sub={`${data.kpis.predictedLateCount} predicted late`} />
            <Kpi icon={Send} color="text-emerald-400" label="Reminders due" value={String(data.kpis.remindersDueCount)} sub="cadence stage reached" />
            <Kpi icon={ShieldAlert} color="text-amber-300" label="Broken promises" value={String(data.kpis.brokenPromiseCount)} sub="need follow-up" />
            <Kpi icon={HandCoins} color="text-blue-400" label="Open AR (worklist)" value={formatMoney(data.kpis.totalOpenCents)} sub={`${data.accounts.length} customers`} />
          </div>

          {data.accounts.length === 0 ? (
            <div className="text-center py-16">
              <CheckCircle2 className="w-10 h-10 text-emerald-500/70 mx-auto mb-3" />
              <p className="text-slate-300 font-medium">Nothing to collect</p>
              <p className="text-sm text-slate-500 mt-1">No open receivables in this scope.</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-800">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 uppercase tracking-wider border-b border-slate-800 bg-slate-900/40">
                    <th className="py-2.5 px-4">Customer</th>
                    <th className="py-2.5 px-4">Risk</th>
                    <th className="py-2.5 px-4 text-right">Overdue</th>
                    <th className="py-2.5 px-4">Forecast pay</th>
                    <th className="py-2.5 px-4">Cadence</th>
                    <th className="py-2.5 px-4">Recommended action</th>
                    <th className="py-2.5 px-4 text-right">Do it</th>
                  </tr>
                </thead>
                <tbody>
                  {data.accounts.map((acc) => {
                    const key = acc.customerId ?? 'UNASSIGNED';
                    const open = expanded === key;
                    const { cls, Icon } = actionStyle(acc.recommendedAction.kind);
                    const canSend = acc.recommendedAction.stage != null && acc.focusInvoiceId != null;
                    return (
                      <React.Fragment key={key}>
                        <tr className="border-b border-slate-800/60 hover:bg-slate-800/20">
                          <td className="py-3 px-4">
                            <button onClick={() => setExpanded(open ? null : key)} className="inline-flex items-center gap-1.5 text-left">
                              {open ? <ChevronDown className="w-3.5 h-3.5 text-slate-500" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-500" />}
                              <span className="text-slate-200">{acc.customerName}</span>
                            </button>
                            <div className="flex items-center gap-2 mt-0.5 pl-5">
                              {acc.hasBrokenPromise && <span className="inline-flex items-center gap-1 text-[11px] text-amber-300"><Ban className="w-3 h-3" />{acc.brokenPromiseCount} broken promise{acc.brokenPromiseCount > 1 ? 's' : ''}</span>}
                              {acc.hasPendingPromise && acc.pendingPromise && <span className="inline-flex items-center gap-1 text-[11px] text-blue-300"><CalendarClock className="w-3 h-3" />promised {acc.pendingPromise.promiseDate}</span>}
                              {!acc.customerEmail && <span className="text-[11px] text-slate-600">no email on file</span>}
                            </div>
                          </td>
                          <td className="py-3 px-4">
                            <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] border ${RISK_BADGE[acc.riskLevel]}`}>{acc.riskLevel}</span>
                          </td>
                          <td className="py-3 px-4 text-right font-mono text-white tabular-nums">{formatMoney(acc.overdueBalanceCents)}
                            <div className="text-[11px] text-slate-500">{acc.overdueInvoiceCount} inv</div>
                          </td>
                          <td className="py-3 px-4">
                            {acc.focusPrediction ? (
                              <div className="text-xs">
                                <div className="flex items-center gap-1.5">
                                  <TrendingUp className="w-3 h-3 text-indigo-300" />
                                  <span className="font-mono text-slate-200">{acc.focusPrediction.predictedPayDate}</span>
                                </div>
                                <div className="flex items-center gap-2 mt-0.5">
                                  <span className={latenessChip(acc.focusPrediction.predictedDaysLate).cls}>{latenessChip(acc.focusPrediction.predictedDaysLate).text}</span>
                                  <span className={`text-[11px] ${CONF_STYLE[acc.focusPrediction.confidence].cls}`} title={acc.focusPrediction.rationale}>{CONF_STYLE[acc.focusPrediction.confidence].label} conf</span>
                                </div>
                                <div className="text-[11px] text-slate-600">oldest {acc.maxDaysOverdue}d</div>
                              </div>
                            ) : (
                              <div className="text-xs text-slate-500">
                                <span className="font-mono">{acc.maxDaysOverdue > 0 ? `${acc.maxDaysOverdue}d oldest` : '—'}</span>
                                <div className="text-[11px] text-slate-600">no pay history</div>
                              </div>
                            )}
                          </td>
                          <td className="py-3 px-4">
                            <div className="text-xs">
                              {acc.currentStage
                                ? <span className={`font-medium ${STAGE_TEXT[acc.currentStage]}`}>{STAGE_LABEL[acc.currentStage]}{acc.reminderDue && <span className="ml-1 text-emerald-400">• due</span>}</span>
                                : <span className="text-slate-500">grace</span>}
                              {acc.nextStep && (
                                <div className="text-[11px] text-slate-500 mt-0.5" title={acc.nextStep.reason}>
                                  <CalendarClock className="w-3 h-3 inline -mt-0.5 mr-0.5" />
                                  next: {acc.nextStep.stage.label} {acc.nextStep.isDueNow ? <span className="text-emerald-400">now</span> : `in ${acc.nextStep.daysUntil}d`}
                                </div>
                              )}
                            </div>
                          </td>
                          <td className="py-3 px-4">
                            <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs border ${cls}`} title={acc.recommendedAction.reason}>
                              <Icon className="w-3 h-3" /> {acc.recommendedAction.label}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-right whitespace-nowrap">
                            <div className="inline-flex items-center gap-2">
                              <button
                                onClick={() => acc.focusInvoiceId && openDraft(acc, acc.focusInvoiceId, acc.recommendedAction.stage ?? acc.currentStage)}
                                disabled={!canSend}
                                title={canSend ? 'Draft an AI reminder for review' : 'No overdue invoice at a cadence stage yet'}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed">
                                <Sparkles className="w-3 h-3" /> Draft
                              </button>
                              <button
                                onClick={() => setPromiseModal({ account: acc, invoiceId: acc.focusInvoiceId, amount: (acc.overdueBalanceCents / 100).toFixed(2), date: today, note: '', saving: false })}
                                title="Log a promise to pay"
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border border-slate-700 text-slate-300 hover:bg-slate-800">
                                <HandCoins className="w-3 h-3" /> Promise
                              </button>
                            </div>
                          </td>
                        </tr>
                        {open && (
                          <tr className="bg-slate-900/40">
                            <td colSpan={7} className="px-4 py-3">
                              <p className="text-xs text-slate-400 mb-2">{acc.riskSummary}</p>
                              <div className="space-y-1">
                                {acc.invoices.map((inv) => (
                                  <div key={inv.id} className="py-1.5 border-b border-slate-800/40 last:border-0">
                                    <div className="flex items-center gap-3 text-xs">
                                      <FileText className="w-3.5 h-3.5 text-slate-600" />
                                      <span className="font-mono text-slate-300 w-28">{inv.invoiceNumber}</span>
                                      <span className="font-mono text-white tabular-nums w-24 text-right">{formatMoney(inv.balanceCents)}</span>
                                      <span className={`w-20 text-right ${inv.daysOverdue > 0 ? 'text-red-300' : 'text-emerald-400'}`}>{inv.daysOverdue > 0 ? `${inv.daysOverdue}d late` : 'current'}</span>
                                      <span className="text-slate-500 w-28">due {inv.dueDate}</span>
                                      <span className="text-slate-500 flex-1">{inv.lastReminderAt ? `last reminded ${fmtWhen(inv.lastReminderAt)}${inv.reminderCount > 1 ? ` ·×${inv.reminderCount}` : ''}${inv.lastStageSent ? ` (${STAGE_LABEL[inv.lastStageSent]})` : ''}` : 'never reminded'}</span>
                                      {inv.daysOverdue > 0 && (
                                        <button onClick={() => openDraft(acc, inv.id, null)}
                                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-emerald-300 hover:bg-emerald-500/10">
                                          <Sparkles className="w-3 h-3" /> draft
                                        </button>
                                      )}
                                      <button onClick={() => setPromiseModal({ account: acc, invoiceId: inv.id, amount: (inv.balanceCents / 100).toFixed(2), date: today, note: '', saving: false })}
                                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-slate-400 hover:bg-slate-800">
                                        <HandCoins className="w-3 h-3" /> promise
                                      </button>
                                    </div>
                                    {(inv.prediction || inv.nextStep) && (
                                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1 pl-6 text-[11px] text-slate-500">
                                        {inv.prediction && (
                                          <span title={inv.prediction.rationale}>
                                            <TrendingUp className="w-3 h-3 inline -mt-0.5 mr-1 text-indigo-300" />
                                            forecast pay {inv.prediction.predictedPayDate} · <span className={latenessChip(inv.prediction.predictedDaysLate).cls}>{latenessChip(inv.prediction.predictedDaysLate).text}</span> · <span className={CONF_STYLE[inv.prediction.confidence].cls}>{CONF_STYLE[inv.prediction.confidence].label} conf</span>
                                          </span>
                                        )}
                                        {inv.nextStep && (
                                          <span title={inv.nextStep.reason}>
                                            <CalendarClock className="w-3 h-3 inline -mt-0.5 mr-1" />
                                            next: {inv.nextStep.stage.label} {inv.nextStep.isDueNow ? 'now' : `in ${inv.nextStep.daysUntil}d (${inv.nextStep.scheduledDate})`}
                                          </span>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                ))}
                                {acc.promises.filter((p) => p.status !== 'KEPT').length > 0 && (
                                  <div className="pt-2 mt-1">
                                    {acc.promises.filter((p) => p.status !== 'KEPT').map((p) => (
                                      <div key={p.id} className="flex items-center gap-2 text-[11px] py-0.5">
                                        {p.status === 'BROKEN' ? <Ban className="w-3 h-3 text-amber-300" /> : <CalendarClock className="w-3 h-3 text-blue-300" />}
                                        <span className={p.status === 'BROKEN' ? 'text-amber-300' : 'text-blue-300'}>
                                          {p.status === 'BROKEN' ? 'Broken promise' : 'Pending promise'}: {formatMoney(p.amountCents)} by {p.promiseDate}
                                        </span>
                                        {p.note && <span className="text-slate-500">— {p.note}</span>}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Draft review modal */}
      {draft && (
        <Modal onClose={() => !draft.sending && setDraft(null)} title="Review reminder before sending">
          {draft.loading ? (
            <div className="py-16 flex flex-col items-center gap-2 text-slate-400">
              <Loader2 className="w-6 h-6 animate-spin text-emerald-400" /><span className="text-sm">Drafting…</span>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className={`px-2 py-0.5 rounded-full border ${draft.stage ? RISK_BADGE.medium : RISK_BADGE.low}`}>{draft.stageLabel || 'Reminder'}</span>
                <span className="text-slate-500">{draft.daysOverdue}d overdue · {formatMoney(draft.balanceCents)} due</span>
                {draft.aiUsed
                  ? <span className="inline-flex items-center gap-1 text-indigo-300"><Sparkles className="w-3 h-3" /> AI-drafted</span>
                  : <span className="text-slate-500">template</span>}
              </div>
              <p className="text-xs text-slate-400">
                To: <span className="text-slate-200">{draft.customerName}</span>{draft.customerEmail ? ` <${draft.customerEmail}>` : ' — no email on file'}
              </p>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Subject</label>
                <input value={draft.subject} onChange={(e) => setDraft((d) => d && { ...d, subject: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white" />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Message</label>
                <textarea value={draft.body} onChange={(e) => setDraft((d) => d && { ...d, body: e.target.value })} rows={12}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white font-mono leading-relaxed" />
              </div>
              <div className="flex items-center justify-between gap-2 pt-1">
                {draft.fallback && (
                  <button onClick={() => setDraft((d) => d && d.fallback ? { ...d, subject: d.fallback.subject, body: d.fallback.body, aiUsed: false } : d)}
                    className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-white">
                    <RefreshCw className="w-3 h-3" /> Reset to template
                  </button>
                )}
                <div className="flex items-center gap-2 ml-auto">
                  <button onClick={() => setDraft(null)} disabled={draft.sending} className="px-3 py-2 text-sm text-slate-400 hover:text-white">Cancel</button>
                  <button onClick={sendDraft} disabled={draft.sending || !draft.customerEmail}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed">
                    {draft.sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                    {draft.sending ? 'Sending…' : 'Approve & send'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </Modal>
      )}

      {/* Promise-to-pay modal */}
      {promiseModal && (
        <Modal onClose={() => !promiseModal.saving && setPromiseModal(null)} title="Log a promise to pay">
          <div className="space-y-4">
            <p className="text-xs text-slate-400">Customer: <span className="text-slate-200">{promiseModal.account.customerName}</span></p>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Against invoice</label>
              <select value={promiseModal.invoiceId ?? ''} onChange={(e) => setPromiseModal((p) => p && { ...p, invoiceId: e.target.value || null })}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white">
                <option value="">Account-wide (no specific invoice)</option>
                {promiseModal.account.invoices.map((inv) => (
                  <option key={inv.id} value={inv.id}>{inv.invoiceNumber} — {formatMoney(inv.balanceCents)}{inv.daysOverdue > 0 ? ` (${inv.daysOverdue}d late)` : ''}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Amount ($)</label>
                <input value={promiseModal.amount} onChange={(e) => setPromiseModal((p) => p && { ...p, amount: e.target.value })} inputMode="decimal"
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white font-mono" />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Promised by</label>
                <input type="date" value={promiseModal.date} onChange={(e) => setPromiseModal((p) => p && { ...p, date: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white" />
              </div>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Note (optional)</label>
              <input value={promiseModal.note} onChange={(e) => setPromiseModal((p) => p && { ...p, note: e.target.value })} placeholder="e.g. spoke with AP, check mailed Friday"
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white" />
            </div>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button onClick={() => setPromiseModal(null)} disabled={promiseModal.saving} className="px-3 py-2 text-sm text-slate-400 hover:text-white">Cancel</button>
              <button onClick={savePromise} disabled={promiseModal.saving}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40">
                {promiseModal.saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <HandCoins className="w-4 h-4" />}
                Log promise
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Small components ─────────────────────────────────────────────────────────

function Kpi({ icon: Icon, color, label, value, sub }: {
  icon: React.ComponentType<{ className?: string }>; color: string; label: string; value: string; sub: string;
}) {
  return (
    <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-slate-400">{label}</span>
        <Icon className={`w-4 h-4 ${color}`} />
      </div>
      <p className="text-xl font-mono font-semibold text-white tabular-nums">{value}</p>
      <p className="text-xs text-slate-500 mt-1">{sub}</p>
    </div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div className="w-full max-w-lg bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <h3 className="text-sm font-semibold text-white">{title}</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
