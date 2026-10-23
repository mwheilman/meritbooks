/**
 * Vendor document submissions: received → AI-checked → accepted | rejected (FPB §19 A4–A6).
 *
 *   recordSubmission      a portal upload / fill-here W-9 / staff upload lands for review;
 *                         the live W-9 / COI request is closed "waiting for review" so the
 *                         vendor is not chased while a person looks (the portal link stays
 *                         alive so they can replace a file and see the read-back)
 *   runAiCheck            COI_EXTRACT through the Core AI gateway (W-9 images only when
 *                         VENDOR_PORTAL_W9_AI=on — D6), then the deterministic rule check
 *                         against the vendor's requirement set. AI down → `unavailable`,
 *                         nothing blocks: a person keys the lines.
 *   acceptSubmission      writes vendor_coverages + VALID vendor_compliance_docs (+ W-9
 *                         status), supersedes older open submissions, fulfils any live
 *                         request, releases bills held for compliance when the vendor is now
 *                         clear, logs DOC_ACCEPTED / HOLD_LIFTED
 *   rejectSubmission      logs DOC_REJECTED and opens a correction request quoting the reason
 *
 * Writes go through the service role (`admin`) — routes authorize first and read the row
 * through the member's RLS client; the portal derives org + vendor from the token row.
 * AI proposes facts only (an ai_decisions PROPOSED row); a person accepts.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { evaluateVendorCompliance } from '@/lib/services/vendor-compliance';
import { logVendorComplianceEvent } from '@/lib/services/vendor-compliance-audit';
import { parseCoiDocument, COI_EXTRACT_FEATURE, type ParseCoiResult, type ProposedCoi } from '@/lib/vendors/coi-parse';
import { parseW9Document, W9_EXTRACT_FEATURE, type ParseW9Result, type ProposedW9 } from '@/lib/vendors/w9-parse';
import { isAiUnavailableError } from '@/lib/ai/gateway';
import { recordEvent } from '@/lib/requests/events';
import { fulfilRequest } from '@/lib/requests/service';
import { LIVE_STATUSES, type RequestRow } from '@/lib/requests/types';
import { createVendorDocRequest } from '@/lib/requests/vendor-compliance';
import { loadPolicyContext } from '@/lib/requests/policy';
import {
  COVERAGE_TYPES,
  checkProposedCoi,
  coverageFactsFromProposal,
  type CoverageKind,
  type RequirementSet,
  type RuleResult,
} from './requirements';
import { governingSet, loadProfiles, loadRequirementSets, loadVendorCompanies } from './store';

type DB = SupabaseClient;

export type DocKind = 'W9' | 'COI';
export type SubmissionStatus = 'received' | 'ai_checked' | 'accepted' | 'rejected' | 'superseded';
export type AiStatus = 'pending' | 'done' | 'unavailable' | 'failed' | 'skipped';
export const OPEN_SUBMISSION: SubmissionStatus[] = ['received', 'ai_checked'];

/** Never select tin_ciphertext through a member client (column_revoke) — use this list. */
export const SUBMISSION_COLUMNS =
  'id, org_id, vendor_id, doc_kind, source, document_id, portal_token_id, request_id, status, ai_status, ai_note, ai_model, ai_decision_id, ai_attempts, extracted, rule_results, rules_passed, w9_form, tin_last4, reviewed_by, reviewed_at, decision_reason, accepted_doc_ids, created_by, created_at, updated_at';

export interface W9FormData {
  legal_name: string;
  business_name: string | null;
  entity_type: string;
  llc_tax_class: 'C' | 'S' | 'P' | null;
  exempt_payee_code: string | null;
  address_line1: string;
  address_line2: string | null;
  city: string;
  state: string;
  zip: string;
  tin_type: 'SSN' | 'EIN';
  tin_last4: string;
  tin_stored: boolean;
  signer_name: string;
  signed_at: string;
  signer_ip: string | null;
  user_agent: string | null;
  certification_version: string;
  is_1099_eligible_signal: boolean | null;
}

export interface SubmissionRow {
  id: string;
  org_id: string;
  vendor_id: string;
  doc_kind: DocKind;
  source: 'portal_upload' | 'portal_w9_form' | 'staff_upload';
  document_id: string | null;
  portal_token_id: string | null;
  request_id: string | null;
  status: SubmissionStatus;
  ai_status: AiStatus;
  ai_note: string | null;
  ai_model: string | null;
  ai_decision_id: string | null;
  /** How many times AI has tried to read this document (mig 180; the re-check job stops at MAX_AI_ATTEMPTS). */
  ai_attempts?: number;
  extracted: { coi?: ProposedCoi; w9?: ProposedW9 } & Record<string, unknown>;
  rule_results: RuleResult[];
  rules_passed: boolean | null;
  w9_form: W9FormData | null;
  tin_last4: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  decision_reason: string | null;
  accepted_doc_ids: string[] | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export class ReviewError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
    this.name = 'ReviewError';
  }
}

/** The set that applies to this vendor across every company it works for (null = no set). */
export async function requirementSetForVendor(db: DB, orgId: string, vendorId: string): Promise<RequirementSet | null> {
  const sets = await loadRequirementSets(db, orgId);
  if (sets.length === 0) return null;
  const [profiles, companies, { data: v }] = await Promise.all([
    loadProfiles(db, orgId, [vendorId]),
    loadVendorCompanies(db, orgId, [vendorId]),
    db.schema('core').from('vendors').select('is_1099_eligible').eq('org_id', orgId).eq('id', vendorId).maybeSingle(),
  ]);
  const p = profiles.get(vendorId);
  const elig = (v as { is_1099_eligible?: boolean | null } | null)?.is_1099_eligible;
  return governingSet(
    sets,
    { vendorType: p?.vendorType ?? null, workType: p?.workType ?? null, is1099Eligible: typeof elig === 'boolean' ? elig : null },
    { companies: companies.get(vendorId) ?? [] },
  );
}

/** A minimal COI check when no requirement set applies: a current general-liability line. */
const BASELINE_SET: RequirementSet = {
  id: 'baseline',
  name: 'Basic certificate check',
  locationId: null,
  vendorType: null,
  tax1099: 'any',
  workType: null,
  w9Required: false,
  coiRequired: true,
  minGlEachOccurrenceCents: null,
  minGlAggregateCents: null,
  minAutoCents: null,
  wcRequired: false,
  minWcEachAccidentCents: null,
  minUmbrellaCents: null,
  requireAdditionalInsured: false,
  requireWaiverOfSubrogation: false,
  certificateHolderNames: [],
  expiryLeadDays: 30,
  blockPayment: false,
  graceDays: 0,
  isActive: true,
  updatedAt: '1970-01-01',
};

const passed = (rs: ReadonlyArray<RuleResult>) => rs.length > 0 && rs.every((r) => r.outcome === 'met' || r.outcome === 'expiring' || r.outcome === 'grace');

/** Close the live W-9 / COI request(s) for this vendor: the vendor answered, a person reviews next. */
export async function closeRequestsOnSubmission(admin: DB, orgId: string, vendorId: string, kind: DocKind, actor: string, now: Date): Promise<string[]> {
  const reqKind = kind === 'W9' ? 'w9' : 'coi';
  const { data } = await admin
    .schema('core')
    .from('requests')
    .select('*')
    .eq('org_id', orgId)
    .eq('recipient_vendor_id', vendorId)
    .eq('kind', reqKind)
    .in('status', [...LIVE_STATUSES]);
  const closed: string[] = [];
  for (const r of (data ?? []) as RequestRow[]) {
    const note = 'The vendor sent it through the portal — waiting for review.';
    const { data: upd } = await admin
      .schema('core')
      .from('requests')
      .update({ status: 'fulfilled', fulfilled_at: now.toISOString(), fulfilled_by: actor, fulfilled_via: 'magic_link', fulfilled_note: note, next_send_at: null, snoozed_until: null, updated_at: now.toISOString() })
      .eq('org_id', orgId)
      .eq('id', r.id)
      .in('status', [...LIVE_STATUSES])
      .select('id');
    if (!upd || (Array.isArray(upd) && upd.length === 0)) continue;
    // The emailed /r/ links stop working; the vendor-portal link stays (replace a file, see the result).
    await admin.schema('core').from('request_tokens').update({ revoked_at: now.toISOString() }).eq('org_id', orgId).eq('request_id', r.id).is('revoked_at', null);
    await recordEvent(admin, r, { event_type: 'fulfilled', detail: note, actor, meta: { via: 'magic_link' } }, now);
    closed.push(r.id);
  }
  return closed;
}

export interface RecordSubmissionInput {
  orgId: string;
  vendorId: string;
  docKind: DocKind;
  source: SubmissionRow['source'];
  documentId?: string | null;
  portalTokenId?: string | null;
  w9Form?: W9FormData | null;
  tinCiphertext?: string | null;
  actor: string;
}

export async function recordSubmission(admin: DB, input: RecordSubmissionInput, now: Date = new Date()): Promise<SubmissionRow> {
  // Earlier unreviewed submissions of the same kind are replaced by this one.
  await admin
    .from('vendor_document_submissions')
    .update({ status: 'superseded', updated_at: now.toISOString() })
    .eq('org_id', input.orgId)
    .eq('vendor_id', input.vendorId)
    .eq('doc_kind', input.docKind)
    .in('status', OPEN_SUBMISSION);
  const { data, error } = await admin
    .from('vendor_document_submissions')
    .insert({
      org_id: input.orgId,
      vendor_id: input.vendorId,
      doc_kind: input.docKind,
      source: input.source,
      document_id: input.documentId ?? null,
      portal_token_id: input.portalTokenId ?? null,
      status: 'received',
      ai_status: input.source === 'portal_w9_form' ? 'skipped' : 'pending',
      ai_note: input.source === 'portal_w9_form' ? 'Typed into the portal by the vendor — no AI read needed.' : null,
      w9_form: input.w9Form ?? null,
      tin_ciphertext: input.tinCiphertext ?? null,
      tin_last4: input.w9Form?.tin_last4 ?? null,
      rule_results: input.w9Form ? w9FormRules(input.w9Form) : [],
      rules_passed: input.w9Form ? true : null,
      created_by: input.actor,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .select(SUBMISSION_COLUMNS)
    .single();
  if (error || !data) throw new ReviewError(`Could not record the submission: ${error?.message ?? 'no row'}`, 500);
  const row = data as SubmissionRow;
  const closed = input.source.startsWith('portal_') ? await closeRequestsOnSubmission(admin, input.orgId, input.vendorId, input.docKind, input.actor, now) : [];
  if (closed[0]) await admin.from('vendor_document_submissions').update({ request_id: closed[0] }).eq('org_id', input.orgId).eq('id', row.id);
  await logVendorComplianceEvent(
    admin,
    input.orgId,
    input.vendorId,
    input.source === 'portal_w9_form' ? 'W9_FORM_SUBMITTED' : 'UPLOAD_RECEIVED',
    input.source === 'portal_w9_form'
      ? `W-9 completed and e-signed in the portal by ${input.w9Form?.signer_name ?? 'the vendor'} (TIN ending ${input.w9Form?.tin_last4 ?? '????'}).`
      : `${input.docKind === 'W9' ? 'W-9' : 'Certificate of insurance'} received${input.source === 'portal_upload' ? ' through the vendor portal' : ''}; waiting for review.`,
    { actor: input.actor, submissionId: row.id, docId: null, meta: closed.length ? { requests_closed: closed } : undefined },
  );
  return { ...row, request_id: closed[0] ?? row.request_id };
}

function w9FormRules(f: W9FormData): RuleResult[] {
  return [
    { rule: 'W9', label: 'Form W-9', outcome: 'met', reason: `Signed by ${f.signer_name} on ${f.signed_at.slice(0, 10)}; TIN ending ${f.tin_last4}${f.tin_stored ? '' : ' (TIN not retained — no encryption key configured)'}.`, expiresOn: null },
  ];
}

export interface AiDeps {
  anthropicApiKey: string | null;
  parseCoi?: typeof parseCoiDocument;
  parseW9?: typeof parseW9Document;
  /** Send uploaded W-9 images to the model (security decision D6; default off). */
  allowW9Ai?: boolean;
  /**
   * Set when the caller's AI budget refuses this read (the portal's per-link daily cap,
   * security review M11). The document is queued for a person with this note.
   */
  aiDeniedNote?: string | null;
}

export const W9_TIN_NOT_STORED_MESSAGE =
  'This W-9 can’t be accepted: the full taxpayer ID was not saved because TIN encryption isn’t set up (TIN_ENCRYPTION_KEY). Set it up, then reject this one and ask the vendor to fill in the W-9 again — or have them upload a signed W-9 PDF.';

/** AI reads per document before the re-check job gives up and leaves it to a person. */
export const MAX_AI_ATTEMPTS = 3;

/** Run the AI read + rule check on an uploaded document. Never throws for AI failures. */
export async function runAiCheck(admin: DB, subIn: SubmissionRow, file: { base64: string; mediaType: string }, deps: AiDeps, now: Date = new Date()): Promise<SubmissionRow> {
  let sub: SubmissionRow = subIn;
  const today = now.toISOString().slice(0, 10);
  const save = async (patch: Record<string, unknown>) => {
    const { data } = await admin.from('vendor_document_submissions').update({ ...patch, updated_at: now.toISOString() }).eq('org_id', sub.org_id).eq('id', sub.id).select(SUBMISSION_COLUMNS);
    return ((Array.isArray(data) ? data[0] : null) as SubmissionRow | null) ?? { ...sub, ...(patch as Partial<SubmissionRow>) };
  };
  const unavailable = async (note: string, status: AiStatus = 'unavailable') => {
    await logVendorComplianceEvent(admin, sub.org_id, sub.vendor_id, 'AI_UNAVAILABLE', `AI could not read the ${sub.doc_kind === 'W9' ? 'W-9' : 'certificate'}: ${note} A person will check it.`, { actor: 'system:ai', submissionId: sub.id });
    return save({ ai_status: status, ai_note: note });
  };

  if (sub.doc_kind === 'W9' && !deps.allowW9Ai) {
    return save({ ai_status: 'skipped', ai_note: 'W-9 images are checked by a person (the TIN is not sent to AI).' });
  }
  // 'skipped', not 'unavailable': the re-check job must not re-spend the budget the cap refused.
  if (deps.aiDeniedNote) return unavailable(deps.aiDeniedNote, 'skipped');
  if (!deps.anthropicApiKey) return unavailable('AI reading is paused.');

  // One more attempt on the books before the model is called (the re-check job stops at
  // MAX_AI_ATTEMPTS so a document the model cannot read is not re-sent every hour).
  const attempts = (sub.ai_attempts ?? 0) + 1;
  {
    const { error: attErr } = await admin.from('vendor_document_submissions').update({ ai_attempts: attempts, updated_at: now.toISOString() }).eq('org_id', sub.org_id).eq('id', sub.id);
    if (attErr) console.warn('[vendor-compliance] could not record the AI attempt:', attErr.message);
  }
  sub = { ...sub, ai_attempts: attempts };

  if (sub.doc_kind === 'COI') {
    let res: ParseCoiResult;
    try {
      res = await (deps.parseCoi ?? parseCoiDocument)({ supabase: admin, anthropicApiKey: deps.anthropicApiKey }, { orgId: sub.org_id, userId: null, base64Data: file.base64, mediaType: file.mediaType });
    } catch (e) {
      return unavailable(isAiUnavailableError(e) ? 'AI reading is paused.' : 'The AI read failed.', isAiUnavailableError(e) ? 'unavailable' : 'failed');
    }
    if (!res.ok) return unavailable(res.budgetBlocked ? 'The AI budget for this month is used up.' : res.error, res.budgetBlocked ? 'unavailable' : 'failed');
    const set = (await requirementSetForVendor(admin, sub.org_id, sub.vendor_id).catch(() => null)) ?? BASELINE_SET;
    const rules = checkProposedCoi(set, coverageFactsFromProposal(res.coi), today);
    const decisionId = await logAiDecision(admin, sub, COI_EXTRACT_FEATURE, res.model, res.correlationId, { kind: 'coi_extraction', submission_id: sub.id, coi: res.coi, rule_results: rules });
    const ok = passed(rules);
    await logVendorComplianceEvent(
      admin,
      sub.org_id,
      sub.vendor_id,
      ok ? 'AI_CHECKED' : 'REQUIREMENT_FAILED',
      ok ? `AI read the certificate: ${res.coi.coverages.length} coverage line(s); every check passes.` : `AI read the certificate: ${rules.filter((r) => !['met', 'expiring', 'grace'].includes(r.outcome)).map((r) => r.reason).join(' ')}`,
      { actor: 'system:ai', submissionId: sub.id },
    );
    return save({ status: 'ai_checked', ai_status: 'done', ai_model: res.model, ai_decision_id: decisionId, ai_note: res.documentNote, extracted: { coi: res.coi }, rule_results: rules, rules_passed: ok });
  }

  let res: ParseW9Result;
  try {
    res = await (deps.parseW9 ?? parseW9Document)({ supabase: admin, anthropicApiKey: deps.anthropicApiKey }, { orgId: sub.org_id, userId: null, base64Data: file.base64, mediaType: file.mediaType });
  } catch (e) {
    return unavailable(isAiUnavailableError(e) ? 'AI reading is paused.' : 'The AI read failed.', isAiUnavailableError(e) ? 'unavailable' : 'failed');
  }
  if (!res.ok) return unavailable(res.budgetBlocked ? 'The AI budget for this month is used up.' : res.error, res.budgetBlocked ? 'unavailable' : 'failed');
  const p = res.proposal;
  const rules: RuleResult[] = [
    p.legal_name && p.tin_last4
      ? { rule: 'W9', label: 'Form W-9', outcome: 'met', reason: `Reads as ${p.legal_name}, TIN ending ${p.tin_last4}.`, expiresOn: null }
      : { rule: 'W9', label: 'Form W-9', outcome: 'not_met', reason: !p.legal_name ? 'The legal name (line 1) could not be read.' : 'The TIN could not be read.', expiresOn: null },
  ];
  const decisionId = await logAiDecision(admin, sub, W9_EXTRACT_FEATURE, res.model, res.correlationId, { kind: 'w9_extraction', submission_id: sub.id, w9: p });
  await logVendorComplianceEvent(admin, sub.org_id, sub.vendor_id, passed(rules) ? 'AI_CHECKED' : 'REQUIREMENT_FAILED', `AI read the W-9: ${rules[0].reason}`, { actor: 'system:ai', submissionId: sub.id });
  return save({ status: 'ai_checked', ai_status: 'done', ai_model: res.model, ai_decision_id: decisionId, ai_note: res.documentNote, extracted: { w9: p }, rule_results: rules, rules_passed: passed(rules), tin_last4: p.tin_last4 });
}

async function logAiDecision(admin: DB, sub: SubmissionRow, feature: string, model: string, correlationId: string | null, output: Record<string, unknown>): Promise<string | null> {
  // admin IS the service role (route / portal / scheduler); named so the write-lock scan sees it.
  const w = serviceWriter(admin);
  try {
    const { data } = await w
      .from('ai_decisions')
      .insert({
        org_id: sub.org_id,
        feature,
        model_used: model,
        correlation_id: correlationId,
        input_summary: `Vendor portal ${sub.doc_kind === 'W9' ? 'W-9' : 'COI'} read (submission ${sub.id})`,
        proposed_output: output,
        reasoning: 'Facts read from a vendor-submitted document and checked against the vendor requirement set. A person accepts or rejects; the model never writes the compliance record.',
        status: 'PROPOSED',
        created_by_user: null,
      })
      .select('id')
      .single();
    return (data as { id: string } | null)?.id ?? null;
  } catch {
    return null;
  }
}

// ── Review ───────────────────────────────────────────────────────────────────

export interface ReviewedCoverage {
  coverage_type: CoverageKind;
  carrier?: string | null;
  policy_number?: string | null;
  each_occurrence_cents: number | null;
  aggregate_cents: number | null;
  effective_date: string | null;
  expiration_date: string | null;
}

export interface AcceptInput {
  actor: string;
  note?: string | null;
  /** COI: the lines as the reviewer confirmed / keyed them (defaults to the AI read). */
  coverages?: ReviewedCoverage[];
  certificateHolder?: string | null;
  additionalInsured?: boolean | null;
  waiverOfSubrogation?: boolean | null;
  carrier?: string | null;
  policyNumber?: string | null;
  /** W-9: apply the 1099 signal from the entity type (default true). */
  apply1099Signal?: boolean;
}

export interface AcceptResult {
  submission: SubmissionRow;
  holdLifted: boolean;
  stillOnHold: boolean;
  remaining: string[];
  requestsFulfilled: number;
  billsReleased: number;
}

async function loadOpen(admin: DB, orgId: string, id: string): Promise<SubmissionRow> {
  const { data, error } = await admin.from('vendor_document_submissions').select(SUBMISSION_COLUMNS).eq('org_id', orgId).eq('id', id).maybeSingle();
  if (error) throw new ReviewError(`Could not read the submission: ${error.message}`, 500);
  if (!data) throw new ReviewError('Submission not found.', 404);
  const row = data as SubmissionRow;
  if (!OPEN_SUBMISSION.includes(row.status)) throw new ReviewError(`This submission was already ${row.status}.`, 409);
  return row;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Pure: validate the lines a reviewer is accepting. Returns an error sentence or null. */
export function validateCoverages(lines: ReadonlyArray<ReviewedCoverage>): string | null {
  if (lines.length === 0) return 'Key at least one coverage line (type, limit and expiration) before accepting.';
  for (const l of lines) {
    if (!(COVERAGE_TYPES as readonly string[]).includes(l.coverage_type)) return 'Pick a coverage type for every line.';
    if (!l.expiration_date || !ISO.test(l.expiration_date)) return 'Every coverage line needs an expiration date.';
    if (l.effective_date && !ISO.test(l.effective_date)) return 'Effective dates must be YYYY-MM-DD.';
    if (l.effective_date && l.expiration_date < l.effective_date) return 'An expiration date is before its effective date.';
    for (const v of [l.each_occurrence_cents, l.aggregate_cents]) if (v !== null && (!Number.isInteger(v) || v < 0)) return 'Limits must be whole cents, zero or more.';
    if (l.each_occurrence_cents === null && l.aggregate_cents === null && l.coverage_type !== 'WORKERS_COMP') return 'Every coverage line (other than statutory workers’ comp) needs a limit.';
  }
  return null;
}

async function upsertDoc(admin: DB, orgId: string, vendorId: string, docType: 'W9' | 'GL_COI' | 'WC_COI', patch: Record<string, unknown>): Promise<string> {
  // admin IS the service role (route / portal / scheduler); named so the write-lock scan sees it.
  const w = serviceWriter(admin);
  const { data: existing } = await w.from('vendor_compliance_docs').select('id').eq('org_id', orgId).eq('vendor_id', vendorId).eq('doc_type', docType).order('created_at', { ascending: true }).limit(1);
  const id = ((existing ?? [])[0] as { id: string } | undefined)?.id;
  if (id) {
    const { error } = await w.from('vendor_compliance_docs').update(patch).eq('org_id', orgId).eq('id', id);
    if (error) throw new ReviewError(`Could not update the ${docType} record: ${error.message}`, 500);
    return id;
  }
  const { data, error } = await w.from('vendor_compliance_docs').insert({ org_id: orgId, vendor_id: vendorId, doc_type: docType, ...patch }).select('id').single();
  if (error || !data) throw new ReviewError(`Could not create the ${docType} record: ${error?.message ?? 'no row'}`, 500);
  return (data as { id: string }).id;
}

const COMPLIANCE_HOLD_REASON = 'Vendor compliance documents missing or expired';

/** Bills put ON_HOLD at creation for compliance go back to PENDING once the vendor is clear. */
async function releaseComplianceBills(admin: DB, orgId: string, vendorId: string, actor: string, now: Date): Promise<number> {
  // admin IS the service role (route / portal / scheduler); named so the write-lock scan sees it.
  const w = serviceWriter(admin);
  const { data } = await w.from('bills').select('id, payment_hold_reason').eq('org_id', orgId).eq('vendor_id', vendorId).eq('status', 'ON_HOLD');
  let n = 0;
  for (const b of (data ?? []) as Array<{ id: string; payment_hold_reason: string | null }>) {
    if (b.payment_hold_reason !== COMPLIANCE_HOLD_REASON) continue;
    const { data: upd } = await w
      .from('bills')
      .update({ status: 'PENDING', payment_hold_reason: null, updated_at: now.toISOString() })
      .eq('org_id', orgId)
      .eq('id', b.id)
      .eq('status', 'ON_HOLD')
      .select('id');
    if (!upd || (Array.isArray(upd) && upd.length === 0)) continue;
    n++;
    await w.from('audit_log').insert({
      org_id: orgId,
      table_name: 'bills',
      record_id: b.id,
      action: 'UPDATE',
      field_name: 'payment_hold_release',
      old_value: COMPLIANCE_HOLD_REASON,
      new_value: 'RELEASED: vendor compliance documents accepted',
      user_id: actor,
    });
    await logVendorComplianceEvent(admin, orgId, vendorId, 'BILL_HOLD_RELEASED', 'Bill released from compliance hold — the vendor’s documents were accepted.', { actor, billId: b.id });
  }
  return n;
}

async function fulfilLiveRequests(admin: DB, orgId: string, vendorId: string, kind: DocKind, actor: string, now: Date): Promise<number> {
  const { data } = await admin
    .schema('core')
    .from('requests')
    .select('id')
    .eq('org_id', orgId)
    .eq('recipient_vendor_id', vendorId)
    .eq('kind', kind === 'W9' ? 'w9' : 'coi')
    .in('status', [...LIVE_STATUSES]);
  let n = 0;
  for (const r of (data ?? []) as Array<{ id: string }>) {
    try {
      await fulfilRequest({ db: admin, now: () => now }, orgId, r.id, actor, { via: 'app', note: 'Document accepted in review.' });
      n++;
    } catch {
      /* raced / already closed */
    }
  }
  return n;
}

/** All asked-for kinds of this portal link are accepted → the link has done its job. */
async function revokeSpentPortalLink(admin: DB, orgId: string, tokenId: string | null, now: Date): Promise<void> {
  // admin IS the service role (route / portal / scheduler); named so the write-lock scan sees it.
  const w = serviceWriter(admin);
  if (!tokenId) return;
  const { data: t } = await w.from('vendor_portal_tokens').select('id, vendor_id, requested_docs, status').eq('org_id', orgId).eq('id', tokenId).maybeSingle();
  const tok = t as { vendor_id: string; requested_docs: string[] | null; status: string } | null;
  if (!tok || tok.status !== 'ACTIVE') return;
  const kinds = (tok.requested_docs ?? []).filter((k) => k === 'W9' || k === 'COI');
  if (kinds.length === 0 || (tok.requested_docs ?? []).includes('BANKING')) return;
  const { data: subs } = await admin.from('vendor_document_submissions').select('doc_kind, status').eq('org_id', orgId).eq('vendor_id', tok.vendor_id).eq('portal_token_id', tokenId);
  const rows = (subs ?? []) as Array<{ doc_kind: string; status: string }>;
  const done = kinds.every((k) => rows.some((s) => s.doc_kind === k && s.status === 'accepted'));
  const open = rows.some((s) => s.status === 'received' || s.status === 'ai_checked');
  if (done && !open) await w.from('vendor_portal_tokens').update({ status: 'REVOKED', updated_at: now.toISOString() }).eq('org_id', orgId).eq('id', tokenId).eq('status', 'ACTIVE');
}

export async function acceptSubmission(admin: DB, orgId: string, id: string, input: AcceptInput, now: Date = new Date()): Promise<AcceptResult> {
  const sub = await loadOpen(admin, orgId, id);
  const before = await evaluateVendorCompliance(admin, orgId, sub.vendor_id, { now });
  const nowIso = now.toISOString();
  const docIds: string[] = [];
  const base = { status: 'VALID', verified_at: nowIso, verified_by_user: input.actor, submission_id: sub.id, updated_at: nowIso };

  if (sub.doc_kind === 'COI') {
    const proposal = sub.extracted?.coi;
    const lines: ReviewedCoverage[] =
      input.coverages ??
      (proposal?.coverages ?? []).map((c) => ({
        coverage_type: c.coverage_type as CoverageKind,
        each_occurrence_cents: c.each_occurrence_cents,
        aggregate_cents: c.aggregate_cents,
        effective_date: c.effective_date,
        expiration_date: c.expiration_date,
      }));
    const problem = validateCoverages(lines);
    if (problem) throw new ReviewError(sub.ai_status === 'done' ? problem : `${problem} (AI did not read this certificate.)`);
    const holder = input.certificateHolder !== undefined ? input.certificateHolder : proposal?.certificate_holder ?? null;
    const ai = input.additionalInsured !== undefined ? input.additionalInsured : proposal?.additional_insured ?? null;
    const wos = input.waiverOfSubrogation !== undefined ? input.waiverOfSubrogation : proposal?.waiver_of_subrogation ?? null;
    const carrier = input.carrier !== undefined ? input.carrier : proposal?.carrier ?? null;
    const policy = input.policyNumber !== undefined ? input.policyNumber : proposal?.policy_number ?? null;
    const types = Array.from(new Set(lines.map((l) => l.coverage_type)));
    await admin.from('vendor_coverages').update({ is_active: false }).eq('org_id', orgId).eq('vendor_id', sub.vendor_id).eq('is_active', true).in('coverage_type', types);
    const { error: covErr } = await admin.from('vendor_coverages').insert(
      lines.map((l) => ({
        org_id: orgId,
        vendor_id: sub.vendor_id,
        submission_id: sub.id,
        coverage_type: l.coverage_type,
        carrier: l.carrier ?? carrier,
        policy_number: l.policy_number ?? policy,
        each_occurrence_cents: l.each_occurrence_cents,
        aggregate_cents: l.aggregate_cents,
        effective_date: l.effective_date,
        expiration_date: l.expiration_date,
        additional_insured: l.coverage_type === 'GENERAL_LIABILITY' ? ai : null,
        waiver_of_subrogation: wos,
        certificate_holder: holder,
        is_active: true,
      })),
    );
    if (covErr) throw new ReviewError(`Could not save the coverage lines: ${covErr.message}`, 500);
    for (const [cov, docType] of [['GENERAL_LIABILITY', 'GL_COI'], ['WORKERS_COMP', 'WC_COI']] as const) {
      const line = lines.filter((l) => l.coverage_type === cov).sort((a, b) => (b.expiration_date ?? '').localeCompare(a.expiration_date ?? ''))[0];
      if (!line) continue;
      docIds.push(await upsertDoc(admin, orgId, sub.vendor_id, docType, { ...base, issued_date: line.effective_date, expiration_date: line.expiration_date, coverage_amount_cents: line.each_occurrence_cents }));
    }
  } else {
    const form = sub.w9_form;
    const read = sub.extracted?.w9;
    // A typed W-9 whose TIN could not be encrypted (no TIN_ENCRYPTION_KEY when it was
    // submitted) holds only the last four — useless for 1099s / TIN matching. Refuse to
    // mark the vendor's W-9 as on file from it.
    if (sub.source === 'portal_w9_form' && form && !form.tin_stored) {
      throw new ReviewError(W9_TIN_NOT_STORED_MESSAGE, 409);
    }
    docIds.push(await upsertDoc(admin, orgId, sub.vendor_id, 'W9', { ...base, issued_date: (form?.signed_at ?? nowIso).slice(0, 10), expiration_date: null }));
    const vendorPatch: Record<string, unknown> = { updated_at: nowIso };
    const { data: v } = await admin.schema('core').from('vendors').select('w9_status').eq('org_id', orgId).eq('id', sub.vendor_id).maybeSingle();
    if (((v as { w9_status?: string | null } | null)?.w9_status ?? 'MISSING') === 'MISSING') vendorPatch.w9_status = 'RECEIVED';
    const signal = form?.is_1099_eligible_signal ?? read?.is_1099_eligible_signal ?? null;
    if ((input.apply1099Signal ?? true) && typeof signal === 'boolean') vendorPatch.is_1099_eligible = signal;
    if (Object.keys(vendorPatch).length > 1) await admin.schema('core').from('vendors').update(vendorPatch).eq('org_id', orgId).eq('id', sub.vendor_id);
  }

  const { data: updRows, error: updErr } = await admin
    .from('vendor_document_submissions')
    .update({ status: 'accepted', reviewed_by: input.actor, reviewed_at: nowIso, decision_reason: input.note?.trim() || null, accepted_doc_ids: docIds, updated_at: nowIso })
    .eq('org_id', orgId)
    .eq('id', id)
    .in('status', OPEN_SUBMISSION)
    .select(SUBMISSION_COLUMNS);
  const updated = (Array.isArray(updRows) ? updRows[0] : null) as SubmissionRow | null;
  if (updErr || !updated) throw new ReviewError('This submission was decided by someone else a moment ago.', 409);

  await logVendorComplianceEvent(admin, orgId, sub.vendor_id, 'DOC_ACCEPTED', `${sub.doc_kind === 'W9' ? 'W-9' : 'Certificate of insurance'} accepted${input.note?.trim() ? `: ${input.note.trim()}` : ''}.`, { actor: input.actor, submissionId: id, docId: docIds[0] ?? null });

  const after = await evaluateVendorCompliance(admin, orgId, sub.vendor_id, { now });
  const holdLifted = before.onHold && !after.onHold;
  if (holdLifted) await logVendorComplianceEvent(admin, orgId, sub.vendor_id, 'HOLD_LIFTED', 'Payment hold lifted — every requirement is met.', { actor: input.actor, submissionId: id });
  const requestsFulfilled = await fulfilLiveRequests(admin, orgId, sub.vendor_id, sub.doc_kind, input.actor, now);
  const billsReleased = after.blocks ? 0 : await releaseComplianceBills(admin, orgId, sub.vendor_id, input.actor, now);
  await revokeSpentPortalLink(admin, orgId, sub.portal_token_id, now);
  return {
    submission: updated,
    holdLifted,
    stillOnHold: after.onHold,
    remaining: after.issues.map((i) => i.reason ?? `${i.label} ${i.state}`),
    requestsFulfilled,
    billsReleased,
  };
}

export interface RejectResult {
  submission: SubmissionRow;
  requestId: string | null;
  requestCreated: boolean;
  noEmail: boolean;
}

export async function rejectSubmission(admin: DB, orgId: string, id: string, input: { actor: string; reason: string; ownerMembershipId?: string | null }, now: Date = new Date()): Promise<RejectResult> {
  const why = input.reason.trim();
  if (why.length < 3) throw new ReviewError('Say what is wrong — the vendor sees this reason.');
  const sub = await loadOpen(admin, orgId, id);
  const nowIso = now.toISOString();
  const { data: updRows } = await admin
    .from('vendor_document_submissions')
    .update({ status: 'rejected', reviewed_by: input.actor, reviewed_at: nowIso, decision_reason: why.slice(0, 1000), updated_at: nowIso })
    .eq('org_id', orgId)
    .eq('id', id)
    .in('status', OPEN_SUBMISSION)
    .select(SUBMISSION_COLUMNS);
  const updated = (Array.isArray(updRows) ? updRows[0] : null) as SubmissionRow | null;
  if (!updated) throw new ReviewError('This submission was decided by someone else a moment ago.', 409);
  await logVendorComplianceEvent(admin, orgId, sub.vendor_id, 'DOC_REJECTED', `${sub.doc_kind === 'W9' ? 'W-9' : 'Certificate of insurance'} rejected: ${why}`, { actor: input.actor, submissionId: id });

  // Re-request, quoting the reason (a correction request; the 30-day cool-down does not apply).
  const { data: v } = await admin.schema('core').from('vendors').select('id, name, display_name, email').eq('org_id', orgId).eq('id', sub.vendor_id).maybeSingle();
  const vendor = v as { id: string; name: string; display_name: string | null; email: string | null } | null;
  if (!vendor) return { submission: updated, requestId: null, requestCreated: false, noEmail: true };
  const ctx = await loadPolicyContext(admin, orgId);
  const kind = sub.doc_kind === 'W9' ? 'w9' : 'coi';
  const name = vendor.display_name || vendor.name;
  const res = await createVendorDocRequest({ db: admin, now: () => now }, ctx, {
    orgId,
    vendor: { id: vendor.id, name, email: vendor.email },
    need: kind === 'w9' ? { kind: 'w9', docTypes: ['W9'], renewal: false, dueDate: null } : { kind: 'coi', docTypes: ['GL_COI'], renewal: false, dueDate: null },
    createdBy: input.actor,
    ownerMembershipId: input.ownerMembershipId ?? null,
    source: 'manual',
    copy: {
      title: kind === 'w9' ? 'We need a corrected W-9' : 'We need a corrected certificate of insurance',
      message: `We could not accept the ${kind === 'w9' ? 'W-9' : 'certificate of insurance'} you sent for ${name}: ${why}\n\nPlease send a corrected one with the button below${kind === 'coi' ? ' (or forward this to your insurance agent)' : ''}.`,
    },
  });
  return { submission: updated, requestId: res.request.id, requestCreated: res.created, noEmail: !vendor.email };
}
