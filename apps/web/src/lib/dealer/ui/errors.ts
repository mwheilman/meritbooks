/**
 * Dealer Pack (D2) — turn a D1 API error ({ error, code, details }) into one calm,
 * plain-English message plus an optional "fix it here" link. Pure, client-safe.
 * Error codes: docs/dealer-pack-api.md §1.
 */

import { ROLE_SPEC, type DealerRole } from '../roles';
import { DEPT_ROLE } from './labels';
import type { DeptRole } from '../types';

export interface DealerApiError {
  error: string;
  code: string;
  details?: unknown;
}

export interface ExplainedError {
  title: string;
  message: string;
  /** Where the person can fix it (e.g. the settings role map). */
  fixHref?: string;
  fixLabel?: string;
}

export const SETTINGS_HREF = '/dealer/settings';

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function roleLabel(key: string): string {
  return ROLE_SPEC[key as DealerRole]?.label ?? key;
}

/** "ROLE:FLOOR_PLAN_PAYABLE" / "DEPT:SERVICE" → plain English. */
export function describeRequirement(req: string): string {
  const [kind, key] = req.split(':');
  if (kind === 'ROLE' && key) return `Account for “${roleLabel(key)}”`;
  if (kind === 'DEPT' && key) return `Department for “${DEPT_ROLE[key as DeptRole]?.label ?? key}”`;
  return req;
}

export function explainDealerError(e: DealerApiError | null | undefined): ExplainedError {
  if (!e) return { title: 'Something went wrong', message: 'Please try again.' };
  const d = rec(e.details);
  switch (e.code) {
    case 'NO_ORG':
      return { title: 'No organization selected', message: 'Sign in to an organization to use the dealer pack.' };
    case 'FORBIDDEN':
      return { title: 'You don’t have permission', message: e.error || 'Ask an administrator for access to this action.' };
    case 'NOT_FOUND':
      return { title: 'Not found', message: e.error || 'This record was not found for this client.' };
    case 'NOT_ENABLED':
      return {
        title: 'The dealer pack is off for this client',
        message: 'Finish setup and switch the pack on before recording money events. Setup, lenders and imports still work.',
        fixHref: SETTINGS_HREF,
        fixLabel: 'Open dealer settings',
      };
    case 'UNMAPPED_ROLE': {
      const role = typeof d.role === 'string' ? d.role : null;
      return {
        title: 'An account still needs to be chosen',
        message: role ? `Choose the account for “${roleLabel(role)}” for this client, then try again.` : e.error,
        fixHref: `${SETTINGS_HREF}#accounts`,
        fixLabel: 'Map accounts',
      };
    }
    case 'UNMAPPED_DEPARTMENT': {
      const dept = typeof d.deptRole === 'string' ? d.deptRole : null;
      return {
        title: 'A department still needs to be chosen',
        message: dept
          ? `Choose which of this client’s departments is “${DEPT_ROLE[dept as DeptRole]?.label ?? dept}”, then try again.`
          : e.error,
        fixHref: `${SETTINGS_HREF}#departments`,
        fixLabel: 'Map departments',
      };
    }
    case 'ENABLE_BLOCKED': {
      const missing = Array.isArray(d.missing) ? (d.missing as string[]) : [];
      const problems = Array.isArray(d.problems) ? (d.problems as string[]) : [];
      const parts = [
        ...missing.map(describeRequirement),
        ...problems.map((p) => `Opening tie-out: ${p}`),
      ];
      return {
        title: 'The dealer pack can’t be switched on yet',
        message: parts.length ? `Still needed: ${parts.join('; ')}.` : e.error,
        fixHref: SETTINGS_HREF,
        fixLabel: 'Finish setup',
      };
    }
    case 'SEPARATION_OF_DUTIES':
      return {
        title: 'A different person must do this step',
        message: 'The person who prepared or proposed this can’t also approve or release it. Ask a colleague with approval rights.',
      };
    case 'INTEREST_VARIANCE':
      return {
        title: 'Billed interest doesn’t match what Books accrued',
        message: e.error || 'The difference is over this client’s tolerance. An approver can accept the variance.',
      };
    case 'NOT_FOOTING':
      return {
        title: 'The statement lines don’t add up to its totals',
        message: 'Fix the lines (or the footer totals) so they match before importing. Nothing was saved.',
      };
    case 'POSTING_FAILED':
      return { title: 'The entry could not be posted', message: e.error || 'Check that the accounting period is open.' };
    case 'CONFLICT':
      return { title: 'That can’t be done in the current state', message: e.error };
    case 'VALIDATION':
    case 'VALIDATION_ERROR':
      return { title: 'Please check the details', message: e.error };
    case 'NETWORK_ERROR':
      return { title: 'Connection problem', message: 'We couldn’t reach the server. Check your connection and try again.' };
    default:
      return { title: 'Something went wrong', message: e.error || 'Please try again.' };
  }
}

/** Field-level Zod messages from a 422 VALIDATION_ERROR (apiHandler shape). */
export function fieldErrors(e: DealerApiError | null | undefined): Record<string, string> {
  const d = rec(e?.details);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(d)) {
    if (Array.isArray(v) && typeof v[0] === 'string') out[k] = v[0];
    else if (typeof v === 'string') out[k] = v;
  }
  return out;
}
