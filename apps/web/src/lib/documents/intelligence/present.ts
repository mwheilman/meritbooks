/**
 * What document-intelligence rows look like on the way OUT to the browser (security
 * review H4 / M): only the DTO columns (no hashes, AI error text, company hints, creators),
 * TIN-shaped strings redacted, and list endpoints never carry a proposal's `payload` —
 * the extracted terms come only from the one-proposal detail read.
 *
 * Pure; the async "is the duplicate visible to this caller" step lives in route-auth.
 */

import { redactDeep, redactTin } from './redact';
import type { IntelligenceDto, ProposalDto, ProposalSummaryDto } from './types';

const r = (v: string | null | undefined): string | null => (typeof v === 'string' ? redactTin(v) : v ?? null);

type Loose<T> = T & Record<string, unknown>;

export function presentIntel(row: Loose<IntelligenceDto> | IntelligenceDto): IntelligenceDto {
  return {
    id: row.id,
    document_id: row.document_id,
    location_id: row.location_id ?? null,
    location_source: row.location_source ?? null,
    doc_class: row.doc_class,
    confidence: Number(row.confidence),
    class_source: row.class_source,
    status: row.status,
    ai_status: row.ai_status,
    ai_attempts: row.ai_attempts ?? 0,
    next_retry_at: row.next_retry_at ?? null,
    counterparty: r(row.counterparty),
    key_dates: (row.key_dates ?? {}) as Record<string, string>,
    amount_cents: row.amount_cents ?? null,
    summary: r(row.summary),
    reason: r(row.reason),
    duplicate_of: row.duplicate_of ?? null,
    source: row.source,
    classified_at: row.classified_at ?? null,
    updated_at: row.updated_at,
  };
}

export function presentProposalSummary(row: Loose<ProposalSummaryDto> | ProposalSummaryDto): ProposalSummaryDto {
  return {
    id: row.id,
    document_id: row.document_id,
    location_id: row.location_id ?? null,
    target_kind: row.target_kind,
    mode: row.mode,
    status: row.status,
    extract_state: row.extract_state,
    title: r(row.title),
    summary: r(row.summary),
    confidence: row.confidence == null ? null : Number(row.confidence),
    native_table: row.native_table ?? null,
    native_id: row.native_id ?? null,
    target_href: row.target_href ?? null,
    accepted_target_type: row.accepted_target_type ?? null,
    accepted_target_id: row.accepted_target_id ?? null,
    last_error: r(row.last_error),
    created_at: row.created_at,
  };
}

/** The one-proposal detail: the summary + the (redacted) extracted terms. */
export function presentProposal(row: Loose<ProposalDto> | ProposalDto): ProposalDto {
  return { ...presentProposalSummary(row), payload: redactDeep((row.payload ?? {}) as Record<string, unknown>) };
}
