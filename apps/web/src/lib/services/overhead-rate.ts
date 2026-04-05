import { SupabaseClient } from '@supabase/supabase-js';

export interface OverheadRateResult {
  totalOpexCents: number;
  ownerExcludedCents: number;
  dealTeamExcludedCents: number;
  directAssignedExcludedCents: number;
  sharedPoolCents: number;
  productionCount: number;
  hoursPerEmployee: number;
  totalCapacityHours: number;
  ohRateCents: number;
  effectiveDate: string;
}

interface EmployeeRow {
  id: string;
  labor_type: string;
  hourly_rate_cents: number | null;
  annual_salary_cents: number | null;
  fica_rate: number | null;
  wc_rate: number | null;
  benefits_monthly_cents: number | null;
  owner_pool_retention_pct: number | null;
  direct_assigned_allocation_pct: number | null;
}

export async function calculateOverheadRate(
  supabase: SupabaseClient,
  orgId: string,
  year: number,
  month: number,
): Promise<OverheadRateResult> {
  const { data } = await supabase
    .from('employees')
    .select('id, labor_type, hourly_rate_cents, annual_salary_cents, fica_rate, wc_rate, benefits_monthly_cents, owner_pool_retention_pct, direct_assigned_allocation_pct')
    .eq('org_id', orgId)
    .eq('is_active', true);

  const employees: EmployeeRow[] = (data ?? []) as EmployeeRow[];

  if (employees.length === 0) {
    return {
      totalOpexCents: 0, ownerExcludedCents: 0, dealTeamExcludedCents: 0,
      directAssignedExcludedCents: 0, sharedPoolCents: 0,
      productionCount: 0, hoursPerEmployee: 150, totalCapacityHours: 0,
      ohRateCents: 0, effectiveDate: `${year}-${String(month).padStart(2, '0')}-01`,
    };
  }

  function burdenedCost(emp: EmployeeRow): number {
    const monthlyBase = emp.annual_salary_cents
      ? Math.round(emp.annual_salary_cents / 12)
      : (emp.hourly_rate_cents ?? 0) * 150;

    const fica = Math.round(monthlyBase * (emp.fica_rate ?? 0.0765));
    const wc = Math.round(monthlyBase * (emp.wc_rate ?? 0.035));
    const benefits = emp.benefits_monthly_cents ?? 68000;

    return monthlyBase + fica + wc + benefits;
  }

  const totalOpexCents = employees.reduce((sum, emp) => sum + burdenedCost(emp), 0);

  let ownerExcludedCents = 0;
  let dealTeamExcludedCents = 0;
  let directAssignedExcludedCents = 0;
  let productionCount = 0;

  for (const emp of employees) {
    const burdened = burdenedCost(emp);
    switch (emp.labor_type) {
      case 'OWNER_GROUP':
        ownerExcludedCents += Math.round(burdened * (1 - (emp.owner_pool_retention_pct ?? 10) / 100));
        break;
      case 'DEAL_TEAM':
        dealTeamExcludedCents += burdened;
        break;
      case 'DIRECT_ASSIGNED':
        directAssignedExcludedCents += burdened;
        break;
      case 'PRODUCTION':
        productionCount++;
        break;
      case 'OVERHEAD':
        break;
    }
  }

  const sharedPoolCents = totalOpexCents - ownerExcludedCents - dealTeamExcludedCents - directAssignedExcludedCents;
  const hoursPerEmployee = 150;
  const totalCapacityHours = productionCount * hoursPerEmployee;
  const ohRateCents = totalCapacityHours > 0 ? Math.round(sharedPoolCents / totalCapacityHours) : 0;

  return {
    totalOpexCents, ownerExcludedCents, dealTeamExcludedCents,
    directAssignedExcludedCents, sharedPoolCents,
    productionCount, hoursPerEmployee, totalCapacityHours,
    ohRateCents, effectiveDate: `${year}-${String(month).padStart(2, '0')}-01`,
  };
}

export function calculateBillRate(hourlyRateCents: number, ohRateCents: number): number {
  return hourlyRateCents + ohRateCents;
}

export function classifyTimeEntry(
  deptGlClassification: string,
  hasJob: boolean,
  isCustomerJob: boolean,
): 'COGS' | 'OPEX' {
  if (deptGlClassification === 'ALWAYS_OPEX') return 'OPEX';
  if (!hasJob) return 'OPEX';
  if (isCustomerJob) return 'OPEX';
  return 'COGS';
}
