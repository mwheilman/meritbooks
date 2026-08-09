export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { createAdminSupabase } from '@/lib/supabase/server';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import {
  resolveTenantByRecipients,
  resolveDefaultLocationId,
  ingestInboundAttachment,
  inboundMessageAlreadySeen,
  normalizeEmailAddress,
  type InboundAttachment,
  type IngestAttachmentOutcome,
} from '@/lib/ap/inbound-intake';
import type { DocProviderDeps } from '@/lib/ap/doc-intelligence';

/**
 * POST /api/webhooks/inbound-email — the AP "monitored mailbox" ingress.
 *
 * A tenant forwards vendor invoices to its per-tenant inbound address; an email
 * provider (SendGrid Inbound Parse, Postmark, Mailgun, Cloudflare Email Worker, …)
 * POSTs the message here as JSON. Provider-agnostic body:
 *
 *   {
 *     "from": "vendor@acme.com",              // or "sender"
 *     "to": "ap-acme@inbound.meritbooks.app", // or ["…"] / "recipient"
 *     "subject": "Invoice 1042",
 *     "messageId": "<abc@provider>",          // optional; enables de-dup
 *     "attachments": [
 *       { "filename": "invoice.pdf", "contentType": "application/pdf", "content": "<base64>" }
 *     ]
 *   }
 *
 * AUTH: a shared secret (INBOUND_EMAIL_SECRET), presented in `x-inbound-email-secret`
 * OR `Authorization: Bearer <secret>`, compared in constant time — the same posture
 * as the event-worker guard. FAILS CLOSED: if the env is unset the endpoint rejects
 * everything (an unauthenticated caller can never post a bill draft into a tenant).
 *
 * DEGRADE-SAFE: each attachment is retained in the documents bucket BEFORE the AI
 * read; if the read fails (AI disabled, unreadable scan), the draft still lands in
 * the AP intake queue as PENDING_PARSE with the original attached. Never a GL post.
 */

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Constant-time shared-secret check. Fails closed when the env is unset. */
function authorizeInbound(req: Request): boolean {
  const secret = process.env.INBOUND_EMAIL_SECRET;
  if (!secret || secret.length === 0) return false;

  const header = req.headers.get('x-inbound-email-secret');
  if (header && safeEqual(header, secret)) return true;

  const authz = req.headers.get('authorization');
  if (authz && authz.toLowerCase().startsWith('bearer ')) {
    const presented = authz.slice(7).trim();
    if (presented && safeEqual(presented, secret)) return true;
  }
  return false;
}

/** Pull recipient addresses out of the many shapes providers use. */
function extractRecipients(body: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string') out.push(...v.split(',').map((s) => s.trim()).filter(Boolean));
    else if (Array.isArray(v)) v.forEach(push);
    else if (v && typeof v === 'object' && 'address' in (v as object)) {
      const a = (v as { address?: unknown }).address;
      if (typeof a === 'string') out.push(a);
    }
  };
  push(body.to);
  push(body.To);
  push(body.recipient);
  push(body.recipients);
  const envelope = body.envelope as { to?: unknown } | undefined;
  if (envelope) push(envelope.to);
  return out;
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}

/** Normalize one provider attachment object into our InboundAttachment shape. */
function normalizeAttachment(raw: unknown): InboundAttachment | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  const base64 = firstString(a.content, a.base64, a.data, a.contentBytes);
  if (!base64) return null;
  const fileName = firstString(a.filename, a.fileName, a.name) ?? 'attachment';
  const mediaType =
    firstString(a.contentType, a.content_type, a.type, a.mimeType, a.mime_type) ?? 'application/octet-stream';
  return { fileName, mediaType, base64 };
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!authorizeInbound(req)) {
    return NextResponse.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }

  const from = firstString(body.from, body.sender, body.From) ?? 'unknown@sender';
  const subject = firstString(body.subject, body.Subject);
  const messageId = firstString(body.messageId, body.message_id, body['Message-Id'], body['message-id']);
  const recipients = extractRecipients(body);
  const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];

  const admin = createAdminSupabase();

  // ── Tenant resolution ─────────────────────────────────────
  const tenant = await resolveTenantByRecipients(admin, recipients);
  if (!tenant) {
    // Can't attribute this message to a tenant. A retry won't fix that, so we
    // ACK (200) to stop provider retries, but log LOUD and store nothing.
    console.error(
      '[inbound-email] no tenant matched recipients',
      recipients.map(normalizeEmailAddress),
      'from',
      from,
    );
    return NextResponse.json(
      { received: true, ignored: true, reason: 'No tenant matched the recipient address.' },
      { status: 200 },
    );
  }

  // ── Idempotency (best-effort) ─────────────────────────────
  if (await inboundMessageAlreadySeen(admin, tenant.orgId, messageId)) {
    return NextResponse.json({ received: true, duplicate: true, org_id: tenant.orgId });
  }

  if (rawAttachments.length === 0) {
    // A body-only email (no invoice attached). Nothing to intake; ACK honestly.
    return NextResponse.json(
      { received: true, org_id: tenant.orgId, items: [], skipped: [], reason: 'No attachments.' },
      { status: 200 },
    );
  }

  const locationId = await resolveDefaultLocationId(admin, tenant.orgId);
  const receivedAt = new Date().toISOString();

  // AI deps only when a key is available; otherwise the intake degrades to
  // PENDING_PARSE (document retained, read deferred).
  const apiKey = getAnthropicApiKey();
  const deps: DocProviderDeps | null = apiKey ? { supabase: admin, anthropicApiKey: apiKey } : null;

  const outcomes: IngestAttachmentOutcome[] = [];
  for (const raw of rawAttachments) {
    const attachment = normalizeAttachment(raw);
    if (!attachment) {
      outcomes.push({ fileName: 'attachment', ok: false, skipped: true, reason: 'Missing content.' });
      continue;
    }
    try {
      outcomes.push(
        await ingestInboundAttachment(admin, {
          orgId: tenant.orgId,
          locationId,
          from,
          subject,
          messageId,
          receivedAt,
          attachment,
          deps,
        }),
      );
    } catch (e) {
      console.error('[inbound-email] ingest threw', attachment.fileName, e);
      outcomes.push({
        fileName: attachment.fileName,
        ok: false,
        skipped: false,
        error: e instanceof Error ? e.message : 'ingest_error',
      });
    }
  }

  const items = outcomes.filter((o) => o.ok);
  const skipped = outcomes.filter((o) => !o.ok);

  return NextResponse.json(
    {
      received: true,
      org_id: tenant.orgId,
      matched_address: tenant.matchedAddress,
      location_id: locationId || null,
      accepted: items.length,
      items,
      skipped,
    },
    { status: 200 },
  );
}
