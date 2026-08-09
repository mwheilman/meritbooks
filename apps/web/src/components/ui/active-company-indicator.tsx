'use client';

import { Building2 } from 'lucide-react';
import { useActiveCompany } from '@/lib/hooks/use-active-company';

/**
 * A compact, always-visible chip that tells a processor exactly which company
 * every action on the current page will post to. Company scope is owned by the
 * header picker + <CompanyScopeGuard>; this is a passive readout of that state so
 * work is never posted to the wrong entity by mistake.
 *
 * Renders nothing in the consolidated ("All companies") view or before the
 * active company has resolved — the chip only appears when there is a single,
 * specific company to name.
 */
export function ActiveCompanyIndicator() {
  const { activeCompany, isAll, ready } = useActiveCompany();

  if (!ready || isAll || !activeCompany) return null;

  return (
    <span
      title={`Working in ${activeCompany.name} — all actions on this page post to this company`}
      className="inline-flex items-center gap-1.5 rounded-md border border-brand-500/25 bg-brand-500/10 px-2.5 py-1 text-2xs font-medium text-brand-300 max-w-[220px]"
    >
      <Building2 size={12} className="text-brand-400 shrink-0" />
      <span className="text-brand-400/70 uppercase tracking-wide">Working in</span>
      <span className="truncate text-brand-200">{activeCompany.name}</span>
    </span>
  );
}
