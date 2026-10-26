/**
 * Document intelligence — the orchestration service (FPB-document-intelligence §7).
 *
 *   registerDocument   on upload: deterministic class + SHA-256 + company suggestion, at once
 *   analyzeDocument    the full read: duplicate check → rules → AI classify (gateway) → merge
 *                      → company → route to the modules' existing extractors → proposals;
 *                      AI down → rules result stands + retry scheduled (never a 5xx)
 *   backfillOrg        "Analyze existing documents" — every eligible doc without a row
 *   retryDue           the `documents.classify_retry` job body
 *   acceptProposal / dismissProposal / dismissDocument / changeType / setCompany /
 *   linkExisting / syncNative  — the human decisions and the native-queue sync
 *
 * TENANCY: `deps.db` is the SERVICE ROLE (migration 188 tables are member read-only).
 * Every read and write is pinned to `orgId`; routes run their permission check and
 * client-scope assertion BEFORE calling in, and pass `canDraft` so no module draft is
 * made for a person without that module's gate + the document's company in scope.
 * Canon §3: nothing here writes the GL — the proposals are completed by each module's
 * own create path.
 *
 * TAXPAYER IDs (security review H4): every file passes the TIN screen (tin-guard.ts)
 * before any AI call. A TIN-bearing form is typed by rules and never sent to AI; a scan
 * with nothing safe to go on waits for a person (needs_review) instead of the AI read;
 * TIN-shaped strings are redacted from every text column, payload and AI prompt.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { classifyWithAi, DOCUMENT_CLASSIFY_FEATURE, type ClassifyFn } from './ai-classify';
import { extractable, isStagedKind, runModuleExtractor, type ExtractImpl } from './extract';
import { defaultNative, matchVendor, type NativeImpl } from './native';
import { resolveRecord } from './records';
import {
  classifyDeterministic,
  counterpartyFromText,
  keyDatesFromText,
  largestAmountCents,
  mergeClass,
  suggestCompany,
  type AiClassOpinion,
  type CompanyOption,
  type RuleResult,
} from './rules';
import { effectiveMediaType, readScreenText, readTextSample, sha256Hex, type TextSample } from './text';
import { redactDeep, redactFields, redactTin } from './redact';
import { TIN_REVIEW_REASON, screenForTin, tinExtractBlocked, tinFormReason, tinScreenedClass, type TinScreen } from './tin-guard';
import {
  CLASS_TARGETS,
  CLASS_TO_DOC_TYPE,
  DOC_CLASS_LABEL,
  MAX_AI_ATTEMPTS,
  ROUTE_MIN_CONFIDENCE,
  TARGETS,
  foundMessage,
  needsAccessMessage,
  type AiState,
  type ClassSource,
  type DocClass,
  type IntelligenceDto,
  type IntelligenceSource,
  type IntelligenceStatus,
  type LocationSource,
  type ProposalDto,
  type TargetKind,
} from './types';

// ── Rows ────────────────────────────────────────────────────────────────────

export interface DocRow {
  id: string;
  org_id: string;
  storage_path: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  doc_type: string;
  entity_type: string | null;
  entity_id: string | null;
  created_at: string;
}

export interface IntelRow extends IntelligenceDto {
  org_id: string;
  content_sha256: string | null;
  rules_class: DocClass | null;
  rules_confidence: number | null;
  ai_last_error: string | null;
  ai_model: string | null;
  ai_decision_id: string | null;
  company_hint: string | null;
  created_at: string;
}

export interface ProposalRow extends ProposalDto {
  org_id: string;
  intelligence_id: string | null;
  content_sha256: string | null;
  decided_by: string | null;
  decided_at: string | null;
}

// ── Deps ────────────────────────────────────────────────────────────────────

export interface IntelDeps {
  /** Service-role client (writes migration-188 tables; every query org-pinned). */
  db: SupabaseClient;
  anthropicApiKey: string | null;
  now: () => Date;
  /** Read a document's bytes from the private bucket (path validated by the caller's impl). */
  loadBytes: (doc: DocRow) => Promise<Uint8Array | null>;
  classify?: ClassifyFn;
  extract?: ExtractImpl;
  native?: NativeImpl;
}

/**
 * May the person running this read have a draft made in the target module? (Its own
 * gate + the document's company inside their client scope.) Absent = a system run (the
 * retry job), which still respects an earlier "needs access" answer.
 */
export type DraftAuthorizer = (kind: TargetKind, locationId: string | null) => Promise<boolean>;

/** Text columns of migration 188 rows that are TIN-redacted before every write. */
const REDACT_KEYS = ['summary', 'counterparty', 'reason', 'title', 'last_error', 'ai_last_error', 'decision_note', 'company_hint', 'payload'] as const;

export class IntelligenceError extends Error {
  constructor(message: string, readonly status: number = 400, readonly code: string = 'INTELLIGENCE_ERROR') {
    super(message);
    this.name = 'IntelligenceError';
  }
}

/** Bytes larger than this are hashed and typed by name only — never sent to AI. */
export const AI_MAX_BYTES = 15 * 1024 * 1024;

const FINAL_STATUSES: ReadonlySet<IntelligenceStatus> = new Set(['dismissed', 'accepted', 'linked', 'duplicate']);

/** A document a module filed itself (lease parse, AP intake, receipts, email) is not re-proposed. */
export function isEligible(doc: Pick<DocRow, 'entity_type'>): boolean {
  return doc.entity_type == null || doc.entity_type === 'location';
}

/** Minutes until the next AI attempt. */
export function retryDelayMinutes(kind: Exclude<AiState, 'pending' | 'done' | 'skipped'>, attempts: number): number {
  if (kind === 'budget_blocked') return 60;
  if (kind === 'unavailable') return 15;
  return Math.min(360, 15 * 2 ** Math.max(0, attempts - 1));
}

function iso(d: Date): string {
  return d.toISOString();
}

function isUniqueViolation(e: { code?: string; message?: string } | null | undefined): boolean {
  return !!e && (e.code === '23505' || /duplicate key|unique/i.test(e.message ?? ''));
}

// ── Loads ───────────────────────────────────────────────────────────────────

async function loadDoc(db: SupabaseClient, orgId: string, documentId: string): Promise<DocRow | null> {
  const { data } = await db
    .from('documents')
    .select('id, org_id, storage_path, file_name, mime_type, size_bytes, doc_type, entity_type, entity_id, created_at')
    .eq('org_id', orgId)
    .eq('id', documentId)
    .maybeSingle();
  return (data as DocRow | null) ?? null;
}

export async function loadIntel(db: SupabaseClient, orgId: string, documentId: string): Promise<IntelRow | null> {
  const { data } = await db.from('document_intelligence').select('*').eq('org_id', orgId).eq('document_id', documentId).maybeSingle();
  return (data as IntelRow | null) ?? null;
}

async function loadProposals(db: SupabaseClient, orgId: string, documentId: string): Promise<ProposalRow[]> {
  const { data } = await db.from('document_proposals').select('*').eq('org_id', orgId).eq('document_id', documentId).order('created_at', { ascending: true });
  return (data as ProposalRow[] | null) ?? [];
}

async function loadCompanies(db: SupabaseClient, orgId: string): Promise<CompanyOption[]> {
  const { data } = await db.schema('core').from('locations').select('id, name, short_code, is_active').eq('org_id', orgId);
  return ((data ?? []) as Array<CompanyOption & { is_active?: boolean | null }>).filter((l) => l.is_active !== false);
}

async function patchIntel(db: SupabaseClient, orgId: string, id: string, patch: Record<string, unknown>, now: Date): Promise<IntelRow> {
  const { data, error } = await db
    .from('document_intelligence')
    .update({ ...redactFields(patch, REDACT_KEYS), updated_at: iso(now) })
    .eq('org_id', orgId)
    .eq('id', id)
    .select('*')
    .single();
  if (error || !data) throw new IntelligenceError(`Could not save the document analysis: ${error?.message ?? 'no row'}`, 500, 'SAVE_FAILED');
  return data as IntelRow;
}

async function patchProposal(db: SupabaseClient, orgId: string, id: string, patch: Record<string, unknown>, now: Date): Promise<ProposalRow> {
  const { data, error } = await db
    .from('document_proposals')
    .update({ ...redactFields(patch, REDACT_KEYS), updated_at: iso(now) })
    .eq('org_id', orgId)
    .eq('id', id)
    .select('*')
    .single();
  if (error || !data) throw new IntelligenceError(`Could not save the proposal: ${error?.message ?? 'no row'}`, 500, 'SAVE_FAILED');
  return data as ProposalRow;
}

async function logDecision(
  db: SupabaseClient,
  row: { orgId: string; locationId: string | null; feature: string; model: string | null; correlationId: string | null; summary: string; output: Record<string, unknown>; confidence: number | null; reasoning: string; userId: string | null },
): Promise<string | null> {
  try {
    // ai_decisions is member read-only (migration 172): `db` is the service role here.
    const writer = serviceWriter(db);
    const { data } = await writer
      .from('ai_decisions')
      .insert({
        org_id: row.orgId,
        location_id: row.locationId,
        feature: row.feature,
        model_requested: null,
        model_used: row.model,
        correlation_id: row.correlationId,
        input_summary: redactTin(row.summary).slice(0, 2000),
        proposed_output: redactDeep(row.output),
        confidence: row.confidence,
        reasoning: redactTin(row.reasoning),
        status: 'PROPOSED',
        created_by_user: row.userId,
      })
      .select('id')
      .single();
    return (data as { id: string } | null)?.id ?? null;
  } catch {
    return null;
  }
}

// ── Read the file ───────────────────────────────────────────────────────────

interface FileRead {
  bytes: Uint8Array | null;
  mediaType: string;
  sample: TextSample;
  /** Everything readable for the TIN screen ('' for a photo / scan). */
  screenText: string;
  sha: string | null;
}

async function readFile(deps: IntelDeps, doc: DocRow, given?: Uint8Array | null): Promise<FileRead> {
  let bytes: Uint8Array | null = given ?? null;
  if (!bytes) {
    try {
      bytes = await deps.loadBytes(doc);
    } catch {
      bytes = null;
    }
  }
  if (!bytes || bytes.length === 0) {
    return { bytes: null, mediaType: doc.mime_type ?? 'application/octet-stream', sample: { text: '', cells: [], sheetSample: null, kind: 'other' }, screenText: '', sha: null };
  }
  const mediaType = effectiveMediaType(bytes, doc.mime_type, doc.file_name);
  const sample = readTextSample(bytes, mediaType, doc.file_name);
  return { bytes, mediaType, sample, screenText: readScreenText(bytes, mediaType, sample), sha: sha256Hex(bytes) };
}

/** The TIN screen for a read file (H4). `userClass` = the type a person chose, if any. */
function screenFile(doc: DocRow, file: FileRead, rules: RuleResult, userClass: DocClass | null): TinScreen {
  return screenForTin({
    fileName: doc.file_name,
    screenText: file.screenText,
    readableText: file.sample.text,
    rulesClass: rules.docClass,
    rulesConfidence: rules.confidence,
    userClass,
  });
}

// ── Register (on upload) ────────────────────────────────────────────────────

export interface Preset {
  docClass: DocClass;
  confidence: number;
  source: ClassSource;
}

export interface RegisterInput {
  orgId: string;
  documentId: string;
  userId: string | null;
  source: IntelligenceSource;
  bytes?: Uint8Array | null;
  uploadLocationId?: string | null;
  preset?: Preset | null;
}

function applyPreset(rules: RuleResult, preset: Preset | null | undefined): { docClass: DocClass; confidence: number; source: ClassSource } {
  if (!preset || preset.docClass === 'other') return { docClass: rules.docClass, confidence: rules.confidence, source: 'rules' };
  if (preset.source === 'user') return { docClass: preset.docClass, confidence: 1, source: 'user' };
  if (preset.source === 'ai') return mergeClass({ docClass: preset.docClass, confidence: preset.confidence, summary: null }, rules);
  return preset.confidence >= rules.confidence ? { docClass: preset.docClass, confidence: preset.confidence, source: 'rules' } : { docClass: rules.docClass, confidence: rules.confidence, source: 'rules' };
}

/**
 * Write the intelligence row for a freshly stored document (idempotent: an existing row
 * is returned as is, except that a user-chosen preset overrides a machine class).
 * Returns null for documents a module already filed (not eligible) or unknown ids.
 */
export async function registerDocument(deps: IntelDeps, input: RegisterInput): Promise<IntelRow | null> {
  const now = deps.now();
  const doc = await loadDoc(deps.db, input.orgId, input.documentId);
  if (!doc || !isEligible(doc)) return null;

  const existing = await loadIntel(deps.db, input.orgId, doc.id);
  if (existing) {
    if (input.preset?.source === 'user' && existing.class_source !== 'user' && !FINAL_STATUSES.has(existing.status)) {
      return patchIntel(deps.db, input.orgId, existing.id, { doc_class: input.preset.docClass, confidence: 1, class_source: 'user' }, now);
    }
    return existing;
  }

  const file = await readFile(deps, doc, input.bytes);
  const rules = classifyDeterministic({ fileName: doc.file_name, text: file.sample.text, cells: file.sample.cells });
  const cls = applyPreset(rules, input.preset);
  const companies = await loadCompanies(deps.db, input.orgId);
  const uploadLoc = input.uploadLocationId ?? (doc.entity_type === 'location' ? doc.entity_id : null);
  const company = suggestCompany(companies, { uploadLocationId: uploadLoc, text: file.sample.text });

  const row = {
    org_id: input.orgId,
    document_id: doc.id,
    location_id: company.locationId,
    location_source: company.source,
    content_sha256: file.sha,
    doc_class: cls.docClass,
    confidence: Number(cls.confidence.toFixed(3)),
    class_source: cls.source,
    rules_class: rules.docClass,
    rules_confidence: Number(rules.confidence.toFixed(3)),
    status: 'queued' as IntelligenceStatus,
    ai_status: (deps.anthropicApiKey ? 'pending' : 'unavailable') as AiState,
    counterparty: counterpartyFromText(file.sample.text, cls.docClass),
    key_dates: keyDatesFromText(file.sample.text),
    amount_cents: largestAmountCents(file.sample.text),
    reason: cls.source === 'user' ? 'You chose this type.' : rules.reason || null,
    text_chars: file.sample.text.length,
    source: input.source,
    classified_at: iso(now),
    created_by: input.userId,
    created_at: iso(now),
    updated_at: iso(now),
  };
  const { data, error } = await deps.db.from('document_intelligence').insert(redactFields(row, REDACT_KEYS)).select('*').single();
  if (error) {
    if (isUniqueViolation(error)) return loadIntel(deps.db, input.orgId, doc.id);
    throw new IntelligenceError(`Could not record the document analysis: ${error.message}`, 500, 'SAVE_FAILED');
  }
  return data as IntelRow;
}

// ── Analyze ─────────────────────────────────────────────────────────────────

export interface AnalyzeInput extends RegisterInput {
  /** Re-run AI even when a prior AI answer exists (Change type does not need this). */
  force?: boolean;
  /** The caller's module gate + client scope for drafts (routes always pass it). */
  canDraft?: DraftAuthorizer;
}

export interface AnalyzeResult {
  intelligence: IntelRow | null;
  proposals: ProposalRow[];
  /** Plain-English outcome for a toast / the onboarding card. */
  message: string;
  skipped?: 'not_eligible' | 'final';
}

type AiFailure = Exclude<AiState, 'pending' | 'done' | 'skipped'>;

interface RouteCtx {
  deps: IntelDeps;
  orgId: string;
  userId: string | null;
  doc: DocRow;
  intel: IntelRow;
  file: FileRead;
  docClass: DocClass;
  locationId: string | null;
  counterparty: string | null;
  now: Date;
  /** The TIN screen cleared this file for AI (H4). False → no extractor / AI draft at all. */
  aiAllowed: boolean;
  /** The screen's verdict (picks the "not read by AI" wording). */
  screen: TinScreen['verdict'];
  canDraft?: DraftAuthorizer;
}

interface RouteResult {
  proposals: ProposalRow[];
  extractPending: boolean;
  failure: AiFailure | null;
  failureMessage: string | null;
}

function defaultTitle(kind: TargetKind, doc: DocRow, counterparty: string | null): string {
  const t = TARGETS[kind];
  return counterparty ? `${t.noun[0].toUpperCase()}${t.noun.slice(1)} — ${counterparty}` : `${t.noun[0].toUpperCase()}${t.noun.slice(1)} — ${doc.file_name}`;
}

async function ensureProposal(ctx: RouteCtx, kind: TargetKind): Promise<{ row: ProposalRow | null; duplicateOf: string | null }> {
  const { deps, orgId, doc } = ctx;
  const existing = (await loadProposals(deps.db, orgId, doc.id)).find((p) => p.target_kind === kind);
  if (existing) return { row: existing, duplicateOf: null };

  // Same bytes already proposed for this module from another document → never a second one.
  if (ctx.file.sha) {
    const { data: twin } = await deps.db
      .from('document_proposals')
      .select('id, document_id, status')
      .eq('org_id', orgId)
      .eq('content_sha256', ctx.file.sha)
      .eq('target_kind', kind)
      .in('status', ['pending', 'accepted'])
      .limit(1);
    const t = (twin as Array<{ document_id: string }> | null)?.[0];
    if (t && t.document_id !== doc.id) return { row: null, duplicateOf: t.document_id };
  }

  const spec = TARGETS[kind];
  const { data, error } = await deps.db
    .from('document_proposals')
    .insert({
      org_id: orgId,
      document_id: doc.id,
      intelligence_id: ctx.intel.id,
      location_id: ctx.locationId,
      target_kind: kind,
      mode: spec.mode,
      status: 'pending',
      extract_state: spec.mode === 'route' ? 'not_needed' : 'pending',
      payload: {},
      title: redactTin(defaultTitle(kind, doc, ctx.counterparty)),
      summary: null,
      target_href: spec.href,
      content_sha256: ctx.file.sha,
      extractor_feature: spec.extractorFeature,
      created_by: ctx.userId,
      created_at: iso(ctx.now),
      updated_at: iso(ctx.now),
    })
    .select('*')
    .single();
  if (error) {
    if (isUniqueViolation(error)) {
      const again = (await loadProposals(deps.db, orgId, doc.id)).find((p) => p.target_kind === kind);
      return again ? { row: again, duplicateOf: null } : { row: null, duplicateOf: 'unknown' };
    }
    throw new IntelligenceError(`Could not create the proposal: ${error.message}`, 500, 'SAVE_FAILED');
  }
  return { row: data as ProposalRow, duplicateOf: null };
}

async function routeDocument(ctx: RouteCtx): Promise<RouteResult & { duplicateOf: string | null }> {
  const { deps, orgId, doc, file, now } = ctx;
  const extract = deps.extract ?? runModuleExtractor;
  const native = deps.native ?? defaultNative;
  const key = deps.anthropicApiKey;
  const out: RouteResult & { duplicateOf: string | null } = { proposals: [], extractPending: false, failure: null, failureMessage: null, duplicateOf: null };
  const noteFailure = (kind: AiFailure, msg: string) => {
    if (!out.failure || kind === 'failed') {
      out.failure = kind;
      out.failureMessage = msg;
    }
  };
  // H4: the bytes only ever leave for an AI read when the TIN screen cleared the file.
  const base64 = ctx.aiAllowed && file.bytes && file.bytes.length <= AI_MAX_BYTES ? Buffer.from(file.bytes).toString('base64') : null;

  /**
   * M: a draft in a module needs that module's gate + the document's company in scope for
   * the person who ran the read. A system run (no authorizer) keeps an earlier refusal.
   */
  const blocked = (moduleLabel: string): string =>
    ctx.screen === 'tin_form' ? tinExtractBlocked(moduleLabel) : `Confirm this document’s type to have it read — or enter the details in ${moduleLabel}.`;
  const mayDraft = async (kind: TargetKind, p: ProposalRow): Promise<boolean> => {
    if (ctx.canDraft) return ctx.canDraft(kind, ctx.locationId);
    return p.last_error !== needsAccessMessage(kind);
  };

  for (const kind of CLASS_TARGETS[ctx.docClass]) {
    if (kind === 'filed') continue;
    const { row, duplicateOf } = await ensureProposal(ctx, kind);
    if (!row) {
      out.duplicateOf = duplicateOf;
      continue;
    }
    let p = row;
    if (p.status !== 'pending' || p.extract_state === 'done' || p.extract_state === 'not_needed') {
      out.proposals.push(p);
      continue;
    }

    if (isStagedKind(kind)) {
      if (!ctx.aiAllowed) {
        p = await patchProposal(deps.db, orgId, p.id, { extract_state: 'failed', location_id: ctx.locationId, last_error: blocked(TARGETS[kind].moduleLabel) }, now);
      } else if (!base64 || !extractable(file.mediaType)) {
        p = await patchProposal(deps.db, orgId, p.id, { extract_state: 'failed', last_error: 'This file type can’t be read automatically — open it and enter the details in the module.' }, now);
      } else if (!(await mayDraft(kind, p))) {
        p = await patchProposal(deps.db, orgId, p.id, { location_id: ctx.locationId, last_error: needsAccessMessage(kind) }, now);
      } else if (!key) {
        out.extractPending = true;
        noteFailure('unavailable', 'AI is not configured.');
        p = await patchProposal(deps.db, orgId, p.id, { location_id: ctx.locationId, last_error: 'AI is paused — the terms will be read when it is back.' }, now);
      } else {
        const r = await extract(kind, { supabase: deps.db, anthropicApiKey: key }, { orgId, userId: ctx.userId, base64, mediaType: file.mediaType, fileName: doc.file_name, documentId: doc.id });
        if (r.ok) {
          const payload = redactDeep(r.payload);
          const decisionId = await logDecision(deps.db, {
            orgId,
            locationId: ctx.locationId,
            feature: r.feature,
            model: r.model,
            correlationId: r.correlationId,
            summary: `Document intelligence — ${doc.file_name}`,
            output: { kind: `${kind}_extraction`, source: 'document_intelligence', document_id: doc.id, ...payload },
            confidence: r.confidence,
            reasoning: `Extracted from a stored document and proposed in ${TARGETS[kind].moduleLabel} for review. The module's own create path finalizes it — nothing is posted here.`,
            userId: ctx.userId,
          });
          const m = (payload.meta ?? {}) as Record<string, unknown>;
          p = await patchProposal(deps.db, orgId, p.id, {
            payload: { ...payload, meta: { ...m, decisionId } },
            title: r.title || p.title,
            summary: r.summary || null,
            confidence: r.confidence,
            extract_state: 'done',
            extractor_model: r.model,
            ai_decision_id: decisionId,
            location_id: ctx.locationId,
            last_error: null,
          }, now);
        } else if (r.kind === 'failed') {
          noteFailure('failed', r.error);
          p = await patchProposal(deps.db, orgId, p.id, { extract_state: (ctx.intel.ai_attempts ?? 0) + 1 >= MAX_AI_ATTEMPTS ? 'failed' : 'pending', last_error: r.error.slice(0, 500) }, now);
          if (p.extract_state === 'pending') out.extractPending = true;
        } else {
          out.extractPending = true;
          noteFailure(r.kind, r.error);
          p = await patchProposal(deps.db, orgId, p.id, { last_error: 'AI is paused — the terms will be read when it is back.' }, now);
        }
      }
    } else if (kind === 'bill') {
      if (!ctx.locationId) {
        p = await patchProposal(deps.db, orgId, p.id, { last_error: 'Pick the company this bill belongs to.' }, now);
      } else if (!ctx.aiAllowed) {
        p = await patchProposal(deps.db, orgId, p.id, { extract_state: 'failed', location_id: ctx.locationId, last_error: blocked('Bills') }, now);
      } else if (!base64 || !extractable(file.mediaType)) {
        p = await patchProposal(deps.db, orgId, p.id, { extract_state: 'failed', last_error: 'This file type can’t be read automatically — enter the bill in Bills.' }, now);
      } else if (!(await mayDraft(kind, p))) {
        p = await patchProposal(deps.db, orgId, p.id, { location_id: ctx.locationId, last_error: needsAccessMessage(kind) }, now);
      } else if (!key) {
        out.extractPending = true;
        noteFailure('unavailable', 'AI is not configured.');
      } else {
        const r = await native.createBillDraft(deps.db, { orgId, userId: ctx.userId, base64, mediaType: file.mediaType, fileName: doc.file_name, locationId: ctx.locationId, documentId: doc.id, anthropicApiKey: key });
        if (r.ok) {
          p = await patchProposal(deps.db, orgId, p.id, { native_table: r.nativeTable, native_id: r.nativeId, title: r.title, summary: r.summary || null, confidence: r.confidence, extract_state: 'done', location_id: ctx.locationId, last_error: null }, now);
        } else if (r.kind === 'failed' || r.kind === 'needs_input') {
          p = await patchProposal(deps.db, orgId, p.id, { last_error: r.error.slice(0, 500) }, now);
          noteFailure('failed', r.error);
          out.extractPending = true;
        } else {
          out.extractPending = true;
          noteFailure(r.kind, r.error);
        }
      }
    } else if (kind === 'vendor_coi' || kind === 'vendor_w9') {
      const vendor = await matchVendor(deps.db, orgId, ctx.counterparty);
      if (!vendor) {
        p = await patchProposal(deps.db, orgId, p.id, { last_error: 'Choose the vendor this belongs to.' }, now);
      } else if (!(await mayDraft(kind, p))) {
        p = await patchProposal(deps.db, orgId, p.id, { last_error: needsAccessMessage(kind) }, now);
      } else {
        const r = await native.createVendorSubmission(deps.db, {
          orgId,
          userId: ctx.userId,
          vendorId: vendor.id,
          docKind: kind === 'vendor_w9' ? 'W9' : 'COI',
          documentId: doc.id,
          // A W-9 never goes to AI (D6 + H4); a COI only when the screen cleared it.
          base64: kind === 'vendor_coi' ? base64 : null,
          mediaType: file.mediaType,
          anthropicApiKey: key,
        });
        if (r.ok) {
          p = await patchProposal(deps.db, orgId, p.id, { native_table: r.nativeTable, native_id: r.nativeId, title: `${r.title} — ${vendor.name}`, summary: r.summary, extract_state: 'done', last_error: null }, now);
        } else {
          p = await patchProposal(deps.db, orgId, p.id, { last_error: r.error.slice(0, 500) }, now);
        }
      }
    }
    out.proposals.push(p);
  }
  return out;
}

/**
 * The full read of one document. Idempotent: re-running never creates a second proposal
 * of a kind; a document whose bytes match an earlier one is marked duplicate.
 */
export async function analyzeDocument(deps: IntelDeps, input: AnalyzeInput): Promise<AnalyzeResult> {
  const now = deps.now();
  const registered = await registerDocument(deps, input);
  if (!registered) return { intelligence: null, proposals: [], message: 'This document is already filed by the module it came from.', skipped: 'not_eligible' };
  let intel = registered;
  if (FINAL_STATUSES.has(intel.status) && !input.force) {
    return { intelligence: intel, proposals: await loadProposals(deps.db, input.orgId, intel.document_id), message: 'Already handled.', skipped: 'final' };
  }
  const doc = await loadDoc(deps.db, input.orgId, intel.document_id);
  if (!doc) throw new IntelligenceError('Document not found', 404, 'NOT_FOUND');

  const file = await readFile(deps, doc, input.bytes);
  if (!file.bytes) {
    intel = await patchIntel(deps.db, input.orgId, intel.id, { status: 'needs_review', reason: 'The file could not be read from storage.', next_retry_at: null }, now);
    return { intelligence: intel, proposals: [], message: 'We could not open this file — check it in Documents.' };
  }

  // 1. Duplicate of an earlier document?
  if (file.sha) {
    const { data: twins } = await deps.db
      .from('document_intelligence')
      .select('document_id, status, created_at')
      .eq('org_id', input.orgId)
      .eq('content_sha256', file.sha)
      .neq('document_id', doc.id)
      .order('created_at', { ascending: true })
      .limit(5);
    const first = ((twins ?? []) as Array<{ document_id: string; status: IntelligenceStatus; created_at: string }>).find((t) => t.status !== 'dismissed' && t.created_at <= intel.created_at);
    if (first) {
      intel = await patchIntel(deps.db, input.orgId, intel.id, { status: 'duplicate', duplicate_of: first.document_id, content_sha256: file.sha, next_retry_at: null, reason: 'Same file as one already in Documents.' }, now);
      return { intelligence: intel, proposals: [], message: 'This is the same file as one already in your documents — nothing new was proposed.' };
    }
  }

  // 2. Rules (always).
  const rules = classifyDeterministic({ fileName: doc.file_name, text: file.sample.text, cells: file.sample.cells });

  // 3. The taxpayer-ID screen (H4), BEFORE any AI call.
  const userTyped = intel.class_source === 'user';
  const screen = screenFile(doc, file, rules, userTyped ? intel.doc_class : null);
  const aiAllowed = screen.verdict === 'clear';

  // 4. AI (when on, useful and allowed).
  const priorAi = intel.class_source === 'ai' && intel.ai_status === 'done';
  const hasText = file.sample.text.trim().length > 0;
  const aiReadable = !!file.bytes && file.bytes.length <= AI_MAX_BYTES && (extractable(file.mediaType) || !!file.sample.sheetSample || hasText);
  let ai: AiClassOpinion | null = priorAi && aiAllowed ? { docClass: intel.doc_class, confidence: Number(intel.confidence), summary: intel.summary } : null;
  let aiStatus: AiState = intel.ai_status;
  let failure: AiFailure | null = null;
  let failureMessage: string | null = null;
  const aiPatch: Record<string, unknown> = {};
  const companies = await loadCompanies(deps.db, input.orgId);
  let aiCompany: string | null = null;
  let aiCounterparty: string | null = null;
  let aiDates: Record<string, string> = {};
  let aiAmount: number | null = null;

  if (!aiAllowed) {
    // A TIN form, or a scan nobody has typed: never to AI. No retry — a person decides.
    aiStatus = 'skipped';
  } else if (!userTyped && (!priorAi || input.force)) {
    if (!deps.anthropicApiKey) {
      failure = 'unavailable';
      failureMessage = 'AI is not configured.';
    } else if (!aiReadable) {
      aiStatus = 'skipped';
    } else {
      const classify = deps.classify ?? classifyWithAi;
      // A readable text layer goes as (redacted) TEXT, never the bytes: a TIN the screen
      // missed is masked before the prompt. Only a file cleared by its name / a person's
      // choice with no text layer goes as the file itself.
      const textual = file.sample.kind === 'sheet' || file.sample.kind === 'text' || (file.sample.kind === 'pdf' && hasText);
      const sampleText = textual ? redactTin(file.sample.sheetSample ?? file.sample.text) : null;
      const r = await classify(
        { supabase: deps.db, anthropicApiKey: deps.anthropicApiKey },
        {
          orgId: input.orgId,
          userId: input.userId,
          base64: textual ? null : Buffer.from(file.bytes).toString('base64'),
          mediaType: file.mediaType,
          textSample: sampleText,
          companies: companies.map((c) => c.name),
        },
      );
      if (r.ok) {
        const c = r.classification;
        ai = { docClass: c.docClass, confidence: c.confidence, summary: c.summary };
        aiStatus = 'done';
        aiCompany = c.companyName;
        aiCounterparty = c.counterparty;
        aiDates = c.keyDates;
        aiAmount = c.amountCents;
        aiPatch.ai_model = r.model;
        aiPatch.summary = c.summary;
        aiPatch.company_hint = c.companyName;
        aiPatch.ai_decision_id = await logDecision(deps.db, {
          orgId: input.orgId,
          locationId: intel.location_id,
          feature: DOCUMENT_CLASSIFY_FEATURE,
          model: r.model,
          correlationId: r.correlationId,
          summary: `Document classification — ${doc.file_name}`,
          output: { kind: 'document_classification', document_id: doc.id, file_name: doc.file_name, doc_class: c.docClass, confidence: c.confidence, rules_class: rules.docClass, counterparty: c.counterparty, company_name: c.companyName, key_dates: c.keyDates, note: c.note },
          confidence: c.confidence,
          reasoning: 'A stored document was read to decide what it is and which module it belongs to; proposed for human confirmation. Nothing is written to the ledger.',
          userId: input.userId,
        });
      } else {
        failure = r.kind;
        failureMessage = r.error;
      }
    }
  }

  // Final class: a person's choice; a TIN form typed natively; else AI merged with rules.
  const final: { docClass: DocClass; confidence: number; source: ClassSource } = userTyped
    ? { docClass: intel.doc_class, confidence: 1, source: 'user' }
    : screen.verdict === 'tin_form'
      ? { ...tinScreenedClass(screen, rules), source: 'rules' }
      : mergeClass(ai, rules);

  // 5. Facts (AI first, then the text hints).
  const text = file.sample.text;
  const counterparty = aiCounterparty ?? (priorAi ? intel.counterparty : null) ?? counterpartyFromText(text, final.docClass);
  const keyDates = Object.keys(aiDates).length ? aiDates : Object.keys(intel.key_dates ?? {}).length ? intel.key_dates : keyDatesFromText(text);
  const amountCents = aiAmount ?? intel.amount_cents ?? largestAmountCents(text);

  // 6. Company (a person's choice sticks).
  let locationId = intel.location_id;
  let locationSource: LocationSource | null = intel.location_source;
  if (locationSource !== 'user') {
    const uploadLoc = input.uploadLocationId ?? (doc.entity_type === 'location' ? doc.entity_id : null) ?? (intel.location_source === 'upload' ? intel.location_id : null);
    const s = suggestCompany(companies, { uploadLocationId: uploadLoc, aiCompanyName: aiCompany ?? intel.company_hint, text });
    if (s.locationId) {
      locationId = s.locationId;
      locationSource = s.source;
    }
  }

  intel = await patchIntel(deps.db, input.orgId, intel.id, {
    ...aiPatch,
    doc_class: final.docClass,
    confidence: Number(final.confidence.toFixed(3)),
    class_source: final.source,
    rules_class: rules.docClass,
    rules_confidence: Number(rules.confidence.toFixed(3)),
    content_sha256: file.sha,
    counterparty,
    key_dates: keyDates,
    amount_cents: amountCents,
    location_id: locationId,
    location_source: locationSource,
    reason:
      final.source === 'user'
        ? 'You chose this type.'
        : screen.verdict === 'tin_form'
          ? tinFormReason(screen.form)
          : screen.verdict === 'unknown'
            ? TIN_REVIEW_REASON
            : final.source === 'ai'
              ? (aiPatch.summary ? 'Read by AI.' : intel.reason)
              : rules.reason || null,
    text_chars: text.length,
    classified_at: iso(now),
  }, now);

  // Keep the center's coarse type in step (only while it still says "Other").
  if (final.docClass !== 'other' && final.confidence >= ROUTE_MIN_CONFIDENCE && doc.doc_type === 'OTHER') {
    await deps.db.from('documents').update({ doc_type: CLASS_TO_DOC_TYPE[final.docClass] }).eq('org_id', input.orgId).eq('id', doc.id);
  }

  // 7. Route (or ask a person).
  let proposals: ProposalRow[] = [];
  let extractPending = false;
  let status: IntelligenceStatus;
  const routable = final.docClass !== 'other' && final.confidence >= ROUTE_MIN_CONFIDENCE;
  if (!routable) {
    status = 'needs_review';
  } else {
    const r = await routeDocument({ deps, orgId: input.orgId, userId: input.userId, doc, intel, file, docClass: final.docClass, locationId, counterparty, now, aiAllowed, screen: screen.verdict, canDraft: input.canDraft });
    proposals = r.proposals;
    extractPending = r.extractPending;
    if (r.failure && (!failure || r.failure === 'failed')) {
      failure = failure ?? r.failure;
      failureMessage = failureMessage ?? r.failureMessage;
    }
    if (r.duplicateOf && proposals.length === 0) {
      intel = await patchIntel(deps.db, input.orgId, intel.id, { status: 'duplicate', duplicate_of: r.duplicateOf === 'unknown' ? null : r.duplicateOf, next_retry_at: null, reason: 'Same file as one already proposed.' }, now);
      return { intelligence: intel, proposals: [], message: 'This is the same file as one already in your documents — nothing new was proposed.' };
    }
    const open = proposals.filter((p) => p.status === 'pending' && p.mode !== 'route');
    const decided = proposals.filter((p) => p.status === 'accepted');
    status = open.length > 0 ? 'proposal_created' : decided.length > 0 && decided.length === proposals.length ? 'accepted' : proposals.length > 0 || CLASS_TARGETS[final.docClass].includes('filed') ? 'routed' : 'needs_review';
  }

  // 8. AI bookkeeping: retry while AI was wanted and could not answer.
  const wantedAi = (aiAllowed && !userTyped && !priorAi && aiStatus !== 'done' && aiStatus !== 'skipped') || extractPending;
  const patch: Record<string, unknown> = { status, routed_at: routable ? iso(now) : null };
  if (wantedAi && failure) {
    const attempts = (intel.ai_attempts ?? 0) + 1;
    patch.ai_status = failure;
    patch.ai_attempts = attempts;
    patch.ai_last_error = (failureMessage ?? '').slice(0, 500);
    patch.next_retry_at = attempts >= MAX_AI_ATTEMPTS ? null : iso(new Date(now.getTime() + retryDelayMinutes(failure, attempts) * 60_000));
  } else {
    patch.ai_status = aiStatus === 'pending' ? (userTyped ? 'skipped' : deps.anthropicApiKey ? 'done' : 'unavailable') : aiStatus;
    patch.next_retry_at = null;
    patch.ai_last_error = null;
  }
  intel = await patchIntel(deps.db, input.orgId, intel.id, patch, now);

  const kinds = proposals.map((p) => p.target_kind);
  const message =
    status === 'needs_review' && screen.verdict === 'unknown'
      ? 'This looks like a scan or photo. To protect taxpayer IDs we don’t send it to AI until you tell us what it is — pick a type.'
      : status === 'needs_review'
      ? deps.anthropicApiKey && !failure
        ? 'We couldn’t tell what this is — pick a type and we’ll put it to work.'
        : 'Kept on file — we’ll read it when AI is available, or pick a type now.'
      : foundMessage(final.docClass, kinds.length ? kinds : CLASS_TARGETS[final.docClass], extractPending);
  return { intelligence: intel, proposals, message };
}

// ── Backfill + retry (the job) ──────────────────────────────────────────────

export interface SweepResult {
  analyzed: number;
  proposals: number;
  needsReview: number;
  duplicates: number;
  linksCreated: number;
  remaining: number;
  errors: string[];
}

/**
 * The plain-English result of "Analyze existing documents" (PURE). Failures are never reported
 * as "everything has already been analyzed" — that wording hid documents the read could not
 * process, so they sat as "Not analyzed" with nobody told.
 */
export function backfillMessage(r: Pick<SweepResult, 'analyzed' | 'proposals' | 'needsReview' | 'duplicates' | 'linksCreated' | 'remaining' | 'errors'>): string {
  const failed = r.errors.filter((e) => !e.startsWith('links:')).length;
  const failedNote = failed > 0 ? ` ${failed} document${failed === 1 ? '' : 's'} couldn’t be read — open ${failed === 1 ? 'it' : 'each one'} and choose Read again, or set the type yourself.` : '';
  const more = r.remaining > 0 ? ` ${r.remaining} more to go — run it again.` : '';
  if (r.analyzed === 0) {
    if (failed > 0) return `Nothing new was analyzed.${failedNote}${more}`;
    if (r.remaining > 0) return `Nothing new was analyzed.${more}`;
    return r.linksCreated > 0 ? `Everything was already analyzed. ${r.linksCreated} existing link(s) recorded.` : 'Everything here has already been analyzed.';
  }
  return `Analyzed ${r.analyzed} document(s): ${r.proposals} proposal(s) ready for review, ${r.needsReview} need a type${r.duplicates ? `, ${r.duplicates} duplicate(s)` : ''}.${failedNote}${more}`;
}

/** Module-filed documents (entity_id set) get a two-way link row. Idempotent. */
async function backfillModuleLinks(deps: IntelDeps, orgId: string): Promise<number> {
  const { data } = await deps.db.from('documents').select('id, entity_type, entity_id').eq('org_id', orgId).not('entity_id', 'is', null).limit(1000);
  const docs = (data ?? []) as Array<{ id: string; entity_type: string | null; entity_id: string }>;
  if (docs.length === 0) return 0;
  const { data: have } = await deps.db.from('document_links').select('document_id, target_type, target_id').eq('org_id', orgId).limit(5000);
  const seen = new Set(((have ?? []) as Array<{ document_id: string; target_type: string; target_id: string }>).map((l) => `${l.document_id}:${l.target_type}:${l.target_id}`));
  let n = 0;
  for (const d of docs) {
    const type = (d.entity_type ?? '').toLowerCase();
    if (!/^[a-z][a-z0-9_]*$/.test(type) || seen.has(`${d.id}:${type}:${d.entity_id}`)) continue;
    const rec = await resolveRecord(deps.db, orgId, type, d.entity_id);
    const { error } = await deps.db.from('document_links').insert({
      org_id: orgId,
      document_id: d.id,
      target_type: type,
      target_id: d.entity_id,
      location_id: rec?.locationId ?? null,
      link_kind: 'source',
      created_via: 'module',
      label: rec?.label ?? null,
      created_at: iso(deps.now()),
    });
    if (!error) n++;
  }
  return n;
}

/** "Analyze existing documents": eligible documents with no intelligence row, oldest first. */
export async function backfillOrg(deps: IntelDeps, input: { orgId: string; userId: string | null; limit?: number; signal?: AbortSignal; canDraft?: DraftAuthorizer }): Promise<SweepResult> {
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
  const res: SweepResult = { analyzed: 0, proposals: 0, needsReview: 0, duplicates: 0, linksCreated: 0, remaining: 0, errors: [] };
  try {
    res.linksCreated = await backfillModuleLinks(deps, input.orgId);
  } catch (e) {
    res.errors.push(`links: ${e instanceof Error ? e.message : String(e)}`);
  }
  const { data: docs } = await deps.db
    .from('documents')
    .select('id, entity_type, created_at')
    .eq('org_id', input.orgId)
    .or('entity_type.is.null,entity_type.eq.location')
    .order('created_at', { ascending: true })
    .limit(2000);
  const { data: have } = await deps.db.from('document_intelligence').select('document_id').eq('org_id', input.orgId).limit(5000);
  const done = new Set(((have ?? []) as Array<{ document_id: string }>).map((r) => r.document_id));
  const todo = ((docs ?? []) as Array<{ id: string }>).filter((d) => !done.has(d.id));
  res.remaining = Math.max(0, todo.length - limit);
  for (const d of todo.slice(0, limit)) {
    if (input.signal?.aborted) break;
    try {
      const r = await analyzeDocument(deps, { orgId: input.orgId, documentId: d.id, userId: input.userId, source: 'backfill', canDraft: input.canDraft });
      res.analyzed++;
      res.proposals += r.proposals.filter((p) => p.status === 'pending' && p.mode !== 'route').length;
      if (r.intelligence?.status === 'needs_review') res.needsReview++;
      if (r.intelligence?.status === 'duplicate') res.duplicates++;
    } catch (e) {
      res.errors.push(`${d.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return res;
}

/** The retry job: documents whose AI read is due again, then a small backfill sweep. */
export async function retryDue(deps: IntelDeps, input: { orgId: string; limit?: number; signal?: AbortSignal }): Promise<SweepResult & { retried: number }> {
  const now = deps.now();
  const limit = Math.max(1, Math.min(input.limit ?? 20, 50));
  const { data } = await deps.db
    .from('document_intelligence')
    .select('document_id, status, ai_attempts, next_retry_at')
    .eq('org_id', input.orgId)
    .lte('next_retry_at', iso(now))
    .lt('ai_attempts', MAX_AI_ATTEMPTS)
    .order('next_retry_at', { ascending: true })
    .limit(limit);
  const due = ((data ?? []) as Array<{ document_id: string; status: IntelligenceStatus }>).filter((r) => !FINAL_STATUSES.has(r.status));
  let retried = 0;
  const errors: string[] = [];
  let proposals = 0;
  let needsReview = 0;
  for (const r of due) {
    if (input.signal?.aborted) break;
    try {
      const out = await analyzeDocument(deps, { orgId: input.orgId, documentId: r.document_id, userId: null, source: 'backfill' });
      retried++;
      proposals += out.proposals.filter((p) => p.status === 'pending' && p.mode !== 'route' && p.extract_state === 'done').length;
      if (out.intelligence?.status === 'needs_review') needsReview++;
    } catch (e) {
      errors.push(`${r.document_id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const sweep = await backfillOrg(deps, { orgId: input.orgId, userId: null, limit: 10, signal: input.signal });
  return {
    ...sweep,
    proposals: sweep.proposals + proposals,
    needsReview: sweep.needsReview + needsReview,
    errors: [...errors, ...sweep.errors],
    retried,
  };
}

// ── Human decisions ─────────────────────────────────────────────────────────

export async function loadProposal(db: SupabaseClient, orgId: string, id: string): Promise<ProposalRow | null> {
  const { data } = await db.from('document_proposals').select('*').eq('org_id', orgId).eq('id', id).maybeSingle();
  return (data as ProposalRow | null) ?? null;
}

async function refreshIntelStatus(deps: IntelDeps, orgId: string, documentId: string, now: Date): Promise<IntelRow | null> {
  const intel = await loadIntel(deps.db, orgId, documentId);
  if (!intel) return null;
  const props = await loadProposals(deps.db, orgId, documentId);
  const live = props.filter((p) => p.status !== 'superseded');
  const open = live.filter((p) => p.status === 'pending' && p.mode !== 'route');
  const accepted = live.filter((p) => p.status === 'accepted');
  let status: IntelligenceStatus = intel.status;
  if (open.length > 0) status = 'proposal_created';
  else if (accepted.length > 0) status = 'accepted';
  else if (live.length > 0 && live.every((p) => p.status === 'dismissed')) status = 'dismissed';
  return patchIntel(deps.db, orgId, intel.id, { status }, now);
}

async function writeLink(
  deps: IntelDeps,
  orgId: string,
  row: { documentId: string; targetType: string; targetId: string; locationId: string | null; via: 'ai' | 'user' | 'module'; proposalId: string | null; label: string | null; userId: string | null },
): Promise<void> {
  const { error } = await deps.db.from('document_links').insert({
    org_id: orgId,
    document_id: row.documentId,
    target_type: row.targetType,
    target_id: row.targetId,
    location_id: row.locationId,
    link_kind: 'source',
    created_via: row.via,
    proposal_id: row.proposalId,
    label: row.label,
    created_by: row.userId,
    created_at: iso(deps.now()),
  });
  if (error && !isUniqueViolation(error)) throw new IntelligenceError(`Could not link the document: ${error.message}`, 500, 'SAVE_FAILED');
  // The center's legacy single link + the record's Attachments panel: set when still free.
  await deps.db.from('documents').update({ entity_type: row.targetType, entity_id: row.targetId }).eq('org_id', orgId).eq('id', row.documentId).is('entity_id', null);
}

export interface AcceptInput {
  orgId: string;
  proposalId: string;
  userId: string;
  targetType: string;
  targetId: string;
  note?: string | null;
}

/**
 * The module created the record from this proposal (or a person picked one): verify the
 * record exists in the org, link both ways, close the proposal. Idempotent for the same
 * target. For vendor W-9 / COI proposals with no submission yet, accepting with a vendor
 * first lodges the submission in Vendor compliance.
 */
export async function acceptProposal(deps: IntelDeps, input: AcceptInput): Promise<{ proposal: ProposalRow; label: string }> {
  const now = deps.now();
  let p = await loadProposal(deps.db, input.orgId, input.proposalId);
  if (!p) throw new IntelligenceError('Proposal not found', 404, 'NOT_FOUND');
  if (p.status === 'accepted') {
    if (p.accepted_target_type === input.targetType && p.accepted_target_id === input.targetId) {
      const rec = await resolveRecord(deps.db, input.orgId, input.targetType, input.targetId);
      return { proposal: p, label: rec?.label ?? '' };
    }
    throw new IntelligenceError('This proposal was already accepted for another record.', 409, 'ALREADY_ACCEPTED');
  }
  if (p.status !== 'pending') throw new IntelligenceError(`This proposal is ${p.status}.`, 409, 'NOT_PENDING');

  const rec = await resolveRecord(deps.db, input.orgId, input.targetType, input.targetId);
  if (!rec) throw new IntelligenceError('That record was not found in this organization.', 404, 'TARGET_NOT_FOUND');

  if ((p.target_kind === 'vendor_coi' || p.target_kind === 'vendor_w9') && !p.native_id) {
    if (input.targetType !== 'vendor') throw new IntelligenceError('Pick the vendor this document belongs to.', 400, 'VENDOR_REQUIRED');
    const doc = await loadDoc(deps.db, input.orgId, p.document_id);
    if (!doc) throw new IntelligenceError('Document not found', 404, 'NOT_FOUND');
    const file = p.target_kind === 'vendor_coi' ? await readFile(deps, doc) : null;
    // H4: a COI's bytes go to the AI check only when the TIN screen clears the file.
    let coiBase64: string | null = null;
    if (file?.bytes && file.bytes.length <= AI_MAX_BYTES) {
      const intelRow = await loadIntel(deps.db, input.orgId, doc.id);
      const rules = classifyDeterministic({ fileName: doc.file_name, text: file.sample.text, cells: file.sample.cells });
      const userClass = intelRow?.class_source === 'user' ? intelRow.doc_class : 'coi';
      if (screenFile(doc, file, rules, userClass).verdict === 'clear') coiBase64 = Buffer.from(file.bytes).toString('base64');
    }
    const native = deps.native ?? defaultNative;
    const r = await native.createVendorSubmission(deps.db, {
      orgId: input.orgId,
      userId: input.userId,
      vendorId: input.targetId,
      docKind: p.target_kind === 'vendor_w9' ? 'W9' : 'COI',
      documentId: doc.id,
      base64: coiBase64,
      mediaType: file?.mediaType ?? doc.mime_type ?? 'application/pdf',
      anthropicApiKey: deps.anthropicApiKey,
    });
    if (!r.ok) throw new IntelligenceError(r.error, 422, 'NATIVE_FAILED');
    p = await patchProposal(deps.db, input.orgId, p.id, { native_table: r.nativeTable, native_id: r.nativeId, extract_state: 'done' }, now);
  }

  await writeLink(deps, input.orgId, { documentId: p.document_id, targetType: input.targetType, targetId: input.targetId, locationId: rec.locationId, via: 'ai', proposalId: p.id, label: rec.label, userId: input.userId });
  p = await patchProposal(deps.db, input.orgId, p.id, {
    status: 'accepted',
    accepted_target_type: input.targetType,
    accepted_target_id: input.targetId,
    decided_by: input.userId,
    decided_at: iso(now),
    decision_note: input.note?.trim() || null,
    location_id: p.location_id ?? rec.locationId,
  }, now);
  await refreshIntelStatus(deps, input.orgId, p.document_id, now);
  return { proposal: p, label: rec.label };
}

export async function dismissProposal(deps: IntelDeps, input: { orgId: string; proposalId: string; userId: string; note?: string | null }): Promise<ProposalRow> {
  const now = deps.now();
  const p = await loadProposal(deps.db, input.orgId, input.proposalId);
  if (!p) throw new IntelligenceError('Proposal not found', 404, 'NOT_FOUND');
  if (p.status === 'dismissed') return p;
  if (p.status !== 'pending') throw new IntelligenceError(`This proposal is ${p.status}.`, 409, 'NOT_PENDING');
  const out = await patchProposal(deps.db, input.orgId, p.id, { status: 'dismissed', decided_by: input.userId, decided_at: iso(now), decision_note: input.note?.trim() || null }, now);
  await refreshIntelStatus(deps, input.orgId, p.document_id, now);
  return out;
}

/** "Not something to file" — every pending proposal dismissed; the retry stops. */
export async function dismissDocument(deps: IntelDeps, input: { orgId: string; documentId: string; userId: string; note?: string | null }): Promise<IntelRow> {
  const now = deps.now();
  const intel = await loadIntel(deps.db, input.orgId, input.documentId);
  if (!intel) throw new IntelligenceError('This document has not been analyzed.', 404, 'NOT_FOUND');
  for (const p of await loadProposals(deps.db, input.orgId, input.documentId)) {
    if (p.status === 'pending') await patchProposal(deps.db, input.orgId, p.id, { status: 'dismissed', decided_by: input.userId, decided_at: iso(now), decision_note: input.note?.trim() || null }, now);
  }
  return patchIntel(deps.db, input.orgId, intel.id, { status: 'dismissed', next_retry_at: null, reviewed_by: input.userId, reviewed_at: iso(now), reason: input.note?.trim() || 'Dismissed.' }, now);
}

/** A person sets the type: pending proposals of other kinds are superseded; the document is re-routed. */
export async function changeType(deps: IntelDeps, input: { orgId: string; documentId: string; userId: string; docClass: DocClass; canDraft?: DraftAuthorizer }): Promise<AnalyzeResult> {
  const now = deps.now();
  let intel = await loadIntel(deps.db, input.orgId, input.documentId);
  if (!intel) {
    intel = await registerDocument(deps, { orgId: input.orgId, documentId: input.documentId, userId: input.userId, source: 'center', preset: { docClass: input.docClass, confidence: 1, source: 'user' } });
    if (!intel) throw new IntelligenceError('This document is filed by the module it came from.', 409, 'NOT_ELIGIBLE');
  }
  const keep = new Set<TargetKind>(CLASS_TARGETS[input.docClass]);
  for (const p of await loadProposals(deps.db, input.orgId, input.documentId)) {
    if (p.status === 'pending' && !keep.has(p.target_kind)) await patchProposal(deps.db, input.orgId, p.id, { status: 'superseded' }, now);
  }
  await patchIntel(deps.db, input.orgId, intel.id, { doc_class: input.docClass, confidence: 1, class_source: 'user', status: 'classified', reviewed_by: input.userId, reviewed_at: iso(now), duplicate_of: null }, now);
  await deps.db.from('documents').update({ doc_type: CLASS_TO_DOC_TYPE[input.docClass] }).eq('org_id', input.orgId).eq('id', input.documentId);
  return analyzeDocument(deps, { orgId: input.orgId, documentId: input.documentId, userId: input.userId, source: 'center', canDraft: input.canDraft });
}

/** A person picks the company: proposals follow; a bill waiting on a company is retried. */
export async function setCompany(deps: IntelDeps, input: { orgId: string; documentId: string; userId: string; locationId: string; canDraft?: DraftAuthorizer }): Promise<AnalyzeResult> {
  const now = deps.now();
  const intel = await loadIntel(deps.db, input.orgId, input.documentId);
  if (!intel) throw new IntelligenceError('This document has not been analyzed.', 404, 'NOT_FOUND');
  await patchIntel(deps.db, input.orgId, intel.id, { location_id: input.locationId, location_source: 'user' }, now);
  for (const p of await loadProposals(deps.db, input.orgId, input.documentId)) {
    if (p.status === 'pending') await patchProposal(deps.db, input.orgId, p.id, { location_id: input.locationId }, now);
  }
  if (FINAL_STATUSES.has(intel.status)) return { intelligence: await loadIntel(deps.db, input.orgId, input.documentId), proposals: await loadProposals(deps.db, input.orgId, input.documentId), message: 'Company updated.' };
  return analyzeDocument(deps, { orgId: input.orgId, documentId: input.documentId, userId: input.userId, source: 'center', canDraft: input.canDraft });
}

/** "Link to existing record": a user link; the document counts as handled. */
export async function linkExisting(deps: IntelDeps, input: { orgId: string; documentId: string; userId: string; targetType: string; targetId: string }): Promise<{ label: string }> {
  const now = deps.now();
  const doc = await loadDoc(deps.db, input.orgId, input.documentId);
  if (!doc) throw new IntelligenceError('Document not found', 404, 'NOT_FOUND');
  const rec = await resolveRecord(deps.db, input.orgId, input.targetType, input.targetId);
  if (!rec) throw new IntelligenceError('That record was not found in this organization.', 404, 'TARGET_NOT_FOUND');
  await writeLink(deps, input.orgId, { documentId: doc.id, targetType: input.targetType, targetId: input.targetId, locationId: rec.locationId, via: 'user', proposalId: null, label: rec.label, userId: input.userId });
  const intel = await loadIntel(deps.db, input.orgId, doc.id);
  if (intel) {
    // A pending proposal for the same module is answered by this link.
    for (const p of await loadProposals(deps.db, input.orgId, doc.id)) {
      if (p.status === 'pending' && TARGETS[p.target_kind].recordType === input.targetType) {
        await patchProposal(deps.db, input.orgId, p.id, { status: 'accepted', accepted_target_type: input.targetType, accepted_target_id: input.targetId, decided_by: input.userId, decided_at: iso(now), decision_note: 'Linked to an existing record.' }, now);
      }
    }
    const open = (await loadProposals(deps.db, input.orgId, doc.id)).some((p) => p.status === 'pending' && p.mode !== 'route');
    await patchIntel(deps.db, input.orgId, intel.id, { status: open ? 'proposal_created' : 'linked', next_retry_at: open ? intel.next_retry_at : null, reviewed_by: input.userId, reviewed_at: iso(now) }, now);
  }
  return { label: rec.label };
}

/** Remove a link (the document's legacy entity link is cleared when it pointed at that record). */
export async function unlink(deps: IntelDeps, input: { orgId: string; linkId: string }): Promise<boolean> {
  const { data } = await deps.db.from('document_links').select('*').eq('org_id', input.orgId).eq('id', input.linkId).maybeSingle();
  const link = data as { id: string; document_id: string; target_type: string; target_id: string } | null;
  if (!link) return false;
  await deps.db.from('document_links').delete().eq('org_id', input.orgId).eq('id', link.id);
  await deps.db.from('documents').update({ entity_type: null, entity_id: null }).eq('org_id', input.orgId).eq('id', link.document_id).eq('entity_type', link.target_type).eq('entity_id', link.target_id);
  return true;
}

/**
 * Native queues decide on their own screens: an AP draft APPROVED with a bill → the
 * proposal is accepted and linked to that bill; REJECTED → dismissed. A vendor
 * submission accepted → linked to the vendor; rejected → dismissed. Cheap; called on list.
 */
export async function syncNative(deps: IntelDeps, orgId: string): Promise<number> {
  const now = deps.now();
  const { data } = await deps.db.from('document_proposals').select('*').eq('org_id', orgId).eq('mode', 'native').eq('status', 'pending').not('native_id', 'is', null).limit(200);
  const rows = (data ?? []) as ProposalRow[];
  let n = 0;
  for (const p of rows) {
    try {
      if (p.native_table === 'ai_decisions') {
        const { data: d } = await deps.db.from('ai_decisions').select('id, status, proposed_output, disposition_by_user').eq('org_id', orgId).eq('id', p.native_id as string).maybeSingle();
        const dec = d as { status: string; proposed_output: { postedBillId?: string } | null; disposition_by_user: string | null } | null;
        if (!dec) continue;
        if (dec.status === 'APPROVED' && dec.proposed_output?.postedBillId) {
          const rec = await resolveRecord(deps.db, orgId, 'bill', dec.proposed_output.postedBillId);
          await writeLink(deps, orgId, { documentId: p.document_id, targetType: 'bill', targetId: dec.proposed_output.postedBillId, locationId: rec?.locationId ?? p.location_id, via: 'ai', proposalId: p.id, label: rec?.label ?? null, userId: dec.disposition_by_user });
          await patchProposal(deps.db, orgId, p.id, { status: 'accepted', accepted_target_type: 'bill', accepted_target_id: dec.proposed_output.postedBillId, decided_by: dec.disposition_by_user ?? 'system', decided_at: iso(now) }, now);
          n++;
        } else if (dec.status === 'REJECTED' || dec.status === 'EXPIRED') {
          await patchProposal(deps.db, orgId, p.id, { status: 'dismissed', decided_by: dec.disposition_by_user ?? 'system', decided_at: iso(now), decision_note: 'Rejected in the AP intake queue.' }, now);
          n++;
        }
      } else if (p.native_table === 'vendor_document_submissions') {
        const { data: s } = await deps.db.from('vendor_document_submissions').select('id, vendor_id, status, reviewed_by').eq('org_id', orgId).eq('id', p.native_id as string).maybeSingle();
        const sub = s as { vendor_id: string; status: string; reviewed_by: string | null } | null;
        if (!sub) continue;
        if (sub.status === 'accepted') {
          const rec = await resolveRecord(deps.db, orgId, 'vendor', sub.vendor_id);
          await writeLink(deps, orgId, { documentId: p.document_id, targetType: 'vendor', targetId: sub.vendor_id, locationId: null, via: 'ai', proposalId: p.id, label: rec?.label ?? null, userId: sub.reviewed_by });
          await patchProposal(deps.db, orgId, p.id, { status: 'accepted', accepted_target_type: 'vendor', accepted_target_id: sub.vendor_id, decided_by: sub.reviewed_by ?? 'system', decided_at: iso(now) }, now);
          n++;
        } else if (sub.status === 'rejected' || sub.status === 'superseded') {
          await patchProposal(deps.db, orgId, p.id, { status: 'dismissed', decided_by: sub.reviewed_by ?? 'system', decided_at: iso(now), decision_note: `Vendor compliance: ${sub.status}.` }, now);
          n++;
        }
      }
      await refreshIntelStatus(deps, orgId, p.document_id, now);
    } catch {
      // one bad row never stops the sync
    }
  }
  return n;
}

/** Labels for the class, for API consumers that only hold the key. */
export function classLabel(c: DocClass): string {
  return DOC_CLASS_LABEL[c];
}
