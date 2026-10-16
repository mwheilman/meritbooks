import { describe, it, expect } from 'vitest';
import { sandboxAllowed, assertSandboxAllowed } from './sandbox-guard';

describe('sandboxAllowed', () => {
  it('refuses by default (no opt-in)', () => {
    expect(sandboxAllowed({})).toBe(false);
    expect(sandboxAllowed({ VERCEL_ENV: 'preview' })).toBe(false);
  });
  it('refuses on the production deployment even with the opt-in', () => {
    expect(sandboxAllowed({ ALLOW_SANDBOX: '1', VERCEL_ENV: 'production' })).toBe(false);
  });
  it('refuses any opt-in value other than "1"', () => {
    expect(sandboxAllowed({ ALLOW_SANDBOX: 'true' })).toBe(false);
    expect(sandboxAllowed({ ALLOW_SANDBOX: '' })).toBe(false);
  });
  it('allows only an explicit opt-in on a non-production deployment', () => {
    expect(sandboxAllowed({ ALLOW_SANDBOX: '1' })).toBe(true);
    expect(sandboxAllowed({ ALLOW_SANDBOX: '1', VERCEL_ENV: 'preview' })).toBe(true);
  });
  it('assertSandboxAllowed throws when refused', () => {
    expect(() => assertSandboxAllowed({ ALLOW_SANDBOX: '1', VERCEL_ENV: 'production' })).toThrow(/disabled/);
    expect(() => assertSandboxAllowed({ ALLOW_SANDBOX: '1' })).not.toThrow();
  });
});
