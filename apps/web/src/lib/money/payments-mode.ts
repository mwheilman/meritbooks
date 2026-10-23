/**
 * Payments mode — derived, never hard-coded (FPB-payments-fees §17.1, audit PM-01).
 *
 * Stripe's mode is a property of the KEY the server holds, not of a constant in the
 * code: `sk_live_` / `rk_live_` / `pk_live_` = live, `sk_test_` / `rk_test_` / `pk_test_`
 * = test. The secret and publishable keys must agree — a live secret with a test
 * publishable key (or the reverse) cannot take a payment, so it is reported as
 * misconfigured and online payment is treated as OFF rather than guessed.
 *
 * Plaid's environment is `PLAID_ENV`: sandbox | development | production. Plaid retired
 * Development in 2024, so it is treated as Sandbox (with a warning); anything unknown is
 * Sandbox. Only `production` is live.
 *
 * Pure: every function takes the env map it reads (defaults to process.env), so the
 * rules are unit-tested without touching the real environment. Server-only callers;
 * nothing here returns a key.
 */

import type { ProviderEnvironment } from '@/lib/money/providers/types';

type Env = Readonly<Record<string, string | undefined>>;

export type KeyMode = 'live' | 'test';

/** The mode a Stripe key belongs to, from its prefix; null if it is not a Stripe key. */
export function stripeKeyMode(key: string | null | undefined): KeyMode | null {
  const k = (key ?? '').trim();
  if (/^(sk|rk|pk)_live_/.test(k)) return 'live';
  if (/^(sk|rk|pk)_test_/.test(k)) return 'test';
  return null;
}

export type StripeModeState =
  /** No secret key on the server. */
  | 'not_configured'
  /** A key is present but is not a recognizable Stripe key. */
  | 'unrecognized_key'
  /** Secret and publishable keys are for different modes (or the publishable key is missing). */
  | 'misconfigured'
  | 'ready';

export interface StripeMode {
  state: StripeModeState;
  /** The mode payments run in. Only set when the secret key is recognizable. */
  mode: KeyMode | null;
  /** True only when BOTH keys are live keys. The only condition under which "live" may be shown. */
  isLive: boolean;
  /** Platform + Connect webhook signing secrets present. */
  webhookConfigured: boolean;
  connectWebhookConfigured: boolean;
  /** Plain-English problem for the admin, or null. Never contains a key. */
  problem: string | null;
}

export function stripeMode(env: Env = process.env): StripeMode {
  const secret = env.STRIPE_SECRET_KEY;
  const publishable = env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  const webhookConfigured = !!env.STRIPE_WEBHOOK_SECRET;
  const connectWebhookConfigured = !!env.STRIPE_WEBHOOK_SECRET_CONNECT;
  const base = { webhookConfigured, connectWebhookConfigured };

  if (!secret) {
    return { ...base, state: 'not_configured', mode: null, isLive: false, problem: 'Stripe is not connected to MeritBooks yet. An administrator adds the Stripe keys to the server.' };
  }
  const sMode = stripeKeyMode(secret);
  if (!sMode) {
    return { ...base, state: 'unrecognized_key', mode: null, isLive: false, problem: 'The Stripe key on the server is not a recognizable Stripe secret key.' };
  }
  const pMode = stripeKeyMode(publishable);
  if (pMode !== sMode) {
    return {
      ...base,
      state: 'misconfigured',
      mode: sMode,
      isLive: false,
      problem: pMode === null
        ? 'The Stripe publishable key is missing on the server, so customers cannot open the payment form.'
        : `The Stripe keys do not match: the secret key is a ${sMode} key but the publishable key is a ${pMode} key. Online payment is off until they match.`,
    };
  }
  return { ...base, state: 'ready', mode: sMode, isLive: sMode === 'live', problem: null };
}

/** The provider_connections.environment the current Stripe key reads and writes. Null = can't operate. */
export function stripeConnectionEnv(env: Env = process.env): ProviderEnvironment | null {
  const s = stripeMode(env);
  return s.state === 'ready' || s.state === 'misconfigured' ? s.mode : null;
}

/** Can the server take a Stripe payment right now (keys present and consistent)? */
export function stripeCanCharge(env: Env = process.env): boolean {
  return stripeMode(env).state === 'ready';
}

// ── Plaid ─────────────────────────────────────────────────────────────────────

export type PlaidEnvName = 'sandbox' | 'development' | 'production';
/** The Plaid API host the adapter talks to (Development is retired → Sandbox). */
export type PlaidApiEnv = 'sandbox' | 'production';

export interface PlaidMode {
  /** What PLAID_ENV says (normalized). */
  env: PlaidEnvName;
  /** The API host actually used. */
  apiEnv: PlaidApiEnv;
  /** provider_connections.environment for Plaid rows. */
  connectionEnv: ProviderEnvironment;
  isLive: boolean;
  configured: boolean;
  /** Plain-English label for the screen. */
  label: string;
  warning: string | null;
}

export function plaidMode(env: Env = process.env): PlaidMode {
  const raw = (env.PLAID_ENV ?? '').trim().toLowerCase();
  const name: PlaidEnvName = raw === 'production' ? 'production' : raw === 'development' ? 'development' : 'sandbox';
  const apiEnv: PlaidApiEnv = name === 'production' ? 'production' : 'sandbox';
  const configured = !!env.PLAID_CLIENT_ID && (!!env.PLAID_SECRET || !!env.PLAID_SECRET_REF);
  let warning: string | null = null;
  if (name === 'development') warning = 'Plaid no longer offers a Development environment, so bank connections use Sandbox (test data).';
  else if (raw && raw !== 'sandbox' && raw !== 'production') warning = `PLAID_ENV "${raw}" is not recognized, so bank connections use Sandbox (test data).`;
  return {
    env: name,
    apiEnv,
    connectionEnv: apiEnv === 'production' ? 'live' : 'test',
    isLive: apiEnv === 'production',
    configured,
    label: apiEnv === 'production' ? 'Production' : 'Sandbox (test data)',
    warning,
  };
}

/** Both providers at once — the shape the Payments screen and the bank feed read. */
export interface PaymentsMode {
  stripe: StripeMode;
  plaid: PlaidMode;
}

export function paymentsMode(env: Env = process.env): PaymentsMode {
  return { stripe: stripeMode(env), plaid: plaidMode(env) };
}
