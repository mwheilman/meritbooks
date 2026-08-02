/**
 * Dunning cadence — the ladder of overdue reminder stages with tone escalation.
 *
 * This is the deterministic policy layer for AR collections. It is PURE (no I/O,
 * no Date.now — callers pass `asOf`) so the stage a customer lands on, and
 * whether a reminder is *due*, are reproducible and unit-testable. The AI never
 * decides the stage; it only phrases the letter for the stage the ladder picks
 * (see dunning-copy.ts). Canon §3: the machine decides the accounting/policy, the
 * model narrates, a human approves the send.
 *
 * Stages escalate by days past due. Tone hardens as the debt ages: a 7-day nudge
 * is a courtesy; a 90-day notice warns of escalation. Nothing here sends anything
 * — the send is always an explicit, human-approved action.
 */

export type DunningStageKey = 'FIRST_NOTICE' | 'SECOND_NOTICE' | 'THIRD_NOTICE' | 'FINAL_NOTICE';
export type DunningTone = 'friendly' | 'firm' | 'urgent' | 'final';

export interface DunningStage {
  key: DunningStageKey;
  /** Escalation order (1 = earliest). Higher = more severe. */
  order: number;
  /** Minimum whole days past the due date for this stage to apply. */
  minDaysOverdue: number;
  tone: DunningTone;
  label: string;
  /** One-line intent shown in the worklist / used to steer the AI draft. */
  intent: string;
}

/**
 * The ladder. Ordered earliest → most severe. 7 / 30 / 60 / 90 days overdue.
 * Editable in one place — the whole workflow (recommended action, draft, send)
 * reads these thresholds, never a hard-coded number elsewhere.
 */
export const DUNNING_LADDER: readonly DunningStage[] = [
  {
    key: 'FIRST_NOTICE',
    order: 1,
    minDaysOverdue: 7,
    tone: 'friendly',
    label: 'First notice',
    intent: 'A friendly reminder that the invoice is now past due; assume an oversight.',
  },
  {
    key: 'SECOND_NOTICE',
    order: 2,
    minDaysOverdue: 30,
    tone: 'firm',
    label: 'Second notice',
    intent: 'A firm follow-up: the balance is a month overdue and needs prompt attention.',
  },
  {
    key: 'THIRD_NOTICE',
    order: 3,
    minDaysOverdue: 60,
    tone: 'urgent',
    label: 'Third notice',
    intent: 'An urgent request: the account is seriously delinquent and needs immediate payment.',
  },
  {
    key: 'FINAL_NOTICE',
    order: 4,
    minDaysOverdue: 90,
    tone: 'final',
    label: 'Final notice',
    intent: 'A final demand before the account is escalated (collections / service hold).',
  },
] as const;

const BY_KEY: Record<DunningStageKey, DunningStage> = DUNNING_LADDER.reduce(
  (acc, s) => {
    acc[s.key] = s;
    return acc;
  },
  {} as Record<DunningStageKey, DunningStage>,
);

export function getDunningStage(key: DunningStageKey): DunningStage {
  return BY_KEY[key];
}

/** The order index of a stage key (0 when null/unknown), for comparisons. */
export function stageOrder(key: DunningStageKey | null): number {
  return key ? BY_KEY[key]?.order ?? 0 : 0;
}

/**
 * The highest cadence stage an invoice QUALIFIES for at `daysOverdue`, or null
 * when it is within terms or inside the grace window (< first threshold).
 */
export function cadenceStageForDays(daysOverdue: number): DunningStage | null {
  let match: DunningStage | null = null;
  for (const stage of DUNNING_LADDER) {
    if (daysOverdue >= stage.minDaysOverdue) match = stage;
  }
  return match;
}

/** Whole days from `from` (YYYY-MM-DD/ISO) to `to`. 0 on unparseable input. */
function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso.length <= 10 ? `${fromIso}T00:00:00Z` : fromIso);
  const b = Date.parse(toIso.length <= 10 ? `${toIso}T00:00:00Z` : toIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.floor((b - a) / 86_400_000);
}

export interface ReminderDecisionInput {
  daysOverdue: number;
  /** The most severe stage already sent for this invoice, or null if none. */
  lastStageSent: DunningStageKey | null;
  /** ISO timestamp of the last reminder actually sent, or null. */
  lastReminderAt: string | null;
  asOf: string; // YYYY-MM-DD or ISO
  /** Minimum quiet gap (days) before re-nudging the SAME stage. Default 7. */
  minGapDays?: number;
}

export interface ReminderDecision {
  /** Whether a reminder should be offered now. */
  isDue: boolean;
  /** The stage to send if due (null when not overdue enough for any stage). */
  stage: DunningStage | null;
  /** True when the recommended stage is an escalation past what was last sent. */
  isEscalation: boolean;
  reason: string;
}

/**
 * Decide whether a reminder is due, and at which stage. A reminder is due when:
 *   • the invoice qualifies for a stage AND
 *   • either that stage is an escalation beyond the last stage sent, OR
 *   • the same stage was last sent but the quiet gap has elapsed (re-nudge).
 *
 * Pure. This is what the worklist calls to badge "reminder due" and what the
 * draft endpoint defaults its stage to.
 */
export function decideReminder(input: ReminderDecisionInput): ReminderDecision {
  const minGap = input.minGapDays ?? 7;
  const stage = cadenceStageForDays(input.daysOverdue);

  if (!stage) {
    return { isDue: false, stage: null, isEscalation: false, reason: 'Within terms or grace window.' };
  }

  const lastOrder = stageOrder(input.lastStageSent);
  const isEscalation = stage.order > lastOrder;

  if (isEscalation) {
    return { isDue: true, stage, isEscalation: true, reason: `Escalate to ${stage.label} (${input.daysOverdue}d overdue).` };
  }

  // Same or lower stage already sent → only re-nudge after the quiet gap.
  const gap = input.lastReminderAt ? daysBetween(input.lastReminderAt, input.asOf) : Number.POSITIVE_INFINITY;
  if (gap >= minGap) {
    return {
      isDue: true,
      stage,
      isEscalation: false,
      reason: `Re-send ${stage.label}; ${Number.isFinite(gap) ? `${gap}d` : 'no prior'} since last reminder.`,
    };
  }

  return {
    isDue: false,
    stage,
    isEscalation: false,
    reason: `${stage.label} sent recently (${gap}d ago); hold until the ${minGap}d gap elapses.`,
  };
}

/** Add `n` whole days to an ISO/YYYY-MM-DD date, returning YYYY-MM-DD. */
function addDays(iso: string, n: number): string {
  const base = Date.parse(iso.length <= 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(base)) return iso.slice(0, 10);
  return new Date(base + n * 86_400_000).toISOString().slice(0, 10);
}

export interface NextCadenceStep {
  stage: DunningStage;
  /** YYYY-MM-DD the step becomes due (today when already due). */
  scheduledDate: string;
  /** Whole days from `asOf` to `scheduledDate` (<= 0 = due now/overdue). */
  daysUntil: number;
  isDueNow: boolean;
  kind: 'first-contact' | 'escalation' | 're-nudge';
  reason: string;
}

/**
 * The NEXT scheduled cadence step for an invoice — what a collector should expect
 * to do next, and when. Pure. If a reminder is already due it reports that (using
 * the same authority as `decideReminder`); otherwise it projects the earlier of:
 *   • the next escalation (one ladder rung above what's been sent), triggered when
 *     the invoice ages to that rung's threshold (dueDate + minDaysOverdue), or
 *   • a re-nudge of the last stage sent once the quiet gap elapses.
 * Returns null only when the due date is unparseable.
 */
export function nextCadenceStep(input: ReminderDecisionInput & { dueDate: string }): NextCadenceStep | null {
  const dueMs = Date.parse(input.dueDate.length <= 10 ? `${input.dueDate}T00:00:00Z` : input.dueDate);
  if (Number.isNaN(dueMs)) return null;
  const minGap = input.minGapDays ?? 7;
  const asOfDay = input.asOf.slice(0, 10);

  // Already due → report the stage the cadence authority picks, dated now.
  const decision = decideReminder(input);
  if (decision.isDue && decision.stage) {
    const lastOrder = stageOrder(input.lastStageSent);
    const kind: NextCadenceStep['kind'] = decision.isEscalation
      ? (lastOrder === 0 ? 'first-contact' : 'escalation')
      : 're-nudge';
    return { stage: decision.stage, scheduledDate: asOfDay, daysUntil: 0, isDueNow: true, kind, reason: decision.reason };
  }

  // Not due → the earliest FUTURE trigger among escalation / re-nudge.
  const lastOrder = stageOrder(input.lastStageSent);
  const candidates: Array<{ stage: DunningStage; date: string; kind: NextCadenceStep['kind'] }> = [];
  const escalation = DUNNING_LADDER.find((s) => s.order === lastOrder + 1) ?? null;
  if (escalation) {
    candidates.push({
      stage: escalation,
      date: addDays(input.dueDate, escalation.minDaysOverdue),
      kind: lastOrder === 0 ? 'first-contact' : 'escalation',
    });
  }
  if (input.lastStageSent && input.lastReminderAt) {
    candidates.push({
      stage: getDunningStage(input.lastStageSent),
      date: addDays(input.lastReminderAt.slice(0, 10), minGap),
      kind: 're-nudge',
    });
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.stage.order - a.stage.order));
  const next = candidates[0];
  const daysUntil = Math.floor(
    (Date.parse(`${next.date}T00:00:00Z`) - Date.parse(`${asOfDay}T00:00:00Z`)) / 86_400_000,
  );
  const isDueNow = daysUntil <= 0;
  const reason =
    next.kind === 're-nudge'
      ? `Re-send ${next.stage.label} on ${next.date} (in ${daysUntil}d).`
      : `${next.kind === 'first-contact' ? 'First contact' : 'Escalate to'} ${next.stage.label} on ${next.date} (in ${daysUntil}d).`;
  return { stage: next.stage, scheduledDate: next.date, daysUntil, isDueNow, kind: next.kind, reason };
}
