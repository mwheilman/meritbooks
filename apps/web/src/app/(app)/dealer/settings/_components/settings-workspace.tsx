'use client';

/**
 * Dealer settings (FPB §9.3): switch on (#enable), accounts (#accounts),
 * departments (#departments), lenders (#lenders), accounting policies (#policies).
 * Reads the shell's settings + readiness (useDealerPack) and refetches them after
 * every save so the pack-off banner and the checklist stay current.
 */

import { useEffect, useRef } from 'react';
import { clsx } from 'clsx';
import { PageHeader } from '@/components/ui';
import { useDealerPack } from '../../_components/dealer-shell';
import { ErrorPanel, Spinner } from '../../_components/ui';
import { EnableSection } from './enable-section';
import { AccountsSection } from './accounts-section';
import { DepartmentsSection } from './departments-section';
import { LendersSection } from './lenders-section';
import { PoliciesSection } from './policies-section';

const SECTIONS = [
  { id: 'enable', label: 'Switch on' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'departments', label: 'Departments' },
  { id: 'lenders', label: 'Lenders' },
  { id: 'policies', label: 'Policies' },
] as const;

export function SettingsWorkspace() {
  const { settings, readiness, isLoading, error, refetch, locationId, clientName } = useDealerPack();
  const scrolled = useRef(false);
  const ready = !!settings && !!readiness;

  // Deep links (/dealer/settings#accounts, #role-FLOOR_PLAN_PAYABLE…) land once content exists.
  useEffect(() => {
    if (!ready || scrolled.current || typeof window === 'undefined') return;
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    scrolled.current = true;
    requestAnimationFrame(() => document.getElementById(hash)?.scrollIntoView({ block: 'start' }));
  }, [ready]);

  if (!locationId) return null;
  if (error && !ready) {
    return (
      <div>
        <PageHeader title="Dealer settings" />
        <div className="card">
          <ErrorPanel error={error} onRetry={() => void refetch()} />
        </div>
      </div>
    );
  }
  if (!ready || (isLoading && !settings)) return <Spinner label="Loading dealer settings…" />;

  const missingRoles = readiness.missing.filter((m) => m.startsWith('ROLE:')).length;
  const missingDepts = readiness.missing.filter((m) => m.startsWith('DEPT:')).length;
  const badge: Record<string, number> = { accounts: missingRoles, departments: missingDepts, enable: readiness.canEnable || readiness.enabled ? 0 : 1 };

  return (
    <div className="lg:grid lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-8">
      <nav aria-label="Settings sections" className="mb-4 lg:sticky lg:top-6 lg:mb-0 lg:h-fit">
        <ul className="flex gap-1 overflow-x-auto lg:flex-col">
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} className={clsx('flex items-center justify-between gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-sm text-slate-400 hover:bg-white/[0.03] hover:text-slate-200')}>
                {s.label}
                {(badge[s.id] ?? 0) > 0 && <span className="rounded-full bg-amber-500/15 px-1.5 font-mono text-2xs tabular-nums text-amber-300">{s.id === 'enable' ? '!' : badge[s.id]}</span>}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0">
        <PageHeader title="Dealer settings" description={`How the dealer pack books ${clientName ?? 'this client'}: accounts, departments, lenders and policies. Changes need the accounting-settings permission.`} />
        <EnableSection readiness={readiness} locationId={locationId} clientName={clientName} onChanged={refetch} />
        <AccountsSection readiness={readiness} locationId={locationId} canEdit onSaved={refetch} />
        <DepartmentsSection readiness={readiness} locationId={locationId} onSaved={refetch} />
        <LendersSection />
        <PoliciesSection settings={settings} locationId={locationId} onSaved={refetch} />
      </div>
    </div>
  );
}
