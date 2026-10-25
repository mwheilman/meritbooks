/** Words for commercial statuses and kinds (pure, client-safe). */
import type { PipKind, StatusKind } from '@meritbooks/merit-ui';

export interface Mark {
  word: string;
  kind: StatusKind;
  pip: PipKind;
}

type Tone = 'pending' | 'review' | 'done' | 'blocked' | 'neutral';
const TONE: Readonly<Record<Tone, { kind: StatusKind; pip: PipKind }>> = {
  pending: { kind: 'track', pip: 'open' },
  review: { kind: 'track', pip: 'soft' },
  done: { kind: 'ready', pip: 'ready' },
  blocked: { kind: 'blocked', pip: 'blocked' },
  neutral: { kind: 'track', pip: 'closed' },
};
const m = (word: string, tone: Tone): Mark => ({ word, ...TONE[tone] });

export const CHANGE_EVENT_STATUS: Readonly<Record<string, Mark>> = {
  OPEN: m('Open', 'pending'), PRICING: m('Pricing', 'pending'), PRICED: m('Priced', 'review'), SUBMITTED: m('With owner', 'review'),
  APPROVED: m('Approved', 'done'), REJECTED: m('Rejected', 'blocked'), NO_COST: m('No cost', 'neutral'), VOID: m('Void', 'neutral'),
};

export const PCO_STATUS: Readonly<Record<string, Mark>> = {
  DRAFT: m('Draft', 'pending'), SUBMITTED: m('With owner', 'review'), REVISE: m('Revise', 'blocked'), APPROVED: m('Approved', 'done'),
  REJECTED: m('Rejected', 'blocked'), VOID: m('Void', 'neutral'), ROLLED_UP: m('In a COR', 'neutral'),
};

export const RFQ_STATUS: Readonly<Record<string, Mark>> = {
  DRAFT: m('Draft', 'pending'), SENT: m('Sent', 'pending'), RESPONDED: m('Priced', 'review'), ACCEPTED: m('Accepted', 'done'),
  DECLINED: m('Declined', 'neutral'), VOID: m('Void', 'neutral'),
};

export const PAY_APP_STAGE: Readonly<Record<string, Mark>> = {
  PENCIL: m('Pencil', 'pending'), PENCIL_SENT: m('Pencil sent', 'review'), REVISE: m('Revise', 'blocked'), CERTIFIED: m('Certified', 'review'),
  FINAL: m('Final', 'done'), VOID: m('Void', 'neutral'),
};

export const SUB_PAY_APP_STATUS: Readonly<Record<string, Mark>> = {
  DRAFT: m('Draft', 'pending'), SUBMITTED: m('Submitted', 'review'), IN_REVIEW: m('In review', 'review'), REVISE: m('Revise', 'blocked'),
  APPROVED: m('Approved', 'done'), REJECTED: m('Rejected', 'blocked'), VOID: m('Void', 'neutral'),
};

export const WAIVER_STATUS: Readonly<Record<string, Mark>> = {
  REQUESTED: m('Requested', 'pending'), SENT: m('Sent to sign', 'pending'), SIGNED: m('Signed', 'review'), RECEIVED: m('Received', 'review'),
  VERIFIED: m('Verified', 'done'), REJECTED: m('Rejected', 'blocked'), VOID: m('Void', 'neutral'),
};

export const WAIVER_TYPE: Readonly<Record<string, string>> = {
  CONDITIONAL_PROGRESS: 'Conditional progress', UNCONDITIONAL_PROGRESS: 'Unconditional progress',
  CONDITIONAL_FINAL: 'Conditional final', UNCONDITIONAL_FINAL: 'Unconditional final',
};

export const COI_STATUS: Readonly<Record<string, Mark>> = {
  RECEIVED: m('Received', 'pending'), VERIFIED: m('Verified', 'done'), DEFICIENT: m('Deficient', 'blocked'), EXPIRED: m('Expired', 'blocked'),
  SUPERSEDED: m('Superseded', 'neutral'),
};

export const RFI_STATUS: Readonly<Record<string, Mark>> = {
  DRAFT: m('Draft', 'pending'), OPEN: m('Open', 'review'), ANSWERED: m('Answered', 'done'), CLOSED: m('Closed', 'neutral'), VOID: m('Void', 'neutral'),
};

export const SUBMITTAL_STATUS: Readonly<Record<string, Mark>> = {
  NOT_STARTED: m('Not started', 'neutral'), REQUESTED: m('Requested', 'pending'), SUBMITTED: m('Submitted', 'review'), IN_REVIEW: m('In review', 'review'),
  APPROVED: m('Approved', 'done'), APPROVED_AS_NOTED: m('Approved as noted', 'done'), REVISE_RESUBMIT: m('Revise and resubmit', 'blocked'),
  REJECTED: m('Rejected', 'blocked'), FOR_RECORD: m('For record', 'done'), CLOSED: m('Closed', 'neutral'), VOID: m('Void', 'neutral'),
};

export const TM_STATUS: Readonly<Record<string, Mark>> = {
  DRAFT: m('Draft', 'pending'), SUBMITTED: m('To sign', 'review'), SIGNED: m('Signed', 'done'), DISPUTED: m('Disputed', 'blocked'),
  BILLED: m('Billed', 'done'), VOID: m('Void', 'neutral'),
};

export const EAC_STATUS: Readonly<Record<string, Mark>> = {
  DRAFT: m('Draft', 'pending'), SUBMITTED: m('Submitted', 'review'), APPROVED: m('Approved', 'done'), REJECTED: m('Sent back', 'blocked'),
  SUPERSEDED: m('Superseded', 'neutral'),
};

export const MEETING_STATUS: Readonly<Record<string, Mark>> = {
  SCHEDULED: m('Scheduled', 'pending'), IN_PROGRESS: m('In progress', 'review'), MINUTES_DRAFT: m('Minutes draft', 'review'),
  DISTRIBUTED: m('Distributed', 'done'), CLOSED: m('Closed', 'neutral'), CANCELLED: m('Cancelled', 'neutral'),
};

export const DAILY_LOG_STATUS: Readonly<Record<string, Mark>> = {
  DRAFT: m('Draft', 'pending'), SIGNED: m('Signed', 'done'), AMENDED: m('Amended', 'review'),
};

export function mark(map: Readonly<Record<string, Mark>>, status: string | null | undefined): Mark {
  return (status && map[status]) || m(status ? status.replace(/_/g, ' ').toLowerCase() : '—', 'neutral');
}

export const AUDIT_RULES: Readonly<Record<string, string>> = {
  APPROVED_CO_NOT_ON_SOV: 'Approved change order not on the SOV',
  SIGNED_TM_UNBILLED: 'Signed T&M not billed',
  STORED_NOT_BILLED: 'Material received, not billed',
  RETAINAGE_RELEASE_ELIGIBLE: 'Retainage ready to bill',
  UNDERBILLED: 'Under-billed',
  OVERBILLED: 'Over-billed',
  SUB_BILLED_OVER_OWNER: 'Subs approved past owner billing',
  PROCEEDING_UNPRICED: 'Work proceeding without a price',
  CO_RESPONSE_OVERDUE: 'Owner response overdue',
  NO_PAY_APP_THIS_PERIOD: 'Cutoff passed, no pay application',
};

export const INBOX_KIND: Readonly<Record<string, string>> = {
  RFI: 'RFI', SUBMITTAL_REVIEW: 'Submittal review', SUB_PAY_APP: 'Sub pay application', PCO: 'Change', TM_SIGNATURE: 'T&M signature',
  EAC: 'Cost forecast', MEETING_ITEM: 'Meeting item', OBSERVATION: 'Observation', COMPLIANCE_HOLD: 'Payment hold',
};

export const DELAY_CAUSE: Readonly<Record<string, string>> = {
  WEATHER: 'Weather', OWNER: 'Owner', DESIGN: 'Design / RFI', SUB: 'Subcontractor', MATERIAL: 'Material', INSPECTION: 'Inspection',
  LABOR: 'Labor', ACCESS: 'Access', OTHER: 'Other',
};

/** "0.1" → "10%". */
export function pctText(n: number | null | undefined, places = 0): string {
  return n == null ? '—' : `${(n * 100).toFixed(places)}%`;
}
