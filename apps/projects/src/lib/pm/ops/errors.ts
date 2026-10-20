/**
 * Plain sentences for the tokens the 1104–1107 definer functions raise. The shared mapper
 * (lib/api-errors) handles 42501/22023/P0001/P0002/23xxx; these functions also raise 55000
 * (locked: "object not in prerequisite state") and 23P01 (exclusion: double booking), which it
 * would turn into a 500. Pure (unit-tested).
 */
import { splitToken, type PgErrorLike } from '@/lib/api-errors';

export interface OpsErrorCopy {
  status: number;
  code: string;
  error: string;
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function tidy(detail: string): string {
  const s = detail.replace(UUID_RE, 'that record').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/\.?$/, '.') : '';
}

const FIXED: Readonly<Record<string, string>> = {
  PM_SKILL_MISMATCH: '',
  PM_WO_NOT_SCHEDULABLE: 'This work order is complete, closed or cancelled, so it cannot be scheduled.',
  PM_EMPTY_CREW: 'That crew has no active members. Add technicians to it first.',
  PM_UNKNOWN_EMPLOYEE: 'Every technician must be an active employee of this company.',
  PM_ASSIGNMENT_TRANSITION_INVALID: 'The technician cannot move to that status from where they are now.',
  PM_WO_TRANSITION_INVALID: 'The work order cannot make that move from its current status.',
  PM_WO_LOCKED: 'This work order is closed or cancelled; its lines are locked.',
  PM_WO_UNDECIDED_OPTIONS: 'The customer has not decided every option yet. Record their choice, then close it.',
  PM_OPERATIONS_OPEN: 'Shop operations on this order are still open.',
  PM_NOT_RELEASED: 'Release the order to the shop before starting operations.',
  PM_ALREADY_RELEASED: 'This order is already released to the shop.',
  PM_PRODUCTION_LOCKED: 'The cut list and routing lock at release. Change them through a change order or a remake.',
  PM_OPERATIONS_EXIST: 'This order already has operations. Replace them to apply a different routing.',
  PM_UNKNOWN_ROUTING: 'That routing is not active on this company.',
  PM_OP_TRANSITION_INVALID: 'That operation cannot make this move from where it is.',
  PM_AGREEMENT_TRANSITION_INVALID: 'The agreement cannot make that move from its current status.',
  PM_AGREEMENT_NOT_ACTIVE: 'Activate the agreement before generating visits.',
  PM_AGREEMENT_LOCKED: 'An active agreement keeps its price and term. Renew it to change them.',
  PM_CLAIM_TRANSITION_INVALID: 'The warranty claim cannot make that move from its current status.',
  PM_CLAIM_LOCKED: 'Submitted claims are locked. Move them through the claim steps.',
  PM_SELECTION_TRANSITION_INVALID: 'The selection cannot make that move from where it is.',
  PM_SELECTION_NO_CHOICE: 'Add at least one option before sending this to the client.',
  PM_SELECTION_AMBIGUOUS: 'This selection has several options. Pick the one the client chose.',
  PM_SELECTION_LOCKED: 'An approved selection keeps its allowance and choice. Change it through a change order.',
  PM_SELECTION_NOT_APPROVED: 'Record the client’s approval of an option first.',
  PM_ITEM_TRANSITION_INVALID: 'The item cannot make that move from its current status.',
  PM_ITEM_PRICE_LOCKED: 'Pricing is pinned once the client approved the item.',
  PM_MEASURE_LOCKED: 'A final measure is locked. Start a new version to change it.',
  PM_MEASURE_TRANSITION_INVALID: 'Only a draft measure can be finalized.',
  PM_UNIT_TRANSITION_INVALID: 'The unit cannot move to that status from where it is.',
  PM_ENTITLEMENT_TRANSITION_INVALID: 'That status does not follow from where the approval is now.',
  PM_DRAW_SCHEDULE_TRANSITION_INVALID: 'Only a draft loan budget can be activated.',
  PM_DRAW_SCHEDULE_NOT_ACTIVE: 'Activate the loan budget first.',
  PM_DRAW_OPEN: 'Finish or cancel the open draw before starting the next one.',
  PM_DRAW_TRANSITION_INVALID: 'The draw cannot make that move from its current status.',
  PM_DRAW_LOCKED: 'A submitted draw is locked. Return it for correction to change it.',
  PM_DRAW_BUDGET_LOCKED: 'The loan budget is active. Reallocate a line with a reason instead.',
  PM_DRAW_INSPECTION_REQUIRED: 'The lender requires a passed inspection before approval.',
  PM_REF_ORG_MISMATCH: 'One of the people or records picked belongs to another workspace.',
  PM_JOB_LOCATION_MISMATCH: 'That record belongs to a different company than the job.',
  PM_PRICE_BOOK_SCOPE: 'That price book item belongs to another company.',
  PM_NO_ACTOR: 'Sign in again: this needs a named person.',
  PM_FORBIDDEN: 'That belongs to a different workspace, or you no longer have access to it.',
  PM_NOT_A_PROJECT: 'That job is not managed in Merit Projects.',
  PM_NOT_PRODUCTION: 'That is not a production order.',
};

/** Detail-carrying tokens: keep the database's specifics, tidied. */
const DETAIL: ReadonlySet<string> = new Set([
  'PM_INVALID', 'PM_DRAW_OVER_BUDGET', 'PM_DRAW_EXCEEDS_LOAN', 'PM_RETAINAGE_RELEASE_EXCEEDS_HELD', 'PM_SOURCE_REF_CONFLICT', 'PM_EXT_UNKNOWN_FIELD', 'PM_EXT_TYPE',
]);

const PREFIX: Readonly<Record<string, string>> = {
  PM_DRAW_OVER_BUDGET: 'A line would draw past its loan budget: ',
  PM_DRAW_EXCEEDS_LOAN: 'This draw is more than the undisbursed loan: ',
  PM_RETAINAGE_RELEASE_EXCEEDS_HELD: 'Retainage released is more than the lender holds on ',
};

/**
 * Copy for an ops RPC failure, or null to let the shared mapper answer. `skillNames` turns
 * skill codes in PM_SKILL_MISMATCH into names.
 */
export function opsErrorCopy(err: PgErrorLike, skillNames: Readonly<Record<string, string>> = {}): OpsErrorCopy | null {
  const pg = (err.code ?? '').toUpperCase();
  const { token, detail } = splitToken(err.message);
  if (token === 'PM_DISPATCH_OVERLAP' || pg === '23P01') {
    const on = /on (\S+) in that window/.exec(detail)?.[1];
    return { status: 409, code: 'PM_DISPATCH_OVERLAP', error: on ? `That technician is already booked on ${on} at that time. Pick another time or technician.` : 'That technician already has an overlapping visit. Pick another time or technician.' };
  }
  if (token === 'PM_SKILL_MISMATCH') {
    const codes = (/lack (.+)$/.exec(detail)?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const names = codes.map((c) => skillNames[c] ?? c.replace(/_/g, ' '));
    return { status: 422, code: token, error: names.length ? `The technician does not hold ${names.join(', ')}. Pick someone who does, or assign anyway.` : 'The technician does not hold the skills this visit needs.' };
  }
  if (!token) {
    if (pg === '55000') return { status: 422, code: 'LOCKED', error: tidy(detail) || 'That record is locked in its current status.' };
    return null;
  }
  if (DETAIL.has(token)) {
    const body = tidy(detail);
    return { status: 422, code: token, error: PREFIX[token] ? `${PREFIX[token]}${body.charAt(0).toLowerCase()}${body.slice(1)}` : body || 'Check the values and try again.' };
  }
  const fixed = FIXED[token];
  if (fixed) return { status: pg === '42501' ? 403 : 422, code: token, error: fixed };
  if (pg === '55000') return { status: 422, code: token, error: tidy(detail) || 'That record is locked in its current status.' };
  return null;
}
