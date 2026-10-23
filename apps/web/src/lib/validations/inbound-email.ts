import { z } from 'zod';
import { normalizeDomain } from '@/lib/email/inbound-rules';
import { normalizeAddress } from '@/lib/email/inbound-normalize';

const uuid = z.string().uuid();

/** GET /api/inbound-email */
export const inboundOverviewQuery = z.object({
  location_id: uuid.optional(),
  check_mx: z.enum(['1', '0']).optional(),
});
export type InboundOverviewQuery = z.infer<typeof inboundOverviewQuery>;

export const INBOUND_OUTCOME_FILTERS = [
  'problems', 'bill_drafted', 'receipt_attached', 'ignored_duplicate', 'rejected_sender', 'rejected_spam',
  'alias_inactive', 'no_attachment', 'forwarding_confirmation', 'not_handled', 'failed', 'processing',
] as const;

/** GET /api/inbound-email/messages */
export const inboundMessagesQuery = z.object({
  location_id: uuid.optional(),
  outcome: z.enum(INBOUND_OUTCOME_FILTERS).optional(),
  purpose: z.enum(['ap', 'receipts']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  per_page: z.coerce.number().int().min(1).max(100).optional(),
});
export type InboundMessagesQuery = z.infer<typeof inboundMessagesQuery>;

const domainList = z
  .array(z.string().max(253))
  .max(100)
  .transform((list, ctx) => {
    const out: string[] = [];
    for (const raw of list) {
      if (!raw.trim()) continue;
      const d = normalizeDomain(raw);
      if (!d) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `“${raw}” is not a domain (example: acmesupply.com).` });
        return z.NEVER;
      }
      out.push(d);
    }
    return Array.from(new Set(out));
  });

const senderList = z
  .array(z.string().max(320))
  .max(200)
  .transform((list, ctx) => {
    const out: string[] = [];
    for (const raw of list) {
      if (!raw.trim()) continue;
      const a = normalizeAddress(raw);
      if (!a) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `“${raw}” is not an email address.` });
        return z.NEVER;
      }
      out.push(a);
    }
    return Array.from(new Set(out));
  });

/** PATCH /api/inbound-email/aliases */
export const inboundAliasPatch = z
  .object({
    alias_id: uuid,
    is_active: z.boolean().optional(),
    sender_rule: z.enum(['any', 'known_vendors', 'listed_domains']).optional(),
    allowed_domains: domainList.optional(),
    allowed_senders: senderList.optional(),
    dismiss_forwarding: z.literal(true).optional(),
    allow_sender: z.string().max(320).refine((s) => Boolean(normalizeAddress(s)), 'Not an email address.').optional(),
  })
  .refine(
    (b) =>
      b.is_active !== undefined || b.sender_rule !== undefined || b.allowed_domains !== undefined ||
      b.allowed_senders !== undefined || b.dismiss_forwarding !== undefined || b.allow_sender !== undefined,
    { message: 'Nothing to change.' },
  );
export type InboundAliasPatch = z.infer<typeof inboundAliasPatch>;
