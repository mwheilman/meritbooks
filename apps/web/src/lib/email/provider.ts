/**
 * Transactional email — provider-agnostic sending.
 *
 * WHY AN INTERFACE RATHER THAN CALLING RESEND DIRECTLY
 *
 * GATE 4 plans document/email ingestion over Microsoft 365 Graph, blocked since
 * Session 22 on Azure credentials. Outbound invoice delivery should not wait on
 * that, and the two jobs have genuinely different requirements: ingestion needs
 * a mailbox, delivery needs deliverability. Resend handles delivery now; Graph
 * can be added as a second implementation without touching callers.
 *
 * FAILURE POSTURE
 *
 * Every send returns an explicit result and never silently reports success. Today
 * this codebase produced eight defects that all shared one shape — reporting
 * success while failing. An invoice recorded as SENT that never left the building
 * is exactly that bug in a new place, so `send` throws on provider failure and
 * the caller must decide what to record.
 */

export interface EmailAttachment {
  filename: string;
  /** Raw bytes. The provider layer handles any encoding. */
  content: Uint8Array;
  contentType: string;
}

export interface EmailMessage {
  to: string[];
  subject: string;
  html: string;
  /** Plain-text alternative. Absent = poorer deliverability; callers should set it. */
  text?: string;
  replyTo?: string;
  attachments?: EmailAttachment[];
}

export interface SendResult {
  id: string;
  provider: EmailProviderId;
}

export type EmailProviderId = 'resend' | 'ms_graph';

export interface EmailProvider {
  readonly id: EmailProviderId;
  send(message: EmailMessage, from: string): Promise<SendResult>;
}

/** Thrown when a send fails. Never swallowed — the caller decides what to record. */
export class EmailSendError extends Error {
  constructor(
    message: string,
    readonly provider: EmailProviderId,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'EmailSendError';
  }
}

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/**
 * Resend (https://resend.com). Requires RESEND_API_KEY and a verified sending
 * domain — an unverified domain is accepted by the API and then silently fails
 * to deliver, so verification is a real prerequisite, not a formality.
 */
export class ResendProvider implements EmailProvider {
  readonly id = 'resend' as const;

  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new Error('RESEND_API_KEY is required to construct ResendProvider');
  }

  async send(message: EmailMessage, from: string): Promise<SendResult> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        reply_to: message.replyTo,
        attachments: message.attachments?.map((a) => ({
          filename: a.filename,
          content: toBase64(a.content),
        })),
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new EmailSendError(
        `Resend rejected the message (${res.status}): ${detail.slice(0, 300)}`,
        'resend',
        res.status,
      );
    }

    const body = (await res.json().catch(() => ({}))) as { id?: string };
    if (!body.id) {
      // A 2xx with no id means we cannot prove it was accepted. Treat as failure
      // rather than recording SENT on an unverifiable outcome.
      throw new EmailSendError('Resend returned success with no message id', 'resend', res.status);
    }
    return { id: body.id, provider: 'resend' };
  }
}

/**
 * Resolve the configured provider. Returns null when email is not set up, so
 * callers can surface "email isn't configured" distinctly from "the send failed"
 * — two different problems that should never share a message.
 */
export function resolveEmailProvider(): EmailProvider | null {
  const key = process.env.RESEND_API_KEY;
  if (key) return new ResendProvider(key);
  return null;
}

/** The From address. Must be on a domain verified with the provider. */
export function resolveFromAddress(): string | null {
  return process.env.INVOICE_FROM_EMAIL ?? null;
}

/**
 * ONE honest definition of "is outbound email configured", so every caller — the
 * invoice/statement/dunning/reminder/invitation/report-pack send paths and any UI
 * that wants to warn before a click — agrees on what "configured" means and never
 * has to re-derive it (or, worse, silently no-op when it isn't).
 *
 * `configured` is true only when BOTH a provider (RESEND_API_KEY) and a verified
 * From address (INVOICE_FROM_EMAIL) are present. When it is false, `code` +
 * `reason` say exactly what is missing so the UI can render an actionable,
 * non-silent "email not configured" state rather than pretending a send happened.
 */
export type EmailConfigCode =
  | 'CONFIGURED'
  | 'EMAIL_NOT_CONFIGURED' // no provider (RESEND_API_KEY missing)
  | 'EMAIL_FROM_MISSING'; // provider present but no From address

export interface EmailConfigStatus {
  configured: boolean;
  hasProvider: boolean;
  hasFromAddress: boolean;
  code: EmailConfigCode;
  /** Null when configured; otherwise a short, actionable message. */
  reason: string | null;
}

export function emailConfigStatus(): EmailConfigStatus {
  const hasProvider = Boolean(process.env.RESEND_API_KEY);
  const hasFromAddress = Boolean(process.env.INVOICE_FROM_EMAIL);

  if (!hasProvider) {
    return {
      configured: false,
      hasProvider,
      hasFromAddress,
      code: 'EMAIL_NOT_CONFIGURED',
      reason: 'Email is not configured. Set RESEND_API_KEY and verify the sending domain.',
    };
  }
  if (!hasFromAddress) {
    return {
      configured: false,
      hasProvider,
      hasFromAddress,
      code: 'EMAIL_FROM_MISSING',
      reason:
        'No sending address configured. Set INVOICE_FROM_EMAIL to an address on a domain verified with the provider.',
    };
  }
  return { configured: true, hasProvider, hasFromAddress, code: 'CONFIGURED', reason: null };
}
