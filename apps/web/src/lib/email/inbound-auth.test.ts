import { describe, it, expect } from 'vitest';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { ipAllowed, preVerifyInboundHeaders, safeEqual, signGeneric, verifyInboundRequest } from './inbound-auth';
import { readInboundConfig, inboundSetupStatus, aliasAddress, type InboundEnv } from './inbound-config';

const SECRET = 's3cret-webhook-password-123';
const body = Buffer.from('{"From":"a@b.test"}');

function headers(h: Record<string, string>): Headers {
  return new Headers(h);
}
function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}
function cfg(env: InboundEnv) {
  return readInboundConfig(env);
}

describe('postmark — Basic auth, fail closed', () => {
  const pm = cfg({ INBOUND_EMAIL_PROVIDER: 'postmark', INBOUND_EMAIL_SECRET: SECRET });

  it('accepts the right user + password', () => {
    expect(verifyInboundRequest({ cfg: pm, headers: headers({ authorization: basic('meritbooks', SECRET) }), rawBody: body, ip: null })).toEqual({ ok: true, method: 'basic' });
  });
  it('rejects a wrong password, a wrong user, no header, and a bare shared-secret header', () => {
    const attempts: Array<Record<string, string>> = [
      { authorization: basic('meritbooks', 'nope') },
      { authorization: basic('admin', SECRET) },
      {},
      { 'x-inbound-email-secret': SECRET },
      { authorization: `Bearer ${SECRET}` },
    ];
    for (const h of attempts) {
      expect(verifyInboundRequest({ cfg: pm, headers: headers(h), rawBody: body, ip: null }).ok).toBe(false);
    }
  });
  it('rejects EVERYTHING when the secret is not set', () => {
    const off = cfg({ INBOUND_EMAIL_PROVIDER: 'postmark' });
    expect(verifyInboundRequest({ cfg: off, headers: headers({ authorization: basic('meritbooks', '') }), rawBody: body, ip: null })).toEqual({ ok: false, reason: 'not_configured' });
  });
  it('honours the custom basic-auth user name', () => {
    const c = cfg({ INBOUND_EMAIL_PROVIDER: 'postmark', INBOUND_EMAIL_SECRET: SECRET, INBOUND_EMAIL_BASIC_USER: 'hooks' });
    expect(verifyInboundRequest({ cfg: c, headers: headers({ authorization: basic('hooks', SECRET) }), rawBody: body, ip: null }).ok).toBe(true);
  });
  it('the optional IP allowlist is enforced before credentials', () => {
    const c = cfg({ INBOUND_EMAIL_PROVIDER: 'postmark', INBOUND_EMAIL_SECRET: SECRET, INBOUND_EMAIL_ALLOWED_IPS: '3.134.147.250, 50.31.156.0/24' });
    const h = headers({ authorization: basic('meritbooks', SECRET) });
    expect(verifyInboundRequest({ cfg: c, headers: h, rawBody: body, ip: '50.31.156.6' }).ok).toBe(true);
    expect(verifyInboundRequest({ cfg: c, headers: h, rawBody: body, ip: '3.134.147.250' }).ok).toBe(true);
    expect(verifyInboundRequest({ cfg: c, headers: h, rawBody: body, ip: '9.9.9.9' })).toEqual({ ok: false, reason: 'ip_not_allowed' });
    expect(verifyInboundRequest({ cfg: c, headers: h, rawBody: body, ip: null }).ok).toBe(false);
  });
});

describe('generic — HMAC or shared secret', () => {
  const g = cfg({ INBOUND_EMAIL_PROVIDER: 'generic', INBOUND_EMAIL_SECRET: SECRET });
  const now = new Date('2026-10-23T12:00:00Z');
  const ts = String(Math.floor(now.getTime() / 1000));

  it('accepts a valid HMAC (with or without the sha256= prefix)', () => {
    const sig = signGeneric(SECRET, ts, body);
    expect(verifyInboundRequest({ cfg: g, headers: headers({ 'x-inbound-signature': sig, 'x-inbound-timestamp': ts }), rawBody: body, ip: null, now })).toEqual({ ok: true, method: 'hmac' });
    expect(verifyInboundRequest({ cfg: g, headers: headers({ 'x-inbound-signature': `sha256=${sig}`, 'x-inbound-timestamp': ts }), rawBody: body, ip: null, now }).ok).toBe(true);
  });
  it('rejects a tampered body, a stale timestamp, and a wrong key', () => {
    const sig = signGeneric(SECRET, ts, body);
    expect(verifyInboundRequest({ cfg: g, headers: headers({ 'x-inbound-signature': sig, 'x-inbound-timestamp': ts }), rawBody: Buffer.from('{"From":"evil"}'), ip: null, now }).ok).toBe(false);
    const old = String(Number(ts) - 600);
    expect(verifyInboundRequest({ cfg: g, headers: headers({ 'x-inbound-signature': signGeneric(SECRET, old, body), 'x-inbound-timestamp': old }), rawBody: body, ip: null, now })).toEqual({ ok: false, reason: 'stale_timestamp' });
    expect(verifyInboundRequest({ cfg: g, headers: headers({ 'x-inbound-signature': signGeneric('other-key-xxxxxxxx', ts, body), 'x-inbound-timestamp': ts }), rawBody: body, ip: null, now }).ok).toBe(false);
  });
  it('still accepts the pre-2D shared-secret header and Bearer', () => {
    expect(verifyInboundRequest({ cfg: g, headers: headers({ 'x-inbound-email-secret': SECRET }), rawBody: body, ip: null }).ok).toBe(true);
    expect(verifyInboundRequest({ cfg: g, headers: headers({ authorization: `Bearer ${SECRET}` }), rawBody: body, ip: null }).ok).toBe(true);
    expect(verifyInboundRequest({ cfg: g, headers: headers({ 'x-inbound-email-secret': 'wrong' }), rawBody: body, ip: null }).ok).toBe(false);
  });
});

describe('sendgrid — ECDSA signature over timestamp + raw body', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const sg = cfg({ INBOUND_EMAIL_PROVIDER: 'sendgrid', SENDGRID_INBOUND_PUBLIC_KEY: pub });
  const ts = '1761220800';
  const now = new Date(Number(ts) * 1000 + 30_000); // 30 s after signing
  const raw = Buffer.from('--b\r\nContent-Disposition: form-data; name="from"\r\n\r\na@b.test\r\n--b--');
  const sign = (data: Buffer) => {
    const s = createSign('sha256');
    s.update(data);
    return s.sign(privateKey).toString('base64');
  };

  it('accepts a valid signature', () => {
    const sig = sign(Buffer.concat([Buffer.from(ts), raw]));
    expect(verifyInboundRequest({ cfg: sg, headers: headers({ 'x-twilio-email-event-webhook-signature': sig, 'x-twilio-email-event-webhook-timestamp': ts }), rawBody: raw, ip: null, now })).toEqual({ ok: true, method: 'ecdsa' });
  });
  it('rejects a VALID signature outside the ±5 minute window (replay)', () => {
    const sig = sign(Buffer.concat([Buffer.from(ts), raw]));
    const h = headers({ 'x-twilio-email-event-webhook-signature': sig, 'x-twilio-email-event-webhook-timestamp': ts });
    expect(verifyInboundRequest({ cfg: sg, headers: h, rawBody: raw, ip: null, now: new Date(Number(ts) * 1000 + 301_000) })).toEqual({ ok: false, reason: 'stale_timestamp' });
    expect(verifyInboundRequest({ cfg: sg, headers: h, rawBody: raw, ip: null, now: new Date(Number(ts) * 1000 - 301_000) })).toEqual({ ok: false, reason: 'stale_timestamp' });
    expect(preVerifyInboundHeaders({ cfg: sg, headers: h, ip: null, now: new Date(Number(ts) * 1000 + 3_600_000) })).toEqual({ ok: false, reason: 'stale_timestamp' });
    expect(preVerifyInboundHeaders({ cfg: sg, headers: h, ip: null, now })).toBeNull();
  });
  it('rejects a tampered body, a changed timestamp, missing headers', () => {
    const sig = sign(Buffer.concat([Buffer.from(ts), raw]));
    expect(verifyInboundRequest({ cfg: sg, headers: headers({ 'x-twilio-email-event-webhook-signature': sig, 'x-twilio-email-event-webhook-timestamp': ts }), rawBody: Buffer.concat([raw, Buffer.from('x')]), ip: null }).ok).toBe(false);
    expect(verifyInboundRequest({ cfg: sg, headers: headers({ 'x-twilio-email-event-webhook-signature': sig, 'x-twilio-email-event-webhook-timestamp': '1' }), rawBody: raw, ip: null }).ok).toBe(false);
    expect(verifyInboundRequest({ cfg: sg, headers: headers({}), rawBody: raw, ip: null })).toEqual({ ok: false, reason: 'missing_signature' });
  });
  it('without a key: Basic auth with the secret, else fail closed', () => {
    const basicOnly = cfg({ INBOUND_EMAIL_PROVIDER: 'sendgrid', INBOUND_EMAIL_SECRET: SECRET });
    expect(verifyInboundRequest({ cfg: basicOnly, headers: headers({ authorization: basic('meritbooks', SECRET) }), rawBody: raw, ip: null }).ok).toBe(true);
    expect(verifyInboundRequest({ cfg: cfg({ INBOUND_EMAIL_PROVIDER: 'sendgrid' }), headers: headers({ authorization: basic('meritbooks', '') }), rawBody: raw, ip: null }).ok).toBe(false);
  });
});

describe('short secrets and header-only pre-checks', () => {
  it('a shared secret under 16 characters is treated as not configured (every provider)', () => {
    for (const provider of ['postmark', 'generic', 'sendgrid'] as const) {
      const c = cfg({ INBOUND_EMAIL_PROVIDER: provider, INBOUND_EMAIL_SECRET: 'short-secret' });
      const h = headers({ authorization: basic('meritbooks', 'short-secret'), 'x-inbound-email-secret': 'short-secret' });
      expect(verifyInboundRequest({ cfg: c, headers: h, rawBody: body, ip: null })).toEqual({ ok: false, reason: 'not_configured' });
      expect(preVerifyInboundHeaders({ cfg: c, headers: h, ip: null })).toEqual({ ok: false, reason: 'not_configured' });
    }
  });
  it('IP allowlist and Basic auth are decided from headers alone (before the body is read)', () => {
    const c = cfg({ INBOUND_EMAIL_PROVIDER: 'postmark', INBOUND_EMAIL_SECRET: SECRET, INBOUND_EMAIL_ALLOWED_IPS: '50.31.156.0/24' });
    expect(preVerifyInboundHeaders({ cfg: c, headers: headers({ authorization: basic('meritbooks', SECRET) }), ip: '9.9.9.9' })).toEqual({ ok: false, reason: 'ip_not_allowed' });
    expect(preVerifyInboundHeaders({ cfg: c, headers: headers({ authorization: basic('meritbooks', 'nope') }), ip: '50.31.156.6' })).toEqual({ ok: false, reason: 'bad_credentials' });
    expect(preVerifyInboundHeaders({ cfg: c, headers: headers({ authorization: basic('meritbooks', SECRET) }), ip: '50.31.156.6' })).toBeNull();
    const g = cfg({ INBOUND_EMAIL_PROVIDER: 'generic', INBOUND_EMAIL_SECRET: SECRET });
    expect(preVerifyInboundHeaders({ cfg: g, headers: headers({}), ip: null })).toEqual({ ok: false, reason: 'bad_credentials' });
  });
});

describe('helpers + setup status', () => {
  it('safeEqual / ipAllowed', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(ipAllowed('10.0.0.5', [])).toBe(true);
    expect(ipAllowed('::ffff:10.0.0.5', ['10.0.0.0/8'])).toBe(true);
    expect(ipAllowed('11.0.0.5', ['10.0.0.0/8'])).toBe(false);
  });
  it('"Active" needs the domain AND a usable credential; missing items are spelled out', () => {
    expect(inboundSetupStatus(cfg({})).state).toBe('not_configured');
    expect(inboundSetupStatus(cfg({})).missing).toHaveLength(2);
    expect(inboundSetupStatus(cfg({ INBOUND_EMAIL_DOMAIN: 'inbound.meritbooks.app', INBOUND_EMAIL_SECRET: 'short' })).state).toBe('not_configured');
    const ok = inboundSetupStatus(cfg({ INBOUND_EMAIL_DOMAIN: 'Inbound.MeritBooks.app', INBOUND_EMAIL_SECRET: SECRET }));
    expect(ok).toMatchObject({ state: 'active', domain: 'inbound.meritbooks.app', provider: 'postmark', mxHost: 'inbound.postmarkapp.com', missing: [] });
  });
  it('addresses use the configured domain, else the default', () => {
    expect(aliasAddress('ap-heritage', null, cfg({}))).toBe('ap-heritage@inbound.meritbooks.app');
    expect(aliasAddress('ap-heritage', null, cfg({ INBOUND_EMAIL_DOMAIN: 'mail.acme.test' }))).toBe('ap-heritage@mail.acme.test');
    expect(aliasAddress('ap-heritage', 'bills.custom.test', cfg({}))).toBe('ap-heritage@bills.custom.test');
  });
});
