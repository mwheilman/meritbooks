import { describe, expect, it } from 'vitest';
import { paymentsMode, plaidMode, stripeCanCharge, stripeConnectionEnv, stripeKeyMode, stripeMode } from './payments-mode';

const TEST = { STRIPE_SECRET_KEY: 'sk_test_abc', NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_abc', STRIPE_WEBHOOK_SECRET: 'whsec_1', STRIPE_WEBHOOK_SECRET_CONNECT: 'whsec_2' };
const LIVE = { STRIPE_SECRET_KEY: 'sk_live_abc', NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_live_abc', STRIPE_WEBHOOK_SECRET: 'whsec_1' };

describe('Stripe mode is derived from the key, never hard-coded (FPB §17.1)', () => {
  it('reads the prefix of secret, restricted and publishable keys', () => {
    expect(stripeKeyMode('sk_live_x')).toBe('live');
    expect(stripeKeyMode('rk_live_x')).toBe('live');
    expect(stripeKeyMode('pk_live_x')).toBe('live');
    expect(stripeKeyMode('sk_test_x')).toBe('test');
    expect(stripeKeyMode('rk_test_x')).toBe('test');
    expect(stripeKeyMode(' pk_test_x ')).toBe('test');
    expect(stripeKeyMode('whsec_x')).toBeNull();
    expect(stripeKeyMode('')).toBeNull();
    expect(stripeKeyMode(undefined)).toBeNull();
  });

  it('test keys → test mode, never live', () => {
    const m = stripeMode(TEST);
    expect(m).toMatchObject({ state: 'ready', mode: 'test', isLive: false, problem: null, webhookConfigured: true, connectWebhookConfigured: true });
    expect(stripeConnectionEnv(TEST)).toBe('test');
    expect(stripeCanCharge(TEST)).toBe(true);
  });

  it('live secret + live publishable → live', () => {
    const m = stripeMode(LIVE);
    expect(m).toMatchObject({ state: 'ready', mode: 'live', isLive: true, connectWebhookConfigured: false });
    expect(stripeConnectionEnv(LIVE)).toBe('live');
  });

  it('a live secret with a test publishable key is misconfigured: not live, cannot charge', () => {
    const env = { STRIPE_SECRET_KEY: 'sk_live_abc', NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_abc' };
    const m = stripeMode(env);
    expect(m.state).toBe('misconfigured');
    expect(m.isLive).toBe(false);
    expect(m.problem).toMatch(/do not match/);
    expect(stripeCanCharge(env)).toBe(false);
    // Reads still use the secret key's environment (status display), charging does not.
    expect(stripeConnectionEnv(env)).toBe('live');
  });

  it('missing publishable key is misconfigured', () => {
    const m = stripeMode({ STRIPE_SECRET_KEY: 'sk_test_abc' });
    expect(m.state).toBe('misconfigured');
    expect(m.problem).toMatch(/publishable key is missing/);
  });

  it('no key / an unrecognizable key → not configured, no environment, never live', () => {
    expect(stripeMode({})).toMatchObject({ state: 'not_configured', mode: null, isLive: false });
    expect(stripeConnectionEnv({})).toBeNull();
    expect(stripeMode({ STRIPE_SECRET_KEY: 'hunter2' })).toMatchObject({ state: 'unrecognized_key', isLive: false });
    expect(stripeConnectionEnv({ STRIPE_SECRET_KEY: 'hunter2' })).toBeNull();
  });

  it('problems never echo a key', () => {
    for (const env of [{}, { STRIPE_SECRET_KEY: 'sk_live_SECRET' }, { STRIPE_SECRET_KEY: 'sk_live_SECRET', NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_PUB' }]) {
      const p = stripeMode(env).problem ?? '';
      expect(p).not.toMatch(/SECRET|PUB|sk_|pk_/);
    }
  });
});

describe('Plaid environment (PLAID_ENV)', () => {
  it('production is live; sandbox / unset are test', () => {
    expect(plaidMode({ PLAID_ENV: 'production' })).toMatchObject({ env: 'production', apiEnv: 'production', connectionEnv: 'live', isLive: true, label: 'Production', warning: null });
    expect(plaidMode({ PLAID_ENV: 'sandbox' })).toMatchObject({ apiEnv: 'sandbox', connectionEnv: 'test', isLive: false, warning: null });
    expect(plaidMode({})).toMatchObject({ env: 'sandbox', apiEnv: 'sandbox', connectionEnv: 'test' });
  });

  it('development (retired by Plaid) and unknown values fall back to Sandbox with a warning', () => {
    expect(plaidMode({ PLAID_ENV: 'development' })).toMatchObject({ env: 'development', apiEnv: 'sandbox', connectionEnv: 'test', isLive: false });
    expect(plaidMode({ PLAID_ENV: 'development' }).warning).toMatch(/no longer offers/);
    expect(plaidMode({ PLAID_ENV: 'prod' }).warning).toMatch(/not recognized/);
    expect(plaidMode({ PLAID_ENV: 'PRODUCTION' }).isLive).toBe(true);
  });

  it('configured needs the client id and a secret (raw or Vault ref)', () => {
    expect(plaidMode({ PLAID_CLIENT_ID: 'c', PLAID_SECRET: 's' }).configured).toBe(true);
    expect(plaidMode({ PLAID_CLIENT_ID: 'c', PLAID_SECRET_REF: 'r' }).configured).toBe(true);
    expect(plaidMode({ PLAID_CLIENT_ID: 'c' }).configured).toBe(false);
  });

  it('paymentsMode bundles both', () => {
    const m = paymentsMode({ ...TEST, PLAID_ENV: 'production' });
    expect(m.stripe.isLive).toBe(false);
    expect(m.plaid.isLive).toBe(true);
  });
});
