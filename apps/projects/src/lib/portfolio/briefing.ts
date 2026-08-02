/**
 * Portfolio briefing — deterministic fact computer (Projects · PORTFOLIO_NARRATIVE).
 *
 * The CORRECTNESS GUARANTEE for the dashboard's AI briefing. EVERY number the
 * briefing can state — backlog, projected margin, at-risk counts, the ranked
 * attention items and their dollar impact — is computed HERE, in code, from the
 * already-loaded (RLS-scoped) portfolio rows. The Core AI gateway is only ever
 * handed these already-computed facts and asked to PHRASE them; it never
 * recomputes, invents, or alters a figure. This mirrors the Books flux-narrative
 * pattern (apps/web · lib/reports/variance.ts + api/reports/narrative).
 *
 * Pure and side-effect free (rows in → facts out) so it is exhaustively
 * unit-testable. All money is integer cents. `projectedMarginPct` is the only
 * derived float and is `null` (not zero) when there is no contract base, so the
 * narrative can say "—" rather than fabricate a percentage.
 */

/** Below this operational-margin percentage a job is flagged "thin margin". */
export const THIN_MARGIN_PCT = 12;

/** How many ranked attention items the briefing surfaces. */
export const TOP_ATTENTION = 3;

// ── Input rows (a subset of the exact dashboard view columns) ─────────────────

/** One row of proj.v_job_margin. */
export interface JobMarginRow {
  job_id: string;
  job_number: string | null;
  name: string | null;
  revenue_contract_cents: number | string | null;
  operational_actual_cents: number | string | null;
  operational_pending_cents: number | string | null;
  committed_open_cents: number | string | null;
  projected_final_cents: number | string | null;
  operational_margin_pct: number | null;
}

/** One row of proj.v_cost_code_slippage. */
export interface CostCodeSlipRow {
  job_id: string;
  variance_cents: number | string | null;
}

/** One row of proj.external_gates. */
export interface GateRow {
  job_id: string;
  name: string | null;
  gate_type: string;
  status: string;
  blocks_billing: boolean;
}

/** One row of proj.billing_requests. */
export interface DrawRow {
  job_id: string;
  status: string;
}

export interface BriefingInputs {
  margins: JobMarginRow[];
  slips: CostCodeSlipRow[];
  gates: GateRow[];
  draws: DrawRow[];
}

// ── Output facts ──────────────────────────────────────────────────────────────

export type AttentionKind =
  | 'projected_loss'
  | 'thin_margin'
  | 'cost_overrun'
  | 'billing_gate'
  | 'unissued_draw';

export type Severity = 'critical' | 'warning' | 'info';

export interface AttentionItem {
  kind: AttentionKind;
  severity: Severity;
  /** Short headline, e.g. "Projected loss" or "2 cost codes over budget". */
  label: string;
  /** Sub-label identifying the job, e.g. "1042 · North Tower". */
  detail: string;
  /** Signed dollar impact in cents (negative = drag); 0 for non-dollar items. */
  impactCents: number;
  /** Drill-through link into the job. */
  href: string;
}

export interface BriefingTotals {
  contractBacklogCents: number;
  projectedFinalCents: number;
  costToDateCents: number;
  committedOpenCents: number;
  pendingCostCents: number;
  projectedMarginCents: number;
  /** Projected margin as a % of contract; null when there is no contract base. */
  projectedMarginPct: number | null;
}

export interface BriefingCounts {
  jobs: number;
  jobsAtProjectedLoss: number;
  thinMarginJobs: number;
  overBudgetCostCodes: number;
  gatesBlockingBilling: number;
  unissuedDraws: number;
}

export interface BriefingFacts {
  totals: BriefingTotals;
  counts: BriefingCounts;
  /** Ranked top-N attention items (by severity, then |impact|). */
  attention: AttentionItem[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Coerce a possibly-string bigint / null column value to a finite number. */
function num(v: number | string | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Compact, signed money label from cents — "$1.2M", "$340K", "-$5K". */
export function compactMoney(cents: number): string {
  const dollars = cents / 100;
  const sign = dollars < 0 ? '-' : '';
  const a = Math.abs(dollars);
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1)}M`;
  if (a >= 1_000) return `${sign}$${Math.round(a / 1_000)}K`;
  return `${sign}$${Math.round(a)}`;
}

/** Percent label — "18.4%" or "—" when not computable. */
export function pctLabel(v: number | null): string {
  return v == null ? '—' : `${v.toFixed(1)}%`;
}

function jobLabel(m: JobMarginRow): string {
  return `${m.job_number ?? ''} · ${m.name ?? 'Job'}`.trim();
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

// ── The pure computer ─────────────────────────────────────────────────────────

/**
 * Compute the deterministic briefing facts from already-loaded portfolio rows.
 * Reuses the EXACT signal logic the dashboard renders (page.tsx): projected-loss
 * and thin-margin jobs from v_job_margin, over-budget cost codes from
 * v_cost_code_slippage, billing-blocking gates from external_gates, and unissued
 * DRAFT draws from billing_requests.
 */
export function computeBriefingFacts(inputs: BriefingInputs): BriefingFacts {
  const { margins, slips, gates, draws } = inputs;

  // ---- Portfolio totals (identical aggregation to the dashboard pulse) ----
  let contractBacklogCents = 0;
  let costToDateCents = 0;
  let pendingCostCents = 0;
  let committedOpenCents = 0;
  let projectedFinalCents = 0;
  for (const m of margins) {
    contractBacklogCents += num(m.revenue_contract_cents);
    costToDateCents += num(m.operational_actual_cents);
    pendingCostCents += num(m.operational_pending_cents);
    committedOpenCents += num(m.committed_open_cents);
    projectedFinalCents += num(m.projected_final_cents);
  }
  const projectedMarginCents = contractBacklogCents - projectedFinalCents;
  const projectedMarginPct =
    contractBacklogCents > 0 ? Math.round((projectedMarginCents / contractBacklogCents) * 1000) / 10 : null;

  // ---- Attention feed + risk counts (same predicates as page.tsx) ----
  const attention: AttentionItem[] = [];
  let jobsAtProjectedLoss = 0;
  let thinMarginJobs = 0;

  for (const m of margins) {
    const pm = num(m.revenue_contract_cents) - num(m.projected_final_cents);
    if (pm < 0) {
      jobsAtProjectedLoss += 1;
      attention.push({
        kind: 'projected_loss',
        severity: 'critical',
        label: 'Projected loss',
        detail: jobLabel(m),
        impactCents: pm,
        href: `/jobs/${m.job_id}`,
      });
    } else if (m.operational_margin_pct != null && m.operational_margin_pct < THIN_MARGIN_PCT) {
      thinMarginJobs += 1;
      attention.push({
        kind: 'thin_margin',
        severity: 'warning',
        label: `Thin margin · ${pctLabel(m.operational_margin_pct)}`,
        detail: jobLabel(m),
        impactCents: pm,
        href: `/jobs/${m.job_id}`,
      });
    }
  }

  // Over-budget cost codes: slips with a negative variance, grouped by job.
  const marginByJob = new Map<string, JobMarginRow>();
  for (const m of margins) marginByJob.set(m.job_id, m);
  const overByJob = new Map<string, { amtCents: number; codes: number }>();
  let overBudgetCostCodes = 0;
  for (const s of slips) {
    const v = num(s.variance_cents);
    if (v < 0) {
      overBudgetCostCodes += 1;
      const e = overByJob.get(s.job_id) ?? { amtCents: 0, codes: 0 };
      e.amtCents += Math.abs(v);
      e.codes += 1;
      overByJob.set(s.job_id, e);
    }
  }
  for (const [jobId, e] of overByJob) {
    const m = marginByJob.get(jobId);
    attention.push({
      kind: 'cost_overrun',
      severity: 'warning',
      label: `${e.codes} cost code${e.codes > 1 ? 's' : ''} over budget`,
      detail: m ? jobLabel(m) : jobId,
      impactCents: -e.amtCents,
      href: `/jobs/${jobId}`,
    });
  }

  // Gates blocking billing: open (not cleared/waived) AND blocks_billing.
  const openGates = gates.filter((g) => !['CLEARED', 'WAIVED'].includes(g.status));
  const blockingGates = openGates.filter((g) => g.blocks_billing);
  for (const g of blockingGates) {
    const m = marginByJob.get(g.job_id);
    attention.push({
      kind: 'billing_gate',
      severity: 'info',
      label: `${g.name ?? g.gate_type} — blocks billing`,
      detail: m ? jobLabel(m) : g.job_id,
      impactCents: 0,
      href: `/jobs/${g.job_id}`,
    });
  }

  // Unissued draws: DRAFT billing requests.
  const draftDraws = draws.filter((d) => d.status === 'DRAFT');
  for (const d of draftDraws) {
    const m = marginByJob.get(d.job_id);
    if (m) {
      attention.push({
        kind: 'unissued_draw',
        severity: 'info',
        label: 'Draw ready — not yet issued',
        detail: jobLabel(m),
        impactCents: 0,
        href: `/jobs/${d.job_id}`,
      });
    }
  }

  // Rank: severity first, then largest absolute dollar impact, then stable label.
  attention.sort((a, b) => {
    const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (s !== 0) return s;
    const d = Math.abs(b.impactCents) - Math.abs(a.impactCents);
    if (d !== 0) return d;
    return a.detail.localeCompare(b.detail);
  });

  return {
    totals: {
      contractBacklogCents,
      projectedFinalCents,
      costToDateCents,
      committedOpenCents,
      pendingCostCents,
      projectedMarginCents,
      projectedMarginPct,
    },
    counts: {
      jobs: margins.length,
      jobsAtProjectedLoss,
      thinMarginJobs,
      overBudgetCostCodes,
      gatesBlockingBilling: blockingGates.length,
      unissuedDraws: draftDraws.length,
    },
    attention: attention.slice(0, TOP_ATTENTION),
  };
}

// ── Gateway prompt (the model PHRASES these facts; it never authors figures) ──

export const NARRATIVE_SYSTEM =
  'You are a construction operations principal briefing yourself on the state of the portfolio. ' +
  'You are given figures that have ALREADY been computed from the ledger. ' +
  'STRICT RULES: (1) Use ONLY the numbers provided — never invent, recompute, round differently, ' +
  'or introduce any figure that is not in the facts. (2) Do not speculate about causes the data ' +
  'does not contain. (3) Write 2-3 tight, plain sentences: lead with backlog and projected margin, ' +
  'then what needs attention. No markdown, no headings, no bullets — just the sentences.';

/** Build the user prompt handing the computed facts to the gateway to phrase. */
export function buildNarrativePrompt(facts: BriefingFacts): string {
  const t = facts.totals;
  const c = facts.counts;
  const factLines = [
    `Contracted backlog: ${compactMoney(t.contractBacklogCents)} across ${c.jobs} job${c.jobs === 1 ? '' : 's'}`,
    `Projected margin: ${compactMoney(t.projectedMarginCents)} (${pctLabel(t.projectedMarginPct)} of contract at projected final)`,
    `Cost to date: ${compactMoney(t.costToDateCents)}; committed open: ${compactMoney(t.committedOpenCents)}; pending cost: ${compactMoney(t.pendingCostCents)}`,
    `Jobs tracking to a projected loss: ${c.jobsAtProjectedLoss}`,
    `Jobs below a ${THIN_MARGIN_PCT}% margin: ${c.thinMarginJobs}`,
    `Cost codes over budget: ${c.overBudgetCostCodes}`,
    `Gates blocking billing: ${c.gatesBlockingBilling}`,
    `Draws ready but not yet issued: ${c.unissuedDraws}`,
  ];
  const attnLines =
    facts.attention.length === 0
      ? '(nothing at risk)'
      : facts.attention
          .map((a, i) => {
            const impact = a.impactCents === 0 ? '' : ` — ${compactMoney(a.impactCents)}`;
            return `${i + 1}. ${a.label} (${a.detail})${impact}`;
          })
          .join('\n');

  return [
    'FACTS (already computed — phrase these, do not alter or add any number):',
    '',
    factLines.join('\n'),
    '',
    'Top attention items (ranked):',
    attnLines,
    '',
    'Write the 2-3 sentence portfolio briefing now.',
  ].join('\n');
}

// ── Deterministic fallback (always correct, no model) ─────────────────────────

/**
 * Templated fallback narrative used when the gateway is unavailable. Always
 * truthful — every figure comes straight from `facts`.
 */
export function deterministicNarrative(facts: BriefingFacts): string {
  const t = facts.totals;
  const c = facts.counts;

  if (c.jobs === 0) {
    return 'No active jobs in the portfolio yet — the briefing will populate once work is underway.';
  }

  const sentences: string[] = [];
  sentences.push(
    `The portfolio carries ${compactMoney(t.contractBacklogCents)} in contracted backlog across ${c.jobs} ` +
      `job${c.jobs === 1 ? '' : 's'}, with a projected margin of ${compactMoney(t.projectedMarginCents)} ` +
      `(${pctLabel(t.projectedMarginPct)} of contract).`,
  );

  const risks: string[] = [];
  if (c.jobsAtProjectedLoss > 0) {
    risks.push(`${c.jobsAtProjectedLoss} job${c.jobsAtProjectedLoss === 1 ? ' is' : 's are'} tracking to a projected loss`);
  }
  if (c.thinMarginJobs > 0) {
    risks.push(`${c.thinMarginJobs} sit${c.thinMarginJobs === 1 ? 's' : ''} below a ${THIN_MARGIN_PCT}% margin`);
  }
  if (c.overBudgetCostCodes > 0) {
    risks.push(`${c.overBudgetCostCodes} cost code${c.overBudgetCostCodes === 1 ? ' is' : 's are'} over budget`);
  }
  sentences.push(
    risks.length > 0
      ? `${risks.join(', ')}.`.replace(/^./, (ch) => ch.toUpperCase())
      : 'No jobs are at a projected loss and every cost code is within budget.',
  );

  const actions: string[] = [];
  if (c.gatesBlockingBilling > 0) {
    actions.push(`${c.gatesBlockingBilling} gate${c.gatesBlockingBilling === 1 ? '' : 's'} blocking billing`);
  }
  if (c.unissuedDraws > 0) {
    actions.push(`${c.unissuedDraws} draw${c.unissuedDraws === 1 ? '' : 's'} ready to issue`);
  }
  if (actions.length > 0) {
    const joined = actions.join(' and ');
    sentences.push(`${joined.charAt(0).toUpperCase()}${joined.slice(1)} awaiting action.`);
  }

  return sentences.join(' ');
}
