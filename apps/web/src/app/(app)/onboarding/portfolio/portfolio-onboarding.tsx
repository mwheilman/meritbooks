'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { clsx } from 'clsx';
import { Building2, FileSpreadsheet, RadioTower } from 'lucide-react';
import { PageHeader } from '@/components/ui';
import { api } from '@/lib/api-client';
import type { ControlTowerData } from '@/lib/companies/portfolio/types';
import { ControlTower } from './control-tower';
import { BulkCompanies } from './bulk-companies';
import { TbDrop } from './tb-drop';

type TabKey = 'tower' | 'companies' | 'balances';

const TABS: Array<{ key: TabKey; label: string; icon: typeof Building2 }> = [
  { key: 'tower', label: 'Control Tower', icon: RadioTower },
  { key: 'companies', label: 'Add companies', icon: Building2 },
  { key: 'balances', label: 'Drop trial balances', icon: FileSpreadsheet },
];

/** Tower data with a quiet background refresh (rows stay on screen while reloading). */
function useTower() {
  const [data, setData] = useState<ControlTowerData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const synced = useRef(false);

  const load = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true); else setLoading(true);
    const res = await api.get<ControlTowerData>('/api/onboarding/portfolio/tower');
    if (res.data) {
      setData(res.data);
      setError(null);
      // Keep core.locations.onboarding_status in step with the data (forward-only), so
      // the Portfolio / Entities board agrees with the Control Tower. Once per visit.
      if (res.data.statusDrift > 0 && !synced.current) {
        synced.current = true;
        const s = await api.post<{ updated: number }>('/api/onboarding/portfolio/tower', {});
        if (s.data && s.data.updated > 0) {
          const again = await api.get<ControlTowerData>('/api/onboarding/portfolio/tower');
          if (again.data) setData(again.data);
        }
      }
    } else {
      setError(res.error?.error ?? 'Could not load your companies');
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** Re-sync statuses after a write elsewhere on the page, then refresh quietly. */
  const syncAndReload = useCallback(async () => {
    await api.post('/api/onboarding/portfolio/tower', {});
    await load(true);
  }, [load]);

  return { data, error, loading, refreshing, reload: load, syncAndReload };
}

export function PortfolioOnboarding() {
  const [tab, setTab] = useState<TabKey>('tower');
  const tower = useTower();
  const tabRefs = useRef<Record<TabKey, HTMLButtonElement | null>>({ tower: null, companies: null, balances: null });

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((t) => t.key === tab);
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next].key);
    tabRefs.current[TABS[next].key]?.focus();
  };

  const companies = useMemo(
    () => (tower.data?.rows ?? []).map((r) => ({
      id: r.locationId,
      name: r.name,
      shortCode: r.shortCode,
      sessionCount: r.sessionCount,
    })),
    [tower.data],
  );
  const total = tower.data?.rows.length ?? 0;
  const live = tower.data?.counts.live ?? 0;

  return (
    <div className="px-6 py-6">
      <PageHeader
        title="Onboard many companies"
        description="Add every company at once, drop all their trial balances in one go, and watch each one reach live. One motion, not one company at a time."
        breadcrumbs={[{ label: 'Onboarding', href: '/onboarding' }, { label: 'Many companies' }]}
      />

      {total > 0 && (
        <div className="card px-4 py-3 mb-4 flex items-center gap-4" aria-live="polite">
          <div className="text-sm text-slate-300">
            <span className="font-mono tabular-nums text-white">{live}</span> of{' '}
            <span className="font-mono tabular-nums text-white">{total}</span> companies live
          </div>
          <div
            className="flex-1 h-1.5 rounded-full bg-slate-800 overflow-hidden"
            role="progressbar"
            aria-label="Companies live"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={live}
          >
            <div className="h-full bg-emerald-500 transition-all duration-500" style={{ width: `${total ? (live / total) * 100 : 0}%` }} />
          </div>
        </div>
      )}

      <div role="tablist" aria-label="Portfolio onboarding" className="flex gap-1 border-b border-slate-800 mb-5" onKeyDown={onTabKey}>
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = t.key === tab;
          return (
            <button
              key={t.key}
              ref={(el) => { tabRefs.current[t.key] = el; }}
              role="tab"
              id={`tab-${t.key}`}
              aria-selected={active}
              aria-controls={`panel-${t.key}`}
              tabIndex={active ? 0 : -1}
              onClick={() => setTab(t.key)}
              className={clsx(
                'flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 rounded-t',
                active ? 'border-emerald-500 text-white' : 'border-transparent text-slate-400 hover:text-slate-200',
              )}
            >
              <Icon size={15} aria-hidden />
              {t.label}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'tower' && (
          <ControlTower
            data={tower.data}
            loading={tower.loading}
            refreshing={tower.refreshing}
            error={tower.error}
            onRetry={() => void tower.reload()}
            onChanged={() => void tower.reload(true)}
            onAddCompanies={() => setTab('companies')}
            onUpload={() => setTab('balances')}
          />
        )}
        {tab === 'companies' && (
          <BulkCompanies
            existing={companies}
            existingLoading={tower.loading}
            onCreated={() => void tower.reload(true)}
            onNext={() => setTab('balances')}
          />
        )}
        {tab === 'balances' && (
          <TbDrop
            companies={companies}
            companiesLoading={tower.loading}
            onCompaniesChanged={() => tower.reload(true)}
            onSessionsCreated={() => void tower.syncAndReload()}
            onDone={() => setTab('tower')}
          />
        )}
      </div>
    </div>
  );
}
