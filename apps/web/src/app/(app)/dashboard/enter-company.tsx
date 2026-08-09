'use client';

import { useRouter } from 'next/navigation';
import { ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { useActiveCompany } from '@/lib/hooks/use-active-company';

/**
 * Dashboard click-through. The dashboard is the ONE consolidated, cross-company
 * place on the processing side — to actually work, the user must first pin a
 * company. This sets the active company (cookie-backed context) and jumps into
 * that company's workspace, so a click on the dashboard is a deliberate "enter
 * this company" action rather than ambiguous consolidated processing.
 */
export function EnterCompany({
  companyId,
  href = '/bank-feed',
  className,
  children,
}: {
  companyId: string;
  href?: string;
  className?: string;
  children: ReactNode;
}) {
  const { setActiveCompany } = useActiveCompany();
  const router = useRouter();

  return (
    <button
      type="button"
      onClick={() => {
        setActiveCompany(companyId);
        router.push(href);
      }}
      className={className}
    >
      {children}
    </button>
  );
}

/** A subtle "Enter →" affordance for a dashboard row. */
export function EnterCompanyLink({
  companyId,
  href = '/bank-feed',
}: {
  companyId: string;
  href?: string;
}) {
  return (
    <EnterCompany
      companyId={companyId}
      href={href}
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-brand-400 transition-colors hover:bg-brand-500/10"
    >
      Enter <ArrowRight size={13} />
    </EnterCompany>
  );
}
