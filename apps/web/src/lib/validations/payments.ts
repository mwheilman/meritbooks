/**
 * Settings → Payments request schemas (FPB-payments-fees §17). Every id here is a
 * MeritBooks id (a company / test-run uuid) — a Stripe connected-account id is never
 * accepted from the browser.
 */
import { z } from 'zod';

export const paymentsOverviewQuery = z.object({
  refresh: z.enum(['0', '1']).optional(),
});
export type PaymentsOverviewQuery = z.infer<typeof paymentsOverviewQuery>;

export const paymentsConnectBody = z.object({
  /** The company to connect. Null = the tenant-level account (only in "one account for all companies" mode). */
  location_id: z.string().uuid().nullable().optional(),
  /** onboard = start / continue Stripe setup; dashboard = open the company's Stripe dashboard. */
  intent: z.enum(['onboard', 'dashboard']).optional(),
});
export type PaymentsConnectBody = z.infer<typeof paymentsConnectBody>;

export const paymentsSettingsBody = z.object({
  account_mode: z.enum(['per_company', 'single']),
});
export type PaymentsSettingsBody = z.infer<typeof paymentsSettingsBody>;

const feePayer = z.enum(['customer', 'company']);

export const companyPaymentOptionsBody = z
  .object({
    location_id: z.string().uuid(),
    card_enabled: z.boolean(),
    ach_enabled: z.boolean(),
    check_enabled: z.boolean(),
    card_fee_payer: feePayer,
    ach_fee_payer: feePayer,
  })
  .refine((b) => b.card_enabled || b.ach_enabled || b.check_enabled, {
    message: 'Keep at least one way for customers to pay.',
    path: ['check_enabled'],
  });
export type CompanyPaymentOptionsBody = z.infer<typeof companyPaymentOptionsBody>;

export const testPaymentCreateBody = z.object({
  location_id: z.string().uuid(),
  /** The UI's confirmation dialog must have been accepted. */
  confirm: z.literal(true),
});
export type TestPaymentCreateBody = z.infer<typeof testPaymentCreateBody>;

export const testPaymentCloseBody = z.object({
  run_id: z.string().uuid(),
  action: z.enum(['cancel', 'refund']),
  confirm: z.literal(true),
});
export type TestPaymentCloseBody = z.infer<typeof testPaymentCloseBody>;

export const bankFeedHealthQuery = z.object({
  location_id: z.string().uuid().optional(),
});
export type BankFeedHealthQuery = z.infer<typeof bankFeedHealthQuery>;
