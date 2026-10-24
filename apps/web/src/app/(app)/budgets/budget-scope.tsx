'use client';

/**
 * Shared scope for the Plan / Departments / Compare / Templates tabs: company, fiscal year, the
 * selected version, and the caller's budget access (from GET /api/budgets/versions).
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Field, Select, useQuery } from '@meritbooks/merit-ui';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { isSpecificCompany } from '@/lib/company-scope';
import type { BudgetAccessSummary, BudgetVersion, DepartmentLite, VersionsResponse } from '@/lib/budgets/types';
import { fiscalYears } from './budget-format';
import s from './budgets.module.css';

interface LocationLite { id: string; name: string; short_code: string }

export interface BudgetScope {
  locations: LocationLite[];
  locationId: string;
  setLocationId: (id: string) => void;
  fiscalYear: number;
  setFiscalYear: (y: number) => void;
  versions: BudgetVersion[];
  version: BudgetVersion | null;
  versionId: string | null;
  setVersionId: (id: string | null) => void;
  access: BudgetAccessSummary | null;
  departments: DepartmentLite[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

const Ctx = createContext<BudgetScope | null>(null);

export function useBudgetScope(): BudgetScope {
  const v = useContext(Ctx);
  if (!v) throw new Error('useBudgetScope must be used inside <BudgetScopeProvider>');
  return v;
}

function initialFy(): number {
  if (typeof window !== 'undefined') {
    const n = parseInt(new URLSearchParams(window.location.search).get('fiscal_year') ?? '', 10);
    if (Number.isFinite(n) && n >= 2000 && n <= 2100) return n;
  }
  return new Date().getFullYear();
}

export function BudgetScopeProvider({ children }: { children: ReactNode }) {
  const { activeCompanyId } = useActiveCompany();
  const [locationId, setLoc] = useState<string>(() => (isSpecificCompany(activeCompanyId) ? activeCompanyId : ''));
  const [touched, setTouched] = useState(false);
  const [fiscalYear, setFiscalYear] = useState<number>(initialFy);
  const [versionId, setVersionId] = useState<string | null>(null);

  useEffect(() => {
    if (!touched && isSpecificCompany(activeCompanyId) && activeCompanyId !== locationId) setLoc(activeCompanyId);
  }, [activeCompanyId, touched, locationId]);

  const { data: rawLocs } = useQuery<LocationLite[]>('/api/locations');
  const locations = useMemo(() => rawLocs ?? [], [rawLocs]);
  useEffect(() => {
    if (!locationId && locations.length === 1) setLoc(locations[0].id);
  }, [locationId, locations]);

  const q = useQuery<VersionsResponse>(locationId ? '/api/budgets/versions' : null, { location_id: locationId, fiscal_year: String(fiscalYear) });
  const versions = useMemo(() => q.data?.versions ?? [], [q.data]);

  // Keep a valid selection: the chosen one, else the published one, else the newest.
  useEffect(() => {
    if (versions.length === 0) {
      if (versionId !== null) setVersionId(null);
      return;
    }
    if (versionId && versions.some((v) => v.id === versionId)) return;
    setVersionId((versions.find((v) => v.isCurrent) ?? versions[0]).id);
  }, [versions, versionId]);

  const value: BudgetScope = {
    locations,
    locationId,
    setLocationId: (id) => {
      setTouched(true);
      setLoc(id);
      setVersionId(null);
    },
    fiscalYear,
    setFiscalYear: (y) => {
      setFiscalYear(y);
      setVersionId(null);
    },
    versions,
    version: versions.find((v) => v.id === versionId) ?? null,
    versionId,
    setVersionId,
    access: q.data?.access ?? null,
    departments: q.data?.departments ?? [],
    loading: q.isLoading,
    error: q.error,
    refetch: q.refetch,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Company + fiscal-year pickers. */
export function ScopeBar({ children }: { children?: ReactNode }) {
  const sc = useBudgetScope();
  return (
    <div className={s.bar}>
      <Field label="Company" className={s.wide}>
        <Select value={sc.locationId} onChange={(e) => sc.setLocationId(e.target.value)}>
          <option value="">Choose a company…</option>
          {sc.locations.map((l) => (
            <option key={l.id} value={l.id}>{l.short_code} · {l.name}</option>
          ))}
        </Select>
      </Field>
      <Field label="Fiscal year">
        <Select value={String(sc.fiscalYear)} onChange={(e) => sc.setFiscalYear(parseInt(e.target.value, 10))}>
          {Array.from(new Set([...fiscalYears(), sc.fiscalYear])).sort((a, b) => b - a).map((y) => (
            <option key={y} value={y}>FY {y}</option>
          ))}
        </Select>
      </Field>
      {children}
    </div>
  );
}
