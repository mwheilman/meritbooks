/**
 * InviteHelper logic (FPB-onboarding §5 / B4): the role picker only offers roles that
 * can actually run onboarding, defaults to one that can also go live, and the request
 * body / error copy are what the invitations API expects.
 */

import { describe, it, expect } from 'vitest';
import { hasPermission } from '@/lib/rbac/permissions';
import {
  onboardingCapableRoles,
  resolveDefaultRole,
  buildInviteRequest,
  inviteErrorMessage,
  isPlausibleEmail,
  DEFAULT_ONBOARDING_ROLE,
} from './invite-helper';
import { buildInvitationEmail, normalizeInviteContext, isWellFormedInviteToken, generateInviteToken, inviteEmailNotConfiguredMessage } from './invitations';

describe('onboardingCapableRoles', () => {
  it('offers only roles that pass the onboarding page gate (settings_acct:edit)', () => {
    const opts = onboardingCapableRoles();
    expect(opts.length).toBeGreaterThan(0);
    for (const o of opts) expect(hasPermission(o.role, 'settings_acct', 'edit')).toBe(true);
  });

  it('never offers Accounting Specialist (cannot run the wizard)', () => {
    expect(onboardingCapableRoles().map((o) => o.role)).not.toContain('accounting_specialist');
  });

  it('lists the bookkeeper-shaped role first and flags go-live ability truthfully', () => {
    const opts = onboardingCapableRoles();
    expect(opts[0].role).toBe('accounting_manager');
    for (const o of opts) expect(o.canGoLive).toBe(hasPermission(o.role, 'journal_entries', 'post'));
  });
});

describe('resolveDefaultRole', () => {
  it('defaults to a role that can run setup AND post the opening balances', () => {
    const role = resolveDefaultRole(undefined);
    expect(role).toBe(DEFAULT_ONBOARDING_ROLE);
    expect(hasPermission(role, 'settings_acct', 'edit')).toBe(true);
    expect(hasPermission(role, 'journal_entries', 'post')).toBe(true);
  });

  it('honours a capable requested role, and replaces an incapable one', () => {
    expect(resolveDefaultRole('cfo')).toBe('cfo');
    expect(resolveDefaultRole('accounting_specialist')).toBe(DEFAULT_ONBOARDING_ROLE);
    expect(resolveDefaultRole('not_a_role')).toBe(DEFAULT_ONBOARDING_ROLE);
  });
});

describe('buildInviteRequest', () => {
  it('scopes the invite to the company and names them its onboarding owner', () => {
    const body = buildInviteRequest({
      email: '  Pat@Books.Example ', firstName: ' Pat ', role: 'accounting_manager',
      companyId: '0f0e3e2a-1111-4c4c-9d9d-222233334444', context: ' Opening balances for Heritage Interiors ',
    });
    expect(body).toEqual({
      email: 'pat@books.example',
      firstName: 'Pat',
      role: 'accounting_manager',
      companyIds: ['0f0e3e2a-1111-4c4c-9d9d-222233334444'],
      onboardingCompanyIds: ['0f0e3e2a-1111-4c4c-9d9d-222233334444'],
      context: 'Opening balances for Heritage Interiors',
    });
  });

  it('omits company + blank first name when not given', () => {
    const body = buildInviteRequest({ email: 'a@b.co', firstName: '  ', role: 'cfo', companyId: null, context: 'Setup' });
    expect(body.companyIds).toEqual([]);
    expect(body.onboardingCompanyIds).toEqual([]);
    expect('firstName' in body).toBe(false);
  });
});

describe('error copy + email validation', () => {
  it('maps API failures to plain English', () => {
    expect(inviteErrorMessage(403, 'FORBIDDEN')).toMatch(/Company Admin/);
    expect(inviteErrorMessage(409, 'ALREADY_MEMBER')).toMatch(/already on your team/);
    expect(inviteErrorMessage(409, 'DUPLICATE_INVITE')).toMatch(/already has an invite/);
    expect(inviteErrorMessage(503, 'INVITATIONS_UNAVAILABLE')).toMatch(/switched on/);
    expect(inviteErrorMessage(500, 'X', 'boom')).toBe('boom');
  });

  it('validates emails loosely', () => {
    expect(isPlausibleEmail('pat@books.example')).toBe(true);
    expect(isPlausibleEmail('pat@books')).toBe(false);
    expect(isPlausibleEmail('')).toBe(false);
  });
});

describe('invitation email + token helpers', () => {
  it('includes the escaped context in the email when given', () => {
    const e = buildInvitationEmail({
      orgName: 'Acme', roleLabel: 'Accounting Manager', acceptUrl: 'https://x/sign-up?invite=t', email: 'p@x.co',
      context: 'Opening balances <for> Acme',
    });
    expect(e.subject).toContain('Opening balances <for> Acme');
    expect(e.html).toContain('Opening balances &lt;for&gt; Acme');
    expect(e.text).toContain('Waiting for you: Opening balances <for> Acme');
  });

  it('is unchanged without context', () => {
    const e = buildInvitationEmail({ orgName: 'Acme', roleLabel: 'CFO', acceptUrl: 'u', email: 'p@x.co' });
    expect(e.subject).toBe("You've been invited to Acme on MeritBooks");
    expect(e.html).not.toContain('Waiting for you');
  });

  it('normalizes context and validates tokens', () => {
    expect(normalizeInviteContext('  a \n b  ')).toBe('a b');
    expect(normalizeInviteContext('   ')).toBeNull();
    expect(normalizeInviteContext(42)).toBeNull();
    expect(normalizeInviteContext('x'.repeat(500))?.length).toBe(200);
    expect(isWellFormedInviteToken(generateInviteToken())).toBe(true);
    expect(isWellFormedInviteToken("abc' or 1=1")).toBe(false);
    expect(isWellFormedInviteToken(undefined)).toBe(false);
  });

  it('names exactly the missing email env vars', () => {
    expect(inviteEmailNotConfiguredMessage({ provider: true, from: true })).toContain('RESEND_API_KEY and INVOICE_FROM_EMAIL');
    expect(inviteEmailNotConfiguredMessage({ provider: false, from: true })).toContain('(INVOICE_FROM_EMAIL not set)');
  });
});
