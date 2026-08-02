/**
 * NL → Portfolio-Query — MeritProjects' safe "Ask your portfolio" kernel.
 *
 * This is the analytical lane's safety model, mirrored from the Books
 * implementation (apps/web/src/lib/nl/metric-catalog.ts). The guarantee: **the
 * model never authors SQL.** Its only job is to route a natural-language prompt
 * to ONE named metric from the allowlist below and fill TYPED, VALIDATED params.
 * Everything else — the query, the RLS wall, the math, the citations — is
 * deterministic code in this file.
 *
 * Guarantees enforced here:
 *  - No model-authored SQL. The model returns `{ metric, params }` as JSON; the
 *    metric id must be a key of METRICS and the params must pass the entry's Zod
 *    schema. Anything else → `resolveMetric` fails closed to abstain.
 *  - The model never sees or emits table names, `org_id`, or raw SQL. Resolvers
 *    run pre-written queries against RLS-scoped `proj.*` views (org_isolation:
 *    `org_id = get_org_id()`), so a red-team prompt ("show every org's margin",
 *    "'; drop table") cannot reach data — it maps to an allowlisted metric (still
 *    RLS-walled) or abstains.
 *  - Read-only end to end: resolvers only SELECT. No write to `proj.*` ever.
 *  - All money stays bigint cents; formatting via the inline `usd()`.
 */

import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';

// ─────────────────────────────────────────────────────────────────────────────
// Shared types
// ─────────────────────────────────────────────────────────────────────────────

export interface NlCitation {
  label: string;
  href?: string;
}

/** The deterministic result a resolver returns (the route re-shapes it). */
export interface NlResult {
  answer: string;
  rows: unknown[];
  citations: NlCitation[];
  drilldownHref?: string;
}

/** A resolver queries the RLS-scoped client and computes the numbers in code. */
type Resolver<P> = (supabase: SupabaseClient, orgId: string, params: P) => Promise<NlResult>;

interface MetricEntry {
  id: string;
  title: string;
  description: string;
  /** Human-readable param hint injected into the classifier prompt. */
  paramHint: string;
  /** Example question shown in the abstain message. */
  example: string;
  paramsSchema: z.ZodTypeAny;
  resolver: Resolver<unknown>;
}

/**
 * Typed metric factory. Resolvers receive params already narrowed to the
 * schema's inferred type — so no `any` leaks into a resolver body. The single
 * cast to the erased `MetricEntry` is contained here.
 */
function defineMetric<S extends z.ZodTypeAny>(m: {
  id: string;
  title: string;
  description: string;
  paramHint: string;
  example: string;
  paramsSchema: S;
  resolver: Resolver<z.infer<S>>;
}): MetricEntry {
  return m as unknown as MetricEntry;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — money + numeric coercion + fuzzy job match
// ─────────────────────────────────────────────────────────────────────────────

/** PostgREST returns bigint as string or number — coerce to a JS number safely. */
function n(v: unknown): number {
  return v == null ? 0 : typeof v === 'number' ? v : Number(v) || 0;
}

/** Compact-but-precise USD from bigint cents (dashboard formatter style). */
function usd(cents: number): string {
  return (Math.round(cents) / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

/** A job drill-down href — the only per-record link pattern the app exposes. */
function jobHref(jobId: string): string {
  return `/jobs/${jobId}`;
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/** A minimal margin-view row shape shared by several resolvers. */
interface JobMarginRow {
  job_id: string;
  job_number: string | null;
  name: string | null;
  revenue_contract_cents: unknown;
  operational_actual_cents: unknown;
  operational_pending_cents: unknown;
  committed_open_cents: unknown;
  projected_final_cents: unknown;
  operational_margin_pct: number | null;
}

function jobLabel(r: { job_number: string | null; name: string | null }): string {
  return [r.job_number, r.name].filter(Boolean).join(' · ') || 'Job';
}

/** Case-insensitive substring match, best (shortest surviving name) first. */
function fuzzyMatch<T extends { job_number: string | null; name: string | null }>(
  rows: T[],
  needle: string,
): T[] {
  const q = needle.trim().toLowerCase();
  if (!q) return [];
  return rows
    .filter((r) => `${r.job_number ?? ''} ${r.name ?? ''}`.toLowerCase().includes(q))
    .sort((a, b) => (a.name ?? '').length - (b.name ?? '').length);
}

// ─────────────────────────────────────────────────────────────────────────────
// The allowlist catalog — ~8 portfolio metrics
// ─────────────────────────────────────────────────────────────────────────────

const emptyParams = z.object({});

const portfolioMargin = defineMetric({
  id: 'portfolio_margin',
  title: 'Portfolio margin',
  description:
    'Portfolio-wide totals: total contract value, projected margin (dollars and percent), and how many jobs are projected to lose money.',
  paramHint: '(no params)',
  example: 'What is our projected margin across the portfolio?',
  paramsSchema: emptyParams,
  async resolver(supabase) {
    const { data, error } = await supabase
      .schema('proj')
      .from('v_job_margin')
      .select('job_id, job_number, name, revenue_contract_cents, projected_final_cents');
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as JobMarginRow[];

    const contract = rows.reduce((s, r) => s + n(r.revenue_contract_cents), 0);
    const projFinal = rows.reduce((s, r) => s + n(r.projected_final_cents), 0);
    const projMargin = contract - projFinal;
    const marginPct = contract > 0 ? projMargin / contract : 0;
    const lossJobs = rows.filter((r) => n(r.revenue_contract_cents) - n(r.projected_final_cents) < 0).length;

    const answer =
      `Across ${rows.length} job${rows.length === 1 ? '' : 's'}, total contract value is ${usd(contract)} ` +
      `and projected margin is ${usd(projMargin)} (${pct(marginPct)} of contract at projected final). ` +
      `${lossJobs === 0 ? 'No jobs are projected to lose money.' : `${lossJobs} job${lossJobs === 1 ? ' is' : 's are'} projected to lose money.`}`;
    return {
      answer,
      rows: [
        { label: 'Total contract value', amountCents: contract },
        { label: 'Projected final cost', amountCents: projFinal },
        { label: 'Projected margin', amountCents: projMargin },
        { label: 'Projected-loss jobs', count: lossJobs },
      ],
      citations: [{ label: 'Portfolio dashboard', href: '/' }],
      drilldownHref: '/',
    };
  },
});

const jobsAtRisk = defineMetric({
  id: 'jobs_at_risk',
  title: 'Jobs at risk',
  description:
    'Jobs projected to lose money, or whose projected operational margin is below a threshold (default 10%).',
  paramHint: 'margin_pct? (number 0..1, the margin floor — e.g. 0.1 for 10%; default 0.10)',
  example: 'Which jobs are at risk or below a 12% margin?',
  paramsSchema: z.object({ margin_pct: z.number().min(0).max(1).optional() }),
  async resolver(supabase, _orgId, params) {
    const floorPct = (params.margin_pct ?? 0.1) * 100; // view stores margin as a 0..100 percent
    const { data, error } = await supabase
      .schema('proj')
      .from('v_job_margin')
      .select('job_id, job_number, name, revenue_contract_cents, projected_final_cents, operational_margin_pct');
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as JobMarginRow[];

    const atRisk = rows
      .map((r) => {
        const projMargin = n(r.revenue_contract_cents) - n(r.projected_final_cents);
        const loss = projMargin < 0;
        const thin = r.operational_margin_pct != null && r.operational_margin_pct < floorPct;
        return { r, projMargin, loss, thin };
      })
      .filter((x) => x.loss || x.thin)
      .sort((a, b) => a.projMargin - b.projMargin);

    const citations: NlCitation[] = atRisk.map((x) => ({ label: jobLabel(x.r), href: jobHref(x.r.job_id) }));
    const answer =
      atRisk.length === 0
        ? `No jobs are projected to lose money or fall below a ${floorPct.toFixed(0)}% margin.`
        : `${atRisk.length} job${atRisk.length === 1 ? '' : 's'} at risk (projected loss or below ${floorPct.toFixed(0)}% margin): ` +
          atRisk
            .slice(0, 8)
            .map((x) => `${jobLabel(x.r)} (${x.loss ? `−${usd(Math.abs(x.projMargin))}` : `${x.r.operational_margin_pct?.toFixed(1)}%`})`)
            .join('; ') +
          (atRisk.length > 8 ? `, and ${atRisk.length - 8} more.` : '.');
    return {
      answer,
      rows: atRisk.map((x) => ({
        jobId: x.r.job_id,
        job: jobLabel(x.r),
        projectedMarginCents: x.projMargin,
        marginPct: x.r.operational_margin_pct,
        reason: x.loss ? 'projected_loss' : 'below_threshold',
      })),
      citations,
      drilldownHref: '/jobs',
    };
  },
});

const overBudgetCostCodes = defineMetric({
  id: 'over_budget_cost_codes',
  title: 'Over-budget cost codes',
  description: 'Cost codes running over budget (negative variance), optionally filtered to one job by name.',
  paramHint: 'job_name? (string — fuzzy match against job number/name)',
  example: 'Which cost codes are over budget on the Ridgeline job?',
  paramsSchema: z.object({ job_name: z.string().min(1).optional() }),
  async resolver(supabase, _orgId, params) {
    const [slipRes, jobRes] = await Promise.all([
      supabase
        .schema('proj')
        .from('v_cost_code_slippage')
        .select('job_id, cost_code, cost_code_name, budgeted_cents, actual_cents, projected_final_cents, variance_cents'),
      supabase.schema('proj').from('v_job_margin').select('job_id, job_number, name'),
    ]);
    if (slipRes.error) throw new Error(slipRes.error.message);
    if (jobRes.error) throw new Error(jobRes.error.message);

    interface SlipRow {
      job_id: string;
      cost_code: string | null;
      cost_code_name: string | null;
      budgeted_cents: unknown;
      actual_cents: unknown;
      projected_final_cents: unknown;
      variance_cents: unknown;
    }
    const jobs = (jobRes.data ?? []) as Array<{ job_id: string; job_number: string | null; name: string | null }>;
    const jobById = new Map(jobs.map((j) => [j.job_id, j]));

    let allowed: Set<string> | null = null;
    if (params.job_name) {
      const matched = fuzzyMatch(jobs, params.job_name);
      allowed = new Set(matched.map((m) => m.job_id));
      if (allowed.size === 0) {
        return {
          answer: `No job matched "${params.job_name}", so there are no cost codes to report.`,
          rows: [],
          citations: [{ label: 'All jobs', href: '/jobs' }],
          drilldownHref: '/jobs',
        };
      }
    }

    const over = ((slipRes.data ?? []) as SlipRow[])
      .filter((r) => n(r.variance_cents) < 0 && (!allowed || allowed.has(r.job_id)))
      .sort((a, b) => n(a.variance_cents) - n(b.variance_cents));

    const totalOver = over.reduce((s, r) => s + Math.abs(n(r.variance_cents)), 0);
    const citeJobIds = [...new Set(over.map((r) => r.job_id))];
    const citations: NlCitation[] = citeJobIds.map((id) => {
      const j = jobById.get(id);
      return { label: j ? jobLabel(j) : 'Job', href: jobHref(id) };
    });
    const answer =
      over.length === 0
        ? params.job_name
          ? `No cost codes are over budget on the matched job.`
          : `No cost codes are over budget across the portfolio.`
        : `${over.length} cost code${over.length === 1 ? '' : 's'} over budget by ${usd(totalOver)} in total. ` +
          `Worst: ` +
          over
            .slice(0, 5)
            .map((r) => `${r.cost_code ?? r.cost_code_name ?? 'code'} (−${usd(Math.abs(n(r.variance_cents)))})`)
            .join(', ') +
          '.';
    return {
      answer,
      rows: over.map((r) => ({
        jobId: r.job_id,
        job: jobById.get(r.job_id) ? jobLabel(jobById.get(r.job_id)!) : null,
        costCode: r.cost_code,
        costCodeName: r.cost_code_name,
        budgetedCents: n(r.budgeted_cents),
        actualCents: n(r.actual_cents),
        projectedFinalCents: n(r.projected_final_cents),
        varianceCents: n(r.variance_cents),
      })),
      citations,
      drilldownHref: '/jobs',
    };
  },
});

const retainageOutstanding = defineMetric({
  id: 'retainage_outstanding',
  title: 'Retainage outstanding',
  description: 'Total and per-job retainage still being held (withheld minus released).',
  paramHint: '(no params)',
  example: 'How much retainage are we holding across jobs?',
  paramsSchema: emptyParams,
  async resolver(supabase) {
    const [retRes, jobRes] = await Promise.all([
      supabase.schema('proj').from('v_job_retainage').select('job_id, held_cents, released_cents, outstanding_cents'),
      supabase.schema('core').from('jobs').select('id, job_number, name'),
    ]);
    if (retRes.error) throw new Error(retRes.error.message);
    if (jobRes.error) throw new Error(jobRes.error.message);

    interface RetRow { job_id: string; held_cents: unknown; released_cents: unknown; outstanding_cents: unknown }
    const jobs = (jobRes.data ?? []) as Array<{ id: string; job_number: string | null; name: string | null }>;
    const jobById = new Map(jobs.map((j) => [j.id, j]));

    const held = ((retRes.data ?? []) as RetRow[])
      .filter((r) => n(r.outstanding_cents) !== 0)
      .sort((a, b) => n(b.outstanding_cents) - n(a.outstanding_cents));
    const total = held.reduce((s, r) => s + n(r.outstanding_cents), 0);

    const citations: NlCitation[] = held.map((r) => {
      const j = jobById.get(r.job_id);
      return { label: j ? jobLabel({ job_number: j.job_number, name: j.name }) : 'Job', href: jobHref(r.job_id) };
    });
    const answer =
      held.length === 0
        ? 'No retainage is currently outstanding across the portfolio.'
        : `${usd(total)} in retainage is outstanding across ${held.length} job${held.length === 1 ? '' : 's'}. ` +
          `Largest: ` +
          held
            .slice(0, 5)
            .map((r) => {
              const j = jobById.get(r.job_id);
              return `${j ? jobLabel({ job_number: j.job_number, name: j.name }) : 'Job'} (${usd(n(r.outstanding_cents))})`;
            })
            .join(', ') +
          '.';
    return {
      answer,
      rows: held.map((r) => {
        const j = jobById.get(r.job_id);
        return {
          jobId: r.job_id,
          job: j ? jobLabel({ job_number: j.job_number, name: j.name }) : null,
          heldCents: n(r.held_cents),
          releasedCents: n(r.released_cents),
          outstandingCents: n(r.outstanding_cents),
        };
      }),
      citations,
      drilldownHref: '/jobs',
    };
  },
});

const billingStatus = defineMetric({
  id: 'billing_status',
  title: 'Billing status',
  description:
    'Billing requests (draws / SOV bills) counted by status, optionally filtered to one job by name.',
  paramHint: 'job_name? (string — fuzzy match against job number/name)',
  example: 'How many draws are still in draft?',
  paramsSchema: z.object({ job_name: z.string().min(1).optional() }),
  async resolver(supabase, _orgId, params) {
    const jobRes = await supabase.schema('proj').from('v_job_margin').select('job_id, job_number, name');
    if (jobRes.error) throw new Error(jobRes.error.message);
    const jobs = (jobRes.data ?? []) as Array<{ job_id: string; job_number: string | null; name: string | null }>;

    let allowed: Set<string> | null = null;
    if (params.job_name) {
      allowed = new Set(fuzzyMatch(jobs, params.job_name).map((m) => m.job_id));
      if (allowed.size === 0) {
        return {
          answer: `No job matched "${params.job_name}", so there is nothing to bill on it.`,
          rows: [],
          citations: [{ label: 'All jobs', href: '/jobs' }],
          drilldownHref: '/jobs',
        };
      }
    }

    let query = supabase.schema('proj').from('billing_requests').select('id, job_id, status, billing_type');
    if (allowed && allowed.size > 0) query = query.in('job_id', [...allowed]);
    const { data, error } = await query;
    if (error) throw new Error(error.message);

    interface BrRow { id: string; job_id: string; status: string | null; billing_type: string | null }
    const brs = (data ?? []) as BrRow[];
    const byStatus = new Map<string, number>();
    for (const b of brs) byStatus.set(b.status ?? 'UNKNOWN', (byStatus.get(b.status ?? 'UNKNOWN') ?? 0) + 1);
    const statusRows = [...byStatus.entries()].map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count);

    const scope = params.job_name ? ' on the matched job' : ' across the portfolio';
    const answer =
      brs.length === 0
        ? `There are no billing requests${scope}.`
        : `${brs.length} billing request${brs.length === 1 ? '' : 's'}${scope}: ` +
          statusRows.map((s) => `${s.count} ${s.status}`).join(', ') +
          '.';
    return {
      answer,
      rows: statusRows,
      citations: [{ label: 'All jobs', href: '/jobs' }],
      drilldownHref: '/jobs',
    };
  },
});

const gatesBlockingBilling = defineMetric({
  id: 'gates_blocking_billing',
  title: 'Gates blocking billing',
  description:
    'External gates (permits, PTO, inspections) that are not CLEARED or WAIVED and are marked as blocking billing.',
  paramHint: '(no params)',
  example: 'What permits are blocking billing right now?',
  paramsSchema: emptyParams,
  async resolver(supabase) {
    const [gateRes, jobRes] = await Promise.all([
      supabase
        .schema('proj')
        .from('external_gates')
        .select('id, job_id, gate_type, name, status, required, blocks_billing')
        .eq('blocks_billing', true)
        .eq('required', true),
      supabase.schema('core').from('jobs').select('id, job_number, name'),
    ]);
    if (gateRes.error) throw new Error(gateRes.error.message);
    if (jobRes.error) throw new Error(jobRes.error.message);

    interface GateRow {
      id: string;
      job_id: string;
      gate_type: string;
      name: string | null;
      status: string;
      blocks_billing: boolean;
    }
    const jobs = (jobRes.data ?? []) as Array<{ id: string; job_number: string | null; name: string | null }>;
    const jobById = new Map(jobs.map((j) => [j.id, j]));

    const open = ((gateRes.data ?? []) as GateRow[]).filter((g) => !['CLEARED', 'WAIVED'].includes(g.status));

    const citations: NlCitation[] = open.map((g) => {
      const j = jobById.get(g.job_id);
      const jl = j ? jobLabel({ job_number: j.job_number, name: j.name }) : 'Job';
      return { label: `${jl} · ${g.name ?? g.gate_type}`, href: jobHref(g.job_id) };
    });
    const answer =
      open.length === 0
        ? 'No required billing-blocking gates are open — nothing is gating a draw.'
        : `${open.length} gate${open.length === 1 ? '' : 's'} blocking billing: ` +
          open
            .slice(0, 8)
            .map((g) => {
              const j = jobById.get(g.job_id);
              const jl = j ? jobLabel({ job_number: j.job_number, name: j.name }) : 'Job';
              return `${g.name ?? g.gate_type} (${g.status.toLowerCase()}) on ${jl}`;
            })
            .join('; ') +
          '.';
    return {
      answer,
      rows: open.map((g) => ({
        gateId: g.id,
        jobId: g.job_id,
        gateType: g.gate_type,
        name: g.name,
        status: g.status,
      })),
      citations,
      drilldownHref: '/jobs',
    };
  },
});

const commitmentExposure = defineMetric({
  id: 'commitment_exposure',
  title: 'Commitment exposure',
  description:
    'Open commitment exposure: committed PO/subcontract dollars not yet invoiced (committed, invoiced, and open).',
  paramHint: '(no params)',
  example: 'What is our open commitment exposure to subs?',
  paramsSchema: emptyParams,
  async resolver(supabase) {
    const { data, error } = await supabase
      .schema('proj')
      .from('v_commitment_status')
      .select('job_id, amount_cents, invoiced_cents, open_cents');
    if (error) throw new Error(error.message);
    interface CmtRow { job_id: string; amount_cents: unknown; invoiced_cents: unknown; open_cents: unknown }
    const rows = (data ?? []) as CmtRow[];

    const committed = rows.reduce((s, r) => s + n(r.amount_cents), 0);
    const invoiced = rows.reduce((s, r) => s + n(r.invoiced_cents), 0);
    const open = rows.reduce((s, r) => s + n(r.open_cents), 0);
    const jobsWithOpen = new Set(rows.filter((r) => n(r.open_cents) > 0).map((r) => r.job_id)).size;

    const answer =
      rows.length === 0
        ? 'There are no open commitments (approved POs or subcontracts) across the portfolio.'
        : `Open commitment exposure is ${usd(open)} across ${jobsWithOpen} job${jobsWithOpen === 1 ? '' : 's'} ` +
          `(${usd(committed)} committed, ${usd(invoiced)} invoiced to date).`;
    return {
      answer,
      rows: [
        { label: 'Committed', amountCents: committed },
        { label: 'Invoiced to date', amountCents: invoiced },
        { label: 'Open exposure', amountCents: open },
      ],
      citations: [{ label: 'All jobs', href: '/jobs' }],
      drilldownHref: '/jobs',
    };
  },
});

const jobLookup = defineMetric({
  id: 'job_lookup',
  title: 'Job lookup',
  description:
    'A single job by fuzzy name: contract value, projected margin, percent complete, outstanding retainage, and open gates.',
  paramHint: 'job_name (string, REQUIRED — fuzzy match against job number/name)',
  example: 'Show me the numbers on the Ridgeline job.',
  paramsSchema: z.object({ job_name: z.string().min(1) }),
  async resolver(supabase, _orgId, params) {
    const marginRes = await supabase
      .schema('proj')
      .from('v_job_margin')
      .select(
        'job_id, job_number, name, revenue_contract_cents, operational_actual_cents, operational_pending_cents, committed_open_cents, projected_final_cents, operational_margin_pct',
      );
    if (marginRes.error) throw new Error(marginRes.error.message);
    const margins = (marginRes.data ?? []) as JobMarginRow[];
    const matched = fuzzyMatch(margins, params.job_name);

    if (matched.length === 0) {
      return {
        answer: `No job matched "${params.job_name}". Try the job number or a distinctive word from its name.`,
        rows: [],
        citations: [{ label: 'All jobs', href: '/jobs' }],
        drilldownHref: '/jobs',
      };
    }
    const job = matched[0];

    const [contractRes, retRes, gateRes] = await Promise.all([
      supabase.schema('proj').from('v_contract_current').select('job_id, pct_complete').eq('job_id', job.job_id),
      supabase.schema('proj').from('v_job_retainage').select('job_id, outstanding_cents').eq('job_id', job.job_id),
      supabase
        .schema('proj')
        .from('external_gates')
        .select('id, status, required')
        .eq('job_id', job.job_id)
        .eq('required', true),
    ]);
    if (contractRes.error) throw new Error(contractRes.error.message);
    if (retRes.error) throw new Error(retRes.error.message);
    if (gateRes.error) throw new Error(gateRes.error.message);

    const pctComplete = ((contractRes.data ?? [])[0] as { pct_complete: number | null } | undefined)?.pct_complete ?? null;
    const outstandingRet = n(((retRes.data ?? [])[0] as { outstanding_cents: unknown } | undefined)?.outstanding_cents);
    const openGates = ((gateRes.data ?? []) as Array<{ status: string }>).filter(
      (g) => !['CLEARED', 'WAIVED'].includes(g.status),
    ).length;

    const contract = n(job.revenue_contract_cents);
    const projFinal = n(job.projected_final_cents);
    const projMargin = contract - projFinal;
    const marginPct = contract > 0 ? projMargin / contract : 0;
    const jl = jobLabel(job);

    const answer =
      `${jl}: contract ${usd(contract)}, projected margin ${usd(projMargin)} (${pct(marginPct)}), ` +
      `${pctComplete == null ? 'percent complete unavailable' : `${Math.round(pctComplete * 100)}% complete`}, ` +
      `${usd(outstandingRet)} retainage outstanding, ${openGates} open required gate${openGates === 1 ? '' : 's'}` +
      (matched.length > 1 ? `. (${matched.length - 1} other job${matched.length - 1 === 1 ? '' : 's'} also matched — refine the name.)` : '.');
    return {
      answer,
      rows: [
        {
          jobId: job.job_id,
          job: jl,
          contractCents: contract,
          projectedFinalCents: projFinal,
          projectedMarginCents: projMargin,
          marginPct: job.operational_margin_pct,
          pctComplete,
          committedOpenCents: n(job.committed_open_cents),
          outstandingRetainageCents: outstandingRet,
          openRequiredGates: openGates,
        },
      ],
      citations: [{ label: jl, href: jobHref(job.job_id) }],
      drilldownHref: jobHref(job.job_id),
    };
  },
});

/** The allowlist. The model may ONLY select one of these ids. */
export const METRICS: Record<string, MetricEntry> = {
  [portfolioMargin.id]: portfolioMargin,
  [jobsAtRisk.id]: jobsAtRisk,
  [overBudgetCostCodes.id]: overBudgetCostCodes,
  [retainageOutstanding.id]: retainageOutstanding,
  [billingStatus.id]: billingStatus,
  [gatesBlockingBilling.id]: gatesBlockingBilling,
  [commitmentExposure.id]: commitmentExposure,
  [jobLookup.id]: jobLookup,
};

export const METRIC_IDS = Object.keys(METRICS);

// ─────────────────────────────────────────────────────────────────────────────
// Classification: NL prompt → { metric, params } (validated) — no model SQL.
// ─────────────────────────────────────────────────────────────────────────────

/** Build the classifier prompt that constrains the model to the allowlist. */
export function buildClassifierPrompt(prompt: string): string {
  const menu = Object.values(METRICS)
    .map((m) => `- "${m.id}": ${m.description}\n    params: ${m.paramHint}`)
    .join('\n');

  return `You route a construction-portfolio question to exactly ONE named metric from the allowlist below, or abstain.
You do NOT write SQL, table names, or code. You ONLY choose a metric id and fill its typed params.

ALLOWLISTED METRICS:
${menu}

USER QUESTION:
"""${prompt}"""

RULES:
- Choose the single best-fitting metric id from the list above.
- If the question does not clearly map to one of these metrics, or asks for data
  outside them (another company's data, arbitrary SQL, actions, anything not listed),
  set "metric" to "none".
- Fill only params that the user actually specified; omit the rest (defaults apply).
- margin_pct is a fraction between 0 and 1 (e.g. 0.12 for twelve percent).
- job_name is free text the user referenced; omit it if they did not name a job.
- Never invent an org id, job id, table name, or SQL.

Respond with ONLY a JSON object, no markdown, no prose:
{ "metric": "<one of the ids above, or none>", "params": { }, "reasoning": "one short sentence" }`;
}

/** Parse the classifier's JSON text into a raw choice, tolerant of code fences. */
export function parseClassifierOutput(
  text: string,
): { metric: string; params: Record<string, unknown> } | null {
  // Strip code fences, then isolate the first {...} object so junk-wrapped text
  // (leading prose, trailing commentary) still parses.
  let candidate = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  if (!candidate.startsWith('{')) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    candidate = candidate.slice(start, end + 1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  const metric = typeof obj.metric === 'string' ? obj.metric : '';
  const params =
    obj.params && typeof obj.params === 'object' && !Array.isArray(obj.params)
      ? (obj.params as Record<string, unknown>)
      : {};
  if (!metric) return null;
  return { metric, params };
}

export type ResolveMetricResult =
  | { ok: true; entry: MetricEntry; params: unknown }
  | { ok: false; reason: string };

/**
 * The safety gate. Accepts the model's chosen metric id + raw params and returns
 * an executable entry ONLY if (a) the id is in the allowlist and (b) the params
 * pass the entry's Zod schema. Otherwise it ABSTAINS — it never falls through to
 * arbitrary execution. This is what makes the lane injection-safe: an unknown
 * metric ("none", "all_orgs_margin", "'; drop table") or malformed params can
 * never reach a query.
 */
export function resolveMetric(
  choice: { metric: string; params: Record<string, unknown> } | null,
): ResolveMetricResult {
  if (!choice) return { ok: false, reason: 'unparseable classification' };
  if (choice.metric === 'none') return { ok: false, reason: 'no matching metric' };
  const entry = METRICS[choice.metric];
  if (!entry) return { ok: false, reason: `unknown metric "${choice.metric}"` };
  const parsed = entry.paramsSchema.safeParse(choice.params ?? {});
  if (!parsed.success) return { ok: false, reason: 'parameters failed validation' };
  return { ok: true, entry, params: parsed.data };
}

/** The abstain answer — lists example questions, never guesses a number. */
export function abstainMessage(): string {
  const list = Object.values(METRICS)
    .map((m) => `• ${m.example}`)
    .join('\n');
  return (
    "I can't answer that from the portfolio ledger. I can answer questions like these, scoped to your organization:\n" +
    list
  );
}
