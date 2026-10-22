'use client';

import type { ReactNode } from 'react';
import { ChordCaps, Icon } from '@meritbooks/merit-ui';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { useShellSlots } from '@/components/layout/shell-context';

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
  const { openSwitcher } = useShellSlots();

  // Wait for /api/me so we don't flash the prompt before the pinned company loads.
  if (!ready) {
    return (
      <div className="wg-loading mb-guard-loading" aria-busy="true">
        <span className="bar-l" style={{ width: '40%' }} aria-hidden="true" />
        <span className="bar-l" style={{ width: '64%' }} aria-hidden="true" />
        <span className="t-cap" role="status">Loading your clients…</span>
      </div>
    );
  }

  if (!isAll) return <>{children}</>;

  return (
    <div className="mb-guard">
      <div className="eyebrow">Pick a client</div>
      <h2 className="t-section" style={{ marginTop: 4, color: 'var(--ink)' }}>{title}</h2>
      <p className="t-body ink-2 mb-guard-lede">{description}</p>

      {companies.length === 0 ? (
        <div className="inline-notice" role="status">
          <div>
            <b>No clients are assigned to you yet.</b> Add clients in setup, or ask an administrator to give you access to one.
          </div>
        </div>
      ) : (
        <div className="surface mb-guard-list">
          <div className="mb-guard-list-h">
            <span className="eyebrow">Your clients · {companies.length}</span>
            <button type="button" className="btn btn--quiet" onClick={openSwitcher}>
              Find a client <ChordCaps chord="mod+j" />
            </button>
          </div>
          <ul>
            {companies.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => setActiveCompany(c.id)} className="mb-guard-row">
                  <span className="avatar mb-guard-code" aria-hidden="true">{c.shortCode.slice(0, 2)}</span>
                  <span className="l1">{c.name}</span>
                  <span className="mb-guard-go">
                    Open books <Icon name="right" />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
