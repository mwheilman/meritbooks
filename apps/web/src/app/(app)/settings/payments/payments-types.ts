/**
 * Response shapes of /api/payments/accounts (the contract the Payments screen renders).
 * Kept here — not imported from lib/money — so the client bundle never reaches server code.
 */

export type Readiness = 'not_connected' | 'setup_incomplete' | 'restricted' | 'ready';
export type FeePayer = 'customer' | 'company';
export type AccountMode = 'per_company' | 'single';

export interface AccountView {
  readiness: Readiness;
  readinessLabel: string;
  source: 'company' | 'tenant' | null;
  modeBadge: 'LIVE' | 'TEST' | null;
  chargesEnabled: boolean | null;
  payoutsEnabled: boolean | null;
  payoutBank: { name: string | null; last4: string } | null;
  requirementsDueCount: number;
  problem: string | null;
  checkedAt: string | null;
  hasAccount: boolean;
}

export interface CompanyOptions {
  cardEnabled: boolean;
  achEnabled: boolean;
  checkEnabled: boolean;
  cardFeePayer: FeePayer;
  achFeePayer: FeePayer;
  usingDefaults: boolean;
}

export interface CompanyRow {
  locationId: string;
  name: string;
  shortCode: string | null;
  account: AccountView;
  options: CompanyOptions;
  acceptsOnline: boolean;
}

export interface FeeLine {
  method: 'CARD' | 'ACH';
  rate: string;
  exampleOn100000: number;
}

export type TestRunState = 'awaiting_payment' | 'processing' | 'paid' | 'cancelled' | 'refunded';

export interface TestRun {
  id: string;
  locationId: string;
  environment: 'test' | 'live';
  amountCents: number;
  state: TestRunState;
  invoiceId: string | null;
  invoiceNumber: string | null;
  payPath: string | null;
  createdBy: string;
  createdAt: string;
  closedAt: string | null;
}

export type StripeState = 'not_configured' | 'unrecognized_key' | 'misconfigured' | 'ready';

export interface PaymentsOverviewResponse {
  stripe: {
    state: StripeState;
    mode: 'live' | 'test' | null;
    isLive: boolean;
    problem: string | null;
    webhookConfigured: boolean;
    connectWebhookConfigured: boolean;
  };
  plaid: { label: string; isLive: boolean; configured: boolean; warning: string | null };
  accountMode: AccountMode;
  tenantAccount: AccountView | null;
  fees: FeeLine[] | null;
  companies: CompanyRow[];
  refreshedErrors: number;
  testRuns: TestRun[];
  can: { configure: boolean; editOptions: boolean };
}
