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
  ohRateCents: number; // per hour
  effectiveDate: string;
}

/**
 * Calculate the monthly overhead rate.
 *
 * Formula:
 *   Shared Pool = Total Merit 6000-series OpEx
 *     - 10% × Owner Group burdened cost
 *     - 100% × Deal Team burdened cost
 *     - 100% × Direct Assigned burdened cost
 *
 *   Billing Capacity = Production Employees × 150 hrs/month
 *   OH Rate = Shared Pool ÷ Capacity
 *
 *   Burdened Cost = (Annual Salary / 12) + 7.65% FICA + 3.50% WC + $680/mo benefits
 *     or: (Hourly × 150hrs) + 7.65% FICA + 3.50% WC + $680/mo benefits
 */
export async function calculateOverheadRate(
  supabase: SupabaseClient,
  orgId: string,
  year: number,
  month: number,
): Promise<OverheadRateResult> {
  // Get all active employees
  const { data: employees } = await supabase
    .from('employees')
    .select('id, labor_type, hourly_rate_cents, annual_salary_cents, fica_rate, wc_rate, benefits_monthly_cents, owner_pool_retention_pct, direct_assigned_allocation_pct')
    .eq('org_id', orgId)
    .eq('is_active', true);

  if (!employees || employees.length === 0) {
    return {
      totalOpexCents: 0, ownerExcludedCents: 0, dealTeamExcludedCents: 0,
      directAssignedExcludedCents: 0, sharedPoolCents: 0,
      productionCount: 0, hoursPerEmployee: 150, totalCapacityHours: 0,
      ohRateCents: 0, effectiveDate: `${year}-${String(month).padStart(2, '0')}-01`,
    };
  }

  // Calculate burdened cost per employee
  function burdenedCost(emp: typeof employees[0]): number {
    const monthlyBase = emp.annual_salary_cents
      ? Math.round(emp.annual_salary_cents / 12)
      : (emp.hourly_rate_cents ?? 0) * 150;

    const fica = Math.round(monthlyBase * (emp.fica_rate ?? 0.0765));
    const wc = Math.round(monthlyBase * (emp.wc_rate ?? 0.035));
    const benefits = emp.benefits_monthly_cents ?? 68000;

    return monthlyBase + fica + wc + benefits;
  }

  // Get total Merit OpEx from GL (6000-series accounts)
  // For now, calculate from employee burdened costs as proxy
  // In production, this would sum from gl_entry_lines for 6000-series accounts
  const totalOpexCents = employees.reduce((sum, emp) => sum + burdenedCost(emp), 0);

  // Calculate exclusions by labor type
  let ownerExcludedCents = 0;
  let dealTeamExcludedCents = 0;
  let directAssignedExcludedCents = 0;
  let productionCount = 0;

  for (const emp of employees) {
    const burdened = burdenedCost(emp);

    switch (emp.labor_type) {
      case 'OWNER_GROUP':
        // 10% stays in pool, 90% excluded
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
        // Stays in pool — absorbed
        break;
    }
  }

  const sharedPoolCents = totalOpexCents - ownerExcludedCents - dealTeamExcludedCents - directAssignedExcludedCents;
  const hoursPerEmployee = 150;
  const totalCapacityHours = productionCount * hoursPerEmployee;
  const ohRateCents = totalCapacityHours > 0 ? Math.round(sharedPoolCents / totalCapacityHours) : 0;

  return {
    totalOpexCents,
    ownerExcludedCents,
    dealTeamExcludedCents,
    directAssignedExcludedCents,
    sharedPoolCents,
    productionCount,
    hoursPerEmployee,
    totalCapacityHours,
    ohRateCents,
    effectiveDate: `${year}-${String(month).padStart(2, '0')}-01`,
  };
}

/**
 * Calculate an employee's bill rate.
 * Bill Rate = Hourly Rate + OH Rate
 */
export function calculateBillRate(hourlyRateCents: number, ohRateCents: number): number {
  return hourlyRateCents + ohRateCents;
}

/**
 * Determine GL classification for a time entry.
 *
 * Rules:
 *   - Office departments (ALWAYS_OPEX): Always OpEx
 *   - Field departments (BY_JOB_MATCH):
 *     - Customer ≠ Job → COGS
 *     - Customer ≈ Job → OpEx
 *     - No job → OpEx
 *   - Controller can override to Capitalize
 */
export function classifyTimeEntry(
  deptGlClassification: string,
  hasJob: boolean,
  isCustomerJob: boolean, // customer is the same entity
): 'COGS' | 'OPEX' {
  if (deptGlClassification === 'ALWAYS_OPEX') return 'OPEX';
  if (!hasJob) return 'OPEX';
  if (isCustomerJob) return 'OPEX'; // internal work
  return 'COGS'; // customer project
}
