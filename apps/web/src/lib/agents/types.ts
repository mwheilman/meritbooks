/**
 * SUPERVISED AGENT ORCHESTRATION (M9) — shared types.
 *
 * The "autonomous workforce" payoff, built the SAFE way. An agent RUN is a typed,
 * ordered chain of already-built steps. The runner walks the chain, honoring the
 * tenant's M10 autonomy dial + kill switch PER STEP, and STOPS at human gates. It
 * never posts money or hits the GL itself — any money/GL effect flows through the
 * existing deterministic engines + approval gates (canon §3: AI proposes facts; a
 * human approves anything that moves money or hits the GL).
 *
 * A step's `kind` decides how the runner treats it:
 *   AUTO        — mechanical, reversible data-entry (e.g. loading an already-intaken
 *                 draft). Runs without a dial; never moves money.
 *   PROPOSE     — AI proposes a FACT. The step writes an ai_decisions row and asks the
 *                 M10 disposition helper whether the tenant's dial permits auto-apply.
 *                 AUTO disposition ⇒ the step applies its (non-GL) data-entry change and
 *                 advances; anything else ⇒ it WAITS for a human (kill switch ⇒ WAIT too).
 *   HUMAN_GATE  — ALWAYS pauses. The human acts through the EXISTING gated surface
 *                 (e.g. the approval workflow / bill-approve route, which enforce SoD and
 *                 do the posting). The runner only OBSERVES that the gate cleared; it
 *                 never approves or posts on the human's behalf.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Disposition } from '@/lib/autonomy/disposition';

export type AgentStepKind = 'AUTO' | 'PROPOSE' | 'HUMAN_GATE';

export type AgentStepStatus =
  | 'PENDING' // not yet reached
  | 'RUNNING' // executing now
  | 'WAITING' // paused at this step, awaiting a human
  | 'DONE' // completed successfully
  | 'REJECTED' // a human declined the proposal/gate
  | 'FAILED' // the step errored
  | 'SKIPPED'; // not applicable for this run

export type AgentRunStatus = 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

/** Accumulated, JSON-serializable run state threaded through the steps. */
export type AgentState = Record<string, unknown>;

/** Everything a step needs to do its work, org-scoped. */
export interface AgentRunContext {
  /** RLS-scoped client (runs AS the user) — the DB enforces tenant isolation. */
  supabase: SupabaseClient;
  orgId: string;
  /** Clerk user id of the actor (the human who started / advanced the run); null for system. */
  userId: string | null;
  locationId: string | null;
}

/** The outcome of running (or advancing) a single step. */
export interface StepExecuteResult {
  status: 'DONE' | 'WAITING' | 'FAILED' | 'REJECTED';
  summary: string;
  /** Persisted onto the step row for the UI. */
  output?: Record<string, unknown>;
  /** Merged into the run's shared context for downstream steps. */
  statePatch?: AgentState;
  /** The ai_decisions row this step produced, if any. */
  aiDecisionId?: string | null;
  /** The M10 disposition this step resolved to, if it consulted the dial. */
  disposition?: Disposition | null;
  /** When WAITING: the human-readable prompt describing what a human must do. */
  gatePrompt?: string | null;
  /** Subject linkage recorded on the run (e.g. { table: 'bills', id }). */
  subject?: { table: string; id: string } | null;
}

/** A human's explicit action at a WAITING gate. */
export interface HumanAdvance {
  decision: 'APPROVE' | 'REJECT';
  note?: string | null;
  actorUserId: string | null;
}

/** One step in a recipe. */
export interface AgentStepDef {
  /** Machine key, unique within the recipe. */
  name: string;
  /** Human label for the timeline. */
  label: string;
  kind: AgentStepKind;
  /**
   * The M10 autonomy feature key governing this step (e.g. 'CATEGORIZATION'). Only
   * meaningful for PROPOSE steps that consult the dial; AUTO/HUMAN_GATE ignore it.
   */
  feature?: string;
  /** Do the step's work on first entry (the AUTO path). */
  execute(ctx: AgentRunContext, state: AgentState): Promise<StepExecuteResult>;
  /**
   * Satisfy a WAITING gate from an explicit human action. If omitted, the engine's
   * default handles it: APPROVE re-runs `execute` treating the dial as satisfied by
   * the human; REJECT stops the run.
   */
  onAdvance?(
    ctx: AgentRunContext,
    state: AgentState,
    action: HumanAdvance,
  ): Promise<StepExecuteResult>;
}

/** A named, ordered chain of steps + how to seed a run from start input. */
export interface AgentRecipe {
  key: string;
  label: string;
  description: string;
  /** Governing autonomy feature for the run overall (surfaced in the UI). */
  feature?: string;
  steps: AgentStepDef[];
  /**
   * Validate the start input and build the initial run state / title / subject.
   * Returns `{ error }` to reject the start with a 4xx.
   */
  init(
    ctx: AgentRunContext,
    input: Record<string, unknown>,
  ): Promise<
    | { title: string; state: AgentState; subject?: { table: string; id: string } | null }
    | { error: string }
  >;
}

// ── View models (returned to the API / UI) ───────────────────────────────────

export interface AgentStepView {
  index: number;
  name: string;
  label: string;
  kind: AgentStepKind;
  status: AgentStepStatus;
  disposition: string | null;
  summary: string | null;
  output: Record<string, unknown>;
  aiDecisionId: string | null;
  gatePrompt: string | null;
  actedByUser: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface AgentRunView {
  id: string;
  recipe: string;
  recipeLabel: string;
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
  steps: AgentStepView[];
  /** false ⇒ the persistence tables are absent; this run was ephemeral (single request). */
  persisted: boolean;
}
