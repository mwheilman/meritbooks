/**
 * SUPERVISED AGENT ORCHESTRATION (M9) — the generic run ENGINE.
 *
 * Walks a recipe's ordered steps, honoring the M10 autonomy dial + kill switch PER
 * STEP, and pausing at human gates. It NEVER posts money or hits the GL: PROPOSE
 * steps only apply reversible, non-GL data entry when the tenant's dial explicitly
 * permits it, and HUMAN_GATE steps hand off to the EXISTING gated engines (approval
 * workflow / bill-approve route) that enforce SoD and do the posting. The runner only
 * observes that a gate cleared.
 *
 * PERSISTENCE DEGRADES SAFE. Runs live in public.agent_runs + public.agent_run_steps
 * (RLS-scoped). If those tables are absent (pre-migration), the engine runs the chain
 * EPHEMERALLY for the single request — auto steps advance, a gate pauses — and returns
 * the computed run without a DB row (`persisted: false`). The list/detail surfaces then
 * simply show an empty history rather than crashing. Nothing about safety depends on the
 * tables existing: a missing dial/kill-switch read already resolves to the conservative
 * PROPOSE path (see lib/autonomy/disposition.ts), so a degraded read can never auto-apply.
 *
 * AUDIT. Every step transition writes an immutable ai_decisions row (the agent's own
 * Decision Log) AND a core.action_log entry — best-effort, never blocking the run.
 */

import { randomUUID } from 'crypto';
import type {
  AgentRecipe,
  AgentRunContext,
  AgentRunStatus,
  AgentRunView,
  AgentState,
  AgentStepDef,
  AgentStepKind,
  AgentStepStatus,
  AgentStepView,
  HumanAdvance,
  StepExecuteResult,
} from './types';
import { getRecipe } from './registry';
import { logAction } from '@/lib/trust/action-log';

const AGENT_FEATURE = 'AGENT_ORCHESTRATION';

// ── Internal mutable runtime ─────────────────────────────────────────────────

interface StepRuntime {
  index: number;
  name: string;
  label: string;
  kind: AgentStepKind;
  status: AgentStepStatus;
  disposition: string | null;
  summary: string | null;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  aiDecisionId: string | null;
  gatePrompt: string | null;
  actedByUser: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

interface RunState {
  id: string;
  recipe: AgentRecipe;
  feature: string | null;
  title: string;
  status: AgentRunStatus;
  currentStepIndex: number;
  subjectTable: string | null;
  subjectId: string | null;
  context: AgentState;
  pausedReason: string | null;
  error: string | null;
  createdByUser: string | null;
  createdAt: string;
  updatedAt: string;
  steps: StepRuntime[];
  persisted: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toStepView(s: StepRuntime): AgentStepView {
  return {
    index: s.index,
    name: s.name,
    label: s.label,
    kind: s.kind,
    status: s.status,
    disposition: s.disposition,
    summary: s.summary,
    output: s.output,
    aiDecisionId: s.aiDecisionId,
    gatePrompt: s.gatePrompt,
    actedByUser: s.actedByUser,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
  };
}

function toRunView(rs: RunState): AgentRunView {
  return {
    id: rs.id,
    recipe: rs.recipe.key,
    recipeLabel: rs.recipe.label,
    feature: rs.feature,
    title: rs.title,
    status: rs.status,
    currentStepIndex: rs.currentStepIndex,
    subjectTable: rs.subjectTable,
    subjectId: rs.subjectId,
    context: rs.context,
    pausedReason: rs.pausedReason,
    error: rs.error,
    createdByUser: rs.createdByUser,
    createdAt: rs.createdAt,
    updatedAt: rs.updatedAt,
    steps: rs.steps.map(toStepView),
    persisted: rs.persisted,
  };
}

// ── Persistence (write-through; every op is best-effort / degrade-safe) ───────

async function persistInsert(ctx: AgentRunContext, rs: RunState): Promise<boolean> {
  try {
    const { error: runErr } = await ctx.supabase.from('agent_runs').insert({
      id: rs.id,
      org_id: ctx.orgId,
      location_id: ctx.locationId,
      recipe: rs.recipe.key,
      feature: rs.feature,
      title: rs.title,
      status: rs.status,
      current_step_index: rs.currentStepIndex,
      subject_table: rs.subjectTable,
      subject_id: rs.subjectId,
      context: rs.context,
      paused_reason: rs.pausedReason,
      error: rs.error,
      created_by_user: rs.createdByUser,
      created_at: rs.createdAt,
      updated_at: rs.updatedAt,
    });
    if (runErr) return false;

    const rows = rs.steps.map((s) => ({
      org_id: ctx.orgId,
      run_id: rs.id,
      step_index: s.index,
      name: s.name,
      label: s.label,
      kind: s.kind,
      status: s.status,
      disposition: s.disposition,
      input: s.input,
      output: s.output,
      ai_decision_id: s.aiDecisionId,
      summary: s.summary,
      acted_by_user: s.actedByUser,
      started_at: s.startedAt,
      ended_at: s.endedAt,
    }));
    const { error: stepErr } = await ctx.supabase.from('agent_run_steps').insert(rows);
    if (stepErr) {
      // Roll back the orphan run row so a half-written run never lingers.
      await ctx.supabase.from('agent_runs').delete().eq('id', rs.id);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function persistRun(ctx: AgentRunContext, rs: RunState): Promise<void> {
  if (!rs.persisted) return;
  try {
    await ctx.supabase
      .from('agent_runs')
      .update({
        status: rs.status,
        current_step_index: rs.currentStepIndex,
        subject_table: rs.subjectTable,
        subject_id: rs.subjectId,
        context: rs.context,
        paused_reason: rs.pausedReason,
        error: rs.error,
        updated_at: rs.updatedAt,
      })
      .eq('org_id', ctx.orgId)
      .eq('id', rs.id);
  } catch {
    /* best-effort */
  }
}

async function persistStep(ctx: AgentRunContext, rs: RunState, s: StepRuntime): Promise<void> {
  if (!rs.persisted) return;
  try {
    await ctx.supabase
      .from('agent_run_steps')
      .update({
        status: s.status,
        disposition: s.disposition,
        input: s.input,
        output: s.output,
        ai_decision_id: s.aiDecisionId,
        summary: s.summary,
        acted_by_user: s.actedByUser,
        started_at: s.startedAt,
        ended_at: s.endedAt,
      })
      .eq('org_id', ctx.orgId)
      .eq('run_id', rs.id)
      .eq('step_index', s.index);
  } catch {
    /* best-effort */
  }
}

// ── Audit: every step transition → ai_decisions + action_log (best-effort) ────

async function recordStepAudit(
  ctx: AgentRunContext,
  rs: RunState,
  s: StepRuntime,
  actor: 'AI' | 'HUMAN',
): Promise<void> {
  // ai_decisions — the agent's own immutable Decision Log row for this step.
  // Never overwrite a decision id the step already produced (e.g. the categorizer's).
  try {
    const status =
      s.status === 'DONE'
        ? actor === 'HUMAN'
          ? 'APPROVED'
          : 'APPROVED'
        : s.status === 'WAITING'
          ? 'PROPOSED'
          : s.status === 'REJECTED'
            ? 'REJECTED'
            : 'PROPOSED';
    const { data } = await ctx.supabase
      .from('ai_decisions')
      .insert({
        org_id: ctx.orgId,
        location_id: ctx.locationId,
        feature: AGENT_FEATURE,
        input_summary: `${rs.recipe.label} · ${s.label}`.slice(0, 2000),
        proposed_output: {
          run_id: rs.id,
          recipe: rs.recipe.key,
          step: s.name,
          step_index: s.index,
          kind: s.kind,
          disposition: s.disposition,
          status: s.status,
          output: s.output,
        },
        reasoning: s.summary,
        status,
        disposition_by_user: actor === 'HUMAN' ? s.actedByUser : null,
        disposition_at: s.status === 'DONE' || s.status === 'REJECTED' ? nowIso() : null,
        created_by_user: rs.createdByUser,
      })
      .select('id')
      .single();
    if (!s.aiDecisionId && data) s.aiDecisionId = (data as { id: string }).id;
  } catch {
    /* best-effort — audit must never break the run */
  }

  // core.action_log — the trust trail (AI badge / human badge).
  await logAction(ctx.supabase, {
    orgId: ctx.orgId,
    locationId: ctx.locationId,
    actorType: actor,
    action: `agent.step.${s.status.toLowerCase()}`,
    subjectTable: 'agent_runs',
    subjectId: rs.id,
    summary: `${rs.recipe.label} · ${s.label}: ${s.summary ?? s.status}`.slice(0, 300),
  });
}

// ── Core drive loop ───────────────────────────────────────────────────────────

function applyResult(rs: RunState, s: StepRuntime, def: AgentStepDef, r: StepExecuteResult): void {
  s.summary = r.summary;
  if (r.output) s.output = r.output;
  if (r.disposition !== undefined) s.disposition = r.disposition ?? null;
  if (r.aiDecisionId !== undefined && r.aiDecisionId) s.aiDecisionId = r.aiDecisionId;
  if (r.statePatch) rs.context = { ...rs.context, ...r.statePatch };
  if (r.subject) {
    rs.subjectTable = r.subject.table;
    rs.subjectId = r.subject.id;
  }
  if (r.status === 'WAITING') {
    s.status = 'WAITING';
    s.gatePrompt = r.gatePrompt ?? `${def.label} needs your approval to continue.`;
  } else if (r.status === 'DONE') {
    s.status = 'DONE';
    s.endedAt = nowIso();
    s.gatePrompt = null;
  } else if (r.status === 'REJECTED') {
    s.status = 'REJECTED';
    s.endedAt = nowIso();
  } else {
    s.status = 'FAILED';
    s.endedAt = nowIso();
  }
}

/**
 * Advance the run from its current position. When `human` is supplied it is applied
 * to the currently-WAITING step (its onAdvance / the default gate handler); after that
 * the loop auto-runs any subsequent non-gate steps until the next pause or completion.
 */
async function drive(ctx: AgentRunContext, rs: RunState, human?: HumanAdvance): Promise<void> {
  if (rs.status !== 'RUNNING' && rs.status !== 'PAUSED') return;
  rs.status = 'RUNNING';
  let action: HumanAdvance | undefined = human;

  while (rs.currentStepIndex < rs.steps.length) {
    const s = rs.steps[rs.currentStepIndex];
    const def = rs.recipe.steps[rs.currentStepIndex];

    if (s.status === 'DONE' || s.status === 'SKIPPED') {
      rs.currentStepIndex += 1;
      continue;
    }

    let result: StepExecuteResult;
    let actorType: 'AI' | 'HUMAN' = 'AI';

    if (s.status === 'WAITING') {
      // A paused gate can only advance with an explicit human action.
      if (!action) break;
      actorType = 'HUMAN';
      s.actedByUser = action.actorUserId;
      try {
        if (action.decision === 'REJECT') {
          result = { status: 'REJECTED', summary: action.note ? `Declined: ${action.note}` : 'Declined by the reviewer.' };
        } else if (def.onAdvance) {
          result = await def.onAdvance(ctx, rs.context, action);
        } else {
          // Default: a human explicitly approved the gate — proceed.
          result = { status: 'DONE', summary: action.note ? `Approved: ${action.note}` : 'Approved by the reviewer.' };
        }
      } catch (e) {
        result = { status: 'FAILED', summary: e instanceof Error ? e.message : 'Step failed while advancing.' };
      }
      action = undefined; // the human action is consumed by this one step
    } else {
      // First entry into this step — run its work.
      s.status = 'RUNNING';
      s.startedAt = nowIso();
      try {
        result = await def.execute(ctx, rs.context);
      } catch (e) {
        result = { status: 'FAILED', summary: e instanceof Error ? e.message : 'Step failed.' };
      }
    }

    applyResult(rs, s, def, result);
    rs.updatedAt = nowIso();
    await recordStepAudit(ctx, rs, s, actorType);
    await persistStep(ctx, rs, s);

    if (s.status === 'DONE') {
      rs.currentStepIndex += 1;
      continue;
    }
    if (s.status === 'WAITING') {
      rs.status = 'PAUSED';
      rs.pausedReason = s.gatePrompt;
      await persistRun(ctx, rs);
      return;
    }
    // FAILED or REJECTED — stop the run.
    rs.status = 'FAILED';
    rs.error = s.summary;
    await persistRun(ctx, rs);
    return;
  }

  // Fell off the end — all steps DONE/SKIPPED.
  rs.status = 'COMPLETED';
  rs.pausedReason = null;
  rs.updatedAt = nowIso();
  await persistRun(ctx, rs);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start a new run of `recipe` with `input`. Seeds state via the recipe's init(),
 * persists (or falls back to ephemeral), then drives to the first pause / completion.
 * Returns `{ error }` (a 4xx-worthy message) when init rejects the input.
 */
export async function startRun(
  ctx: AgentRunContext,
  recipe: AgentRecipe,
  input: Record<string, unknown>,
): Promise<{ run: AgentRunView } | { error: string }> {
  const seeded = await recipe.init(ctx, input);
  if ('error' in seeded) return { error: seeded.error };

  const createdAt = nowIso();
  const rs: RunState = {
    id: randomUUID(),
    recipe,
    feature: recipe.feature ?? null,
    title: seeded.title,
    status: 'RUNNING',
    currentStepIndex: 0,
    subjectTable: seeded.subject?.table ?? null,
    subjectId: seeded.subject?.id ?? null,
    context: seeded.state,
    pausedReason: null,
    error: null,
    createdByUser: ctx.userId,
    createdAt,
    updatedAt: createdAt,
    steps: recipe.steps.map((def, i) => ({
      index: i,
      name: def.name,
      label: def.label,
      kind: def.kind,
      status: 'PENDING' as AgentStepStatus,
      disposition: null,
      summary: null,
      input: {},
      output: {},
      aiDecisionId: null,
      gatePrompt: null,
      actedByUser: null,
      startedAt: null,
      endedAt: null,
    })),
    persisted: false,
  };

  rs.persisted = await persistInsert(ctx, rs);
  await drive(ctx, rs);
  return { run: toRunView(rs) };
}

// ── Loading persisted runs ────────────────────────────────────────────────────

interface RunRow {
  id: string;
  recipe: string;
  feature: string | null;
  title: string;
  status: AgentRunStatus;
  current_step_index: number;
  subject_table: string | null;
  subject_id: string | null;
  context: AgentState | null;
  paused_reason: string | null;
  error: string | null;
  created_by_user: string | null;
  created_at: string;
  updated_at: string;
}
interface StepRow {
  step_index: number;
  name: string;
  label: string;
  kind: AgentStepKind;
  status: AgentStepStatus;
  disposition: string | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  ai_decision_id: string | null;
  summary: string | null;
  acted_by_user: string | null;
  started_at: string | null;
  ended_at: string | null;
}

function rowToStepRuntime(r: StepRow): StepRuntime {
  return {
    index: r.step_index,
    name: r.name,
    label: r.label,
    kind: r.kind,
    status: r.status,
    disposition: r.disposition,
    summary: r.summary,
    input: r.input ?? {},
    output: r.output ?? {},
    aiDecisionId: r.ai_decision_id,
    gatePrompt: r.status === 'WAITING' ? (r.summary ?? null) : null,
    actedByUser: r.acted_by_user,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

async function loadRunState(ctx: AgentRunContext, runId: string): Promise<RunState | null> {
  let runRow: RunRow | null = null;
  let stepRows: StepRow[] = [];
  try {
    const { data: run } = await ctx.supabase
      .from('agent_runs')
      .select('*')
      .eq('org_id', ctx.orgId)
      .eq('id', runId)
      .maybeSingle();
    runRow = (run as RunRow | null) ?? null;
    if (!runRow) return null;
    const { data: steps } = await ctx.supabase
      .from('agent_run_steps')
      .select('*')
      .eq('org_id', ctx.orgId)
      .eq('run_id', runId)
      .order('step_index', { ascending: true });
    stepRows = (steps as StepRow[] | null) ?? [];
  } catch {
    return null; // tables absent ⇒ nothing to load (degrade-safe)
  }

  const recipe = getRecipe(runRow.recipe);
  if (!recipe) return null; // unknown recipe ⇒ cannot drive it

  return {
    id: runRow.id,
    recipe,
    feature: runRow.feature,
    title: runRow.title,
    status: runRow.status,
    currentStepIndex: runRow.current_step_index,
    subjectTable: runRow.subject_table,
    subjectId: runRow.subject_id,
    context: runRow.context ?? {},
    pausedReason: runRow.paused_reason,
    error: runRow.error,
    createdByUser: runRow.created_by_user,
    createdAt: runRow.created_at,
    updatedAt: runRow.updated_at,
    steps: stepRows.map(rowToStepRuntime),
    persisted: true,
  };
}

/** Read one run (view only). Returns null when absent or the tables don't exist. */
export async function getRun(ctx: AgentRunContext, runId: string): Promise<AgentRunView | null> {
  const rs = await loadRunState(ctx, runId);
  return rs ? toRunView(rs) : null;
}

/**
 * Advance a WAITING run with a human decision at its current gate. Returns null when
 * the run can't be found (absent / ephemeral / pre-migration). Throws a plain Error
 * with a friendly message when the run isn't in a state that can be advanced.
 */
export async function advanceRun(
  ctx: AgentRunContext,
  runId: string,
  action: HumanAdvance,
): Promise<AgentRunView | null> {
  const rs = await loadRunState(ctx, runId);
  if (!rs) return null;
  if (rs.status !== 'PAUSED') {
    throw new Error(`This run is ${rs.status.toLowerCase()} and cannot be advanced.`);
  }
  const cur = rs.steps[rs.currentStepIndex];
  if (!cur || cur.status !== 'WAITING') {
    throw new Error('This run has no step waiting for a decision.');
  }
  await drive(ctx, rs, action);
  return toRunView(rs);
}

export interface ListRunsOptions {
  status?: AgentRunStatus;
  recipe?: string;
  limit?: number;
}

/** List recent runs (newest first). Degrade-safe: returns [] if the tables are absent. */
export async function listRuns(
  ctx: AgentRunContext,
  opts: ListRunsOptions = {},
): Promise<AgentRunView[]> {
  try {
    let q = ctx.supabase.from('agent_runs').select('*').eq('org_id', ctx.orgId);
    if (opts.status) q = q.eq('status', opts.status);
    if (opts.recipe) q = q.eq('recipe', opts.recipe);
    const { data: runs, error } = await q
      .order('created_at', { ascending: false })
      .limit(Math.min(opts.limit ?? 100, 200));
    if (error || !runs) return [];
    const runRows = runs as RunRow[];
    if (runRows.length === 0) return [];

    const ids = runRows.map((r) => r.id);
    const { data: steps } = await ctx.supabase
      .from('agent_run_steps')
      .select('*')
      .eq('org_id', ctx.orgId)
      .in('run_id', ids)
      .order('step_index', { ascending: true });
    const stepsByRun = new Map<string, StepRow[]>();
    for (const s of (steps as (StepRow & { run_id: string })[] | null) ?? []) {
      const arr = stepsByRun.get(s.run_id) ?? [];
      arr.push(s);
      stepsByRun.set(s.run_id, arr);
    }

    return runRows.map((r) => {
      const recipe = getRecipe(r.recipe);
      const stepViews: AgentStepView[] = (stepsByRun.get(r.id) ?? [])
        .map(rowToStepRuntime)
        .map(toStepView);
      return {
        id: r.id,
        recipe: r.recipe,
        recipeLabel: recipe?.label ?? r.recipe,
        feature: r.feature,
        title: r.title,
        status: r.status,
        currentStepIndex: r.current_step_index,
        subjectTable: r.subject_table,
        subjectId: r.subject_id,
        context: r.context ?? {},
        pausedReason: r.paused_reason,
        error: r.error,
        createdByUser: r.created_by_user,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        steps: stepViews,
        persisted: true,
      };
    });
  } catch {
    return [];
  }
}
