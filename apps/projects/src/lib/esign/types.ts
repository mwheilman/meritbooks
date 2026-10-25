/** E-signature contract shared by lib/esign, the routes and the views (migration 1115). */
import { z } from 'zod';

export const COMPLETION_KINDS = ['estimate', 'change_order', 'lien_waiver', 'dealer_quote'] as const;
export type CompletionKind = (typeof COMPLETION_KINDS)[number];

export const SignerInput = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254).optional().nullable(),
  phone: z.string().trim().regex(/^\+?[0-9 ().-]{7,20}$/, 'Use a phone number like +1 515 555 0100').optional().nullable(),
  roleLabel: z.string().trim().max(60).optional().nullable(),
  channel: z.enum(['email', 'sms', 'both', 'link']).optional(),
  order: z.number().int().min(1).max(20).optional(),
}).superRefine((s, ctx) => {
  const ch = s.channel ?? (s.email ? 'email' : s.phone ? 'sms' : 'link');
  if ((ch === 'email' || ch === 'both') && !s.email) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['email'], message: 'Add an email to send by email.' });
  if ((ch === 'sms' || ch === 'both') && !s.phone) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['phone'], message: 'Add a mobile number to send by text.' });
});
export type SignerInputT = z.infer<typeof SignerInput>;

export const RequestSignatureInput = z.object({
  documentId: z.string().uuid(),
  signers: z.array(SignerInput).min(1).max(10),
  title: z.string().trim().max(200).optional(),
  message: z.string().trim().max(2000).optional(),
  expiresDays: z.number().int().min(1).max(90).optional(),
  routing: z.enum(['sequential', 'parallel']).optional(),
  onCompleted: z.object({ kind: z.enum(COMPLETION_KINDS), id: z.string().uuid() }).optional().nullable(),
});
export type RequestSignatureInputT = z.infer<typeof RequestSignatureInput>;

export type EnvelopeStatus = 'draft' | 'sent' | 'completed' | 'declined' | 'voided' | 'expired';
export type SignerStatus = 'waiting' | 'pending_send' | 'sent' | 'viewed' | 'signed' | 'declined';

export interface EnvelopeRow {
  id: string;
  location_id: string;
  job_id: string | null;
  file_id: string;
  version_id: string;
  title: string;
  message: string | null;
  status: EnvelopeStatus;
  routing: 'sequential' | 'parallel';
  expires_at: string;
  on_completed_kind: CompletionKind | 'none';
  on_completed_id: string | null;
  sender_user: string;
  sent_at: string | null;
  completed_at: string | null;
  declined_at: string | null;
  decline_reason: string | null;
  voided_at: string | null;
  void_reason: string | null;
  original_sha256: string;
  finalize_state: 'not_ready' | 'pending' | 'done' | 'failed';
  finalize_error: string | null;
  signed_version_id: string | null;
  signed_sha256: string | null;
  created_at: string;
}

export interface SignerRow {
  id: string;
  envelope_id: string;
  routing_order: number;
  position: number;
  name: string;
  email: string | null;
  phone: string | null;
  role_label: string | null;
  channel: 'email' | 'sms' | 'both' | 'link';
  status: SignerStatus;
  sent_at: string | null;
  viewed_at: string | null;
  consented_at: string | null;
  consent_version: string | null;
  signed_at: string | null;
  typed_name: string | null;
  signature_png: string | null;
  sign_ip: string | null;
  sign_user_agent: string | null;
  declined_at: string | null;
  decline_reason: string | null;
}

export interface EventRow {
  id: string;
  envelope_id: string;
  signer_id: string | null;
  event: string;
  at: string;
  ip: string | null;
  user_agent: string | null;
  actor_user: string | null;
  detail: Record<string, unknown>;
}

export interface OutboxRow {
  id: string;
  envelope_id: string;
  signer_id: string | null;
  kind: 'envelope.completed' | 'envelope.declined' | 'signer.turn';
  subject_kind: CompletionKind | 'none';
  subject_id: string | null;
  status: 'pending' | 'done' | 'failed' | 'skipped';
  attempts: number;
  last_error: string | null;
  created_at: string;
}

/** What esign.open / sign / decline return (the public page's state). */
export interface PublicSignState {
  ok: boolean;
  reason: string | null;
  can_act?: boolean;
  envelope?: { id: string; title: string; message?: string | null; status: EnvelopeStatus; expires_at?: string; sent_at?: string | null; completed_at: string | null; sha256?: string };
  document?: { title: string; file_name: string; page_count: number | null; kind: string };
  /** Storage key granted for ~10 minutes by a valid open (never shown to the browser). */
  document_path?: string;
  company?: { company_name: string; org_name: string | null; logo_url: string | null; primary_color: string; ink_color: string; on_primary_color: string };
  signer?: { id: string; name: string; email?: string | null; role_label?: string | null; status: SignerStatus; signed_at: string | null; routing_order: number };
  signers?: Array<{ name: string; role_label: string | null; routing_order: number; status: SignerStatus; signed_at: string | null; you: boolean }>;
  consent?: { version: string; text: string };
}

export const ENVELOPE_STATUS_WORD: Readonly<Record<EnvelopeStatus, string>> = {
  draft: 'Draft', sent: 'Out for signature', completed: 'Signed', declined: 'Declined', voided: 'Voided', expired: 'Expired',
};
export const SIGNER_STATUS_WORD: Readonly<Record<SignerStatus, string>> = {
  waiting: 'Waiting for earlier signers', pending_send: 'Link not sent yet', sent: 'Link sent', viewed: 'Opened', signed: 'Signed', declined: 'Declined',
};

/** Plain words for the public page's refusal reasons. */
export const REASON_WORD: Readonly<Record<string, string>> = {
  invalid: 'This signing link is not valid. Ask the sender for a new link.',
  unavailable: 'Signing is not available right now. Try again in a few minutes.',
  used: 'This link has already been used. Each link works once.',
  revoked: 'This link was replaced or cancelled. Use the newest link the sender gave you.',
  expired: 'This signing request expired. Ask the sender to send it again.',
  voided: 'The sender cancelled this signing request.',
  declined: 'This request was declined, so it can no longer be signed.',
  signed: 'You have already signed. Thank you.',
  waiting: 'Someone earlier in the signing order has not signed yet. You will get a link when it is your turn.',
  completed: 'Everyone has signed.',
  consent_required: 'Tick the box to agree to sign electronically.',
  name_required: 'Type your full name.',
  signature_required: 'Draw your signature in the box.',
  reason_required: 'Say why you are declining, so the sender can fix it.',
};
