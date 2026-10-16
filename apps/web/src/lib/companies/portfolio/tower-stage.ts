/**
 * Control Tower stage logic — pure (no I/O). See tower.ts for the stage definitions.
 */

import type { NextAction, OnboardingStatus, TowerRow, TowerSession, TowerStage } from './types';
import { TOWER_STAGES } from './types';

export function deriveStage(session: TowerSession | null, openingPosted: boolean): TowerStage {
  if (openingPosted || session?.posted) return 'live';
  if (!session) return 'created';
  if (session.tiedOut) return 'checked';
  if (session.unmappedCount === 0 && session.unknownTargetCount === 0) return 'matched';
  return 'uploaded';
}

export function stageIndex(stage: TowerStage): number {
  return TOWER_STAGES.indexOf(stage);
}

/** The per-company onboarding_status the stage implies. */
export function statusForStage(stage: TowerStage): OnboardingStatus {
  if (stage === 'live') return 'complete';
  if (stage === 'created') return 'not_started';
  return 'in_progress';
}

const STATUS_RANK: Record<OnboardingStatus, number> = { not_started: 0, in_progress: 1, complete: 2 };

/**
 * Forward-only reconciliation of the stored status with the derived one: returns
 * the status to WRITE, or null to leave it. Never moves a company backwards (a
 * manual "complete" or an owner-assigned "in_progress" is respected).
 */
export function statusToSync(stored: OnboardingStatus, derived: OnboardingStatus): OnboardingStatus | null {
  return STATUS_RANK[derived] > STATUS_RANK[stored] ? derived : null;
}

export function coerceStatus(v: unknown): OnboardingStatus {
  return v === 'in_progress' || v === 'complete' ? v : 'not_started';
}

export function nextActionFor(row: Pick<TowerRow, 'stage' | 'session' | 'periodsMissing' | 'openingEntryId'>): NextAction {
  if (row.periodsMissing) {
    return { kind: 'repair_periods', label: 'Add missing fiscal periods', href: null };
  }
  const s = row.session;
  const sessionHref = s ? `/onboarding/conversion?sessionId=${encodeURIComponent(s.id)}` : null;
  switch (row.stage) {
    case 'created':
      return { kind: 'upload', label: 'Drop its trial balance', href: null };
    case 'uploaded':
      return { kind: 'link', label: 'Match remaining accounts', href: sessionHref };
    case 'matched':
      return { kind: 'link', label: s && !s.balanced ? 'Fix the out-of-balance TB' : 'Tie out the balances', href: sessionHref };
    case 'checked':
      return { kind: 'link', label: 'Approve opening books', href: sessionHref };
    case 'live':
    default:
      return {
        kind: 'link',
        label: 'View opening entry',
        href: row.openingEntryId ? `/journal-entries?entry=${encodeURIComponent(row.openingEntryId)}` : null,
      };
  }
}

/** Pick the session that represents a company: a posted one wins, else the newest live one. */
export function pickSession(sessions: TowerSession[]): TowerSession | null {
  if (sessions.length === 0) return null;
  const posted = sessions.find((s) => s.posted);
  if (posted) return posted;
  const open = sessions.filter((s) => s.status !== 'REJECTED' && s.status !== 'EXPIRED');
  const pool = open.length > 0 ? open : sessions;
  return [...pool].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

