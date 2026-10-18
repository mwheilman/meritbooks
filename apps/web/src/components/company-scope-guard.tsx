'use client';

import { Building2, Loader2, ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { useActiveCompany } from '@/lib/hooks/use-active-company';

/**
 * CONTROL GUARD for processing surfaces.
 *
 * All processing must be scoped to exactly ONE company — for bookkeepers AND
 * tenant admins alike — because consolidating processing data is dangerous
 * (users lose track of which account they are actually working on). When no
 * single company is selected ("All"), this renders a friendly full-page prompt
 * to pick one instead of showing ambiguous consolidated processing data.
 *
 * The DASHBOARD and REPORTS are EXEMPT (they legitimately allow "All") — do not
 * wrap them with this guard.
 *
 * Usage (wrap the page's client shell):
 *   <CompanyScopeGuard>
 *     <BillsClient />
 *   </CompanyScopeGuard>
 */
export function CompanyScopeGuard({
  children,
  title = 'Select a company to begin',
  description = 'Processing is always scoped to one company so nothing lands on the wrong account. Choose the company you want to work in.',
}: {
  children: ReactNode;
  title?: string;
  description?: string;
}) {
  const { isAll, ready, companies, setActiveCompany } = useActiveCompany();

  // Wait for /api/me so we don't flash the prompt before the pinned company loads.
  if (!ready) {
    return (
      <div className="flex items-center justify-center py-24 text-slate-500">
        <Loader2 className="animate-spin" size={22} />
      </div>
    );
  }

  if (!isAll) return <>{children}</>;

  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center py-16 text-center">
      <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-500/15">
        <Building2 size={26} className="text-brand-400" />
      </div>
      <h2 className="mb-2 text-xl font-semibold tracking-tight text-white">{title}</h2>
      <p className="mb-8 max-w-md text-sm leading-relaxed text-slate-400">{description}</p>

      {companies.length === 0 ? (
        <div className="card w-full max-w-md p-6 text-sm text-slate-500">
          No companies are assigned to you yet. Add entities in Settings, or ask an
          administrator to assign you to a company.
        </div>
      ) : (
        <div className="w-full max-w-md space-y-2 text-left">
          <p className="px-1 pb-1 text-2xs font-semibold uppercase tracking-wider text-slate-500">
            Your companies · {companies.length}
          </p>
          {companies.map((c) => (
            <button
              key={c.id}
              onClick={() => setActiveCompany(c.id)}
              className="group flex w-full items-center gap-3 rounded-xl border border-slate-800 bg-surface-900 px-4 py-3 text-left transition-colors hover:border-brand-500/40 hover:bg-white/[0.03]"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-800 text-2xs font-bold text-slate-400 group-hover:bg-brand-500/20 group-hover:text-brand-400">
                {c.shortCode.slice(0, 2)}
              </div>
              <span className="flex-1 truncate text-sm font-medium text-slate-200">
                {c.name}
              </span>
              <ArrowRight
                size={16}
                className="text-slate-600 transition-colors group-hover:text-brand-400"
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
