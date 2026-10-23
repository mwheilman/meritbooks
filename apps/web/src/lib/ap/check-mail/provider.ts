/**
 * Print-and-mail adapter for checks (CK-02) — provider-agnostic, NO provider wired.
 *
 * The owner has not chosen between printing in-house and a mail service (Lob, Checkbook,
 * PostGrid, …). This is the seam a provider plugs into: given a check that has already been
 * released and numbered from the account's sequence, hand it to the service and get back a
 * tracking reference. The default provider reports "not configured" and refuses to send —
 * the /checks screen shows "Mail with a service" disabled with that note.
 *
 * A real provider must: receive the full MICR numbers only server-side (never log them),
 * be idempotent on `idempotencyKey` (the check id), and never be called for a check that is
 * VOIDED / SPOILED / CLEARED. Wiring one = implement CheckMailProvider and return it from
 * `getCheckMailProvider()` behind tenant configuration.
 */

export interface MailAddress {
  name: string;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  zip: string;
  country?: string;
}

export interface MailCheckRequest {
  idempotencyKey: string;
  checkNumber: number;
  amountCents: number;
  checkDate: string;
  memo: string | null;
  payee: MailAddress;
  from: MailAddress;
  bank: { routing: string; account: string; name: string | null };
  /** Remittance lines printed on the attached stub. */
  remittance: Array<{ ref: string | null; date: string | null; paidCents: number }>;
}

export interface MailCheckResult {
  providerId: string;
  trackingRef: string;
  expectedDeliveryDate: string | null;
}

export interface CheckMailStatus {
  configured: boolean;
  provider: string | null;
  /** Plain-English line for the UI. */
  note: string;
}

export interface CheckMailProvider {
  readonly id: string;
  status(): CheckMailStatus;
  mail(request: MailCheckRequest): Promise<MailCheckResult>;
}

export class CheckMailNotConfiguredError extends Error {
  readonly status = 409;
  constructor() {
    super('Mailing checks through a service is not configured. Print the checks here, or ask your administrator to choose a mail service.');
    this.name = 'CheckMailNotConfiguredError';
  }
}

export const notConfiguredProvider: CheckMailProvider = {
  id: 'none',
  status: () => ({
    configured: false,
    provider: null,
    note: "Not configured — your administrator hasn't chosen a check mailing service.",
  }),
  mail: async () => {
    throw new CheckMailNotConfiguredError();
  },
};

/** The tenant's mail provider. Always the not-configured default until a provider is chosen. */
export function getCheckMailProvider(_orgId?: string): CheckMailProvider {
  return notConfiguredProvider;
}
