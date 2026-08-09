'use client';

import { useState } from 'react';
import { clsx } from 'clsx';
import { Play, BarChart3 } from 'lucide-react';
import { CompanyScopeGuard } from '@/components/company-scope-guard';
import { RevRecRun } from './rev-rec-run';
import { RevRecReports } from './rev-rec-reports';

const TABS = [
  { id: 'run', label: 'Run recognition', icon: Play },
  { id: 'reports', label: 'Reports', icon: BarChart3 },
] as const;
type Tab = (typeof TABS)[number]['id'];

export function RevRecTabs() {
  const [tab, setTab] = useState<Tab>('run');

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-1 border-b border-slate-800">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={clsx(
                'inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
                active ? 'border-emerald-500 text-white' : 'border-transparent text-slate-400 hover:text-slate-200',
              )}
            >
              <Icon size={14} /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'run' ? (
        // Posting recognition writes into ONE company's books — scope-guard it.
        <CompanyScopeGuard>
          <RevRecRun />
        </CompanyScopeGuard>
      ) : (
        // Reports are read-only and allow the consolidated ("All") view — EXEMPT
        // from the scope guard, mirroring the dashboard/reports exemption.
        <RevRecReports />
      )}
    </div>
  );
}
