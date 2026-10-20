import { describe, expect, it } from 'vitest';
import { mapPgError, splitToken } from '@/lib/api-errors';

describe('PG errcode → HTTP mapping', () => {
  it('42501 → 403, with the plain sentence for a known token', () => {
    const m = mapPgError({ code: '42501', message: 'PM_SOD_VIOLATION: the preparer of CO-2026-0001 cannot approve it' });
    expect(m.status).toBe(403);
    expect(m.body.code).toBe('PM_SOD_VIOLATION');
    expect(m.body.error).toBe('You prepared this change order, so someone else has to approve it.');
  });

  it('42501 with an unknown token never leaks the raw detail', () => {
    const m = mapPgError({ code: '42501', message: 'permission denied for table budgets' });
    expect(m.status).toBe(403);
    expect(m.body.error).toBe('You don’t have access to do that.');
  });

  it('22023 → 422 with the message', () => {
    const m = mapPgError({ code: '22023', message: 'PM_INVALID: name is required' });
    expect(m.status).toBe(422);
    expect(m.body.error).toBe('Name is required.');
    expect(m.body.code).toBe('PM_INVALID');
  });

  it('P0001 → 422 with the message', () => {
    const m = mapPgError({ code: 'P0001', message: 'PRECONDITION_NO_CONTRACT: job x has no ACTIVE contract; set the contract before emitting progress' });
    expect(m.status).toBe(422);
    expect(m.body.error).toMatch(/Set the contract first/);
  });

  it('P0001 without a token keeps the database sentence', () => {
    const m = mapPgError({ code: 'P0001', message: 'budget is locked' });
    expect(m).toEqual({ status: 422, body: { error: 'Budget is locked.', code: 'P0001' } });
  });

  it('P0002 → 404', () => {
    const m = mapPgError({ code: 'P0002', message: 'PM_UNKNOWN_JOB_TYPE: remodel is not an active job type' });
    expect(m.status).toBe(404);
    expect(m.body.code).toBe('PM_UNKNOWN_JOB_TYPE');
  });

  it('duplicates → 409, broken references → 422, anything else → 500', () => {
    expect(mapPgError({ code: '23505', message: 'duplicate key value' }).status).toBe(409);
    expect(mapPgError({ code: '23514', message: 'PM_COST_CODE_SCOPE: cost code x is not usable on job y' }).status).toBe(422);
    expect(mapPgError({ code: 'XX000', message: 'internal' }).status).toBe(500);
    expect(mapPgError({ code: null, message: null }).status).toBe(500);
  });

  it('splits the PM_ token from the detail', () => {
    expect(splitToken('PM_FORBIDDEN: job 1 not found')).toEqual({ token: 'PM_FORBIDDEN', detail: 'job 1 not found' });
    expect(splitToken('plain message')).toEqual({ token: null, detail: 'plain message' });
  });
});
