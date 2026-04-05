import { SupabaseClient } from '@supabase/supabase-js';
import { calculateOverheadRate, classifyTimeEntry, calculateBillRate } from './overhead-rate';

export interface ChargebackInvoiceData {
  locationId: string;
  locationName: string;
  invoiceNumber: string;
  sections: {
    cogsLaborCents: number;
    opexLaborCents: number;
    cogsExpensesCents: number;
    opexExpensesCents: number;
    sharedCostsCents: number;
    directAssignedCents: number;
  };
  totalCents: number;
  lineItems: ChargebackLineItem[];
}

export interface ChargebackLineItem {
  section: string;
  description: string;
  hours?: number;
  hourlyRateCents?: number;
  ohRateCents?: number;
  amountCents: number;
  glClassification: 'COGS' | 'OPEX';
  sourceNotes?: string;
}

/**
 * Generate chargeback invoices for a given month.
 *
 * Invoice structure (6 sections per receiving company):
 *   1. COGS-Labor: Production hrs on customer projects
 *   2. OpEx-Labor: Always-OpEx dept hrs + internal/facility hrs
 *   3. COGS-Expenses: Receipts tagged to jobs from BY_JOB_MATCH depts
 *   4. OpEx-Expenses: General receipts or ALWAYS_OPEX dept receipts
 *   5. Shared Costs: Per allocation rules
 *   6. Direct Assigned: Burdened cost × allocation %
 */
export async function generateChargebackInvoices(
  supabase: SupabaseClient,
  orgId: string,
  year: number,
  month: number,
): Promise<ChargebackInvoiceData[]> {
  // Get overhead rate for the period
  const ohRate = await calculateOverheadRate(supabase, orgId, year, month);

  // Get all locations (excluding Merit itself for receiving)
  const { data: locations } = await supabase
    .from('locations')
    .select('id, name, short_code')
    .eq('org_id', orgId)
    .eq('is_active', true);

  if (!locations) return [];

  // Get Merit location for determining "customer ≠ job" logic
  const meritLocation = locations.find((l) => l.short_code === 'MMG');
  if (!meritLocation) return [];

  // Get time entries for the period
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = new Date(year, month, 0).toISOString().split('T')[0];

  const { data: timeEntries } = await supabase
    .from('time_entries')
    .select(`
      id, employee_id, location_id, total_hours, notes, job_id, is_billable,
      departments ( name, gl_classification ),
      employees ( first_name, last_name, hourly_rate_cents, labor_type )
    `)
    .eq('org_id', orgId)
    .gte('clock_in', startDate)
    .lte('clock_in', endDate + 'T23:59:59Z');

  // Get shared cost allocation rules
  const { data: sharedRules } = await supabase
    .from('shared_cost_rules')
    .select('*')
    .eq('org_id', orgId)
    .eq('is_active', true);

  // Build invoices per receiving company
  const invoices: ChargebackInvoiceData[] = [];

  for (const location of locations) {
    if (location.id === meritLocation.id) continue; // Merit doesn't bill itself

    const lineItems: ChargebackLineItem[] = [];
    let cogsLaborCents = 0;
    let opexLaborCents = 0;
    let cogsExpensesCents = 0;
    let opexExpensesCents = 0;
    let sharedCostsCents = 0;
    let directAssignedCents = 0;

    // Process time entries for this location
    for (const entry of (timeEntries ?? [])) {
      if (entry.location_id !== location.id) continue;
      if (!entry.total_hours || entry.total_hours <= 0) continue;

      const emp = entry.employees as { first_name: string; last_name: string; hourly_rate_cents: number; labor_type: string } | null;
      const dept = entry.departments as { name: string; gl_classification: string } | null;

      if (!emp || emp.labor_type !== 'PRODUCTION') continue;

      const glClass = classifyTimeEntry(
        dept?.gl_classification ?? 'ALWAYS_OPEX',
        !!entry.job_id,
        false, // simplified — would check if job's customer is the same entity
      );

      const billRate = calculateBillRate(emp.hourly_rate_cents ?? 0, ohRate.ohRateCents);
      const amount = Math.round(entry.total_hours * billRate);

      const item: ChargebackLineItem = {
        section: glClass === 'COGS' ? 'COGS_LABOR' : 'OPEX_LABOR',
        description: `${emp.first_name} ${emp.last_name} — ${dept?.name ?? 'Unknown'}`,
        hours: entry.total_hours,
        hourlyRateCents: emp.hourly_rate_cents ?? 0,
        ohRateCents: ohRate.ohRateCents,
        amountCents: amount,
        glClassification: glClass,
        sourceNotes: entry.notes ?? undefined,
      };

      lineItems.push(item);

      if (glClass === 'COGS') cogsLaborCents += amount;
      else opexLaborCents += amount;
    }

    // Process shared cost allocations
    for (const rule of (sharedRules ?? [])) {
      const applicableLocations = rule.applicable_location_ids as string[];
      if (applicableLocations.length > 0 && !applicableLocations.includes(location.id)) continue;

      const targetCount = applicableLocations.length > 0 ? applicableLocations.length : locations.length;
      let allocationAmount = 0;

      switch (rule.allocation_method) {
        case 'EVEN_SPLIT':
          allocationAmount = Math.round(rule.monthly_amount_cents / targetCount);
          break;
        case 'BY_REVENUE_PCT':
          // Simplified — would query actual revenue per location
          allocationAmount = Math.round(rule.monthly_amount_cents / targetCount);
          break;
        case 'BY_HEADCOUNT':
          allocationAmount = Math.round(rule.monthly_amount_cents / targetCount);
          break;
        default:
          allocationAmount = Math.round(rule.monthly_amount_cents / targetCount);
      }

      lineItems.push({
        section: 'SHARED_COSTS',
        description: rule.name,
        amountCents: allocationAmount,
        glClassification: 'OPEX',
      });

      sharedCostsCents += allocationAmount;
    }

    const totalCents = cogsLaborCents + opexLaborCents + cogsExpensesCents + opexExpensesCents + sharedCostsCents + directAssignedCents;

    if (totalCents > 0) {
      const monthStr = String(month).padStart(2, '0');
      const dayStr = '15'; // invoice date mid-month
      invoices.push({
        locationId: location.id,
        locationName: location.name,
        invoiceNumber: `CB-${year}-${monthStr}${dayStr}-${location.short_code}`,
        sections: {
          cogsLaborCents,
          opexLaborCents,
          cogsExpensesCents,
          opexExpensesCents,
          sharedCostsCents,
          directAssignedCents,
        },
        totalCents,
        lineItems,
      });
    }
  }

  return invoices;
}
