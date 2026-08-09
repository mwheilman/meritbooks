'use client';

import { useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { Sparkles, ClipboardCheck, Scale } from 'lucide-react';
import { ReconciliationAutopilot } from './reconciliation-autopilot';
import { ReconciliationView } from './reconciliation-view';
import { TieOutCard } from '../cash-application/cash-application-parts';

/**
 * Three views of the same domain:
 *   • Autopilot — clear individual statement lines against the book (GL) and open
 *     bills, one AI-scored proposal at a time.
 *   • Statement — the period-level statement-vs-GL reconciliation form + history.
 *   • AR ↔ GL tie-out — the AR subledger vs GL control tie-out (moved off the retired
 *     standalone cash-application page onto Reconciliation, where a controller lives).
 */
export function ReconciliationTabs() {
  const [tab, setTab] = useState<'autopilot' | 'statement' | 'tie-out'>('autopilot');

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-1.5">
        <TabButton
          active={tab === 'autopilot'}
          onClick={() => setTab('autopilot')}
          icon={<Sparkles className="h-3.5 w-3.5" />}
          label="Autopilot"
        />
        <TabButton
          active={tab === 'statement'}
          onClick={() => setTab('statement')}
          icon={<ClipboardCheck className="h-3.5 w-3.5" />}
          label="Statement Reconciliation"
        />
        <TabButton
          active={tab === 'tie-out'}
          onClick={() => setTab('tie-out')}
          icon={<Scale className="h-3.5 w-3.5" />}
          label="AR ↔ GL Tie-Out"
        />
      </div>

      {tab === 'autopilot' && <ReconciliationAutopilot />}
      {tab === 'statement' && <ReconciliationView />}
      {tab === 'tie-out' && <TieOutCard />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-lg border px-3.5 py-2 text-sm font-medium transition-colors',
        active
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
          : 'border-slate-800 bg-slate-800/30 text-slate-400 hover:text-slate-200',
      )}
    >
      {icon}
      {label}
    </button>
  );
}
