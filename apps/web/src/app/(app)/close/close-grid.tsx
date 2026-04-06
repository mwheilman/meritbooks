'use client';

import { useState, useCallback } from 'react';
import { useQuery } from '@/hooks';
import { CheckCircle2, Circle, Clock, Lock, AlertCircle, Loader2, Zap, ChevronDown, ChevronRight } from 'lucide-react';
import { clsx } from 'clsx';

interface ClosePhase { total: number; complete: number; dueDay: number }
interface ChecklistItem { id: string; phase: string; task_name: string; task_order: number; due_day: number; is_complete: boolean; is_auto_verified: boolean; completed_at: string | null; notes: string | null }
interface LocationClose {
  locationId: string; locationName: string; shortCode: string;
  periodStatus: string; periodId: string | null;
  phases: { INITIAL: ClosePhase; MID_CLOSE: ClosePhase; FINAL: ClosePhase };
  items: ChecklistItem[];
  totalTasks: number; completedTasks: number;
}
interface CloseResponse {
  period: { year: number; month: number };
  grid: LocationClose[];
  summary: { totalLocations: number; closedCount: number; inProgressCount: number; notStartedCount: number };
}

const PHASE_LABELS: Record<string, { label: string; color: string }> = {
  INITIAL: { label: 'Initial (Day 3)', color: 'bg-blue-500' },
  MID_CLOSE: { label: 'Mid-Close (Day 7)', color: 'bg-amber-500' },
  FINAL: { label: 'Final (Day 10)', color: 'bg-emerald-500' },
};

const STATUS_BADGE: Record<string, { label: string; cls: string; icon: typeof Lock }> = {
  OPEN: { label: 'Open', cls: 'bg-blue-500/20 text-blue-300', icon: Circle },
  SOFT_CLOSE: { label: 'Soft Close', cls: 'bg-amber-500/20 text-amber-300', icon: Clock },
  HARD_CLOSE: { label: 'Closed', cls: 'bg-emerald-500/20 text-emerald-300', icon: Lock },
  NO_PERIOD: { label: 'No Period', cls: 'bg-gray-500/20 text-gray-400', icon: AlertCircle },
};

export function CloseGrid() {
  const now = new Date();
  const [year] = useState(now.getFullYear());
  const [month] = useState(now.getMonth() + 1);
  const [expandedLoc, setExpandedLoc] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const { data, isLoading, error } = useQuery<CloseResponse>(
    `/api/close?year=${year}&month=${month}`, undefined, { key: String(refreshKey) }
  );

  const toggleItem = useCallback(async (itemId: string, isComplete: boolean) => {
    await fetch('/api/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checklist_id: itemId, is_complete: isComplete }),
    });
    setRefreshKey((k) => k + 1);
  }, []);

  if (isLoading) return <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-emerald-400 animate-spin" /></div>;
  if (error) return <div className="p-8 text-center"><AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" /><p className="text-red-400 text-sm">{String(error)}</p></div>;

  const grid = data?.grid ?? [];
  const summary = data?.summary;
  const monthName = new Date(year, month - 1).toLocaleString('en', { month: 'long', year: 'numeric' });

  return (
    <div className="space-y-6">
      {/* Summary strip */}
      <div className="flex items-center gap-6 px-4 py-3 rounded-lg bg-gray-800/30 border border-gray-700/50 text-sm">
        <span className="text-gray-400">Period: <span className="text-white font-medium">{monthName}</span></span>
        <div className="h-4 w-px bg-gray-700" />
        <span className="text-gray-400">Entities: <span className="text-white font-mono">{summary?.totalLocations ?? 0}</span></span>
        <span className="text-emerald-400 font-medium">{summary?.closedCount ?? 0} closed</span>
        <span className="text-blue-400">{summary?.inProgressCount ?? 0} in progress</span>
        <span className="text-gray-500">{summary?.notStartedCount ?? 0} not started</span>
      </div>

      {/* Entity rows */}
      <div className="space-y-2">
        {grid.map((loc) => {
          const isExpanded = expandedLoc === loc.locationId;
          const pct = loc.totalTasks > 0 ? Math.round((loc.completedTasks / loc.totalTasks) * 100) : 0;
          const status = STATUS_BADGE[loc.periodStatus] ?? STATUS_BADGE.NO_PERIOD;
          const StatusIcon = status.icon;

          return (
            <div key={loc.locationId} className="bg-gray-800/30 border border-gray-700/30 rounded-lg overflow-hidden">
              {/* Location header */}
              <button
                onClick={() => setExpandedLoc(isExpanded ? null : loc.locationId)}
                className="w-full flex items-center gap-4 px-4 py-3 hover:bg-gray-800/50 transition-colors text-left"
              >
                {isExpanded ? <ChevronDown className="w-4 h-4 text-gray-500" /> : <ChevronRight className="w-4 h-4 text-gray-500" />}

                <span className="w-8 h-8 rounded bg-gray-700 text-[10px] font-mono text-gray-300 flex items-center justify-center shrink-0">
                  {loc.shortCode}
                </span>
                <span className="text-sm font-medium text-white flex-1">{loc.locationName}</span>

                {/* Phase progress bars */}
                <div className="flex items-center gap-3">
                  {(['INITIAL', 'MID_CLOSE', 'FINAL'] as const).map((phase) => {
                    const p = loc.phases[phase];
                    const phasePct = p.total > 0 ? (p.complete / p.total) * 100 : 0;
                    return (
                      <div key={phase} className="flex items-center gap-1.5">
                        <div className="h-1.5 w-10 rounded-full bg-gray-700 overflow-hidden">
                          <div className={clsx('h-full rounded-full', PHASE_LABELS[phase].color)} style={{ width: `${phasePct}%` }} />
                        </div>
                        <span className="text-[10px] font-mono text-gray-500">{p.complete}/{p.total}</span>
                      </div>
                    );
                  })}
                </div>

                {/* Overall progress */}
                <span className="font-mono text-xs text-gray-400 w-10 text-right">{pct}%</span>

                {/* Status badge */}
                <span className={clsx('flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium', status.cls)}>
                  <StatusIcon className="w-3 h-3" />{status.label}
                </span>
              </button>

              {/* Expanded checklist */}
              {isExpanded && loc.items.length > 0 && (
                <div className="border-t border-gray-700/30 px-4 py-3 space-y-1">
                  {(['INITIAL', 'MID_CLOSE', 'FINAL'] as const).map((phase) => {
                    const phaseItems = loc.items.filter((i: ChecklistItem) => i.phase === phase);
                    if (phaseItems.length === 0) return null;
                    return (
                      <div key={phase} className="mb-3">
                        <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">{PHASE_LABELS[phase].label}</p>
                        {phaseItems.map((item: ChecklistItem) => (
                          <button
                            key={item.id}
                            onClick={() => toggleItem(item.id, !item.is_complete)}
                            className="flex items-center gap-2 w-full px-2 py-1.5 rounded hover:bg-gray-700/30 transition-colors text-left"
                          >
                            {item.is_complete
                              ? <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                              : <Circle className="w-4 h-4 text-gray-600 shrink-0" />}
                            <span className={clsx('text-sm flex-1', item.is_complete ? 'text-gray-500 line-through' : 'text-gray-300')}>
                              {item.task_name}
                            </span>
                            {item.is_auto_verified && <Zap className="w-3 h-3 text-amber-400" />}
                            <span className="text-[10px] text-gray-600 font-mono">Day {item.due_day}</span>
                          </button>
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}

              {isExpanded && loc.items.length === 0 && (
                <div className="border-t border-gray-700/30 px-4 py-6 text-center text-sm text-gray-500">
                  No checklist items for this period. Create a fiscal period and checklist template to enable close tracking.
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
