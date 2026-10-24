/**
 * Recommended department budget templates (system set, Wave 4B — FPB-reports-fpna §4.4 / §4.11).
 *
 * Every line selects accounts BY TYPE / SUB-TYPE / GROUP / NAME (canon §2: the COA is per tenant;
 * never an account number). A line that matches nothing in a tenant's chart is reported as "not in
 * your chart" and skipped. Default drivers: amounts cents, rates basis points.
 *
 * A tenant edits any of these into a tenant template (public.budget_templates, versioned).
 */
import type { BudgetTemplate, TemplateLine } from '../types';

const PY = (growthBps: number) => ({ method: 'PY_GROWTH' as const, params: { growthBps } });

const salaries = (label = 'Salaries & wages'): TemplateLine => ({
  key: 'salaries', label, selector: { types: ['OPEX'], name: 'salar|wage', notName: 'payable|accrued' },
  ...PY(400), bridgeDriver: 'HEADCOUNT', required: true, note: 'Headcount × monthly rate if you know it; otherwise last year + raises.',
});
const payrollTaxes: TemplateLine = {
  key: 'payroll_taxes', label: 'Payroll taxes & benefits', selector: { types: ['OPEX'], name: 'payroll tax|benefit|health|401|workers*comp' },
  ...PY(500), bridgeDriver: 'HEADCOUNT',
};
const travel: TemplateLine = {
  key: 'travel', label: 'Travel & meals', selector: { types: ['OPEX'], name: 'travel|meal|entertain' }, ...PY(300),
};
const software: TemplateLine = {
  key: 'software', label: 'Software & subscriptions', selector: { types: ['OPEX'], group: 'tech', name: 'software|subscription|saas|licen' }, ...PY(800),
};
const training: TemplateLine = {
  key: 'training', label: 'Training & education', selector: { types: ['OPEX'], name: 'training|education|seminar' }, ...PY(0),
};
const vehicles: TemplateLine = {
  key: 'vehicles', label: 'Vehicles & fuel', selector: { types: ['OPEX', 'COGS'], group: 'vehicle', name: 'vehicle|fuel|auto|truck' }, ...PY(400),
};
const tools: TemplateLine = {
  key: 'tools', label: 'Small tools & equipment', selector: { types: ['OPEX', 'COGS'], name: 'tool|equipment|supplies' }, ...PY(300),
};

export const SYSTEM_TEMPLATES: readonly BudgetTemplate[] = [
  {
    id: 'system:sales', scope: 'system', key: 'sales', version: 1, name: 'Sales', departmentKind: 'SALES', basedOn: null,
    description: 'Reps, commissions and the cost of selling. Commissions follow the revenue the department brings in.',
    lines: [
      { key: 'revenue', label: 'Revenue this team sells', selector: { types: ['REVENUE'], notName: 'interdep|intercompany|elimin' }, ...PY(600), bridgeDriver: 'AUTO', required: true },
      salaries('Sales salaries'),
      { key: 'commissions', label: 'Commissions', selector: { types: ['OPEX', 'COGS'], name: 'commission' }, method: 'PCT_OF_REVENUE', params: { pctBps: 500 }, bridgeDriver: 'VOLUME', note: 'Quota × commission rate — set the rate as % of revenue.' },
      payrollTaxes, travel,
      { key: 'crm', label: 'CRM & sales tools', selector: { types: ['OPEX'], name: 'crm|software|subscription' }, ...PY(800) },
      { key: 'samples', label: 'Samples & demos', selector: { types: ['OPEX'], name: 'sample|demo|display' }, ...PY(0) },
      training,
    ],
    kpis: ['Revenue per rep', 'Close rate', 'Average ticket', 'Commission % of revenue'],
  },
  {
    id: 'system:marketing', scope: 'system', key: 'marketing', version: 1, name: 'Marketing', departmentKind: 'MARKETING', basedOn: null,
    description: 'Lead generation and brand. Spend capped as a share of revenue and weighted to the busy season.',
    lines: [
      { key: 'paid_ads', label: 'Paid search & local service ads', selector: { types: ['OPEX'], group: 'marketing', name: 'advertis|ads|search|ppc|google|lead' }, method: 'PCT_OF_REVENUE', params: { pctBps: 300 }, bridgeDriver: 'VOLUME', required: true, note: 'Leads target × cost per lead, or a % of revenue cap.' },
      { key: 'seo', label: 'SEO, website & content', selector: { types: ['OPEX'], name: 'seo|website|web|content' }, ...PY(500) },
      { key: 'print', label: 'Print & direct mail', selector: { types: ['OPEX'], name: 'print|mail|postage|brochure' }, ...PY(0) },
      { key: 'events', label: 'Events & home shows', selector: { types: ['OPEX'], name: 'event|show|sponsor|trade' }, ...PY(0) },
      { key: 'brand', label: 'Brand & creative / agency fees', selector: { types: ['OPEX'], group: 'marketing', name: 'brand|creative|agency|marketing' }, ...PY(300) },
      software,
    ],
    kpis: ['Cost per lead', 'Leads', 'Marketing % of revenue', 'Booked jobs per lead'],
  },
  {
    id: 'system:operations', scope: 'system', key: 'operations', version: 1, name: 'Operations / Field', departmentKind: 'OPERATIONS', basedOn: null,
    description: 'Crews in the field: labor, materials, subcontract, vehicles. Scales with jobs.',
    lines: [
      { key: 'revenue', label: 'Job revenue', selector: { types: ['REVENUE'], notName: 'interdep|intercompany|elimin' }, ...PY(500) },
      { key: 'field_labor', label: 'Field labor', selector: { types: ['COGS'], group: 'labor', name: 'labor|wage|payroll' }, ...PY(400), bridgeDriver: 'HEADCOUNT', required: true, note: 'Jobs × hours per job × loaded rate.' },
      { key: 'materials', label: 'Materials', selector: { types: ['COGS'], group: 'material', name: 'material|equipment|parts' }, method: 'PCT_OF_REVENUE', params: { pctBps: 3500 }, bridgeDriver: 'VOLUME', required: true },
      { key: 'subcontract', label: 'Subcontractors', selector: { types: ['COGS'], name: 'subcontract|sub-contract|contract labor' }, ...PY(300) },
      { key: 'permits', label: 'Permits & disposal', selector: { types: ['COGS', 'OPEX'], name: 'permit|dump|disposal|haul' }, ...PY(300) },
      vehicles, tools,
      { key: 'warranty', label: 'Warranty & callbacks', selector: { types: ['COGS', 'OPEX'], name: 'warrant|callback|rework' }, ...PY(0) },
    ],
    kpis: ['Gross margin %', 'Labor % of revenue', 'Materials % of revenue', 'Revenue per crew'],
  },
  {
    id: 'system:service', scope: 'system', key: 'service', version: 1, name: 'Service', departmentKind: 'SERVICE', basedOn: null,
    description: 'Service calls and maintenance agreements: techs, parts, trucks, dispatch.',
    lines: [
      { key: 'service_revenue', label: 'Service revenue', selector: { types: ['REVENUE'], group: 'service', name: 'service|repair|maint' }, ...PY(600), required: true, note: 'Calls a month × average ticket.' },
      { key: 'agreements', label: 'Maintenance agreements', selector: { types: ['REVENUE'], name: 'agreement|membership|contract' }, ...PY(800) },
      { key: 'tech_labor', label: 'Technician labor', selector: { types: ['COGS'], group: 'labor', name: 'labor|wage|tech' }, ...PY(400), bridgeDriver: 'HEADCOUNT', required: true },
      { key: 'parts', label: 'Parts used', selector: { types: ['COGS'], name: 'part|material|supplies' }, method: 'PCT_OF_REVENUE', params: { pctBps: 2200 }, bridgeDriver: 'VOLUME' },
      vehicles,
      { key: 'dispatch', label: 'Dispatch & scheduling', selector: { types: ['OPEX'], name: 'dispatch|schedul|answering|call center' }, ...PY(300) },
      tools,
    ],
    kpis: ['Billable hours %', 'Callbacks %', 'Average ticket', 'Agreements renewed %'],
  },
  {
    id: 'system:parts', scope: 'system', key: 'parts', version: 1, name: 'Parts', departmentKind: 'PARTS', basedOn: null,
    description: 'Parts counter and inventory: sales, cost of parts, freight, shrink.',
    lines: [
      { key: 'parts_revenue', label: 'Parts sales', selector: { types: ['REVENUE'], group: 'product|parts', name: 'part|product|sales' }, ...PY(500), required: true },
      { key: 'parts_cost', label: 'Cost of parts sold', selector: { types: ['COGS'], name: 'part|material|cost of goods|product' }, method: 'PCT_OF_REVENUE', params: { pctBps: 6500 }, bridgeDriver: 'VOLUME', required: true },
      { key: 'freight', label: 'Freight in', selector: { types: ['COGS', 'OPEX'], name: 'freight|shipping|delivery' }, ...PY(300) },
      { key: 'shrink', label: 'Inventory shrink & obsolescence', selector: { types: ['COGS', 'OPEX'], name: 'shrink|obsolete|inventory adj' }, ...PY(0) },
      salaries('Parts staff'),
    ],
    kpis: ['Parts margin %', 'Inventory turns', 'Fill rate'],
  },
  {
    id: 'system:shop', scope: 'system', key: 'shop', version: 1, name: 'Shop / Production', departmentKind: 'SHOP', basedOn: null,
    description: 'The shop floor: production labor, materials per unit, consumables, machine upkeep.',
    lines: [
      { key: 'production_labor', label: 'Production labor', selector: { types: ['COGS'], group: 'labor', name: 'labor|wage|production' }, ...PY(400), bridgeDriver: 'HEADCOUNT', required: true, note: 'Units × labor hours per unit × rate.' },
      { key: 'materials', label: 'Materials', selector: { types: ['COGS'], group: 'material', name: 'material|lumber|sheet|hardware' }, method: 'UNITS_RATE', params: { unitsPerMonth: 0, rateCents: 0, growthBps: 0 }, bridgeDriver: 'VOLUME', required: true, note: 'Units a month × material cost per unit.' },
      { key: 'consumables', label: 'Consumables', selector: { types: ['COGS', 'OPEX'], name: 'consumabl|supplies|finish|glue|abrasive' }, ...PY(300) },
      { key: 'machine', label: 'Machine maintenance', selector: { types: ['OPEX', 'COGS'], name: 'repair|maint|machine' }, ...PY(300) },
      { key: 'freight_in', label: 'Freight in', selector: { types: ['COGS', 'OPEX'], name: 'freight|shipping' }, ...PY(300) },
      { key: 'utilities', label: 'Shop utilities', selector: { types: ['OPEX'], group: 'occupancy', name: 'utilit|electric|gas' }, ...PY(400) },
    ],
    kpis: ['Units per week', 'Material $ per unit', 'Yield %', 'On-time %'],
  },
  {
    id: 'system:construction_pm', scope: 'system', key: 'construction_pm', version: 1, name: 'Construction PM', departmentKind: 'CONSTRUCTION_PM', basedOn: null,
    description: 'Project management and estimating: PM salaries, site costs, insurance, bonding, warranty.',
    lines: [
      { key: 'contract_revenue', label: 'Contract revenue', selector: { types: ['REVENUE'], notName: 'interdep|intercompany|elimin' }, ...PY(500), note: 'Homes / projects × average contract, by expected close month.' },
      salaries('PM & superintendent salaries'),
      payrollTaxes,
      { key: 'subcontract', label: 'Subcontractors', selector: { types: ['COGS'], name: 'subcontract|sub-contract' }, method: 'PCT_OF_REVENUE', params: { pctBps: 5500 }, bridgeDriver: 'VOLUME', required: true },
      { key: 'materials', label: 'Materials', selector: { types: ['COGS'], group: 'material', name: 'material|lumber' }, method: 'PCT_OF_REVENUE', params: { pctBps: 2000 }, bridgeDriver: 'VOLUME' },
      { key: 'site', label: 'Site costs, permits & dumpsters', selector: { types: ['COGS', 'OPEX'], name: 'permit|site|dump|portable' }, ...PY(300) },
      { key: 'insurance', label: 'Builder’s risk, GL insurance & bonding', selector: { types: ['OPEX'], group: 'insurance', name: 'insurance|bond' }, ...PY(600) },
      { key: 'warranty', label: 'Warranty reserve', selector: { types: ['COGS', 'OPEX'], name: 'warrant' }, ...PY(0) },
    ],
    kpis: ['Gross margin per project', 'Change-order %', 'Months per build', 'Backlog'],
  },
  {
    id: 'system:admin', scope: 'system', key: 'admin', version: 1, name: 'Admin & G&A', departmentKind: 'ADMIN', basedOn: null,
    description: 'Office, occupancy, insurance and professional fees — mostly fixed, from contracts and renewals.',
    lines: [
      salaries('Office salaries'),
      payrollTaxes,
      { key: 'rent', label: 'Rent', selector: { types: ['OPEX'], group: 'occupancy', name: 'rent|lease' }, method: 'FIXED_MONTHLY', params: { monthlyCents: 0 }, bridgeDriver: 'INFLATION', required: true, note: 'From the lease schedule.' },
      { key: 'utilities', label: 'Utilities & telecom', selector: { types: ['OPEX'], name: 'utilit|electric|phone|internet|telecom' }, ...PY(400) },
      { key: 'insurance', label: 'Insurance', selector: { types: ['OPEX'], group: 'insurance', name: 'insurance' }, ...PY(800), note: 'From the renewal quotes.' },
      { key: 'professional', label: 'Professional fees', selector: { types: ['OPEX'], group: 'professional', name: 'legal|accounting|professional|consult' }, ...PY(300) },
      { key: 'office', label: 'Office supplies & postage', selector: { types: ['OPEX'], group: 'office', name: 'office|supplies|postage' }, ...PY(200) },
      software,
      { key: 'bank_fees', label: 'Bank & merchant fees', selector: { types: ['OPEX', 'OTHER'], name: 'bank|merchant|card fee|processing' }, method: 'PCT_OF_REVENUE', params: { pctBps: 150 }, bridgeDriver: 'VOLUME' },
    ],
    kpis: ['G&A % of revenue', 'Rent % of revenue'],
  },
  {
    id: 'system:executive', scope: 'system', key: 'executive', version: 1, name: 'Executive', departmentKind: 'EXECUTIVE', basedOn: null,
    description: 'Leadership comp, governance, recruiting and management fees as booked (never allocated).',
    lines: [
      { key: 'exec_comp', label: 'Executive compensation', selector: { types: ['OPEX'], name: 'officer|executive|owner|salar' }, method: 'HEADCOUNT_RATE', params: { headcount: 1, monthlyRateCents: 0, burdenBps: 1500, startMonth: 1 }, bridgeDriver: 'HEADCOUNT', required: true },
      { key: 'governance', label: 'Board & governance', selector: { types: ['OPEX'], name: 'board|governance|director' }, ...PY(0) },
      travel,
      { key: 'recruiting', label: 'Recruiting', selector: { types: ['OPEX'], name: 'recruit|hiring|job post' }, ...PY(0) },
      { key: 'mgmt_fees', label: 'Management fees (as booked)', selector: { types: ['OPEX'], name: 'management fee' }, method: 'FIXED_MONTHLY', params: { monthlyCents: 0 }, bridgeDriver: 'INFLATION' },
    ],
    kpis: ['EBITDA margin', 'Revenue per employee'],
  },
  {
    id: 'system:finance', scope: 'system', key: 'finance', version: 1, name: 'Finance & accounting', departmentKind: 'FINANCE', basedOn: null,
    description: 'The finance team: staff, audit and tax fees, accounting software, bank and card fees.',
    lines: [
      salaries('Finance staff'),
      payrollTaxes,
      { key: 'audit_tax', label: 'Audit & tax fees', selector: { types: ['OPEX'], group: 'professional', name: 'audit|tax prep|accounting|cpa' }, ...PY(400), note: 'From the engagement letters.' },
      { key: 'acct_software', label: 'Accounting software', selector: { types: ['OPEX'], group: 'tech', name: 'software|subscription' }, ...PY(800) },
      { key: 'bank_fees', label: 'Bank & card fees', selector: { types: ['OPEX', 'OTHER'], name: 'bank|merchant|card fee|processing' }, ...PY(300) },
    ],
    kpis: ['Days to close', 'Finance cost % of revenue'],
  },
];

export function systemTemplate(key: string): BudgetTemplate | null {
  return SYSTEM_TEMPLATES.find((t) => t.key === key) ?? null;
}

/** Suggest a system template from a department's name / code ("Install" → operations). */
export function suggestTemplateKey(name: string, code = ''): string {
  const s = `${name} ${code}`.toLowerCase();
  if (/market|advertis|brand/.test(s)) return 'marketing';
  if (/sales|business dev|estimat/.test(s)) return 'sales';
  if (/service|maint|repair/.test(s)) return 'service';
  if (/parts|counter|inventory/.test(s)) return 'parts';
  if (/shop|production|manufact|mill|cabinet/.test(s)) return 'shop';
  if (/construct|project|build|pm\b|site/.test(s)) return 'construction_pm';
  if (/exec|owner|leader|ceo/.test(s)) return 'executive';
  if (/financ|account|book/.test(s)) return 'finance';
  if (/admin|office|g&a|general|hr/.test(s)) return 'admin';
  return 'operations';
}
