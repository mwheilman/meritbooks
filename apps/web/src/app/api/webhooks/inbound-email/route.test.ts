/**
 * The public inbound webhook fails CLOSED and verifies before it parses or touches
 * the database (FPB-ap-intake §6 criterion 4).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const adminCalls = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createAdminSupabase: () => {
    adminCalls();
    throw new Error('the database must not be touched in these cases');
  },
}));

import { POST } from './route';

const SECRET = 'a-very-long-webhook-password-1';
const ENV_KEYS = ['INBOUND_EMAIL_PROVIDER', 'INBOUND_EMAIL_SECRET', 'INBOUND_EMAIL_DOMAIN', 'INBOUND_EMAIL_BASIC_USER', 'INBOUND_EMAIL_ALLOWED_IPS'] as const;
const saved: Record<string, string | undefined> = {};

function req(body: string, headers: Record<string, string> = {}): Request {
  return new Request('https://books.test/api/webhooks/inbound-email', { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });
}
const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  adminCalls.mockClear();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('POST /api/webhooks/inbound-email', () => {
  it('401 for everything when no secret is configured — even with credentials', async () => {
    const res = await POST(req('{}', { authorization: basic('meritbooks', '') }));
    expect(res.status).toBe(401);
    expect(adminCalls).not.toHaveBeenCalled();
  });

  it('401 on a wrong password (postmark default)', async () => {
    process.env.INBOUND_EMAIL_SECRET = SECRET;
    const res = await POST(req('{}', { authorization: basic('meritbooks', 'guess') }));
    expect(res.status).toBe(401);
    expect(adminCalls).not.toHaveBeenCalled();
  });

  it('400 on an unreadable body once authenticated (no DB touched)', async () => {
    process.env.INBOUND_EMAIL_SECRET = SECRET;
    const res = await POST(req('{not json', { authorization: basic('meritbooks', SECRET) }));
    expect(res.status).toBe(400);
    expect(adminCalls).not.toHaveBeenCalled();
  });

  it('413 when the declared size is beyond any provider limit', async () => {
    process.env.INBOUND_EMAIL_SECRET = SECRET;
    const res = await POST(req('{}', { authorization: basic('meritbooks', SECRET), 'content-length': String(50 * 1024 * 1024) }));
    expect(res.status).toBe(413);
  });
});
