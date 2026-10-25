/**
 * Opening positions for Books (PLT-70, CGC-08, FS-65, DLR-81). Projects never writes the GL: these
 * build validated, Books-shaped handoffs from COMMITTED import rows; pm.opening_stage_handoff
 * re-foots them in SQL and pm.opening_tieout compares them with what Books holds.
 *
 * The WIP arithmetic is Books' own (apps/web/src/lib/jobcost/wip.ts computeWipJob — earned =
 * contract × %-complete, %-complete = physical override when > 0 else cost / EAC clamped to 1,
 * cents rounded with Math.round, over / under = billed − earned); the parity test proves the same
 * numbers. Every handoff also carries the file Books' importers already read:
 *   JOB_WIP       → `books_wip_jobs`: Books' ProposedJob[] (lib/onboarding/wip-import/types.ts) for
 *                   POST /api/onboarding/import/wip, plus `job_dimension_lines` (per job, by account
 *                   role, the opening entry WITH the job dimension Books must post — see the handoff
 *                   doc in the final report) and `subledger_detail` (ImportedSubledgerDetail keys).
 *   DEALER_UNITS  → `books_opening_rows`: Books' Dealer Pack OPENING import fields
 *                   (lib/dealer/imports/fields.ts OPENING_FIELDS keys), money as dollars text.
 * Pure. All money integer cents.
 */
import { normName } from '../onboarding/import/values';
import type { CellValue, OpeningKind } from './types';

// ------------------------------------------------------------------ Books' WIP arithmetic (mirrored)

export interface WipLine {
  contractValueCents: number;
  estimatedCostCents: number;
  costsToDateCents: number;
  billedToDateCents: number;
  pctComplete: number;
  pctBasis: 'PHYSICAL' | 'COST_TO_COST';
  earnedRevenueCents: number;
  overBillingCents: number;
  underBillingCents: number;
}

const cents = (x: number) => (Number.isFinite(x) ? Math.round(x) : 0);
const clamp = (x: number) => (!Number.isFinite(x) || x <= 0 ? 0 : x >= 1 ? 1 : x);

export function computeWipLine(i: { contract: number; eac: number; costToDate: number; billed: number; pctOverride: number | null }): WipLine {
  const contract = Math.max(0, cents(i.contract));
  const est = Math.max(0, cents(i.eac));
  const cost = Math.max(0, cents(i.costToDate));
  const billed = Math.max(0, cents(i.billed));
  const override = i.pctOverride == null ? null : clamp(i.pctOverride);
  const costToCost = est > 0 ? clamp(cost / est) : 0;
  const physical = override != null && override > 0;
  const pct = physical ? override : costToCost;
  const earned = cents(contract * pct);
  const net = billed - earned;
  return {
    contractValueCents: contract, estimatedCostCents: est, costsToDateCents: cost, billedToDateCents: billed, pctComplete: pct,
    pctBasis: physical ? 'PHYSICAL' : 'COST_TO_COST', earnedRevenueCents: earned, overBillingCents: net > 0 ? net : 0, underBillingCents: net < 0 ? -net : 0,
  };
}

// ------------------------------------------------------------------ committed rows in

export interface CommittedRow {
  row_number: number;
  entity: string;
  external_ref: string | null;
  data: Record<string, CellValue>;
  outcome: string;
  target_id: string | null;
}

const num = (d: Record<string, CellValue>, k: string): number | null => (typeof d[k] === 'number' ? (d[k] as number) : null);
const str = (d: Record<string, CellValue>, k: string): string | null => (typeof d[k] === 'string' && (d[k] as string).trim() ? (d[k] as string) : null);
const sum = <T>(xs: T[], f: (x: T) => number | null) => xs.reduce((a, x) => a + (f(x) ?? 0), 0);

export interface OpeningJobFact {
  job_id: string;
  external_ref: string | null;
  job_name: string;
  customer_name: string | null;
  original_contract_cents: number;
  approved_co_cents: number;
  revised_contract_cents: number;
  estimated_cost_cents: number;
  cost_to_date_cents: number;
  billed_to_date_cents: number;
  retainage_receivable_cents: number;
  retainage_payable_cents: number;
  customer_deposits_cents: number;
  open_commitments_cents: number;
  commitments_billed_cents: number;
  earned_revenue_cents: number;
  over_billing_cents: number;
  under_billing_cents: number;
  pct_complete: number | null;
  last_pay_app_number: number | null;
  sov: { line_no: number | null; description: string | null; cost_code: string | null; scheduled_value_cents: number; billed_to_date_cents: number; stored_materials_cents: number; retainage_cents: number }[];
  cost_codes: { code: string; description: string | null; cost_type: string | null; budget_cents: number }[];
}

export interface HandoffDraft {
  kind: OpeningKind;
  asOf: string;
  payload: Record<string, unknown> & { totals: Record<string, number>; blockers: { ref: string | null; message: string }[]; warnings: { ref: string | null; message: string }[] };
  facts: OpeningJobFact[];
}

function groupBy<T>(xs: T[], key: (x: T) => string | null): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    if (!k) continue;
    const list = m.get(k) ?? [];
    list.push(x);
    m.set(k, list);
  }
  return m;
}

const isApproved = (s: string | null) => !!s && /\b(approved|executed|signed|accepted)\b/i.test(s);
const isOpenCommitment = (s: string | null) => !s || !/\b(void|cancel|closed|complete)/i.test(s);

/** Mid-stream jobs → the JOB_WIP opening position (+ SOV, budgets, commitments, COs, deposits when brought in). */
export function buildJobWipHandoff(input: {
  asOf: string;
  jobs: CommittedRow[];
  sov?: CommittedRow[];
  budgets?: CommittedRow[];
  commitments?: CommittedRow[];
  changeOrders?: CommittedRow[];
  deposits?: CommittedRow[];
}): HandoffDraft {
  const live = (rows: CommittedRow[] | undefined) => (rows ?? []).filter((r) => r.outcome !== 'ERROR');
  const jobs = input.jobs.filter((r) => r.target_id && (r.outcome === 'CREATED' || r.outcome === 'SKIPPED' || r.outcome === 'MATCHED'));
  const refOf = new Map<string, string>(); // job ref → job id
  for (const j of jobs) if (j.external_ref) refOf.set(j.external_ref.toUpperCase(), j.target_id!);
  const jobKey = (r: CommittedRow) => (typeof r.data._job_id === 'string' ? (r.data._job_id as string) : refOf.get((str(r.data, 'job_ref') ?? '').toUpperCase()) ?? null);
  const sovBy = groupBy(live(input.sov), jobKey);
  const budBy = groupBy(live(input.budgets), jobKey);
  const cmtBy = groupBy(live(input.commitments), jobKey);
  const coBy = groupBy(live(input.changeOrders), jobKey);
  const depBy = groupBy(live(input.deposits), jobKey);
  const blockers: { ref: string | null; message: string }[] = [];
  const warnings: { ref: string | null; message: string }[] = [];
  const seen = new Set<string>();

  const facts: OpeningJobFact[] = [];
  for (const j of jobs) {
    const id = j.target_id!;
    if (seen.has(id)) continue;
    seen.add(id);
    const d = j.data;
    const sov = sovBy.get(id) ?? [];
    const bud = budBy.get(id) ?? [];
    const cmt = (cmtBy.get(id) ?? []).filter((c) => isOpenCommitment(str(c.data, 'status')));
    const cos = coBy.get(id) ?? [];
    const deps = depBy.get(id) ?? [];
    const approvedCo = num(d, 'approved_co_cents') ?? (cos.length ? sum(cos.filter((c) => isApproved(str(c.data, 'status'))), (c) => num(c.data, 'amount_cents')) : 0);
    const original = num(d, 'original_contract_cents') ?? Math.max(0, (num(d, 'contract_cents') ?? 0) - approvedCo);
    const revised = num(d, 'contract_cents') ?? original + approvedCo;
    const sovBilled = sum(sov, (s) => num(s.data, 'billed_to_date_cents'));
    const billed = num(d, 'billed_to_date_cents') ?? sovBilled;
    const eac = num(d, 'estimated_cost_cents') ?? sum(bud, (b) => num(b.data, 'amount_cents'));
    const cost = num(d, 'cost_to_date_cents') ?? 0;
    const retRec = num(d, 'retainage_receivable_cents') ?? sum(sov, (s) => num(s.data, 'retainage_cents'));
    const retPay = num(d, 'retainage_payable_cents') ?? sum(cmt, (c) => num(c.data, 'retainage_held_cents'));
    const openCmt = num(d, 'open_commitments_cents') ?? sum(cmt, (c) => Math.max(0, (num(c.data, 'amount_cents') ?? 0) - (num(c.data, 'billed_cents') ?? 0)));
    const cmtBilled = num(d, 'commitments_billed_cents') ?? sum(cmt, (c) => num(c.data, 'billed_cents'));
    const deposits = num(d, 'customer_deposits_cents') ?? sum(deps, (x) => num(x.data, 'amount_cents'));
    const pct = num(d, 'pct_complete');
    const w = computeWipLine({ contract: revised, eac, costToDate: cost, billed, pctOverride: pct });
    const ref = j.external_ref;

    if (sov.length) {
      const sched = sum(sov, (s) => num(s.data, 'scheduled_value_cents'));
      if (Math.abs(sched - revised) > 100) warnings.push({ ref, message: `Schedule of values totals ${sched / 100} but the contract is ${revised / 100}` });
      if (num(d, 'billed_to_date_cents') !== null && Math.abs(sovBilled - billed) > 100) warnings.push({ ref, message: `Billed to date per SOV line (${sovBilled / 100}) differs from the job’s billed to date (${billed / 100})` });
    }
    if (cost > eac && eac > 0) warnings.push({ ref, message: 'Cost to date is over the estimated cost; the job shows 100% complete (a loss job?)' });
    if (billed > revised && revised > 0) warnings.push({ ref, message: 'Billed more than the contract' });

    facts.push({
      job_id: id, external_ref: ref, job_name: str(d, 'name') ?? ref ?? 'Job', customer_name: str(d, 'customer_name'),
      original_contract_cents: original, approved_co_cents: approvedCo, revised_contract_cents: w.contractValueCents, estimated_cost_cents: w.estimatedCostCents,
      cost_to_date_cents: w.costsToDateCents, billed_to_date_cents: w.billedToDateCents, retainage_receivable_cents: Math.max(0, retRec),
      retainage_payable_cents: Math.max(0, retPay), customer_deposits_cents: Math.max(0, deposits), open_commitments_cents: Math.max(0, openCmt),
      commitments_billed_cents: Math.max(0, cmtBilled), earned_revenue_cents: w.earnedRevenueCents, over_billing_cents: w.overBillingCents,
      under_billing_cents: w.underBillingCents, pct_complete: Math.round(w.pctComplete * 1_000_000) / 1_000_000,
      last_pay_app_number: num(d, 'last_pay_app_number'),
      sov: sov.map((s) => ({
        line_no: num(s.data, 'line_no'), description: str(s.data, 'description'), cost_code: str(s.data, 'cost_code'),
        scheduled_value_cents: num(s.data, 'scheduled_value_cents') ?? 0, billed_to_date_cents: num(s.data, 'billed_to_date_cents') ?? 0,
        stored_materials_cents: num(s.data, 'stored_materials_cents') ?? 0, retainage_cents: num(s.data, 'retainage_cents') ?? 0,
      })),
      cost_codes: bud.map((b) => ({ code: str(b.data, 'cost_code') ?? '', description: str(b.data, 'description'), cost_type: str(b.data, 'cost_type'), budget_cents: num(b.data, 'amount_cents') ?? 0 })),
    });
    // Books' WIP gate (wipImportBlockers): a contract and an EAC for every open job
    if (w.contractValueCents <= 0) blockers.push({ ref, message: `${ref ?? 'A job'} needs a contract value` });
    if (w.estimatedCostCents <= 0) blockers.push({ ref, message: `${ref ?? 'A job'} needs an estimated total cost (EAC) so earned revenue can be computed` });
  }

  const totals = wipTotals(facts);
  return {
    kind: 'JOB_WIP', asOf: input.asOf, facts,
    payload: {
      kind: 'JOB_WIP', as_of_date: input.asOf, totals, blockers, warnings,
      subledger_detail: {
        wipCostsToDateCents: totals.cost_to_date_cents, unbilledCents: totals.under_billing_cents, billingsInExcessCents: totals.over_billing_cents,
        ...(totals.retainage_receivable_cents ? { retainageReceivableCents: totals.retainage_receivable_cents } : {}),
        ...(totals.retainage_payable_cents ? { retainagePayableCents: totals.retainage_payable_cents } : {}),
        ...(totals.customer_deposits_cents ? { customerDepositsCents: totals.customer_deposits_cents } : {}),
      },
      books_wip_jobs: facts.map(booksProposedJob),
      job_dimension_lines: facts.flatMap(jobDimensionLines),
    },
  };
}

export function wipTotals(facts: OpeningJobFact[]): Record<string, number> {
  const t = (k: keyof OpeningJobFact) => facts.reduce((a, f) => a + (typeof f[k] === 'number' ? (f[k] as number) : 0), 0);
  return {
    jobs: facts.length,
    revised_contract_cents: t('revised_contract_cents'), estimated_cost_cents: t('estimated_cost_cents'), cost_to_date_cents: t('cost_to_date_cents'),
    billed_to_date_cents: t('billed_to_date_cents'), earned_revenue_cents: t('earned_revenue_cents'), under_billing_cents: t('under_billing_cents'),
    over_billing_cents: t('over_billing_cents'), retainage_receivable_cents: t('retainage_receivable_cents'), retainage_payable_cents: t('retainage_payable_cents'),
    customer_deposits_cents: t('customer_deposits_cents'), open_commitments_cents: t('open_commitments_cents'),
  };
}

/** Books' ProposedJob (apps/web/src/lib/onboarding/wip-import/types.ts). */
export function booksProposedJob(f: OpeningJobFact) {
  return {
    jobNumber: f.external_ref ?? f.job_id, jobName: f.job_name, customerName: f.customer_name, jobType: null,
    originalContractCents: f.original_contract_cents, approvedChangeOrdersCents: f.approved_co_cents, contractValueCents: f.revised_contract_cents,
    estimatedCostCents: f.estimated_cost_cents, costsToDateCents: f.cost_to_date_cents, billedToDateCents: f.billed_to_date_cents,
    retainageReceivableCents: f.retainage_receivable_cents, retainagePayableCents: f.retainage_payable_cents, customerDepositsCents: f.customer_deposits_cents,
    pctCompleteOverride: null,
    costCodes: f.cost_codes.map((c) => ({ code: c.code, label: c.description, costType: (c.cost_type as 'LABOR' | 'MATERIALS' | 'SUBCONTRACTOR' | 'EQUIPMENT' | 'OTHER' | null) ?? null, budgetCents: c.budget_cents })),
    confidence: {}, lowConfidenceFields: [], source: 'human' as const,
    projectsJobId: f.job_id,
  };
}

/** The job-dimension opening lines Books must post (one per job × account role; debit-positive orientation by role). */
export function jobDimensionLines(f: OpeningJobFact) {
  const lines: { job_id: string; job_ref: string | null; role: string; debit_cents: number; credit_cents: number; memo: string }[] = [];
  const add = (role: string, dr: number, cr: number, memo: string) => { if (dr > 0 || cr > 0) lines.push({ job_id: f.job_id, job_ref: f.external_ref, role, debit_cents: dr, credit_cents: cr, memo }); };
  add('JOB_WIP', f.cost_to_date_cents, 0, 'Opening cost to date');
  add('UNBILLED_RECEIVABLE', f.under_billing_cents, 0, 'Opening costs and earnings in excess of billings');
  add('DEFERRED_REVENUE', 0, f.over_billing_cents, 'Opening billings in excess of costs and earnings');
  add('RETAINAGE_RECEIVABLE', f.retainage_receivable_cents, 0, 'Opening retainage held by the owner');
  add('RETAINAGE_PAYABLE', 0, f.retainage_payable_cents, 'Opening retainage held from subcontractors');
  add('CUSTOMER_DEPOSITS', 0, f.customer_deposits_cents, 'Opening customer deposits held');
  return lines;
}

// ------------------------------------------------------------------ other kinds

const dollars = (c: number | null) => (c == null ? '' : (c / 100).toFixed(2));

function unitList(rows: CommittedRow[]) {
  return rows.map((u) => {
    const d = u.data;
    const floor = num(d, 'floor_balance_cents') ?? 0;
    return {
      asset_id: u.target_id, serial_number: str(d, 'serial_number'), stock_number: str(d, 'stock_number'), make: str(d, 'make'), model: str(d, 'model'),
      model_year: num(d, 'model_year'), condition: str(d, 'condition'), unit_status: str(d, 'unit_status'), received_on: str(d, 'received_on'),
      cost_cents: num(d, 'cost_cents') ?? 0, list_price_cents: num(d, 'list_price_cents'), floor_lender: str(d, 'floor_lender'), floor_note_ref: str(d, 'floor_note_ref'),
      floored_on: str(d, 'floored_on'), floor_balance_cents: floor, rental: u.entity === 'rental_unit',
    };
  });
}

/** c-Systems units → DEALER_UNITS + Books' Dealer Pack OPENING rows. */
export function buildDealerUnitsHandoff(asOf: string, units: CommittedRow[]): HandoffDraft {
  const rows = units.filter((u) => u.target_id && u.outcome !== 'ERROR');
  const warnings: { ref: string | null; message: string }[] = [];
  const blockers: { ref: string | null; message: string }[] = [];
  const list = unitList(rows);
  for (const u of list) {
    if (u.floor_balance_cents > 0 && !u.floor_lender) blockers.push({ ref: u.serial_number, message: `${u.serial_number} owes the lender but no lender is named` });
    if (u.floor_balance_cents > 0 && !u.floor_note_ref) warnings.push({ ref: u.serial_number, message: `${u.serial_number} has no lender invoice number; Books matches the note by serial` });
  }
  const openingRows = dealerOpeningRows(asOf, list);
  const byLender = new Map<string, { units: number; floor_cents: number }>();
  for (const u of list) if (u.floor_balance_cents > 0) {
    const k = u.floor_lender ?? '(no lender)';
    const g = byLender.get(k) ?? { units: 0, floor_cents: 0 };
    g.units += 1; g.floor_cents += u.floor_balance_cents;
    byLender.set(k, g);
  }
  return {
    kind: 'DEALER_UNITS', asOf, facts: [],
    payload: {
      kind: 'DEALER_UNITS', as_of_date: asOf, units: list, blockers, warnings,
      by_lender: [...byLender.entries()].map(([lender, g]) => ({ lender, ...g })),
      totals: { units: list.length, cost_cents: sum(list, (u) => u.cost_cents), floor_cents: sum(list, (u) => u.floor_balance_cents), floored_units: list.filter((u) => u.floor_balance_cents > 0).length },
      books_opening_rows: openingRows,
      // Books' OPENING import floors a whole file onto one floor-plan line: one file per lender
      // (units the dealer owns outright go in their own file with no line).
      books_opening_files: [...new Set(openingRows.map((r) => r.lender))].map((lender) => ({
        lender: lender || null, rows: openingRows.filter((r) => r.lender === lender).map((r) => { const { lender: _lender, ...rest } = r; void _lender; return rest; }),
      })),
    },
  };
}

function dealerOpeningRows(asOf: string, list: ReturnType<typeof unitList>) {
  return list.map((u) => ({
    serialNumber: u.serial_number ?? '', stockNumber: u.stock_number ?? '', vinHin: '', make: u.make ?? '', model: u.model ?? '',
    modelYear: u.model_year == null ? '' : String(u.model_year), description: '', condition: u.rental ? 'RENTAL' : u.condition ?? 'NEW',
    status: u.unit_status === 'IN_TRANSIT' || u.unit_status === 'ON_ORDER' ? u.unit_status : 'IN_STOCK', receivedDate: u.received_on ?? '',
    listPriceCents: dollars(u.list_price_cents), unitCostCents: dollars(u.cost_cents),
    lenderInvoiceNumber: u.floor_balance_cents > 0 ? u.floor_note_ref ?? '' : '', flooredDate: u.floor_balance_cents > 0 ? u.floored_on ?? '' : '',
    principalCents: u.floor_balance_cents > 0 ? dollars(u.floor_balance_cents) : '', interestAccruedThrough: asOf, lender: u.floor_balance_cents > 0 ? u.floor_lender ?? '' : '',
  }));
}

/** FS-65: agreements → AGREEMENT_DEFERRED (count, deferred $, visits owed) vs the old system's deferred report. */
export function buildAgreementHandoff(asOf: string, rows: CommittedRow[], sourceReportedDeferredCents: number | null): HandoffDraft {
  const live = rows.filter((r) => r.outcome === 'CREATED' || r.outcome === 'SKIPPED');
  const list = live.map((r) => ({ agreement_id: r.target_id, external_ref: r.external_ref, customer_name: str(r.data, 'customer_name'), plan_name: str(r.data, 'plan_name'),
    deferred_cents: num(r.data, 'deferred_cents') ?? 0, visits_remaining: num(r.data, 'visits_remaining') ?? 0 }));
  const deferred = sum(list, (x) => x.deferred_cents);
  const warnings: { ref: string | null; message: string }[] = [];
  if (sourceReportedDeferredCents != null && Math.abs(sourceReportedDeferredCents - deferred) > 100) {
    warnings.push({ ref: null, message: `The agreements add up to ${dollars(deferred)} deferred; the old system's report says ${dollars(sourceReportedDeferredCents)}` });
  }
  return {
    kind: 'AGREEMENT_DEFERRED', asOf, facts: [],
    payload: { kind: 'AGREEMENT_DEFERRED', as_of_date: asOf, agreements: list, source_reported_deferred_cents: sourceReportedDeferredCents, blockers: [], warnings,
      totals: { agreements: list.length, deferred_cents: deferred, visits_owed: sum(list, (x) => x.visits_remaining) } },
  };
}

/** Open AR → OPEN_AR, per customer (Books owns AR; this is the tie-out, not a posting). */
export function buildOpenArHandoff(asOf: string, rows: CommittedRow[]): HandoffDraft {
  const by = new Map<string, { customer_id: string | null; name: string; open_cents: number; invoices: number }>();
  for (const r of rows) {
    if (r.outcome === 'ERROR' || r.outcome === 'SKIPPED') continue;
    const name = str(r.data, 'customer_name') ?? str(r.data, 'customer_ref') ?? 'Unknown customer';
    const id = typeof r.data._customer_id === 'string' ? (r.data._customer_id as string) : null;
    const k = id ?? `name:${normName(name)}`;
    const g = by.get(k) ?? { customer_id: id, name, open_cents: 0, invoices: 0 };
    g.open_cents += num(r.data, 'balance_cents') ?? 0;
    g.invoices += 1;
    by.set(k, g);
  }
  const customers = [...by.values()].sort((a, b) => b.open_cents - a.open_cents);
  const unmatched = customers.filter((c) => !c.customer_id);
  return {
    kind: 'OPEN_AR', asOf, facts: [],
    payload: { kind: 'OPEN_AR', as_of_date: asOf, customers, blockers: [],
      warnings: unmatched.length ? [{ ref: null, message: `${unmatched.length} customer(s) on open invoices aren't in your customer list yet; bring the customer file in first` }] : [],
      totals: { customers: customers.length, invoices: sum(customers, (c) => c.invoices), open_ar_cents: sum(customers, (c) => c.open_cents) } },
  };
}

export function buildDepositsHandoff(asOf: string, rows: CommittedRow[], field = 'amount_cents'): HandoffDraft {
  const list = rows.filter((r) => r.outcome !== 'ERROR' && (num(r.data, field) ?? 0) > 0).map((r) => ({
    ref: r.external_ref, job_id: typeof r.data._job_id === 'string' ? r.data._job_id : null, customer_id: typeof r.data._customer_id === 'string' ? r.data._customer_id : null,
    customer_name: str(r.data, 'customer_name'), amount_cents: num(r.data, field) ?? 0, entity: r.entity,
  }));
  return { kind: 'CUSTOMER_DEPOSITS', asOf, facts: [], payload: { kind: 'CUSTOMER_DEPOSITS', as_of_date: asOf, deposits: list, blockers: [], warnings: [], totals: { deposits: list.length, deposits_cents: sum(list, (x) => x.amount_cents) } } };
}

export function buildPartsHandoff(asOf: string, rows: CommittedRow[]): HandoffDraft {
  const list = rows.filter((r) => r.target_id && r.outcome !== 'ERROR').map((r) => {
    const qty = num(r.data, 'on_hand') ?? 0;
    const cost = num(r.data, 'cost_cents') ?? 0;
    return { part_id: r.target_id, part_number: str(r.data, 'part_number'), manufacturer: str(r.data, 'manufacturer'), bin: str(r.data, 'bin'), on_hand: qty, cost_cents: cost, value_cents: Math.round(qty * cost) };
  });
  const noCost = list.filter((p) => p.on_hand > 0 && p.cost_cents === 0);
  return { kind: 'PARTS_INVENTORY', asOf, facts: [], payload: { kind: 'PARTS_INVENTORY', as_of_date: asOf, parts: list, blockers: [],
    warnings: noCost.length ? [{ ref: null, message: `${noCost.length} part(s) on hand have no cost; they value at $0` }] : [],
    totals: { parts: list.length, units_on_hand: sum(list, (p) => p.on_hand), value_cents: sum(list, (p) => p.value_cents) } } };
}

export function buildWarrantyHandoff(asOf: string, rows: CommittedRow[]): HandoffDraft {
  const list = rows.filter((r) => r.outcome !== 'ERROR').map((r) => ({ claim_number: r.external_ref, unit_serial: str(r.data, 'unit_serial'), manufacturer: str(r.data, 'manufacturer'),
    status: str(r.data, 'status'), amount_cents: num(r.data, 'amount_cents') ?? 0, asset_id: typeof r.data._asset_id === 'string' ? r.data._asset_id : null }));
  return { kind: 'WARRANTY_RECEIVABLE', asOf, facts: [], payload: { kind: 'WARRANTY_RECEIVABLE', as_of_date: asOf, claims: list, blockers: [], warnings: [],
    totals: { claims: list.length, claims_cents: sum(list, (c) => c.amount_cents) } } };
}

/** Which handoff a committed batch of this entity feeds. */
export const HANDOFF_FOR_ENTITY: Partial<Record<string, OpeningKind>> = {
  job: 'JOB_WIP', sov_line: 'JOB_WIP', budget: 'JOB_WIP', commitment: 'JOB_WIP', change_order: 'JOB_WIP',
  agreement: 'AGREEMENT_DEFERRED', unit: 'DEALER_UNITS', rental_unit: 'DEALER_UNITS', open_ar: 'OPEN_AR',
  deposit: 'CUSTOMER_DEPOSITS', special_order: 'CUSTOMER_DEPOSITS', part: 'PARTS_INVENTORY', warranty_claim: 'WARRANTY_RECEIVABLE',
};

/** RFC-4180 CSV of a list of flat objects (Books-ready file). */
export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const cols = Object.keys(rows[0]!);
  const cell = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}

/** The committed entities each opening position is built from. */
export const ENTITIES_FOR_KIND: Readonly<Record<OpeningKind, readonly string[]>> = {
  JOB_WIP: ['job', 'sov_line', 'budget', 'commitment', 'change_order', 'deposit'],
  AGREEMENT_DEFERRED: ['agreement'],
  DEALER_UNITS: ['unit', 'rental_unit'],
  OPEN_AR: ['open_ar'],
  CUSTOMER_DEPOSITS: ['deposit', 'special_order'],
  PARTS_INVENTORY: ['part'],
  WARRANTY_RECEIVABLE: ['warranty_claim'],
};

/** One handoff draft from the committed rows of its entities. */
export function draftFor(kind: OpeningKind, rows: Partial<Record<string, CommittedRow[]>>, asOf: string, opts: { sourceReportedDeferredCents?: number | null } = {}): HandoffDraft {
  switch (kind) {
    case 'JOB_WIP':
      return buildJobWipHandoff({ asOf, jobs: rows.job ?? [], sov: rows.sov_line, budgets: rows.budget, commitments: rows.commitment, changeOrders: rows.change_order, deposits: rows.deposit });
    case 'AGREEMENT_DEFERRED':
      return buildAgreementHandoff(asOf, rows.agreement ?? [], opts.sourceReportedDeferredCents ?? null);
    case 'DEALER_UNITS':
      return buildDealerUnitsHandoff(asOf, [...(rows.unit ?? []), ...(rows.rental_unit ?? [])]);
    case 'OPEN_AR':
      return buildOpenArHandoff(asOf, rows.open_ar ?? []);
    case 'CUSTOMER_DEPOSITS': {
      const a = buildDepositsHandoff(asOf, rows.deposit ?? []);
      const b = buildDepositsHandoff(asOf, rows.special_order ?? [], 'deposit_cents');
      const deposits = [...(a.payload.deposits as unknown[]), ...(b.payload.deposits as unknown[])];
      return { ...a, payload: { ...a.payload, deposits, totals: { deposits: deposits.length, deposits_cents: a.payload.totals.deposits_cents! + b.payload.totals.deposits_cents! } } };
    }
    case 'PARTS_INVENTORY':
      return buildPartsHandoff(asOf, rows.part ?? []);
    case 'WARRANTY_RECEIVABLE':
      return buildWarrantyHandoff(asOf, rows.warranty_claim ?? []);
  }
}
