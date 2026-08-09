'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useMe } from '@/lib/hooks/use-me';
import {
  ACTIVE_COMPANY_COOKIE,
  ALL_COMPANIES,
  isSpecificCompany,
  readActiveCompanyCookie,
} from '@/lib/company-scope';

export interface CompanyOption {
  id: string;
  name: string;
  shortCode: string;
}

interface ActiveCompanyContextValue {
  /** 'all' (consolidated) or a specific `core.locations` id. */
  activeCompanyId: string;
  /** The selected company, or null when consolidated ('all'). */
  activeCompany: CompanyOption | null;
  /** True when no single company is selected (consolidated). */
  isAll: boolean;
  /** The caller's assignable companies (does NOT include the synthetic "All"). */
  companies: CompanyOption[];
  /** Select a company id, or ALL_COMPANIES for consolidated. Persists to a cookie. */
  setActiveCompany: (id: string) => void;
  /** True once /api/me has resolved and the cookie has been reconciled. */
  ready: boolean;
}

const DEFAULT: ActiveCompanyContextValue = {
  activeCompanyId: ALL_COMPANIES,
  activeCompany: null,
  isAll: true,
  companies: [],
  setActiveCompany: () => {},
  ready: false,
};

const ActiveCompanyContext = createContext<ActiveCompanyContextValue>(DEFAULT);

function writeCookie(id: string) {
  try {
    const oneYear = 60 * 60 * 24 * 365;
    document.cookie = `${ACTIVE_COMPANY_COOKIE}=${encodeURIComponent(
      id,
    )}; path=/; max-age=${oneYear}; samesite=lax`;
  } catch {
    /* document unavailable (SSR) — ignore */
  }
}

/**
 * Holds the ACTIVE COMPANY — the single entity all processing work is scoped to.
 * Mounted inside MeProvider (needs the viewer's assigned locations) and read by
 * the header selector, the shared useQuery hook (which auto-attaches the company
 * to requests), the processing-page guard, and the dashboard click-through.
 */
export function ActiveCompanyProvider({ children }: { children: ReactNode }) {
  const { locations, loading } = useMe();

  const companies: CompanyOption[] = useMemo(
    () =>
      locations.map((l) => ({
        id: l.id,
        name: l.name,
        shortCode: (l.code || l.name).slice(0, 3).toUpperCase(),
      })),
    [locations],
  );

  // Initialise synchronously from the cookie on the client so a returning user
  // doesn't flash "All" before their pinned company loads.
  const [activeCompanyId, setActiveCompanyId] = useState<string>(() => {
    if (typeof document === 'undefined') return ALL_COMPANIES;
    return readActiveCompanyCookie(document.cookie);
  });

  // Reconcile once locations resolve: a stored id that is no longer among the
  // caller's assigned companies (role/assignment changed, or a stale cookie)
  // falls back to consolidated rather than silently scoping to something the
  // user can't actually see.
  useEffect(() => {
    if (loading) return;
    if (
      isSpecificCompany(activeCompanyId) &&
      !companies.some((c) => c.id === activeCompanyId)
    ) {
      setActiveCompanyId(ALL_COMPANIES);
      writeCookie(ALL_COMPANIES);
    }
  }, [loading, companies, activeCompanyId]);

  const setActiveCompany = useCallback((id: string) => {
    const next = id || ALL_COMPANIES;
    setActiveCompanyId(next);
    writeCookie(next);
  }, []);

  const value = useMemo<ActiveCompanyContextValue>(() => {
    const isAll = !isSpecificCompany(activeCompanyId);
    return {
      activeCompanyId,
      activeCompany: isAll
        ? null
        : companies.find((c) => c.id === activeCompanyId) ?? null,
      isAll,
      companies,
      setActiveCompany,
      ready: !loading,
    };
  }, [activeCompanyId, companies, setActiveCompany, loading]);

  return (
    <ActiveCompanyContext.Provider value={value}>
      {children}
    </ActiveCompanyContext.Provider>
  );
}

export function useActiveCompany(): ActiveCompanyContextValue {
  return useContext(ActiveCompanyContext);
}
