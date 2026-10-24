/**
 * Lead stage logic (panel 06 §2.3 BP-45/46/51, §2d). Pure and client-safe: the board decides
 * what a drop means before it calls crm.move_lead, and the database applies its own guards.
 *
 *   - stage kinds are fixed (open / won / lost) so reports work across companies
 *   - Lost needs a reason (BP-51); reopening a won or lost lead needs a reason
 *   - Won needs someone to have won it from: a linked customer or contact
 *   - a lead that became a job stays won
 */
import type { ActivityRow, FollowupRow, LeadRow, Pipeline, StageKind, StageRow } from './types';

export const REASON_MIN = 3;

export type MoveReasonKind = 'lost' | 'reopen';

export type MoveCheck =
  | { ok: true; reason: MoveReasonKind | null }
  | { ok: false; message: string };

type LeadForMove = Pick<LeadRow, 'pipeline_id' | 'stage_id' | 'customer_id' | 'contact_id' | 'converted_job_id' | 'converted_estimate_id'>;

/** What moving `lead` from `from` to `to` needs (or why it can't). */
export function checkMove(lead: LeadForMove, from: StageRow | null, to: StageRow): MoveCheck {
  if (from && from.id === to.id) return { ok: false, message: `It is already in ${to.name}.` };
  if (to.pipeline_id !== lead.pipeline_id) return { ok: false, message: 'That stage belongs to another pipeline.' };
  // crm.move_lead refuses a converted lead: its work lives on the job now (and it is already won)
  if (lead.converted_job_id || lead.converted_estimate_id) return { ok: false, message: 'This lead became a job, so it stays won. Its work lives on the job now.' };
  if (to.kind === 'won' && !lead.customer_id && !lead.contact_id) {
    return { ok: false, message: 'Link a customer or contact before marking it won.' };
  }
  if (to.kind === 'lost') return { ok: true, reason: 'lost' };
  if (from && from.kind !== 'open' && to.kind === 'open') return { ok: true, reason: 'reopen' };
  return { ok: true, reason: null };
}

/** The reason the move needs, checked. Null = fine. */
export function reasonProblem(kind: MoveReasonKind | null, reason: string | null | undefined): string | null {
  if (!kind) return null;
  if ((reason?.trim().length ?? 0) >= REASON_MIN) return null;
  return kind === 'lost' ? 'Say why it was lost (price, competitor, timing…).' : 'Say why it is open again.';
}

export function reasonPrompt(kind: MoveReasonKind): { title: string; label: string; verb: string } {
  return kind === 'lost'
    ? { title: 'Mark the lead lost', label: 'Why was it lost?', verb: 'Mark lost' }
    : { title: 'Reopen the lead', label: 'Why is it open again?', verb: 'Reopen' };
}

// ------------------------------------------------------------------ board

export function stageById(p: Pipeline | null, id: string | null | undefined): StageRow | null {
  return p?.stages.find((s) => s.id === id) ?? null;
}

const KIND_ORDER: Readonly<Record<StageKind, number>> = { open: 0, won: 1, lost: 2 };

/** Stages in board order: open stages by sort, then won, then lost. */
export function boardStages(stages: ReadonlyArray<StageRow>): StageRow[] {
  return [...stages].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.sort - b.sort || a.name.localeCompare(b.name));
}

/** Probability as 0–1: the stage's, or 1 for won and 0 for lost. */
export function stageProbability(s: Pick<StageRow, 'kind' | 'probability_pct'>): number {
  if (s.kind === 'won') return 1;
  if (s.kind === 'lost') return 0;
  const p = Number(s.probability_pct ?? 0);
  return Number.isFinite(p) ? Math.max(0, Math.min(p, 100)) / 100 : 0;
}

export function weightedCents(lead: Pick<LeadRow, 'estimated_value_cents'>, s: Pick<StageRow, 'kind' | 'probability_pct'>): number {
  return Math.round((lead.estimated_value_cents ?? 0) * stageProbability(s));
}

export interface BoardColumn<L> {
  stage: StageRow;
  leads: L[];
  valueCents: number;
  weightedCents: number;
}

export function boardColumns<L extends Pick<LeadRow, 'stage_id' | 'estimated_value_cents' | 'updated_at'>>(p: Pipeline, leads: ReadonlyArray<L>): BoardColumn<L>[] {
  return boardStages(p.stages).map((stage) => {
    const ls = leads.filter((l) => l.stage_id === stage.id).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return {
      stage,
      leads: ls,
      valueCents: ls.reduce((s, l) => s + (l.estimated_value_cents ?? 0), 0),
      weightedCents: ls.reduce((s, l) => s + weightedCents(l, stage), 0),
    };
  });
}

// ------------------------------------------------------------------ time

const MIN = 60_000;
const DAY = 86_400_000;

/** When the lead entered its current stage (the last event into it, else its creation). */
export function enteredStageAt(lead: Pick<LeadRow, 'stage_id' | 'created_at'>, events: ReadonlyArray<{ to_stage_id: string; created_at: string }>): string {
  const into = events.filter((e) => e.to_stage_id === lead.stage_id).map((e) => e.created_at).sort();
  return into[into.length - 1] ?? lead.created_at;
}

export function daysSince(iso: string, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - Date.parse(iso)) / DAY));
}

/** Weekdays strictly after `fromIso`'s day up to and including `toIso`'s day. */
export function businessDaysBetween(fromIso: string, toIso: string): number {
  const a = new Date(`${fromIso.slice(0, 10)}T12:00:00Z`);
  const b = new Date(`${toIso.slice(0, 10)}T12:00:00Z`);
  let n = 0;
  for (let d = new Date(a.getTime() + DAY); d <= b; d = new Date(d.getTime() + DAY)) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) n += 1;
  }
  return n;
}

// ------------------------------------------------------------------ speed to lead (BP-42)

const TOUCH: ReadonlySet<string> = new Set(['call', 'sms', 'email', 'meeting', 'site_visit', 'portal_message']);

/** The first time someone reached out: the earliest outbound (or undirected) contact activity. */
export function firstTouchAt(acts: ReadonlyArray<Pick<ActivityRow, 'kind' | 'direction' | 'occurred_at'>>): string | null {
  const t = acts.filter((a) => TOUCH.has(a.kind) && a.direction !== 'inbound').map((a) => a.occurred_at).sort();
  return t[0] ?? null;
}

export type SpeedTone = 'ready' | 'track' | 'risk' | 'overdue';

export interface Speed {
  state: 'answered' | 'waiting';
  minutes: number;
  tone: SpeedTone;
  text: string;
}

/** Targets: first touch within 5 minutes is on track, within an hour at risk, beyond that late. */
export const SPEED_TARGET_MIN = 5;
export const SPEED_LATE_MIN = 60;

export function durationWords(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.floor(h / 24)} days`;
}

/** Null for a lead that is no longer open and was never touched (nothing to time). */
export function speedToLead(createdAt: string, firstTouch: string | null, open: boolean, nowMs: number): Speed | null {
  const start = Date.parse(createdAt);
  if (firstTouch) {
    const minutes = Math.max(0, (Date.parse(firstTouch) - start) / MIN);
    return { state: 'answered', minutes, tone: minutes <= SPEED_TARGET_MIN ? 'ready' : minutes <= SPEED_LATE_MIN ? 'track' : 'risk', text: `First touch in ${durationWords(minutes)}` };
  }
  if (!open) return null;
  const minutes = Math.max(0, (nowMs - start) / MIN);
  return { state: 'waiting', minutes, tone: minutes <= SPEED_TARGET_MIN ? 'track' : minutes <= SPEED_LATE_MIN ? 'risk' : 'overdue', text: `Waiting ${durationWords(minutes)}` };
}

// ------------------------------------------------------------------ next step and follow-ups

/** A lead with no next step after 2 business days is flagged (panel 06 §2d). */
export function needsNextStep(
  lead: Pick<LeadRow, 'next_step' | 'next_step_on' | 'created_at'>,
  open: boolean,
  lastActivityAt: string | null,
  todayIso: string,
): boolean {
  if (!open) return false;
  if (lead.next_step && lead.next_step_on && lead.next_step_on >= todayIso) return false;
  const since = lastActivityAt && lastActivityAt > lead.created_at ? lastActivityAt : lead.created_at;
  return businessDaysBetween(since, todayIso) >= 2 || !!(lead.next_step_on && lead.next_step_on < todayIso);
}

export type FollowupState = 'done' | 'overdue' | 'due' | 'upcoming';

export function followupState(f: Pick<FollowupRow, 'due_on' | 'done_at'>, todayIso: string): FollowupState {
  if (f.done_at) return 'done';
  if (f.due_on < todayIso) return 'overdue';
  if (f.due_on === todayIso) return 'due';
  return 'upcoming';
}

/** Open follow-ups due today or earlier. */
export function dueFollowups<F extends Pick<FollowupRow, 'due_on' | 'done_at'>>(fs: ReadonlyArray<F>, todayIso: string): F[] {
  return fs.filter((f) => !f.done_at && f.due_on <= todayIso).sort((a, b) => a.due_on.localeCompare(b.due_on));
}
