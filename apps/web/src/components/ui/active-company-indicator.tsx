'use client';

import { usePathname } from 'next/navigation';
import { Tag } from '@meritbooks/merit-ui';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { usePlane } from '@/lib/hooks/use-plane';
import { isOrgLevelRoute } from '@/lib/shell/org-level-routes';

/**
 * A quiet tag beside the page's verbs naming the client every action on the page
 * posts to ("Posts to Clive Power Equipment"). The ⌘J chip in the bar carries the
 * context; this repeats it where the buttons are, so work never lands in the wrong
 * books. Renders nothing outside the Books plane, before the client resolves, with
 * no single client picked, or on an org-level page (/settings, /team, /inbox …) where
 * nothing posts to one client's books (lib/shell/org-level-routes).
 */
export function ActiveCompanyIndicator() {
  const { activeCompany, isAll, ready } = useActiveCompany();
  const { plane } = usePlane();
  const pathname = usePathname();

  if (plane !== 'books') return null;
  if (!ready || isAll || !activeCompany) return null;
  if (isOrgLevelRoute(pathname)) return null;

  return (
    <Tag title={`Working in ${activeCompany.name} — all actions on this page post to this client`} className="mb-posts-to">
      Posts to {activeCompany.name}
    </Tag>
  );
}
