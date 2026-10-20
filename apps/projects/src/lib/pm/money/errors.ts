/**
 * Money-route errors (1102/1103 tokens) → HTTP status + one plain sentence. Pure
 * (unit-tested). Builds on lib/api-errors mapPgError for the errcode → status rules
 * and replaces the sentence for the money tokens, so approval tiers, separation of
 * duties and billing preconditions read in plain words.
 */
import { APPROVAL_ROLE_LABELS, type ApprovalRole } from '@/lib/packs';
import { mapPgError, splitToken, type MappedError, type PgErrorLike } from '@/lib/api-errors';
import { parsePreconditionList, preconditionCopy, preconditionsSentence } from './preconditions';

/** What was being approved, for the separation-of-duties sentence. */
export type MoneySubject = 'commitment' | 'commitment change' | 'billing request' | 'estimate' | 'deposit' | 'record';

const SENTENCES: Readonly<Record<string, string>> = {
  PM_NO_ACTOR: 'Sign in again: approvals need a named person.',
  PM_FORBIDDEN: 'That belongs to a different workspace, or you no longer have access to it.',
  PM_APPROVAL_NO_TIER: 'This amount is above every approval tier for commitments. Ask an owner to add a higher tier in Settings.',
  PM_APPROVAL_MULTI_UNSUPPORTED: 'This amount needs more than one approver, and two-person approval is not available yet. Ask an owner to change the tier in Settings.',
  // estimates
  PM_ESTIMATE_NOT_DRAFT: 'Only a draft estimate can be sent.',
  PM_ESTIMATE_NOT_OPEN: 'Only a draft or sent estimate can be accepted or declined.',
  PM_ESTIMATE_EMPTY: 'Add at least one line first.',
  PM_ESTIMATE_NONPOSITIVE: 'The estimate total has to be more than zero to accept it.',
  PM_ESTIMATE_UNCODED: 'Every line with a cost needs a cost code; the budget is built by cost code.',
  PM_ESTIMATE_SUPERSEDED: 'A newer version exists. Revise the latest version instead.',
  PM_ESTIMATE_DRAFT_EXISTS: 'This estimate already has a draft version. Finish or delete that draft first.',
  PM_ESTIMATE_LOCKED: 'Lines can change only while the estimate is a draft. Revise it to make changes.',
  // commitments
  PM_COMMITMENT_NOT_DRAFT: 'Only a draft commitment can be approved.',
  PM_COMMITMENT_NO_VENDOR: 'Choose the vendor before approving.',
  PM_COMMITMENT_EMPTY: 'Add lines that total more than zero before approving.',
  PM_COMMITMENT_UNCODED: 'Every line needs a cost code before approving.',
  PM_COMMITMENT_NOT_APPROVED: 'Only an approved commitment can be marked signed.',
  PM_COMMITMENT_NOT_OPEN: 'Only an approved or signed commitment can be closed.',
  PM_COMMITMENT_NOT_VOIDABLE: 'Closed or void commitments cannot be voided.',
  PM_COMMITMENT_BILLED: 'Merit Books has bills against this commitment, so it cannot be voided. Close it instead.',
  PM_COMMITMENT_VOID: 'This commitment is void.',
  PM_COMMITMENT_LOCKED: 'Lines change only while the commitment is a draft. Use a change order on the commitment instead.',
  PM_COMMITMENT_JOB_FIXED: 'A commitment cannot move to another job.',
  PM_UNKNOWN_COMMITMENT: 'That commitment was not found in this workspace.',
  PM_HOLD_REASON: 'Give a reason for the payment hold; Merit Books shows it to whoever runs payments.',
  PM_UNKNOWN_VENDOR: 'That vendor was not found in this workspace.',
  PM_CCO_NOT_DRAFT: 'Only a draft commitment change can be approved or rejected.',
  PM_CCO_COMMITMENT_STATE: 'Changes apply to approved or signed commitments. Edit a draft commitment directly.',
  PM_CCO_NEGATIVE_LINE: 'That change would take the line below zero.',
  PM_CCO_NEW_LINE: 'A change that adds a line needs a cost code and an amount above zero.',
  PM_CCO_LINE: 'That line is not on this commitment.',
  PM_CCO_OWNER_CO: 'That change order is on a different job.',
  PM_RECEIPT_COMMITMENT_STATE: 'Receive against an approved or signed commitment.',
  PM_RECEIPT_AMOUNT: 'Enter the amount received; this line has no unit cost to work it out.',
  PM_DOCUMENT_ORG_MISMATCH: 'That document belongs to a different workspace.',
  PM_COMPLIANCE_JOB: 'That commitment is on a different job.',
  // SOV
  PM_SOV_NOT_DRAFT: 'Only a draft schedule of values can be activated.',
  PM_SOV_EMPTY: 'Add scheduled values before activating.',
  PM_SOV_CONTRACT_MISMATCH: 'The schedule of values does not add up to the revised contract. Fix the lines, or activate it anyway.',
  PM_SOV_DRAFT_APPLICATION: 'Approve or void the draft pay application first.',
  PM_SOV_BELOW_BILLED: 'A billed line is missing from this version or scheduled below what has been billed on it.',
  PM_SOV_DRAFT_EXISTS: 'This job already has a draft schedule of values.',
  PM_SOV_LOCKED: 'An active schedule of values is locked. Revise it to change lines.',
  PM_SOV_CONTRACT: 'That contract is on a different job.',
  PM_UNKNOWN_SOV: 'That schedule of values is not on this job.',
  PM_SOV_UNKNOWN_LINE: 'A line in the pay application is not on the active schedule of values.',
  PM_SOV_DUPLICATE_LINE: 'A line appears twice in the pay application.',
  PM_SOV_PCT: 'Percent complete is 0 to 100.',
  PM_SOV_NEGATIVE: 'A line would go below zero. Check the percent and stored materials.',
  PM_SOV_OVER_SCHEDULED: 'Completed plus stored would be more than a line’s scheduled value.',
  PM_DRAFT_PAY_APP_EXISTS: 'This job already has a draft pay application. Approve or void it first.',
  // billing
  PM_DRAFT_EXISTS: 'This job already has a draft progress billing. Approve or void it first.',
  PM_NO_PROGRESS_PCT: 'Enter a percent complete, or set progress on the Contract tab first.',
  PM_NOT_A_MILESTONE: 'One of those is not a milestone.',
  PM_MILESTONE_NOT_COMPLETE: 'Only completed milestones can be billed.',
  PM_UNKNOWN_MILESTONE: 'One of those milestones is not on this job.',
  PM_MILESTONE_NO_AMOUNT: 'A milestone has no billing amount or share of the contract. Set it on the schedule first.',
  PM_MILESTONE_ALREADY_BILLED: 'One of those milestones has already been billed.',
  PM_MILESTONE_DUPLICATE: 'A milestone is listed twice.',
  PM_RELEASE_IN_FLIGHT: 'A retainage release is already drafted or rejected. Approve or void it first.',
  PM_ALLOWANCE_CLOSED: 'That allowance is already closed.',
  PM_ALLOWANCE_NO_OVERAGE: 'Close the allowance with an overage first.',
  PM_ALLOWANCE_ALREADY_BILLED: 'That overage has already been billed.',
  PM_BILLING_NOT_APPROVABLE: 'Only drafts and rejected requests can be approved.',
  PM_BILLING_NOT_VOIDABLE: 'Merit Books has this request. To undo an issued invoice, issue a credit memo in Merit Books.',
  PM_BILLING_LOCKED: 'Generated lines cannot be edited. Void the draft and draft it again.',
  PM_BILLING_LINE_TYPE: 'Only standard lines can be added by hand.',
  PM_BILLING_CONTRACT: 'That contract is on a different job.',
  PM_BILLING_JOB_FIXED: 'A billing request cannot move to another job.',
  PM_DEPOSIT_NOT_REJECTED: 'Only a deposit request Merit Books rejected can be sent again.',
  PM_COST_CODE_SCOPE: 'That cost code belongs to another company or job.',
  PM_NOT_A_PROJECT: 'That job is not managed in Merit Projects.',
  PM_UNKNOWN_JOB: 'That job was not found in this workspace.',
  PM_UNKNOWN_CUSTOMER: 'That customer was not found in this workspace.',
};

function capitalize(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** "approving 2800000000 cents under policy commitment needs role ["owner"]; approver has pm" → plain words. */
export function approvalRoleSentence(detail: string): string {
  const m = /needs role (\[.*?\]|\S+); approver has (.+)$/.exec(detail);
  let roles: string[] = [];
  if (m?.[1]) {
    try {
      const parsed: unknown = JSON.parse(m[1]);
      if (Array.isArray(parsed)) roles = parsed.filter((x): x is string => typeof x === 'string');
    } catch {
      roles = [m[1].replace(/[^a-z_]/gi, '')];
    }
  }
  const label = (r: string) => (APPROVAL_ROLE_LABELS[r.toLowerCase() as ApprovalRole] ?? r.replace(/_/g, ' ')).toLowerCase();
  const need = roles.length ? roles.map(label).join(' or ') : 'a more senior role';
  const have = m?.[2]?.trim();
  const haveText = have && have !== '(none)' ? ` You are signed in as ${label(have)}.` : ' Your account has no approval role yet.';
  return `This amount needs approval by ${/^[aeiou]/.test(need) ? 'an' : 'a'} ${need}.${haveText}`;
}

/** PG error from a money RPC → status + plain sentence + the token as code. */
export function mapMoneyError(err: PgErrorLike, subject: MoneySubject = 'record'): MappedError & { body: { preconditions?: string[] } } {
  const base = mapPgError(err);
  const { token, detail } = splitToken(err.message);
  if (!token) return base;

  if (token === 'PM_SOD_VIOLATION') {
    return { status: 403, body: { error: `You prepared this ${subject}, so someone else has to approve it.`, code: token } };
  }
  if (token === 'PM_APPROVAL_ROLE') {
    return { status: 403, body: { error: approvalRoleSentence(detail), code: token } };
  }
  if (token === 'PM_APPROVAL_MULTI_UNSUPPORTED') {
    return { status: 422, body: { error: SENTENCES[token]!, code: token } };
  }
  if (token === 'PRECONDITION_FAILED') {
    const codes = parsePreconditionList(detail);
    return { status: 422, body: { error: preconditionsSentence(codes), code: token, preconditions: codes } };
  }
  if (token.startsWith('PRECONDITION_')) {
    return { status: 422, body: { error: preconditionCopy(token).sentence, code: token, preconditions: [token] } };
  }
  const s = SENTENCES[token];
  if (s) return { status: base.status, body: { error: s, code: token } };
  // unknown token: keep the status; 403s never leak detail (mapPgError already chose)
  if (base.status === 403 || base.status === 500) return base;
  return { status: base.status, body: { error: detail ? capitalize(detail.replace(/\.?$/, '.')) : base.body.error, code: token } };
}

export function isKnownMoneyToken(token: string): boolean {
  return token in SENTENCES || token === 'PM_SOD_VIOLATION' || token === 'PM_APPROVAL_ROLE' || token.startsWith('PRECONDITION_');
}

/** Tokens whose database detail is the message (PM_INVALID carries the specific reason). */
export const DETAIL_TOKENS: ReadonlySet<string> = new Set(['PM_INVALID']);
