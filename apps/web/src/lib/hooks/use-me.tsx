'use client';

import { useState, useEffect, useCallback, createContext, useContext, type ReactNode } from 'react';
import type { UserRole, FeatureAction, PayrollVisibility, CompanyScope, SidebarItem } from '@/lib/rbac/permissions';

export interface MeUser {
  clerkId: string;
  employeeId: string | null;
  firstName: string;
  lastName: string;
  email: string;
  role: UserRole | null;
  roleLabel: string;
  roleDescription: string;
  laborType: string | null;
  isActive: boolean;
  hasEmployeeRecord: boolean;
  mfaRequired: boolean;
  companyScope: CompanyScope;
  payrollVisibility: PayrollVisibility;
  canManageUsers: boolean;
  canEditAccountingSettings: boolean;
  canEditSystemSettings: boolean;
}

export interface MeContextValue {
  loading: boolean;
  authenticated: boolean;
  hasOrg: boolean;
  setupComplete: boolean;
  orgId: string | null;
  orgName: string | null;
  user: MeUser | null;
  permissions: {
    visibleFeatures: string[];
    featurePermissions: Record<string, Record<string, boolean>>;
  } | null;
  sidebar: Record<string, SidebarItem[]>;
  locations: Array<{ id: string; name: string; code: string }>;
  // Helpers
  can: (featureId: string, action?: FeatureAction) => boolean;
  isAdmin: boolean;
  refresh: () => Promise<void>;
}

const MeContext = createContext<MeContextValue>({
  loading: true,
  authenticated: false,
  hasOrg: false,
  setupComplete: false,
  orgId: null,
  orgName: null,
  user: null,
  permissions: null,
  sidebar: {},
  locations: [],
  can: () => false,
  isAdmin: false,
  refresh: async () => {},
});

export function MeProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<{
    loading: boolean;
    authenticated: boolean;
    hasOrg: boolean;
    setupComplete: boolean;
    orgId: string | null;
    orgName: string | null;
    user: MeUser | null;
    permissions: MeContextValue['permissions'];
    sidebar: Record<string, SidebarItem[]>;
    locations: Array<{ id: string; name: string; code: string }>;
  }>({
    loading: true,
    authenticated: false,
    hasOrg: false,
    setupComplete: false,
    orgId: null,
    orgName: null,
    user: null,
    permissions: null,
    sidebar: {},
    locations: [],
  });

  const fetchMe = useCallback(async () => {
    try {
      const res = await fetch('/api/me');
      if (!res.ok) {
        setData((prev) => ({ ...prev, loading: false, authenticated: false }));
        return;
      }
      const json = await res.json();
      setData({
        loading: false,
        authenticated: json.authenticated ?? false,
        hasOrg: json.hasOrg ?? false,
        setupComplete: json.setupComplete ?? false,
        orgId: json.orgId ?? null,
        orgName: json.orgName ?? null,
        user: json.user ?? null,
        permissions: json.permissions ?? null,
        sidebar: json.sidebar ?? {},
        locations: json.locations ?? [],
      });
    } catch {
      setData((prev) => ({ ...prev, loading: false }));
    }
  }, []);

  useEffect(() => {
    fetchMe();
  }, [fetchMe]);

  const can = useCallback(
    (featureId: string, action: FeatureAction = 'view'): boolean => {
      if (!data.permissions) return false;
      const perms = data.permissions.featurePermissions[featureId];
      if (!perms) return false;
      return perms[action] === true;
    },
    [data.permissions]
  );

  const isAdmin = data.user?.role === 'company_admin';

  const value: MeContextValue = {
    ...data,
    can,
    isAdmin,
    refresh: fetchMe,
  };

  return <MeContext.Provider value={value}>{children}</MeContext.Provider>;
}

export function useMe(): MeContextValue {
  return useContext(MeContext);
}
