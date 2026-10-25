/**
 * Plain sentences for the tokens migration 1122 (industry depth) raises. The definer functions
 * already word their detail for a person ("the project is out of balance by 50000000 cents"), so
 * the detail is kept and tidied; a few tokens get a fixed sentence because the detail is internal.
 * Runs before the dealer / ops / shared mappers: the shared PM_SOD_VIOLATION sentence talks about
 * change orders, which is wrong for a pay ticket, a remake or a draw invoice. Pure (unit-tested).
 */
import { splitToken, type PgErrorLike } from '@/lib/api-errors';

export interface DepthErrorCopy {
  status: number;
  code: string;
  error: string;
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const CENTS_RE = /(-?\d{3,}) cents/g;

/** The 1122 tokens (and the shared ones whose 1122 detail is the better sentence). */
export const DEPTH_TOKENS: ReadonlySet<string> = new Set([
  'PM_UNKNOWN_VENDOR', 'PM_CLAIM_TRANSITION_INVALID', 'PM_UNKNOWN_EMPLOYEE', 'PM_SOD_VIOLATION', 'PM_RENTAL_TRANSITION_INVALID',
  'PM_PAY_TICKET_STATE', 'PM_DUPLICATE', 'PM_DRAW_LOCKED', 'PM_WO_LOCKED', 'PM_PROGRAM_NOT_ELIGIBLE', 'PM_PRODUCTION_LOCKED',
  'PM_PRICE_FILE_STATE', 'PM_KIOSK_SESSION', 'PM_FLR_ROLL_SHORT', 'PM_DSN_ITEM_LOCKED', 'PM_DEV_LOCKED', 'PM_DEAL_LOCKED',
  'PM_CLAIM_LOCKED', 'PM_UNKNOWN_OPERATION', 'PM_TIME_BILLED', 'PM_REMAKE_DECIDED', 'PM_PUNCH_TOO_LONG', 'PM_NO_EMPLOYEE',
  'PM_NOT_PRODUCTION', 'PM_KIOSK_PIN', 'PM_KIOSK_NOT_RUNNING', 'PM_KIOSK_LOCKED', 'PM_KIOSK_BADGE', 'PM_KIOSK_DEVICE_LOCKED', 'PM_KIOSK_RATE_LIMIT', 'PM_KIOSK_PIN_REQUIRED', 'PM_ITEM_TRANSITION_INVALID',
  'PM_INBOX_DECIDED', 'PM_FLR_ROLL_UNAVAILABLE', 'PM_FLR_NOT_READY', 'PM_FLR_CUT_DONE', 'PM_FLR_CAPACITY_FULL', 'PM_ESTIMATE_LOCKED',
  'PM_DSN_NO_AGREEMENT', 'PM_DSN_NOT_PROPOSABLE', 'PM_DSN_DEPOSIT_SHORT', 'PM_DSN_DECIDED', 'PM_DEV_SOURCE_OVER_COMMITMENT',
  'PM_DEV_REALLOCATION_OPEN', 'PM_DEV_OUT_OF_BALANCE', 'PM_DEV_LINE_SHORT', 'PM_DEV_LENDER_CONSENT_REQUIRED', 'PM_CREDIT_DECIDED',
  'PM_CLAIM_SUBMISSION_STATE', 'PM_CLAIM_INCOMPLETE', 'PM_CHARGEBACK_STATE', 'PM_CAD_IMPORT_STATE',
]);

const FIXED: Readonly<Record<string, string>> = {
  PM_KIOSK_SESSION: 'The station lost this worker. Scan the badge again.',
  PM_KIOSK_PIN: 'That PIN does not match this badge.',
  PM_KIOSK_BADGE: 'That badge is not set up at this company.',
  PM_KIOSK_LOCKED: 'Too many tries on this badge. Wait ten minutes or ask a supervisor.',

  PM_PUNCH_TOO_LONG: 'That punch ran past the longest shift. A supervisor fixes it on the time sheet.',
  PM_KIOSK_DEVICE_LOCKED: 'Too many failed sign-ins at this station. It is locked for 15 minutes.',
  PM_KIOSK_PIN_REQUIRED: 'This badge has no PIN yet. A supervisor sets one before it can sign in.',
  PM_KIOSK_RATE_LIMIT: 'Too many sign-ins at this station in a minute. Wait a moment and scan again.',
};

/** "out of balance by 50000000 cents" → "out of balance by $500,000.00". */
export function centsWords(detail: string): string {
  return detail.replace(CENTS_RE, (_m, n: string) => {
    const v = Number(n);
    const abs = Math.abs(v);
    const s = `$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
    return v < 0 ? `-${s}` : s;
  });
}

function tidy(detail: string): string {
  const s = centsWords(detail).replace(UUID_RE, 'that record').replace(/\s+/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/\.?$/, '.') : '';
}

function statusFor(pg: string, token: string): number {
  if (pg === '42501') return 403;
  if (pg === 'P0002') return 404;
  if (pg === '23505' || token === 'PM_DUPLICATE') return 409;
  if (pg === '23P01' || token === 'PM_FLR_CAPACITY_FULL' || token === 'PM_DEV_REALLOCATION_OPEN') return 409;
  return 422;
}

export function depthErrorCopy(e: PgErrorLike): DepthErrorCopy | null {
  const { token, detail } = splitToken(e.message);
  if (!token || !DEPTH_TOKENS.has(token)) return null;
  const pg = (e.code ?? '').toUpperCase();
  const error = FIXED[token] ?? (tidy(detail) || 'That change was not made.');
  return { status: statusFor(pg, token), code: token, error };
}
