import { describe, it, expect } from 'vitest';
import { isQboReturnCode, qboReturnMessage, type QboReturnCode } from './return-codes';
import type { QboReturnCode as RouteReturnCode } from './route-helpers';

// Compile-time: the client copy and the server contract are the SAME union.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameUnion: Same<QboReturnCode, RouteReturnCode> = true;

describe('QuickBooks OAuth return codes', () => {
  it('client and server unions match', () => {
    expect(sameUnion).toBe(true);
  });

  it('recognizes only the known codes', () => {
    for (const c of ['connected', 'cancelled', 'not_configured', 'forbidden', 'expired', 'error']) {
      expect(isQboReturnCode(c)).toBe(true);
    }
    expect(isQboReturnCode('hacked')).toBe(false);
    expect(isQboReturnCode(null)).toBe(false);
    expect(isQboReturnCode('')).toBe(false);
  });

  it('every code has a plain message; error uses the server reason when given', () => {
    expect(qboReturnMessage('connected').tone).toBe('success');
    expect(qboReturnMessage('not_configured').text).toMatch(/export/i);
    expect(qboReturnMessage('forbidden').text).toMatch(/admin/i);
    expect(qboReturnMessage('error', 'Intuit said no').text).toBe('Intuit said no');
    expect(qboReturnMessage('error', '  ').text).toMatch(/went wrong/);
  });
});
