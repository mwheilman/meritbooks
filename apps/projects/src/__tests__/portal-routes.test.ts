/**
 * Portal API routes (1118): sign-in (server key, browser nonce, cookies), same-origin writes,
 * session required, database refusals → plain HTTP, e-sign hand-off, file streaming / upload
 * guards, the magic link — against a fake database port (no network, no service role).
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));
const jar = new Map<string, string>();
const sets: { name: string; value: string; opts: Record<string, unknown> }[] = [];
vi.mock('next/headers', () => ({
  cookies: () => ({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)! } : undefined),
    set: (n: string, v: string, o: Record<string, unknown> = {}) => { sets.push({ name: n, value: v, opts: o }); if (v) jar.set(n, v); else jar.delete(n); },
  }),
  headers: () => new Headers(),
}));

import { setPortalPort, type PortalFn, type RpcResult } from '@/lib/portal/db';
import { setStoragePort } from '@/lib/portal/storage';
import { setDeliveryPorts } from '@/lib/portal/deliver';
import { mapPortalError } from '@/lib/portal/errors';
import { trustedClientIp } from '@/lib/portal/ip';
import { POST as authPOST } from '@/app/api/portal/auth/route';
import { POST as actionsPOST } from '@/app/api/portal/actions/route';
import { GET as filesGET } from '@/app/api/portal/files/route';
import { POST as uploadsPOST } from '@/app/api/portal/uploads/route';
import { GET as magicGET } from '@/app/(portal)/portal/auth/[token]/route';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const ORG = 'a0000000-0000-4000-8000-000000000001';
const ID = 'b0000000-0000-4000-8000-000000000002';
const SESSION = 'S'.repeat(43);
const calls: { fn: PortalFn; args: Record<string, unknown> }[] = [];
let answer: (fn: PortalFn, args: Record<string, unknown>) => RpcResult = () => ({ data: { ok: true }, error: null });

const post = (url: string, body: unknown, headers: Record<string, string> = {}) => new NextRequest(`https://p.test${url}`, {
  method: 'POST', headers: { host: 'p.test', origin: 'https://p.test', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

beforeEach(() => {
  jar.clear(); sets.length = 0; calls.length = 0;
  answer = () => ({ data: { ok: true }, error: null });
  setPortalPort(async (fn, args) => { calls.push({ fn, args }); return answer(fn, args); });
  process.env.PORTAL_SERVER_KEY = 'server-key-0123456789abcdef';
  process.env.PORTAL_BASE_URL = 'https://p.test';
});
const delivered: { to: string; text: string }[] = [];
beforeEach(() => {
  delivered.length = 0;
  setDeliveryPorts({
    email: { id: 'resend', send: async (m) => { delivered.push({ to: m.to, text: m.text }); return { status: 'sent', provider: 'resend', providerMessageId: 'em-1' }; } },
    sms: { id: 'twilio', send: async (m) => { delivered.push({ to: m.to, text: m.body }); return { status: 'sent', provider: 'twilio', providerMessageId: 'sm-1' }; } },
  });
});
afterEach(() => { setPortalPort(null); setStoragePort(null); setDeliveryPorts(null); delete process.env.PORTAL_SERVER_KEY; });

describe('errors', () => {
  it('maps PORTAL_* tokens to statuses with the sentence; anything else is unavailable', () => {
    expect(mapPortalError({ message: 'PORTAL_FORBIDDEN: no access to this job' })).toEqual({ status: 404, code: 'forbidden', message: 'no access to this job' });
    expect(mapPortalError({ message: 'PORTAL_VERIFY: confirm your phone number first' }).status).toBe(403);
    expect(mapPortalError({ message: 'PORTAL_AUTH: sign in again' }).code).toBe('auth');
    expect(mapPortalError({ message: 'relation "pm.x" does not exist' })).toMatchObject({ status: 503, code: 'unavailable' });
  });
});

describe('sign-in', () => {
  it('fails closed without PORTAL_SERVER_KEY', async () => {
    delete process.env.PORTAL_SERVER_KEY;
    const r = await authPOST(post('/api/portal/auth', { op: 'start', identifier: 'pat@home.test' }));
    expect(r.status).toBe(503);
    expect(calls).toEqual([]);
  });

  it('start sends only hashes of the browser nonce, sets the nonce cookie (httpOnly), never says whether the address exists', async () => {
    answer = () => ({ data: { ok: true, sent: false }, error: null });
    const r = await authPOST(post('/api/portal/auth', { op: 'start', identifier: 'nobody@x.test', locale: 'es' }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    const a = calls[0].args;
    expect(calls[0].fn).toBe('auth_start');
    const nonce = jar.get('mp_portal_n')!;
    expect(a.p_nonce_hash).toBe(sha(nonce));
    expect(JSON.stringify(a)).not.toContain(nonce);
    expect(a.p_code).toMatch(/^\d{6}$/);
    expect(a.p_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.p_base_url).toBe('https://p.test');
    expect(sets.find((s) => s.name === 'mp_portal_n')?.opts).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
  });

  it('the link and code go straight to the provider at dispatch time — the database gets hashes only, and records the outcome', async () => {
    answer = (fn) => fn === 'auth_start'
      ? { data: { ok: true, sent: true, dispatch: { outbound_id: 'o1', channel: 'email', to: 'pat@home.test', from: null, subject: 'Your sign-in code', company: 'Heritage', locale: 'en' } }, error: null }
      : { data: null, error: null };
    const r = await authPOST(post('/api/portal/auth', { op: 'start', identifier: 'pat@home.test' }));
    expect(await r.json()).toEqual({ ok: true }); // the recipient never comes back to the browser
    const start = calls[0].args;
    expect(delivered).toHaveLength(1);
    expect(delivered[0].to).toBe('pat@home.test');
    expect(delivered[0].text).toContain(`code is ${start.p_code}`);
    expect(delivered[0].text).toContain(`/portal/auth/${start.p_token}`);
    expect(calls[1]).toEqual({ fn: 'dispatch_result', args: expect.objectContaining({ p_outbound: 'o1', p_ok: true, p_provider_message_id: 'em-1' }) });
    expect(JSON.stringify(calls[1].args)).not.toContain(String(start.p_code));
  });

  it('switching company needs the current session and opens a session for the company that sent the new code', async () => {
    expect((await authPOST(post('/api/portal/auth', { op: 'switch', orgId: ORG }))).status).toBe(401);
    jar.set('mp_portal', SESSION);
    answer = () => ({ data: { ok: true, sent: false }, error: null });
    expect((await authPOST(post('/api/portal/auth', { op: 'switch', orgId: ORG }))).status).toBe(200);
    expect(calls.at(-1)).toEqual({ fn: 'auth_switch', args: expect.objectContaining({ p_session: SESSION, p_org: ORG }) });
    answer = () => ({ data: { ok: true, reason: null, org_id: ORG }, error: null });
    const v = await authPOST(post('/api/portal/auth', { op: 'verify_switch', code: '222222' }));
    expect(await v.json()).toMatchObject({ ok: true, orgId: ORG });
    expect(calls.at(-1)!.fn).toBe('auth_verify_switch');
    expect(jar.get('mp_portal')).not.toBe(SESSION);
  });

  it('answers at once and the same way with or without access (no timing oracle); the work runs after the response', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    setPortalPort(async (fn, args) => { calls.push({ fn, args }); await gate; return { data: { ok: false, reason: 'rate_limited' }, error: null }; });
    const r = await authPOST(post('/api/portal/auth', { op: 'start', identifier: 'pat@home.test' }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true }); // returned while the database call is still pending
    release();
    await new Promise((x) => setTimeout(x, 0));
    expect(calls.map((c) => c.fn)).toEqual(['auth_start']);
    expect(delivered).toEqual([]);
    // a malformed address is refused up front, before any database work
    expect((await authPOST(post('/api/portal/auth', { op: 'start', identifier: 'not an address' }))).status).toBe(422);
  });

  it('the per-IP limits use the platform IP, never the client-written leftmost x-forwarded-for', () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(trustedClientIp({ headers: h({ 'x-forwarded-for': '6.6.6.6, 10.0.0.1', 'x-vercel-forwarded-for': '10.1.2.3' }) })).toBe('10.1.2.3');
    expect(trustedClientIp({ headers: h({ 'x-forwarded-for': '6.6.6.6' }), ip: '10.4.4.4' })).toBe('10.4.4.4');
    expect(trustedClientIp({ headers: h({ 'x-forwarded-for': '6.6.6.6' }) })).toBeNull();
  });

  it('refuses writes from another origin (CSRF)', async () => {
    const r = await authPOST(post('/api/portal/auth', { op: 'start', identifier: 'pat@home.test' }, { origin: 'https://evil.test' }));
    expect(r.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('verify needs this browser’s nonce; a session cookie is set only when the database opens one', async () => {
    expect((await authPOST(post('/api/portal/auth', { op: 'verify', identifier: 'pat@home.test', code: '123456' }))).status).toBe(422);
    jar.set('mp_portal_n', 'N'.repeat(43));
    answer = () => ({ data: { ok: false, reason: 'wrong_code' }, error: null });
    const bad = await authPOST(post('/api/portal/auth', { op: 'verify', identifier: 'pat@home.test', code: '123456' }));
    expect(bad.status).toBe(422);
    expect((await bad.json()).reason).toBe('wrong_code');
    expect(jar.has('mp_portal')).toBe(false);
    answer = () => ({ data: { ok: true, reason: null, locale: 'en' }, error: null });
    const ok = await authPOST(post('/api/portal/auth', { op: 'verify', identifier: 'pat@home.test', code: '123456' }));
    expect(ok.status).toBe(200);
    const session = jar.get('mp_portal')!;
    expect(calls.at(-1)!.args.p_session_hash).toBe(sha(session));
    expect(calls.at(-1)!.args.p_nonce).toBe('N'.repeat(43));
    expect(calls.at(-1)!.args.p_server_key).toBe('server-key-0123456789abcdef');
    expect(sets.find((s) => s.name === 'mp_portal')?.opts).toMatchObject({ httpOnly: true, maxAge: 60 * 60 * 24 * 30 });
  });
});

describe('actions', () => {
  it('no session → 401; bad body → 422', async () => {
    expect((await actionsPOST(post('/api/portal/actions', { op: 'sign', orgId: ORG, signerId: ID }))).status).toBe(401);
    jar.set('mp_portal', SESSION);
    expect((await actionsPOST(post('/api/portal/actions', { op: 'decide', orgId: ORG, kind: 'estimate', id: ID, decision: 'approved', typedName: 'Pat' }))).status).toBe(422); // no consent
    expect(calls).toEqual([]);
  });

  it('decide passes the session, the typed name and the caller’s IP / browser for the audit trail', async () => {
    jar.set('mp_portal', SESSION);
    const r = await actionsPOST(post('/api/portal/actions', { op: 'decide', orgId: ORG, kind: 'selection', id: ID, decision: 'approved', typedName: 'Pat Smith', consent: true, optionId: ID },
      { 'x-forwarded-for': '6.6.6.6, 10.0.0.1', 'x-vercel-forwarded-for': '10.1.2.3', 'user-agent': 'phone' }));
    expect(r.status).toBe(200);
    expect(calls[0]).toEqual({ fn: 'decide', args: expect.objectContaining({ p_session: SESSION, p_org: ORG, p_kind: 'selection', p_option: ID, p_typed_name: 'Pat Smith', p_ip: '10.1.2.3', p_user_agent: 'phone' }) });
  });

  it('database refusals become plain answers (forbidden 404, verify 403)', async () => {
    jar.set('mp_portal', SESSION);
    answer = () => ({ data: null, error: { message: 'PORTAL_FORBIDDEN: no access to this conversation', code: '42501' } });
    const f = await actionsPOST(post('/api/portal/actions', { op: 'message', orgId: ORG, jobId: ID, audience: 'customer', body: 'hi' }));
    expect(f.status).toBe(404);
    expect(await f.json()).toEqual({ error: 'no access to this conversation', code: 'forbidden' });
    answer = () => ({ data: null, error: { message: 'PORTAL_VERIFY: confirm your phone number first', code: '28000' } });
    expect((await actionsPOST(post('/api/portal/actions', { op: 'accept', orgId: ORG, commitmentId: ID, typedName: 'Tia Tile', consent: true }))).status).toBe(403);
  });

  it('sign mints a one-time e-sign token: only its hash reaches the database, the page gets /sign/<token>', async () => {
    jar.set('mp_portal', SESSION);
    const r = await actionsPOST(post('/api/portal/actions', { op: 'sign', orgId: ORG, signerId: ID }));
    const body = (await r.json()) as { url: string };
    const token = body.url.replace('/sign/', '');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(calls[0].fn).toBe('esign_link');
    expect(calls[0].args.p_token_hash).toBe(sha(token));
    expect(JSON.stringify(calls[0].args)).not.toContain(token);
  });

  it('pay application lines are % complete between 0 and 1', async () => {
    jar.set('mp_portal', SESSION);
    const bad = await actionsPOST(post('/api/portal/actions', { op: 'pay_app', orgId: ORG, commitmentId: ID, periodEnd: '2026-10-31', lines: [{ line_id: ID, pct_complete: 1.5 }] }));
    expect(bad.status).toBe(422);
  });
});

describe('files', () => {
  const get = (q: string) => new NextRequest(`https://p.test/api/portal/files?${q}`, { headers: { host: 'p.test' } });
  it('streams exactly the granted object, never cached, nosniff; refuses keys outside the org', async () => {
    jar.set('mp_portal', SESSION);
    const downloads: string[] = [];
    setStoragePort({ upload: async () => true, download: async (p) => { downloads.push(p); return new TextEncoder().encode('%PDF').buffer as ArrayBuffer; } });
    answer = () => ({ data: { path: `${ORG}/pm/docs/plan.pdf`, file_name: 'plan.pdf', mime_type: 'application/pdf' }, error: null });
    const r = await filesGET(get(`orgId=${ORG}&kind=document&id=${ID}`));
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toContain('no-store');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(downloads).toEqual([`${ORG}/pm/docs/plan.pdf`]);
    answer = () => ({ data: { path: `${ID}/pm/docs/other-tenant.pdf`, file_name: 'x.pdf', mime_type: 'application/pdf' }, error: null });
    expect((await filesGET(get(`orgId=${ORG}&kind=document&id=${ID}`))).status).toBe(404);
    expect((await filesGET(get(`orgId=${ORG}&kind=../../etc&id=${ID}`))).status).toBe(404);
  });
});

describe('uploads', () => {
  const form = (file: File) => {
    const fd = new FormData();
    fd.set('orgId', ORG); fd.set('purpose', 'photo'); fd.set('file', file);
    return new NextRequest('https://p.test/api/portal/uploads', { method: 'POST', headers: { host: 'p.test', origin: 'https://p.test' }, body: fd });
  };
  it('PDF and photos only; the bytes go to the slot the database opened, then it is filed', async () => {
    jar.set('mp_portal', SESSION);
    const ups: string[] = [];
    setStoragePort({ upload: async (p) => { ups.push(p); return true; }, download: async () => null });
    expect((await uploadsPOST(form(new File(['MZ'], 'x.exe', { type: 'application/x-msdownload' })))).status).toBe(422);
    answer = (fn) => fn === 'upload_begin' ? { data: { upload_id: ID, path: `${ORG}/pm/photos/portal-${ID}.jpg` }, error: null } : { data: { document_id: ID }, error: null };
    const r = await uploadsPOST(form(new File([new Uint8Array([1, 2, 3])], 'door.jpg', { type: 'image/jpeg' })));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, documentId: ID });
    expect(ups).toEqual([`${ORG}/pm/photos/portal-${ID}.jpg`]);
    expect(calls.map((c) => c.fn)).toEqual(['upload_begin', 'upload_finish']);
  });
});

describe('the magic link', () => {
  const open = (cookie?: string) => new NextRequest(`https://p.test/portal/auth/${'T'.repeat(43)}`, { headers: { host: 'p.test', ...(cookie ? { cookie } : {}) } });
  it('another device → sign-in with the reason; same browser → 30-day session cookie and on to the portal', async () => {
    answer = () => ({ data: { ok: false, reason: 'other_device' }, error: null });
    const r1 = await magicGET(open(), { params: { token: 'T'.repeat(43) } });
    expect(r1.status).toBe(303);
    expect(r1.headers.get('location')).toBe('https://p.test/portal/sign-in?reason=other_device');
    expect(calls[0].args.p_nonce).toBeNull();
    answer = () => ({ data: { ok: true, reason: null }, error: null });
    const r2 = await magicGET(open(`mp_portal_n=${'N'.repeat(43)}`), { params: { token: 'T'.repeat(43) } });
    expect(r2.headers.get('location')).toBe('https://p.test/portal');
    expect(r2.headers.get('set-cookie')).toMatch(/mp_portal=[A-Za-z0-9_-]{43}.*HttpOnly/i);
    expect(calls[1].args.p_nonce).toBe('N'.repeat(43));
  });
  it('a malformed token never reaches the database', async () => {
    const r = await magicGET(open(), { params: { token: 'bad' } });
    expect(r.headers.get('location')).toContain('reason=invalid');
    expect(calls).toEqual([]);
  });
});
