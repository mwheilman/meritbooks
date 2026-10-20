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
import { usePathname } from 'next/navigation';
import { useMe } from '@/lib/hooks/use-me';
import { companyFromUrl } from '@/lib/company-scope-url';
import {
  ACTIVE_COMPANY_COOKIE,
  ALL_COMPANIES,
  isSpecificCompany,
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
/** Server-read seed (see lib/company-scope-server.ts). */
export interface InitialActiveCompany {
  id: string;
  name: string | null;
  shortCode: string | null;
}

export function ActiveCompanyProvider({
  children,
  initialCompany,
}: {
  children: ReactNode;
  initialCompany?: InitialActiveCompany | null;
}) {
  const { locations, loading } = useMe();

  // Until /api/me resolves, expose the server-resolved company (if any) as a
  // provisional single-item list so the header can name it on first paint.
  const seed = initialCompany && isSpecificCompany(initialCompany.id) && initialCompany.name
    ? { id: initialCompany.id, name: initialCompany.name, shortCode: initialCompany.shortCode ?? initialCompany.name.slice(0, 3).toUpperCase() }
    : null;
  const seedId = seed?.id;
  const seedName = seed?.name;
  const seedShort = seed?.shortCode;
  const companies: CompanyOption[] = useMemo(() => {
    if (loading) return seedId && seedName ? [{ id: seedId, name: seedName, shortCode: seedShort ?? '' }] : [];
    return locations.map((l) => ({
      id: l.id,
      name: l.name,
      shortCode: (l.code || l.name).slice(0, 3).toUpperCase(),
    }));
  }, [locations, loading, seedId, seedName, seedShort]);

  // Initialise from the SERVER-read cookie value — identical on the server render
  // and the first client render. Reading document.cookie here (as before) made
  // the two renders disagree → hydration errors #425/#418/#423 and an "All
  // Companies" header for seconds after every refresh (audit 06 §L.3 L1).
  const [activeCompanyId, setActiveCompanyId] = useState<string>(
    () => initialCompany?.id || ALL_COMPANIES,
  );

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

  // Deep links carry the company as `?location_id=` (Entities board, entity
  // snapshot, dashboard click-throughs). Honor it on navigation when it names
  // one of the caller's assigned companies, so the target page opens scoped to
  // that company instead of the previously active one (audit 06 §5 bug 11).
  const pathname = usePathname();
  useEffect(() => {
    if (loading || typeof window === 'undefined') return;
    const want = companyFromUrl(window.location.search, companies.map((c) => c.id));
    if (want && want !== activeCompanyId) {
      setActiveCompanyId(want);
      writeCookie(want);
    }
    // Run on navigation (and once /api/me resolves) — not on every manual switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, loading, companies]);

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
