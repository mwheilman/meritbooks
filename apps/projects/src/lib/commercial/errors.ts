/**
 * Commercial (1120) error tokens → HTTP status + one plain sentence. Pure (unit-tested).
 * The 42501 tokens get fixed sentences (mapPgError never shows a 403's detail); the 22023
 * tokens carry the specific reason after the colon, which is already written for people
 * ("PM_PCO_EMPTY: PCO-004 has no lines") — those keep their detail. Anything else falls back
 * to the money mapper (separation of duties, approval tiers, 1102 tokens).
 */
import { splitToken, type MappedError, type PgErrorLike } from '@/lib/api-errors';
import { mapMoneyError, type MoneySubject } from '@/lib/pm/money/errors';

const FIXED: Readonly<Record<string, { status: number; error: string }>> = {
  PM_MONEY_FORBIDDEN: { status: 403, error: 'Prices and costs on this job need the money access your role does not have. Save it without a figure; the project manager prices it.' },
  PM_CHANGE_EVENT_LOCKED: { status: 409, error: 'This change is with the owner or decided. Reprice it through its PCO.' },
  PM_PCO_LOCKED: { status: 409, error: 'The PCO is with the owner or decided. Revise it to change lines.' },
  PM_PCO_STATE: { status: 409, error: 'A PCO moves only through its actions: submit, revise or roll into a COR.' },
  PM_DAILY_LOG_LOCKED: { status: 409, error: 'This daily log is signed. Add an amendment instead; the original stays on record.' },
  PM_DAILY_LOG_STATE: { status: 409, error: 'Sign the log with Sign; a signed log changes only by amendment.' },
  PM_TM_LOCKED: { status: 409, error: 'This T&M ticket is signed. It is locked so the signature means what it says.' },
  PM_RFI_LOCKED: { status: 409, error: 'This RFI is closed. Reopen it to change it.' },
  PM_EAC_LOCKED: { status: 409, error: 'The forecast is submitted or approved. Start next month’s forecast to change it.' },
  PM_EAC_LINES: { status: 409, error: 'Budget, committed and actual come from the job. Enter the cost to complete; the forecast is worked out from it.' },
  PM_EAC_RPC: { status: 409, error: 'A forecast moves only through Submit and Approve.' },
  PM_SUB_PAY_APP_RPC: { status: 409, error: 'Sub pay applications are created and moved through their actions so the math and the approval chain stay intact.' },
  PM_SUB_PAY_APP_LOCKED: { status: 409, error: 'The pay application is in review. Send it back for revision to change lines.' },
  PM_IMMUTABLE: { status: 409, error: 'A pinned record never changes. Pin the period again to make a revision.' },
  PM_TRANSMITTAL_LOCKED: { status: 409, error: 'A sent transmittal is the record of what went out. Send a new one.' },
  PM_PROPOSAL_LOCKED: { status: 409, error: 'The proposal was sent. Revise it as a new version.' },
  PM_REVIEW_SIGNED: { status: 409, error: 'The review package is signed. Build next month’s package.' },
  PM_CM_JOB_FIXED: { status: 409, error: 'A record cannot move to another job.' },
  PM_SOD_DISTINCT: { status: 403, error: 'You approved an earlier step on this one. Someone else has to approve this step.' },
};

/** Tokens whose detail is the sentence (raised with 22023 / P0001 and written for people). */
const DETAIL_PREFIXES = ['PM_INVALID', 'PM_RFQ_', 'PM_PCO_', 'PM_COR_', 'PM_PAYAPP_', 'PM_SUB_PAY_APP_', 'PM_WAIVER_', 'PM_TM_', 'PM_EAC_', 'PM_RFI_',
  'PM_SUBMITTAL_', 'PM_MEETING_', 'PM_INSPECTION_', 'PM_CLOSE_', 'PM_PROPOSAL_', 'PM_VOICE_', 'PM_CHANGE_EVENT_', 'PM_REVIEW_', 'PM_COI_',
  'PM_UNKNOWN_', 'PM_NOT_A_PAY_APP', 'PM_CO_NOT_APPROVED', 'PM_CM_', 'PRECONDITION_'];

function sentence(detail: string): string {
  const d = detail.trim();
  if (!d) return 'That could not be saved.';
  const s = d[0]!.toUpperCase() + d.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/** Status for a detail token: preconditions and states are 422/409, never 500. */
function statusFor(token: string, pgCode: string): number {
  if (token.startsWith('PRECONDITION_')) return 422;
  if (pgCode === '42501') return 403;
  if (/_STATE$|_CLOSED$|_LOCKED$|_EXISTS$|_OPEN$/.test(token)) return 409;
  return 422;
}

export function mapCommercialError(err: PgErrorLike, subject: MoneySubject = 'record'): MappedError {
  const { token, detail } = splitToken(err.message);
  if (token && Object.hasOwn(FIXED, token)) {
    const f = FIXED[token]!;
    return { status: f.status, body: { error: f.error, code: token } };
  }
  if (token && token !== 'PM_FORBIDDEN' && token !== 'PM_SOD_VIOLATION' && DETAIL_PREFIXES.some((p) => token.startsWith(p))) {
    // a 42501 detail token is still a refusal; its detail names only the caller's own records
    return { status: statusFor(token, (err.code ?? '').toUpperCase()), body: { error: sentence(detail), code: token } };
  }
  return mapMoneyError(err, subject);
}
