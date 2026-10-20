/** Stage → pip + status kind (status is never colour alone: pip shape + the stage word). */
import type { PipKind, StatusKind } from '@meritbooks/merit-ui';
import type { CoreStatus, TaskStatus, ChangeOrderStage } from './types';

export function stageStatus(core: CoreStatus): { kind: StatusKind; pip: PipKind } {
  switch (core) {
    case 'BID': return { kind: 'track', pip: 'open' };
    case 'ACTIVE': return { kind: 'track', pip: 'track' };
    case 'ON_HOLD': return { kind: 'risk', pip: 'soft' };
    case 'COMPLETE': return { kind: 'ready', pip: 'ready' };
    case 'CLOSED':
    case 'CANCELLED': return { kind: 'track', pip: 'closed' };
  }
}

export function taskStatus(status: TaskStatus, overdue: boolean): { kind: StatusKind; pip: PipKind; word: string } {
  if (status === 'DONE') return { kind: 'ready', pip: 'ready', word: 'Done' };
  if (status === 'CANCELLED') return { kind: 'track', pip: 'closed', word: 'Cancelled' };
  if (status === 'BLOCKED') return { kind: 'blocked', pip: 'blocked', word: 'Blocked' };
  if (overdue) return { kind: 'overdue', pip: 'overdue', word: 'Overdue' };
  if (status === 'IN_PROGRESS') return { kind: 'track', pip: 'open', word: 'In progress' };
  return { kind: 'track', pip: 'track', word: 'To do' };
}

export const CO_STAGE_WORDS: Readonly<Record<ChangeOrderStage, string>> = {
  PCO: 'Potential',
  COR: 'Requested',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  VOID: 'Void',
};

export function coStatus(stage: ChangeOrderStage): { kind: StatusKind; pip: PipKind } {
  switch (stage) {
    case 'PCO': return { kind: 'track', pip: 'open' };
    case 'COR': return { kind: 'risk', pip: 'risk' };
    case 'APPROVED': return { kind: 'ready', pip: 'ready' };
    case 'REJECTED': return { kind: 'blocked', pip: 'blocked' };
    case 'VOID': return { kind: 'track', pip: 'closed' };
  }
}

export const CORE_STATUS_WORDS: Readonly<Record<CoreStatus, string>> = {
  BID: 'Bid', ACTIVE: 'Active', ON_HOLD: 'On hold', COMPLETE: 'Complete', CLOSED: 'Closed', CANCELLED: 'Cancelled',
};
