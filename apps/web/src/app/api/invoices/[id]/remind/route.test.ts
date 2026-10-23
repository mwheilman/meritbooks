/**
 * POST /api/invoices/[id]/remind — the Wave 1 security fix: session org, invoices:create
 * on the invoice's client, the invoice read through the member's RLS client pinned to the
 * session org, the outbound quota, doc.pay (never a hand-built pay URL), and the real
 * member as the actor. Collaborators are faked; the route's own decisions are under test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const ORG = '11111111-1111-1111-1111-111111111111';
const INV = '33333333-3333-4333-8333-333333333333';
const LOC = '44444444-4444-4444-8444-444444444444';

const eqCalls: Array<[string, unknown]> = [];
let invoiceRow: Record<string, unknown> | null = null;
const supabase = {
  from: (table: string) => {
    expect(table).toBe('invoices');
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => { eqCalls.push([c, v]); return q; },
      maybeSingle: async () => ({ data: invoiceRow, error: null }),
    };
    return q;
  },
};

vi.mock('@/lib/api-handler', () => ({
  apiHandler: (schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } }, handler: (b: unknown, ctx: unknown) => Promise<Response>) =>
    async (req: Request) => {
      const parsed = schema.safeParse(await req.json());
      if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 422 });
      return handler(parsed.data, { userId: 'user_1', orgId: ORG, supabase });
    },
}));

const requirePermission = vi.fn();
vi.mock('@/lib/rbac/require-permission', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));

const send = vi.fn();
vi.mock('@/lib/email/provider', async () => {
  const actual = await vi.importActual<typeof import('@/lib/email/provider')>('@/lib/email/provider');
  return { ...actual, resolveEmailProvider: () => ({ id: 'resend', send }), resolveFromAddress: () => 'billing@acme.test' };
});

const consumeSendQuota = vi.fn();
vi.mock('@/lib/email/send-quota', () => ({ consumeSendQuota: (...a: unknown[]) => consumeSendQuota(...a) }));

const doc = {
  id: INV, invoice_number: '1001', due_date: '2026-01-01', entity: { name: 'Acme Co' },
  customer: { name: 'Bob', email: 'bob@example.com' }, cc_emails: ['ap@example.com'], customer_cc_emails: [],
  pay: { url: 'https://app.test/pay/resolved-token', payable: true },
};
const loadInvoiceDocById = vi.fn();
vi.mock('@/lib/invoices/invoice-doc', () => ({ loadInvoiceDocById: (...a: unknown[]) => loadInvoiceDocById(...a) }));
vi.mock('@/lib/invoices/invoice-email', () => ({
  buildInvoiceEmail: (d: { pay: { url: string; payable: boolean } }) => ({ subject: 's', html: `<a href="${d.pay.url}">Pay</a>`, text: 't', hasPayButton: d.pay.payable }),
}));
vi.mock('@/lib/invoices/invoice-pdf', () => ({ InvoicePdf: () => null }));
vi.mock('@react-pdf/renderer', () => ({ renderToBuffer: async () => Buffer.from('pdf') }));
const recordInvoiceEvent = vi.fn(async () => undefined);
vi.mock('@/lib/invoices/invoice-events', () => ({ recordInvoiceEvent: (...a: unknown[]) => recordInvoiceEvent(...(a as [])) }));
const logHumanAction = vi.fn(async () => undefined);
vi.mock('@/lib/trust/action-log', () => ({ logHumanAction: (...a: unknown[]) => logHumanAction(...(a as [])) }));
vi.mock('@/lib/supabase/server', () => ({ createAdminSupabase: () => ({}) }));

import { POST } from './route';

const call = (body: unknown = { tier: 'MANUAL' }) =>
  POST(new Request(`http://localhost/api/invoices/${INV}/remind`, { method: 'POST', body: JSON.stringify(body) }), { params: { id: INV } });

beforeEach(() => {
  eqCalls.length = 0;
  invoiceRow = { id: INV, location_id: LOC, status: 'SENT', balance_cents: 50_000 };
  requirePermission.mockReset().mockResolvedValue({ ok: true, role: 'bookkeeper', orgId: ORG });
  send.mockReset().mockResolvedValue({ id: 'msg_1', provider: 'resend' });
  consumeSendQuota.mockReset().mockResolvedValue({ ok: true, userCount: 2, orgCount: 2 });
  loadInvoiceDocById.mockReset().mockResolvedValue(doc);
  recordInvoiceEvent.mockClear();
  logHumanAction.mockClear();
});

describe('POST /api/invoices/[id]/remind', () => {
  it('reads the invoice pinned to the SESSION org and 404s one the member cannot see', async () => {
    invoiceRow = null;
    const res = await call();
    expect(res.status).toBe(404);
    expect(eqCalls).toContainEqual(['org_id', ORG]);
    expect(send).not.toHaveBeenCalled();
    expect(requirePermission).not.toHaveBeenCalled();
  });

  it('requires invoices:create on the invoice\'s client', async () => {
    requirePermission.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) });
    const res = await call();
    expect(res.status).toBe(403);
    expect(requirePermission).toHaveBeenCalledWith('user_1', 'invoices', 'create', { locationId: LOC });
    expect(send).not.toHaveBeenCalled();
  });

  it('sends with the resolved pay link, meters the quota, and records the real member', async () => {
    const res = await call();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ sent: true, pay_url: 'https://app.test/pay/resolved-token', payable: true });
    expect(consumeSendQuota).toHaveBeenCalledWith(ORG, 'user_1', 2, 'invoice_remind');
    expect(loadInvoiceDocById).toHaveBeenCalledWith(supabase, ORG, INV);
    const msg = send.mock.calls[0][0] as { to: string[]; cc: string[]; html: string };
    expect(msg.to).toEqual(['bob@example.com']);
    expect(msg.cc).toEqual(['ap@example.com']);
    expect(msg.html).toContain('resolved-token');
    expect(recordInvoiceEvent).toHaveBeenCalledWith(supabase, expect.objectContaining({ orgId: ORG, type: 'REMINDER_SENT', actor: 'user_1' }));
    expect(logHumanAction).toHaveBeenCalled();
  });

  it('no pay link when the invoice is not payable online', async () => {
    loadInvoiceDocById.mockResolvedValue({ ...doc, pay: { url: '', payable: false } });
    const body = await (await call()).json();
    expect(body).toMatchObject({ sent: true, pay_url: null, payable: false });
  });

  it('refuses over the outbound quota without sending', async () => {
    consumeSendQuota.mockResolvedValue({ ok: false, status: 429, code: 'SEND_QUOTA_USER', error: 'limit', retryAfterSec: 60 });
    const res = await call();
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(send).not.toHaveBeenCalled();
    expect(recordInvoiceEvent).not.toHaveBeenCalled();
  });

  it('refuses a paid invoice and a malformed tier', async () => {
    invoiceRow = { id: INV, location_id: LOC, status: 'PAID', balance_cents: 0 };
    expect((await call()).status).toBe(422);
    invoiceRow = { id: INV, location_id: LOC, status: 'SENT', balance_cents: 1 };
    expect((await call({ tier: 'x\r\ny' })).status).toBe(422);
    expect(send).not.toHaveBeenCalled();
  });
});
