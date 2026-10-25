/**
 * Portal database errors → HTTP. The portal functions raise "PORTAL_<CODE>: sentence"; the
 * sentence is written for the person in front of the portal. Pure (unit-tested).
 */
export type PortalErrorCode = 'auth' | 'forbidden' | 'verify' | 'invalid' | 'rate_limited' | 'not_set_up' | 'unavailable';

export interface MappedPortalError { status: number; code: PortalErrorCode; message: string }

const TOKENS: Readonly<Record<string, { status: number; code: PortalErrorCode }>> = {
  PORTAL_AUTH: { status: 401, code: 'auth' },
  PORTAL_FORBIDDEN: { status: 404, code: 'forbidden' },
  PORTAL_VERIFY: { status: 403, code: 'verify' },
  PORTAL_INVALID: { status: 422, code: 'invalid' },
  PORTAL_RATE: { status: 429, code: 'rate_limited' },
  PORTAL_NOT_SET_UP: { status: 503, code: 'not_set_up' },
  PORTAL_KEY: { status: 503, code: 'not_set_up' },
};

export function mapPortalError(e: { message?: string | null; code?: string | null } | null | undefined): MappedPortalError {
  const msg = e?.message ?? '';
  const m = /^(PORTAL_[A-Z_]+):\s*(.*)$/s.exec(msg);
  if (m && TOKENS[m[1]]) return { ...TOKENS[m[1]], message: m[2].trim() || 'That did not go through.' };
  return { status: 503, code: 'unavailable', message: 'The portal is not responding. Try again in a minute.' };
}

export class PortalError extends Error {
  constructor(public readonly status: number, public readonly code: PortalErrorCode, message: string) {
    super(message);
    this.name = 'PortalError';
  }
}
