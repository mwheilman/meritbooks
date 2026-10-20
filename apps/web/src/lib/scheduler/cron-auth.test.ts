/**
 * Dispatcher authentication: Bearer CRON_SECRET only, constant-time, FAIL CLOSED.
 * Covers the pure check and the real route handler (dispatch mocked so no DB).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isAuthorizedCronRequest } from './cron-auth';

const { dispatchTick } = vi.hoisted(() => ({
  dispatchTick: vi.fn(async () => ({
    tickId: 't', startedAt: '2026-10-20T08:10:00.000Z', paused: false, due: 0, started: 0, units: [], configErrors: [],
  })),
}));
vi.mock('@/lib/scheduler/dispatch', () => ({ dispatchTick }));

const SECRET = 'cron-secret-0123456789abcdef';

describe('isAuthorizedCronRequest', () => {
  it('accepts exactly "Bearer <secret>"', () => {
    expect(isAuthorizedCronRequest(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });
  it.each([
    ['no header', null],
    ['empty header', ''],
    ['wrong secret', 'Bearer not-the-secret-at-all-xx'],
    ['secret without Bearer', SECRET],
    ['prefix of the secret', `Bearer ${SECRET.slice(0, -1)}`],
    ['secret plus suffix', `Bearer ${SECRET}x`],
    ['Basic scheme', `Basic ${SECRET}`],
  ])('rejects %s', (_label, header) => {
    expect(isAuthorizedCronRequest(header, SECRET)).toBe(false);
  });
  it('fails closed when CRON_SECRET is unset, blank, or too short', () => {
    expect(isAuthorizedCronRequest('Bearer ', undefined)).toBe(false);
    expect(isAuthorizedCronRequest('Bearer undefined', undefined)).toBe(false);
    expect(isAuthorizedCronRequest('Bearer ', '')).toBe(false);
    expect(isAuthorizedCronRequest('Bearer short', 'short')).toBe(false);
  });
});

describe('GET /api/cron/tick', () => {
  const original = process.env.CRON_SECRET;
  beforeEach(() => {
    dispatchTick.mockClear();
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  });

  const call = async (headers: Record<string, string>, method: 'GET' | 'POST' = 'GET') => {
    const mod = await import('@/app/api/cron/tick/route');
    const req = new Request('https://app.example/api/cron/tick', { method, headers });
    return method === 'GET' ? mod.GET(req) : mod.POST(req);
  };

  it('401 with no Authorization header', async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await call({});
    expect(res.status).toBe(401);
    expect(dispatchTick).not.toHaveBeenCalled();
  });

  it('401 with an invalid secret', async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await call({ authorization: 'Bearer wrong-secret-wrong-secret' });
    expect(res.status).toBe(401);
    expect(dispatchTick).not.toHaveBeenCalled();
  });

  it('401 when CRON_SECRET is not configured, even with an empty bearer', async () => {
    delete process.env.CRON_SECRET;
    expect((await call({ authorization: 'Bearer ' })).status).toBe(401);
    expect((await call({ authorization: 'Bearer undefined' })).status).toBe(401);
    expect(dispatchTick).not.toHaveBeenCalled();
  });

  it('a session cookie is not a credential', async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await call({ cookie: '__session=eyJhbGciOi.fake.jwt' });
    expect(res.status).toBe(401);
  });

  it('runs the tick with the right secret (GET and POST)', async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await call({ authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, due: 0 });
    expect((await call({ authorization: `Bearer ${SECRET}` }, 'POST')).status).toBe(200);
    expect(dispatchTick).toHaveBeenCalledTimes(2);
  });
});
