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
