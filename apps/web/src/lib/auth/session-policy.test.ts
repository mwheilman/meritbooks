import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SECURITY_POLICY,
  evaluateSessionPolicy,
  ipInCidr,
  isSessionPolicyError,
  isValidCidr,
  normalizeSecurityPolicy,
  policyLoosenings,
  type SecurityPolicy,
  type SessionFacts,
} from './session-policy';
import { clientIpFrom } from './client-ip';

const now = new Date('2026-10-20T12:00:00Z');
const facts = (f: Partial<SessionFacts> = {}): SessionFacts => ({
  factorVerificationAge: [3, -1], sessionCreatedAt: new Date(now.getTime() - 3_600_000),
  lastActiveAt: new Date(now.getTime() - 60_000), clientIp: '203.0.113.7', now, ...f,
});
const pol = (p: Partial<SecurityPolicy>): SecurityPolicy => ({ ...DEFAULT_SECURITY_POLICY, ...p });

describe('session policy — off by default (fail open, visibly)', () => {
  it('policy off → allowed with the policy_off warning, even with no Clerk facts', () => {
    const d = evaluateSessionPolicy(DEFAULT_SECURITY_POLICY, [], facts({ factorVerificationAge: null }), 'money_release');
    expect(d).toEqual({ ok: true, warnings: ['policy_off'] });
  });

  it('normalize: junk → off; out-of-range values clamped', () => {
    expect(normalizeSecurityPolicy('x')).toEqual(DEFAULT_SECURITY_POLICY);
    expect(normalizeSecurityPolicy({ default_step_up_minutes: 9999, session_max_hours: 0, mfa_all_staff: 'yes' }))
      .toEqual({ ...DEFAULT_SECURITY_POLICY, default_step_up_minutes: 240 });
  });
});

describe('session policy — step-up', () => {
  const p = pol({ default_step_up_minutes: 10 });
  it('a first factor verified within the window passes', () => {
    expect(evaluateSessionPolicy(p, [], facts({ factorVerificationAge: [3, -1] }), 'money_release').ok).toBe(true);
  });
  it('a stale verification → STEP_UP_REQUIRED with a Clerk reverification config', () => {
    const d = evaluateSessionPolicy(p, [], facts({ factorVerificationAge: [45, -1] }), 'money_release');
    expect(d).toMatchObject({ ok: false, code: 'STEP_UP_REQUIRED', obligation: 'step_up', reverification: { level: 'first_factor', afterMinutes: 10 } });
  });
  it('policy ON but Clerk sent no factor-verification claim → FAIL CLOSED', () => {
    const d = evaluateSessionPolicy(p, [], facts({ factorVerificationAge: null }), 'bank_details_edit');
    expect(d).toMatchObject({ ok: false, code: 'POLICY_UNVERIFIABLE', obligation: 'step_up' });
  });
});

describe('session policy — MFA for all staff', () => {
  const p = pol({ mfa_all_staff: true, default_step_up_minutes: 10 });
  it('no second factor this session → MFA_REQUIRED', () => {
    expect(evaluateSessionPolicy(p, [], facts({ factorVerificationAge: [1, -1] }), 'money_release'))
      .toMatchObject({ ok: false, code: 'MFA_REQUIRED', obligation: 'mfa_enroll' });
  });
  it('second factor verified recently → allowed; stale → step-up at second_factor level', () => {
    expect(evaluateSessionPolicy(p, [], facts({ factorVerificationAge: [1, 2] }), 'money_release').ok).toBe(true);
    expect(evaluateSessionPolicy(p, [], facts({ factorVerificationAge: [1, 30] }), 'money_release'))
      .toMatchObject({ ok: false, code: 'STEP_UP_REQUIRED', reverification: { level: 'second_factor', afterMinutes: 10 } });
  });
});

describe('session policy — session age, idle, IP allowlist', () => {
  it('session older than the max → SESSION_EXPIRED; unknown age → fail closed', () => {
    const p = pol({ session_max_hours: 1 });
    expect(evaluateSessionPolicy(p, [], facts({ sessionCreatedAt: new Date(now.getTime() - 2 * 3_600_000) }), 'money_release'))
      .toMatchObject({ ok: false, code: 'SESSION_EXPIRED' });
    expect(evaluateSessionPolicy(p, [], facts({ sessionCreatedAt: null }), 'money_release'))
      .toMatchObject({ ok: false, code: 'POLICY_UNVERIFIABLE' });
  });
  it('idle longer than the timeout → IDLE_TIMEOUT', () => {
    expect(evaluateSessionPolicy(pol({ idle_timeout_minutes: 15 }), [], facts({ lastActiveAt: new Date(now.getTime() - 3_600_000) }), 'money_release'))
      .toMatchObject({ ok: false, code: 'IDLE_TIMEOUT' });
  });
  it('IP allowlist: inside passes, outside blocked, unknown IP fails closed', () => {
    const p = pol({ ip_allowlist_enforced: true });
    expect(evaluateSessionPolicy(p, ['203.0.113.0/24'], facts(), 'money_release').ok).toBe(true);
    expect(evaluateSessionPolicy(p, ['198.51.100.0/24'], facts(), 'money_release')).toMatchObject({ ok: false, code: 'IP_NOT_ALLOWED' });
    expect(evaluateSessionPolicy(p, ['198.51.100.0/24'], facts({ clientIp: null }), 'money_release')).toMatchObject({ ok: false, code: 'POLICY_UNVERIFIABLE' });
  });
  it('CIDR matching covers IPv4, IPv6 and IPv4-mapped IPv6', () => {
    expect(ipInCidr('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(ipInCidr('11.1.2.3', '10.0.0.0/8')).toBe(false);
    expect(ipInCidr('2001:db8::1', '2001:db8::/32')).toBe(true);
    expect(ipInCidr('2001:db9::1', '2001:db8::/32')).toBe(false);
    expect(ipInCidr('::ffff:203.0.113.9', '203.0.113.0/24')).toBe(true);
    expect(ipInCidr('203.0.113.9', '203.0.113.9')).toBe(true);
    expect(isValidCidr('10.0.0.0/33')).toBe(false);
    expect(isValidCidr('nope')).toBe(false);
  });
  it('isSessionPolicyError recognises the structured denial body', () => {
    expect(isSessionPolicyError({ code: 'STEP_UP_REQUIRED', obligation: 'step_up', error: 'x' })).toBe(true);
    expect(isSessionPolicyError({ code: 'FORBIDDEN' })).toBe(false);
  });
});

describe('wave 2G — policyLoosenings (relaxing needs a session that meets the current policy)', () => {
  const strict = pol({ mfa_all_staff: true, default_step_up_minutes: 15, session_max_hours: 12, idle_timeout_minutes: 30, ip_allowlist_enforced: true });
  const cidrs = ['10.0.0.0/8'];

  it('no change and pure tightening are not loosening', () => {
    expect(policyLoosenings(strict, cidrs, strict, cidrs)).toEqual([]);
    expect(policyLoosenings(pol({}), [], strict, cidrs)).toEqual([]);
    expect(policyLoosenings(strict, cidrs, pol({ ...strict, default_step_up_minutes: 5, session_max_hours: 4, idle_timeout_minutes: 10 }), cidrs)).toEqual([]);
    // narrowing the allowlist (a subnet of an allowed network, or removing one) tightens
    expect(policyLoosenings(strict, ['10.0.0.0/8', '192.168.0.0/16'], strict, ['10.1.0.0/16'])).toEqual([]);
  });

  it('flags every relaxation', () => {
    expect(policyLoosenings(strict, cidrs, pol({ ...strict, mfa_all_staff: false }), cidrs)).toEqual(['two-factor requirement turned off']);
    expect(policyLoosenings(strict, cidrs, pol({ ...strict, default_step_up_minutes: 0 }), cidrs)).toEqual(['re-verification turned off']);
    expect(policyLoosenings(strict, cidrs, pol({ ...strict, default_step_up_minutes: 60 }), cidrs)).toEqual(['re-verification window lengthened']);
    expect(policyLoosenings(strict, cidrs, pol({ ...strict, session_max_hours: null }), cidrs)).toEqual(['session age limit removed']);
    expect(policyLoosenings(strict, cidrs, pol({ ...strict, idle_timeout_minutes: 60 }), cidrs)).toEqual(['idle timeout raised']);
    expect(policyLoosenings(strict, cidrs, pol({ ...strict, ip_allowlist_enforced: false }), cidrs)).toEqual(['IP allowlist turned off']);
    expect(policyLoosenings(strict, cidrs, strict, [...cidrs, '203.0.113.0/24'])).toEqual(['networks added to the IP allowlist']);
    expect(policyLoosenings(strict, ['10.1.0.0/16'], strict, ['10.0.0.0/8'])).toEqual(['networks added to the IP allowlist']);
  });
});

describe('wave 2G — clientIpFrom trusts only platform-set headers', () => {
  const h = (m: Record<string, string>) => (n: string) => m[n] ?? null;
  it('prefers x-vercel-forwarded-for, then x-real-ip', () => {
    expect(clientIpFrom(h({ 'x-vercel-forwarded-for': '198.51.100.9', 'x-real-ip': '10.0.0.1', 'x-forwarded-for': '1.2.3.4' }))).toBe('198.51.100.9');
    expect(clientIpFrom(h({ 'x-real-ip': '10.0.0.1', 'x-forwarded-for': '1.2.3.4' }))).toBe('10.0.0.1');
  });
  it('never uses the client-controlled first x-forwarded-for hop', () => {
    expect(clientIpFrom(h({ 'x-forwarded-for': '10.0.0.5, 203.0.113.7' }))).toBeNull();
  });
});
