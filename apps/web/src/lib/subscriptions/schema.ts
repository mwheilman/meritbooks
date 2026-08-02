/**
 * Zod schemas + shared helpers for the subscription-catcher API. Kept inside
 * lib/subscriptions/* (owned by this slice) rather than the reserved validations dir.
 * Money fields are integer cents.
 */

import { z } from 'zod';
import { formatMoney } from '@meritbooks/shared';
import { BILLING_CADENCES } from './detect';

export const SUBSCRIPTION_STATUSES = [
  'DETECTED',
  'ACTIVE',
  'UNDER_REVIEW',
  'CANCELLING',
  'CANCELLED',
  'KEPT',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const SUBSCRIPTION_SOURCES = ['DETECTED', 'MANUAL', 'PARSED'] as const;

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected yyyy-mm-dd');
const CENTS = z.number().int().min(0);

/** Register / edit a subscription (MANUAL source, or confirming a parsed one). */
export const createSubscriptionSchema = z.object({
  location_id: z.string().uuid().nullable().optional(),
  vendor_id: z.string().uuid().nullable().optional(),
  vendor_name: z.string().min(1).max(200),
  product: z.string().max(200).nullable().optional(),
  category: z.string().max(120).nullable().optional(),
  amount_cents: CENTS.default(0),
  billing_cadence: z.enum(BILLING_CADENCES).default('MONTHLY'),
  first_seen_date: ISO_DATE.nullable().optional(),
  last_charged_date: ISO_DATE.nullable().optional(),
  next_renewal_date: ISO_DATE.nullable().optional(),
  status: z.enum(SUBSCRIPTION_STATUSES).default('ACTIVE'),
  auto_renews: z.boolean().default(true),
  notice_period_days: z.number().int().min(0).max(3650).nullable().optional(),
  cancellation_terms: z.string().max(4000).nullable().optional(),
  cancellation_method: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  source: z.enum(SUBSCRIPTION_SOURCES).default('MANUAL'),
});

export const updateSubscriptionSchema = createSubscriptionSchema.partial();

/** Keep / cancel / review decision on a detected or active subscription. */
export const decisionSchema = z.object({
  action: z.enum(['keep', 'cancel', 'review']),
  note: z.string().max(2000).nullable().optional(),
});

export type CreateSubscriptionInput = z.infer<typeof createSubscriptionSchema>;
export type UpdateSubscriptionInput = z.infer<typeof updateSubscriptionSchema>;
export type DecisionInput = z.infer<typeof decisionSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Cancellation draft (pure). A CANCEL decision NEVER cancels anything — it DRAFTS a
// cancellation request for a human to send (canon §3). The draft is notice-aware.
// ─────────────────────────────────────────────────────────────────────────────
export interface DraftableSubscription {
  vendor_name: string;
  product?: string | null;
  amount_cents?: number | null;
  billing_cadence?: string | null;
  next_renewal_date?: string | null;
  notice_period_days?: number | null;
  cancellation_method?: string | null;
}

/** Build a plain-text cancellation request a human reviews and sends. Deterministic. */
export function draftCancellation(sub: DraftableSubscription, orgName = 'our organization'): string {
  const service = sub.product ? `${sub.vendor_name} — ${sub.product}` : sub.vendor_name;
  const amount =
    typeof sub.amount_cents === 'number'
      ? ` (currently ${formatMoney(sub.amount_cents)}${sub.billing_cadence ? ` / ${sub.billing_cadence.toLowerCase()}` : ''})`
      : '';
  const noticeLine =
    typeof sub.notice_period_days === 'number' && sub.notice_period_days > 0
      ? ` Per the agreement, we are providing the required ${sub.notice_period_days} days' notice.`
      : '';
  const renewalLine = sub.next_renewal_date
    ? ` We request this cancellation take effect before the next renewal on ${sub.next_renewal_date}.`
    : '';
  const methodLine = sub.cancellation_method
    ? `\n\n(Note: your terms specify cancellation via ${sub.cancellation_method} — confirm this request is submitted through that channel.)`
    : '';

  return (
    `To the ${sub.vendor_name} Billing / Account team,\n\n` +
    `Please cancel the subscription for ${service}${amount} associated with ${orgName}, effective at the end of the current billing period.${noticeLine}${renewalLine}\n\n` +
    `Please confirm the cancellation in writing, including the effective date and confirmation that no further charges will be made.\n\n` +
    `Thank you,\n${orgName}` +
    methodLine
  );
}
