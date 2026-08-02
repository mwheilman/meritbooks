'use client';

import { useState, useCallback } from 'react';
import {
  CheckCircle2, Circle, AlertTriangle, Lock, AlertCircle, Loader2, Zap, Hand,
  ChevronDown, ChevronRight, ChevronLeft, ShieldAlert, ShieldCheck, Clock,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, addToast } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';

// ── Types (mirror /api/close/orchestration) ────────────────────────────────────

type TaskStatus = 'pass' | 'blocked' | 'pending';
type TaskKind = 'AUTO' | 'MANUAL';
type Phase = 'INITIAL' | 'MID_CLOSE' | 'FINAL';
type PeriodStatus = 'OPEN' | 'SOFT_CLOSE' | 'HARD_CLOSE' | 'NO_PERIOD';
type DriverUnit = 'count' | 'cents' | 'none';

interface EvaluatedTask {
  key: string;
  label: string;
  description: string;
  kind: TaskKind;
  blocking: boolean;
  dependsOn: string[];
  phase: Phase;
  unit: DriverUnit;
  order: number;
  dueDay: number;
  status: TaskStatus;
  driverValue: number | null;
  driverLabel: string;
  actionable: boolean;
  reason: string | null;
}
interface GraphEvaluation {
  tasks: EvaluatedTask[];
  blockers: EvaluatedTask[];
  warnings: EvaluatedTask[];
  readyToHardClose: boolean;
  autoPass: number;
  autoTotal: number;
  manualDone: number;
  manualTotal: number;
  completedTasks: number;
  totalTasks: number;
  percentComplete: number;
}
interface GateBlocker { key: string; label: string; reason: string }
interface Entity {
  locationId: string;
  name: string;
  shortCode: string;
  periodId: string | null;
  periodStatus: PeriodStatus;
  closedAt: string | null;
  evaluation: GraphEvaluation;
  gate: { pass: boolean; overridden: boolean; blockers: GateBlocker[] };
}
interface BoardResponse {
  period: { year: number; month: number; key: string; label: string };
  summary: { totalEntities: number; readyToClose: number; blocked: number; closed: number; noPeriod: number };
  entities: Entity[];
}

const PHASE_LABEL: Record<Phase, string> = {
  INITIAL: 'Initial (Day 3)',
  MID_CLOSE: 'Mid-close (Day 7)',
  FINAL: 'Final (Day 10)',
};
const PHASE_ORDER: Phase[] = ['INITIAL', 'MID_CLOSE', 'FINAL'];

const STATUS_BADGE: Record<PeriodStatus, { label: string; cls: string; icon: typeof Lock }> = {
  OPEN: { label: 'Open', cls: 'bg-blue-500/20 text-blue-300', icon: Circle },
  SOFT_CLOSE: { label: 'Soft close', cls: 'bg-amber-500/20 text-amber-300', icon: Clock },
  HARD_CLOSE: { label: 'Closed', cls: 'bg-emerald-500/20 text-emerald-300', icon: Lock },
  NO_PERIOD: { label: 'No period', cls: 'bg-slate-500/20 text-slate-400', icon: AlertCircle },
};

function driverText(t: EvaluatedTask): string {
  return t.driverLabel;
}

export function CloseOrchestration() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [busyTask, setBusyTask] = useState<string | null>(null);
  const [overrideFor, setOverrideFor] = useState<string | null>(null);
  const [overrideReason, setOverrideReason] = useState('');

  const { data, isLoading, error } = useQuery<BoardResponse>(
    `/api/close/orchestration?year=${year}&month=${month}`, undefined, { key: String(refreshKey) },
  );

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const shiftMonth = useCallback((delta: number) => {
    setExpanded(null);
    setOverrideFor(null);
    const d = new Date(year, month - 1 + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth() + 1);
  }, [year, month]);

  const toggleManual = useCallback(async (ent: Entity, taskKey: string, next: boolean) => {
    if (!ent.periodId) { addToast('error', 'Generate a fiscal period for this entity first'); return; }
    setBusyTask(`${ent.locationId}:${taskKey}`);
    try {
      const res = await fetch('/api/close/orchestration', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_id: ent.locationId,
          fiscal_period_id: ent.periodId,
          task_key: taskKey,
          is_complete: next,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        addToast('error', j.error ?? 'Failed to update sign-off');
        return;
      }
      refresh();
    } catch {
      addToast('error', 'Network error');
    } finally {
      setBusyTask(null);
    }
  }, [refresh]);

  const hardClose = useCallback(async (ent: Entity, reason?: string) => {
    if (!ent.periodId) return;
    setBusyTask(`${ent.locationId}:__close`);
    try {
      const res = await fetch('/api/periods', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period_id: ent.periodId, status: 'HARD_CLOSE', reason: reason ?? null }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 409 && j.code === 'CLOSE_GATE') {
        setOverrideFor(ent.locationId);
        addToast('error', 'Close is blocked — resolve the blockers or supply an override reason');
        return;
      }
      if (!res.ok) { addToast('error', j.error ?? 'Failed to close'); return; }
      addToast('success', j.closeGateOverridden ? 'Period hard-closed with override' : 'Period hard-closed');
      setOverrideFor(null);
      setOverrideReason('');
      refresh();
    } catch {
      addToast('error', 'Network error');
    } finally {
      setBusyTask(null);
    }
  }, [refresh]);

  if (isLoading) {
    return <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-emerald-400 animate-spin" /></div>;
  }
  if (error) {
    return (
      <div className="p-8 text-center">
        <AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" />
        <p className="text-red-400 text-sm">{String(error)}</p>
      </div>
    );
  }

  const summary = data?.summary;
  const entities = data?.entities ?? [];
  const monthName = data?.period.label ?? new Date(year, month - 1).toLocaleString('en', { month: 'long', year: 'numeric' });

  return (
    <div className="space-y-6">
      {/* Period nav + summary */}
      <div className="flex flex-wrap items-center gap-4 px-4 py-3 rounded-lg bg-slate-800/30 border border-slate-700/50 text-sm">
        <div className="flex items-center gap-2">
          <button onClick={() => shiftMonth(-1)} className="p-1.5 rounded-md bg-slate-800 text-slate-400 hover:text-white"><ChevronLeft size={15} /></button>
          <span className="text-white font-medium w-36 text-center">{monthName}</span>
          <button onClick={() => shiftMonth(1)} className="p-1.5 rounded-md bg-slate-800 text-slate-400 hover:text-white"><ChevronRight size={15} /></button>
        </div>
        <div className="h-4 w-px bg-slate-700" />
        <span className="text-slate-400">Entities <span className="text-white font-mono">{summary?.totalEntities ?? 0}</span></span>
        <span className="flex items-center gap-1 text-emerald-400"><ShieldCheck size={14} />{summary?.readyToClose ?? 0} ready</span>
        <span className="flex items-center gap-1 text-red-400"><ShieldAlert size={14} />{summary?.blocked ?? 0} blocked</span>
        <span className="flex items-center gap-1 text-slate-400"><Lock size={13} />{summary?.closed ?? 0} closed</span>
        {(summary?.noPeriod ?? 0) > 0 && <span className="text-slate-500">{summary?.noPeriod} no period</span>}
      </div>

      {entities.length === 0 ? (
        <div className="p-10 text-center text-sm text-slate-500">
          <AlertCircle className="w-8 h-8 mx-auto text-slate-600 mb-2" />
          No entities found. Add a company to manage its close.
        </div>
      ) : (
        <div className="space-y-2">
          {entities.map((ent) => {
            const isOpen = expanded === ent.locationId;
            const ev = ent.evaluation;
            const badge = STATUS_BADGE[ent.periodStatus];
            const BadgeIcon = badge.icon;
            const isPeriodOpen = ent.periodStatus === 'OPEN' || ent.periodStatus === 'SOFT_CLOSE';
            const ready = isPeriodOpen && ev.readyToHardClose;
            const blockedCount = ev.blockers.length;

            return (
              <div key={ent.locationId} className="bg-slate-800/30 border border-slate-700/30 rounded-lg overflow-hidden">
                {/* Entity header */}
                <button
                  onClick={() => setExpanded(isOpen ? null : ent.locationId)}
                  className="w-full flex items-center gap-4 px-4 py-3 hover:bg-slate-800/50 transition-colors text-left"
                >
                  {isOpen ? <ChevronDown className="w-4 h-4 text-slate-500" /> : <ChevronRight className="w-4 h-4 text-slate-500" />}
                  <span className="w-8 h-8 rounded bg-slate-700 text-[10px] font-mono text-slate-300 flex items-center justify-center shrink-0">
                    {ent.shortCode}
                  </span>
                  <span className="text-sm font-medium text-white flex-1 truncate">{ent.name}</span>

                  {/* Progress bar */}
                  <div className="hidden sm:flex items-center gap-2">
                    <div className="h-1.5 w-28 rounded-full bg-slate-700 overflow-hidden">
                      <div
                        className={clsx('h-full rounded-full', ready ? 'bg-emerald-500' : blockedCount > 0 ? 'bg-amber-500' : 'bg-blue-500')}
                        style={{ width: `${ev.percentComplete}%` }}
                      />
                    </div>
                    <span className="text-[10px] font-mono text-slate-500 w-14">{ev.completedTasks}/{ev.totalTasks} · {ev.percentComplete}%</span>
                  </div>

                  {/* Readiness chip */}
                  {ent.periodStatus === 'HARD_CLOSE' ? (
                    <span className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-emerald-500/15 text-emerald-300">
                      <Lock className="w-3 h-3" />Closed
                    </span>
                  ) : ready ? (
                    <span className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-emerald-500/15 text-emerald-300">
                      <ShieldCheck className="w-3 h-3" />Ready
                    </span>
                  ) : ent.periodStatus === 'NO_PERIOD' ? (
                    <span className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-slate-500/15 text-slate-400">No period</span>
                  ) : (
                    <span className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-red-500/15 text-red-300">
                      <ShieldAlert className="w-3 h-3" />{blockedCount} blocking
                    </span>
                  )}

                  {/* Period status */}
                  <span className={clsx('flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium', badge.cls)}>
                    <BadgeIcon className="w-3 h-3" />{badge.label}
                  </span>
                </button>

                {/* Expanded task graph */}
                {isOpen && (
                  <div className="border-t border-slate-700/30 px-4 py-4 space-y-4">
                    {ent.periodStatus === 'NO_PERIOD' ? (
                      <p className="text-sm text-slate-500 text-center py-4">
                        No fiscal period exists for this entity. Generate one on the Periods page to enable close tracking.
                      </p>
                    ) : (
                      <>
                        {PHASE_ORDER.map((phase) => {
                          const phaseTasks = ev.tasks.filter((t) => t.phase === phase).sort((a, b) => a.order - b.order);
                          if (phaseTasks.length === 0) return null;
                          return (
                            <div key={phase}>
                              <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5">{PHASE_LABEL[phase]}</p>
                              <div className="space-y-1">
                                {phaseTasks.map((t) => (
                                  <TaskRow
                                    key={t.key}
                                    task={t}
                                    busy={busyTask === `${ent.locationId}:${t.key}`}
                                    onToggle={(next) => toggleManual(ent, t.key, next)}
                                  />
                                ))}
                              </div>
                            </div>
                          );
                        })}

                        {/* Hard-close gate + action */}
                        {isPeriodOpen && (
                          <div className="pt-2 border-t border-slate-700/30">
                            {ev.readyToHardClose ? (
                              <div className="flex items-center justify-between gap-3">
                                <p className="text-xs text-emerald-300 flex items-center gap-1.5">
                                  <ShieldCheck size={14} /> All blocking tasks pass — this period is ready to hard-close.
                                </p>
                                <button
                                  onClick={() => hardClose(ent)}
                                  disabled={busyTask === `${ent.locationId}:__close`}
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50"
                                >
                                  {busyTask === `${ent.locationId}:__close` ? <Loader2 size={13} className="animate-spin" /> : <Lock size={13} />}
                                  Hard-close period
                                </button>
                              </div>
                            ) : (
                              <div className="space-y-2">
                                <p className="text-xs text-red-300 flex items-center gap-1.5">
                                  <ShieldAlert size={14} /> Hard close is blocked by {ev.blockers.length} task(s):
                                </p>
                                <ul className="text-[11px] text-slate-400 space-y-0.5 pl-5 list-disc">
                                  {ev.blockers.map((b) => (
                                    <li key={b.key}><span className="text-slate-300">{b.label}</span> — {b.reason}</li>
                                  ))}
                                </ul>
                                {overrideFor === ent.locationId ? (
                                  <div className="flex items-center gap-2 pt-1">
                                    <input
                                      value={overrideReason}
                                      onChange={(e) => setOverrideReason(e.target.value)}
                                      placeholder="Override reason (audited)…"
                                      className="flex-1 px-2.5 py-1.5 rounded-md bg-slate-900 border border-slate-700 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-red-500/50"
                                    />
                                    <button
                                      onClick={() => hardClose(ent, overrideReason)}
                                      disabled={overrideReason.trim().length < 4 || busyTask === `${ent.locationId}:__close`}
                                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-red-600 text-white hover:bg-red-500 disabled:opacity-40"
                                    >
                                      {busyTask === `${ent.locationId}:__close` ? <Loader2 size={13} className="animate-spin" /> : <Lock size={13} />}
                                      Force close
                                    </button>
                                    <button onClick={() => { setOverrideFor(null); setOverrideReason(''); }} className="text-xs text-slate-500 hover:text-slate-300 px-1">Cancel</button>
                                  </div>
                                ) : (
                                  <button
                                    onClick={() => { setOverrideFor(ent.locationId); setOverrideReason(''); }}
                                    className="text-[11px] text-slate-500 hover:text-red-300 underline underline-offset-2"
                                  >
                                    Override &amp; force close…
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </>
                    )}
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

function TaskRow({ task, busy, onToggle }: { task: EvaluatedTask; busy: boolean; onToggle: (next: boolean) => void }) {
  const isManual = task.kind === 'MANUAL';
  const canToggle = isManual && (task.actionable || task.status === 'pass');

  const StatusIcon =
    task.status === 'pass' ? CheckCircle2 : task.status === 'blocked' ? AlertTriangle : Circle;
  const statusColor =
    task.status === 'pass' ? 'text-emerald-400' : task.status === 'blocked' ? (task.blocking ? 'text-red-400' : 'text-amber-400') : 'text-slate-600';

  const chipColor =
    task.status === 'pass' ? 'bg-emerald-500/15 text-emerald-300'
      : task.status === 'blocked' ? (task.blocking ? 'bg-red-500/15 text-red-300' : 'bg-amber-500/15 text-amber-300')
        : 'bg-slate-700/40 text-slate-500';

  return (
    <div className="flex items-start gap-2.5 px-2 py-1.5 rounded hover:bg-slate-700/20">
      <StatusIcon className={clsx('w-4 h-4 shrink-0 mt-0.5', statusColor)} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={clsx('text-sm', task.status === 'pass' ? 'text-slate-300' : 'text-slate-200')}>{task.label}</span>
          {isManual
            ? <span title="Manual sign-off" className="text-indigo-400"><Hand className="w-3 h-3" /></span>
            : <span title="Auto-verified from live data" className="text-amber-400"><Zap className="w-3 h-3" /></span>}
          {!task.blocking && <span className="text-[9px] uppercase tracking-wider text-slate-600">optional</span>}
          <span className={clsx('text-[10px] font-mono px-1.5 py-0.5 rounded', chipColor)}>{driverText(task)}</span>
        </div>
        {task.status === 'blocked' && task.reason && (
          <p className="text-[11px] text-slate-500 mt-0.5">{task.reason}</p>
        )}
        {task.status === 'pending' && (
          <p className="text-[11px] text-slate-600 mt-0.5">Waiting on prerequisite tasks</p>
        )}
      </div>
      {isManual && (
        <button
          onClick={() => onToggle(task.status !== 'pass')}
          disabled={!canToggle || busy}
          className={clsx(
            'shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-colors',
            task.status === 'pass'
              ? 'bg-slate-700/50 text-slate-300 hover:bg-slate-700'
              : 'bg-indigo-600/80 text-white hover:bg-indigo-500 disabled:opacity-40',
          )}
          title={!canToggle ? 'Complete the prerequisite tasks first' : undefined}
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : task.status === 'pass' ? 'Reopen' : 'Sign off'}
        </button>
      )}
    </div>
  );
}
