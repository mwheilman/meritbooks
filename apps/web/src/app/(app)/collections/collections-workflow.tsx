'use client';

import React, { useMemo, useState } from 'react';
import {
  Button,
  ButtonLink,
  Conf,
  Dialog,
  Eyebrow,
  Field,
  Icon,
  InlineNotice,
  Input,
  Keybar,
  Meter,
  Pip,
  Select,
  Status,
  Tag,
  Textarea,
  countStrokes,
  cx,
  useHotkey,
  useListKeynav,
  type PipKind,
  type StatusKind,
} from '@meritbooks/merit-ui';
import { useQuery, addToast } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { EmptyState, PageHeader, TableSkeleton } from '@/components/ui';
import s from './collections.module.css';

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

// ─── Look maps (status is never colour alone: pip shape + word) ─────────────

const RISK_STATUS: Record<RiskLevel, { kind: StatusKind; word: string }> = {
  low: { kind: 'track', word: 'Low' },
  medium: { kind: 'risk', word: 'Medium' },
  high: { kind: 'overdue', word: 'High' },
};
const STAGE_LABEL: Record<StageKey, string> = {
  FIRST_NOTICE: 'First notice', SECOND_NOTICE: 'Second notice', THIRD_NOTICE: 'Third notice', FINAL_NOTICE: 'Final notice',
};
const STAGE_ORDER: StageKey[] = ['FIRST_NOTICE', 'SECOND_NOTICE', 'THIRD_NOTICE', 'FINAL_NOTICE'];
const ACTION_PIP: Record<ActionKind, PipKind> = {
  AWAIT_PROMISE: 'open',
  CALL_BROKEN_PROMISE: 'risk',
  ESCALATE: 'blocked',
  MONITOR: 'closed',
  SEND_FIRST_NOTICE: 'soft',
  SEND_SECOND_NOTICE: 'soft',
  SEND_THIRD_NOTICE: 'risk',
  SEND_FINAL_NOTICE: 'overdue',
};
const fmtWhen = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null;

const CONF_WORD: Record<PredConfidence, string> = { high: 'High', medium: 'Medium', low: 'Low' };

function lateness(daysLate: number): { pip: PipKind; text: string } {
  if (daysLate > 0) return { pip: 'overdue', text: `~${daysLate}d late` };
  if (daysLate === 0) return { pip: 'risk', text: 'on the due date' };
  return { pip: 'ready', text: `~${-daysLate}d early` };
}

function Lateness({ daysLate }: { daysLate: number }) {
  const l = lateness(daysLate);
  return (
    <span className="mb-sev">
      <Pip kind={l.pip} />
      {l.text}
    </span>
  );
}

function PredConf({ p }: { p: PayPrediction }) {
  const score = Math.round(p.confidenceScore * 100);
  return (
    <span title={p.rationale}>
      <Conf score={score} label={`${CONF_WORD[p.confidence]} forecast confidence, ${score} of 100`} />
    </span>
  );
}

const keyOf = (a: WlAccount) => a.customerId ?? 'UNASSIGNED';

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
  // The account whose detail is open in the side panel (formerly the expanded row).
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

  const draftFor = (acc: WlAccount) => {
    if (acc.recommendedAction.stage == null || acc.focusInvoiceId == null) return;
    void openDraft(acc, acc.focusInvoiceId, acc.recommendedAction.stage ?? acc.currentStage);
  };
  const promiseFor = (acc: WlAccount, invoiceId: string | null = acc.focusInvoiceId, cents = acc.overdueBalanceCents) =>
    setPromiseModal({ account: acc, invoiceId, amount: (cents / 100).toFixed(2), date: today, note: '', saving: false });

  const accounts = useMemo(() => data?.accounts ?? [], [data]);
  const toggleExpanded = (acc: WlAccount) => {
    const k = keyOf(acc);
    setExpanded((cur) => (cur === k ? null : k));
  };

  // Keyboard (one registry): J/K move · Enter shows or hides the account · D drafts · P logs a promise.
  const keysOn = !draft && !promiseModal && accounts.length > 0;
  const { activeIndex, setActiveIndex, rowProps } = useListKeynav({
    count: accounts.length,
    onOpen: (i) => { const acc = accounts[i]; if (acc) toggleExpanded(acc); },
    onAction: (i) => { const acc = accounts[i]; if (acc) draftFor(acc); },
    actionKey: 'd',
    enabled: keysOn,
    owner: 'Collections worklist',
  });
  useHotkey(
    'p',
    () => {
      const acc = activeIndex >= 0 ? accounts[activeIndex] : undefined;
      if (!acc) return false;
      promiseFor(acc);
      return true;
    },
    { enabled: keysOn, owner: 'Collections worklist', description: 'Log a promise to pay' },
  );

  const loadingFirst = isLoading && !data;
  const kpis = data?.kpis;
  const figures: ReadonlyArray<{ label: string; value: string; sub: string }> = kpis
    ? [
        { label: 'Overdue AR', value: formatMoney(kpis.totalOverdueCents), sub: `${kpis.accountsInWorklist} accounts` },
        { label: 'Expected at risk', value: formatMoney(kpis.totalExpectedValueAtRiskCents), sub: `${kpis.predictedLateCount} predicted late` },
        { label: 'Reminders due', value: String(kpis.remindersDueCount), sub: 'cadence stage reached' },
        { label: 'Broken promises', value: String(kpis.brokenPromiseCount), sub: 'need a follow-up call' },
        { label: 'Open AR (worklist)', value: formatMoney(kpis.totalOpenCents), sub: `${accounts.length} customers` },
      ]
    : ['Overdue AR', 'Expected at risk', 'Reminders due', 'Broken promises', 'Open AR (worklist)'].map((label) => ({ label, value: '', sub: '' }));

  return (
    <div className={s.stack}>
      {/* Header — hidden when embedded in the Collections tab shell (which owns the page chrome). */}
      {!embedded && (
        <PageHeader
          eyebrow={['Receivables', 'Invoices & AR']}
          title="Collections workflow"
          description="Prioritized worklist, notice cadence, and promise-to-pay tracking. AI drafts; you approve every send."
          actions={<ButtonLink href="/invoices" variant="quiet" icon="left">Invoices &amp; AR</ButtonLink>}
        />
      )}

      {/* Controls */}
      <div className={s.toolbar}>
        <Select
          aria-label="Filter the worklist by company"
          className={s.companySelect}
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
        >
          <option value="">All companies</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </Select>
        <label className={s.inline}>
          <span className="t-cap">As of</span>
          <Input type="date" value={asOf} max={today} onChange={(e) => setAsOf(e.target.value)} aria-label="As of date" />
        </label>
        <div className={s.grow} />
        {!embedded && (
          <ButtonLink href="/collections?tab=aging" variant="quiet" iconAfter="right">View aging &amp; DSO</ButtonLink>
        )}
      </div>

      {error ? (
        <div className={s.state} role="alert">
          <Tag tone="neg">Not loaded</Tag>
          <p className="t-head">Couldn&apos;t load the collections worklist.</p>
          <p className="ink-2">{error}</p>
          <Button onClick={reload}>Try again</Button>
        </div>
      ) : (
        <>
          {/* Figure strip */}
          <div className={s.figs} aria-busy={loadingFirst || undefined}>
            {figures.map((f) => (
              <div key={f.label} className="fig">
                <span className="fig-l">{f.label}</span>
                {loadingFirst ? (
                  <span className={cx('mb-skel', s.figSkel)} aria-hidden="true" />
                ) : (
                  <span className="fig-v fig-v--dense tnum">{f.value}</span>
                )}
                <span className="fig-vs"><span className="tnum">{loadingFirst ? '—' : f.sub}</span></span>
              </div>
            ))}
          </div>

          {loadingFirst ? (
            <TableSkeleton rows={6} cols={7} />
          ) : accounts.length === 0 ? (
            <EmptyState
              title="Nothing to collect"
              description="No open receivables in this scope. Pick another company or an earlier as-of date."
            />
          ) : (
            <div>
              <div className={s.tableWrap}>
                <table className="tbl tbl-q" aria-label="Collections worklist, highest priority first">
                  <colgroup>
                    <col />
                    <col style={{ width: 96 }} />
                    <col style={{ width: 120 }} />
                    <col style={{ width: 184 }} />
                    <col style={{ width: 184 }} />
                    <col style={{ width: 176 }} />
                    <col style={{ width: 168 }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th scope="col">Customer</th>
                      <th scope="col">Risk</th>
                      <th scope="col" className="n">Overdue</th>
                      <th scope="col">Forecast pay</th>
                      <th scope="col">Cadence</th>
                      <th scope="col">Next best action</th>
                      <th scope="col" className="n"><span className="sr">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map((acc, i) => {
                      const key = keyOf(acc);
                      const isOpen = expanded === key;
                      const canSend = acc.recommendedAction.stage != null && acc.focusInvoiceId != null;
                      const { ref, 'data-active': active } = rowProps(i);
                      const idx = acc.currentStage ? STAGE_ORDER.indexOf(acc.currentStage) : -1;
                      return (
                        <React.Fragment key={key}>
                          <tr
                            ref={ref}
                            className={cx('q-row', active && 'is-cursor', (acc.riskLevel === 'high' || acc.hasBrokenPromise) && 'is-attn')}
                            aria-current={active ? 'true' : undefined}
                            onClick={(e) => {
                              setActiveIndex(i);
                              if ((e.target as HTMLElement).closest('button,a,input,select,textarea')) return;
                              toggleExpanded(acc);
                            }}
                            style={{ cursor: 'pointer' }}
                          >
                            <td>
                              <button type="button" className={s.toggle} onClick={() => { setActiveIndex(i); toggleExpanded(acc); }} aria-expanded={isOpen}>
                                <Icon name={isOpen ? 'down' : 'right'} />
                                <span className="l1">{acc.customerName}</span>
                              </button>
                              {(acc.hasBrokenPromise || (acc.hasPendingPromise && acc.pendingPromise) || !acc.customerEmail) && (
                                <span className={cx(s.sub, s.indent)}>
                                  {acc.hasBrokenPromise && (
                                    <span className="mb-sev"><Pip kind="risk" />{acc.brokenPromiseCount} broken promise{acc.brokenPromiseCount > 1 ? 's' : ''}</span>
                                  )}
                                  {acc.hasPendingPromise && acc.pendingPromise && (
                                    <span className="mb-sev"><Pip kind="open" />Promised {acc.pendingPromise.promiseDate}</span>
                                  )}
                                  {!acc.customerEmail && <span>No email on file</span>}
                                </span>
                              )}
                            </td>
                            <td><Status kind={RISK_STATUS[acc.riskLevel].kind}>{RISK_STATUS[acc.riskLevel].word}</Status></td>
                            <td className="n">
                              <span className="l1 tnum">{formatMoney(acc.overdueBalanceCents)}</span>
                              <span className="l2 tnum">{acc.overdueInvoiceCount} inv{acc.focusPrediction && acc.maxDaysOverdue > 0 ? ` · oldest ${acc.maxDaysOverdue}d` : ''}</span>
                            </td>
                            <td>
                              {acc.focusPrediction ? (
                                <>
                                  <span className="l1 tnum">{acc.focusPrediction.predictedPayDate}</span>
                                  <span className={s.sub}>
                                    <Lateness daysLate={acc.focusPrediction.predictedDaysLate} />
                                    <PredConf p={acc.focusPrediction} />
                                  </span>
                                </>
                              ) : (
                                <>
                                  <span className="l1 tnum ink-2">{acc.maxDaysOverdue > 0 ? `${acc.maxDaysOverdue}d oldest` : '—'}</span>
                                  <span className="l2">No pay history</span>
                                </>
                              )}
                            </td>
                            <td>
                              <span className={s.cadence}>
                                <Meter
                                  strokes={countStrokes(4, idx + 1)}
                                  label={acc.currentStage ? `${STAGE_LABEL[acc.currentStage]} sent, ${idx + 1} of 4` : 'In grace, no notice sent'}
                                />
                                <span className="l1">{acc.currentStage ? STAGE_LABEL[acc.currentStage] : 'Grace'}</span>
                                {acc.reminderDue && <Tag tone="warn">Due</Tag>}
                              </span>
                              {acc.nextStep && (
                                <span className="l2" title={acc.nextStep.reason}>
                                  Next: {acc.nextStep.stage.label} {acc.nextStep.isDueNow ? 'now' : `in ${acc.nextStep.daysUntil}d`}
                                </span>
                              )}
                            </td>
                            <td>
                              <span className="mb-sev" title={acc.recommendedAction.reason}>
                                <Pip kind={ACTION_PIP[acc.recommendedAction.kind] ?? 'soft'} />
                                <span className="mb-trunc">{acc.recommendedAction.label}</span>
                              </span>
                            </td>
                            <td className="n">
                              <span className={s.rowActs}>
                                <Button
                                  onClick={() => draftFor(acc)}
                                  disabled={!canSend}
                                  title={canSend ? 'Draft an AI reminder for review' : 'No overdue invoice at a cadence stage yet'}
                                >
                                  Draft
                                </Button>
                                <Button variant="quiet" onClick={() => promiseFor(acc)} title="Log a promise to pay">
                                  Promise
                                </Button>
                              </span>
                            </td>
                          </tr>
                          {isOpen && (
                            <tr className={s.detailRow}>
                              <td colSpan={7}>
                                <AccountDetail
                                  acc={acc}
                                  onDraft={(invoiceId, stage) => void openDraft(acc, invoiceId, stage)}
                                  onPromise={(invoiceId, cents) => promiseFor(acc, invoiceId, cents)}
                                />
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Keybar
                hints={[
                  { chord: 'j k', label: 'Move' },
                  { chord: 'enter', label: 'Show or hide details' },
                  { chord: 'd', label: 'Draft reminder' },
                  { chord: 'p', label: 'Log promise' },
                ]}
                note="Nothing is sent until you approve it."
              />
            </div>
          )}
        </>
      )}
      {/* Draft review dialog */}
      <Dialog
        open={!!draft}
        onClose={() => { if (!draft?.sending) setDraft(null); }}
        title="Review reminder before sending"
        width={640}
        dismissOnScrim={false}
        footNote={
          draft && !draft.loading && draft.fallback ? (
            <Button
              variant="quiet"
              icon="undo"
              onClick={() => setDraft((d) => d && d.fallback ? { ...d, subject: d.fallback.subject, body: d.fallback.body, aiUsed: false } : d)}
            >
              Reset to template
            </Button>
          ) : undefined
        }
        actions={
          <>
            <Button onClick={() => setDraft(null)} disabled={draft?.sending}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => void sendDraft()}
              disabled={!draft || draft.loading || draft.sending || !draft.customerEmail}
              title={draft && !draft.customerEmail ? 'No email on file for this customer' : undefined}
            >
              {draft?.sending ? 'Sending…' : 'Approve & send'}
            </Button>
          </>
        }
      >
        {draft && (draft.loading ? (
          <div className={s.drafting} aria-busy="true">
            <span className="mb-skel" style={{ width: '60%' }} aria-hidden="true" />
            <span className="mb-skel" style={{ width: '90%' }} aria-hidden="true" />
            <span className="mb-skel" style={{ width: '80%' }} aria-hidden="true" />
            <span className="t-cap" role="status">Drafting the reminder…</span>
          </div>
        ) : (
          <div className={s.dialogStack}>
            <div className={s.draftMeta}>
              <Tag tone={draft.stage ? 'warn' : 'default'}>{draft.stageLabel || 'Reminder'}</Tag>
              <span className="t-cap tnum">{draft.daysOverdue}d overdue · {formatMoney(draft.balanceCents)} due</span>
              {draft.aiUsed ? <Tag tone="ai">AI draft</Tag> : <Tag>Template</Tag>}
            </div>
            <p className="ink-2">
              To: <b>{draft.customerName}</b>{draft.customerEmail ? ` <${draft.customerEmail}>` : ''}
            </p>
            {!draft.customerEmail && (
              <InlineNotice tone="warn" title="No email on file.">Add one on the customer record to send this notice.</InlineNotice>
            )}
            <Field label="Subject">
              <Input value={draft.subject} onChange={(e) => setDraft((d) => d && { ...d, subject: e.target.value })} />
            </Field>
            <Field label="Message">
              <Textarea
                className={s.message}
                value={draft.body}
                onChange={(e) => setDraft((d) => d && { ...d, body: e.target.value })}
                rows={12}
              />
            </Field>
          </div>
        ))}
      </Dialog>

      {/* Promise-to-pay dialog */}
      <Dialog
        open={!!promiseModal}
        onClose={() => { if (!promiseModal?.saving) setPromiseModal(null); }}
        title="Log a promise to pay"
        actions={
          <>
            <Button onClick={() => setPromiseModal(null)} disabled={promiseModal?.saving}>Cancel</Button>
            <Button variant="primary" onClick={() => void savePromise()} disabled={promiseModal?.saving}>
              {promiseModal?.saving ? 'Logging…' : 'Log promise'}
            </Button>
          </>
        }
      >
        {promiseModal && (
          <div className={s.dialogStack}>
            <p className="ink-2">Customer: <b>{promiseModal.account.customerName}</b></p>
            <Field label="Against invoice">
              <Select
                value={promiseModal.invoiceId ?? ''}
                onChange={(e) => setPromiseModal((p) => p && { ...p, invoiceId: e.target.value || null })}
              >
                <option value="">Account-wide (no specific invoice)</option>
                {promiseModal.account.invoices.map((inv) => (
                  <option key={inv.id} value={inv.id}>{inv.invoiceNumber} — {formatMoney(inv.balanceCents)}{inv.daysOverdue > 0 ? ` (${inv.daysOverdue}d late)` : ''}</option>
                ))}
              </Select>
            </Field>
            <div className={s.two}>
              <Field label="Amount ($)">
                <Input
                  value={promiseModal.amount}
                  onChange={(e) => setPromiseModal((p) => p && { ...p, amount: e.target.value })}
                  inputMode="decimal"
                  className="tnum"
                  data-autofocus
                />
              </Field>
              <Field label="Promised by">
                <Input type="date" value={promiseModal.date} onChange={(e) => setPromiseModal((p) => p && { ...p, date: e.target.value })} />
              </Field>
            </div>
            <Field label="Note (optional)">
              <Input
                value={promiseModal.note}
                onChange={(e) => setPromiseModal((p) => p && { ...p, note: e.target.value })}
                placeholder="e.g. Spoke with AP, check mailed Friday"
              />
            </Field>
          </div>
        )}
      </Dialog>
    </div>
  );
}

// ─── Account detail (the expanded row) ───────────────────────────────────────

function AccountDetail({ acc, onDraft, onPromise }: {
  acc: WlAccount;
  onDraft: (invoiceId: string, stage: StageKey | null) => void;
  onPromise: (invoiceId: string | null, cents: number) => void;
}) {
  const openPromises = acc.promises.filter((p) => p.status !== 'KEPT');
  return (
    <div className={s.detail}>
      <section className={s.why} aria-label="Why this action is next">
        <Eyebrow>Why this is next</Eyebrow>
        <span className="mb-sev">
          <Pip kind={ACTION_PIP[acc.recommendedAction.kind] ?? 'soft'} />
          {acc.recommendedAction.label}
        </span>
        <p className="ink-2">{acc.recommendedAction.reason}</p>
        {acc.riskSummary && <p className="t-cap">{acc.riskSummary}</p>}
        {acc.riskFlags.length > 0 && (
          <span className={s.tags}>
            {acc.riskFlags.map((f) => <Tag key={f}>{f}</Tag>)}
          </span>
        )}
      </section>

      <section aria-label="Open invoices">
        <Eyebrow>{['Open invoices', String(acc.invoices.length)]}</Eyebrow>
        <ul className={s.list}>
          {acc.invoices.map((inv) => (
            <li key={inv.id}>
              <div className={s.invHead}>
                <span className="l1 tnum">{inv.invoiceNumber}</span>
                <span className="tnum b">{formatMoney(inv.balanceCents)}</span>
              </div>
              <span className={cx(s.sub, s.subWrap)}>
                {inv.daysOverdue > 0 ? (
                  <Status kind="overdue">{inv.daysOverdue}d late</Status>
                ) : (
                  <Status kind="track">Current</Status>
                )}
                <span className="tnum">due {inv.dueDate}</span>
                <span>
                  {inv.lastReminderAt
                    ? `last reminded ${fmtWhen(inv.lastReminderAt)}${inv.reminderCount > 1 ? ` ×${inv.reminderCount}` : ''}${inv.lastStageSent ? ` (${STAGE_LABEL[inv.lastStageSent]})` : ''}`
                    : 'never reminded'}
                </span>
              </span>
              {inv.prediction && (
                <span className={cx(s.sub, s.subWrap)} title={inv.prediction.rationale}>
                  <span className="tnum">Forecast pay {inv.prediction.predictedPayDate}</span>
                  <Lateness daysLate={inv.prediction.predictedDaysLate} />
                  <PredConf p={inv.prediction} />
                </span>
              )}
              {inv.nextStep && (
                <span className={cx(s.sub, s.subWrap)} title={inv.nextStep.reason}>
                  Next: {inv.nextStep.stage.label} {inv.nextStep.isDueNow ? 'now' : `in ${inv.nextStep.daysUntil}d (${inv.nextStep.scheduledDate})`}
                </span>
              )}
              <div className={s.invActs}>
                {inv.daysOverdue > 0 && (
                  <Button variant="quiet" onClick={() => onDraft(inv.id, null)}>Draft reminder</Button>
                )}
                <Button variant="quiet" onClick={() => onPromise(inv.id, inv.balanceCents)}>Log promise</Button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Promises to pay">
        <Eyebrow>{['Promises to pay', String(openPromises.length)]}</Eyebrow>
        {openPromises.length === 0 ? (
          <p className="t-cap" style={{ marginTop: 8 }}>No open promises. Log one when the customer commits to a date.</p>
        ) : (
          <ul className={s.list}>
            {openPromises.map((p) => (
              <li key={p.id} className={s.promise}>
                {p.status === 'BROKEN' ? <Status kind="overdue">Broken</Status> : <Status kind="track" pip="open">Pending</Status>}
                <span className="tnum">{formatMoney(p.amountCents)} by {p.promiseDate}</span>
                {p.note && <span className="t-cap">— {p.note}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
