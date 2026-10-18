'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  Bot,
  Loader2,
  Play,
  ShieldCheck,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleX,
  Cpu,
  Hand,
  Sparkles,
  ChevronRight,
  AlertTriangle,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, addToast } from '@/hooks';
import { api } from '@/lib/api-client';

// ── Shapes (mirror lib/agents/types AgentRunView / AgentStepView) ─────────────
type StepKind = 'AUTO' | 'PROPOSE' | 'HUMAN_GATE';
type StepStatus = 'PENDING' | 'RUNNING' | 'WAITING' | 'DONE' | 'REJECTED' | 'FAILED' | 'SKIPPED';
type RunStatus = 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

interface StepView {
  index: number;
  name: string;
  label: string;
  kind: StepKind;
  status: StepStatus;
  disposition: string | null;
  summary: string | null;
  output: Record<string, unknown>;
  aiDecisionId: string | null;
  gatePrompt: string | null;
  actedByUser: string | null;
  startedAt: string | null;
  endedAt: string | null;
}
interface RunView {
  id: string;
  recipe: string;
  recipeLabel: string;
  feature: string | null;
  title: string;
  status: RunStatus;
  currentStepIndex: number;
  subjectTable: string | null;
  subjectId: string | null;
  context: Record<string, unknown>;
  pausedReason: string | null;
  error: string | null;
  createdByUser: string | null;
  createdAt: string;
  updatedAt: string;
  steps: StepView[];
  persisted: boolean;
}
interface RecipeSummary {
  key: string;
  label: string;
  description: string;
  feature: string | null;
  steps: Array<{ name: string; label: string; kind: StepKind }>;
}

// ── Presentational helpers ────────────────────────────────────────────────────
function runTone(s: RunStatus): string {
  switch (s) {
    case 'COMPLETED': return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30';
    case 'PAUSED': return 'text-amber-400 bg-amber-500/10 border-amber-500/30';
    case 'RUNNING': return 'text-blue-400 bg-blue-500/10 border-blue-500/30';
    case 'FAILED': return 'text-red-400 bg-red-500/10 border-red-500/30';
    default: return 'text-slate-400 bg-slate-500/10 border-slate-500/30';
  }
}
function StepIcon({ status }: { status: StepStatus }) {
  const cls = 'h-4 w-4';
  switch (status) {
    case 'DONE': return <CircleCheck className={clsx(cls, 'text-emerald-400')} />;
    case 'WAITING': return <CirclePause className={clsx(cls, 'text-amber-400')} />;
    case 'RUNNING': return <Loader2 className={clsx(cls, 'text-blue-400 animate-spin')} />;
    case 'FAILED': return <CircleX className={clsx(cls, 'text-red-400')} />;
    case 'REJECTED': return <CircleX className={clsx(cls, 'text-red-400')} />;
    default: return <CircleDashed className={clsx(cls, 'text-slate-600')} />;
  }
}
function KindBadge({ kind }: { kind: StepKind }) {
  const map: Record<StepKind, { label: string; cls: string; icon: JSX.Element }> = {
    AUTO: { label: 'Auto', cls: 'text-slate-300 bg-slate-700/40 border-slate-600/40', icon: <Cpu className="h-3 w-3" /> },
    PROPOSE: { label: 'AI Proposes', cls: 'text-indigo-300 bg-indigo-500/10 border-indigo-500/30', icon: <Sparkles className="h-3 w-3" /> },
    HUMAN_GATE: { label: 'Human Gate', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30', icon: <Hand className="h-3 w-3" /> },
  };
  const m = map[kind];
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium', m.cls)}>
      {m.icon}{m.label}
    </span>
  );
}

export function AgentsClient() {
  const { data, isLoading, error, refetch } = useQuery<{ data: { runs: RunView[]; recipes: RecipeSummary[] } }>('/api/agents');
  const runs = data?.data.runs ?? [];
  const recipes = data?.data.recipes ?? [];

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [billId, setBillId] = useState('');
  const [starting, setStarting] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [note, setNote] = useState('');

  const selected = useMemo(
    () => runs.find((r) => r.id === selectedId) ?? runs[0] ?? null,
    [runs, selectedId],
  );

  const start = useCallback(async () => {
    const id = billId.trim();
    if (!id) { addToast('error', 'Enter the bill_id of an intaken bill to run the agent on.'); return; }
    setStarting(true);
    const res = await api.post<{ data: RunView }>('/api/agents/start', { recipe: 'AP_INTAKE', input: { bill_id: id } });
    setStarting(false);
    if (res.error) { addToast('error', res.error.error); return; }
    addToast('success', 'Agent started.');
    setBillId('');
    if (res.data?.data) setSelectedId(res.data.data.id);
    refetch();
  }, [billId, refetch]);

  const advance = useCallback(async (decision: 'APPROVE' | 'REJECT') => {
    if (!selected) return;
    setAdvancing(true);
    const res = await api.post<{ data: RunView }>(`/api/agents/${selected.id}/advance`, { decision, note: note.trim() || null });
    setAdvancing(false);
    if (res.error) { addToast('error', res.error.error); return; }
    addToast('success', decision === 'APPROVE' ? 'Gate approved — agent continued.' : 'Gate rejected — agent stopped.');
    setNote('');
    refetch();
  }, [selected, note, refetch]);

  const waitingStep = selected?.steps.find((s) => s.status === 'WAITING') ?? null;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white flex items-center gap-2">
            <Bot className="h-6 w-6 text-emerald-400" /> Supervised Agents
          </h1>
          <p className="text-sm text-slate-400 mt-1 max-w-2xl">
            Agents chain the steps you already trust and <span className="text-slate-200">stop at every human gate</span>.
            An agent never posts money or hits the GL — it proposes, and the existing gated engines post only after a human approves.
          </p>
        </div>
        <div className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-300">
          <ShieldCheck className="h-4 w-4" /> Approval-gated by design
        </div>
      </div>

      {/* Start panel */}
      <div className="rounded-xl border border-slate-800 bg-surface-900 p-5">
        <div className="flex items-center gap-2 mb-3">
          <Play className="h-4 w-4 text-emerald-400" />
          <h2 className="text-sm font-semibold text-white">Run the AP Invoice Intake agent</h2>
        </div>
        <p className="text-xs text-slate-500 mb-4">
          Reads an already-intaken bill, proposes its GL coding (M10 dial-governed), routes it to the approval workflow,
          and hands the <span className="text-slate-300">approved</span> bill to the existing posting path. Provide the bill&apos;s id.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <input
            value={billId}
            onChange={(e) => setBillId(e.target.value)}
            placeholder="bill_id (uuid of a PENDING / ON_HOLD bill)"
            className="flex-1 min-w-[280px] rounded-lg border border-slate-700 bg-surface-950 px-3 py-2 text-sm text-white font-mono placeholder:text-slate-600 focus:border-emerald-500/50 focus:outline-none"
          />
          <button
            onClick={start}
            disabled={starting}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Start agent
          </button>
        </div>
        {recipes.map((r) => (
          <div key={r.key} className="mt-4 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
            <span className="text-slate-400 font-medium">{r.label}:</span>
            {r.steps.map((s, i) => (
              <span key={s.name} className="inline-flex items-center gap-2">
                <KindBadge kind={s.kind} />
                <span className="text-slate-400">{s.label}</span>
                {i < r.steps.length - 1 && <ChevronRight className="h-3 w-3 text-slate-700" />}
              </span>
            ))}
          </div>
        ))}
      </div>

      {/* Body: list + detail */}
      <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-6">
        {/* Run list */}
        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 px-1">Run history</h3>
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-slate-500 p-4"><Loader2 className="h-4 w-4 animate-spin" /> Loading runs…</div>
          ) : error ? (
            <div className="flex flex-wrap items-center gap-2 text-sm text-red-400 p-4 rounded-lg border border-red-500/30 bg-red-500/5">
              <AlertTriangle className="h-4 w-4" /> Could not load runs.
              <button onClick={() => refetch()} className="ml-auto rounded-lg bg-slate-800 px-3 py-1 text-xs font-medium text-slate-200 hover:bg-slate-700">
                Try again
              </button>
            </div>
          ) : runs.length === 0 ? (
            <div className="text-sm text-slate-500 p-4 rounded-lg border border-slate-800 bg-surface-900">
              No agent runs yet. Start one above to see the step-by-step timeline.
            </div>
          ) : (
            runs.map((r) => (
              <button
                key={r.id}
                onClick={() => setSelectedId(r.id)}
                className={clsx(
                  'w-full text-left rounded-lg border p-3 transition-colors',
                  selected?.id === r.id ? 'border-emerald-500/50 bg-emerald-500/5' : 'border-slate-800 bg-surface-900 hover:border-slate-700',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-white truncate">{r.title}</span>
                  <span className={clsx('shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium', runTone(r.status))}>{r.status}</span>
                </div>
                <div className="mt-1 text-[11px] text-slate-500">
                  {r.recipeLabel} · {new Date(r.createdAt).toLocaleString()}
                </div>
              </button>
            ))
          )}
        </div>

        {/* Run detail */}
        <div className="rounded-xl border border-slate-800 bg-surface-900 p-5 min-h-[240px]">
          {!selected ? (
            <div className="flex h-full items-center justify-center text-sm text-slate-500">Select a run to see its timeline.</div>
          ) : (
            <>
              <div className="flex items-start justify-between gap-3 mb-4">
                <div>
                  <div className="text-white font-semibold">{selected.title}</div>
                  <div className="text-[11px] text-slate-500 mt-0.5 font-mono">{selected.id}</div>
                </div>
                <span className={clsx('shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium', runTone(selected.status))}>{selected.status}</span>
              </div>

              {selected.error && (
                <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-300">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" /> {selected.error}
                </div>
              )}

              {/* Timeline */}
              <ol className="relative space-y-4 pl-2">
                {selected.steps.map((s, i) => (
                  <li key={s.name} className="relative pl-6">
                    {i < selected.steps.length - 1 && <span className="absolute left-[7px] top-5 bottom-[-1rem] w-px bg-slate-800" aria-hidden />}
                    <span className="absolute left-0 top-0.5"><StepIcon status={s.status} /></span>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-white">{s.label}</span>
                      <KindBadge kind={s.kind} />
                      {s.disposition && (
                        <span className="rounded-full border border-slate-700 bg-slate-800/40 px-2 py-0.5 text-[10px] text-slate-300">
                          dial: {s.disposition}
                        </span>
                      )}
                      <span className="text-[10px] uppercase tracking-wide text-slate-600">{s.status}</span>
                    </div>
                    {s.summary && <p className="mt-1 text-xs text-slate-400">{s.summary}</p>}
                    {s.aiDecisionId && (
                      <p className="mt-1 text-[10px] text-slate-600 font-mono">decision: {s.aiDecisionId}</p>
                    )}
                  </li>
                ))}
              </ol>

              {/* Gate action */}
              {selected.status === 'PAUSED' && waitingStep && (
                <div className="mt-6 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
                  <div className="flex items-center gap-2 text-sm font-medium text-amber-300">
                    <Hand className="h-4 w-4" /> Waiting for you: {waitingStep.label}
                  </div>
                  <p className="mt-1.5 text-xs text-amber-200/80">{waitingStep.gatePrompt ?? selected.pausedReason}</p>
                  {waitingStep.kind === 'HUMAN_GATE' && (
                    <p className="mt-2 text-[11px] text-slate-400">
                      Approve the bill through Bills / Approvals first — the agent only continues once it confirms the bill is APPROVED. It never approves for you.
                    </p>
                  )}
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Optional note (recorded on the audit trail)…"
                    rows={2}
                    className="mt-3 w-full rounded-lg border border-slate-700 bg-surface-950 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-emerald-500/50 focus:outline-none"
                  />
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      onClick={() => advance('APPROVE')}
                      disabled={advancing}
                      className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                    >
                      {advancing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CircleCheck className="h-4 w-4" />}
                      {waitingStep.kind === 'HUMAN_GATE' ? 'Continue' : 'Approve & continue'}
                    </button>
                    <button
                      onClick={() => advance('REJECT')}
                      disabled={advancing}
                      className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-2 text-sm font-medium text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                    >
                      <CircleX className="h-4 w-4" /> Reject & stop
                    </button>
                  </div>
                </div>
              )}

              {selected.subjectTable === 'bills' && selected.subjectId && (
                <div className="mt-4 text-xs">
                  <a href={`/bills`} className="inline-flex items-center gap-1 text-emerald-400 hover:text-emerald-300">
                    Open Bills <ChevronRight className="h-3 w-3" />
                  </a>
                </div>
              )}

              {!selected.persisted && (
                <p className="mt-4 text-[11px] text-slate-600">
                  This run was ephemeral (agent persistence tables not yet migrated) — it will not appear in history.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
