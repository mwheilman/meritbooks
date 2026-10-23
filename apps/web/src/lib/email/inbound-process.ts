/**
 * Inbound email orchestrator — one verified, parsed `InboundEmail` in; one log row
 * and one outcome per company address it reached.
 *
 *   route → (per address) claim → inactive? → forwarding confirmation? → sender rule →
 *   spam? → keep the original .eml → purpose handler (AP / receipts) → finalize
 *
 * HTTP mapping (the route returns this):
 *   no address of ours      403  (Postmark stops retrying; nothing stored)
 *   processed / duplicate   200
 *   a step THREW or a handler reported 'failed'   500 → the provider retries; the
 *   claim turns the earlier 'failed' row into a retry, and finished addresses are
 *   duplicates, so a retry never double-drafts.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  InboundEmail,
  InboundHandlerContext,
  InboundHandlerResult,
} from './inbound-types';
import { readInboundConfig, type InboundConfig } from './inbound-config';
import { loadSenderFacts, routeRecipients, type RoutedAddress } from './inbound-aliases';
import { claimDelivery, finalizeDelivery, touchAlias } from './inbound-log';
import { detectForwardingConfirmation, evaluateSender, type SenderFacts } from './inbound-rules';
import { buildEml, subjectStem } from './inbound-eml';
import { INBOUND_HANDLERS, type InboundHandlerRegistry } from './inbound-handlers';
import { storeSourceDocument } from '@/lib/documents/store-source';
import { getAnthropicApiKey } from '@/lib/ai/gateway';

export interface ProcessDeps {
  admin: SupabaseClient;
  cfg?: InboundConfig;
  handlers?: InboundHandlerRegistry;
  /** Keep the original email as a document. Default: documents bucket (.eml). */
  storeEmail?: (args: { admin: SupabaseClient; orgId: string; email: InboundEmail; alias: RoutedAddress }) => Promise<string | null>;
  now?: () => Date;
}

export interface AddressResult {
  address: string;
  orgId: string;
  locationId: string;
  purpose: 'ap' | 'receipts';
  state: 'processed' | 'duplicate' | 'in_flight';
  outcome: string;
  detail: string;
  messageLogId: string;
}

export interface ProcessResult {
  status: 200 | 403 | 500;
  body: { received: boolean; reason?: string; addresses: AddressResult[] };
}

const defaultStoreEmail: NonNullable<ProcessDeps['storeEmail']> = async ({ admin, orgId, email, alias }) => {
  const stored = await storeSourceDocument({
    supabase: admin,
    orgId,
    userId: null,
    base64: buildEml(email).toString('base64'),
    fileName: `${subjectStem(email)}.eml`,
    mimeType: 'message/rfc822',
    docType: alias.resolved.purpose === 'receipts' ? 'RECEIPT' : 'BILL',
    entityType: 'inbound_email',
    notes: `Original email from ${email.from.address} to ${alias.resolved.address}`,
  });
  return stored?.documentId ?? null;
};

/** Spam verdicts are ignored for senders the tenant already trusts — VERIFIED senders only. */
function trustedSender(email: InboundEmail, alias: RoutedAddress, facts: SenderFacts): boolean {
  if (email.auth?.verified !== true) return false;
  const from = email.from.address;
  return facts.memberEmails.has(from) || facts.vendorEmails.has(from) || alias.policy.allowed_senders.includes(from);
}

export async function processInboundEmail(email: InboundEmail, deps: ProcessDeps): Promise<ProcessResult> {
  const { admin } = deps;
  const cfg = deps.cfg ?? readInboundConfig();
  const handlers = deps.handlers ?? INBOUND_HANDLERS;
  const storeEmail = deps.storeEmail ?? defaultStoreEmail;
  const now = deps.now ?? (() => new Date());

  const routed = await routeRecipients(admin, email.recipients, cfg);
  if (routed.length === 0) {
    console.warn('[inbound-email] no company address matched', email.recipients, 'from', email.from.address);
    return { status: 403, body: { received: false, reason: 'No MeritBooks inbox matches the recipient address.', addresses: [] } };
  }

  const factsByOrg = new Map<string, SenderFacts>();
  const results: AddressResult[] = [];
  let retry = false;

  for (const r of routed) {
    const claim = await claimDelivery(admin, email, r, now());
    const base = { address: r.resolved.address, orgId: r.resolved.orgId, locationId: r.resolved.locationId, purpose: r.resolved.purpose, messageLogId: claim.id };
    if (claim.state === 'duplicate' || claim.state === 'in_flight') {
      results.push({ ...base, state: claim.state, outcome: claim.outcome, detail: claim.state === 'duplicate' ? 'Already received — ignored.' : 'Being processed.' });
      continue;
    }
    if (claim.state === 'claimed') await touchAlias(admin, r.resolved.aliasId, now());

    const finish = async (res: InboundHandlerResult & { emailDocumentId?: string | null }) => {
      await finalizeDelivery(admin, claim.id, {
        outcome: res.outcome,
        detail: res.detail,
        attachments: res.attachments ?? [],
        acceptedCount: res.linked?.intakeDraftIds?.length ?? res.linked?.receiptIds?.length ?? 0,
        intakeDraftIds: res.linked?.intakeDraftIds,
        billIds: res.linked?.billIds,
        documentIds: res.linked?.documentIds,
        receiptIds: res.linked?.receiptIds,
        emailDocumentId: res.emailDocumentId ?? null,
      }, now());
      results.push({ ...base, state: 'processed', outcome: res.outcome, detail: res.detail });
      if (res.outcome === 'failed') retry = true;
    };

    try {
      if (!r.accepting) {
        await finish({ outcome: 'alias_inactive', detail: `${r.inactiveReason ?? 'This address is not accepting mail.'} Nothing was stored.` });
        continue;
      }

      const fwd = detectForwardingConfirmation(email);
      if (fwd && !fwd.authenticated) {
        // Looks like Gmail, but Google's DKIM signature did not verify — a forged
        // "confirm forwarding" could trick an admin into clicking a planted link.
        await finish({
          outcome: 'rejected_sender',
          detail: 'A message claiming to be a Gmail forwarding confirmation arrived, but Google’s signature did not verify, so it was ignored. Ask Gmail to resend the confirmation.',
        });
        continue;
      }
      if (fwd) {
        if (r.alias) {
          await admin.schema('core').from('inbound_aliases').update({
            fwd_confirm_from: fwd.requestedBy, fwd_confirm_code: fwd.code, fwd_confirm_url: fwd.url,
            fwd_confirm_at: now().toISOString(), fwd_confirm_verified: fwd.authenticated, updated_at: now().toISOString(),
          }).eq('id', r.alias.id).eq('org_id', r.resolved.orgId);
        }
        await finish({
          outcome: 'forwarding_confirmation',
          // never the code in the log: the log is readable by anyone with bills:view
          detail: `Gmail is asking to confirm forwarding${fwd.requestedBy ? ` from ${fwd.requestedBy}` : ''}. An admin can confirm it in Settings → Email inboxes.`,
        });
        continue;
      }

      let facts = factsByOrg.get(r.resolved.orgId);
      if (!facts) {
        facts = await loadSenderFacts(admin, r.resolved.orgId);
        factsByOrg.set(r.resolved.orgId, facts);
      }
      const decision = evaluateSender(email.from.address, r.policy, facts, { verified: email.auth?.verified === true, purpose: r.resolved.purpose });
      if (!decision.allowed) {
        await finish({ outcome: 'rejected_sender', detail: `${decision.reason} Nothing was stored — allow this sender to accept their mail.` });
        continue;
      }
      if (email.spam?.flagged && !trustedSender(email, r, facts)) {
        await finish({ outcome: 'rejected_spam', detail: `Marked as spam by the mail provider${email.spam.score !== null ? ` (score ${email.spam.score})` : ''}. Nothing was stored — allow this sender if it is genuine.` });
        continue;
      }

      const emailDocumentId = await storeEmail({ admin, orgId: r.resolved.orgId, email, alias: r }).catch((e: unknown) => {
        console.error('[inbound-email] keeping the original email failed (non-fatal):', e instanceof Error ? e.message : e);
        return null;
      });

      const ctx: InboundHandlerContext = {
        admin,
        alias: r.resolved,
        messageLogId: claim.id,
        aiAvailable: Boolean(getAnthropicApiKey()),
        emailDocumentId,
      };
      const res = await handlers[r.resolved.purpose](email, ctx);
      const legacyNote = r.legacy ? ' (sent to the organization address — filed under the default company)' : '';
      await finish({ ...res, detail: `${res.detail}${legacyNote}`, emailDocumentId });
    } catch (e) {
      retry = true;
      const msg = e instanceof Error ? e.message : 'Unexpected error.';
      console.error('[inbound-email] processing failed', r.resolved.address, msg);
      try {
        await finalizeDelivery(admin, claim.id, { outcome: 'failed', detail: `Processing failed: ${msg} The provider will retry.` }, now());
      } catch {
        /* the row stays 'processing'; a retry after 10 min reclaims it */
      }
      results.push({ ...base, state: 'processed', outcome: 'failed', detail: msg });
    }
  }

  return { status: retry ? 500 : 200, body: { received: true, addresses: results } };
}
