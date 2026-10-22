'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useCallback, type ReactNode } from 'react';
import { Icon } from '@meritbooks/merit-ui';
import { useActiveCompany } from '@/lib/hooks/use-active-company';

/**
 * "Enter this client": sets the active client (the cookie-backed context every
 * processing request is scoped to) and goes to `href` — by default that client's
 * home. Re-renders in place when `href` is the page you're already on (the server
 * reads the new context). Processing always happens inside one client.
 */
export function useEnterCompany(): (companyId: string, href?: string) => void {
  const { setActiveCompany } = useActiveCompany();
  const router = useRouter();
  const pathname = usePathname();
  return useCallback(
    (companyId: string, href = '/dashboard') => {
      setActiveCompany(companyId);
      if (href === pathname) router.refresh();
      else router.push(href);
    },
    [setActiveCompany, router, pathname],
  );
}

export function EnterCompany({
  companyId,
  href = '/dashboard',
  className,
  children,
}: {
  companyId: string;
  href?: string;
  className?: string;
  children: ReactNode;
}) {
  const enter = useEnterCompany();
  return (
    <button type="button" onClick={() => enter(companyId, href)} className={className}>
      {children}
    </button>
  );
}

/** A quiet "Open books →" verb for a row. */
export function EnterCompanyLink({ companyId, href = '/dashboard' }: { companyId: string; href?: string }) {
  return (
    <EnterCompany companyId={companyId} href={href} className="btn btn--quiet">
      Open books <Icon name="right" />
    </EnterCompany>
  );
}
