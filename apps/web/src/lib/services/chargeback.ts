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

/** Supabase FK joins return arrays. Extract first element safely. */
function fkFirst<T>(val: unknown): T | null {
  if (Array.isArray(val)) return (val[0] as T) ?? null;
  return (val as T) ?? null;
}

export async function generateChargebackInvoices(
  supabase: SupabaseClient,
  orgId: string,
  year: number,
  month: number,
): Promise<ChargebackInvoiceData[]> {
  const ohRate = await calculateOverheadRate(supabase, orgId, year, month);

  const { data: locations } = await supabase
    .from('locations')
    .select('id, name, short_code')
    .eq('org_id', orgId)
    .eq('is_active', true);

  if (!locations) return [];

  const meritLocation = locations.find((l) => l.short_code === 'MMG');
  if (!meritLocation) return [];

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

  const { data: sharedRules } = await supabase
    .from('shared_cost_rules')
    .select('*')
    .eq('org_id', orgId)
    .eq('is_active', true);

  const invoices: ChargebackInvoiceData[] = [];

  for (const location of locations) {
    if (location.id === meritLocation.id) continue;

    const lineItems: ChargebackLineItem[] = [];
    let cogsLaborCents = 0;
    let opexLaborCents = 0;
    const cogsExpensesCents = 0;
    const opexExpensesCents = 0;
    let sharedCostsCents = 0;
    const directAssignedCents = 0;

    for (const entry of (timeEntries ?? [])) {
      if (entry.location_id !== location.id) continue;
      if (!entry.total_hours || entry.total_hours <= 0) continue;

      const emp = fkFirst<{ first_name: string; last_name: string; hourly_rate_cents: number; labor_type: string }>(entry.employees);
      const dept = fkFirst<{ name: string; gl_classification: string }>(entry.departments);

      if (!emp || emp.labor_type !== 'PRODUCTION') continue;

      const glClass = classifyTimeEntry(
        dept?.gl_classification ?? 'ALWAYS_OPEX',
        !!entry.job_id,
        false,
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

    for (const rule of (sharedRules ?? [])) {
      const applicableLocations = rule.applicable_location_ids as string[];
      if (applicableLocations.length > 0 && !applicableLocations.includes(location.id)) continue;

      const targetCount = applicableLocations.length > 0 ? applicableLocations.length : locations.length;
      let allocationAmount = 0;

      switch (rule.allocation_method) {
        case 'EVEN_SPLIT':
        case 'BY_REVENUE_PCT':
        case 'BY_HEADCOUNT':
        default:
          allocationAmount = Math.round(rule.monthly_amount_cents / targetCount);
          break;
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
      invoices.push({
        locationId: location.id,
        locationName: location.name,
        invoiceNumber: `CB-${year}-${monthStr}15-${location.short_code}`,
        sections: { cogsLaborCents, opexLaborCents, cogsExpensesCents, opexExpensesCents, sharedCostsCents, directAssignedCents },
        totalCents,
        lineItems,
      });
    }
  }

  return invoices;
}
