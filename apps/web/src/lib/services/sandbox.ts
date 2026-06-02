/**
 * Seeded Test Tenant (Sandbox) — Merit Enterprise Suite.
 *
 * Stands up a COA-complete, multi-entity tenant and EXERCISES the full
 * cross-module chain end-to-end through the REAL services (never raw shortcuts):
 *
 *   - Chart of accounts via the shared real seeding path (`seedChartOfAccounts`)
 *     — testing the sandbox also tests onboarding.
 *   - Two entities (locations) with different fiscal-year starts + generated
 *     periods, including a HARD_CLOSE prior-year period for the Rule-F path.
 *   - Departments, customers, vendors, items, employees.
 *   - Jobs spanning BOTH recognition methods (POC vs point-of-sale) + the
 *     per-company job_type→method map, so method-per-job resolution is exercised.
 *
 * The round-trip drives the four contract paths through the real consumers:
 *   1. Cost     — post a job-dimensioned GL cost + emit JOB_COST (Books→Projects).
 *   2. Recognize— enqueue JOB_PROGRESS, drain via processProgressEvents → rev-rec.
 *   3. Billing  — enqueue JOB_BILLING, drain via processBillingEvents → AR invoice.
 *   4. Reject   — enqueue an event on a HARD_CLOSE period; expect a clean reject.
 *
 * Single-tenant deployment: the sandbox IS the current org (created if none
 * exists). Reset clears the tenant's transactional + master data and re-seeds;
 * the COA structure, entities, and periods survive (reset = re-run the seed).
 *
 * NOTE on "reaches Projects": this repo is Books (Module 1). The JOB_COST events
 * are emitted to core.events and left `pending` for the Projects consumer
 * (Module 2), which is not deployed here. We report them as emitted/pending —
 * the honest state — rather than claiming a consumer we don't have ran.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { seedChartOfAccounts } from './coa-seed';
import { postJournalEntry } from './gl-posting';
import { emitJobCostEvent, stampGlLineJob } from './job-cost-events';
import { processProgressEvents } from './job-progress';
import { processBillingEvents } from './billing-consumer';

type DB = SupabaseClient;

const SANDBOX_TAG = '[SANDBOX]';

// Stable short codes so seeding is idempotent across re-runs.
const ENTITY_A = { name: `${SANDBOX_TAG} Northwind Construction`, short_code: 'NWC', fy_start: 1 };
const ENTITY_B = { name: `${SANDBOX_TAG} Coho Flooring`, short_code: 'CHF', fy_start: 7 };

export interface SandboxEntity {
  id: string;
  name: string;
  short_code: string;
  fiscal_year_start_month: number;
}

export interface SandboxStatus {
  hasOrg: boolean;
  orgId: string | null;
  orgName: string | null;
  accountCount: number;
  entities: SandboxEntity[];
  departmentCount: number;
  customerCount: number;
  vendorCount: number;
  itemCount: number;
  employeeCount: number;
  jobCount: number;
  openPeriods: number;
  closedPeriods: number;
  seeded: boolean; // sandbox entities present
}

export interface SeedStep {
  step: string;
  detail: string;
}

export interface SeedResult {
  orgId: string;
  steps: SeedStep[];
  status: SandboxStatus;
}

/** Path-by-path outcome of the cross-module round-trip. */
export interface RoundTripPath {
  path: 'cost' | 'recognition' | 'billing' | 'rejection';
  label: string;
  pass: boolean;
  detail: string;
}

export interface RoundTripResult {
  asOf: string;
  paths: RoundTripPath[];
  allPassed: boolean;
}

// ───────────────────────── helpers ─────────────────────────

async function resolveOrg(db: DB): Promise<{ id: string; name: string } | null> {
  const { data } = await db
    .schema('core').from('organizations')
    .select('id, name')
    .limit(1)
    .maybeSingle();
  return (data as { id: string; name: string } | null) ?? null;
}

async function ensureOrg(db: DB): Promise<{ id: string; name: string }> {
  const existing = await resolveOrg(db);
  if (existing) return existing;
  const { data, error } = await db
    .schema('core').from('organizations')
    .insert({
      name: `${SANDBOX_TAG} Sandbox Co`,
      slug: 'sandbox-co',
      timezone: 'America/Chicago',
      setup_complete: true,
      entitlements: { projects: true },
    })
    .select('id, name')
    .single();
  if (error || !data) throw new Error(`Could not create sandbox organization: ${error?.message}`);
  return data as { id: string; name: string };
}

async function acctId(db: DB, orgId: string, number: string): Promise<string | null> {
  const { data } = await db
    .from('accounts')
    .select('id')
    .eq('org_id', orgId)
    .eq('account_number', number)
    .limit(1)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

/** Lowest-numbered active account of a given type (role-based lookup, not a hard number). */
async function acctByType(
  db: DB,
  orgId: string,
  accountType: string,
  namePattern?: RegExp,
  opts: { excludeControl?: boolean } = {},
): Promise<string | null> {
  const { data } = await db
    .from('accounts')
    .select('id, name, account_number, is_control_account')
    .eq('org_id', orgId)
    .eq('account_type', accountType)
    .eq('is_active', true)
    .order('account_number', { ascending: true });
  let rows = (data ?? []) as { id: string; name: string; is_control_account: boolean }[];
  if (opts.excludeControl) rows = rows.filter((r) => !r.is_control_account);
  if (rows.length === 0) return null;
  if (namePattern) {
    const hit = rows.find((r) => namePattern.test(r.name));
    if (hit) return hit.id;
  }
  return rows[0].id;
}

/** Upsert an entity (location) by short_code; generate fiscal periods if new. */
async function ensureEntity(
  db: DB,
  orgId: string,
  spec: { name: string; short_code: string; fy_start: number; rev_rec_method: string },
): Promise<SandboxEntity> {
  const { data: existing } = await db
    .schema('core').from('locations')
    .select('id, name, short_code, fiscal_year_start_month')
    .eq('org_id', orgId)
    .eq('short_code', spec.short_code)
    .maybeSingle();

  if (existing) {
    return existing as SandboxEntity;
  }

  const { data: loc, error } = await db
    .schema('core').from('locations')
    .insert({
      org_id: orgId,
      name: spec.name,
      short_code: spec.short_code,
      industry: 'Construction',
      fiscal_year_start_month: spec.fy_start,
      rev_rec_method: spec.rev_rec_method,
      default_internal_charge_method: 'revenue',
    })
    .select('id, name, short_code, fiscal_year_start_month')
    .single();
  if (error || !loc) throw new Error(`Could not create entity ${spec.short_code}: ${error?.message}`);

  await generatePeriods(db, orgId, (loc as { id: string }).id);
  return loc as SandboxEntity;
}

/**
 * Generate prior-year (HARD_CLOSE) + current-year + next-year periods, mirroring
 * the onboarding wizard's period generation so the Rule-F closed-period path is
 * naturally available (prior-year months are HARD_CLOSE).
 */
async function generatePeriods(db: DB, orgId: string, locationId: string): Promise<void> {
  const now = new Date();
  const years = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1];
  const periods: Array<Record<string, unknown>> = [];
  for (const year of years) {
    for (let month = 1; month <= 12; month++) {
      const startDate = new Date(year, month - 1, 1);
      const endDate = new Date(year, month, 0);
      const periodDate = new Date(year, month - 1, 15);
      const isBeforeCurrentMonth = periodDate < new Date(now.getFullYear(), now.getMonth(), 1);
      const status = year < now.getFullYear() ? 'HARD_CLOSE' : isBeforeCurrentMonth ? 'SOFT_CLOSE' : 'OPEN';
      periods.push({
        org_id: orgId,
        location_id: locationId,
        period_year: year,
        period_month: month,
        start_date: startDate.toISOString().split('T')[0],
        end_date: endDate.toISOString().split('T')[0],
        status,
      });
    }
  }
  const { error } = await db.from('fiscal_periods').insert(periods);
  if (error) throw new Error(`Period generation failed: ${error.message}`);
}

/** A date guaranteed to land in an OPEN current-year period (the 15th of this month). */
function openDate(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 15)).toISOString().slice(0, 10);
}

/** A date guaranteed to land in a HARD_CLOSE prior-year period. */
function closedDate(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear() - 1, 5, 15)).toISOString().slice(0, 10);
}

async function upsertDepartment(
  db: DB,
  orgId: string,
  spec: { name: string; code: string },
): Promise<string> {
  const { data: existing } = await db
    .schema('core').from('departments')
    .select('id')
    .eq('org_id', orgId)
    .eq('code', spec.code)
    .maybeSingle();
  if (existing) return (existing as { id: string }).id;
  const { data, error } = await db
    .schema('core').from('departments')
    .insert({ org_id: orgId, name: spec.name, code: spec.code })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Department ${spec.code}: ${error?.message}`);
  return (data as { id: string }).id;
}

// ───────────────────────── seeding ─────────────────────────

/**
 * Seed (or repair) the sandbox tenant. Idempotent: safe to run repeatedly.
 * If `reset` is true, transactional + master data is cleared first.
 */
export async function seedSandbox(db: DB, opts: { reset?: boolean } = {}): Promise<SeedResult> {
  const steps: SeedStep[] = [];
  const org = await ensureOrg(db);
  steps.push({ step: 'organization', detail: `${org.name} (${org.id.slice(0, 8)}…)` });

  // Ensure Projects entitlement so Books runs in auto-fed mode (seam exercised).
  await db.schema('core').from('organizations').update({ entitlements: { projects: true } }).eq('id', org.id);

  if (opts.reset) {
    await clearTenantData(db, org.id);
    steps.push({ step: 'reset', detail: 'Cleared transactional + master data (COA / entities / periods preserved)' });
  }

  // 1) COA via the REAL shared seeding path.
  const coa = await seedChartOfAccounts(db, org.id);
  steps.push({ step: 'chart_of_accounts', detail: `${coa.totalAccounts} accounts (template: ${coa.templateAccounts})` });

  // 2) Two entities with different fiscal-year starts + periods.
  const entA = await ensureEntity(db, org.id, { ...ENTITY_A, rev_rec_method: 'PCT_COSTS_INCURRED' });
  const entB = await ensureEntity(db, org.id, { ...ENTITY_B, rev_rec_method: 'POINT_OF_SALE' });
  steps.push({ step: 'entities', detail: `${entA.short_code} (FY ${entA.fiscal_year_start_month}), ${entB.short_code} (FY ${entB.fiscal_year_start_month})` });

  // 3) Departments per entity.
  const deptField = await upsertDepartment(db, org.id, { name: `${SANDBOX_TAG} Field Operations`, code: 'NWC-FIELD' });
  const deptRetail = await upsertDepartment(db, org.id, { name: `${SANDBOX_TAG} Retail`, code: 'CHF-RETAIL' });
  steps.push({ step: 'departments', detail: '2 departments (Field Operations, Retail)' });

  // 4) Master data — customers, vendors, items, employees.
  const custA = await ensureCustomer(db, org.id, `${SANDBOX_TAG} Fabrikam Inc.`);
  const custB = await ensureCustomer(db, org.id, `${SANDBOX_TAG} Tailspin Homes`);
  const vendor = await ensureVendor(db, org.id, `${SANDBOX_TAG} Contoso Lumber`);
  steps.push({ step: 'master_data', detail: '2 customers, 1 vendor' });

  const incomeAcct = await acctByType(db, org.id, 'REVENUE', /service|sales|contract|operating|revenue/i);
  const cogsAcct =
    (await acctByType(db, org.id, 'COGS', /material|cost of|subcontract|direct/i)) ??
    (await acctByType(db, org.id, 'COGS')) ??
    (await acctByType(db, org.id, 'OPEX'));
  await ensureItem(db, org.id, { sku: 'SBX-FLOOR', name: `${SANDBOX_TAG} Hardwood flooring (sq ft)`, item_type: 'INVENTORY', income_account_id: incomeAcct, cogs_account_id: cogsAcct });
  await ensureItem(db, org.id, { sku: 'SBX-LABOR', name: `${SANDBOX_TAG} Installation labor (hr)`, item_type: 'LABOR', income_account_id: incomeAcct, cogs_account_id: cogsAcct });
  await ensureEmployee(db, org.id, { first: 'Sandbox', last: 'Installer', departmentId: deptField });
  steps.push({ step: 'items_employees', detail: '2 items, 1 employee' });

  // 5) Jobs spanning BOTH recognition methods + the job_type→method map.
  // Map (per company): NWC CONSTRUCTION → PCT_COSTS_INCURRED; CHF SERVICE → POINT_OF_SALE.
  await upsertMethodMap(db, org.id, entA.id, 'CONSTRUCTION', 'PCT_COSTS_INCURRED');
  await upsertMethodMap(db, org.id, entB.id, 'SERVICE', 'POINT_OF_SALE');

  const jobA = await ensureJob(db, org.id, {
    locationId: entA.id, departmentId: deptField, customerId: custA, customerName: `${SANDBOX_TAG} Fabrikam Inc.`,
    jobNumber: 'NWC-1001', name: `${SANDBOX_TAG} Office build-out (POC)`, jobType: 'CONSTRUCTION', archetype: 'fixed-bid-construction',
    contractCents: 1_200_000_00, estimateCents: 800_000_00,
  });
  const jobB = await ensureJob(db, org.id, {
    locationId: entB.id, departmentId: deptRetail, customerId: custB, customerName: `${SANDBOX_TAG} Tailspin Homes`,
    jobNumber: 'CHF-2001', name: `${SANDBOX_TAG} Retail flooring sale (point-of-sale)`, jobType: 'SERVICE', archetype: 'retail-sale',
    contractCents: 45_000_00, estimateCents: 28_000_00,
  });
  steps.push({ step: 'jobs', detail: `Job A ${jobA.jobNumber} (POC), Job B ${jobB.jobNumber} (point-of-sale)` });

  const status = await getSandboxStatus(db);
  return { orgId: org.id, steps, status };
}

async function ensureCustomer(db: DB, orgId: string, name: string): Promise<string> {
  const { data: existing } = await db.schema('core').from('customers').select('id').eq('org_id', orgId).eq('name', name).maybeSingle();
  if (existing) return (existing as { id: string }).id;
  const { data, error } = await db.schema('core').from('customers').insert({ org_id: orgId, name, payment_terms_days: 30 }).select('id').single();
  if (error || !data) throw new Error(`Customer "${name}": ${error?.message}`);
  return (data as { id: string }).id;
}

async function ensureVendor(db: DB, orgId: string, name: string): Promise<string> {
  const { data: existing } = await db.schema('core').from('vendors').select('id').eq('org_id', orgId).eq('name', name).maybeSingle();
  if (existing) return (existing as { id: string }).id;
  const { data, error } = await db.schema('core').from('vendors').insert({ org_id: orgId, name, payment_terms_days: 30 }).select('id').single();
  if (error || !data) throw new Error(`Vendor "${name}": ${error?.message}`);
  return (data as { id: string }).id;
}

async function ensureItem(
  db: DB,
  orgId: string,
  spec: { sku: string; name: string; item_type: string; income_account_id: string | null; cogs_account_id: string | null },
): Promise<void> {
  const { data: existing } = await db.schema('core').from('items').select('id').eq('org_id', orgId).eq('sku', spec.sku).maybeSingle();
  if (existing) return;
  const { error } = await db.schema('core').from('items').insert({
    org_id: orgId, sku: spec.sku, name: spec.name, item_type: spec.item_type,
    income_account_id: spec.income_account_id, cogs_account_id: spec.cogs_account_id,
  });
  if (error) throw new Error(`Item "${spec.sku}": ${error.message}`);
}

async function ensureEmployee(
  db: DB,
  orgId: string,
  spec: { first: string; last: string; departmentId: string },
): Promise<void> {
  const { data: existing } = await db.schema('core').from('employees').select('id').eq('org_id', orgId).eq('first_name', spec.first).eq('last_name', spec.last).maybeSingle();
  if (existing) return;
  const { error } = await db.schema('core').from('employees').insert({
    org_id: orgId, first_name: spec.first, last_name: spec.last, department_id: spec.departmentId, is_active: true,
  });
  if (error) throw new Error(`Employee "${spec.first} ${spec.last}": ${error.message}`);
}

async function upsertMethodMap(db: DB, orgId: string, locationId: string, jobType: string, method: string): Promise<void> {
  const { error } = await db.from('rev_rec_method_map').upsert(
    { org_id: orgId, location_id: locationId, job_type: jobType, method },
    { onConflict: 'org_id,location_id,job_type' },
  );
  if (error) throw new Error(`Method map (${jobType}): ${error.message}`);
}

interface JobSpec {
  locationId: string; departmentId: string; customerId: string; customerName: string;
  jobNumber: string; name: string; jobType: string; archetype: string;
  contractCents: number; estimateCents: number;
}

async function ensureJob(db: DB, orgId: string, spec: JobSpec): Promise<{ id: string; jobNumber: string }> {
  const { data: existing } = await db
    .schema('core').from('jobs')
    .select('id, job_number')
    .eq('org_id', orgId)
    .eq('location_id', spec.locationId)
    .eq('job_number', spec.jobNumber)
    .maybeSingle();
  if (existing) return { id: (existing as { id: string }).id, jobNumber: (existing as { job_number: string }).job_number };

  const { data, error } = await db
    .schema('core').from('jobs')
    .insert({
      org_id: orgId,
      location_id: spec.locationId,
      department_id: spec.departmentId,
      customer_id: spec.customerId,
      customer_name: spec.customerName,
      job_number: spec.jobNumber,
      name: spec.name,
      job_type: spec.jobType,
      archetype: spec.archetype,
      status: 'ACTIVE',
      contract_amount_cents: spec.contractCents,
      estimated_cost_cents: spec.estimateCents,
      start_date: openDate(),
    })
    .select('id, job_number')
    .single();
  if (error || !data) throw new Error(`Job ${spec.jobNumber}: ${error?.message}`);
  return { id: (data as { id: string }).id, jobNumber: (data as { job_number: string }).job_number };
}

// ───────────────────────── round-trip ─────────────────────────

/** Find the POC job (Job A) and the point-of-sale job (Job B) for the org. */
async function findSandboxJobs(db: DB, orgId: string) {
  const { data } = await db
    .schema('core').from('jobs')
    .select('id, job_number, name, location_id, department_id, job_type, customer_id, contract_amount_cents, estimated_cost_cents')
    .eq('org_id', orgId)
    .in('job_number', ['NWC-1001', 'CHF-2001']);
  const rows = (data ?? []) as Array<{ id: string; job_number: string; location_id: string; department_id: string | null; job_type: string; customer_id: string | null; contract_amount_cents: number | null; estimated_cost_cents: number | null }>;
  return {
    jobA: rows.find((r) => r.job_number === 'NWC-1001') ?? null,
    jobB: rows.find((r) => r.job_number === 'CHF-2001') ?? null,
  };
}

/**
 * Drive the four contract paths through the real consumers and report pass/fail.
 * Idempotent-ish: uses fresh event_ids each run; recognition is incremental so
 * re-running converges (delta → 0) rather than double-counting.
 */
export async function runSandboxRoundTrip(db: DB, orgId: string): Promise<RoundTripResult> {
  const asOf = openDate();
  const paths: RoundTripPath[] = [];
  const { jobA, jobB } = await findSandboxJobs(db, orgId);

  if (!jobA || !jobB) {
    return {
      asOf,
      allPassed: false,
      paths: [{ path: 'cost', label: 'Prerequisite', pass: false, detail: 'Sandbox jobs not found — seed the sandbox first.' }],
    };
  }

  // ── Path 1: Cost — post a job-dimensioned GL cost, then emit JOB_COST. ──
  try {
    const cogsId =
      (await acctByType(db, orgId, 'COGS', /material|cost of|subcontract|direct/i)) ??
      (await acctByType(db, orgId, 'COGS')) ??
      (await acctByType(db, orgId, 'OPEX'));
    const apClearing = (await acctId(db, orgId, '2400')) ?? (await acctByType(db, orgId, 'LIABILITY', /accrued|clearing|payable/i, { excludeControl: true }));
    if (!cogsId || !apClearing) throw new Error('Missing COGS/OPEX or accrual/clearing account in COA');
    const costCents = 120_000_00; // drives PCT_COSTS_INCURRED to 15% of the 800k estimate
    const je = await postJournalEntry(db, {
      org_id: orgId,
      location_id: jobA.location_id,
      entry_date: asOf,
      entry_type: 'STANDARD',
      memo: `${SANDBOX_TAG} Job cost — materials`,
      source_module: 'AP',
      created_by: null,
      lines: [
        { account_id: cogsId, debit_cents: costCents, credit_cents: 0, location_id: jobA.location_id, department_id: jobA.department_id ?? undefined, memo: 'Job materials' },
        { account_id: apClearing, debit_cents: 0, credit_cents: costCents, location_id: jobA.location_id, department_id: jobA.department_id ?? undefined, memo: 'Accrued job cost' },
      ],
    });
    if (!je.success) throw new Error(je.error ?? 'GL post failed');

    // Stamp the cost (debit) GL line with the job dimension + write the
    // job_cost_entries bridge row, via the real seam helper (contract §6/§8).
    const { data: costLine } = await db
      .from('gl_entry_lines')
      .select('id')
      .eq('gl_entry_id', je.entry_id)
      .eq('debit_cents', costCents)
      .limit(1)
      .maybeSingle();
    const costLineId = (costLine as { id: string } | null)?.id ?? null;
    if (costLineId) {
      await stampGlLineJob(db, {
        orgId, glEntryLineId: costLineId, jobId: jobA.id, amountCents: costCents,
        occurredOn: asOf, description: `${SANDBOX_TAG} Job materials`,
      });
    }

    // Reflect the actual cost on the job (the cost trigger/sync would do this in the live path;
    // we set it directly so PCT_COSTS_INCURRED has a real actual-vs-estimate ratio).
    await db.schema('core').from('jobs').update({ actual_cost_cents: costCents, updated_at: new Date().toISOString() }).eq('id', jobA.id);

    const eventId = await emitJobCostEvent(db, {
      orgId, locationId: jobA.location_id, jobId: jobA.id, costType: 'MATERIALS',
      amountCents: costCents, occurredOn: asOf, lifecycle: 'CLEARED', gate: 'PAYABLE_APPROVAL',
      sourceRef: `sandbox-cost-${je.entry_number ?? eventTag()}`, glEntryId: je.entry_id, memo: `${SANDBOX_TAG} cleared job cost`,
    });
    paths.push({
      path: 'cost', label: 'Cost (Books → JOB_COST emit)', pass: !!costLineId,
      detail: costLineId
        ? `Posted GL ${je.entry_number ?? ''} ($120,000.00 cost), stamped job_id on the cost line + bridge row; JOB_COST event ${eventId.slice(0, 8)}… emitted (pending the Projects consumer, Module 2).`
        : `Posted GL ${je.entry_number ?? ''} but could not locate the cost line to stamp job_id.`,
    });
  } catch (e) {
    paths.push({ path: 'cost', label: 'Cost (Books → JOB_COST emit)', pass: false, detail: e instanceof Error ? e.message : 'cost path failed' });
  }

  // ── Path 2: Recognition — JOB_PROGRESS for Job A (POC) drained via the real consumer. ──
  try {
    await enqueueProgressEvent(db, orgId, {
      jobId: jobA.id, locationId: jobA.location_id, occurredOn: asOf,
      contract_value_cents: jobA.contract_amount_cents ?? 1_200_000_00,
      cost_estimate_cents: jobA.estimated_cost_cents ?? 800_000_00,
      pct_complete: null, // POC uses cost-to-cost; pct ignored
    });
    const before = await jobRecognized(db, orgId, jobA.id);
    const res = await processProgressEvents(db, orgId, null);
    const after = await jobRecognized(db, orgId, jobA.id);
    const processed = res.processed > 0;
    // PCT_COSTS_INCURRED: 120k actual / 800k estimate = 15% → 15% of 1.2M contract = 180k earned.
    const moved = after !== before;
    paths.push({
      path: 'recognition', label: 'Recognition (JOB_PROGRESS → rev-rec)', pass: processed && (moved || after > 0),
      detail: processed
        ? `Drained ${res.processed} progress event(s); Job A recognized-to-date now $${(after / 100).toLocaleString()} (cost-to-cost on $1.2M contract).`
        : `No progress event processed (${res.rejected} rejected). ${res.results[0]?.error ?? ''}`,
    });
  } catch (e) {
    paths.push({ path: 'recognition', label: 'Recognition (JOB_PROGRESS → rev-rec)', pass: false, detail: e instanceof Error ? e.message : 'recognition path failed' });
  }

  // ── Path 3: Billing — JOB_BILLING for Job A drained via the real consumer. ──
  try {
    await enqueueBillingEvent(db, orgId, {
      jobId: jobA.id, locationId: jobA.location_id, occurredOn: asOf, billingType: 'PROGRESS',
      lines: [{ description: `${SANDBOX_TAG} Progress draw #1`, amount_cents: 150_000_00, item_id: null }],
    });
    const res = await processBillingEvents(db, orgId);
    const ok = res.processed > 0 && !!res.results.find((r) => r.status === 'processed' && r.invoice_number);
    const inv = res.results.find((r) => r.invoice_number)?.invoice_number;
    paths.push({
      path: 'billing', label: 'Billing (JOB_BILLING → AR invoice)', pass: ok,
      detail: ok
        ? `Issued invoice ${inv}; AR posted ($150,000.00 progress draw) on Job A.`
        : `Billing not processed (${res.rejected} rejected). ${res.results[0]?.error ?? ''}`,
    });
  } catch (e) {
    paths.push({ path: 'billing', label: 'Billing (JOB_BILLING → AR invoice)', pass: false, detail: e instanceof Error ? e.message : 'billing path failed' });
  }

  // ── Path 4: Rejection — event on a HARD_CLOSE prior-year period must be rejected. ──
  try {
    await enqueueProgressEvent(db, orgId, {
      jobId: jobA.id, locationId: jobA.location_id, occurredOn: closedDate(),
      contract_value_cents: jobA.contract_amount_cents ?? 1_200_000_00,
      cost_estimate_cents: jobA.estimated_cost_cents ?? 800_000_00,
      pct_complete: null,
    });
    const res = await processProgressEvents(db, orgId, null);
    const rejected = res.rejected > 0 && !!res.results.find((r) => r.status === 'rejected' && /closed|locked|period/i.test(r.error ?? ''));
    const reason = res.results.find((r) => r.status === 'rejected')?.error;
    paths.push({
      path: 'rejection', label: 'Rejection (Rule F — closed period)', pass: rejected,
      detail: rejected ? `Event on a HARD_CLOSE period correctly rejected: "${reason}".` : 'Expected a closed-period rejection but none occurred.',
    });
  } catch (e) {
    paths.push({ path: 'rejection', label: 'Rejection (Rule F — closed period)', pass: false, detail: e instanceof Error ? e.message : 'rejection path failed' });
  }

  return { asOf, paths, allPassed: paths.every((p) => p.pass) };
}

function eventTag(): string {
  return randomUUID().slice(0, 8);
}

async function jobRecognized(db: DB, orgId: string, jobId: string): Promise<number> {
  const { data } = await db.schema('core').from('jobs').select('revenue_recognized_cents').eq('org_id', orgId).eq('id', jobId).maybeSingle();
  return Number((data as { revenue_recognized_cents: number } | null)?.revenue_recognized_cents ?? 0);
}

/** Insert a JOB_PROGRESS event in the exact shape the consumer expects (contract v3 §5). */
async function enqueueProgressEvent(
  db: DB,
  orgId: string,
  p: { jobId: string; locationId: string; occurredOn: string; contract_value_cents: number; cost_estimate_cents: number; pct_complete: number | null },
): Promise<void> {
  const eventId = randomUUID();
  const payload = {
    event_id: eventId, job_id: p.jobId, location_id: p.locationId, trigger: 'SANDBOX',
    contract_value_cents: p.contract_value_cents, cost_estimate_cents: p.cost_estimate_cents,
    pct_complete: p.pct_complete, occurred_on: p.occurredOn, source_ref: `sandbox-progress-${eventId.slice(0, 8)}`,
    memo: `${SANDBOX_TAG} progress snapshot`,
  };
  const { error } = await db.schema('core').from('events').insert({
    org_id: orgId, event_id: eventId, event_type: 'JOB_PROGRESS', source_module: 'PROJECTS',
    payload, occurred_on: p.occurredOn, status: 'pending',
  });
  if (error) throw new Error(`enqueue JOB_PROGRESS: ${error.message}`);
}

/** Insert a JOB_BILLING event in the exact shape the consumer expects (contract v3 §4). */
async function enqueueBillingEvent(
  db: DB,
  orgId: string,
  p: { jobId: string; locationId: string; occurredOn: string; billingType: string; lines: { description: string; amount_cents: number; item_id: string | null }[] },
): Promise<void> {
  const eventId = randomUUID();
  const payload = {
    event_id: eventId, job_id: p.jobId, location_id: p.locationId, billing_type: p.billingType,
    occurred_on: p.occurredOn, source_ref: `sandbox-billing-${eventId.slice(0, 8)}`,
    memo: `${SANDBOX_TAG} draw`, lines: p.lines,
  };
  const { error } = await db.schema('core').from('events').insert({
    org_id: orgId, event_id: eventId, event_type: 'JOB_BILLING', source_module: 'PROJECTS',
    payload, occurred_on: p.occurredOn, status: 'pending',
  });
  if (error) throw new Error(`enqueue JOB_BILLING: ${error.message}`);
}

// ───────────────────────── reset ─────────────────────────

/**
 * Clear the tenant's transactional + master data so the sandbox can be re-seeded
 * from a clean operational state. Preserves the COA (types/sub-types/groups/
 * accounts), entities (locations), and fiscal periods — reset = re-run the seed.
 *
 * Delete order respects FKs: ledger lines → entries → invoices → events →
 * rev-rec runs/maps → cost bridges/attributions → jobs → master data → depts.
 */
async function clearTenantData(db: DB, orgId: string): Promise<void> {
  // Books-schema (public) ledger + sub-ledger rows.
  await db.from('gl_entry_lines').delete().eq('org_id', orgId);
  await db.from('gl_entries').delete().eq('org_id', orgId);
  await db.from('invoice_lines').delete().eq('org_id', orgId);
  await db.from('invoices').delete().eq('org_id', orgId);
  await db.from('revenue_recognition_runs').delete().eq('org_id', orgId);
  await db.from('rev_rec_method_map').delete().eq('org_id', orgId);
  await db.from('job_cost_entries').delete().eq('org_id', orgId);
  await db.from('job_cost_attributions').delete().eq('org_id', orgId);

  // Suite event log.
  await db.schema('core').from('events').delete().eq('org_id', orgId);

  // Core master data (jobs first — they FK customers/departments/locations).
  await db.schema('core').from('jobs').delete().eq('org_id', orgId);
  await db.schema('core').from('items').delete().eq('org_id', orgId);
  await db.schema('core').from('employees').delete().eq('org_id', orgId);
  await db.schema('core').from('customers').delete().eq('org_id', orgId);
  await db.schema('core').from('vendors').delete().eq('org_id', orgId);
  await db.schema('core').from('departments').delete().eq('org_id', orgId);
}

/** Reset = clear + re-seed. */
export async function resetSandbox(db: DB): Promise<SeedResult> {
  return seedSandbox(db, { reset: true });
}

// ───────────────────────── status ─────────────────────────

export async function getSandboxStatus(db: DB): Promise<SandboxStatus> {
  const org = await resolveOrg(db);
  if (!org) {
    return {
      hasOrg: false, orgId: null, orgName: null, accountCount: 0, entities: [],
      departmentCount: 0, customerCount: 0, vendorCount: 0, itemCount: 0,
      employeeCount: 0, jobCount: 0, openPeriods: 0, closedPeriods: 0, seeded: false,
    };
  }
  const orgId = org.id;

  const count = async (table: string, schema?: 'core') => {
    const base = schema ? db.schema(schema).from(table) : db.from(table);
    const { count: c } = await base.select('id', { count: 'exact', head: true }).eq('org_id', orgId);
    return c ?? 0;
  };

  const { data: locs } = await db
    .schema('core').from('locations')
    .select('id, name, short_code, fiscal_year_start_month')
    .eq('org_id', orgId)
    .order('short_code', { ascending: true });
  const entities = (locs ?? []) as SandboxEntity[];

  const { count: openPeriods } = await db.from('fiscal_periods').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('status', 'OPEN');
  const { count: closedPeriods } = await db.from('fiscal_periods').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('status', 'HARD_CLOSE');

  const jobCount = await count('jobs', 'core');
  const seeded = entities.some((e) => e.short_code === 'NWC' || e.short_code === 'CHF') && jobCount > 0;

  return {
    hasOrg: true,
    orgId,
    orgName: org.name,
    accountCount: await count('accounts'),
    entities,
    departmentCount: await count('departments', 'core'),
    customerCount: await count('customers', 'core'),
    vendorCount: await count('vendors', 'core'),
    itemCount: await count('items', 'core'),
    employeeCount: await count('employees', 'core'),
    jobCount,
    openPeriods: openPeriods ?? 0,
    closedPeriods: closedPeriods ?? 0,
    seeded,
  };
}
